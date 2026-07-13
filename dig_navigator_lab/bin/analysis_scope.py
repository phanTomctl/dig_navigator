import hashlib
import json
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

import splunk.rest
from splunk.rest import BaseRestHandler

APP_NAME = "dig_navigator_lab"
COLLECTION = "dig_analysis_scope"
MAX_SAMPLE_LIMIT = 100000

DEFAULT_SCOPE = {
    "base_search": "index=somerandomindex sourcetype=mysourcetype",
    "earliest": "-24h",
    "latest": "now",
    "group_by": "sourcetype",
    "sample_limit": "5000",
}


def splunkd_url(uri):
    return splunk.rest.makeSplunkdUri().rstrip("/") + uri


def splunkd_request(session_key, uri, method="GET", payload=None, form=None, timeout=30):
    headers = {"Authorization": "Splunk %s" % session_key}
    data = None

    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    elif form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urllib.parse.urlencode(form).encode("utf-8")

    req = urllib.request.Request(splunkd_url(uri), data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")

    if not body:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return body


def get_request_value(request, key):
    if not hasattr(request, "get"):
        return None

    value = request.get(key)
    if value not in (None, ""):
        return value

    for container_name in ("payload", "form", "query"):
        container = request.get(container_name)
        if isinstance(container, dict):
            value = container.get(key)
            if value not in (None, ""):
                return value

    return None


def normalise_sample_limit(value):
    try:
        limit = int(str(value).strip())
    except Exception:
        limit = int(DEFAULT_SCOPE["sample_limit"])
    if limit < 1:
        limit = 1
    if limit > MAX_SAMPLE_LIMIT:
        limit = MAX_SAMPLE_LIMIT
    return str(limit)


def safe_scope_from_request(request):
    scope = {}
    for key in ("base_search", "earliest", "latest", "group_by", "sample_limit"):
        value = get_request_value(request, key)
        if value in (None, ""):
            value = DEFAULT_SCOPE[key]
        scope[key] = str(value).strip()

    if scope["group_by"] not in ("sourcetype", "source"):
        scope["group_by"] = DEFAULT_SCOPE["group_by"]
    scope["sample_limit"] = normalise_sample_limit(scope["sample_limit"])
    return scope


def get_current_username(session_key):
    context = splunkd_request(
        session_key,
        "/services/authentication/current-context?output_mode=json",
        method="GET",
    )
    if isinstance(context, dict):
        entries = context.get("entry", [])
        if entries:
            content = entries[0].get("content", {})
            username = content.get("username") or content.get("user")
            if username:
                return username
    return "unknown"


def scope_key(username):
    raw = (username or "unknown").lower().encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def collection_config_uri():
    return "/servicesNS/nobody/%s/storage/collections/config/%s" % (APP_NAME, COLLECTION)


def collection_data_uri():
    return "/servicesNS/nobody/%s/storage/collections/data/%s" % (APP_NAME, COLLECTION)


def record_uri(key):
    return collection_data_uri() + "/" + urllib.parse.quote(key, safe="")


def ensure_collection(session_key):
    """Create the KV collection on demand if it has not yet materialised after install."""
    try:
        splunkd_request(session_key, collection_config_uri() + "?output_mode=json", method="GET")
        return
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    # The collection is also declared in collections.conf. This fallback makes first-load
    # behaviour more robust on fresh installs where the collection is not yet available.
    splunkd_request(
        session_key,
        "/servicesNS/nobody/%s/storage/collections/config?output_mode=json" % APP_NAME,
        method="POST",
        form={"name": COLLECTION},
    )


def get_scope(session_key):
    username = get_current_username(session_key)
    key = scope_key(username)
    ensure_collection(session_key)

    record = {}
    try:
        query = urllib.parse.quote(json.dumps({"_key": key}), safe="")
        records = splunkd_request(
            session_key,
            collection_data_uri() + '?query=' + query + '&output_mode=json',
            method="GET",
        )
        if isinstance(records, list) and records:
            record = records[0]
        elif isinstance(records, dict):
            record = records
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    scope = DEFAULT_SCOPE.copy()
    if isinstance(record, dict):
        for field in DEFAULT_SCOPE:
            if record.get(field) not in (None, ""):
                scope[field] = str(record.get(field))

    scope["username"] = username
    scope["is_default"] = not bool(record)
    scope["updated_at"] = record.get("updated_at") if isinstance(record, dict) else None
    return scope


def save_scope(session_key, request, reset=False):
    username = get_current_username(session_key)
    key = scope_key(username)
    scope = DEFAULT_SCOPE.copy() if reset else safe_scope_from_request(request)
    ensure_collection(session_key)

    record = {
        "_key": key,
        "username": username,
        "base_search": scope["base_search"],
        "earliest": scope["earliest"],
        "latest": scope["latest"],
        "group_by": scope["group_by"],
        "sample_limit": scope["sample_limit"],
        "updated_at": int(time.time()),
    }

    # Splunk KV Store does not reliably create a new record by POSTing to a keyed URI.
    # Delete-if-present then insert to the collection root gives deterministic upsert behaviour.
    try:
        splunkd_request(session_key, record_uri(key) + "?output_mode=json", method="DELETE")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    splunkd_request(
        session_key,
        collection_data_uri() + "?output_mode=json",
        method="POST",
        payload=record,
    )

    result = record.copy()
    result["status"] = "ok"
    result["reset"] = reset
    return result


class AnalysisScope(BaseRestHandler):
    def _write_json(self, payload, status=200):
        self.response.setStatus(status)
        self.response.setHeader("content-type", "application/json")
        self.response.write(json.dumps(payload))

    def handle_GET(self):
        try:
            result = get_scope(self.sessionKey)
            result["status"] = "ok"
            self._write_json(result)
        except Exception as e:
            self._write_json({
                "status": "error",
                "message": str(e),
                "traceback": traceback.format_exc(),
            }, status=500)

    def handle_POST(self):
        try:
            action = get_request_value(self.request, "action") or "save"
            result = save_scope(self.sessionKey, self.request, reset=(action == "reset"))
            self._write_json(result)
        except Exception as e:
            self._write_json({
                "status": "error",
                "message": str(e),
                "traceback": traceback.format_exc(),
            }, status=500)
