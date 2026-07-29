/*
 * DIG Snapshot Lab — custom HTML/JS tile strip prototype.
 *
 * Isolation: used only by data_quality_snapshot_lab.xml.
 * Migration: add this script + dig_snapshot_tiles.css to data_intelligence.xml,
 * copy the HTML mount + tile_* searches, then remove the lab view from nav.
 *
 * Performance: no timers/polling. Listens only to SimpleXML search managers
 * that already run from shared base_sample / base_structure / base_timeliness.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc) {
    "use strict";

    /*
     * PROVISIONAL bands — confirm with product owner per tile before sign-off.
     * Structure / Consistency: score 0-100
     * CIM field overlap: percent of observed fields in selected field_scope
     * Delivery lag: percent of sampled events in Healthy delay category
     * Datamodel alignment: Current count >= 1 => green (requested)
     */
    var THRESHOLDS = {
        structure: { green: 70, amber: 40 },
        consistency: { green: 70, amber: 40 },
        cim_overlap: { green: 40, amber: 20 },
        delivery_lag: { green: 80, amber: 50 }
    };

    var TILE_ORDER = [
        "structure",
        "consistency",
        "cim_overlap",
        "delivery_lag",
        "datamodel_alignment"
    ];

    var state = {
        structure: null,
        consistency: null,
        cim_overlap: null,
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
        var row = {};
        data.fields.forEach(function(field, idx) {
            row[field] = data.rows[0][idx];
        });
        return row;
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
            html += '<div class="dig-snapshot-tile-value">' + (tile.value || "—") + "</div>";
        }
        html += '<div class="dig-snapshot-tile-sub">' + (tile.sub || "") + "</div>";
        html += '<div class="dig-snapshot-tile-status">' + statusLabel(band) + "</div>";
        html += "</div>";
        return html;
    }

    function buildTiles() {
        var tiles = [];

        var structureScore = state.structure && state.structure.Structure;
        tiles.push({
            id: "structure",
            label: "Structure",
            value: structureScore != null ? structureScore : "—",
            sub: "Avg structure signal in sample",
            band: bandFromScore(structureScore, THRESHOLDS.structure)
        });

        var consistencyScore = state.consistency && state.consistency.Consistency;
        tiles.push({
            id: "consistency",
            label: "Consistency",
            value: consistencyScore != null ? consistencyScore : "—",
            sub: "Shape / length stability in sample",
            band: bandFromScore(consistencyScore, THRESHOLDS.consistency)
        });

        var cimPct = state.cim_overlap && state.cim_overlap.cim_overlap_pct;
        tiles.push({
            id: "cim_overlap",
            label: "CIM field overlap",
            value: cimPct != null ? cimPct + "%" : "—",
            sub: "Observed fields in selected Field scope",
            band: bandFromScore(cimPct, THRESHOLDS.cim_overlap)
        });

        var healthyPct = state.delivery_lag && state.delivery_lag.healthy_pct;
        var medianLag = state.delivery_lag && state.delivery_lag.median_lag_display;
        tiles.push({
            id: "delivery_lag",
            label: "Delivery lag",
            value: healthyPct != null ? healthyPct + "%" : "—",
            sub: medianLag ? ("Healthy events · median " + medianLag) : "Share of events within healthy lag",
            band: bandFromScore(healthyPct, THRESHOLDS.delivery_lag)
        });

        var currentCount = state.datamodel_alignment && state.datamodel_alignment.current_dm_count;
        var potentialCount = state.datamodel_alignment && state.datamodel_alignment.potential_dm_count;
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
        html += '<p class="dig-snapshot-banner"><strong>Snapshot Lab</strong> — indicator strip for the selected analysis scope. Not a certification. Thresholds are provisional.</p>';
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

    bindSearch("tile_structure_consistency", function(row) {
        state.structure = row;
        state.consistency = row;
    });

    bindSearch("tile_cim_overlap", function(row) {
        state.cim_overlap = row;
    });

    bindSearch("tile_delivery_lag", function(row) {
        state.delivery_lag = row;
    });

    bindSearch("tile_datamodel_alignment", function(row) {
        state.datamodel_alignment = row;
    });

    render();
});
