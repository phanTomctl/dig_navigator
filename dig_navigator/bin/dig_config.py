import hashlib
import json
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

import splunk
import splunk.rest
from splunk.rest import BaseRestHandler


APP_NAME = "dig_navigator"

DATAMODEL_FIELDS_COLLECTION = "datamodel_fields"
CIM_DATAMODEL_TAGS_COLLECTION = "cim_datamodel_tags"
SA_CIM_SOURCE = "sa_cim:/services/data/models"

SEARCH_EXPORT_TIMEOUT = 180

DATAMODEL_FIELDS_SPL = r"""
| rest /services/data/models
| fields title eai:data
| spath input=eai:data path=objects{} output=object
| mvexpand object
| spath input=object path=objectName output=dataset
| spath input=object path=fields{} output=normal_fields
| spath input=object path=calculations{}.outputFields{} output=calc_fields
| eval field_json=mvappend(normal_fields, calc_fields)
| mvexpand field_json
| spath input=field_json path=fieldName output=field_name
| spath input=field_json path=comment.recommended output=recommended
| spath input=field_json path=comment.description output=description
| spath input=field_json path=required output=required
| spath input=field_json path=hidden output=hidden
| where isnotnull(field_name) AND field_name!="" AND (hidden!="true" OR isnull(hidden))
| eval datamodel=title
| eval notes=description
| eval recommended=if(recommended="true","true","false")
| eval required=if(required="true","true","false")
| eval field_status=case(required="true","required", recommended="true","recommended", true(),"optional")
| stats
    max(required) as required
    max(recommended) as recommended
    first(notes) as notes
    by datamodel field_name
| eval field_status=case(required="true","required", recommended="true","recommended", true(),"optional")
| table datamodel field_name field_status recommended required notes
| sort datamodel field_name
""".strip()

CIM_DATAMODEL_TAGS_SPL = r"""
| rest /services/data/models
| fields title eai:data
| spath input=eai:data path=objects{} output=object
| mvexpand object
| spath input=object path=parentName output=parent_dataset
| spath input=object path=comment.tags{} output=object_tags
| spath input=object path=constraints{}.search output=constraint_search
| eval object_tags=mvjoin(object_tags, ",")
| eval constraint_text=mvjoin(constraint_search, " ")
| rex field=constraint_text max_match=0 "(?:^|\s)tag=(?<constraint_tags>[^\s\)]+)"
| eval root_tags=if(parent_dataset="BaseEvent" OR isnull(parent_dataset) OR parent_dataset="", object_tags, null())
| eval supporting_tags=if(isnotnull(parent_dataset) AND parent_dataset!="BaseEvent", object_tags, null())
| eval datamodel=title
| eval tag_blob=mvappend(
    if(isnotnull(root_tags) AND len(root_tags)>0, "top_level:" . root_tags, null()),
    if(isnotnull(supporting_tags) AND len(supporting_tags)>0, "supporting:" . supporting_tags, null()),
    if(isnotnull(constraint_tags) AND len(constraint_tags)>0, "constraint:" . constraint_tags, null())
)
| mvexpand tag_blob
| rex field=tag_blob "^(?<tag_role>[^:]+):(?<tag_csv>.*)$"
| makemv delim="," tag_csv
| mvexpand tag_csv
| eval expected_tag=lower(trim(tag_csv))
| where len(expected_tag)>0
| dedup datamodel expected_tag tag_role
| table datamodel expected_tag tag_role
| sort datamodel tag_role expected_tag
""".strip()


def make_datamodel_field_key(datamodel, field_name):
    raw = f"{datamodel}:{field_name}".lower().encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def make_datamodel_tag_key(datamodel, tag, tag_role):
    raw = f"{datamodel}:{tag_role}:{tag}".lower().encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def splunkd_url(uri):
    base_uri = splunk.rest.makeSplunkdUri()
    return base_uri.rstrip("/") + uri


