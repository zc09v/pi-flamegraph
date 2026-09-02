import type { FlameGraphData, Span } from "./types";

function escAttr(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

/**
 * The inline renderer. It is intentionally written with no template literals
 * or `${...}` sequences so it can live safely inside the outer template string.
 */
const RENDERER_JS = `
(function () {
  var data = JSON.parse(document.getElementById("flamegraph-data").textContent);
  var root = data.root;
  var viewRoot = root;

  var chart = document.getElementById("chart");
  var chartScroll = document.getElementById("chart-scroll");
  var tooltip = document.getElementById("tooltip");
  var breadcrumb = document.getElementById("breadcrumb");
  var searchInput = document.getElementById("search");
  var statsEl = document.getElementById("stats");
  var legendEl = document.getElementById("legend");
  var resetBtn = document.getElementById("reset");

  var ROW_HEIGHT = 22;
  var MIN_BAR_PX = 1.2;
  var MIN_WIDTH_PX = 900;

  var CATEGORY_COLORS = {
    session: "#7d8bb0",
    agent: "#9b7bd0",
    turn: "#2fbfae",
    model: "#e08c3f",
    request: "#e6c46a",
    tool: "#5cb85c"
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtMs(ms) {
    if (!isFinite(ms)) return "n/a";
    if (ms < 1) return ms.toFixed(2) + " ms";
    if (ms < 1000) return (Math.round(ms * 10) / 10) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(2) + " s";
    var m = Math.floor(ms / 60000);
    var s = ((ms % 60000) / 1000).toFixed(1);
    return m + "m " + s + "s";
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function fmtInt(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n);
    return n.toLocaleString();
  }

  function fmtUsd(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n);
    var abs = Math.abs(n);
    var d = abs >= 1 ? 2 : (abs >= 0.01 ? 4 : 6);
    return "$" + n.toFixed(d);
  }

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  function colorFor(node) {
    if (node.category === "tool") {
      var hue = 85 + (hashStr(node.name) % 55);
      return "hsl(" + hue + ", 52%, 42%)";
    }
    return CATEGORY_COLORS[node.category] || "#8890a0";
  }

  function indexTree() {
    var id = 0;
    function walk(n, p) {
      n.__id = id++;
      n.__parent = p || null;
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i], n);
    }
    walk(root, null);
  }

  function collect(node, parent, out) {
    var dur = node.end - node.start;
    var kids = node.children || [];
    var childDur = 0;
    var item = { node: node, parent: parent };
    out.push(item);
    for (var i = 0; i < kids.length; i++) {
      collect(kids[i], item, out);
      childDur += (kids[i].end - kids[i].start);
    }
    item.self = Math.max(dur - childDur, 0);
    return item;
  }

  function assignRows(items) {
    var sorted = items.slice().sort(function (a, b) {
      return (a.node.start - b.node.start) || (a.node.__id - b.node.__id);
    });
    var rowEnds = [];
    var rowOf = [];
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var r = 0;
      while (r < rowEnds.length && rowEnds[r] > it.node.start) r++;
      rowEnds[r] = it.node.end;
      rowOf[it.node.__id] = r;
    }
    return rowOf;
  }

  function findMatches(query) {
    if (!query) return null;
    var matches = [];
    function walk(n) {
      if (n.name && n.name.toLowerCase().indexOf(query) >= 0) matches.push(n);
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    }
    walk(root);
    return matches;
  }

  function renderBreadcrumb() {
    breadcrumb.innerHTML = "";
    var chain = [];
    var n = viewRoot;
    while (n) { chain.push(n); n = n.__parent; }
    chain.reverse();
    for (var i = 0; i < chain.length; i++) {
      (function (target) {
        var span = document.createElement("span");
        span.className = "crumb";
        span.textContent = target.name || target.category;
        span.addEventListener("click", function () { viewRoot = target; render(); });
        breadcrumb.appendChild(span);
      })(chain[i]);
      if (i < chain.length - 1) {
        var sep = document.createElement("span");
        sep.textContent = " / ";
        breadcrumb.appendChild(sep);
      }
    }
  }

  function addRow(rows, key, val) {
    rows.push('<div class="tt-row"><span class="k">' + key + ':</span> ' + val + '</div>');
  }

  function metaStr(v, cap) {
    if (v == null) return "";
    var s = typeof v === "string" ? v : JSON.stringify(v);
    if (s === undefined) s = String(v);
    if (s && s.length > cap) s = s.slice(0, cap) + "…";
    return esc(s);
  }

  function showTooltip(item, ev) {
    var n = item.node;
    var dur = n.end - n.start;
    var rows = [];
    rows.push('<div class="tt-title">' + esc(n.name || n.category) + '</div>');
    addRow(rows, "category", esc(n.category));
    addRow(rows, "duration", fmtMs(dur));
    var selfPct = dur > 0 ? (item.self / dur * 100).toFixed(0) : "0";
    addRow(rows, "self", fmtMs(item.self) + " (" + selfPct + "%)");
    if (item.parent) {
      var pdur = item.parent.node.end - item.parent.node.start;
      if (pdur > 0) {
        addRow(rows, "of parent", (dur / pdur * 100).toFixed(1) + "%");
      }
    }
    addRow(rows, "start", fmtClock(n.start));
    addRow(rows, "end", fmtClock(n.end));

    var meta = n.meta;
    if (meta) {
      if (meta.tokens) {
        var t = meta.tokens;
        var tp = [];
        if (typeof t.input === "number") tp.push("in " + fmtInt(t.input));
        if (typeof t.output === "number") tp.push("out " + fmtInt(t.output));
        if (typeof t.cacheRead === "number") tp.push("cacheR " + fmtInt(t.cacheRead));
        if (typeof t.cacheWrite === "number") tp.push("cacheW " + fmtInt(t.cacheWrite));
        if (typeof t.reasoning === "number") tp.push("reasoning " + fmtInt(t.reasoning));
        if (typeof t.total === "number") tp.push("total " + fmtInt(t.total));
        if (tp.length) addRow(rows, "tokens", tp.join(" · "));
      }
      if (meta.cost) {
        var c = meta.cost;
        var cp = [];
        if (typeof c.input === "number") cp.push("in " + fmtUsd(c.input));
        if (typeof c.output === "number") cp.push("out " + fmtUsd(c.output));
        if (typeof c.cacheRead === "number") cp.push("cacheR " + fmtUsd(c.cacheRead));
        if (typeof c.cacheWrite === "number") cp.push("cacheW " + fmtUsd(c.cacheWrite));
        if (typeof c.total === "number") cp.push("total " + fmtUsd(c.total));
        if (cp.length) addRow(rows, "cost", cp.join(" · "));
      }
      var skip = { tokens: 1, cost: 1, args: 1 };
      for (var k in meta) {
        if (meta.hasOwnProperty(k) && !skip[k]) {
          var v = meta[k];
          if (v !== undefined && v !== null) addRow(rows, k, metaStr(v, 220));
        }
      }
      if (meta.args) addRow(rows, "args", metaStr(meta.args, 300));
    }

    var kids = n.children || [];
    if (kids.length) {
      rows.push('<div class="tt-sec">children (' + kids.length + ')</div>');
      var shown = kids.slice(0, 10);
      for (var i = 0; i < shown.length; i++) {
        var kn = shown[i];
        rows.push('<div class="tt-row tt-child">' + esc(kn.name || kn.category) + ' · ' + fmtMs(kn.end - kn.start) + '</div>');
      }
      if (kids.length > shown.length) {
        rows.push('<div class="tt-row tt-child tt-more">… +' + (kids.length - shown.length) + ' more</div>');
      }
    }

    tooltip.innerHTML = rows.join("");
    tooltip.style.display = "block";
    var x = ev.clientX + 14;
    var y = ev.clientY + 14;
    var w = tooltip.offsetWidth;
    var h = tooltip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    tooltip.style.left = Math.max(8, x) + "px";
    tooltip.style.top = Math.max(8, y) + "px";
  }

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  function updateStats(items, maxRow, matches, viewDur) {
    var text = items.length + " spans · view " + fmtMs(viewDur) + " · max depth " + (maxRow + 1);
    if (matches) text += " · " + matches.length + " match" + (matches.length === 1 ? "" : "es");
    statsEl.textContent = text;
  }

  function renderLegend() {
    var order = ["session", "agent", "turn", "model", "request", "tool"];
    legendEl.innerHTML = "";
    for (var i = 0; i < order.length; i++) {
      var c = order[i];
      var item = document.createElement("span");
      var sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = CATEGORY_COLORS[c];
      item.appendChild(sw);
      item.appendChild(document.createTextNode(c));
      legendEl.appendChild(item);
    }
  }

  function render() {
    var items = [];
    collect(viewRoot, null, items);
    var rowOf = assignRows(items);
    var viewStart = viewRoot.start;
    var viewDur = Math.max(viewRoot.end - viewRoot.start, 1);
    var wrapWidth = Math.max(chartScroll.clientWidth, MIN_WIDTH_PX);
    var scale = wrapWidth / viewDur;
    var maxRow = 0;
    var maxRight = 0;
    var query = searchInput.value.trim().toLowerCase();
    var matches = findMatches(query);

    chart.innerHTML = "";

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var n = it.node;
      var left = (n.start - viewStart) * scale;
      var width = Math.max((n.end - n.start) * scale, MIN_BAR_PX);
      var row = rowOf[n.__id];
      if (row > maxRow) maxRow = row;
      if (left + width > maxRight) maxRight = left + width;

      var bar = document.createElement("div");
      bar.className = "bar cat-" + n.category;
      bar.style.left = left + "px";
      bar.style.top = (row * ROW_HEIGHT + 1) + "px";
      bar.style.width = width + "px";
      bar.style.height = (ROW_HEIGHT - 2) + "px";
      bar.style.background = colorFor(n);
      if (width > 26) bar.textContent = n.name || n.category;

      if (matches) {
        bar.className += matches.indexOf(n) >= 0 ? " hit" : " dim";
      }

      bar.__item = it;
      (function (target, item) {
        bar.addEventListener("click", function () { viewRoot = target; render(); });
        bar.addEventListener("mousemove", function (ev) { showTooltip(item, ev); });
        bar.addEventListener("mouseleave", hideTooltip);
      })(n, it);

      chart.appendChild(bar);
    }

    chart.style.width = Math.max(wrapWidth, maxRight) + "px";
    chart.style.height = ((maxRow + 1) * ROW_HEIGHT + 4) + "px";

    renderBreadcrumb();
    updateStats(items, maxRow, matches, viewDur);
  }

  searchInput.addEventListener("input", render);
  resetBtn.addEventListener("click", function () {
    searchInput.value = "";
    viewRoot = root;
    render();
  });

  indexTree();
  renderLegend();
  render();
})();
`;

export function renderFlameGraphHtml(data: FlameGraphData): string {
  // Escape "</" so the JSON cannot prematurely close the script tag.
  const dataJson = JSON.stringify(data).replace(/<\//g, "<\\/");

  const metaLines = [
    `<div>session: ${escAttr(data.sessionId || "n/a")}</div>`,
    data.sessionFile ? `<div>file: ${escAttr(data.sessionFile)}</div>` : "",
    data.cwd ? `<div>cwd: ${escAttr(data.cwd)}</div>` : "",
    `<div>generated: ${escAttr(data.generatedAt)}</div>`,
  ]
    .filter(Boolean)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escAttr(data.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #14161c;
    color: #e6e8ee;
    font-size: 13px;
  }
  header { padding: 14px 18px 10px; border-bottom: 1px solid #2a2e39; }
  h1 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
  .meta { color: #9aa1b0; font-size: 12px; line-height: 1.7; word-break: break-all; }
  .toolbar {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 10px 18px; border-bottom: 1px solid #2a2e39;
    position: sticky; top: 0; background: #14161c; z-index: 5;
  }
  .toolbar input {
    flex: 1; min-width: 160px; background: #1e2129; border: 1px solid #343947;
    color: #e6e8ee; padding: 6px 10px; border-radius: 6px; font-size: 13px;
  }
  .toolbar button {
    background: #262a34; border: 1px solid #343947; color: #dfe3ea;
    padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  }
  .toolbar button:hover { background: #2f3440; }
  .legend {
    display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 18px 2px;
    font-size: 12px; color: #9aa1b0;
  }
  .legend .sw {
    display: inline-block; width: 10px; height: 10px; border-radius: 2px;
    margin-right: 4px; vertical-align: -1px;
  }
  #stats { color: #8b93a3; font-size: 12px; padding: 6px 18px 0; }
  #breadcrumb {
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    padding: 6px 18px 0; font-size: 12px; color: #9aa1b0;
  }
  #breadcrumb .crumb { cursor: pointer; color: #7fb3ff; }
  #breadcrumb .crumb:hover { text-decoration: underline; }
  #chart-scroll { overflow: auto; padding: 8px 18px 18px; }
  #chart { position: relative; }
  .bar {
    position: absolute; border-radius: 3px; color: #0d0f13; font-size: 11px;
    line-height: 20px; padding: 0 5px; overflow: hidden; white-space: nowrap;
    text-overflow: ellipsis; cursor: pointer; border: 1px solid rgba(0,0,0,.35);
  }
  .bar.dim { opacity: 0.15; }
  .bar.hit { box-shadow: 0 0 0 2px #ffffff; z-index: 3; }
  #tooltip {
    position: fixed; display: none; background: #0c0e13; border: 1px solid #3a4150;
    border-radius: 8px; padding: 10px 12px; font-size: 12px; max-width: 520px;
    z-index: 20; pointer-events: none; box-shadow: 0 8px 24px rgba(0,0,0,.5);
  }
  .tt-title { font-weight: 600; margin-bottom: 4px; color: #ffffff; word-break: break-word; }
  .tt-row { color: #b7bdca; line-height: 1.6; }
  .tt-row .k { color: #7e8594; }
  .tt-child { padding-left: 10px; color: #8f96a5; }
  .tt-more { color: #6b7280; }
  .tt-sec { margin-top: 5px; margin-bottom: 1px; color: #7e8594; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
</style>
</head>
<body>
<header>
  <h1>${escAttr(data.title)}</h1>
  <div class="meta">${metaLines}</div>
</header>
<div class="legend" id="legend"></div>
<div class="toolbar">
  <input id="search" type="text" placeholder="Search spans…" autocomplete="off">
  <button id="reset">Reset zoom</button>
</div>
<div id="stats"></div>
<div id="breadcrumb"></div>
<div id="chart-scroll"><div id="chart"></div></div>
<div id="tooltip"></div>
<script type="application/json" id="flamegraph-data">${dataJson}</script>
<script>${RENDERER_JS}</script>
</body>
</html>`;
}
