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
 * - URL/drilldown tokens override saved KV scope only when they differ from the
 *   safe dashboard defaults.
 * - Scope is applied to default and submitted token models, then searches are
 *   restarted defensively for direct dashboard opens.
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
        sample_limit: "5000"
    };

    var MAX_SAMPLE_LIMIT = 100000;
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

    function getUrlScopeIfMeaningful() {
        var params = parseQuery();
        var baseSearch = getQueryValue(params, ["form.base_search", "base_search"]);
        var earliest = getQueryValue(params, ["form.time_range.earliest", "time_range.earliest", "earliest"]);
        var latest = getQueryValue(params, ["form.time_range.latest", "time_range.latest", "latest"]);
        var groupBy = getQueryValue(params, ["form.group_by", "group_by"]);
        var sampleLimit = getQueryValue(params, ["form.sample_limit", "sample_limit"]);

        var meaningful = false;
        if (baseSearch && baseSearch !== DEFAULT_SCOPE.base_search) {
            meaningful = true;
        }
        if (earliest && earliest !== DEFAULT_SCOPE.earliest) {
            meaningful = true;
        }
        if (latest && latest !== DEFAULT_SCOPE.latest) {
            meaningful = true;
        }
        if (groupBy && groupBy !== DEFAULT_SCOPE.group_by) {
            meaningful = true;
        }
        if (sampleLimit && normaliseLimit(sampleLimit) !== DEFAULT_SCOPE.sample_limit) {
            meaningful = true;
        }

        if (!meaningful) {
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

    function readCurrentScope() {
        var timeValue = readComponentValue("time_range");
        var earliest = getToken("form.time_range.earliest", "time_range.earliest", DEFAULT_SCOPE.earliest);
        var latest = getToken("form.time_range.latest", "time_range.latest", DEFAULT_SCOPE.latest);

        if (timeValue && typeof timeValue === "object") {
            earliest = timeValue.earliest_time || timeValue.earliest || earliest;
            latest = timeValue.latest_time || timeValue.latest || latest;
        }

        return normaliseScope({
            base_search: readComponentValue("base_search") || getToken("form.base_search", "base_search", DEFAULT_SCOPE.base_search),
            earliest: earliest,
            latest: latest,
            group_by: readComponentValue("group_by") || getToken("form.group_by", "group_by", DEFAULT_SCOPE.group_by),
            sample_limit: readComponentValue("sample_limit") || getToken("form.sample_limit", "sample_limit", DEFAULT_SCOPE.sample_limit)
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
            '  <div id="dig_scope_summary" class="dig-scope-summary"></div>' +
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

    function loadScope(forceSaved) {
        var urlScope = getUrlScopeIfMeaningful();
        if (urlScope && !forceSaved) {
            setScopeTokens(urlScope);
            updateStatus("Using drilldown scope. Click Apply Scope to save it.", false);
            return;
        }

        $.ajax({
            url: endpoint,
            type: "GET",
            dataType: "json",
            cache: false,
            success: function(scope) {
                scope = normaliseScope(scope);
                setScopeTokens(scope);
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



    function getFilterToggleText() {
        var text = "";
        $("a, button").each(function() {
            var t = $.trim($(this).text() || "").toLowerCase();
            if (t === "show filters" || t === "hide filters") {
                text = t;
                return false;
            }
        });
        return text;
    }

    function getFilterToggleElement() {
        var found = $();
        $("a, button").each(function() {
            var t = $.trim($(this).text() || "").toLowerCase();
            if (t === "show filters" || t === "hide filters") {
                found = $(this);
                return false;
            }
        });
        return found;
    }

    function normaliseFilterToggleLabel(hidden) {
        var toggle = getFilterToggleElement();
        if (!toggle.length) {
            return;
        }

        toggle.text(hidden ? "Show Filters" : "Hide Filters");
        toggle.attr("aria-expanded", hidden ? "false" : "true");
    }    

    function applyFilterVisibilityFromNativeToggle() {
        var toggleText = getFilterToggleText();
        var hidden = toggleText === "show filters";

        $(document.body).toggleClass("dig-filters-hidden", hidden);
        $("#dig_scope_toolbar").toggleClass("dig-scope-collapsed", hidden);

        normaliseFilterToggleLabel(hidden);
        updateScopeSummary(readCurrentScope());
    }

    function installFilterVisibilitySync() {
        $(document).on("click", "a, button", function() {
            window.setTimeout(applyFilterVisibilityFromNativeToggle, 50);
            window.setTimeout(applyFilterVisibilityFromNativeToggle, 250);
            window.setTimeout(applyFilterVisibilityFromNativeToggle, 750);
        });

        window.setInterval(applyFilterVisibilityFromNativeToggle, 1000);

        try {
            var observer = new MutationObserver(function() {
                window.setTimeout(applyFilterVisibilityFromNativeToggle, 25);
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
            });
        } catch (e) {}
    }

    try {
        injectToolbar();
        markScopeInputs();
        updateScopeSummary(readCurrentScope());
        updateCollapsedState();
        installFilterVisibilitySync();
        applyFilterVisibilityFromNativeToggle();

        $(document).on("click", "#dig_apply_scope", function(e) {
            e.preventDefault();
            saveScope("save");
        });

        $(document).on("click", "#dig_load_scope", function(e) {
            e.preventDefault();
            loadScope(true);
        });

        $(document).on("click", "#dig_reset_scope", function(e) {
            e.preventDefault();
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
            applyFilterVisibilityFromNativeToggle();
            loadScope(false);
        }, 250);
    } catch (e) {
        if (window.console && console.error) {
            console.error("DIG Analysis Scope initialisation failed", e);
        }
        updateStatus("Analysis Scope initialisation failed. See browser console.", true);
    }
});
