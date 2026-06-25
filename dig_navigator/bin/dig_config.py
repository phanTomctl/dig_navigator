import json
import time
import hashlib
import urllib.request
from html.parser import HTMLParser
import traceback

import splunk
import splunk.rest
from splunk.rest import BaseRestHandler


APP_NAME = "dig_navigator"

DATAMODEL_FIELDS_COLLECTION = "datamodel_fields"
CIM_DATAMODEL_TAGS_COLLECTION = "cim_datamodel_tags"


DATAMODELS = [
    {"datamodel": "Alerts", "slug": "alerts"},
    {"datamodel": "Authentication", "slug": "authentication"},
    {"datamodel": "Certificates", "slug": "certificates"},
    {"datamodel": "Change", "slug": "change"},
    {"datamodel": "Databases", "slug": "databases"},
    {"datamodel": "DLP", "slug": "data-loss-prevention"},
    {"datamodel": "Email", "slug": "email"},
    {"datamodel": "Endpoint", "slug": "endpoint"},
    {"datamodel": "Intrusion_Detection", "slug": "intrusion-detection"},
    {"datamodel": "Malware", "slug": "malware"},
    {"datamodel": "Network_Resolution", "slug": "network-resolution-dns"},
    {"datamodel": "Network_Sessions", "slug": "network-sessions"},
    {"datamodel": "Network_Traffic", "slug": "network-traffic"},
    {"datamodel": "Performance", "slug": "performance"},
    {"datamodel": "Updates", "slug": "updates"},
    {"datamodel": "Vulnerabilities", "slug": "vulnerabilities"},
    {"datamodel": "Web", "slug": "web"},
    {"datamodel": "Event_Signatures", "slug": "event-signatures"},
    {"datamodel": "Interprocess_Messaging", "slug": "interprocess-messaging"},
    {"datamodel": "Compute_Inventory", "slug": "inventory"},
    {"datamodel": "JVM", "slug": "java-virtual-machines-jvm"},
]


# Conservative DIG-maintained mapping of CIM datamodels to expected evidence tags.
# This intentionally does not use /services/data/models tags_whitelist because that
# metadata can include broad/supporting tags that overstate datamodel readiness.
#
# Datamodel names intentionally use the app/system canonical names used by DIG
# lookups and dashboards, for example Network_Traffic rather than Network Traffic.
CURATED_DATAMODEL_TAGS = {
    "Alerts": {
        "top_level": ["alert"],
        "supporting": [],
    },
    "Application_State": {
        "top_level": ["application"],
        "supporting": ["state"],
    },
    "Authentication": {
        "top_level": ["authentication"],
        "supporting": ["privileged", "user"],
    },
    "Certificates": {
        "top_level": ["certificate"],
        "supporting": [],
    },
    "Change": {
        "top_level": ["change"],
        "supporting": [],
    },
    "Change_Analysis": {
        "top_level": ["change"],
        "supporting": [],
    },
    "Compute_Inventory": {
        "top_level": ["inventory"],
        "supporting": ["host"],
    },
    "DLP": {
        "top_level": ["dlp"],
        "supporting": ["data"],
    },
    "Data_Access": {
        "top_level": ["access"],
        "supporting": ["data"],
    },
    "Databases": {
        "top_level": ["database"],
        "supporting": [],
    },
    "Email": {
        "top_level": ["email"],
        "supporting": [],
    },
    "Endpoint": {
        "top_level": ["endpoint"],
        "supporting": ["filesystem", "process", "registry", "service", "report"],
    },
    "Event_Signatures": {
        "top_level": ["event"],
        "supporting": ["signature"],
    },
    "Interprocess_Messaging": {
        "top_level": ["message"],
        "supporting": [],
    },
    "Intrusion_Detection": {
        "top_level": ["ids"],
        "supporting": ["attack"],
    },
    "JVM": {
        "top_level": ["jvm"],
        "supporting": [],
    },
    "Malware": {
        "top_level": ["malware"],
        "supporting": ["virus"],
    },
    "Network_Resolution": {
        "top_level": ["dns"],
        "supporting": ["network"],
    },
    "Network_Sessions": {
        "top_level": ["session"],
        "supporting": ["network"],
    },
    "Network_Traffic": {
        "top_level": ["network"],
        "supporting": ["communicate"],
    },
    "Performance": {
        "top_level": ["performance"],
        "supporting": [],
    },
    "Ticket_Management": {
        "top_level": ["ticket"],
        "supporting": [],
    },
    "Updates": {
        "top_level": ["update"],
        "supporting": [],
    },
    "Vulnerabilities": {
        "top_level": ["vulnerability"],
        "supporting": [],
    },
    "Web": {
        "top_level": ["web"],
        "supporting": [],
    },
}
CIM_VERSION = "8.5"