def splunkd_json_request(session_key, uri, method="GET", payload=None, form=None, timeout=30):
    headers = {
        "Authorization": f"Splunk {session_key}",
    }

    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    elif form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urllib.parse.urlencode(form).encode("utf-8")

    req = urllib.request.Request(
        url=splunkd_url(uri),
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


def parse_export_results(response_body):
    rows = []

    for line in response_body.splitlines():
        line = line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except ValueError:
            continue

        if not isinstance(payload, dict):
            continue

        if isinstance(payload.get("result"), dict):
            rows.append(payload["result"])
        elif "fields" not in payload and "preview" not in payload:
            rows.append(payload)

    return rows


def run_spl_search(session_key, spl, timeout=SEARCH_EXPORT_TIMEOUT):
    """
    Run a generating SPL search via the export endpoint and return result rows.
    """
    uri = "/services/search/jobs/export?output_mode=json"
    form = {
        "search": spl,
    }

    response_body = splunkd_json_request(
        session_key=session_key,
        uri=uri,
        method="POST",
        form=form,
        timeout=timeout,
    )

    if response_body is None:
        return []

    if isinstance(response_body, list):
        return [row for row in response_body if isinstance(row, dict)]

    if isinstance(response_body, dict):
        if isinstance(response_body.get("results"), list):
            return response_body["results"]
        if isinstance(response_body.get("result"), dict):
            return [response_body["result"]]

    if isinstance(response_body, str):
        return parse_export_results(response_body)

    return []


def as_bool(value):
    if isinstance(value, list):
        value = value[0] if value else False
    return str(value).strip().lower() in ("1", "true", "yes")


def as_scalar(value, default=""):
    """
    Flatten export/search values into a single KV-safe scalar.

    Search export can return lists for multivalue fields such as
    values(notes).
    """
    if value is None:
        return default
    if isinstance(value, list):
        parts = [str(item).strip() for item in value if item is not None and str(item).strip()]
        return " | ".join(parts) if parts else default
    return str(value).strip() or default


def map_field_rows(result_rows, now):
    records = []
    seen = set()

    for row in result_rows:
        datamodel = as_scalar(row.get("datamodel") or row.get("title"))
        field_name = as_scalar(row.get("field_name"))

        if not datamodel or not field_name:
            continue

        dedupe_key = (datamodel.lower(), field_name.lower())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        recommended = as_bool(row.get("recommended"))
        required = as_bool(row.get("required"))
        field_status = as_scalar(row.get("field_status"))

        if not field_status:
            if required:
                field_status = "required"
            elif recommended:
                field_status = "recommended"
            else:
                field_status = "optional"

        notes = as_scalar(row.get("notes") or row.get("description"))

        records.append({
            "_key": make_datamodel_field_key(datamodel, field_name),
            "datamodel": datamodel,
            "field_name": field_name,
            "table_index": 1,
            "notes": notes,
            "field_status": field_status,
            "recommended": recommended,
            "required": required,
            "last_seen": now,
            "updated_at": now,
        })

    return records


def map_tag_rows(result_rows, now):
    records = []
    seen = set()

    for row in result_rows:
        datamodel = as_scalar(row.get("datamodel") or row.get("title"))
        expected_tag = as_scalar(row.get("expected_tag")).lower()
        tag_role = as_scalar(row.get("tag_role"), "supporting").lower()

        if not datamodel or not expected_tag:
            continue

        dedupe_key = (datamodel.lower(), expected_tag, tag_role)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        records.append({
            "_key": make_datamodel_tag_key(datamodel, expected_tag, tag_role),
            "datamodel": datamodel,
            "expected_tag": expected_tag,
            "tag_role": tag_role,
            "updated_at": now,
        })

    return records


def write_records_to_kvstore(session_key, collection_name, records, batch_size=500):
    if not records:
        return {
            "collection": collection_name,
            "attempted_records": 0,
            "batches": 0,
            "response": None,
        }

    uri = (
        f"/servicesNS/nobody/{APP_NAME}"
        f"/storage/collections/data/{collection_name}/batch_save"
    )

    batches = 0
    for start in range(0, len(records), batch_size):
        chunk = records[start:start + batch_size]
        try:
            splunkd_json_request(
                session_key=session_key,
                uri=uri,
                method="POST",
                payload=chunk,
            )
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else str(e)
            raise RuntimeError(
                "KV Store batch_save failed for %s (batch %s, records %s-%s): %s %s"
                % (
                    collection_name,
                    batches + 1,
                    start + 1,
                    start + len(chunk),
                    e.code,
                    body,
                )
            ) from e
        batches += 1

    return {
        "collection": collection_name,
        "attempted_records": len(records),
        "batches": batches,
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


def build_datamodel_fields_from_cim(session_key):
    now = int(time.time())
    errors = []

    try:
        result_rows = run_spl_search(session_key, DATAMODEL_FIELDS_SPL)
        records = map_field_rows(result_rows, now)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else str(e)
        return {
            "status": "error",
            "records_written": 0,
            "records_deleted": 0,
            "source": SA_CIM_SOURCE,
            "errors": [{"error": f"SA_CIM field metadata search failed: {body}"}],
        }
    except Exception as e:
        return {
            "status": "error",
            "records_written": 0,
            "records_deleted": 0,
            "source": SA_CIM_SOURCE,
            "errors": [{"error": str(e)}],
        }

    if not records:
        errors.append({
            "error": "No datamodel field rows returned from SA_CIM. Confirm SA_CIM is installed and datamodels are available.",
        })

    clear_result = clear_kvstore_collection(
        session_key=session_key,
        collection_name=DATAMODEL_FIELDS_COLLECTION,
    )
    errors.extend(clear_result.get("errors", []))

    if records:
        write_records_to_kvstore(
            session_key=session_key,
            collection_name=DATAMODEL_FIELDS_COLLECTION,
            records=records,
        )

    datamodels_checked = len({
        record["datamodel"]
        for record in records
    })

    return {
        "status": "ok" if records and not errors else ("partial" if records else "error"),
        "records_written": len(records),
        "records_deleted": clear_result.get("records_deleted", 0),
        "datamodels_checked": datamodels_checked,
        "source": SA_CIM_SOURCE,
        "errors": errors,
    }


def build_cim_datamodel_tags(session_key):
    now = int(time.time())
    errors = []

    try:
        result_rows = run_spl_search(session_key, CIM_DATAMODEL_TAGS_SPL)
        records = map_tag_rows(result_rows, now)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else str(e)
        return {
            "status": "error",
            "records_written": 0,
            "records_deleted": 0,
            "source": SA_CIM_SOURCE,
            "errors": [{"error": f"SA_CIM tag metadata search failed: {body}"}],
        }
    except Exception as e:
        return {
            "status": "error",
            "records_written": 0,
            "records_deleted": 0,
            "source": SA_CIM_SOURCE,
            "errors": [{"error": str(e)}],
        }

    if not records:
        errors.append({
            "error": "No datamodel tag rows returned from SA_CIM. Confirm SA_CIM is installed and datamodels are available.",
        })

    clear_result = clear_kvstore_collection(
        session_key=session_key,
        collection_name=CIM_DATAMODEL_TAGS_COLLECTION,
    )
    errors.extend(clear_result.get("errors", []))

    if records:
        write_records_to_kvstore(
            session_key=session_key,
            collection_name=CIM_DATAMODEL_TAGS_COLLECTION,
            records=records,
        )

    datamodels_checked = len({
        record["datamodel"]
        for record in records
    })

    return {
        "status": "ok" if records and not errors else ("partial" if records else "error"),
        "records_written": len(records),
        "records_deleted": clear_result.get("records_deleted", 0),
        "datamodels_checked": datamodels_checked,
        "source": SA_CIM_SOURCE,
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
            "source": SA_CIM_SOURCE,
        }))

    def handle_POST(self):
        self.response.setHeader("content-type", "application/json")

        try:
            action = get_request_value(self.request, "action") or "scrape_fields"

            if action == "build_tags":
                result = build_cim_datamodel_tags(self.sessionKey)

            elif action == "run_all":
                fields_result = build_datamodel_fields_from_cim(self.sessionKey)
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
                result = build_datamodel_fields_from_cim(self.sessionKey)

            result["action"] = action
            self.response.write(json.dumps(result))

        except Exception as e:
            self.response.setStatus(500)
            self.response.write(json.dumps({
                "status": "error",
                "message": str(e),
                "traceback": traceback.format_exc(),
            }))
