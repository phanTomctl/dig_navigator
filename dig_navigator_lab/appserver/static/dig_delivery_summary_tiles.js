/*
 * DIG Delivery Summary - HTML/JS tile strip for Telemetry Delivery IN.
 *
 * Reuses dig_snapshot_tiles.css (shared visual language with Data Quality Snapshot).
 *
 * Wire-up:
 *   1. stylesheet includes dig_snapshot_tiles.css
 *   2. script includes dig_delivery_summary_tiles.js
 *   3. <search id="tile_delivery_summary" base="base_timeliness_evidence">...</search>
 *   4. Mount: <div id="dig-delivery-summary-tiles"></div>
 *
 * Performance: no timers/polling. Listens only to the tile_delivery_summary manager.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc) {
    "use strict";

    var TILE_ORDER = [
        "worst_status",
        "median_delay",
        "p95_delay",
        "delay_mix",
        "timestamp_issues"
    ];

    var state = {
        summary: null
    };

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

    function num(row, names) {
        var v = fieldVal(row, names);
        if (v == null) {
            return null;
        }
        var n = Number(v);
        return isFinite(n) ? n : null;
    }

    function bandFromWorstStatus(status) {
        if (!status) {
            return "pending";
        }
        var s = String(status).toLowerCase();
        if (s === "healthy") {
            return "green";
        }
        if (s === "warning") {
            return "amber";
        }
        if (s === "poor" || s === "critical" || s.indexOf("future") >= 0) {
            return "red";
        }
        return "pending";
    }

    /*
     * Compare observed delay seconds to lookup-backed healthy/warning averages
     * from the sample (same rule precedence as the evidence base).
     */
    function bandFromDelaySeconds(seconds, healthySeconds, warningSeconds) {
        if (seconds == null) {
            return "pending";
        }
        var healthy = healthySeconds != null ? healthySeconds : 300;
        var warning = warningSeconds != null ? warningSeconds : 1800;
        if (seconds < 0) {
            return "red";
        }
        if (seconds <= healthy) {
            return "green";
        }
        if (seconds <= warning) {
            return "amber";
        }
        return "red";
    }

    function bandDelayMix(healthy, delayed) {
        var h = healthy || 0;
        var d = delayed || 0;
        if (h + d === 0) {
            return "pending";
        }
        if (d === 0) {
            return "green";
        }
        if (h >= d) {
            return "amber";
        }
        return "red";
    }

    function bandTimestampIssues(futureCount, oldCount) {
        var f = futureCount || 0;
        var o = oldCount || 0;
        if (f > 0) {
            return "red";
        }
        if (o > 0) {
            return "amber";
        }
        return "green";
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
        var html = '<div class="dig-snapshot-tile is-' + band + '" data-tile="' + tile.id + '">';
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
            html += '<div class="dig-snapshot-tile-value">' + (tile.value || "-") + "</div>";
        }
        html += '<div class="dig-snapshot-tile-sub">' + (tile.sub || "") + "</div>";
        html += '<div class="dig-snapshot-tile-status">' + statusLabel(band) + "</div>";
        html += "</div>";
        return html;
    }

    function buildTiles() {
        var row = state.summary;
        var tiles = [];

        var worst = fieldVal(row, ["worst_observed_status"]);
        tiles.push({
            id: "worst_status",
            label: "Worst Status",
            value: worst != null ? worst : "-",
            sub: "Most severe delay or timestamp signal in sample",
            band: bandFromWorstStatus(worst)
        });

        var medianDisplay = fieldVal(row, ["median_delay"]);
        var medianSeconds = num(row, ["median_delay_seconds"]);
        var healthySeconds = num(row, ["expected_healthy_seconds"]);
        var warningSeconds = num(row, ["expected_warning_seconds"]);
        tiles.push({
            id: "median_delay",
            label: "Median Delay",
            value: medianDisplay != null ? medianDisplay : "-",
            sub: "Half of events arrived within this lag",
            band: bandFromDelaySeconds(medianSeconds, healthySeconds, warningSeconds)
        });

        var p95Display = fieldVal(row, ["p95_delay"]);
        var p95Seconds = num(row, ["p95_delay_seconds"]);
        tiles.push({
            id: "p95_delay",
            label: "P95 Delay",
            value: p95Display != null ? p95Display : "-",
            sub: "95% of events within this lag",
            band: bandFromDelaySeconds(p95Seconds, healthySeconds, warningSeconds)
        });

        var healthy = num(row, ["healthy_delay_events"]) || 0;
        var warning = num(row, ["warning_delay_events"]) || 0;
        var poor = num(row, ["poor_delay_events"]) || 0;
        var critical = num(row, ["critical_delay_events"]) || 0;
        var delayed = warning + poor + critical;
        var sampled = num(row, ["events_sampled"]);
        tiles.push({
            id: "delay_mix",
            label: "Delay Mix",
            dual: [
                { label: "Healthy", value: healthy },
                { label: "Delayed", value: delayed }
            ],
            sub: sampled != null ? (sampled + " events sampled") : "Healthy vs Warning/Poor/Critical",
            band: bandDelayMix(healthy, delayed)
        });

        var futureCount = num(row, ["future_timestamp_events"]) || 0;
        var oldCount = num(row, ["old_event_at_index_events"]) || 0;
        tiles.push({
            id: "timestamp_issues",
            label: "Timestamp Issues",
            dual: [
                { label: "Future", value: futureCount },
                { label: "Over 30d", value: oldCount }
            ],
            sub: "Integrity flags separate from delivery categories",
            band: bandTimestampIssues(futureCount, oldCount)
        });

        return tiles;
    }

    function render() {
        var $root = $("#dig-delivery-summary-tiles");
        if (!$root.length) {
            return;
        }
        var tiles = buildTiles();
        var html = '<div class="dig-snapshot-wrap">';
        html += '<div class="context-toggle"><details><summary>Why This Matters</summary><div class="context-panel">';
        html += "<p><strong>Worst Status:</strong> Most severe delay category or future-timestamp signal in the sample.</p>";
        html += "<p><strong>Median / P95 Delay:</strong> Delivery lag as <code>_indextime − _time</code>, coloured against lookup healthy/warning thresholds.</p>";
        html += "<p><strong>Delay Mix:</strong> Healthy events vs Warning+Poor+Critical. Timestamp Issues are counted separately.</p>";
        html += "<p><strong>Timestamp Issues:</strong> Future timestamps and events already over 30 days old when indexed.</p>";
        html += "</div></details></div>";
        html += '<p class="dig-snapshot-banner">Delivery indicator strip for the selected sample. Not a certification.</p>';
        html += '<div class="dig-snapshot-grid">';
        TILE_ORDER.forEach(function(id) {
            var tile = tiles.filter(function(t) { return t.id === id; })[0];
            if (tile) {
                html += renderTile(tile);
            }
        });
        html += "</div></div>";
        $root.html(html);
    }

    bindSearch("tile_delivery_summary", function(row) {
        state.summary = row;
    });

    render();
});
