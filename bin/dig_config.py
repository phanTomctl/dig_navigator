import hashlib
import json
import re
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

CIM_TAG_REGEX = r'tag\s*=\s*"?([A-Za-z0-9_]+)"?'
CIM_MACRO_REGEX = re.compile(r"`[^`]+`")
CIM_NOT_CLAUSE_REGEX = re.compile(r"\bNOT\s*\([^)]*\)", flags=re.IGNORECASE)

# Root dataset parents in SA_CIM model JSON / REST eai:data.
ROOT_PARENTS = frozenset({"", "BaseEvent", "BaseSearch", "BaseTransaction"})

# Only ingest datamodels owned by the CIM add-on.
SA_CIM_APPS = {"Splunk_SA_CIM", "SA_CIM"}

# Legacy peer models and Splunk-internal models are excluded entirely.
EXCLUDED_DATAMODELS = {
    "application_state",
    "change_analysis",
    "splunk_cim_validation",
}
EXCLUDED_DATAMODEL_PREFIXES = ("splunk_", "internal_")

# Default Splunk metadata must not inflate CIM field matching.
METADATA_FIELD_NAMES = {
    "host",
    "source",
    "sourcetype",
    "index",
    "splunk_server",
    "splunk_server_group",
    "linecount",
    "punct",
    "eventtype",
    "constraint",
}

SA_CIM_MODEL_FILTER_SPL = r"""
| rename "eai:acl.app" as app
| where app="Splunk_SA_CIM" OR app="SA_CIM"
| eval dm_lower=lower(title)
| where NOT match(dm_lower, "^(application_state|change_analysis|splunk_cim_validation)$")
| where NOT match(dm_lower, "^(splunk_|internal_)")
""".strip()

DATAMODEL_FIELDS_SPL = rf"""
| rest /services/data/models
| fields title eai:acl.app eai:data
{SA_CIM_MODEL_FILTER_SPL}
| spath input=eai:data path=objects{{}} output=object
| mvexpand object
| spath input=object path=objectName output=dataset
| spath input=object path=fields{{}} output=normal_fields
| spath input=object path=calculations{{}}.outputFields{{}} output=calc_fields
| eval field_json=mvappend(normal_fields, calc_fields)
| mvexpand field_json
| spath input=field_json path=fieldName output=field_name
| spath input=field_json path=comment.recommended output=recommended
| spath input=field_json path=comment.description output=description
| spath input=field_json path=required output=required
| spath input=field_json path=hidden output=hidden
| where isnotnull(field_name) AND field_name!="" AND (hidden!="true" OR isnull(hidden))
| eval field_name=lower(trim(field_name))
| where NOT match(field_name, "^_")
| where NOT match(field_name, "^(host|source|sourcetype|index|splunk_server|splunk_server_group|linecount|punct|eventtype|constraint)$")
| eval datamodel=title
| eval notes=description
| eval recommended=if(recommended="true" OR recommended=1,1,0)
| eval required=if(required="true" OR required=1,1,0)
| eval field_status=case(
    required=1, "required",
    recommended=1, "recommended",
    true(), "optional"
)
| stats
    max(required) as required
    max(recommended) as recommended
    first(notes) as notes
    by datamodel field_name
| eval field_status=case(
    required=1, "required",
    recommended=1, "recommended",
    true(), "optional"
)
| eval source_url="/services/data/models"
| eval last_seen=now()
| eval updated_at=now()
| table datamodel, field_name, notes, source_url, field_status, recommended, required, last_seen, updated_at
| sort datamodel field_name
""".strip()

CIM_DATAMODEL_TAGS_SPL = rf"""
| rest /services/data/models
| fields title eai:acl.app eai:data
{SA_CIM_MODEL_FILTER_SPL}
| spath input=eai:data path=objects{{}} output=object
| mvexpand object
| spath input=object path=objectName output=dataset
| spath input=object path=parentName output=parent_dataset
| spath input=object path=comment.tags{{}} output=object_tags
| spath input=object path=constraints{{}}.search output=constraint_search
| table title dataset parent_dataset object_tags constraint_search
| sort title dataset
""".strip()


