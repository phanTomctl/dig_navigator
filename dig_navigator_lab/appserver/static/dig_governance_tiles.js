/*
 * DIG Governance Summary - HTML/JS tile strip for Data Governance Exec.
 *
 * Reuses dig_snapshot_tiles.css (shared visual language with Snapshot / Delivery).
 *
 * Wire-up:
 *   1. stylesheet includes dig_snapshot_tiles.css
 *   2. script includes dig_governance_tiles.js
 *   3. <search id="tile_governance_summary" base="base_governance_primary_controls">...</search>
 *   4. Mount on Exec and/or IN:
 *        <div id="dig-governance-summary-tiles"></div>
 *
 * Performance: no timers/polling. Listens only to the tile_governance_summary manager.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc) {
    "use strict";

    var TILE_ORDER = [
        "primary_controls",
        "avg_coverage",
        "good_coverage",
        "partial_coverage",
        "low_coverage",
        "no_coverage"
    ];

    var WIDE_TILES = {
        primary_controls: true,
        avg_coverage: true
    };

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

    function bandShare(count, total, goodAt, amberAt) {
        if (total == null || total <= 0 || count == null) {
            return "pending";
        }
        var share = count / total;
        if (share >= goodAt) {
            return "green";
        }
        if (share >= amberAt) {
            return "amber";
        }
        return "red";
    }

    function bandCountBad(count) {
        if (count == null) {
            return "pending";
        }
        if (count <= 0) {
            return "green";
        }
        return "red";
    }

    function bandCountWarn(count, total) {
        if (count == null || total == null || total <= 0) {
            return "pending";
        }
        if (count <= 0) {
            return "green";
        }
        if (count / total < 0.35) {
            return "amber";
        }
        return "red";
    }

    function bandAvgCoverage(pct) {
        if (pct == null) {
            return "pending";
        }
        if (pct >= 70) {
            return "green";
        }
        if (pct >= 40) {
            return "amber";
        }
        return "red";
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
        var wideClass = WIDE_TILES[tile.id] ? " is-wide" : "";
        var html = '<div class="dig-snapshot-tile is-' + band + wideClass + '" data-tile="' + tile.id + '">';
        html += '<div class="dig-snapshot-tile-label">' + tile.label + "</div>";
        html += '<div class="dig-snapshot-tile-value">' + (tile.value || "-") + "</div>";
        html += '<div class="dig-snapshot-tile-sub">' + (tile.sub || "") + "</div>";
        html += '<div class="dig-snapshot-tile-status">' + statusLabel(band) + "</div>";
        html += "</div>";
        return html;
    }

    function buildTiles() {
        var row = state.summary;
        var tiles = [];
        var primary = num(row, ["primary_controls"]);
        var good = num(row, ["good_controls"]);
        var partial = num(row, ["partial_controls"]);
        var low = num(row, ["low_controls"]);
        var none = num(row, ["none_controls"]);
        var avg = num(row, ["avg_coverage_pct"]);
        var matched = num(row, ["matched_datamodels"]);
        var frameworks = num(row, ["frameworks"]);

        tiles.push({
            id: "primary_controls",
            label: "Primary Controls",
            value: primary != null ? String(primary) : "-",
            sub: frameworks != null ? (frameworks + " frameworks in scope") : "High-relevance controls scored",
            band: primary != null && primary > 0 ? "green" : "pending"
        });

        tiles.push({
            id: "good_coverage",
            label: "Good Coverage",
            value: good != null ? String(good) : "-",
            sub: "≥70% recommended CIM fields",
            band: bandShare(good, primary, 0.5, 0.2)
        });

        tiles.push({
            id: "partial_coverage",
            label: "Partial Coverage",
            value: partial != null ? String(partial) : "-",
            sub: "40-69% recommended fields",
            band: bandCountWarn(partial, primary)
        });

        tiles.push({
            id: "low_coverage",
            label: "Low Coverage",
            value: low != null ? String(low) : "-",
            sub: "1-39% (often thin / shared fields)",
            band: bandCountWarn(low, primary)
        });

        tiles.push({
            id: "no_coverage",
            label: "No Coverage",
            value: none != null ? String(none) : "-",
            sub: "0% recommended fields on primary DM",
            band: bandCountBad(none)
        });

        tiles.push({
            id: "avg_coverage",
            label: "Field Coverage",
            value: avg != null ? (avg + "%") : "-",
            sub: matched != null ? (matched + " matched primary datamodels") : "Avg recommended-field completeness",
            band: bandAvgCoverage(avg)
        });

        return tiles;
    }

    function render() {
        var $roots = $("#dig-governance-summary-tiles");
        if (!$roots.length) {
            return;
        }
        var tiles = buildTiles();
        var html = '<div class="dig-snapshot-wrap">';
        html += '<div class="context-toggle"><details><summary>Why This Matters</summary><div class="context-panel">';
        html += "<p><strong>Primary Controls:</strong> High-relevance mapped controls scored against their single primary datamodel (Ticket_Management excluded).</p>";
        html += "<p><strong>Band tiles:</strong> Good / Partial / Low / No Coverage from recommended CIM field completeness. Potential evidence only, not compliance.</p>";
        html += "<p><strong>Field Coverage:</strong> Average recommended-field % across those primary controls. Matched datamodels are primaries with coverage greater than 0%.</p>";
        html += "</div></details></div>";
        html += '<p class="dig-snapshot-banner">Governance evidence strip for the selected sample. Not a compliance score.</p>';
        html += '<div class="dig-snapshot-grid dig-snapshot-grid-gov">';
        TILE_ORDER.forEach(function(id) {
            var tile = tiles.filter(function(t) { return t.id === id; })[0];
            if (tile) {
                html += renderTile(tile);
            }
        });
        html += "</div></div>";
        $roots.html(html);
    }

    bindSearch("tile_governance_summary", function(row) {
        state.summary = row;
    });

    render();
});
