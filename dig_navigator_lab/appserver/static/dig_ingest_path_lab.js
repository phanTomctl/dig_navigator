/*
 * DIG Ingest Path Lab - temporary visualisation prototypes (Designs A/B/C).
 *
 * Wire-up:
 *   1. stylesheet includes dig_snapshot_tiles.css, dig_ingest_path_lab.css
 *   2. script includes dig_ingest_path_lab.js
 *   3. Searches: viz_ingest_channels, viz_ingest_flows
 *   4. Mounts:
 *        #dig-ingest-design-a
 *        #dig-ingest-design-b
 *        #dig-ingest-design-c
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc) {
    "use strict";

    var CHANNEL_COLORS = [
        "#7dff9a",
        "#00e5ff",
        "#ffc857",
        "#ff6b6b",
        "#a8c4b6",
        "#ff4fd8",
        "#9bffce",
        "#6bc5ff"
    ];

    var state = {
        channels: [],
        flows: [],
        selectedChannel: null,
        animFrame: null,
        orbitAngle: 0
    };

    function rowsFromResults(resultsModel) {
        if (!resultsModel || !resultsModel.hasData || !resultsModel.hasData()) {
            return [];
        }
        var data = resultsModel.data();
        if (!data || !data.rows || !data.fields) {
            return [];
        }
        return data.rows.map(function(raw) {
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
        });
    }

    function num(v) {
        var n = Number(v);
        return isFinite(n) ? n : 0;
    }

    function asList(v) {
        if (v == null || v === "") {
            return [];
        }
        if (Array.isArray(v)) {
            return v;
        }
        return String(v).split(/\n|;|\|/).map(function(s) {
            return s.trim();
        }).filter(Boolean);
    }

    function colorFor(index) {
        return CHANNEL_COLORS[index % CHANNEL_COLORS.length];
    }

    function bindMulti(id, handler) {
        var manager = mvc.Components.get(id);
        if (!manager) {
            return;
        }
        var results = manager.data("results", { count: 0 });
        results.on("data", function() {
            handler(rowsFromResults(results));
            renderAll();
        });
        results.on("error", function() {
            handler([]);
            renderAll();
        });
        manager.on("search:start", function() {
            handler([]);
            renderAll();
        });
    }

    function bandForShare(pct) {
        if (pct == null) {
            return "pending";
        }
        if (pct >= 40) {
            return "green";
        }
        if (pct >= 15) {
            return "amber";
        }
        return "red";
    }

    /* ---------- Design C tiles ---------- */

    function renderDesignC() {
        var $root = $("#dig-ingest-design-c");
        if (!$root.length) {
            return;
        }
        if (!state.channels.length) {
            $root.html('<div class="dig-ingest-lab-wrap"><p class="dig-ingest-pending">Waiting for channel summary...</p></div>');
            return;
        }
        var html = '<div class="dig-ingest-lab-wrap dig-snapshot-wrap">';
        html += '<p class="dig-ingest-lab-banner">Design C: channel share tiles. Inferred from source patterns in the sample.</p>';
        html += '<div class="dig-snapshot-grid">';
        state.channels.slice(0, 8).forEach(function(ch, idx) {
            var pct = num(ch.pct);
            var band = bandForShare(pct);
            html += '<div class="dig-snapshot-tile is-' + band + '" data-channel="' + escapeAttr(ch.ingress_channel) + '">';
            html += '<div class="dig-snapshot-tile-label">' + escapeHtml(ch.ingress_channel) + "</div>";
            html += '<div class="dig-snapshot-tile-value">' + pct + "%</div>";
            html += '<div class="dig-snapshot-tile-sub">' + num(ch.events) + " events · " + num(ch.sources) + " sources</div>";
            html += '<div class="dig-snapshot-tile-status">' + (idx === 0 ? "Largest" : "Channel") + "</div>";
            html += "</div>";
        });
        html += "</div></div>";
        $root.html(html);
    }

    /* ---------- Design A constellation ---------- */

    function stopAnim() {
        if (state.animFrame != null) {
            window.cancelAnimationFrame(state.animFrame);
            state.animFrame = null;
        }
    }

    function renderDesignA() {
        var $root = $("#dig-ingest-design-a");
        if (!$root.length) {
            return;
        }
        stopAnim();
        if (!state.channels.length) {
            $root.html('<div class="dig-ingest-lab-wrap"><p class="dig-ingest-pending">Waiting for channel summary...</p></div>');
            return;
        }

        var html = '<div class="dig-ingest-lab-wrap">';
        html += '<p class="dig-ingest-lab-banner"><strong>Design A:</strong> Arrival constellation. Centre = receiver(s); orbit size = channel volume. Click a channel for top sources.</p>';
        html += '<div class="dig-ingest-constellation">';
        html += '<div class="dig-ingest-canvas-host"><canvas id="dig-ingest-orbit-canvas"></canvas></div>';
        html += '<div class="dig-ingest-side">';
        html += '<div class="dig-ingest-side-title">Channel detail</div>';
        html += '<div id="dig-ingest-side-body" class="dig-ingest-side-empty">Click an orbiting channel to inspect contributing data sources.</div>';
        html += "</div></div></div>";
        $root.html(html);

        var canvas = document.getElementById("dig-ingest-orbit-canvas");
        if (!canvas) {
            return;
        }
        var host = canvas.parentElement;
        var dpr = window.devicePixelRatio || 1;
        var width = host.clientWidth || 640;
        var height = 340;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        var ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        var receivers = {};
        state.channels.forEach(function(ch) {
            asList(ch.receivers).forEach(function(r) {
                receivers[r] = true;
            });
        });
        var receiverNames = Object.keys(receivers);
        var centreLabel = receiverNames.length === 1 ? receiverNames[0] : (receiverNames.length + " receivers");
        var maxEvents = Math.max.apply(null, state.channels.map(function(c) {
            return num(c.events);
        }).concat([1]));

        var nodes = state.channels.map(function(ch, idx) {
            var share = num(ch.events) / maxEvents;
            return {
                channel: ch.ingress_channel,
                events: num(ch.events),
                pct: num(ch.pct),
                sources: num(ch.sources),
                color: colorFor(idx),
                radius: 14 + share * 28,
                orbit: 90 + (idx % 3) * 28,
                phase: (idx / Math.max(state.channels.length, 1)) * Math.PI * 2,
                pulse: idx === 0
            };
        });

        function draw(angle) {
            ctx.clearRect(0, 0, width, height);
            var cx = width / 2;
            var cy = height / 2;

            ctx.beginPath();
            ctx.strokeStyle = "rgba(125,255,154,0.12)";
            ctx.lineWidth = 1;
            [90, 118, 146].forEach(function(r) {
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();
            });

            ctx.beginPath();
            ctx.fillStyle = "#10251d";
            ctx.strokeStyle = "#7dff9a";
            ctx.lineWidth = 2;
            ctx.arc(cx, cy, 36, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = "#7dff9a";
            ctx.font = "700 10px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("RECEIVER", cx, cy - 4);
            ctx.fillStyle = "#e8f5ef";
            ctx.font = "12px sans-serif";
            var label = centreLabel.length > 22 ? centreLabel.slice(0, 20) + "…" : centreLabel;
            ctx.fillText(label, cx, cy + 12);

            nodes.forEach(function(node) {
                var a = angle + node.phase;
                node.x = cx + Math.cos(a) * node.orbit;
                node.y = cy + Math.sin(a) * node.orbit;
                var glow = node.pulse ? (0.35 + 0.25 * Math.sin(angle * 3)) : 0.15;
                ctx.beginPath();
                ctx.fillStyle = hexAlpha(node.color, glow);
                ctx.arc(node.x, node.y, node.radius + 8, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.fillStyle = node.color;
                ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
                ctx.fill();
                if (state.selectedChannel === node.channel) {
                    ctx.beginPath();
                    ctx.strokeStyle = "#ffffff";
                    ctx.lineWidth = 2;
                    ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.fillStyle = "#e8f5ef";
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(node.channel, node.x, node.y + node.radius + 14);
            });
        }

        function tick() {
            state.orbitAngle += 0.004;
            draw(state.orbitAngle);
            state.animFrame = window.requestAnimationFrame(tick);
        }
        tick();

        $(canvas).off("click.digIngest").on("click.digIngest", function(evt) {
            var rect = canvas.getBoundingClientRect();
            var x = evt.clientX - rect.left;
            var y = evt.clientY - rect.top;
            var hit = null;
            nodes.forEach(function(node) {
                var dx = x - node.x;
                var dy = y - node.y;
                if (Math.sqrt(dx * dx + dy * dy) <= node.radius + 4) {
                    hit = node;
                }
            });
            if (hit) {
                state.selectedChannel = hit.channel;
                updateSidePanel(hit.channel);
            }
        });

        if (state.selectedChannel) {
            updateSidePanel(state.selectedChannel);
        }
    }

    function updateSidePanel(channel) {
        var $body = $("#dig-ingest-side-body");
        if (!$body.length) {
            return;
        }
        var ch = state.channels.filter(function(c) {
            return c.ingress_channel === channel;
        })[0];
        var sources = state.flows.filter(function(f) {
            return f.ingress_channel === channel;
        });
        var bySource = {};
        sources.forEach(function(f) {
            var key = f.group_value || "unknown";
            bySource[key] = (bySource[key] || 0) + num(f.events);
        });
        var ranked = Object.keys(bySource).map(function(k) {
            return { name: k, events: bySource[k] };
        }).sort(function(a, b) {
            return b.events - a.events;
        }).slice(0, 8);

        var html = "<p style=\"color:#a8c4b6;font-size:12px;margin:0 0 10px 0;\">";
        html += escapeHtml(channel) + " · " + (ch ? num(ch.events) : 0) + " events · " + (ch ? num(ch.pct) : 0) + "%</p>";
        if (!ranked.length) {
            html += '<div class="dig-ingest-side-empty">No group_value rows for this channel in the flow summary.</div>';
        } else {
            html += '<ul class="dig-ingest-side-list">';
            ranked.forEach(function(item) {
                html += "<li><span>" + escapeHtml(item.name) + "</span><span>" + item.events + "</span></li>";
            });
            html += "</ul>";
        }
        $body.html(html);
    }

    /* ---------- Design B flow ribbon ---------- */

    function renderDesignB() {
        var $root = $("#dig-ingest-design-b");
        if (!$root.length) {
            return;
        }
        if (!state.flows.length) {
            $root.html('<div class="dig-ingest-lab-wrap"><p class="dig-ingest-pending">Waiting for flow summary...</p></div>');
            return;
        }

        var html = '<div class="dig-ingest-lab-wrap" style="position:relative;">';
        html += '<p class="dig-ingest-lab-banner"><strong>Design B:</strong> Flow ribbon (Sankey-lite). Source → channel → receiver. Thickness = events.</p>';
        html += '<div class="dig-ingest-flow-host" id="dig-ingest-flow-host"></div>';
        html += '<div class="dig-ingest-flow-tip" id="dig-ingest-flow-tip"></div>';
        html += "</div>";
        $root.html(html);

        var flows = state.flows.slice().sort(function(a, b) {
            return num(b.events) - num(a.events);
        }).slice(0, 40);
        var total = flows.reduce(function(sum, f) {
            return sum + num(f.events);
        }, 0) || 1;

        var left = unique(flows.map(function(f) { return f.group_value || "unknown"; }));
        var mid = unique(flows.map(function(f) { return f.ingress_channel || "Unclassified"; }));
        var right = unique(flows.map(function(f) { return f.receiver || "unknown"; }));

        var width = 720;
        var height = 300;
        var colL = 20;
        var colM = width / 2 - 40;
        var colR = width - 140;
        var nodeH = 18;

        function stackPositions(names, x) {
            var map = {};
            var gap = Math.min(22, (height - 40) / Math.max(names.length, 1));
            names.forEach(function(name, i) {
                map[name] = { x: x, y: 30 + i * gap, name: name };
            });
            return map;
        }

        var leftPos = stackPositions(left, colL);
        var midPos = stackPositions(mid, colM);
        var rightPos = stackPositions(right, colR);
        var channelIndex = {};
        mid.forEach(function(name, idx) {
            channelIndex[name] = idx;
        });

        var svg = '<svg viewBox="0 0 ' + width + " " + height + '" xmlns="http://www.w3.org/2000/svg">';
        flows.forEach(function(f) {
            var a = leftPos[f.group_value || "unknown"];
            var b = midPos[f.ingress_channel || "Unclassified"];
            var c = rightPos[f.receiver || "unknown"];
            if (!a || !b || !c) {
                return;
            }
            var stroke = 1 + (num(f.events) / total) * 28;
            var color = colorFor(channelIndex[f.ingress_channel || "Unclassified"] || 0);
            var tip = escapeAttr((f.group_value || "?") + " → " + (f.ingress_channel || "?") + " → " + (f.receiver || "?") + " (" + num(f.events) + ")");
            svg += pathLink(a.x + 90, a.y, b.x, b.y, stroke, color, tip);
            svg += pathLink(b.x + 90, b.y, c.x, c.y, stroke, color, tip);
        });

        function drawNodes(map) {
            Object.keys(map).forEach(function(key) {
                var n = map[key];
                var label = n.name.length > 18 ? n.name.slice(0, 16) + "…" : n.name;
                svg += '<rect x="' + n.x + '" y="' + (n.y - nodeH / 2) + '" width="90" height="' + nodeH + '" rx="4" fill="#10251d" stroke="#3a5a4c"/>';
                svg += '<text class="dig-ingest-node-label" x="' + (n.x + 45) + '" y="' + (n.y + 4) + '" text-anchor="middle">' + escapeHtml(label) + "</text>";
            });
        }
        drawNodes(leftPos);
        drawNodes(midPos);
        drawNodes(rightPos);
        svg += "</svg>";
        $("#dig-ingest-flow-host").html(svg);

        var $tip = $("#dig-ingest-flow-tip");
        $("#dig-ingest-flow-host path.dig-ingest-link").on("mousemove", function(evt) {
            $tip.text($(this).attr("data-tip") || "").css({
                display: "block",
                left: evt.pageX + 12,
                top: evt.pageY - 10
            });
        }).on("mouseleave", function() {
            $tip.hide();
        });
    }

    function pathLink(x1, y1, x2, y2, stroke, color, tip) {
        var mx = (x1 + x2) / 2;
        return '<path class="dig-ingest-link" data-tip="' + tip + '" d="M' + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2 + '" stroke="' + color + '" stroke-width="' + stroke.toFixed(2) + '"/>';
    }

    function unique(arr) {
        var seen = {};
        var out = [];
        arr.forEach(function(v) {
            if (!seen[v]) {
                seen[v] = true;
                out.push(v);
            }
        });
        return out;
    }

    function hexAlpha(hex, alpha) {
        var h = String(hex || "#7dff9a").replace("#", "");
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        var r = parseInt(h.slice(0, 2), 16);
        var g = parseInt(h.slice(2, 4), 16);
        var b = parseInt(h.slice(4, 6), 16);
        return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function escapeAttr(s) {
        return escapeHtml(s).replace(/'/g, "&#39;");
    }

    function renderAll() {
        renderDesignA();
        renderDesignB();
        renderDesignC();
    }

    bindMulti("viz_ingest_channels", function(rows) {
        state.channels = (rows || []).slice().sort(function(a, b) {
            return num(b.events) - num(a.events);
        });
    });

    bindMulti("viz_ingest_flows", function(rows) {
        state.flows = rows || [];
    });

    renderAll();
});