def is_allowed_datamodel(datamodel):
    if not datamodel:
        return False
    dm_lower = datamodel.strip().lower()
    if dm_lower in EXCLUDED_DATAMODELS:
        return False
    if dm_lower.startswith(EXCLUDED_DATAMODEL_PREFIXES):
        return False
    return True


def is_metadata_field(field_name):
    if not field_name:
        return True
    fn = field_name.strip().lower()
    return fn.startswith("_") or fn in METADATA_FIELD_NAMES


def make_datamodel_field_key(datamodel, field_name):
    raw = f"{datamodel}:{field_name}".lower().encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def make_datamodel_tag_key(datamodel, tag, tag_role, coverage_set=""):
    raw = f"{datamodel}:{coverage_set}:{tag_role}:{tag}".lower().encode("utf-8")
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


def split_tag_values(value):
    tags = []

    if value is None:
        return tags

    raw_values = value if isinstance(value, list) else [value]
    for raw in raw_values:
        for chunk in str(raw).replace("\r", "\n").split("\n"):
            for item in chunk.split(","):
                candidate = item.strip().strip('"').strip("'").lower()
                if candidate:
                    tags.append(candidate)

    return tags


def extract_constraint_tags(value):
    matches = []
    raw_values = value if isinstance(value, list) else [value]
    for raw in raw_values:
        matches.extend(re.findall(CIM_TAG_REGEX, str(raw), flags=re.IGNORECASE))
    return [match.strip().lower() for match in matches if match and match.strip()]


def normalize_constraint_text(value):
    raw_values = value if isinstance(value, list) else [value]
    parts = []
    for raw in raw_values:
        text = str(raw or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts)


def parse_constraint_tag_requirements(constraint_search):
    """
    Parse a CIM dataset constraint into:
      - and_tags: required together for coverage (e.g. network + communicate)
      - category_tags: OR-group alternatives (e.g. Inventory cpu|memory|...)

    Index macros and NOT(...) clauses are stripped before parsing.
    """
    text = normalize_constraint_text(constraint_search)
    if not text:
        return set(), set()

    text = CIM_MACRO_REGEX.sub(" ", text)
    text = CIM_NOT_CLAUSE_REGEX.sub(" ", text)

    category_tags = set()
    spans = []
    stack = []
    for idx, char in enumerate(text):
        if char == "(":
            stack.append(idx)
        elif char == ")" and stack:
            start = stack.pop()
            spans.append((start, idx + 1, text[start + 1:idx]))

    or_spans = [
        span for span in spans
        if re.search(r"\bOR\b", span[2], flags=re.IGNORECASE)
        and re.search(CIM_TAG_REGEX, span[2], flags=re.IGNORECASE)
    ]
    # Keep outermost OR groups only (nested OR branches stay inside the parent group).
    outer_or_spans = [
        span for span in or_spans
        if not any(
            other is not span
            and span[0] >= other[0]
            and span[1] <= other[1]
            for other in or_spans
        )
    ]

    remainder = text
    for start, end, inner in sorted(outer_or_spans, key=lambda item: item[0], reverse=True):
        for tag in re.findall(CIM_TAG_REGEX, inner, flags=re.IGNORECASE):
            cleaned = tag.strip().lower()
            if cleaned:
                category_tags.add(cleaned)
        remainder = remainder[:start] + " " + remainder[end:]

    and_tags = {
        tag.strip().lower()
        for tag in re.findall(CIM_TAG_REGEX, remainder, flags=re.IGNORECASE)
        if tag and tag.strip()
    }
    and_tags -= category_tags
    return and_tags, category_tags


def is_valid_cim_tag(tag):
    return bool(tag) and bool(re.match(r"^[a-z0-9_]+$", tag))