BASE_DATAMODEL_URL = (
    "https://help.splunk.com/splunk-enterprise/common-information-model/{version}/data-models/{datamodel}"
)


def build_datamodel_urls():
    return [
        {
            "datamodel": item["datamodel"],
            "url": BASE_DATAMODEL_URL.format(
                version=CIM_VERSION,
                datamodel=item["slug"],
            ),
        }
        for item in DATAMODELS
    ]


class SimpleTableParser(HTMLParser):
    """
    Minimal HTML table parser.
    For production, vendor BeautifulSoup into app/lib if you prefer bs4.
    """

    def __init__(self):
        super().__init__()
        self.tables = []
        self.current_table = None
        self.current_row = None
        self.current_cell = None
        self.in_cell = False

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.current_table = []
        elif tag == "tr" and self.current_table is not None:
            self.current_row = []
        elif tag in ("td", "th") and self.current_row is not None:
            self.current_cell = ""
            self.in_cell = True

    def handle_data(self, data):
        if self.in_cell and self.current_cell is not None:
            self.current_cell += data

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.in_cell:
            self.current_row.append(" ".join(self.current_cell.split()))
            self.current_cell = None
            self.in_cell = False
        elif tag == "tr" and self.current_table is not None:
            if self.current_row:
                self.current_table.append(self.current_row)
            self.current_row = None
        elif tag == "table" and self.current_table is not None:
            self.tables.append(self.current_table)
            self.current_table = None


def get_page(url):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-GB,en;q=0.9",
        },
    )

    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def find_field_notes_tables(html):
    parser = SimpleTableParser()
    parser.feed(html)

    matches = []
    notes_headers = [
        "notes",
        "abbreviated list of example values",
    ]

    for table in parser.tables:
        if not table:
            continue

        headers = [h.strip().lower() for h in table[0]]

        if "field name" not in headers:
            continue

        field_idx = headers.index("field name")

        notes_idx = None
        for notes_header in notes_headers:
            if notes_header in headers:
                notes_idx = headers.index(notes_header)
                break

        if notes_idx is None:
            continue

        matches.append({
            "rows": table[1:],
            "field_idx": field_idx,
            "notes_idx": notes_idx,
            "headers": headers,
        })

    return matches


def get_field_status(row):
    row_text = " ".join(row).lower()

    if "required" in row_text:
        return "required"

    if "recommended" in row_text:
        return "recommended"

    return "optional"


def make_datamodel_field_key(datamodel, table_index, field_name):
    raw = f"{datamodel}:{table_index}:{field_name}".lower().encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def make_datamodel_tag_key(datamodel, tag):
    raw = f"{datamodel}:{tag}".lower().encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def splunkd_url(uri):
    base_uri = splunk.rest.makeSplunkdUri()
    return base_uri.rstrip("/") + uri


def splunkd_json_request(session_key, uri, method="GET", payload=None, timeout=30):
    """
    Send JSON-capable requests to splunkd using Splunk's own URI helper.

    This avoids hardcoded 127.0.0.1:8089 while still allowing raw JSON
    bodies for KV Store batch_save endpoints.
    """
    url = splunkd_url(uri)

    headers = {
        "Authorization": f"Splunk {session_key}",
    }

    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers,
    )

    with urllib.request.urlopen(req, timeout=timeout) as response:
        response_body = response.read().decode("utf-8", errors="replace")

    if not response_body:
        return None

    try:
        return json.loads(response_body)
    except ValueError:
        return response_body


