/*
 * DIG Analysis Scope v2 (cache-busted filename)
 *
 * Fixes vs dig_analysis_scope_kv.js:
 * - Sync live Analysis Scope text into default+submitted tokens on every edit
 *   so SimpleXML drilldowns ($base_search$) see unsaved scope.
 * - Stash scope in sessionStorage + rewrite window.open / anchor URLs at click.
 * - Landing: stash, then any URL form.base_search, then KV (never let KV win a drilldown).
 * - Cancel KV/URL reapply when the user edits so reapply cannot fight typing.
 * - DIG-owned Show/Hide Filters (inject CSS + hide native Splunk control in JS).
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/utils",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc, utils) {
    "use strict";

    var SCOPE_JS_VERSION = "v2-20260731";
    var DEFAULT_SCOPE = {
        base_search: "index=somerandomindex sourcetype=mysourcetype",
        earliest: "-24h",
        latest: "now",
        group_by: "sourcetype",
        sample_limit: "1000"
    };

    var MAX_SAMPLE_LIMIT = 100000;
    var DRILLDOWN_SCOPE_KEY = "dig_navigator_lab_drilldown_scope";
    var endpoint = makeUrl("/splunkd/__raw/servicesNS/nobody/dig_navigator_lab/analysis_scope?output_mode=json");
    var defaultTokens = mvc.Components.get("default");
    var submittedTokens = mvc.Components.get("submitted");
    var scopeReapplyTimers = [];
    var filtersCollapsed = false;
    var userEditing = false;

    if (window.console && console.info) {
        console.info("DIG Analysis Scope " + SCOPE_JS_VERSION + " loaded");
    }

    function makeUrl(path) {
        try {
            if (utils && typeof utils.make_url === "function") {
                return utils.make_url(path);
            }
        } catch (e) {}
        try {
            if (window.Splunk && Splunk.util && typeof Splunk.util.make_url === "function") {
                return Splunk.util.make_url(path);
            }
        } catch (e) {}
        return path;
    }

    function parseQuery() {
        var out = {};
        var search = window.location.search || "";
        if (search.charAt(0) === "?") {
            search = search.substring(1);
        }
        if (!search) {
            return out;
        }
        search.split("&").forEach(function(part) {
            if (!part) {
                return;
            }
            var idx = part.indexOf("=");
            var rawKey = idx >= 0 ? part.substring(0, idx) : part;
            var rawValue = idx >= 0 ? part.substring(idx + 1) : "";
            try {
                out[decodeURIComponent(rawKey.replace(/\+/g, " "))] = decodeURIComponent(rawValue.replace(/\+/g, " "));
            } catch (e) {
                out[rawKey] = rawValue;
            }
        });
        return out;
    }

    function getQueryValue(params, names) {
        for (var i = 0; i < names.length; i++) {
            if (Object.prototype.hasOwnProperty.call(params, names[i])) {
                return params[names[i]];
            }
        }
        return null;
    }

    function normaliseLimit(value) {
        var limit = parseInt(value, 10);
        if (isNaN(limit) || limit < 1) {
            limit = parseInt(DEFAULT_SCOPE.sample_limit, 10);
        }
        if (limit > MAX_SAMPLE_LIMIT) {
            limit = MAX_SAMPLE_LIMIT;
        }
        return String(limit);
    }

    function normaliseScope(scope) {
        scope = $.extend({}, DEFAULT_SCOPE, scope || {});
        scope.base_search = String(scope.base_search || DEFAULT_SCOPE.base_search);
        scope.earliest = String(scope.earliest || DEFAULT_SCOPE.earliest);
        scope.latest = String(scope.latest || DEFAULT_SCOPE.latest);
        scope.group_by = String(scope.group_by || DEFAULT_SCOPE.group_by);
        if (scope.group_by !== "source" && scope.group_by !== "sourcetype") {
            scope.group_by = DEFAULT_SCOPE.group_by;
        }
        scope.sample_limit = normaliseLimit(scope.sample_limit);
        return scope;
    }

    function scopesEqual(left, right) {
        left = normaliseScope(left);
        right = normaliseScope(right);
        return left.base_search === right.base_search &&
            left.earliest === right.earliest &&
            left.latest === right.latest &&
            left.group_by === right.group_by &&
            left.sample_limit === right.sample_limit;
    }

    function isWildcardDrilldownValue(value) {
        if (value === null || value === undefined) {
            return true;
        }
        value = String(value).trim();
        return value === "" || value === "*";
    }

    function clearScopeReapply() {
        scopeReapplyTimers.forEach(function(timerId) {
            window.clearTimeout(timerId);
        });
        scopeReapplyTimers = [];
    }

    function scheduleScopeReapply(scope, attemptsRemaining) {
        clearScopeReapply();
        if (!attemptsRemaining || attemptsRemaining < 1) {
            return;
        }

        function tick(remaining) {
            if (remaining < 1) {
                return;
            }
            var timerId = window.setTimeout(function() {
                if (userEditing) {
                    return;
                }
                var current = readCurrentScope();
                if (!scopesEqual(current, scope)) {
                    setScopeTokens(scope, { refresh: true, updateInputs: true });
                }
                tick(remaining - 1);
            }, 500);
            scopeReapplyTimers.push(timerId);
        }

        tick(attemptsRemaining);
    }

    function hasMeaningfulDrilldownContext(params) {
        var markerGroups = [
            ["form.selected_group", "selected_group"],
            ["form.classification", "classification"],
            ["form.selected_delay_category", "selected_delay_category"],
            ["form.selected_timestamp_indicator", "selected_timestamp_indicator"],
            ["form.datamodel_filter", "datamodel_filter"],
            ["form.capability_filter", "capability_filter"],
            ["form.coverage_filter", "coverage_filter"],
            ["form.governance_relevance_filter", "governance_relevance_filter"],
            ["form.tier_filter", "tier_filter"],
            ["form.retention_filter", "retention_filter"],
            ["form.framework_filter", "framework_filter"]
        ];

        for (var i = 0; i < markerGroups.length; i++) {
            var value = getQueryValue(params, markerGroups[i]);
            if (!isWildcardDrilldownValue(value)) {
                return true;
            }
        }
        return false;
    }

    function getUrlScopeFromParams(params) {
        var baseSearch = getQueryValue(params, ["form.base_search", "base_search"]);
        var earliest = getQueryValue(params, ["form.time_range.earliest", "time_range.earliest", "earliest"]);
        var latest = getQueryValue(params, ["form.time_range.latest", "time_range.latest", "latest"]);
        var groupBy = getQueryValue(params, ["form.group_by", "group_by"]);
        var sampleLimit = getQueryValue(params, ["form.sample_limit", "sample_limit"]);

        if (!baseSearch && !earliest && !latest && !groupBy && !sampleLimit) {
            return null;
        }

        return normaliseScope({
            base_search: baseSearch || DEFAULT_SCOPE.base_search,
            earliest: earliest || DEFAULT_SCOPE.earliest,
            latest: latest || DEFAULT_SCOPE.latest,
            group_by: groupBy || DEFAULT_SCOPE.group_by,
            sample_limit: sampleLimit || DEFAULT_SCOPE.sample_limit
        });
    }

    function getUrlDrilldownScope() {
        var params = parseQuery();
        var baseSearch = getQueryValue(params, ["form.base_search", "base_search"]);
        // Any non-empty form.base_search in the URL is a drilldown override.
        if (baseSearch !== null && String(baseSearch).trim() !== "") {
            return getUrlScopeFromParams(params);
        }
        if (hasMeaningfulDrilldownContext(params)) {
            return getUrlScopeFromParams(params);
        }
        return null;
    }

    function stashDrilldownScope(scope) {
        try {
            window.sessionStorage.setItem(DRILLDOWN_SCOPE_KEY, JSON.stringify(normaliseScope(scope)));
        } catch (e) {}
    }

    function consumeStashedDrilldownScope() {
        try {
            var raw = window.sessionStorage.getItem(DRILLDOWN_SCOPE_KEY);
            if (!raw) {
                return null;
            }
            window.sessionStorage.removeItem(DRILLDOWN_SCOPE_KEY);
            return normaliseScope(JSON.parse(raw));
        } catch (e) {
            return null;
        }
    }

    function replaceQueryParam(url, name, value) {
        var parts = String(url || "").split("#");
        var baseAndQuery = parts[0];
        var hash = parts.length > 1 ? "#" + parts.slice(1).join("#") : "";
        var qIdx = baseAndQuery.indexOf("?");
        var path = qIdx >= 0 ? baseAndQuery.substring(0, qIdx) : baseAndQuery;
        var query = qIdx >= 0 ? baseAndQuery.substring(qIdx + 1) : "";
        var params = query ? query.split("&") : [];
        var encodedName = encodeURIComponent(name);
        var encodedValue = encodeURIComponent(value == null ? "" : String(value));
        var found = false;
        var next = params.map(function(part) {
            if (!part) {
                return part;
            }
            var eq = part.indexOf("=");
            var key = eq >= 0 ? part.substring(0, eq) : part;
            try {
                key = decodeURIComponent(key.replace(/\+/g, " "));
            } catch (e) {}
            if (key === name || key === encodedName) {
                found = true;
                return encodedName + "=" + encodedValue;
            }
            return part;
        }).filter(function(part) {
            return part !== "";
        });
        if (!found) {
            next.push(encodedName + "=" + encodedValue);
        }
        return path + (next.length ? "?" + next.join("&") : "") + hash;
    }

    function applyLiveScopeToUrl(url) {
        var scope = readCurrentScope();
        stashDrilldownScope(scope);
        syncTokensFromLiveScope();
        if (!url || typeof url !== "string") {
            return url;
        }
        if (url.indexOf("base_search=") < 0) {
            return url;
        }
        var next = url;
        next = replaceQueryParam(next, "form.base_search", scope.base_search);
        next = replaceQueryParam(next, "form.group_by", scope.group_by);
        next = replaceQueryParam(next, "form.sample_limit", scope.sample_limit);
        next = replaceQueryParam(next, "form.time_range.earliest", scope.earliest);
        next = replaceQueryParam(next, "form.time_range.latest", scope.latest);
        return next;
    }

    function installDrilldownScopeRewrite() {
        document.addEventListener("mousedown", function() {
            try {
                stashDrilldownScope(readCurrentScope());
                syncTokensFromLiveScope();
            } catch (e) {}
        }, true);

        document.addEventListener("click", function(e) {
            var node = e.target;
            while (node && node !== document && node.tagName !== "A") {
                node = node.parentNode;
            }
            if (!node || node.tagName !== "A") {
                return;
            }
            var href = node.getAttribute("href");
            if (!href || href.indexOf("base_search=") < 0) {
                return;
            }
            var next = applyLiveScopeToUrl(href);
            if (next && next !== href) {
                node.setAttribute("href", next);
            }
        }, true);

        try {
            if (!window.__digOpenPatchedV2) {
                window.__digOpenPatchedV2 = true;
                var origOpen = window.open;
                window.open = function(url, name, specs) {
                    try {
                        url = applyLiveScopeToUrl(url);
                    } catch (e) {}
                    return origOpen.call(window, url, name, specs);
                };
            }
        } catch (e) {}
    }

    function getToken(primary, fallback, defaultValue) {
        var value;
        if (defaultTokens) {
            value = defaultTokens.get(primary);
            if (value === undefined || value === null || value === "") {
                value = defaultTokens.get(fallback);
            }
        }
        if ((value === undefined || value === null || value === "") && submittedTokens) {
            value = submittedTokens.get(primary);
            if (value === undefined || value === null || value === "") {
                value = submittedTokens.get(fallback);
            }
        }
        if (value === undefined || value === null || value === "") {
            value = defaultValue;
        }
        return value;
    }

    function getInputComponents() {
        var components = [];
        try {
            if (mvc.Components && typeof mvc.Components.getInstances === "function") {
                mvc.Components.getInstances().forEach(function(component) {
                    try {
                        var token = component.settings && component.settings.get && component.settings.get("token");
                        if (token) {
                            components.push({ component: component, token: token });
                        }
                    } catch (e) {}
                });
            }
        } catch (e) {}
        return components;
    }

    function readComponentValue(tokenName) {
        var result;
        getInputComponents().forEach(function(item) {
            if (result !== undefined || item.token !== tokenName) {
                return;
            }
            try {
                if (typeof item.component.val === "function") {
                    result = item.component.val();
                } else if (item.component.settings && item.component.settings.get) {
                    result = item.component.settings.get("value");
                }
            } catch (e) {}
        });
        return result;
    }

    function readDomTextValue(containerClass) {
        var $input = $(containerClass).find("input[type='text'], input[data-test='textbox'], textarea").first();
        if (!$input.length) {
            $input = $(".dashboard-form-globalfieldset input[type='text']").first();
            if (containerClass.indexOf("sample") >= 0) {
                $input = $(".dashboard-form-globalfieldset .dig-sample-limit-input input, .dashboard-form-globalfieldset input").eq(1);
            }
        }
        if (!$input.length) {
            return null;
        }
        var value = $input.val();
        if (value === undefined || value === null || value === "") {
            return null;
        }
        return String(value);
    }

    function readCurrentScope() {
        var timeValue = readComponentValue("time_range");
        var earliest = getToken("form.time_range.earliest", "time_range.earliest", DEFAULT_SCOPE.earliest);
        var latest = getToken("form.time_range.latest", "time_range.latest", DEFAULT_SCOPE.latest);

        if (timeValue && typeof timeValue === "object") {
            earliest = timeValue.earliest_time || timeValue.earliest || earliest;
            latest = timeValue.latest_time || timeValue.latest || latest;
        }

        var baseSearch = readDomTextValue(".dig-analysis-scope-input") ||
            readComponentValue("base_search") ||
            getToken("form.base_search", "base_search", DEFAULT_SCOPE.base_search);
        var sampleLimit = readDomTextValue(".dig-sample-limit-input") ||
            readComponentValue("sample_limit") ||
            getToken("form.sample_limit", "sample_limit", DEFAULT_SCOPE.sample_limit);

        return normaliseScope({
            base_search: baseSearch,
            earliest: earliest,
            latest: latest,
            group_by: readComponentValue("group_by") || getToken("form.group_by", "group_by", DEFAULT_SCOPE.group_by),
            sample_limit: sampleLimit
        });
    }

    function setModelToken(model, name, value) {
        if (model && typeof model.set === "function") {
            model.set(name, value);
        }
    }

    function setComponentValue(component, value) {
        try {
            if (typeof component.val === "function") {
                component.val(value);
            }
        } catch (e) {}
        try {
            if (component.settings && typeof component.settings.set === "function") {
                component.settings.set("value", value);
            }
        } catch (e) {}
    }

    function pushScopePairs(scope) {
        var pairs = {
            "base_search": scope.base_search,
            "form.base_search": scope.base_search,
            "time_range.earliest": scope.earliest,
            "form.time_range.earliest": scope.earliest,
            "time_range.latest": scope.latest,
            "form.time_range.latest": scope.latest,
            "group_by": scope.group_by,
            "form.group_by": scope.group_by,
            "sample_limit": scope.sample_limit,
            "form.sample_limit": scope.sample_limit
        };

        Object.keys(pairs).forEach(function(name) {
            setModelToken(defaultTokens, name, pairs[name]);
            setModelToken(submittedTokens, name, pairs[name]);
        });
    }

    function syncTokensFromLiveScope() {
        var scope = normaliseScope(readCurrentScope());
        pushScopePairs(scope);
        updateScopeSummary(scope);
        return scope;
    }

    function setScopeTokens(scope, options) {
        options = options || {};
        scope = normaliseScope(scope);
        pushScopePairs(scope);
        if (options.updateInputs !== false) {
            updateVisibleInputs(scope);
        }
        updateScopeSummary(scope);
        if (options.refresh !== false) {
            refreshSearches();
        }
    }

    function updateVisibleInputs(scope) {
        getInputComponents().forEach(function(item) {
            try {
                if (item.token === "base_search") {
                    setComponentValue(item.component, scope.base_search);
                } else if (item.token === "group_by") {
                    setComponentValue(item.component, scope.group_by);
                } else if (item.token === "sample_limit") {
                    setComponentValue(item.component, scope.sample_limit);
                } else if (item.token === "time_range") {
                    setComponentValue(item.component, { earliest_time: scope.earliest, latest_time: scope.latest });
                }
            } catch (e) {}
        });
    }

    function refreshSearches() {
        try {
            if (!mvc.Components || typeof mvc.Components.getInstances !== "function") {
                return;
            }
            mvc.Components.getInstances().forEach(function(component) {
                try {
                    if (component && typeof component.startSearch === "function") {
                        component.startSearch();
                    }
                } catch (e) {}
            });
        } catch (e) {}
    }

    function updateStatus(message, isError) {
        var status = $("#dig_scope_status");
        if (!status.length) {
            return;
        }
        status.text(message || "");
        status.toggleClass("dig-scope-error", !!isError);
    }

    function updateScopeSummary(scope) {
        scope = normaliseScope(scope || readCurrentScope());
        var summary = "Current scope: " + scope.base_search + " | Time: " + scope.earliest + " to " + scope.latest + " | Group: " + scope.group_by + " | Limit: " + scope.sample_limit;
        $("#dig_scope_summary").text(summary);
    }

    function markScopeInputs() {
        getInputComponents().forEach(function(item) {
            try {
                var el = item.component.$el || item.component.el;
                var container = $(el).closest(".input");
                if (!container.length) {
                    container = $(el);
                }
                if (item.token === "base_search") {
                    container.addClass("dig-analysis-scope-input");
                } else if (item.token === "sample_limit") {
                    container.addClass("dig-sample-limit-input");
                }
            } catch (e) {}
        });
    }

    function injectCriticalCss() {
        if ($("#dig_scope_v2_css").length) {
            return;
        }
        var css = "" +
            ".hide-global-filters,.show-global-filters,a.hide-global-filters,a.show-global-filters," +
            "[data-test='hide-filters'],[data-test='show-filters']{display:none!important;}" +
            ".dig-scope-toolbar{margin:8px 0 14px 0;padding:8px 10px;border:1px solid rgba(125,255,154,.22);" +
            "border-radius:6px;background:rgba(2,20,12,.72);display:flex;flex-direction:column;gap:6px;}" +
            ".dig-scope-summary-row{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px;}" +
            ".dig-scope-summary{font-size:12px;line-height:1.35;color:#fff;opacity:.92;word-break:break-word;flex:1 1 auto;}" +
            ".dig-scope-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}" +
            ".dig-scope-help{font-size:12px;opacity:.78;line-height:1.35;}" +
            ".dig-filter-toggle{flex:0 0 auto;white-space:nowrap;}" +
            "body.dig-filters-hidden .dashboard-form-globalfieldset .input," +
            "body.dig-filters-hidden .dashboard-form-globalfieldset .form-submit," +
            "body.dig-filters-hidden .dashboard-form-globalfieldset .dashboard-form-submit," +
            "body.dig-filters-hidden .dashboard-form-globalfieldset .splunk-submit-button{display:none!important;}" +
            "body.dig-filters-hidden #dig_scope_toolbar .dig-scope-actions," +
            "body.dig-filters-hidden #dig_scope_toolbar .dig-scope-help{display:none!important;}" +
            "body.dig-filters-hidden #dig_scope_toolbar .dig-scope-summary-row{display:flex!important;}" +
            "body.dig-filters-hidden #dig_toggle_filters{display:inline-block!important;}";
        $("<style id='dig_scope_v2_css' type='text/css'></style>").text(css).appendTo("head");
    }

    function hideNativeFilterControls() {
        $(".hide-global-filters, .show-global-filters, a.hide-global-filters, a.show-global-filters").hide();
        $("a, button, span").each(function() {
            var t = $.trim($(this).text() || "").toLowerCase();
            if (t === "hide filters" || t === "show filters") {
                if ($(this).closest("#dig_scope_toolbar").length) {
                    return;
                }
                $(this).hide();
            }
        });
    }

    function injectToolbar() {
        if ($("#dig_scope_toolbar").length) {
            if (!$("#dig_toggle_filters").length) {
                $("#dig_scope_summary").wrap('<div class="dig-scope-summary-row"></div>');
                $("#dig_scope_summary").after('<button id="dig_toggle_filters" type="button" class="btn dig-filter-toggle">Hide Filters</button>');
            }
            return;
        }

        var html = "" +
            '<div id="dig_scope_toolbar" class="dig-scope-toolbar" data-dig-scope-version="' + SCOPE_JS_VERSION + '">' +
            '  <div class="dig-scope-summary-row">' +
            '    <div id="dig_scope_summary" class="dig-scope-summary"></div>' +
            '    <button id="dig_toggle_filters" type="button" class="btn dig-filter-toggle">Hide Filters</button>' +
            '  </div>' +
            '  <div class="dig-scope-actions">' +
            '    <button id="dig_apply_scope" type="button" class="btn btn-primary">Apply Scope</button>' +
            '    <button id="dig_load_scope" type="button" class="btn">Load Scope</button>' +
            '    <button id="dig_reset_scope" type="button" class="btn">Reset Scope</button>' +
            '    <span id="dig_scope_status" class="dig-scope-status"></span>' +
            '  </div>' +
            '  <div class="dig-scope-help">Saved per Splunk user. Edit Analysis Scope anytime — drilldowns use the live text box. Apply Scope only saves it. Sample event limit capped at 100000.</div>' +
            '</div>';

        var fieldset = $(".dashboard-form-globalfieldset, .fieldset, fieldset").first();
        if (fieldset.length) {
            fieldset.after(html);
        } else {
            $("body").prepend(html);
        }
    }

    function loadScope(forceSaved, skipDrilldownOverlay) {
        $.ajax({
            url: endpoint,
            type: "GET",
            dataType: "json",
            cache: false,
            success: function(scope) {
                scope = normaliseScope(scope);

                if (!skipDrilldownOverlay) {
                    var stashed = consumeStashedDrilldownScope();
                    if (stashed) {
                        clearScopeReapply();
                        setScopeTokens(stashed, { refresh: true, updateInputs: true });
                        scheduleScopeReapply(stashed, 8);
                        updateStatus("Using drilldown scope. Click Apply Scope to save it.", false);
                        return;
                    }

                    var urlScope = getUrlDrilldownScope();
                    if (urlScope) {
                        clearScopeReapply();
                        setScopeTokens(urlScope, { refresh: true, updateInputs: true });
                        scheduleScopeReapply(urlScope, 8);
                        updateStatus("Using drilldown scope. Click Apply Scope to save it.", false);
                        return;
                    }
                }

                setScopeTokens(scope, { refresh: true, updateInputs: true });
                scheduleScopeReapply(scope, 4);
                if (scope && scope.is_default) {
                    updateStatus("Default safe scope loaded. Set a valid Analysis Scope and click Apply Scope.", false);
                } else {
                    updateStatus("Saved Analysis Scope loaded.", false);
                }
            },
            error: function(xhr) {
                setScopeTokens(DEFAULT_SCOPE, { refresh: true, updateInputs: true });
                updateStatus("Unable to load saved Analysis Scope: " + xhr.status, true);
            }
        });
    }

    function saveScope(action) {
        var scope = action === "reset" ? $.extend({}, DEFAULT_SCOPE) : readCurrentScope();
        scope.action = action || "save";

        $.ajax({
            url: endpoint,
            type: "POST",
            data: scope,
            dataType: "json",
            cache: false,
            success: function(saved) {
                setScopeTokens(saved, { refresh: true, updateInputs: true });
                if (action === "reset") {
                    updateStatus("Scope reset to safe default.", false);
                } else {
                    updateStatus("Analysis Scope saved.", false);
                }
            },
            error: function(xhr) {
                updateStatus("Unable to save Analysis Scope: " + xhr.status + " " + (xhr.responseText || ""), true);
            }
        });
    }

    function applyFiltersCollapsedState() {
        $(document.body).toggleClass("dig-filters-hidden", filtersCollapsed);
        $("#dig_scope_toolbar").toggleClass("dig-scope-collapsed", filtersCollapsed);
        var $fieldset = $(".dashboard-form-globalfieldset, .fieldset").first();
        $fieldset.toggleClass("dig-fieldset-collapsed", filtersCollapsed);

        // Direct style backup — does not depend on stylesheet cache.
        if (filtersCollapsed) {
            $fieldset.find(".input, .form-submit, .dashboard-form-submit, .splunk-submit-button").hide();
            $("#dig_scope_toolbar .dig-scope-actions, #dig_scope_toolbar .dig-scope-help").hide();
        } else {
            $fieldset.find(".input, .form-submit, .dashboard-form-submit, .splunk-submit-button").show();
            $("#dig_scope_toolbar .dig-scope-actions, #dig_scope_toolbar .dig-scope-help").show();
        }

        var $toggle = $("#dig_toggle_filters");
        if ($toggle.length) {
            $toggle.text(filtersCollapsed ? "Show Filters" : "Hide Filters");
            $toggle.attr("aria-expanded", filtersCollapsed ? "false" : "true");
        }

        hideNativeFilterControls();
        updateScopeSummary(readCurrentScope());
    }

    function setFiltersCollapsed(hidden) {
        filtersCollapsed = !!hidden;
        applyFiltersCollapsedState();
    }

    function installFilterVisibilitySync() {
        $(document).on("click", "#dig_toggle_filters", function(e) {
            e.preventDefault();
            e.stopPropagation();
            setFiltersCollapsed(!filtersCollapsed);
        });
        // Keep native control suppressed if Splunk re-renders it.
        window.setInterval(hideNativeFilterControls, 1000);
    }

    function installLiveTokenSync() {
        function onUserEdit() {
            userEditing = true;
            clearScopeReapply();
            syncTokensFromLiveScope();
            window.setTimeout(function() {
                userEditing = false;
            }, 1500);
        }

        $(document).on("input change keyup blur", ".dig-analysis-scope-input input, .dig-sample-limit-input input", onUserEdit);

        getInputComponents().forEach(function(item) {
            try {
                if (item.component && typeof item.component.on === "function") {
                    item.component.on("change", function() {
                        onUserEdit();
                    });
                }
            } catch (e) {}
        });
    }

    try {
        injectCriticalCss();
        injectToolbar();
        markScopeInputs();
        updateScopeSummary(readCurrentScope());
        installFilterVisibilitySync();
        installDrilldownScopeRewrite();
        installLiveTokenSync();
        applyFiltersCollapsedState();
        hideNativeFilterControls();

        $(document).on("click", "#dig_apply_scope", function(e) {
            e.preventDefault();
            saveScope("save");
        });

        $(document).on("click", "#dig_load_scope", function(e) {
            e.preventDefault();
            clearScopeReapply();
            loadScope(true, true);
        });

        $(document).on("click", "#dig_reset_scope", function(e) {
            e.preventDefault();
            clearScopeReapply();
            saveScope("reset");
        });

        window.setTimeout(function() {
            markScopeInputs();
            applyFiltersCollapsedState();
            hideNativeFilterControls();
            loadScope(true, false);
        }, 250);

        window.setTimeout(hideNativeFilterControls, 1000);
        window.setTimeout(hideNativeFilterControls, 2500);
    } catch (e) {
        if (window.console && console.error) {
            console.error("DIG Analysis Scope v2 initialisation failed", e);
        }
        updateStatus("Analysis Scope initialisation failed. See browser console.", true);
    }
});
