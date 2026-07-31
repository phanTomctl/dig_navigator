/*
 * DIG Analysis Scope
 *
 * KV Store-backed per-user Analysis Scope for DIG dashboards.
 * Saves/restores the common scope inputs used across DIG dashboards:
 *   base_search, time_range earliest/latest, group_by, sample_limit.
 *
 * Design notes:
 * - No dependency on splunkjs/mvc/simplexml/submit; that module is not present in
 *   some Splunk 10 builds and can break dashboard loading.
 * - Direct opens load saved per-user KV scope.
 * - Drilldowns stash live scope in sessionStorage at click time and rewrite
 *   form.base_search (etc.) in the href from the visible inputs — SimpleXML
 *   $base_search$ / $form.base_search$ are not reliable for unsaved edits.
 * - Landing pages consume the stash (then URL) before KV so saved scope cannot win.
 * - Native Splunk Hide Filters control is hidden; DIG owns Show/Hide Filters in
 *   the Analysis Scope toolbar via body.dig-filters-hidden.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/utils",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc, utils) {
    "use strict";

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

    var scopeReapplyTimers = [];
    var filtersCollapsed = false;

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
                var current = readCurrentScope();
                if (!scopesEqual(current, scope)) {
                    setScopeTokens(scope);
                }
                tick(remaining - 1);
            }, 500);
            scopeReapplyTimers.push(timerId);
        }

        tick(attemptsRemaining);
    }

    function hasMeaningfulDrilldownContext(params) {
        // Treat as drilldown when a context token carries a specific non-wildcard
        // value that should override the saved Analysis Scope.
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

    function getUrlScopeIfMeaningful() {
        var params = parseQuery();
        if (!hasMeaningfulDrilldownContext(params)) {
            return null;
        }
        return getUrlScopeFromParams(params);
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
            if (key === encodedName || key === name) {
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
        if (!url || typeof url !== "string") {
            return url;
        }
        if (url.indexOf("form.base_search=") < 0 && url.indexOf("base_search=") < 0) {
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
        // Stash early: Splunk often builds the drilldown URL from tokens and
        // window.open()s it — there may be no <a href> for us to rewrite.
        $(document).on("mousedown", ".dashboard-element, .dashboard-panel, .panel-element", function() {
            stashDrilldownScope(readCurrentScope());
        });

        $(document).on("click", "a[href*='form.base_search='], a[href*='base_search=']", function() {
            var href = $(this).attr("href");
            var next = applyLiveScopeToUrl(href);
            if (next && next !== href) {
                $(this).attr("href", next);
            }
        });

        try {
            if (window.__digOpenPatched) {
                return;
            }
            window.__digOpenPatched = true;
            var origOpen = window.open;
            window.open = function(url, name, specs) {
                try {
                    url = applyLiveScopeToUrl(url);
                } catch (e) {}
                return origOpen.call(window, url, name, specs);
            };
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

        // Prefer visible DOM values — tokens lag when the user edits without Apply.
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

    function setScopeTokens(scope) {
        scope = normaliseScope(scope);

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

        updateVisibleInputs(scope);
        updateScopeSummary(scope);
        refreshSearches();
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
            if (submittedTokens && typeof submittedTokens.trigger === "function") {
                submittedTokens.trigger("change");
            }
        } catch (e) {}

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

    function isFieldsetHidden() {
        var fieldset = $(".dashboard-form-globalfieldset, .fieldset, fieldset").first();
        if (!fieldset.length) {
            return false;
        }
        return !fieldset.is(":visible");
    }

    function updateCollapsedState() {
        var hidden = isFieldsetHidden();
        $("#dig_scope_toolbar").toggleClass("dig-scope-collapsed", hidden);
        updateScopeSummary(readCurrentScope());
    }

    function injectToolbar() {
        if ($("#dig_scope_toolbar").length) {
            return;
        }

        var html = '' +
            '<div id="dig_scope_toolbar" class="dig-scope-toolbar">' +
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
            '  <div class="dig-scope-help">Saved per Splunk user. Direct dashboard opens use the saved scope automatically. Drilldowns can temporarily override it. Sample event limit is capped at 100000.</div>' +
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
                        setScopeTokens(stashed);
                        scheduleScopeReapply(stashed, 6);
                        updateStatus("Using drilldown scope. Click Apply Scope to save it.", false);
                        return;
                    }

                    var urlScope = getUrlScopeIfMeaningful();
                    if (urlScope) {
                        clearScopeReapply();
                        setScopeTokens(urlScope);
                        scheduleScopeReapply(urlScope, 6);
                        updateStatus("Using drilldown scope. Click Apply Scope to save it.", false);
                        return;
                    }
                }

                setScopeTokens(scope);
                scheduleScopeReapply(scope, 4);
                if (scope && scope.is_default) {
                    updateStatus("Default safe scope loaded. Set a valid Analysis Scope and click Apply Scope.", false);
                } else {
                    updateStatus("Saved Analysis Scope loaded.", false);
                }
            },
            error: function(xhr) {
                setScopeTokens(DEFAULT_SCOPE);
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
                setScopeTokens(saved);
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
        $(".dashboard-form-globalfieldset, .fieldset").first().toggleClass("dig-fieldset-collapsed", filtersCollapsed);

        var $toggle = $("#dig_toggle_filters");
        if ($toggle.length) {
            $toggle.text(filtersCollapsed ? "Show Filters" : "Hide Filters");
            $toggle.attr("aria-expanded", filtersCollapsed ? "false" : "true");
        }

        updateScopeSummary(readCurrentScope());
    }

    function setFiltersCollapsed(hidden) {
        filtersCollapsed = !!hidden;
        applyFiltersCollapsedState();
    }

    function installFilterVisibilitySync() {
        // Own the control — do not depend on Splunk's native Hide Filters link.
        $(document).on("click", "#dig_toggle_filters", function(e) {
            e.preventDefault();
            e.stopPropagation();
            setFiltersCollapsed(!filtersCollapsed);
        });
    }

    try {
        injectToolbar();
        markScopeInputs();
        updateScopeSummary(readCurrentScope());
        updateCollapsedState();
        installFilterVisibilitySync();
        installDrilldownScopeRewrite();
        applyFiltersCollapsedState();

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


        getInputComponents().forEach(function(item) {
            try {
                if (item.component && typeof item.component.on === "function") {
                    item.component.on("change", function() {
                        window.setTimeout(function() { updateScopeSummary(readCurrentScope()); }, 50);
                    });
                }
            } catch (e) {}
        });

        window.setTimeout(function() {
            markScopeInputs();
            updateCollapsedState();
            applyFiltersCollapsedState();
            loadScope(true, false);
        }, 250);
    } catch (e) {
        if (window.console && console.error) {
            console.error("DIG Analysis Scope initialisation failed", e);
        }
        updateStatus("Analysis Scope initialisation failed. See browser console.", true);
    }
});