def write_records_to_kvstore(session_key, collection_name, records):
    if not records:
        return {
            "collection": collection_name,
            "attempted_records": 0,
            "response": None,
        }

    uri = (
        f"/servicesNS/nobody/{APP_NAME}"
        f"/storage/collections/data/{collection_name}/batch_save"
    )

    response = splunkd_json_request(
        session_key=session_key,
        uri=uri,
        method="POST",
        payload=records,
    )

    return {
        "collection": collection_name,
        "attempted_records": len(records),
    }


def delete_kvstore_record(session_key, collection_name, record_key):
    uri = (
        f"/servicesNS/nobody/{APP_NAME}"
        f"/storage/collections/data/{collection_name}/{record_key}"
    )
    return splunkd_json_request(
        session_key=session_key,
        uri=uri,
        method="DELETE",
    )


def clear_kvstore_collection(session_key, collection_name):
    """
    Remove all records from a KV Store collection without deleting the collection.

    Splunk Cloud/AppInspect-friendly behaviour: read existing record keys and
    delete the records one-by-one, so the collection definition remains intact.
    """
    uri = (
        f"/servicesNS/nobody/{APP_NAME}"
        f"/storage/collections/data/{collection_name}?output_mode=json"
    )

    try:
        existing_records = splunkd_json_request(
            session_key=session_key,
            uri=uri,
            method="GET",
        )
    except Exception as e:
        return {
            "collection": collection_name,
            "records_deleted": 0,
            "errors": [{"error": str(e)}],
        }

    if not isinstance(existing_records, list):
        return {
            "collection": collection_name,
            "records_deleted": 0,
            "errors": [],
        }

    deleted = 0
    errors = []

    for record in existing_records:
        record_key = record.get("_key") if isinstance(record, dict) else None
        if not record_key:
            continue

        try:
            delete_kvstore_record(session_key, collection_name, record_key)
            deleted += 1
        except Exception as e:
            errors.append({
                "_key": record_key,
                "error": str(e),
            })

    return {
        "collection": collection_name,
        "records_deleted": deleted,
        "errors": errors,
    }


def build_cim_datamodel_tags(session_key):
    """
    Build cim_datamodel_tags KV Store collection using a conservative curated
    mapping of datamodels to expected evidence tags.

    This deliberately avoids /services/data/models tags_whitelist because that
    metadata can include broad/supporting tags such as cloud, pci, time, update,
    and other values that are not reliable evidence that data is ready for a
    specific CIM datamodel.

    Expected KV Store collection:
      cim_datamodel_tags

    Expected lookup:
      cim_datamodel_tags_lookup
    """
    now = int(time.time())
    records = []
    errors = []

    clear_result = clear_kvstore_collection(
        session_key=session_key,
        collection_name=CIM_DATAMODEL_TAGS_COLLECTION,
    )
    errors.extend(clear_result.get("errors", []))

    for datamodel, tag_groups in sorted(CURATED_DATAMODEL_TAGS.items()):
        try:
            if isinstance(tag_groups, dict):
                role_to_tags = {
                    "top_level": tag_groups.get("top_level", []),
                    "supporting": tag_groups.get("supporting", []),
                }
            else:
                # Backwards-compatible fallback for any simple list mappings.
                role_to_tags = {
                    "top_level": tag_groups,
                    "supporting": [],
                }

            seen_tags = set()
            for tag_role, tags in role_to_tags.items():
                clean_tags = sorted({
                    str(tag).strip().lower()
                    for tag in tags
                    if str(tag).strip()
                })

                for tag in clean_tags:
                    dedupe_key = (datamodel.lower(), tag)
                    if dedupe_key in seen_tags:
                        continue
                    seen_tags.add(dedupe_key)

                    records.append({
                        "_key": make_datamodel_tag_key(datamodel, tag),
                        "datamodel": datamodel,
                        "expected_tag": tag,
                        "tag_role": tag_role,
                        "updated_at": now,
                    })

        except Exception as e:
            errors.append({
                "datamodel": datamodel,
                "error": str(e),
            })

    if records:
        write_records_to_kvstore(
            session_key=session_key,
            collection_name=CIM_DATAMODEL_TAGS_COLLECTION,
            records=records,
        )

    return {
        "status": "ok" if not errors else "partial",
        "records_written": len(records),
        "records_deleted": clear_result.get("records_deleted", 0),
        "datamodels_checked": len(CURATED_DATAMODEL_TAGS),
        "source": "curated_datamodel_tag_mapping",
        "errors": errors,
    }

