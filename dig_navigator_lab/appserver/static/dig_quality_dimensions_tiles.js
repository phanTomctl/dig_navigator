/*
 * DIG Data Quality Dimensions — HTML/JS tile strip for Quality IN.
 *
 * Reuses dig_snapshot_tiles.css (shared visual language with Snapshot / Delivery).
 *
 * Wire-up:
 *   1. stylesheet includes dig_snapshot_tiles.css
 *   2. script includes dig_quality_dimensions_tiles.js
 *   3. Searches: tile_structure_consistency, tile_parsing_quality,
 *      tile_cardinality_duplication, tile_quality_cim
 *   4. Mount: <div id="dig-quality-dimensions-tiles"></div>
 *   5. Token: field_scope (same meaning as Data Intelligence)
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc) {
    "use strict";

    var THRESHOLDS = {
        structure: { green: 70, amber: 40 },
        consistency: { green: 70, amber: 40 },
        parsing: { green: 70, amber: 40 },
        cardinality: { green: 70, amber: 40 }
    };

    var TILE_ORDER = [
        "structure",
        "consistency",
        "cim_alignment",
        "parsing_quality",
        "cardinality",
        "duplication"
    ];

    var state = {
        structure: null,
        consistency: null,
        parsing_quality: null,
        cardinality: null,
        duplication: null,
        cim: null
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
        html += '<div class="dig-snapshot-tile-value">' + (tile.value || "—") + "</div>";
        html += '<div class="dig-snapshot-tile-sub">' + (tile.sub || "") + "</div>";
        html += '<div class="dig-snapshot-tile-status">' + statusLabel(band) + "</div>";
        html += "</div>";
        return html;
    }

    function buildTiles() {
        var cim = state.cim;
        var tiles = [];

        var structureScore = fieldVal(state.structure, ["Structure", "structure_score"]);
        tiles.push({
            id: "structure",
            label: "Structure",
            value: structureScore != null ? structureScore : "—",
            sub: "Avg structure signal in sample",
            band: bandFromScore(structureScore, THRESHOLDS.structure)
        });

        var consistencyScore = fieldVal(state.consistency, ["Consistency", "consistency_score"]);
        tiles.push({
            id: "consistency",
            label: "Consistency",
            value: consistencyScore != null ? consistencyScore : "—",
            sub: "Shape / length stability in sample",
            band: bandFromScore(consistencyScore, THRESHOLDS.consistency)
        });

        var cimPct = fieldVal(cim, ["cim_alignment_pct"]);
        var cimMatched = fieldVal(cim, ["matched_scope_fields"]);
        var cimTotal = fieldVal(cim, ["total_scope_fields"]);
        var cimSub = "Field-scope coverage for matched datamodels";
        if (cimMatched != null && cimTotal != null) {
            cimSub = cimMatched + " / " + cimTotal + " scope fields · matched models";
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

        return tiles;
    }

    function render() {
        var $root = $("#dig-quality-dimensions-tiles");
        if (!$root.length) {
            return;
        }
        var tiles = buildTiles();
        var html = '<div class="dig-snapshot-wrap">';
        html += '<div class="context-toggle"><details><summary>Why This Matters</summary><div class="context-panel">';
        html += "<p><strong>Structure / Consistency:</strong> Same model as Data Intelligence (schema-aware shapes + length stability).</p>";
        html += "<p><strong>CIM Alignment:</strong> Field-scope coverage for datamodels that already have field evidence (same story as Data Intelligence).</p>";
        html += "<p><strong>Parsing Quality:</strong> How completely extracted fields are populated across events (fill rate).</p>";
        html += "<p><strong>Cardinality:</strong> Pressure from distinct shapes, hosts, and sources relative to sample size.</p>";
        html += "<p><strong>Duplication:</strong> Repeated raw event payloads in the sample (collection or replay risk).</p>";
        html += "</div></details></div>";
        html += '<p class="dig-snapshot-banner">Quality indicator strip for the selected sample. Not a certification. Governance is reviewed on the Governance dashboards.</p>';
        html += '<div class="dig-snapshot-grid dig-snapshot-grid-6">';
        TILE_ORDER.forEach(function(id) {
            var tile = tiles.filter(function(t) { return t.id === id; })[0];
            if (tile) {
                html += renderTile(tile);
            }
        });
        html += "</div></div>";
        $root.html(html);
    }

    bindSearch("tile_structure_consistency", function(row) {
        state.structure = row;
        state.consistency = row;
    });
    bindSearch("tile_parsing_quality", function(row) {
        state.parsing_quality = row;
    });
    bindSearch("tile_cardinality_duplication", function(row) {
        state.cardinality = row;
        state.duplication = row;
    });
    bindSearch("tile_quality_cim", function(row) {
        state.cim = row;
    });

    render();
});