def map_field_rows(result_rows, now):
    records = []
    seen = set()

    for row in result_rows:
        datamodel = as_scalar(row.get("datamodel") or row.get("title"))
        field_name = as_scalar(row.get("field_name"))

        if not datamodel or not field_name:
            continue
        if not is_allowed_datamodel(datamodel):
            continue
        if is_metadata_field(field_name):
            continue

        field_name = field_name.strip().lower()
        dedupe_key = (datamodel.lower(), field_name)
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
        source_url = as_scalar(row.get("source_url")) or "/services/data/models"

        records.append({
            "_key": make_datamodel_field_key(datamodel, field_name),
            "datamodel": datamodel,
            "field_name": field_name,
            "notes": notes,
            "source_url": source_url,
            "field_status": field_status,
            "recommended": recommended,
            "required": required,
            "last_seen": now,
            "updated_at": now,
        })

    return records


def map_tag_rows(result_rows, now):
    """
    Build CIM tag role records from SA_CIM dataset hierarchy.

    Coverage model:
      - Each root dataset (BaseEvent/BaseSearch/BaseTransaction) is a coverage_set.
      - top_level tags are AND-required within that set (from root constraints, or
        comment.tags when the constraint has no tag= clauses).
      - A datamodel is covered when ANY coverage_set has all of its top_level tags present.
      - OR-group tags from root constraints (Inventory/Performance categories) and
        non-root object tags are supporting context only; they do not gate coverage.
      - constraint tags are every tag= value found in constraint searches (informational).
    """
    records = []
    seen = set()

    per_datamodel = {}

    for row in result_rows:
        datamodel = as_scalar(row.get("datamodel") or row.get("title"))
        dataset = as_scalar(row.get("dataset") or row.get("objectName"))
        parent_dataset = as_scalar(row.get("parent_dataset") or row.get("parentName"))
        if not datamodel:
            continue
        if not is_allowed_datamodel(datamodel):
            continue

        model_state = per_datamodel.setdefault(
            datamodel,
            {
                "roots": {},
                "supporting": set(),
                "constraint": set(),
            },
        )

        object_tags = [
            tag for tag in split_tag_values(row.get("object_tags")) if is_valid_cim_tag(tag)
        ]
        constraint_text = normalize_constraint_text(row.get("constraint_search"))
        and_tags, category_tags = parse_constraint_tag_requirements(constraint_text)
        and_tags = {tag for tag in and_tags if is_valid_cim_tag(tag)}
        category_tags = {tag for tag in category_tags if is_valid_cim_tag(tag)}
        model_state["constraint"].update(extract_constraint_tags(constraint_text))

        if parent_dataset in ROOT_PARENTS:
            coverage_set = dataset or "root"
            root_state = model_state["roots"].setdefault(
                coverage_set,
                {"top_level": set()},
            )
            if and_tags:
                root_state["top_level"].update(and_tags)
            elif object_tags:
                # BaseSearch roots often store requirements only in comment.tags.
                root_state["top_level"].update(object_tags)
            # Inventory/Performance OR branches are supporting context only.
            model_state["supporting"].update(category_tags)
        else:
            model_state["supporting"].update(object_tags)

    for datamodel, model_state in per_datamodel.items():
        datamodel_lower = datamodel.lower()
        reserved_tags = set()

        for coverage_set, root_state in sorted(model_state["roots"].items()):
            for expected_tag in sorted(root_state["top_level"]):
                reserved_tags.add(expected_tag)
                dedupe_key = (datamodel_lower, coverage_set, expected_tag, "top_level")
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                records.append({
                    "_key": make_datamodel_tag_key(
                        datamodel, expected_tag, "top_level", coverage_set
                    ),
                    "datamodel": datamodel,
                    "expected_tag": expected_tag,
                    "tag_role": "top_level",
                    "coverage_set": coverage_set,
                    "updated_at": now,
                })

        for expected_tag in sorted(model_state["supporting"] - reserved_tags):
            if not is_valid_cim_tag(expected_tag):
                continue
            dedupe_key = (datamodel_lower, "", expected_tag, "supporting")
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            records.append({
                "_key": make_datamodel_tag_key(datamodel, expected_tag, "supporting"),
                "datamodel": datamodel,
                "expected_tag": expected_tag,
                "tag_role": "supporting",
                "coverage_set": "",
                "updated_at": now,
            })

        for expected_tag in sorted(model_state["constraint"]):
            if not is_valid_cim_tag(expected_tag):
                continue
            dedupe_key = (datamodel_lower, "", expected_tag, "constraint")
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            records.append({
                "_key": make_datamodel_tag_key(datamodel, expected_tag, "constraint"),
                "datamodel": datamodel,
                "expected_tag": expected_tag,
                "tag_role": "constraint",
                "coverage_set": "",
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


def kvstore_has_records(session_key, collection_name):
    """Return True when the named KV collection has at least one record."""
    uri = (
        f"/servicesNS/nobody/{APP_NAME}"
        f"/storage/collections/data/{collection_name}"
        f"?output_mode=json&limit=1"
    )
    try:
        records = splunkd_json_request(
            session_key=session_key,
            uri=uri,
            method="GET",
        )
    except Exception:
        return False

    return isinstance(records, list) and len(records) > 0


def set_app_is_configured(session_key, configured=True):
    """
    Persist [install] is_configured in local/app.conf and reload the app.

    Splunk uses this flag with setup_view to force Configuration until setup completes.
    """
    value = "1" if configured else "0"
    errors = []

    # Ensure the [install] stanza exists in local app.conf, then set the key.
    try:
        splunkd_json_request(
            session_key=session_key,
            uri=f"/servicesNS/nobody/{APP_NAME}/properties/app?output_mode=json",
            method="POST",
            form={"__stanza": "install"},
        )
    except Exception as e:
        # Stanza may already exist; continue and try the property update.
        errors.append({"step": "ensure_install_stanza", "error": str(e)})

    try:
        splunkd_json_request(
            session_key=session_key,
            uri=(
                f"/servicesNS/nobody/{APP_NAME}"
                f"/properties/app/install/is_configured?output_mode=json"
            ),
            method="POST",
            form={"value": value},
        )
    except Exception as e:
        # Fallback used by many apps / older endpoints.
        try:
            splunkd_json_request(
                session_key=session_key,
                uri=f"/servicesNS/nobody/{APP_NAME}/properties/app/install?output_mode=json",
                method="POST",
                form={"is_configured": value},
            )
        except Exception as e2:
            return {
                "ok": False,
                "is_configured": value,
                "errors": errors + [
                    {"step": "set_is_configured", "error": str(e)},
                    {"step": "set_is_configured_fallback", "error": str(e2)},
                ],
            }

    try:
        splunkd_json_request(
            session_key=session_key,
            uri=f"/servicesNS/nobody/{APP_NAME}/apps/local/{APP_NAME}/_reload",
            method="POST",
            form={},
        )
    except Exception as e:
        errors.append({"step": "reload_app", "error": str(e)})

    return {
        "ok": True,
        "is_configured": value,
        "errors": errors,
    }


def maybe_mark_app_configured(session_key):
    """
    Mark the app configured once both CIM field and tag lookups have data.
    """
    fields_ready = kvstore_has_records(session_key, DATAMODEL_FIELDS_COLLECTION)
    tags_ready = kvstore_has_records(session_key, CIM_DATAMODEL_TAGS_COLLECTION)

    if not (fields_ready and tags_ready):
        return {
            "app_configured": False,
            "fields_ready": fields_ready,
            "tags_ready": tags_ready,
            "detail": "Both datamodel field and tag lookups must contain records before setup is complete.",
        }

    configure_result = set_app_is_configured(session_key, configured=True)
    return {
        "app_configured": bool(configure_result.get("ok")),
        "fields_ready": fields_ready,
        "tags_ready": tags_ready,
        "configure_result": configure_result,
    }


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
            result["setup"] = maybe_mark_app_configured(self.sessionKey)
            self.response.write(json.dumps(result))

        except Exception as e:
            self.response.setStatus(500)
            self.response.write(json.dumps({
                "status": "error",
                "message": str(e),
                "traceback": traceback.format_exc(),
            }))
