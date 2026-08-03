/*
 * DIG Data Quality Snapshot — shared HTML/JS tile strip.
 *
 * Reuse on any dashboard:
 *   1. stylesheet="...,dig_snapshot_tiles.css" script="...,dig_snapshot_tiles.js"
 *   2. Provide base_sample / base_structure / base_timeliness_evidence (DI token pattern)
 *   3. Tokens: datamodel_filter, field_scope
 *   4. Copy the <search id="tile_*"> blocks from data_intelligence.xml
 *   5. Mount: <div id="dig-snapshot-tiles"></div>
 *
 * Performance: no timers/polling. Listens only to SimpleXML search managers.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/utils",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc, utils) {
    "use strict";

    /*
     * Structure / Consistency / Parsing / Cardinality: score 0-100 bands.
     * CIM Alignment: rule-based — see bandCimAlignment().
     * Delivery lag: rule-based vs lookup expected healthy lag — see bandDeliveryLag().
     * Duplication: % bands — see bandDuplication().
     * Datamodel alignment: Current count >= 1 => green.
     */
    var THRESHOLDS = {
        structure: { green: 70, amber: 40 },
        consistency: { green: 70, amber: 40 },
        parsing: { green: 70, amber: 40 },
        cardinality: { green: 70, amber: 40 }
    };

    /* Row 1 then row 2 of the 4x2 Snapshot grid */
    var TILE_ORDER = [
        "datamodel_alignment",
        "cim_alignment",
        "parsing_quality",
        "cardinality",
        "delivery_lag",
        "duplication",
        "structure",
        "consistency"
    ];

    var TILE_DRILLDOWNS = {
        datamodel_alignment: "datamodel_center",
        cim_alignment: "datamodel_center",
        parsing_quality: "data_quality_center",
        cardinality: "data_quality_center",
        delivery_lag: "telemetry_timeliness_center",
        duplication: "data_quality_center",
        structure: "data_structure_center",
        consistency: "data_structure_center"
    };

    var defaultTokens = mvc.Components.get("default");
    var submittedTokens = mvc.Components.get("submitted");

    var state = {
        structure: null,
        consistency: null,
        cim_alignment: null,
        parsing_quality: null,
        cardinality: null,
        duplication: null,
        delivery_lag: null,
        datamodel_alignment: null
    };

    function bandFromScore(score, thresholds) {
        var n = Number(score);
        if (!isFinite(n)) {
            return "pending";
        }
        if (n >= thresholds.green) {
            return "green";
        }
        if (n >= thresholds.amber) {
            return "amber";
        }
        return "red";
    }

    /*
     * Green: 100% of Field-scope fields covered for datamodels with evidence.
     * Amber: some coverage but below 100%.
     * Red: no observed fields matched to any selected datamodel.
     */
    function bandCimAlignment(row) {
        if (!row) {
            return "pending";
        }
        var anyMatch = Number(row.any_dm_match || 0);
        var pct = Number(row.cim_alignment_pct);
        if (!anyMatch || !isFinite(pct) || Number(row.matched_scope_fields || 0) === 0) {
            return "red";
        }
        if (pct >= 100) {
            return "green";
        }
        return "amber";
    }

    /*
     * Uses telemetry_timeliness_rules healthy_seconds (via base_timeliness_evidence).
     * Green: no future timestamps AND average lag within expected healthy lag.
     * Amber: average lag above expected, no future timestamps.
     * Red: any future timestamps in the sample.
     */
    function bandDeliveryLag(row) {
        if (!row) {
            return "pending";
        }
        var futureCount = Number(row.future_count || 0);
        var avgLag = Number(row.avg_lag);
        var expected = Number(row.expected_healthy_seconds);
        if (!isFinite(avgLag)) {
            return "pending";
        }
        if (!isFinite(expected)) {
            expected = 0;
        }
        if (futureCount > 0) {
            return "red";
        }
        if (avgLag <= expected) {
            return "green";
        }
        return "amber";
    }

    /*
     * Duplication: share of events whose raw payload is not unique in the sample.
     * Green < 5%, Amber < 20%, Red >= 20%.
     */
    function bandDuplication(dupPct) {
        var n = Number(dupPct);
        if (!isFinite(n)) {
            return "pending";
        }
        if (n < 5) {
            return "green";
        }
        if (n < 20) {
            return "amber";
        }
        return "red";
    }

    function statusLabel(band) {
        if (band === "green") {
            return "Green";
        }
        if (band === "amber") {
            return "Amber";
        }
        if (band === "red") {
            return "Red";
        }
        return "Waiting";
    }

    function firstRow(resultsModel) {
        if (!resultsModel || !resultsModel.hasData || !resultsModel.hasData()) {
            return null;
        }
        var data = resultsModel.data();
        if (!data || !data.rows || !data.rows.length || !data.fields) {
            return null;
        }
        var raw = data.rows[0];
        var row = {};
        if (raw && !Array.isArray(raw) && typeof raw === "object") {
            data.fields.forEach(function(field) {
                if (Object.prototype.hasOwnProperty.call(raw, field)) {
                    row[field] = raw[field];
                }
            });
            return row;
        }
        data.fields.forEach(function(field, idx) {
            row[field] = raw[idx];
        });
        return row;
    }

    function fieldVal(row, names) {
        if (!row) {
            return null;
        }
        for (var i = 0; i < names.length; i++) {
            if (row[names[i]] != null && row[names[i]] !== "") {
                return row[names[i]];
            }
        }
        return null;
    }

    function readToken(names, fallback) {
        var i;
        var value;
        for (i = 0; i < names.length; i++) {
            if (defaultTokens) {
                value = defaultTokens.get(names[i]);
                if (value !== undefined && value !== null && value !== "") {
                    return value;
                }
            }
            if (submittedTokens) {
                value = submittedTokens.get(names[i]);
                if (value !== undefined && value !== null && value !== "") {
                    return value;
                }
            }
        }
        return fallback;
    }

    function makeAppUrl(path) {
        try {
            if (utils && typeof utils.make_url === "function") {
                return utils.make_url(path);
            }
        } catch (e) {}
        return path;
    }

    function buildDrilldownUrl(viewName) {
        var params = {
            "form.base_search": readToken(["form.base_search", "base_search"], ""),
            "form.time_range.earliest": readToken(["form.time_range.earliest", "time_range.earliest"], "-24h"),
            "form.time_range.latest": readToken(["form.time_range.latest", "time_range.latest"], "now"),
            "form.group_by": readToken(["form.group_by", "group_by"], "sourcetype"),
            "form.sample_limit": readToken(["form.sample_limit", "sample_limit"], "1000"),
            "form.selected_group": "*"
        };

        if (viewName === "datamodel_center") {
            params["form.datamodel_filter"] = readToken(["form.datamodel_filter", "datamodel_filter"], "*");
            params["form.field_scope"] = readToken(["form.field_scope", "field_scope"], "recommended");
            params["form.dm_perspective"] = readToken(["form.dm_perspective", "dm_perspective"], "combined");
        } else if (viewName === "data_quality_center") {
            params["form.field_scope"] = readToken(["form.field_scope", "field_scope"], "recommended");
        } else if (viewName === "data_structure_center") {
            params["form.classification"] = "*";
        } else if (viewName === "telemetry_timeliness_center") {
            params["form.selected_delay_category"] = "*";
            params["form.selected_timestamp_indicator"] = "*";
        }

        var qs = Object.keys(params).map(function(key) {
            return encodeURIComponent(key) + "=" + encodeURIComponent(params[key] == null ? "" : String(params[key]));
        }).join("&");

        return makeAppUrl("/app/dig_navigator_lab/" + viewName + "?" + qs);
    }

    function openTileDrilldown(tileId) {
        var viewName = TILE_DRILLDOWNS[tileId];
        if (!viewName) {
            return;
        }
        window.open(buildDrilldownUrl(viewName), "_blank");
    }

    function bindSearch(id, handler) {
        var manager = mvc.Components.get(id);
        if (!manager) {
            return;
        }
        var results = manager.data("results", { count: 1 });
        results.on("data", function() {
            handler(firstRow(results));
            render();
        });
        results.on("error", function() {
            handler(null);
            render();
        });
        manager.on("search:start", function() {
            handler(null);
            render();
        });
    }

    function renderTile(tile) {
        var band = tile.band || "pending";
        var clickable = !!TILE_DRILLDOWNS[tile.id];
        var html = '<div class="dig-snapshot-tile is-' + band +
            (clickable ? " is-clickable" : "") +
            '" data-tile="' + tile.id + '"' +
            (clickable ? ' role="link" tabindex="0" title="Open related Information Nexus"' : "") +
            ">";
        html += '<div class="dig-snapshot-tile-label">' + tile.label + "</div>";
        if (tile.dual) {
            html += '<div class="dig-snapshot-tile-dual">';
            tile.dual.forEach(function(item) {
                html += '<div class="dig-snapshot-dual-item">';
                html += '<div class="dig-snapshot-dual-label">' + item.label + "</div>";
                html += '<div class="dig-snapshot-dual-value">' + item.value + "</div>";
                html += "</div>";
            });
            html += "</div>";
        } else {
            html += '<div class="dig-snapshot-tile-value">' + (tile.value || "—") + "</div>";
        }
        html += '<div class="dig-snapshot-tile-sub">' + (tile.sub || "") + "</div>";
        html += '<div class="dig-snapshot-tile-status">' + statusLabel(band) + "</div>";
        html += "</div>";
        return html;
    }

    function buildTiles() {
        var tiles = [];

        var structureScore = fieldVal(state.structure, ["Structure", "structure"]);
        tiles.push({
            id: "structure",
            label: "Structure",
            value: structureScore != null ? structureScore : "—",
            sub: "Avg structure signal in sample",
            band: bandFromScore(structureScore, THRESHOLDS.structure)
        });

        var consistencyScore = fieldVal(state.consistency, ["Consistency", "consistency"]);
        tiles.push({
            id: "consistency",
            label: "Consistency",
            value: consistencyScore != null ? consistencyScore : "—",
            sub: "Shape / length stability in sample",
            band: bandFromScore(consistencyScore, THRESHOLDS.consistency)
        });

        var cim = state.cim_alignment;
        var cimPct = fieldVal(cim, ["cim_alignment_pct"]);
        var cimMatched = fieldVal(cim, ["matched_scope_fields"]);
        var cimTotal = fieldVal(cim, ["total_scope_fields"]);
        var cimSub = "Field-scope coverage for matched datamodels";
        if (cimMatched != null && cimTotal != null) {
            cimSub = cimMatched + " / " + cimTotal + " scope fields · matched models only";
        }
        tiles.push({
            id: "cim_alignment",
            label: "CIM Alignment",
            value: cimPct != null ? cimPct + "%" : "—",
            sub: cimSub,
            band: bandCimAlignment(cim)
        });

        var parsingScore = fieldVal(state.parsing_quality, ["parsing_quality_pct"]);
        tiles.push({
            id: "parsing_quality",
            label: "Parsing Quality",
            value: parsingScore != null ? parsingScore : "—",
            sub: "Avg field fill rate (extracted fields vs events)",
            band: bandFromScore(parsingScore, THRESHOLDS.parsing)
        });

        var cardScore = fieldVal(state.cardinality, ["cardinality_score"]);
        var cardPressure = fieldVal(state.cardinality, ["cardinality_pressure_pct"]);
        var cardSub = "Lower pressure from shapes / hosts / sources is better";
        if (cardPressure != null) {
            cardSub = "Pressure " + cardPressure + "% (shapes / hosts / sources)";
        }
        tiles.push({
            id: "cardinality",
            label: "Cardinality",
            value: cardScore != null ? cardScore : "—",
            sub: cardSub,
            band: bandFromScore(cardScore, THRESHOLDS.cardinality)
        });

        var dupPct = fieldVal(state.duplication, ["duplicate_pct"]);
        tiles.push({
            id: "duplication",
            label: "Duplication",
            value: dupPct != null ? dupPct + "%" : "—",
            sub: "Share of events with repeated raw payloads",
            band: bandDuplication(dupPct)
        });

        var lag = state.delivery_lag;
        var lagDisplay = fieldVal(lag, ["avg_lag_display"]);
        var expectedDisplay = fieldVal(lag, ["expected_healthy_display"]);
        var futureCount = fieldVal(lag, ["future_count"]);
        var lagSub = "Average ingest delay vs lookup expected lag";
        if (expectedDisplay) {
            lagSub = "Expected ≤ " + expectedDisplay + " (telemetry_timeliness_rules)";
            if (Number(futureCount) > 0) {
                lagSub = futureCount + " future timestamp event(s) · " + lagSub;
            }
        }
        tiles.push({
            id: "delivery_lag",
            label: "Delivery lag",
            value: lagDisplay != null ? lagDisplay : "—",
            sub: lagSub,
            band: bandDeliveryLag(lag)
        });

        var currentCount = fieldVal(state.datamodel_alignment, ["current_dm_count"]);
        var potentialCount = fieldVal(state.datamodel_alignment, ["potential_dm_count"]);
        var dmBand = "pending";
        if (currentCount != null || potentialCount != null) {
            var cur = Number(currentCount || 0);
            var pot = Number(potentialCount || 0);
            if (cur >= 1) {
                dmBand = "green";
            } else if (pot >= 1) {
                dmBand = "amber";
            } else {
                dmBand = "red";
            }
        }
        tiles.push({
            id: "datamodel_alignment",
            label: "Datamodel alignment",
            dual: [
                { label: "Current", value: currentCount != null ? currentCount : "—" },
                { label: "Potential", value: potentialCount != null ? potentialCount : "—" }
            ],
            sub: "Models with field evidence in scope",
            band: dmBand
        });

        return tiles;
    }

    function render() {
        var $root = $("#dig-snapshot-tiles");
        if (!$root.length) {
            return;
        }
        var tiles = buildTiles();
        var html = '<div class="dig-snapshot-wrap">';
        html += '<div class="context-toggle"><details><summary>Why This Matters</summary><div class="context-panel">';
        html += "<p><strong>Structure:</strong> Share of sampled events with a recognisable format (JSON, XML, KV, or delimited). Not the same as the Structured / Semi-Structured pie labels, which also use shape consistency.</p>";
        html += "<p><strong>Consistency:</strong> How stable event shapes and lengths are within the sample. Lower shape diversity and length variance score higher.</p>";
        html += "<p><strong>CIM Alignment:</strong> Of Field-scope fields for datamodels with at least one match in the sample, what share are present. Green = 100%. Amber = partial. Red = no fields matched to any selected datamodel.</p>";
        html += "<p><strong>Parsing Quality:</strong> How completely extracted fields are populated across events (fill rate).</p>";
        html += "<p><strong>Cardinality:</strong> Pressure from distinct shapes, hosts, and sources relative to sample size. Drill into Quality IN for detail.</p>";
        html += "<p><strong>Duplication:</strong> Repeated raw event payloads in the sample (collection or replay risk). Drill into Quality IN for detail.</p>";
        html += "<p><strong>Delivery lag:</strong> Average ingest delay (_indextime − _time) vs expected healthy lag from <em>telemetry_timeliness_rules</em>. Green = within expected. Amber = above expected. Red = future timestamps present.</p>";
        html += "<p><strong>Datamodel alignment:</strong> Count of CIM models with Current vs Potential field evidence in scope. Green when Current ≥ 1.</p>";
        html += "</div></details></div>";
        html += '<p class="dig-snapshot-banner">Indicator strip for the selected analysis scope. Not a certification. Click a tile to open the related Information Nexus with the current scope.</p>';
        html += '<div class="dig-snapshot-grid dig-snapshot-grid-8">';
        TILE_ORDER.forEach(function(id) {
            var tile = tiles.filter(function(t) { return t.id === id; })[0];
            if (tile) {
                html += renderTile(tile);
            }
        });
        html += "</div></div>";
        $root.html(html);

        $root.find(".dig-snapshot-tile.is-clickable").on("click", function() {
            openTileDrilldown($(this).attr("data-tile"));
        }).on("keydown", function(e) {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openTileDrilldown($(this).attr("data-tile"));
            }
        });
    }

    bindSearch("tile_structure_consistency", function(row) {
        state.structure = row;
        state.consistency = row;
    });

    bindSearch("tile_cim_alignment", function(row) {
        state.cim_alignment = row;
    });

    bindSearch("tile_parsing_quality", function(row) {
        state.parsing_quality = row;
    });

    bindSearch("tile_cardinality_duplication", function(row) {
        state.cardinality = row;
        state.duplication = row;
    });

    bindSearch("tile_delivery_lag", function(row) {
        state.delivery_lag = row;
    });

    bindSearch("tile_datamodel_alignment", function(row) {
        state.datamodel_alignment = row;
    });

    render();
});