def scrape_all(session_key):
    now = int(time.time())
    records = []
    errors = []

    datamodel_urls = build_datamodel_urls()

    for item in datamodel_urls:
        datamodel = item["datamodel"]
        url = item["url"]

        try:
            html = get_page(url)
            tables = find_field_notes_tables(html)

            if not tables:
                errors.append({
                    "datamodel": datamodel,
                    "url": url,
                    "error": "No tables found with Field Name and Notes/example columns",
                })
                continue

            for table_index, table_match in enumerate(tables, start=1):
                rows = table_match["rows"]
                field_idx = table_match["field_idx"]
                notes_idx = table_match["notes_idx"]

                for row in rows:
                    if len(row) <= max(field_idx, notes_idx):
                        continue

                    field_name = row[field_idx].strip()
                    notes = row[notes_idx].strip()

                    if not field_name:
                        continue

                    field_status = get_field_status(row)

                    records.append({
                        "_key": make_datamodel_field_key(datamodel, table_index, field_name),
                        "datamodel": datamodel,
                        "field_name": field_name,
                        "table_index": table_index,
                        "notes": notes,
                        "source_url": url,
                        "field_status": field_status,
                        "recommended": field_status == "recommended",
                        "required": field_status == "required",
                        "last_seen": now,
                        "updated_at": now,
                    })

        except Exception as e:
            errors.append({
                "datamodel": datamodel,
                "url": url,
                "error": str(e),
            })

    clear_result = {
        "collection": DATAMODEL_FIELDS_COLLECTION,
        "records_deleted": 0,
        "errors": [],
    }

    if records:
        clear_result = clear_kvstore_collection(
            session_key=session_key,
            collection_name=DATAMODEL_FIELDS_COLLECTION,
        )
        errors.extend(clear_result.get("errors", []))

        write_records_to_kvstore(
            session_key=session_key,
            collection_name=DATAMODEL_FIELDS_COLLECTION,
            records=records,
        )

    return {
        "status": "ok" if not errors else "partial",
        "records_written": len(records),
        "records_deleted": clear_result.get("records_deleted", 0),
        "datamodel_urls_checked": len(datamodel_urls),
        "errors": errors,
    }

def get_request_value(request, key):
    if not hasattr(request, "get"):
        return None

    direct_value = request.get(key)
    if direct_value:
        return direct_value

    for container_name in ("payload", "form", "query"):
        container = request.get(container_name)
        if isinstance(container, dict):
            value = container.get(key)
            if value:
                return value

    return None

class DIGConfig(BaseRestHandler):

    def handle_GET(self):
        self.response.setHeader("content-type", "application/json")
        self.response.write(json.dumps({
            "status": "ready",
            "message": "POST to this endpoint with action=scrape_fields, action=build_tags, or action=run_all.",
            "actions": [
                "scrape_fields",
                "build_tags",
                "run_all",
            ],
        }))

    def handle_POST(self):
        self.response.setHeader("content-type", "application/json")

        try:
            ## This will present the results back in the panel and can be messy. 
            ## Uncomment to enable

            #request_debug = {
            #    "type": str(type(self.request)),
            #    "keys": list(self.request.keys()) if hasattr(self.request, "keys") else [],
            #    "request": str(self.request),
            #}

            action = get_request_value(self.request, "action") or "scrape_fields"

            if action == "build_tags":
                result = build_cim_datamodel_tags(self.sessionKey)

            elif action == "run_all":
                fields_result = scrape_all(self.sessionKey)
                tags_result = build_cim_datamodel_tags(self.sessionKey)
                result = {
                    "status": (
                        "ok"
                        if fields_result.get("status") == "ok"
                        and tags_result.get("status") == "ok"
                        else "partial"
                    ),
                    "fields": fields_result,
                    "tags": tags_result,
                }

            else:
                result = scrape_all(self.sessionKey)

            result["action"] = action
            ## This will present the results back in the panel and can be messy. 
            ## Uncomment to enable
            #result["request_debug"] = request_debug

            self.response.write(json.dumps(result))

        except Exception as e:
            self.response.setStatus(500)
            self.response.write(json.dumps({
                "status": "error",
                "message": str(e),
                "traceback": traceback.format_exc(),
        }))
