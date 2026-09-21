/* ==========================================================================
   Event Reporting Center — render engine
   Only Live Today > Sales renders real numbers (from the connected Google
   Sheet via Code.gs). Every other tab is an explicit "Coming Soon" — this
   file intentionally contains no fabricated metric values.
   ========================================================================== */

/* ---------------- FORMAT HELPERS ---------------- */
function fmtVal(v, unit, decimals){
  if(v === null || v === undefined || !isFinite(v)) return "N/A";
  const d = decimals !== undefined ? decimals : (unit === "idx" ? 1 : unit === "rs" ? 0 : 2);
  const n = Number(v).toFixed(d).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  switch(unit){
    case "rs_cr": return `${n} Cr`;   // GMV: value already in Cr, no ₹
    case "cr":    return `${n} Cr`;
    case "l":     return `${n} Lac`;
    case "m":     return `${n} M`;
    case "rs":    return `${Math.round(v)}`;   // ASP: plain number
    case "pct":   return `${n}%`;
    case "idx":   return `${n}`;
    // Smart GMV: auto-scale Cr → L → K based on magnitude (value in Cr)
    case "gmv_auto": {
      const cr = Number(v);
      if(cr >= 1)  return `${cr.toFixed(decimals !== undefined ? decimals : 2).replace(/\.?0+$/,"")} Cr`;
      const lac = cr * 100;
      if(lac >= 1) return `${lac.toFixed(decimals !== undefined ? decimals : 2).replace(/\.?0+$/,"")} L`;
      return `${(lac * 100).toFixed(0)} K`;
    }
    // Smart Units: auto-scale Lac → K (value in Lac)
    case "units_auto": {
      const lac = Number(v);
      if(lac >= 1) return `${lac.toFixed(decimals !== undefined ? decimals : 2).replace(/\.?0+$/,"")} Lac`;
      const k = lac * 100;
      return `${k.toFixed(decimals !== undefined ? decimals : 1).replace(/\.?0+$/,"")}K`;
    }
    default: return `${n}`;
  }
}

/* ---------------- SVG LINE CHART (with numeric Y axis) ---------------- */
function niceStep(rawStep){
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * mag;
}
/* Catmull-Rom -> cubic Bezier smoothing, built per contiguous (non-null) run
   so gaps in the data still show as breaks rather than being bridged. */
function smoothSegmentPath(points){
  if(points.length < 2) return "";
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} `;
  for(let i = 0; i < points.length - 1; i++){
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)} `;
  }
  return d;
}
/* Shared geometry so the hover overlay (attachChartHover) can compute the same
   pixel positions as the static chart it's drawn over. */
const CHART_GEOM = { w: 1000, h: 340, padL: 62, padR: 18, padT: 18, padB: 34 };
function chartScales(series, labels){
  const { w, h, padL, padR, padT, padB } = CHART_GEOM;
  const allVals = series.flatMap(s => s.data).filter(v => v !== null && v !== undefined);
  const rawMax = Math.max(...allVals, 0);
  const step = niceStep(rawMax / 4 || 1);
  const max = step * 4;
  const min = 0;
  return {
    hasData: allVals.length > 0, max, min, step,
    x: i => padL + (i / (labels.length - 1 || 1)) * (w - padL - padR),
    y: v => h - padB - ((v - min) / ((max - min) || 1)) * (h - padT - padB),
  };
}
function svgLineChart(series, labels, axisUnit){
  const { w, h, padL, padR, padT, padB } = CHART_GEOM;
  const scales = chartScales(series, labels);
  if(!scales.hasData){
    return `<svg viewBox="0 0 ${w} ${h}"><text x="${w/2}" y="${h/2}" font-size="15" fill="#9aa7bb" text-anchor="middle">No data yet</text></svg>`;
  }
  const { x, y, max, min, step } = scales;

  const ticks = [0, 1, 2, 3, 4].map(i => min + i * step);
  const gridLines = ticks.map(t => {
    const gy = y(t).toFixed(1);
    return `<line x1="${padL}" y1="${gy}" x2="${w-padR}" y2="${gy}" stroke="#eef1f7" stroke-width="1" shape-rendering="crispEdges"/>`;
  }).join("");
  const yLabels = ticks.map(t => {
    const gy = y(t);
    return `<text x="${padL-10}" y="${(gy+4).toFixed(1)}" font-size="12" fill="#8793a7" text-anchor="end">${fmtVal(t, axisUnit || "cr", 1)}</text>`;
  }).join("");

  const defs = series.map((s, si) => `
    <linearGradient id="chartFill${si}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${s.color}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
    </linearGradient>`).join("");

  const paths = series.map((s, si) => {
    const runs = [];
    let current = [];
    s.data.forEach((v, i) => {
      if(v === null || v === undefined){
        if(current.length) runs.push(current);
        current = [];
        return;
      }
      current.push({ x: x(i), y: y(v) });
    });
    if(current.length) runs.push(current);

    const fillArea = si === 0 ? runs.map(pts => {
      const d = smoothSegmentPath(pts);
      const base = h - padB;
      return `<path d="${d} L${pts[pts.length-1].x.toFixed(1)},${base} L${pts[0].x.toFixed(1)},${base} Z" fill="url(#chartFill${si})" stroke="none"/>`;
    }).join("") : "";

    const line = runs.map(pts => `<path fill="none" stroke="${s.color}" stroke-width="${s.width||3}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${s.dash ? s.dash.join(",") : "0"}" d="${smoothSegmentPath(pts)}"/>`).join("");

    return fillArea + line;
  }).join("");

  const xStep = Math.ceil(labels.length / 8) || 1;
  const xLabels = labels.map((l, i) => (i % xStep === 0 || i === labels.length-1)
    ? `<text x="${x(i).toFixed(1)}" y="${h-10}" font-size="12" fill="#9aa7bb" text-anchor="middle">${l}</text>` : "").join("");

  const axisLine = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h-padB}" stroke="#d5dce8" stroke-width="1" shape-rendering="crispEdges"/>`;

  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs>${defs}</defs>${gridLines}${axisLine}${yLabels}${paths}${xLabels}</svg>`;
}
/* Crosshair + per-series dots + tooltip, drawn as absolutely-positioned HTML
   over the chart container (simpler than mutating the SVG DOM on every move). */
function attachChartHover(containerId, series, labels, axisUnit){
  const container = document.getElementById(containerId);
  if(!container) return;
  const scales = chartScales(series, labels);
  if(!scales.hasData) return;
  const { x, y } = scales;
  const { w, h, padL, padR } = CHART_GEOM;

  let overlay = container.querySelector(".chart-hover-overlay");
  if(overlay) overlay.remove();
  overlay = document.createElement("div");
  overlay.className = "chart-hover-overlay";
  overlay.innerHTML = `<div class="chart-hover-line"></div>` +
    series.map(s => `<div class="chart-hover-dot" style="background:${s.color}"></div>`).join("") +
    `<div class="chart-hover-tip"></div>`;
  container.appendChild(overlay);

  const line = overlay.querySelector(".chart-hover-line");
  const dots = overlay.querySelectorAll(".chart-hover-dot");
  const tip = overlay.querySelector(".chart-hover-tip");
  const step = (w - padL - padR) / (labels.length - 1 || 1);

  function handleMove(clientX){
    const rect = container.getBoundingClientRect();
    const scaleX = w / rect.width, scaleY = h / rect.height;
    const dataX = (clientX - rect.left) * scaleX;
    const idx = Math.max(0, Math.min(labels.length - 1, Math.round((dataX - padL) / step)));
    const pxX = x(idx) / scaleX;

    line.style.left = pxX + "px";
    line.style.display = "block";

    let tipHtml = `<div class="tip-label">${labels[idx]}</div>`;
    series.forEach((s, i) => {
      const v = s.data[idx];
      const dot = dots[i];
      if(v === null || v === undefined){ dot.style.display = "none"; return; }
      dot.style.left = pxX + "px";
      dot.style.top = (y(v) / scaleY) + "px";
      dot.style.display = "block";
      tipHtml += `<div class="tip-row"><i style="background:${s.color}"></i>${s.label}: <b>${fmtVal(v, axisUnit || "cr")}</b></div>`;
    });
    tip.innerHTML = tipHtml;
    tip.style.display = "block";
    const tipLeft = pxX > rect.width - 150 ? pxX - 150 : pxX + 10;
    tip.style.left = tipLeft + "px";
  }

  container.onmousemove = e => handleMove(e.clientX);
  container.onmouseleave = () => {
    line.style.display = "none";
    dots.forEach(d => d.style.display = "none");
    tip.style.display = "none";
  };
}
function legendFor(series){
  return `<div class="legend">${series.map(s=>`<span><i class="dot" style="background:${s.color}"></i>${s.label}</span>`).join("")}</div>`;
}

/* ---------------- MASTER BUSINESS STATE ---------------- */
let CURRENT_BUSINESS = DEFAULT_BUSINESS;
function businessLabel(){
  return (BUSINESSES.find(b => b.key === CURRENT_BUSINESS) || {}).label || CURRENT_BUSINESS;
}
function renderBusinessSwitcher(){
  const el = document.getElementById("businessSwitcher");
  el.innerHTML = BUSINESSES.map(b => `<button class="${b.key===CURRENT_BUSINESS?'active':''}" data-biz="${b.key}">${b.label}</button>`).join("");
  el.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      if(btn.dataset.biz === CURRENT_BUSINESS) return;
      CURRENT_BUSINESS = btn.dataset.biz;
      LIVE_FILTERS = { marketplace: "All", branded: "All", alpha: "All", pricePoint: "All", sc: "All" }; // filter values (e.g. price buckets) are business-specific
      LIVE_DAY = "D0";
      FUNNEL_DAY = "D0";
      TRAFFIC_DAY = "D0";
      FUNNEL_FILTERS        = { alpha: "All", sc: "All" };
      SUMMARY_FUNNEL_FILTERS = { alpha: "All", sc: "All" };
      SUMMARY_FUNNEL_DAY = "All";
      TRAFFIC_FILTERS       = { alpha: "All", sc: "All" };
      CVP_FILTERS     = { sc: "All" };
      renderNavAndPages(activePageId);
    });
  });
}

/* ---------------- COMING SOON PAGE ---------------- */
function renderComingSoon(groupId, tabKey){
  const config = TAB_CONFIGS[tabKey];
  const el = document.getElementById(`page-${groupId}-${tabKey}`);
  if(!el) return;
  const label = groupId === "event" ? "Event Summary" : "Live Today";
  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>${label} — ${config.title}</h1><div class="sub">Not connected to a data source yet</div></div>
        <span class="tag ok">${businessLabel()}</span>
        <span class="tag warn">🚧 Coming Soon</span>
      </div>
      <div class="callout" style="margin-top:6px">
        This tab isn't wired to a live data source yet, so it intentionally shows no numbers
        instead of illustrative placeholders. Only <b>Live Today → Sales</b> is currently
        connected (Google Sheet: GMV, Units, ASP).
      </div>
      <div class="section-title" style="margin-top:16px"><span>Planned Metrics</span><span class="line"></span></div>
      <div class="chip-row" style="display:flex;flex-wrap:wrap;gap:7px">
        ${config.metrics.map(m => `<div class="chip">${m.name}</div>`).join("")}
      </div>
    </div>`;
}

/* Sheet's order_date_key is a plain YYYYMMDD int — format for display. */
function fmtSheetDate(dateKey){
  const s = String(dateKey);
  if(s.length !== 8) return s;
  const d = new Date(Number(s.slice(0,4)), Number(s.slice(4,6)) - 1, Number(s.slice(6,8)));
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); // e.g. "8 Sept"
}

/* ---------------- LIVE SALES PAGE (Live Today > Sales — real data only) ---------------- */
function renderLiveSalesLoading(){
  const el = document.getElementById("page-live-sales");
  if(!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Sales</h1><div class="sub">Hourly performance, live from Google Sheet</div></div>
        <span class="tag ok">${businessLabel()}</span>
        <span class="tag warn" id="liveSalesStatus">⏳ Connecting…</span>
      </div>
      <div class="callout">Loading live GMV/Units data for ${businessLabel()}…</div>
    </div>`;
}

/* ---------------- BACKEND ABSTRACTION ----------------
   Two interchangeable backends expose the same two functions
   (getLiveSalesData(business), getSalesDebugInfo()):
   - Apps Script deployment: google.script.run (server = Code.gs)
   - Local dev: fetch() against the Flask server in server/app.py
   Both return the identical JSON shape, so the rendering code below never
   needs to know which one it's talking to. */
const BACKEND_ROUTES = {
  getLiveSalesData: (business, filters, day) => `/api/live-sales?${new URLSearchParams(Object.assign({ business, day }, filters || {})).toString()}`,
  getSalesDebugInfo: () => `/api/sales-debug`,
  getFilterOptions: business => `/api/filter-options?business=${encodeURIComponent(business)}`,
  getFunnelData: (business, day, filters) => `/api/funnel-data?${new URLSearchParams(Object.assign({ business, day }, filters || {})).toString()}`,
  getFunnelFilterOptions: business => `/api/funnel-filter-options?business=${encodeURIComponent(business)}`,
  getTrafficData: (business, day, filters) => `/api/traffic-data?${new URLSearchParams(Object.assign({ business, day }, filters || {})).toString()}`,
  getTrafficFilterOptions: business => `/api/traffic-filter-options?business=${encodeURIComponent(business)}`,
  getCvpData: (business, filters) => `/api/cvp-data?${new URLSearchParams(Object.assign({ business }, filters || {})).toString()}`,
};
function callBackend(fnName, args, onSuccess, onError){
  if(typeof google !== "undefined" && google.script && google.script.run){
    google.script.run.withSuccessHandler(onSuccess).withFailureHandler(onError)[fnName].apply(null, args);
    return;
  }
  fetch(BACKEND_ROUTES[fnName].apply(null, args))
    .then(r => {
      // 404 with no JSON body = plain static server, no /api route at all.
      // 4xx/5xx WITH a JSON {error} body = the Flask backend IS running but
      // hit a real error (e.g. missing credentials.json) — surface that instead.
      return r.json()
        .catch(() => { throw new Error(`No local backend at this port (HTTP ${r.status}) — run "python3 server/app.py" instead of the plain static server.`); })
        .then(body => {
          if(!r.ok || (body && body.error)) throw new Error((body && body.error) || `HTTP ${r.status}`);
          return body;
        });
    })
    .then(onSuccess)
    .catch(onError);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function renderLiveSalesEmpty(message, showDebug){
  const el = document.getElementById("page-live-sales");
  if(!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Sales</h1><div class="sub">Hourly performance, live from Google Sheet</div></div>
        <span class="tag ok">${businessLabel()}</span>
        <span class="tag bad" id="liveSalesStatus">⚠ No data</span>
      </div>
      <div class="callout" style="white-space:pre-wrap">${escapeHtml(message)}</div>
    </div>
    <div id="liveSalesDebug" style="margin-top:10px"></div>`;

  if(showDebug){
    callBackend("getSalesDebugInfo", [], renderLiveSalesDebug, err => {
      const dbg = document.getElementById("liveSalesDebug");
      if(dbg) dbg.innerHTML = `<div class="callout" style="white-space:pre-wrap">Debug call failed: ${escapeHtml(err && err.message ? err.message : err)}</div>`;
    });
  }
}

function renderLiveSalesDebug(info){
  const dbg = document.getElementById("liveSalesDebug");
  if(!dbg || !info) return;
  const rows = (obj) => Object.keys(obj).sort((a,b)=>obj[b]-obj[a])
    .map(k => `<tr><td>${k || "(blank)"}</td><td>${obj[k]}</td></tr>`).join("") || `<tr><td colspan="2">none</td></tr>`;
  dbg.innerHTML = `
    <div class="card">
      <div class="cardhead"><b>DEBUG — Sheet Diagnostics</b><span class="tiny">temporary, remove getSalesDebugInfo() call once fixed</span></div>
      <div class="callout" style="margin-bottom:10px">
        Sheet has <b>${info.numSheetsInFile}</b> tab(s): ${info.allSheets.map(s=>`${s.name} (${s.rows} rows)`).join(", ")}.
        Reading tab: <b>${info.activeSheetName}</b> · ${info.totalDataRows} data rows · latest order_date_key = <b>${info.maxDate}</b>.
        <br>Current BUSINESS_SHEET_MAP: ${JSON.stringify(info.businessSheetMap)}
      </div>
      <div class="grid g2">
        <div>
          <div class="tiny" style="margin-bottom:6px">Business units at latest date (${info.maxDate})</div>
          <table class="table"><thead><tr><th>analytic_business_unit</th><th>rows</th></tr></thead><tbody>${rows(info.businessUnitCountsAtMaxDate)}</tbody></table>
        </div>
        <div>
          <div class="tiny" style="margin-bottom:6px">Business units across whole sheet</div>
          <table class="table"><thead><tr><th>analytic_business_unit</th><th>rows</th></tr></thead><tbody>${rows(info.businessUnitCountsOverall)}</tbody></table>
        </div>
      </div>
    </div>`;
}

const LIVE_SALES_METRICS = [
  { key: "gmv", label: "GMV", unit: "rs_cr", pick: h => h.gmv / 1e7 },
  { key: "units", label: "Units", unit: "l", pick: h => h.units / 1e5 },
];

/* Real filters, matching the sheet's own columns — applied server-side. */
const LIVE_FILTER_KEYS = ["marketplace", "branded", "alpha", "pricePoint", "sc"];
const LIVE_FILTER_LABELS = { marketplace: "Marketplace", branded: "Brand", alpha: "Alpha/MP", pricePoint: "Price Point", sc: "Super Category" };
let LIVE_FILTERS = { marketplace: "All", branded: "All", alpha: "All", pricePoint: "All", sc: "All" };
/* The raw sheet spans exactly 2 days: D0 (today, live/partial) and D-1 (yesterday, complete). */
let LIVE_DAY = "D0";

/* Live Today > Funnel — separate spreadsheet. No marketplace/brand/price-point
   columns exist at this grain, but Alpha/MP and Super Category do (each
   backed by its own dedicated grain tab — see server/app.py funnel_grain_tabs). */
const FUNNEL_FILTER_KEYS = ["alpha", "sc"];
const FUNNEL_FILTER_LABELS = { alpha: "Alpha/MP", sc: "Super Category" };
let FUNNEL_FILTERS = { alpha: "All", sc: "All" };

/* Live Today > Traffic — same grain logic as Funnel (CY only for now). */
const TRAFFIC_FILTER_KEYS   = ["alpha", "sc"];
const TRAFFIC_FILTER_LABELS = { alpha: "Alpha/MP", sc: "Super Category" };
let TRAFFIC_FILTERS = { alpha: "All", sc: "All" };
let TRAFFIC_DAY = "D0";

const TRAFFIC_KPI_METRICS = [
  { key: "visits",   label: "Visits",          unit: "m" },
  { key: "direct",   label: "Direct Visits",   unit: "m" },
  { key: "indirect", label: "Indirect Visits",  unit: "m" },
  { key: "search",   label: "Search Visits",    unit: "m" },
  { key: "merch",    label: "Merch Visits",     unit: "m" },
  { key: "reco",     label: "Reco Visits",      unit: "m" },
  { key: "crm",      label: "CRM Visits",       unit: "m" },
  { key: "perf",     label: "Perf Visits",      unit: "m" },
  { key: "reco_hp",  label: "Reco HP Visits",   unit: "m" },
  { key: "reco_pp",  label: "Reco PP Visits",   unit: "m" },
  { key: "wlm",      label: "WLM",              unit: "m" },
  { key: "infinite", label: "Infinite",         unit: "m" },
];
/* Chart metric list — raw additive series only (no derived ratios for traffic). */
const TRAFFIC_CHART_METRICS = TRAFFIC_KPI_METRICS.map(m => ({
  key: m.key, label: m.label, unit: m.unit, type: "raw",
  pick: h => (h[m.key] || 0) / 1e6,
}));

const FUNNEL_METRICS = [
  { key: "visits", label: "Visits", unit: "m", type: "raw", pick: h => h.visits / 1e6 },
  { key: "ppv", label: "PPV", unit: "m", type: "raw", pick: h => h.ppv / 1e6 },
  { key: "ppvRate", label: "Visits with PPV %", unit: "pct", type: "ratio", num: "ppvVisits", den: "visits" },
  { key: "ppvToCabn", label: "PPV to CABN Visits", unit: "pct", type: "ratio", num: "cabn", den: "ppvVisits" },
  { key: "cabnToCheckout", label: "CABN to Checkout Visits", unit: "pct", type: "ratio", num: "checkout", den: "cabn" },
  { key: "checkoutToSummary", label: "Checkout to Summary Visits", unit: "pct", type: "ratio", num: "summary", den: "checkout" },
  { key: "summaryToPayment", label: "Summary to Payment Visits", unit: "pct", type: "ratio", num: "payment", den: "summary" },
  { key: "p2o", label: "P2O Visits", unit: "pct", type: "ratio", num: "orders", den: "payment" },
  { key: "ov", label: "O/V", unit: "pct", type: "ratio", num: "orders", den: "visits" },
];
let FUNNEL_DAY = "D0";
/* Overall aggregate uses totalGmv/totalUnits; per-SC entries use gmv/units — normalize both. */
function liveTotals(agg){
  const gmv = agg.totalGmv !== undefined ? agg.totalGmv : agg.gmv;
  const units = agg.totalUnits !== undefined ? agg.totalUnits : agg.units;
  return { gmv: gmv / 1e7, units: units / 1e5, asp: units ? gmv / units : null };
}
function liveHourlySeries(agg, metricKey, hourCount, metricsList){
  const m = (metricsList || LIVE_SALES_METRICS).find(x => x.key === metricKey);
  return Array.from({ length: hourCount }, (_, i) => {
    const row = agg.hourly.find(h => h.hour === i);
    return row ? m.pick(row) : null;
  });
}
function yoyPct(ty, ly){
  if(ly === null || ly === undefined || !ly) return null;
  return ((ty - ly) / ly) * 100;
}
function yoyBadge(pct){
  if(pct === null || pct === undefined || !isFinite(pct)) return "";
  const cls = pct >= 0 ? "up" : "down";
  return `<span class="stat ${cls}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% YoY</span>`;
}
/* Payment-mix metrics are already percentages, so their YoY is shown as a
   percentage-point delta (TY share minus LY share), not a relative % change. */
function ppBadge(tyShare, lyShare){
  if(tyShare === null || tyShare === undefined || lyShare === null || lyShare === undefined) return "";
  const deltaPp = (tyShare - lyShare) * 100;
  const cls = deltaPp >= 0 ? "up" : "down";
  return `<span class="stat ${cls}">${deltaPp >= 0 ? "▲" : "▼"} ${Math.abs(deltaPp).toFixed(1)}pp YoY</span>`;
}
function pct1(x){ return x === null || x === undefined ? "N/A" : (x * 100).toFixed(1) + "%"; }
/* BAU spike = live value ÷ BAU per-day average (normalized for the BAU
   period's day count) for the same hour window — how many multiples of a
   normal day this event hour-window is doing. Shown for GMV/Units only, one
   line per CY/LY, with only the multiplier colored (green ≥1x, red <1x). */
function spikeBadge(label, spike){
  if(spike === null || spike === undefined || !isFinite(spike)) return "";
  const cls = spike >= 1 ? "up" : "down";
  return `<div class="spike-line">${label} <span class="${cls}">${spike.toFixed(2)}x</span> BAU</div>`;
}

let _lastFilterOpts = {};
function populateLiveFilterOptions(){
  callBackend("getFilterOptions", [CURRENT_BUSINESS], opts => {
    if(!opts || opts.error) return;
    _lastFilterOpts = opts;
    LIVE_FILTER_KEYS.forEach(key => {
      const sel = document.getElementById(`liveFilter-${key}`);
      if(!sel) return;
      const values = opts[key] || [];
      sel.innerHTML = `<option value="All">${LIVE_FILTER_LABELS[key]}: All</option>` +
        values.map(v => `<option value="${escapeHtml(v)}" ${LIVE_FILTERS[key]===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
      sel.onchange = () => { LIVE_FILTERS[key] = sel.value; hydrateLiveSales(); };
    });
    // also populate breakdown filter dropdowns
    ["seg","mc","sc"].forEach(ns => {
      BREAKDOWN_FILTER_KEYS.forEach(k => {
        const sel2 = document.getElementById(`bdf-${ns}-${k}`);
        if(!sel2) return;
        const values = opts[k] || [];
        sel2.innerHTML = `<option value="All">${BREAKDOWN_FILTER_LABELS[k]}: All</option>` +
          values.map(v => `<option value="${escapeHtml(v)}" ${BREAKDOWN_FILTERS[k]===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
        sel2.value = BREAKDOWN_FILTERS[k];
        sel2.onchange = () => {
          BREAKDOWN_FILTERS[k] = sel2.value;
          LIVE_FILTERS[k] = sel2.value;
          // sync sibling namespaces + top filter bar
          ["seg","mc","sc"].forEach(n2 => {
            const s2 = document.getElementById(`bdf-${n2}-${k}`);
            if(s2 && s2 !== sel2) s2.value = sel2.value;
          });
          const top = document.getElementById(`liveFilter-${k}`);
          if(top) top.value = sel2.value;
          hydrateLiveSales();
        };
      });
    });
  }, () => { /* ignore silently */ });
}

function populateLiveDaySelect(days, selectedDay){
  const sel = document.getElementById("liveDaySelect");
  if(!sel || !days || !days.length) return;
  sel.innerHTML = days.map(d => `<option value="${d.key}" ${d.key===selectedDay?"selected":""}>${d.key} (${fmtSheetDate(d.dateKey)})</option>`).join("");
  sel.onchange = () => { LIVE_DAY = sel.value; hydrateLiveSales(); };
}

/* Shared KPI-card renderer — used for both the fixed Overall block and the
   independent SC-wise summary block, so the two never interfere with each other. */
function renderLiveKpiCards(targetId, agg, ly){
  const totals = liveTotals(agg);
  const lyTotals = ly ? liveTotals(ly) : null;
  const gmvYoy = lyTotals ? yoyPct(totals.gmv, lyTotals.gmv) : null;
  const unitsYoy = lyTotals ? yoyPct(totals.units, lyTotals.units) : null;
  const aspYoy = lyTotals ? yoyPct(totals.asp, lyTotals.asp) : null;
  const ps = agg.paymentShare || {};
  const lyPs = (ly && ly.paymentShare) || {};
  const bau = agg.bauSpike || {};
  const gmvSpike = bau.gmv || {}, unitsSpike = bau.units || {};
  document.getElementById(targetId).innerHTML = `
    <div class="card kpi"><label>GMV</label><div class="value">${fmtVal(totals.gmv,"rs_cr")}</div><div class="statrow">${yoyBadge(gmvYoy)}</div><div class="spikerow">${spikeBadge("CY", gmvSpike.cy)}${spikeBadge("LY", gmvSpike.ly)}</div></div>
    <div class="card kpi"><label>Units</label><div class="value">${fmtVal(totals.units,"l")}</div><div class="statrow">${yoyBadge(unitsYoy)}</div><div class="spikerow">${spikeBadge("CY", unitsSpike.cy)}${spikeBadge("LY", unitsSpike.ly)}</div></div>
    <div class="card kpi"><label>ASP</label><div class="value">${fmtVal(totals.asp,"rs")}</div><div class="statrow">${yoyBadge(aspYoy)}</div></div>
    <div class="card kpi"><label>UPI Share</label><div class="value">${pct1(ps.upi)}</div><div class="statrow">${ppBadge(ps.upi, lyPs.upi)}</div></div>
    <div class="card kpi"><label>COD Share</label><div class="value">${pct1(ps.cod)}</div><div class="statrow">${ppBadge(ps.cod, lyPs.cod)}</div></div>
    <div class="card kpi"><label>PBO Share</label><div class="value">${pct1(ps.pbo)}</div><div class="statrow">${ppBadge(ps.pbo, lyPs.pbo)}</div></div>
  `;
}

/* 3-level segment breakdown: segment → Alpha/BMP/UMP → price point.
   Level 0 = top (segment), level 1 = child (seller type), level 2 = grandchild (price point). */
function renderLiveTable(targetId, agg){
  const rows = agg.breakdown || [];
  const cell = (cy, ly, unit) => {
    const yoy = ly ? yoyPct(cy, ly) : null;
    return `<td>${fmtVal(cy, unit)}</td><td>${ly ? fmtVal(ly, unit) : "—"}</td>${yoyCell(yoy)}`;
  };

  const tbody = document.getElementById(targetId);
  let html = "";
  let rowIdx = 0;

  rows.forEach((r, pi) => {
    const parentKey = `p${pi}`;
    html += `<tr class="seg-parent" data-key="${parentKey}">
      <td><span class="seg-toggle">▸</span><b>${escapeHtml(r.label)}</b></td>
      ${cell(r.tyGmv/1e7, r.lyGmv/1e7, "rs_cr")}${spikeCell(r.cyGmvSpike)}${spikeCell(r.lyGmvSpike)}
      ${cell(r.tyUnits/1e5, r.lyUnits/1e5, "l")}${spikeCell(r.cyUnitsSpike)}${spikeCell(r.lyUnitsSpike)}
    </tr>`;

    (r.children || []).forEach((c, ci) => {
      const childKey = `${parentKey}-c${ci}`;
      html += `<tr class="seg-child seg-l1 hidden" data-parent-key="${parentKey}" data-key="${childKey}">
        <td><span class="seg-toggle">▸</span>${escapeHtml(c.label)}</td>
        ${cell(c.tyGmv/1e7, c.lyGmv/1e7, "rs_cr")}${spikeCell(c.cyGmvSpike)}${spikeCell(c.lyGmvSpike)}
        ${cell(c.tyUnits/1e5, c.lyUnits/1e5, "l")}${spikeCell(c.cyUnitsSpike)}${spikeCell(c.lyUnitsSpike)}
      </tr>`;

      (c.children || []).forEach((g, gi) => {
        html += `<tr class="seg-child seg-l2 hidden" data-parent-key="${childKey}">
          <td>${escapeHtml(g.label)}</td>
          ${cell(g.tyGmv/1e7, g.lyGmv/1e7, "gmv_auto")}${spikeCell(g.cyGmvSpike)}${spikeCell(g.lyGmvSpike)}
          ${cell(g.tyUnits/1e5, g.lyUnits/1e5, "units_auto")}${spikeCell(g.cyUnitsSpike)}${spikeCell(g.lyUnitsSpike)}
        </tr>`;
      });
    });
  });

  tbody.innerHTML = html;

  // Level-0 toggle: show/hide direct L1 children (click anywhere on row)
  tbody.querySelectorAll(".seg-parent").forEach(tr => {
    tr.addEventListener("click", e => {
      const key = tr.dataset.key;
      const toggle = tr.querySelector(".seg-toggle");
      const expanding = toggle.textContent === "▸";
      toggle.textContent = expanding ? "▾" : "▸";
      tbody.querySelectorAll(`tr[data-parent-key="${key}"]`).forEach(child => {
        child.classList.toggle("hidden", !expanding);
        // collapse L2 when L1 parent collapses
        if(!expanding) {
          child.querySelector(".seg-toggle") && (child.querySelector(".seg-toggle").textContent = "▸");
          tbody.querySelectorAll(`tr[data-parent-key="${child.dataset.key}"]`).forEach(g => g.classList.add("hidden"));
        }
      });
    });
  });

  // Level-1 toggle: show/hide L2 grandchildren (click anywhere on row)
  tbody.querySelectorAll(".seg-l1").forEach(tr => {
    tr.addEventListener("click", e => {
      const key = tr.dataset.key;
      const toggle = tr.querySelector(".seg-toggle");
      const expanding = toggle.textContent === "▸";
      toggle.textContent = expanding ? "▾" : "▸";
      tbody.querySelectorAll(`tr[data-parent-key="${key}"]`).forEach(g => g.classList.toggle("hidden", !expanding));
    });
  });
}
function yoyCell(delta){
  return `<td class="${delta===null?'':delta>=0?'up':'down'}">${delta===null?"N/A":(delta>=0?"▲":"▼")+" "+Math.abs(delta).toFixed(1)+"%"}</td>`;
}
function spikeCell(spike){
  return `<td>${spike===null||spike===undefined?"N/A":spike.toFixed(2)+"x"}</td>`;
}

/* Named breakdown (MC / SC) — expandable with price point drill-down. */
function renderNamedBreakdownTable(targetId, agg, fieldName){
  const cell = (cy, ly, unit) => {
    const yoy = ly !== null ? yoyPct(cy, ly) : null;
    return `<td>${fmtVal(cy, unit)}</td><td>${ly !== null ? fmtVal(ly, unit) : "—"}</td>${yoyCell(yoy)}`;
  };
  const lyByName = {};
  ((agg.ly && agg.ly[fieldName]) || []).forEach(s => { lyByName[s.name] = s; });
  const rows = agg[fieldName] || [];
  const tbody = document.getElementById(targetId);
  let html = "";
  rows.forEach((r, i) => {
    const ly = lyByName[r.name] || null;
    const hasPP = r.pricePoints && r.pricePoints.length > 0;
    const lyPpByName = {};
    ((ly && ly.pricePoints) || []).forEach(p => { lyPpByName[p.name] = p; });
    html += `<tr class="seg-parent" data-key="np${i}" style="cursor:${hasPP?"pointer":"default"}">
      <td>${hasPP?`<span class="seg-toggle">▸</span>`:""}${escapeHtml(r.name)}</td>
      ${cell(r.gmv/1e7, ly?ly.gmv/1e7:null,"rs_cr")}${spikeCell(r.cyGmvSpike)}${spikeCell(r.lyGmvSpike)}
      ${cell(r.units/1e5, ly?ly.units/1e5:null,"l")}${spikeCell(r.cyUnitsSpike)}${spikeCell(r.lyUnitsSpike)}
    </tr>`;
    if(hasPP){
      r.pricePoints.forEach(pp => {
        const lyPp = lyPpByName[pp.name] || null;
        html += `<tr class="seg-child seg-l1 hidden" data-parent-key="np${i}">
          <td>${escapeHtml(pp.name)}</td>
          ${cell(pp.gmv/1e7, lyPp?lyPp.gmv/1e7:null,"gmv_auto")}<td>—</td><td>—</td>
          ${cell(pp.units/1e5, lyPp?lyPp.units/1e5:null,"units_auto")}<td>—</td><td>—</td>
        </tr>`;
      });
    }
  });
  tbody.innerHTML = html;
  tbody.querySelectorAll(".seg-parent").forEach(tr => {
    if(!tr.querySelector(".seg-toggle")) return;
    tr.addEventListener("click", () => {
      const key = tr.dataset.key;
      const tog = tr.querySelector(".seg-toggle");
      const expanding = tog.textContent === "▸";
      tog.textContent = expanding ? "▾" : "▸";
      tbody.querySelectorAll(`tr[data-parent-key="${key}"]`).forEach(c => c.classList.toggle("hidden", !expanding));
    });
  });
}

/* Running total per contiguous run of real values — hours with no data yet
   (null) stay null rather than carrying the sum forward into the future. */
function toCumulative(data){
  let sum = 0;
  return data.map(v => {
    if(v === null || v === undefined) return null;
    sum += v;
    return sum;
  });
}

/* Ratio metrics (conversion rates) can't be summed like additive counts —
   "cumulative" means cumulative-numerator ÷ cumulative-denominator up to
   that hour, not a running sum of per-hour percentages. */
function ratioHourlySeries(agg, m, hourCount, mode){
  let cumNum = 0, cumDen = 0;
  return Array.from({ length: hourCount }, (_, i) => {
    const row = agg.hourly.find(h => h.hour === i);
    if(!row) return null;
    const num = row[m.num] || 0, den = row[m.den] || 0;
    if(mode === "cumulative"){
      cumNum += num; cumDen += den;
      return cumDen ? (cumNum / cumDen) * 100 : null;
    }
    return den ? (num / den) * 100 : null;
  });
}

/* Hourly trend is always plotted across the full 24h axis, TY and LY alike —
   LY is never hour-capped (it's a completed historical day either way).
   toggleId (optional) wires an Hourly/Cumulative button pair in the header. */
function wireLiveChart(selectId, chartId, agg, ly, toggleId, metricsList){
  const list = metricsList || LIVE_SALES_METRICS;
  const sel = document.getElementById(selectId);
  const toggle = toggleId ? document.getElementById(toggleId) : null;
  let mode = "hourly";
  const paintChart = () => {
    const m = list.find(x => x.key === sel.value);
    let tyData, lyData;
    if(m.type === "ratio"){
      tyData = ratioHourlySeries(agg, m, 24, mode);
      lyData = ly ? ratioHourlySeries(ly, m, 24, mode) : null;
    } else if(m.key === "asp" && mode === "cumulative"){
      // ASP cumulative = running sum(gmv) / running sum(units)
      const aspCumSeries = (source) => {
        let cumGmv = 0, cumUnits = 0;
        return Array.from({length: 24}, (_, i) => {
          const row = source.hourly.find(h => h.hour === i);
          if(!row) return null;
          cumGmv += row.gmv || 0; cumUnits += row.units || 0;
          return cumUnits ? cumGmv / cumUnits : null;
        });
      };
      tyData = aspCumSeries(agg);
      lyData = ly ? aspCumSeries(ly) : null;
    } else {
      const tyRaw = liveHourlySeries(agg, sel.value, 24, list);
      const lyRaw = ly ? liveHourlySeries(ly, sel.value, 24, list) : null;
      tyData = mode === "cumulative" ? toCumulative(tyRaw) : tyRaw;
      lyData = lyRaw ? (mode === "cumulative" ? toCumulative(lyRaw) : lyRaw) : null;
    }
    const series = [{ label: m.label + " (TY)", color: "#2563eb", data: tyData }];
    if(lyData) series.push({ label: m.label + " (LY)", color: "#39a66a", dash: [7,5], data: lyData });
    document.getElementById(chartId).innerHTML = svgLineChart(series, HOUR_LABELS, m.unit);
    attachChartHover(chartId, series, HOUR_LABELS, m.unit);
  };
  sel.onchange = paintChart;
  if(toggle){
    toggle.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => {
        if(btn.dataset.mode === mode) return;
        mode = btn.dataset.mode;
        toggle.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
        paintChart();
      });
    });
  }
  paintChart();
}

/* ---------------- KEY INSIGHTS (LLM-driven) ---------------- */
function buildInsightsPrompt(data){
  const ly = data.ly;
  const totals = liveTotals(data);
  const lyTotals = ly ? liveTotals(ly) : null;
  const gmvYoy = lyTotals ? ((totals.gmv - lyTotals.gmv) / lyTotals.gmv * 100).toFixed(1) : null;
  const unitsYoy = lyTotals ? ((totals.units - lyTotals.units) / lyTotals.units * 100).toFixed(1) : null;
  const aspYoy = lyTotals ? ((totals.asp - lyTotals.asp) / lyTotals.asp * 100).toFixed(1) : null;
  const hourStr = data.excludedHour != null ? `00:00–${String(data.excludedHour-1).padStart(2,"00")}:00` : "full day";

  const topSc = (data.superCategories || []).slice(0, 5).map(s => {
    const lySc = ((ly && ly.superCategories) || []).find(l => l.name === s.name);
    const yoy = lySc ? ((s.gmv - lySc.gmv) / lySc.gmv * 100).toFixed(1) : null;
    return `${s.name}: ₹${(s.gmv/1e7).toFixed(2)} Cr${yoy !== null ? ` (${yoy>0?"+":""}${yoy}% YoY)` : ""}`;
  }).join(", ");

  const topMc = (data.megaCategories || []).slice(0, 4).map(m => {
    const lyMc = ((ly && ly.megaCategories) || []).find(l => l.name === m.name);
    const yoy = lyMc ? ((m.gmv - lyMc.gmv) / lyMc.gmv * 100).toFixed(1) : null;
    return `${m.name}: ₹${(m.gmv/1e7).toFixed(2)} Cr${yoy !== null ? ` (${yoy>0?"+":""}${yoy}% YoY)` : ""}`;
  }).join(", ");

  const ps = data.paymentShare || {};
  const lyPs = (ly && ly.paymentShare) || {};

  return `You are a senior e-commerce analytics expert for Flipkart's ${businessLabel()} business unit during the Big Billion Days festive sale.

Current data window: ${fmtSheetDate(data.dateKey)}, ${hourStr} (${data.rowCount} data rows).

OVERALL METRICS:
- GMV: ${totals.gmv.toFixed(2)} Cr${gmvYoy !== null ? ` | YoY: ${gmvYoy > 0 ? "+" : ""}${gmvYoy}%` : ""}
- Units: ${totals.units.toFixed(2)} Lac${unitsYoy !== null ? ` | YoY: ${unitsYoy > 0 ? "+" : ""}${unitsYoy}%` : ""}
- ASP: ${totals.asp ? Math.round(totals.asp) : "N/A"}${aspYoy !== null ? ` | YoY: ${aspYoy > 0 ? "+" : ""}${aspYoy}%` : ""}
- UPI Share: ${ps.upi != null ? (ps.upi*100).toFixed(1)+"%" : "N/A"}${lyPs.upi != null ? ` (LY: ${(lyPs.upi*100).toFixed(1)}%)` : ""}
- COD Share: ${ps.cod != null ? (ps.cod*100).toFixed(1)+"%" : "N/A"}${lyPs.cod != null ? ` (LY: ${(lyPs.cod*100).toFixed(1)}%)` : ""}

TOP SUPER CATEGORIES (by GMV): ${topSc || "N/A"}
TOP MEGA CATEGORIES: ${topMc || "N/A"}

Generate exactly 4 concise, data-driven insights in JSON format. Each insight must:
- Reference specific numbers from the data
- Be actionable or diagnostic (not generic)
- Have a "type": one of "positive", "negative", "neutral", "alert"
- Have a "title" (5-8 words) and "body" (1-2 sentences, specific)

Respond ONLY with valid JSON array, no markdown, no explanation:
[{"type":"positive","title":"...","body":"..."},...]`;
}

function renderInsights(el, insights){
  const iconMap = { positive:"▲", negative:"▼", neutral:"●", alert:"⚠" };
  const colorMap = { positive:"var(--green)", negative:"var(--red)", neutral:"var(--blue)", alert:"#f59e0b" };
  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${insights.map(ins => `
        <div style="flex:1;min-width:200px;max-width:calc(25% - 8px);background:var(--surface2);border-radius:8px;padding:10px 12px;border-left:3px solid ${colorMap[ins.type]||"var(--blue)"}">
          <div style="font-size:11px;font-weight:700;color:${colorMap[ins.type]||"var(--blue)"};margin-bottom:4px;display:flex;align-items:center;gap:5px">
            <span>${iconMap[ins.type]||"●"}</span> ${escapeHtml(ins.title||"")}
          </div>
          <div style="font-size:12px;line-height:1.5;color:var(--text)">${escapeHtml(ins.body||"")}</div>
        </div>`).join("")}
    </div>`;
}

async function generateInsights(data){
  const sec = document.getElementById("liveInsightsSection");
  if(!sec) return;
  sec.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;padding:6px 0">
    <span style="animation:spin 1s linear infinite;display:inline-block">⟳</span> Generating insights…</div>`;

  const prompt = buildInsightsPrompt(data);
  try {
    const res = await fetch("/api/insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if(!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if(j.error) throw new Error(j.error);
    let insights;
    try { insights = JSON.parse(j.text); } catch(e) {
      // try to extract JSON array from text
      const m = j.text.match(/\[[\s\S]*\]/);
      insights = m ? JSON.parse(m[0]) : null;
    }
    if(!insights || !insights.length) throw new Error("No insights returned");
    renderInsights(sec, insights);
  } catch(e) {
    sec.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:4px 0">⚠ Insights unavailable: ${escapeHtml(e.message)}</div>`;
  }
}

const BREAKDOWN_FILTER_KEYS = ["marketplace", "branded", "pricePoint", "alpha"];
const BREAKDOWN_FILTER_LABELS = { marketplace: "Marketplace", branded: "Brand", pricePoint: "Price Point", alpha: "Alpha/MP" };
let BREAKDOWN_FILTERS = { marketplace: "All", branded: "All", pricePoint: "All", alpha: "All" };

function breakdownTableHtml(title, tbodyId, hourCount, rowLabel, ns){
  const hourStr = `00:00 → ${String(hourCount-1).padStart(2,"0")}:00`;
  const filterBar = BREAKDOWN_FILTER_KEYS.map(k =>
    `<select class="metric-select bdf-sel" data-fkey="${k}" id="bdf-${ns}-${k}"><option value="All">${BREAKDOWN_FILTER_LABELS[k]}: All</option></select>`
  ).join("");
  return `<div style="margin-top:10px" class="card">
    <div class="cardhead"><b>${title} BREAKDOWN — CUMULATIVE TILL HOUR</b><span class="tiny">${hourStr}</span></div>
    <div class="chipbar" style="margin-top:4px">
      <span class="cbl">Filter:</span>${filterBar}
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${rowLabel}</th><th>GMV CY</th><th>GMV LY</th><th>GMV YoY</th><th>GMV CY Spike</th><th>GMV LY Spike</th><th>Units CY</th><th>Units LY</th><th>Units YoY</th><th>Units CY Spike</th><th>Units LY Spike</th></tr></thead>
      <tbody id="${tbodyId}"></tbody>
    </table></div>
  </div>`;
}


function renderLiveSalesPage(overallData){
  const el = document.getElementById("page-live-sales");
  if(!el) return;

  const hourCount = overallData.excludedHour != null ? overallData.excludedHour : 24;
  const hoursSub = overallData.excludedHour != null
    ? `hours 00:00–${String(hourCount-1).padStart(2,"0")}:00 (current hour excluded, still in progress)`
    : `all 24 hours (completed day)`;

  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Sales</h1><div class="sub">Hourly performance, live from Google Sheet · ${fmtSheetDate(overallData.dateKey)} · ${hoursSub}</div></div>
        <span class="tag ok">${businessLabel()}</span>
      </div>

      <div class="chipbar" style="margin-top:4px">
        <span class="cbl">Day:</span>
        <select class="metric-select" id="liveDaySelect"></select>
        <span class="cbl" style="margin-left:10px">Filters:</span>
        ${LIVE_FILTER_KEYS.map(k => `<select class="metric-select" id="liveFilter-${k}"><option value="All">${LIVE_FILTER_LABELS[k]}: All</option></select>`).join("")}
        ${LIVE_FILTER_KEYS.some(k => LIVE_FILTERS[k] !== "All") ? `<div class="chip" id="liveFilterClear" style="color:var(--blue);border-color:var(--blue)">Clear filters</div>` : ""}
      </div>

      <div id="liveInsightsSection" style="margin-top:12px"></div>

      <div class="grid g6" id="liveKpiRow" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>HOURLY TREND — OVERALL</b>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="chart-mode-toggle" id="liveChartMode">
            <button class="active" data-mode="hourly">Hourly</button>
            <button data-mode="cumulative">Cumulative</button>
          </div>
          <select class="metric-select" id="liveMetricSelect">
            ${LIVE_SALES_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="chart" id="liveChart"></div>
      <div class="legend"><span><i class="dot"></i>${fmtSheetDate(overallData.dateKey)} (This Year)</span>${overallData.ly ? `<span><i class="dot ly"></i>${fmtSheetDate(overallData.ly.dateKey)} (Last Year)</span>` : ""}</div>
    </div>

    ${breakdownTableHtml("SELLER TYPE", "liveTableRows", hourCount, CURRENT_BUSINESS === "LS" ? "Apparel / Non-Apparel" : "Alpha / MP", "seg")}
    ${CURRENT_BUSINESS === "LS" ? breakdownTableHtml("MEGA CATEGORY", "liveMcTableRows", hourCount, "Mega Category", "mc") : ""}
    ${breakdownTableHtml("SUPER CATEGORY", "liveScTableRows", hourCount, "Super Category", "sc")}

  `;

  populateLiveFilterOptions();
  populateLiveDaySelect(overallData.days, overallData.selectedDay);
  const clearBtn = document.getElementById("liveFilterClear");
  if(clearBtn) clearBtn.addEventListener("click", () => {
    LIVE_FILTER_KEYS.forEach(k => LIVE_FILTERS[k] = "All");
    hydrateLiveSales();
  });

  // Overall block — rendered once, never repainted by the SC-wise section below.
  renderLiveKpiCards("liveKpiRow", overallData, overallData.ly);
  renderLiveTable("liveTableRows", overallData);
  if(CURRENT_BUSINESS === "LS") renderNamedBreakdownTable("liveMcTableRows", overallData, "megaCategories");
  renderNamedBreakdownTable("liveScTableRows", overallData, "superCategories");
  wireLiveChart("liveMetricSelect", "liveChart", overallData, overallData.ly, "liveChartMode");
  generateInsights(overallData);
}

/* ============================================================
   EVENT SUMMARY — SALES (daily trend across entire BBD event)
   Mirrors Live Sales but uses Daily_sales_2026/2025 tabs and
   shows a day-by-day trend chart instead of hourly.
   ============================================================ */
let SUMMARY_FILTERS = { marketplace: "All", branded: "All", alpha: "All", pricePoint: "All", sc: "All" };

function dailySeries(data, key){
  /* Returns [{label, value}] for the trend chart — one point per day */
  return (data.daily || []).map(d => ({
    label: fmtSheetDate(d.day),
    value: key === "gmv" ? d.gmv / 1e7 : key === "units" ? d.units / 1e5 : null,
  }));
}


function breakdownDailyTableHtml(title, tbodyId, rowLabel, ns){
  const filterBar = BREAKDOWN_FILTER_KEYS.map(k =>
    `<select class="metric-select bdf-sel" data-fkey="${k}" id="sbdf-${ns}-${k}"><option value="All">${BREAKDOWN_FILTER_LABELS[k]}: All</option></select>`
  ).join("");
  return `<div style="margin-top:10px" class="card">
    <div class="cardhead"><b>${title} BREAKDOWN — FULL EVENT</b></div>
    <div class="chipbar" style="margin-top:4px">
      <span class="cbl">Filter:</span>${filterBar}
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${rowLabel}</th><th>GMV CY</th><th>GMV LY</th><th>GMV YoY</th><th>GMV CY Spike</th><th>GMV LY Spike</th><th>Units CY</th><th>Units LY</th><th>Units YoY</th><th>Units CY Spike</th><th>Units LY Spike</th></tr></thead>
      <tbody id="${tbodyId}"></tbody>
    </table></div>
  </div>`;
}

function renderSummaryKpiCards(data){
  const totals = liveTotals(data);
  const ly = data.ly;
  const lyTotals = ly ? liveTotals(ly) : null;
  const ps = data.paymentShare || {};
  const lyPs = (ly && ly.paymentShare) || {};
  const bau = data.bauSpike || {};
  const gmvSpike = bau.gmv || {}, unitsSpike = bau.units || {};
  document.getElementById("summaryKpiRow").innerHTML = `
    <div class="card kpi"><label>GMV</label><div class="value">${fmtVal(totals.gmv,"rs_cr")}</div><div class="statrow">${yoyBadge(lyTotals ? yoyPct(totals.gmv,lyTotals.gmv) : null)}</div><div class="spikerow">${spikeBadge("CY",gmvSpike.cy)}${spikeBadge("LY",gmvSpike.ly)}</div></div>
    <div class="card kpi"><label>Units</label><div class="value">${fmtVal(totals.units,"l")}</div><div class="statrow">${yoyBadge(lyTotals ? yoyPct(totals.units,lyTotals.units) : null)}</div><div class="spikerow">${spikeBadge("CY",unitsSpike.cy)}${spikeBadge("LY",unitsSpike.ly)}</div></div>
    <div class="card kpi"><label>ASP</label><div class="value">${fmtVal(totals.asp,"rs")}</div><div class="statrow">${yoyBadge(lyTotals ? yoyPct(totals.asp,lyTotals.asp) : null)}</div></div>
    <div class="card kpi"><label>UPI Share</label><div class="value">${pct1(ps.upi)}</div><div class="statrow">${ppBadge(ps.upi,lyPs.upi)}</div></div>
    <div class="card kpi"><label>COD Share</label><div class="value">${pct1(ps.cod)}</div><div class="statrow">${ppBadge(ps.cod,lyPs.cod)}</div></div>
    <div class="card kpi"><label>PBO Share</label><div class="value">${pct1(ps.pbo)}</div><div class="statrow">${ppBadge(ps.pbo,lyPs.pbo)}</div></div>
  `;
}

function renderSummaryTables(data){
  // Seller Type breakdown (same as live: seg-parent L0, children L1, grandchildren L2)
  const segTbody = document.getElementById("summarySegRows");
  if(segTbody) renderLiveTable(segTbody.id, data);

  // SC breakdown
  const scTbody = document.getElementById("summaryScRows");
  if(scTbody) renderNamedBreakdownTable(scTbody.id, data, "superCategories");

  // MC breakdown (LS only)
  const mcTbody = document.getElementById("summaryMcRows");
  if(mcTbody && CURRENT_BUSINESS === "LS") renderNamedBreakdownTable(mcTbody.id, data, "megaCategories");
}

function renderSummaryDailyChart(data, metric, mode){
  const ty = dailySeries(data, metric);
  const ly = data.ly ? dailySeries(data.ly, metric) : null;
  const unit = metric === "gmv" ? "rs_cr" : "l";
  const labels = ty.map(p => p.label);
  const raw = arr => arr.map(p => p.value);
  const cum = arr => { let s = 0; return arr.map(p => { s += (p.value || 0); return s; }); };
  const tyData = mode === "cumulative" ? cum(ty) : raw(ty);
  const lyData = ly ? (mode === "cumulative" ? cum(ly) : raw(ly)) : null;
  const mLabel = metric === "gmv" ? "GMV" : "Units";
  const series = [{ label: `${mLabel} (TY)`, color: "#2563eb", data: tyData }];
  if(lyData) series.push({ label: `${mLabel} (LY)`, color: "#39a66a", dash: [7,5], data: lyData });
  const el = document.getElementById("summaryDailyChart");
  if(!el) return;
  el.innerHTML = `<div class="chart" id="summaryDailyChartInner" style="height:260px">${svgLineChart(series, labels, unit)}</div>`;
  attachChartHover("summaryDailyChartInner", series, labels, unit);
}

function renderSummaryFilterOptions(data){
  callBackend("getFilterOptions", [CURRENT_BUSINESS], opts => {
    if(!opts || opts.error) return;
    LIVE_FILTER_KEYS.forEach(key => {
      const sel = document.getElementById(`summaryFilter-${key}`);
      if(!sel) return;
      const values = opts[key] || [];
      sel.innerHTML = `<option value="All">${LIVE_FILTER_LABELS[key]}: All</option>` +
        values.map(v => `<option value="${escapeHtml(v)}" ${SUMMARY_FILTERS[key]===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
      sel.onchange = () => { SUMMARY_FILTERS[key] = sel.value; hydrateEventSales(); };
    });
    BREAKDOWN_FILTER_KEYS.forEach(k => {
      ["sseg","smc","ssc"].forEach(ns => {
        const sel2 = document.getElementById(`sbdf-${ns}-${k}`);
        if(!sel2) return;
        const values = opts[k] || [];
        sel2.innerHTML = `<option value="All">${BREAKDOWN_FILTER_LABELS[k]}: All</option>` +
          values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
        sel2.value = SUMMARY_FILTERS[k];
        sel2.onchange = () => { SUMMARY_FILTERS[k] = sel2.value; hydrateEventSales(); };
      });
    });
  }, () => {});
}

function renderSummaryPage(data){
  const el = document.getElementById("page-event-sales");
  if(!el) return;

  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Event Summary — Sales</h1><div class="sub">Daily performance across Big Billion Days · ${data.rowCount} data rows · Daily_sales_2026 / 2025</div></div>
        <span class="tag ok">${businessLabel()}</span>
      </div>
      <div class="chipbar" style="margin-top:4px">
        <span class="cbl">Filters:</span>
        ${LIVE_FILTER_KEYS.map(k => `<select class="metric-select" id="summaryFilter-${k}"><option value="All">${LIVE_FILTER_LABELS[k]}: All</option></select>`).join("")}
      </div>
      <div class="grid g6" id="summaryKpiRow" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>DAILY TREND — OVERALL</b>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="chart-mode-toggle" id="summaryChartMode">
            <button class="active" data-mode="daily">Daily</button>
            <button data-mode="cumulative">Cumulative</button>
          </div>
          <select class="metric-select" id="summaryMetricSelect">
            <option value="gmv">GMV</option>
            <option value="units">Units</option>
          </select>
        </div>
      </div>
      <div id="summaryDailyChart"></div>
      <div class="legend">
        <span><i class="dot"></i>This Year (2026)</span>
        ${data.ly ? `<span><i class="dot ly"></i>Last Year (2025)</span>` : ""}
      </div>
    </div>

    ${breakdownDailyTableHtml("SELLER TYPE", "summarySegRows", CURRENT_BUSINESS === "LS" ? "Apparel / Non-Apparel" : "Alpha / MP", "sseg")}
    ${CURRENT_BUSINESS === "LS" ? breakdownDailyTableHtml("MEGA CATEGORY", "summaryMcRows", "Mega Category", "smc") : ""}
    ${breakdownDailyTableHtml("SUPER CATEGORY", "summaryScRows", "Super Category", "ssc")}
  `;

  renderSummaryKpiCards(data);
  renderSummaryTables(data);
  let summaryChartMode = "daily";
  const paintSummaryChart = () => renderSummaryDailyChart(data, document.getElementById("summaryMetricSelect").value, summaryChartMode);
  paintSummaryChart();
  renderSummaryFilterOptions(data);

  document.getElementById("summaryMetricSelect").onchange = paintSummaryChart;
  document.getElementById("summaryChartMode").querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      if(btn.dataset.mode === summaryChartMode) return;
      summaryChartMode = btn.dataset.mode;
      document.getElementById("summaryChartMode").querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
      paintSummaryChart();
    });
  });
}

function renderSummaryLoading(){
  const el = document.getElementById("page-event-sales");
  if(el) el.innerHTML = `<div class="card"><div class="cardhead"><div><h1>Event Summary — Sales</h1><div class="sub">Daily performance, live from Google Sheet</div></div><span class="tag ok">${businessLabel()}</span><span class="tag warn">⏳ Connecting…</span></div><div class="callout">Loading daily sales data for ${businessLabel()}…</div></div>`;
}

function hydrateEventSales(){
  renderSummaryLoading();
  const params = new URLSearchParams({ business: CURRENT_BUSINESS, ...SUMMARY_FILTERS });
  fetch(`/api/summary-sales?${params}`)
    .then(r => r.json())
    .then(data => {
      if(!data || data.error || !data.rowCount){
        const el = document.getElementById("page-event-sales");
        if(el) el.innerHTML = `<div class="card"><div class="callout">⚠ ${escapeHtml(data && data.error ? data.error : "No daily sales data found. Add Daily_sales_2026 and Daily_sales_2025 tabs to the Sales sheet.")}</div></div>`;
        return;
      }
      renderSummaryPage(data);
    })
    .catch(e => {
      const el = document.getElementById("page-event-sales");
      if(el) el.innerHTML = `<div class="card"><div class="callout">⚠ Error: ${escapeHtml(e.message)}</div></div>`;
    });
}

/* ---------------- LIVE DATA FETCH ---------------- */
function hydrateLiveSales(){
  renderLiveSalesLoading();
  callBackend("getLiveSalesData", [CURRENT_BUSINESS, LIVE_FILTERS, LIVE_DAY], data => {
    if(!data || !data.rowCount){
      renderLiveSalesEmpty(`No live rows found for "${businessLabel()}" (mapped to "${(data && data.sheetBusinessUnit) || "?"}" in the sheet). Check BUSINESS_SHEET_MAP. Diagnostics below.`, true);
      return;
    }
    renderLiveSalesPage(data);
  }, err => {
    renderLiveSalesEmpty("⚠ Live Sheet error: " + (err && err.message ? err.message : err) + " (see server/README.md if running locally)");
  });
}

/* ---------------- LIVE FUNNEL PAGE (Live Today > Funnel — real data only) ----------------
   Same flow/layout as Live Sales (header, day selector, KPI row, hourly trend
   chart with hover+cumulative toggle, breakdown tables) — no filters (the
   source sheet has no marketplace/brand/alpha/price-point columns at this
   grain), no BAU spike (no BAU tab for Funnel), and the two breakdown tables
   only carry Visits+Orders (the top/bottom of the funnel), mirroring how
   Sales' breakdown tables carry GMV+Units. */
function renderLiveFunnelLoading(){
  const el = document.getElementById("page-live-funnel");
  if(!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Funnel</h1><div class="sub">Hourly performance, live from Google Sheet</div></div>
        <span class="tag ok">${businessLabel()}</span>
        <span class="tag warn">⏳ Connecting…</span>
      </div>
      <div class="callout">Loading live funnel data for ${businessLabel()}…</div>
    </div>`;
}

function renderLiveFunnelEmpty(message){
  const el = document.getElementById("page-live-funnel");
  if(!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Funnel</h1><div class="sub">Hourly performance, live from Google Sheet</div></div>
        <span class="tag ok">${businessLabel()}</span>
        <span class="tag bad">⚠ No data</span>
      </div>
      <div class="callout" style="white-space:pre-wrap">${escapeHtml(message)}</div>
    </div>`;
}

function populateFunnelDaySelect(days, selectedDay){
  const sel = document.getElementById("funnelDaySelect");
  if(!sel || !days || !days.length) return;
  sel.innerHTML = days.map(d => `<option value="${d.key}" ${d.key===selectedDay?"selected":""}>${d.key} (${fmtSheetDate(d.dateKey)})</option>`).join("");
  sel.onchange = () => { FUNNEL_DAY = sel.value; hydrateLiveFunnel(); };
}

function populateFunnelFilterOptions(){
  callBackend("getFunnelFilterOptions", [CURRENT_BUSINESS], opts => {
    if(!opts || opts.error) return;
    FUNNEL_FILTER_KEYS.forEach(key => {
      const sel = document.getElementById(`funnelFilter-${key}`);
      if(!sel) return;
      const values = opts[key] || [];
      sel.innerHTML = `<option value="All">${FUNNEL_FILTER_LABELS[key]}: All</option>` +
        values.map(v => `<option value="${escapeHtml(v)}" ${FUNNEL_FILTERS[key]===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
      sel.onchange = () => { FUNNEL_FILTERS[key] = sel.value; hydrateLiveFunnel(); };
    });
  }, () => { /* filter options are a nice-to-have; ignore failures silently */ });
}

function renderFunnelKpiCards(targetId, totals, lyTotals){
  const cards = FUNNEL_METRICS.map(m => {
    if(m.type === "ratio"){
      const cy = totals[m.den] ? (totals[m.num] / totals[m.den]) * 100 : null;
      const ly = lyTotals && lyTotals[m.den] ? (lyTotals[m.num] / lyTotals[m.den]) * 100 : null;
      return `<div class="card kpi"><label>${m.label}</label><div class="value">${fmtVal(cy, m.unit)}</div><div class="statrow">${ppBadge(cy !== null ? cy / 100 : null, ly !== null ? ly / 100 : null)}</div></div>`;
    }
    const cy = totals[m.key] / 1e6;
    const ly = lyTotals ? lyTotals[m.key] / 1e6 : null;
    const yoy = ly !== null ? yoyPct(cy, ly) : null;
    return `<div class="card kpi"><label>${m.label}</label><div class="value">${fmtVal(cy, m.unit)}</div><div class="statrow">${yoyBadge(yoy)}</div></div>`;
  });
  const wrap = document.getElementById(targetId);
  wrap.innerHTML = `<div class="grid" style="grid-template-columns:repeat(9,minmax(0,1fr));gap:10px">${cards.join("")}</div>`;
}

/* Funnel table columns — mirrors KPI cards exactly:
   abs = Mn value + YoY%   |   ratio = derived % + YoY in bps */
const FUNNEL_TABLE_COLS = [
  { label: "Visits",              type: "abs",   pick: t => t.visits / 1e6 },
  { label: "PPV",                 type: "abs",   pick: t => t.ppv   / 1e6 },
  { label: "Visits w/ PPV %",     type: "ratio", num: "ppvVisits", den: "visits" },
  { label: "PPV→CABN %",          type: "ratio", num: "cabn",      den: "ppvVisits" },
  { label: "CABN→Checkout %",     type: "ratio", num: "checkout",  den: "cabn" },
  { label: "Checkout→Summary %",  type: "ratio", num: "summary",   den: "checkout" },
  { label: "Summary→Payment %",   type: "ratio", num: "payment",   den: "summary" },
  { label: "P2O %",               type: "ratio", num: "orders",    den: "payment" },
  { label: "O/V %",               type: "ratio", num: "orders",    den: "visits" },
];

function funnelTableHtml(title, tbodyId, hourCount, rowLabel, callout){
  const hourStr = `00:00 → ${String(hourCount-1).padStart(2,"0")}:00`;
  const cols = FUNNEL_TABLE_COLS.flatMap(c =>
    c.type === "abs"
      ? [`<th>${c.label} (Mn)</th>`, `<th>${c.label} YoY</th>`]
      : [`<th>${c.label}</th>`,      `<th>YoY (bps)</th>`]
  ).join("");
  return `<div style="margin-top:10px" class="card">
    <div class="cardhead"><b>${title} BREAKDOWN — CUMULATIVE TILL HOUR</b><span class="tiny">${hourStr}</span></div>
    ${callout ? `<div class="callout" style="margin:6px 0 4px;font-size:11px;color:var(--muted)">⚠ ${callout}</div>` : ""}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${rowLabel}</th>${cols}</tr></thead>
      <tbody id="${tbodyId}"></tbody>
    </table></div>
  </div>`;
}

function renderFunnelFullTable(targetId, rows){
  const ratio = (t, num, den) => t[den] ? t[num] / t[den] * 100 : null;
  const absCell = (cyMn, lyMn) => {
    const yoy = lyMn ? yoyPct(cyMn, lyMn) : null;
    return `<td>${cyMn.toFixed(2)} Mn</td>${yoyCell(yoy)}`;
  };
  const ratioCell = (cyPct, lyPct) => {
    const bps = (cyPct !== null && lyPct !== null) ? Math.round((cyPct - lyPct) * 100) : null;
    const cls = bps === null ? "" : bps >= 0 ? "up" : "down";
    return `<td>${cyPct === null ? "N/A" : cyPct.toFixed(2)+"%"}</td>` +
           `<td class="${cls}">${bps === null ? "N/A" : (bps>=0?"+":"")+bps+" bps"}</td>`;
  };
  const tbody = document.getElementById(targetId);
  if(!tbody) return;
  tbody.innerHTML = rows.map(r => {
    const t = r.ty, l = r.ly;
    const cells = FUNNEL_TABLE_COLS.map(c => {
      if(c.type === "abs"){
        return absCell(c.pick(t), l ? c.pick(l) : null);
      }
      return ratioCell(ratio(t, c.num, c.den), l ? ratio(l, c.num, c.den) : null);
    }).join("");
    return `<tr><td>${escapeHtml(r.label)}</td>${cells}</tr>`;
  }).join("");
}

function renderLiveFunnelPage(data){
  const el = document.getElementById("page-live-funnel");
  if(!el) return;

  const hourCount = data.excludedHour != null ? data.excludedHour : 24;
  const hoursSub = data.excludedHour != null
    ? `hours 00:00–${String(hourCount-1).padStart(2,"0")}:00 (current hour excluded, still in progress)`
    : `all 24 hours (completed day)`;

  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Funnel</h1><div class="sub">Hourly performance, live from Google Sheet · ${fmtSheetDate(data.dateKey)} · ${hoursSub}</div></div>
        <span class="tag ok">${businessLabel()}</span>
      </div>

      <div class="chipbar" style="margin-top:4px">
        <span class="cbl">Day:</span>
        <select class="metric-select" id="funnelDaySelect"></select>
        <span class="cbl" style="margin-left:10px">Filters:</span>
        ${FUNNEL_FILTER_KEYS.map(k => `<select class="metric-select" id="funnelFilter-${k}"><option value="All">${FUNNEL_FILTER_LABELS[k]}: All</option></select>`).join("")}
        ${FUNNEL_FILTER_KEYS.some(k => FUNNEL_FILTERS[k] !== "All") ? `<div class="chip" id="funnelFilterClear" style="color:var(--blue);border-color:var(--blue)">Clear filters</div>` : ""}
      </div>

      <div id="funnelKpiRow" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>HOURLY TREND — OVERALL</b>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="metric-select" id="funnelMetricSelect">
            ${FUNNEL_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="chart" id="funnelChart"></div>
      <div class="legend"><span><i class="dot"></i>${fmtSheetDate(data.dateKey)} (This Year)</span>${data.ly ? `<span><i class="dot ly"></i>${fmtSheetDate(data.ly.dateKey)} (Last Year)</span>` : ""}</div>
    </div>

    ${funnelTableHtml("SEGMENT", "funnelSegmentRows", hourCount, "Segment", "")}
    ${funnelTableHtml("SUPER CATEGORY", "funnelScRows", hourCount, "Super Category", "")}
  `;

  populateFunnelDaySelect(data.days, data.selectedDay);
  populateFunnelFilterOptions();
  const clearBtn = document.getElementById("funnelFilterClear");
  if(clearBtn) clearBtn.addEventListener("click", () => {
    FUNNEL_FILTER_KEYS.forEach(k => FUNNEL_FILTERS[k] = "All");
    hydrateLiveFunnel();
  });
  renderFunnelKpiCards("funnelKpiRow", data.totals, data.ly ? data.ly.totals : null);
  renderFunnelFullTable("funnelSegmentRows", (data.segments || []).map(s => ({ label: s.label, ty: s.ty, ly: s.ly })));
  renderFunnelFullTable("funnelScRows", (data.superCategories || []).map(sc => ({ label: sc.name, ty: sc, ly: sc.ly || null })));
  wireLiveChart("funnelMetricSelect", "funnelChart", data, data.ly, null, FUNNEL_METRICS);
}

function hydrateLiveFunnel(){
  renderLiveFunnelLoading();
  callBackend("getFunnelData", [CURRENT_BUSINESS, FUNNEL_DAY, FUNNEL_FILTERS], data => {
    if(!data || !data.rowCount){
      renderLiveFunnelEmpty(`No funnel rows found for "${businessLabel()}" (mapped to "${(data && data.sheetBusinessUnit) || "?"}" in the sheet).`);
      return;
    }
    renderLiveFunnelPage(data);
  }, err => {
    renderLiveFunnelEmpty("⚠ Live Funnel Sheet error: " + (err && err.message ? err.message : err));
  });
}

/* ---------------- EVENT SUMMARY FUNNEL PAGE (Event Summary > Funnel) ---------------- */
function funnelDailyTableHtml(title, tbodyId, rowLabel){
  const cols = FUNNEL_TABLE_COLS.flatMap(c =>
    c.type === "abs"
      ? [`<th>${c.label} (Mn)</th>`, `<th>${c.label} YoY</th>`]
      : [`<th>${c.label}</th>`,      `<th>YoY (bps)</th>`]
  ).join("");
  return `<div style="margin-top:10px" class="card">
    <div class="cardhead"><b>${title} BREAKDOWN — FULL EVENT</b></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${rowLabel}</th>${cols}</tr></thead>
      <tbody id="${tbodyId}"></tbody>
    </table></div>
  </div>`;
}

let SUMMARY_FUNNEL_FILTERS = { alpha: "All", sc: "All" };
let SUMMARY_FUNNEL_DAY = "All";

function renderSummaryFunnelLoading(){
  const el = document.getElementById("page-event-funnel");
  if(!el) return;
  el.innerHTML = `<div class="card"><div class="cardhead"><div><h1>Event Summary — Funnel</h1><div class="sub">Daily cumulative · Big Billion Days 2026</div></div><span class="tag ok">${businessLabel()}</span><span class="tag warn">⏳ Connecting…</span></div><div class="callout">Loading event funnel data for ${businessLabel()}…</div></div>`;
}

function renderSummaryFunnelEmpty(message){
  const el = document.getElementById("page-event-funnel");
  if(!el) return;
  el.innerHTML = `<div class="card"><div class="cardhead"><div><h1>Event Summary — Funnel</h1><div class="sub">Daily cumulative · Big Billion Days 2026</div></div><span class="tag ok">${businessLabel()}</span><span class="tag bad">⚠ No data</span></div><div class="callout" style="white-space:pre-wrap">${escapeHtml(message)}</div></div>`;
}

function populateSummaryFunnelFilterOptions(data){
  // SC filter options derived from superCategories in the data
  const scNames = (data.superCategories || []).map(r => r.name);
  FUNNEL_FILTER_KEYS.forEach(key => {
    const sel = document.getElementById(`sfunnelFilter-${key}`);
    if(!sel) return;
    let values = [];
    if(key === "alpha") values = ["Alpha", "MP"];
    if(key === "sc") values = scNames;
    sel.innerHTML = `<option value="All">${FUNNEL_FILTER_LABELS[key]}: All</option>` +
      values.map(v => `<option value="${escapeHtml(v)}" ${SUMMARY_FUNNEL_FILTERS[key]===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
    sel.onchange = () => { SUMMARY_FUNNEL_FILTERS[key] = sel.value; hydrateSummaryFunnelTables(); };
  });
}

function renderSummaryFunnelDailyChart(data, metricKey){
  const m = FUNNEL_METRICS.find(x => x.key === metricKey) || FUNNEL_METRICS[0];
  const cy = (data.daily || []);
  const ly = (data.ly_daily || []);
  const labels = cy.map(d => fmtSheetDate(parseInt(d.dateIso.replace(/-/g,""),10)));

  function pick(rows){
    if(m.type === "ratio"){
      return rows.map(d => d[m.den] ? (d[m.num] / d[m.den]) * 100 : null);
    }
    return rows.map(d => (d[m.key] || 0) / 1e6);
  }

  const tyData = pick(cy);
  const series = [{ label: `${m.label} (TY)`, color: "#2563eb", data: tyData }];
  if(ly.length){
    const lyLabels = ly.map(d => fmtSheetDate(parseInt(d.dateIso.replace(/-/g,""),10)));
    // Align LY to same index positions as CY
    const lyData = labels.map((_, i) => ly[i] ? pick([ly[i]])[0] : null);
    series.push({ label: `${m.label} (LY)`, color: "#39a66a", dash: [7,5], data: lyData });
  }
  const unit = m.type === "ratio" ? "pct" : "m";
  const el = document.getElementById("sfunnelDailyChart");
  if(!el) return;
  el.innerHTML = `<div class="chart" id="sfunnelDailyChartInner" style="height:260px">${svgLineChart(series, labels, unit)}</div>`;
  attachChartHover("sfunnelDailyChartInner", series, labels, unit);
}

function renderSummaryFunnelPage(data){
  const el = document.getElementById("page-event-funnel");
  if(!el) return;

  const dayOptions = (data.days||[]).map(d => {
    const s = String(d.dateKey);
    const label = `${s.slice(6,8)} ${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+s.slice(4,6)]}`;
    return `<option value="${d.dateKey}" ${SUMMARY_FUNNEL_DAY===String(d.dateKey)?"selected":""}>${label}</option>`;
  }).join("");

  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Event Summary — Funnel</h1><div class="sub">Daily cumulative · Big Billion Days 2026 · ${data.rowCount} data rows</div></div>
        <span class="tag ok">${businessLabel()}</span>
      </div>
      <div id="sfunnelKpiRow" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>DAILY TREND — OVERALL</b>
        <select class="metric-select" id="sfunnelMetricSelect">
          ${FUNNEL_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join("")}
        </select>
      </div>
      <div id="sfunnelDailyChart"></div>
      <div class="legend">
        <span><i class="dot"></i>This Year (2026)</span>
        ${(data.ly_daily && data.ly_daily.length) ? `<span><i class="dot ly"></i>Last Year (2025)</span>` : ""}
      </div>
    </div>

    ${funnelDailyTableHtml("SEGMENT", "sfunnelSegmentRows", "Segment")}

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>SUPER CATEGORY BREAKDOWN — <span id="sfunnelScTitle">${SUMMARY_FUNNEL_DAY === "All" ? "FULL EVENT" : "DAY: "+SUMMARY_FUNNEL_DAY}</span></b>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="cbl">Day:</span>
          <select class="metric-select" id="sfunnelDaySelect">
            <option value="All">All Days</option>
            ${dayOptions}
          </select>
        </div>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Super Category</th>${FUNNEL_TABLE_COLS.flatMap(c => c.type==="abs" ? [`<th>${c.label} (Mn)</th>`,`<th>${c.label} YoY</th>`] : [`<th>${c.label}</th>`,`<th>YoY (bps)</th>`]).join("")}</tr></thead>
        <tbody id="sfunnelScRows"></tbody>
      </table></div>
    </div>
  `;

  const daySelect = document.getElementById("sfunnelDaySelect");
  if(daySelect) daySelect.onchange = e => { SUMMARY_FUNNEL_DAY = e.target.value; hydrateSummaryFunnelTables(); };

  renderFunnelKpiCards("sfunnelKpiRow", data.totals, data.ly ? data.ly.totals : null);
  renderFunnelFullTable("sfunnelSegmentRows", (data.segments || []).map(s => ({ label: s.label, ty: s.ty, ly: s.ly })));
  renderFunnelFullTable("sfunnelScRows", (data.superCategories || []).map(sc => ({ label: sc.name, ty: sc, ly: sc.ly || null })));

  let sfunnelMetric = "visits";
  const paintChart = () => renderSummaryFunnelDailyChart(data, sfunnelMetric);
  paintChart();
  document.getElementById("sfunnelMetricSelect").onchange = e => { sfunnelMetric = e.target.value; paintChart(); };

}

function hydrateSummaryFunnelTables(){
  // Re-fetches only breakdown tables using current day + filter state; KPI/trend unchanged
  ["sfunnelSegmentRows","sfunnelScRows"].forEach(id => {
    const el = document.getElementById(id); if(el) el.innerHTML = `<tr><td colspan="99" style="color:var(--muted);text-align:center;padding:12px">Loading…</td></tr>`;
  });
  const params = new URLSearchParams({ business: CURRENT_BUSINESS, ...SUMMARY_FUNNEL_FILTERS, day: SUMMARY_FUNNEL_DAY });
  fetch(`/api/summary-funnel-data?${params}`)
    .then(r => r.json())
    .then(data => {
      renderFunnelFullTable("sfunnelSegmentRows", (data.segments||[]).map(s => ({ label: s.label, ty: s.ty, ly: s.ly })));
      renderFunnelFullTable("sfunnelScRows", (data.superCategories||[]).map(sc => ({ label: sc.name, ty: sc, ly: sc.ly||null })));
      const titleEl = document.getElementById("sfunnelScTitle");
      if(titleEl) titleEl.textContent = SUMMARY_FUNNEL_DAY === "All" ? "FULL EVENT" : "DAY: " + SUMMARY_FUNNEL_DAY;
    })
    .catch(() => {});
}

function hydrateSummaryFunnel(){
  renderSummaryFunnelLoading();
  const params = new URLSearchParams({ business: CURRENT_BUSINESS, ...SUMMARY_FUNNEL_FILTERS, day: "All" });
  fetch(`/api/summary-funnel-data?${params}`)
    .then(r => r.json())
    .then(data => {
      if(!data || data.error || !data.rowCount){
        renderSummaryFunnelEmpty(`⚠ ${escapeHtml(data && data.error ? data.error : "No daily funnel data found. Check FUNNEL_DAILY_BU_CY_TAB exists in the sheet.")}`);
        return;
      }
      renderSummaryFunnelPage(data);
    })
    .catch(e => renderSummaryFunnelEmpty("⚠ Error: " + escapeHtml(e.message)));
}

/* ---------------- EVENT SUMMARY TRAFFIC PAGE ---------------- */
let SUMMARY_TRAFFIC_DAY = "All";

function renderSummaryTrafficLoading(){
  const el = document.getElementById("page-event-traffic");
  if(el) el.innerHTML = `<div class="card"><div class="cardhead"><h1>Event Summary — Traffic</h1></div><div style="padding:40px;text-align:center;color:var(--muted)">Loading…</div></div>`;
}

function renderSummaryTrafficEmpty(msg){
  const el = document.getElementById("page-event-traffic");
  if(el) el.innerHTML = `<div class="card"><div style="padding:40px;text-align:center;color:var(--muted)">${msg}</div></div>`;
}

function renderSummaryTrafficDailyChart(data, metricKey){
  const m = TRAFFIC_KPI_METRICS.find(x => x.key === metricKey) || TRAFFIC_KPI_METRICS[0];
  const cyDays = data.daily || [];
  const lyDays = data.ly_daily || [];
  const labels = cyDays.map(d => fmtSheetDate(parseInt(d.dateIso.replace(/-/g,""), 10)));
  const cyVals = cyDays.map(d => (d[m.key] || 0) / 1e6);
  const series = [{ label: `${m.label} (TY)`, color: "#2563eb", data: cyVals }];
  if(lyDays.length){
    const lyVals = labels.map((_, i) => lyDays[i] ? (lyDays[i][m.key] || 0) / 1e6 : null);
    series.push({ label: `${m.label} (LY)`, color: "#39a66a", dash: [7,5], data: lyVals });
  }
  const el = document.getElementById("strafficDailyChart");
  if(!el) return;
  el.innerHTML = `<div class="chart" id="strafficDailyChartInner" style="height:260px">${svgLineChart(series, labels, "m")}</div>`;
  attachChartHover("strafficDailyChartInner", series, labels, "m");
}

function renderSummaryTrafficPage(data){
  const el = document.getElementById("page-event-traffic");
  if(!el) return;

  const dayOptions = (data.days||[]).map(d => {
    const s = String(d.dateKey);
    const label = `${s.slice(6,8)} ${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+s.slice(4,6)]}`;
    return `<option value="${d.dateKey}" ${SUMMARY_TRAFFIC_DAY===String(d.dateKey)?"selected":""}>${label}</option>`;
  }).join("");

  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Event Summary — Traffic</h1><div class="sub">Daily cumulative · Big Billion Days 2026 · ${data.rowCount} days</div></div>
        <span class="tag ok">${businessLabel()}</span>
      </div>
      <div class="grid g6" id="strafficKpiRow" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>DAILY TREND — OVERALL</b>
        <select class="metric-select" id="strafficMetricSelect">
          ${TRAFFIC_KPI_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join("")}
        </select>
      </div>
      <div id="strafficDailyChart"></div>
      <div class="legend">
        <span><i class="dot"></i>This Year (2026)</span>
        ${(data.ly_daily && data.ly_daily.length) ? `<span><i class="dot ly"></i>Last Year (2025)</span>` : ""}
      </div>
    </div>

    ${trafficTableHtml("SEGMENT BREAKDOWN — FULL EVENT", "strafficSegmentRows", "")}

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>SUPER CATEGORY BREAKDOWN — <span id="strafficScTitle">${SUMMARY_TRAFFIC_DAY === "All" ? "FULL EVENT" : "DAY: "+SUMMARY_TRAFFIC_DAY}</span></b>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="cbl">Day:</span>
          <select class="metric-select" id="strafficDaySelect">
            <option value="All">All Days</option>
            ${dayOptions}
          </select>
        </div>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Super Category</th>${TRAFFIC_TABLE_COLS.map(c => `<th>${c.label} (Mn)</th><th>YoY%</th>`).join("")}</tr></thead>
        <tbody id="strafficScRows"></tbody>
      </table></div>
    </div>
  `;

  const daySelect = document.getElementById("strafficDaySelect");
  if(daySelect) daySelect.onchange = e => { SUMMARY_TRAFFIC_DAY = e.target.value; hydrateSummaryTrafficTables(); };

  renderTrafficKpiCards("strafficKpiRow", data.totals, data.ly ? data.ly.totals : null);
  renderTrafficFullTable("strafficSegmentRows", data.segments || [], "Segment");
  renderTrafficFullTable("strafficScRows", (data.superCategories||[]).map(r => ({label: r.name, ty: r, ly: r.ly})), "Super Category");

  let strafficMetric = "visits";
  const paintChart = () => renderSummaryTrafficDailyChart(data, strafficMetric);
  paintChart();
  document.getElementById("strafficMetricSelect").onchange = e => { strafficMetric = e.target.value; paintChart(); };
}

function hydrateSummaryTrafficTables(){
  ["strafficSegmentRows","strafficScRows"].forEach(id => {
    const el = document.getElementById(id); if(el) el.innerHTML = `<tr><td colspan="99" style="color:var(--muted);text-align:center;padding:12px">Loading…</td></tr>`;
  });
  const params = new URLSearchParams({ business: CURRENT_BUSINESS, day: SUMMARY_TRAFFIC_DAY });
  fetch(`/api/summary-traffic-data?${params}`)
    .then(r => r.json())
    .then(data => {
      renderTrafficFullTable("strafficSegmentRows", data.segments || [], "Segment");
      renderTrafficFullTable("strafficScRows", (data.superCategories||[]).map(r => ({label: r.name, ty: r, ly: r.ly})), "Super Category");
      const titleEl = document.getElementById("strafficScTitle");
      if(titleEl) titleEl.textContent = SUMMARY_TRAFFIC_DAY === "All" ? "FULL EVENT" : "DAY: " + SUMMARY_TRAFFIC_DAY;
    })
    .catch(() => {});
}

function hydrateSummaryTraffic(){
  renderSummaryTrafficLoading();
  fetch(`/api/summary-traffic-data?${new URLSearchParams({ business: CURRENT_BUSINESS, day: "All" })}`)
    .then(r => r.json())
    .then(data => {
      if(!data || data.error || !data.rowCount){
        renderSummaryTrafficEmpty(`⚠ ${escapeHtml(data && data.error ? data.error : "No daily traffic data found.")}`);
        return;
      }
      renderSummaryTrafficPage(data);
    })
    .catch(e => renderSummaryTrafficEmpty("⚠ Error: " + escapeHtml(e.message)));
}

/* ---------------- LIVE TRAFFIC PAGE (Live Today > Traffic — CY only, LY coming later) ---------------- */
function renderLiveTrafficLoading(){
  const el = document.getElementById("page-live-traffic");
  if(!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Traffic</h1><div class="sub">Hourly performance, live from Google Sheet</div></div>
        <span class="tag ok">${businessLabel()}</span>
        <span class="tag warn">⏳ Connecting…</span>
      </div>
      <div class="callout">Loading live traffic data for ${businessLabel()}…</div>
    </div>`;
}

function renderLiveTrafficEmpty(message){
  const el = document.getElementById("page-live-traffic");
  if(!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Traffic</h1><div class="sub">Hourly performance, live from Google Sheet</div></div>
        <span class="tag ok">${businessLabel()}</span>
        <span class="tag bad">⚠ No data</span>
      </div>
      <div class="callout" style="white-space:pre-wrap">${escapeHtml(message)}</div>
    </div>`;
}

function populateTrafficDaySelect(days, selectedDay){
  const sel = document.getElementById("trafficDaySelect");
  if(!sel || !days || !days.length) return;
  sel.innerHTML = days.map(d => `<option value="${d.key}" ${d.key===selectedDay?"selected":""}>${d.key} (${fmtSheetDate(d.dateKey)})</option>`).join("");
  sel.onchange = () => { TRAFFIC_DAY = sel.value; hydrateLiveTraffic(); };
}

function populateTrafficFilterOptions(){
  callBackend("getTrafficFilterOptions", [CURRENT_BUSINESS], opts => {
    if(!opts || opts.error) return;
    TRAFFIC_FILTER_KEYS.forEach(key => {
      const sel = document.getElementById(`trafficFilter-${key}`);
      if(!sel) return;
      const values = opts[key] || [];
      sel.innerHTML = `<option value="All">${TRAFFIC_FILTER_LABELS[key]}: All</option>` +
        values.map(v => `<option value="${escapeHtml(v)}" ${TRAFFIC_FILTERS[key]===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
      sel.onchange = () => { TRAFFIC_FILTERS[key] = sel.value; hydrateLiveTraffic(); };
    });
  }, () => {});
}

function renderTrafficKpiCards(targetId, totals, lyTotals){
  document.getElementById(targetId).innerHTML = TRAFFIC_KPI_METRICS.map(m => {
    const cy = (totals[m.key] || 0) / 1e6;
    const ly = lyTotals ? (lyTotals[m.key] || 0) / 1e6 : null;
    const yoy = ly !== null ? yoyPct(cy, ly) : null;
    return `<div class="card kpi"><label>${m.label}</label><div class="value">${fmtVal(cy, m.unit)}</div><div class="statrow">${yoyBadge(yoy)}</div></div>`;
  }).join("");
}

const TRAFFIC_TABLE_COLS = [
  { label: "Visits",      key: "visits"   },
  { label: "Direct",      key: "direct"   },
  { label: "Indirect",    key: "indirect" },
  { label: "Search",      key: "search"   },
  { label: "Merch",       key: "merch"    },
  { label: "Reco",        key: "reco"     },
  { label: "CRM",         key: "crm"      },
  { label: "Perf",        key: "perf"     },
  { label: "Reco HP",     key: "reco_hp"  },
  { label: "Reco PP",     key: "reco_pp"  },
  { label: "WLM",         key: "wlm"      },
  { label: "Infinite",    key: "infinite" },
];

function renderTrafficFullTable(targetId, rows, nameLabel){
  const el = document.getElementById(targetId);
  if(!el) return;
  const colSpan = 1 + TRAFFIC_TABLE_COLS.length * 2;
  if(!rows || !rows.length){
    el.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center;color:var(--muted)">No data</td></tr>`;
    return;
  }
  el.innerHTML = rows.map(r => {
    const cy = r.ty || r;
    const ly = r.ly || null;
    const cells = TRAFFIC_TABLE_COLS.map(c => {
      const cyV = (cy[c.key] || 0) / 1e6;
      const lyV = ly ? (ly[c.key] || 0) / 1e6 : null;
      const yoy = lyV !== null ? yoyPct(cyV, lyV) : null;
      const cls = yoy === null ? "" : yoy >= 0 ? "up" : "down";
      return `<td>${cyV.toFixed(2)} Mn</td><td class="${cls}">${yoy === null ? "—" : (yoy >= 0 ? "+" : "") + yoy.toFixed(1) + "%"}</td>`;
    }).join("");
    const name = r.label || r.name || "—";
    return `<tr><td>${escapeHtml(name)}</td>${cells}</tr>`;
  }).join("");
}

function trafficTableHtml(title, tbodyId, subtitle){
  const headerCols = TRAFFIC_TABLE_COLS.map(c => `<th>${c.label} (Mn)</th><th>YoY%</th>`).join("");
  return `
    <div style="margin-top:10px" class="card">
      <div class="cardhead"><b>${title}</b><span class="tiny">${subtitle||""}</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th>${headerCols}</tr></thead>
        <tbody id="${tbodyId}"></tbody>
      </table></div>
    </div>`;
}

function renderLiveTrafficPage(data){
  const el = document.getElementById("page-live-traffic");
  if(!el) return;

  const hourCount = data.excludedHour != null ? data.excludedHour : 24;
  const hoursSub  = data.excludedHour != null
    ? `hours 00:00–${String(hourCount-1).padStart(2,"00")}:00 (current hour excluded)`
    : `all 24 hours (completed day)`;

  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — Traffic</h1><div class="sub">Hourly performance · ${fmtSheetDate(data.dateKey)} · ${hoursSub}</div></div>
        <span class="tag ok">${businessLabel()}</span>
      </div>

      <div class="chipbar" style="margin-top:4px">
        <span class="cbl">Day:</span>
        <select class="metric-select" id="trafficDaySelect"></select>
        <span class="cbl" style="margin-left:10px">Filters:</span>
        ${TRAFFIC_FILTER_KEYS.map(k => `<select class="metric-select" id="trafficFilter-${k}"><option value="All">${TRAFFIC_FILTER_LABELS[k]}: All</option></select>`).join("")}
        ${TRAFFIC_FILTER_KEYS.some(k => TRAFFIC_FILTERS[k] !== "All") ? `<div class="chip" id="trafficFilterClear" style="color:var(--blue);border-color:var(--blue)">Clear filters</div>` : ""}
      </div>

      <div class="grid g6" id="trafficKpiRow" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>HOURLY TREND</b>
        <select class="metric-select" id="trafficMetricSelect">
          ${TRAFFIC_CHART_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join("")}
        </select>
      </div>
      <div class="chart" id="trafficChart"></div>
      <div class="legend"><span><i class="dot"></i>${fmtSheetDate(data.dateKey)} (This Year)</span>${data.ly ? `<span><i class="dot ly"></i>${fmtSheetDate(data.ly.dateKey)} (Last Year)</span>` : ""}</div>
    </div>

    ${trafficTableHtml("SEGMENT BREAKDOWN", "trafficSegmentRows", `00:00 → ${String(hourCount-1).padStart(2,"00")}:00`)}
    ${trafficTableHtml("SUPER CATEGORY BREAKDOWN", "trafficScRows", `00:00 → ${String(hourCount-1).padStart(2,"00")}:00`)}
  `;

  populateTrafficDaySelect(data.days, data.selectedDay);
  populateTrafficFilterOptions();
  const clearBtn = document.getElementById("trafficFilterClear");
  if(clearBtn) clearBtn.addEventListener("click", () => {
    TRAFFIC_FILTER_KEYS.forEach(k => TRAFFIC_FILTERS[k] = "All");
    hydrateLiveTraffic();
  });

  const lyTotals = data.ly ? data.ly.totals : null;
  renderTrafficKpiCards("trafficKpiRow", data.totals, lyTotals);
  renderTrafficFullTable("trafficSegmentRows", data.segments || [], "Segment");
  renderTrafficFullTable("trafficScRows", (data.superCategories || []).map(r => ({label: r.name, ty: r, ly: r.ly})), "Super Category");
  wireLiveChart("trafficMetricSelect", "trafficChart", data, data.ly || null, null, TRAFFIC_CHART_METRICS);
}

function hydrateLiveTraffic(){
  renderLiveTrafficLoading();
  callBackend("getTrafficData", [CURRENT_BUSINESS, TRAFFIC_DAY, TRAFFIC_FILTERS], data => {
    if(!data || !data.rowCount){
      renderLiveTrafficEmpty(`No traffic rows found for "${businessLabel()}" (mapped to "${(data && data.sheetBusinessUnit) || "?"}" in the sheet).`);
      return;
    }
    renderLiveTrafficPage(data);
  }, err => {
    renderLiveTrafficEmpty("⚠ Live Traffic Sheet error: " + (err && err.message ? err.message : err));
  });
}

/* ---------------- CVP INPUTS PAGE (Live Today > CVP Inputs) ---------------- */
const CVP_PAGE_ID = "live-inputs";
let CVP_FILTERS = { sc: "All" };

const CVP_CHART_METRICS = [
  { key: "outputPriceDrop", label: "Output Price Drop", unit: "pct", type: "raw", pick: h => h.outputPriceDrop != null ? h.outputPriceDrop * 100 : null },
  { key: "inputPriceDrop",  label: "Input Price Drop",  unit: "pct", type: "raw", pick: h => h.inputPriceDrop  != null ? h.inputPriceDrop  * 100 : null },
  { key: "nsPct",  label: "NS%",  unit: "pct", type: "raw", pick: h => h.nsPct  != null ? h.nsPct  * 100 : null },
  { key: "nbPct",  label: "NB%",  unit: "pct", type: "raw", pick: h => h.nbPct  != null ? h.nbPct  * 100 : null },
  { key: "oosPct", label: "OOS%", unit: "pct", type: "raw", pick: h => h.oosPct != null ? h.oosPct * 100 : null },
];

function cvpDropCard(label, cyVal, lyVal){
  const fmt  = v => v != null ? (v * 100).toFixed(2) + "%" : "N/A";
  const delta = (cyVal != null && lyVal != null) ? (cyVal - lyVal) * 100 : null;
  // for price drop: smaller (more negative) = better = "up" green
  const cls   = delta === null ? "" : delta <= 0 ? "up" : "down";
  const badge = delta === null ? "" :
    `<span class="stat ${cls}">${delta <= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(2)}pp YoY</span>`;
  return `<div class="card kpi"><label>${label}</label><div class="value">${fmt(cyVal)}</div><div class="sub" style="margin-top:2px">LY: ${fmt(lyVal)}</div><div class="statrow">${badge}</div></div>`;
}

function nbMetricCard(label, val, goodDir="down"){
  const fmt = v => v != null ? (v * 100).toFixed(2) + "%" : "N/A";
  return `<div class="card kpi"><label>${label}</label><div class="value">${fmt(val)}</div></div>`;
}

function populateCvpFilterOptions(opts){
  const scSel = document.getElementById("cvpFilter-sc");
  if(!scSel) return;
  const scs = (opts && opts.sc) || [];
  scSel.innerHTML = `<option value="All">Super Category: All</option>` +
    scs.map(v => `<option value="${escapeHtml(v)}" ${CVP_FILTERS.sc===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
  scSel.onchange = () => { CVP_FILTERS.sc = scSel.value; hydrateCvp(); };
}

function renderCvpScTable(targetId, rows){
  document.getElementById(targetId).innerHTML = rows.map(r => {
    const ly = r.ly || null;
    const nb = r.nb || null;
    const opDelta = (r.outputPriceDrop != null && ly && ly.outputPriceDrop != null) ? (r.outputPriceDrop - ly.outputPriceDrop) * 100 : null;
    const ipDelta = (r.inputPriceDrop  != null && ly && ly.inputPriceDrop  != null) ? (r.inputPriceDrop  - ly.inputPriceDrop)  * 100 : null;
    const ppCell = (cy, lyv, delta) => {
      const cls = delta === null ? "" : delta <= 0 ? "up" : "down";
      return `<td>${cy != null ? (cy*100).toFixed(2)+"%" : "N/A"}</td><td>${lyv != null ? (lyv*100).toFixed(2)+"%" : "—"}</td><td class="${cls}">${delta === null ? "N/A" : (delta<=0?"▲":"▼")+" "+Math.abs(delta).toFixed(2)+"pp"}</td>`;
    };
    const pctCell = v => `<td>${v != null ? (v*100).toFixed(2)+"%" : "—"}</td>`;
    return `<tr><td>${escapeHtml(r.name)}</td>
      ${ppCell(r.outputPriceDrop, ly ? ly.outputPriceDrop : null, opDelta)}
      ${ppCell(r.inputPriceDrop,  ly ? ly.inputPriceDrop  : null, ipDelta)}
      ${pctCell(nb ? nb.nsPct  : null)}
      ${pctCell(nb ? nb.nbPct  : null)}
      ${pctCell(nb ? nb.oosPct : null)}
    </tr>`;
  }).join("");
}

function renderCvpPage(data){
  const el = document.getElementById("page-live-inputs");
  if(!el) return;
  const cy = data.cy || {};
  const ly = data.ly || {};
  const nb = data.nb || {};

  el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>Live Today — CVP Inputs</h1><div class="sub">Price drop · NB/NS/OOS metrics · cumulative D0</div></div>
        <span class="tag ok">${businessLabel()}</span>
      </div>
      <div class="chipbar" style="margin-top:4px">
        <span class="cbl">Filters:</span>
        <select class="metric-select" id="cvpFilter-sc"><option value="All">Super Category: All</option></select>
        ${CVP_FILTERS.sc !== "All" ? `<div class="chip" id="cvpFilterClear" style="color:var(--blue);border-color:var(--blue)">Clear filters</div>` : ""}
      </div>
      <div class="grid g3" style="margin-top:10px">
        ${cvpDropCard("Output Price Drop", cy.outputPriceDrop, ly.outputPriceDrop)}
        ${cvpDropCard("Input Price Drop",  cy.inputPriceDrop,  ly.inputPriceDrop)}
      </div>
      <div class="grid g3" style="margin-top:8px">
        ${nbMetricCard("NS%",  nb.nsPct)}
        ${nbMetricCard("NB%",  nb.nbPct)}
        ${nbMetricCard("OOS%", nb.oosPct)}
      </div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead">
        <b>HOURLY TREND</b>
        <select class="metric-select" id="cvpMetricSelect">
          ${CVP_CHART_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join("")}
        </select>
      </div>
      <div class="chart" id="cvpChart"></div>
      <div class="legend">
        <span><i class="dot"></i>CY</span>
        ${data.lyHourly && data.lyHourly.length ? `<span><i class="dot ly"></i>LY</span>` : ""}
      </div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead"><b>SUPER CATEGORY BREAKDOWN</b></div>
      <div class="table-wrap"><table class="table">
        <thead><tr>
          <th>Super Category</th>
          <th>Output Drop CY</th><th>Output Drop LY</th><th>Output Drop YoY</th>
          <th>Input Drop CY</th><th>Input Drop LY</th><th>Input Drop YoY</th>
          <th>NS%</th><th>NB%</th><th>OOS%</th>
        </tr></thead>
        <tbody id="cvpScRows"></tbody>
      </table></div>
    </div>
  `;

  populateCvpFilterOptions(data.filterOptions);
  const clearBtn = document.getElementById("cvpFilterClear");
  if(clearBtn) clearBtn.addEventListener("click", () => { CVP_FILTERS.sc = "All"; hydrateCvp(); });

  renderCvpScTable("cvpScRows", data.superCategories || []);

  // Merge NB hourly into combined hourly keyed by hour
  const nbByHour = {};
  (data.nbHourly || []).forEach(h => { nbByHour[h.hour] = h; });
  const mergedHourly = (data.hourly || []).map(h => ({
    ...h,
    nsPct:  nbByHour[h.hour] ? nbByHour[h.hour].nsPct  : null,
    nbPct:  nbByHour[h.hour] ? nbByHour[h.hour].nbPct  : null,
    oosPct: nbByHour[h.hour] ? nbByHour[h.hour].oosPct : null,
  }));
  // Also include NB-only hours not in CVP hourly
  (data.nbHourly || []).forEach(h => {
    if(!mergedHourly.find(m => m.hour === h.hour))
      mergedHourly.push({ hour: h.hour, nsPct: h.nsPct, nbPct: h.nbPct, oosPct: h.oosPct });
  });
  mergedHourly.sort((a,b) => a.hour - b.hour);

  const cyAgg  = { hourly: mergedHourly };
  const lyAgg  = data.lyHourly && data.lyHourly.length
    ? { hourly: data.lyHourly.map(h => ({ hour: h.hour, outputPriceDrop: h.outputPriceDrop, inputPriceDrop: h.inputPriceDrop })) }
    : null;
  wireLiveChart("cvpMetricSelect", "cvpChart", cyAgg, lyAgg, null, CVP_CHART_METRICS);
}

function hydrateCvp(){
  const el = document.getElementById("page-live-inputs");
  if(!el) return;
  el.innerHTML = `<div class="card"><div class="cardhead"><div><h1>Live Today — CVP Inputs</h1></div><span class="tag ok">${businessLabel()}</span><span class="tag warn">⏳ Connecting…</span></div><div class="callout">Loading…</div></div>`;
  callBackend("getCvpData", [CURRENT_BUSINESS, CVP_FILTERS], data => {
    if(!data || data.error){
      el.innerHTML = `<div class="card"><div class="cardhead"><div><h1>Live Today — CVP Inputs</h1></div><span class="tag bad">⚠ Error</span></div><div class="callout">${escapeHtml(data && data.error ? data.error : "No data")}</div></div>`;
      return;
    }
    renderCvpPage(data);
  }, err => {
    el.innerHTML = `<div class="card"><div class="callout">⚠ ${escapeHtml(err && err.message ? err.message : String(err))}</div></div>`;
  });
}

/* ---------------- RCA TAB ---------------- */
function renderRcaPage(){
  const el = document.getElementById("page-live-rca");
  if(!el) return;

  /* Realistic festive dummy data — swap for live API when available */
  const MODE_DATA = {
    target: {
      baseline: 100, actual: 92, label: "Target", baselineLabel: "Target ₹100 Cr",
      units: { baseline: 1200000, actual: 1056000 },
      asp:   { baseline: 833,     actual: 871 },
      traffic: { baseline: 18000000, actual: 16500000,
        direct:   { baseline: 9000000,  actual: 8250000,
          search: { baseline: 3600000, actual: 3300000 },
          merch:  { baseline: 2700000, actual: 2310000 },
          direct: { baseline: 2700000, actual: 2640000 },
        },
        indirect: { baseline: 9000000, actual: 8250000 },
      },
      funnel: {
        ppv:      { baseline: 0.72, actual: 0.68 },
        cabn:     { baseline: 0.38, actual: 0.34 },
        checkout: { baseline: 0.61, actual: 0.58 },
        payment:  { baseline: 0.84, actual: 0.81 },
      },
      scMix: [
        { name: "WomenEthnicContemporary", asp: 980, share: 0.28, baselineShare: 0.24 },
        { name: "WomenWesternCore",        asp: 720, share: 0.22, baselineShare: 0.26 },
        { name: "MensClothingTopwear",     asp: 540, share: 0.18, baselineShare: 0.20 },
        { name: "FashionWearables",        asp: 1240,share: 0.15, baselineShare: 0.13 },
        { name: "Others",                  asp: 620, share: 0.17, baselineShare: 0.17 },
      ],
    },
    yoy: {
      baseline: 82, actual: 92, label: "LY", baselineLabel: "LY ₹82 Cr",
      units: { baseline: 980000,  actual: 1056000 },
      asp:   { baseline: 837,     actual: 871 },
      traffic: { baseline: 15200000, actual: 16500000,
        direct:   { baseline: 7600000, actual: 8250000,
          search: { baseline: 3040000, actual: 3300000 },
          merch:  { baseline: 2280000, actual: 2310000 },
          direct: { baseline: 2280000, actual: 2640000 },
        },
        indirect: { baseline: 7600000, actual: 8250000 },
      },
      funnel: {
        ppv:      { baseline: 0.65, actual: 0.68 },
        cabn:     { baseline: 0.31, actual: 0.34 },
        checkout: { baseline: 0.55, actual: 0.58 },
        payment:  { baseline: 0.79, actual: 0.81 },
      },
      scMix: [
        { name: "WomenEthnicContemporary", asp: 980, share: 0.28, baselineShare: 0.26 },
        { name: "WomenWesternCore",        asp: 720, share: 0.22, baselineShare: 0.24 },
        { name: "MensClothingTopwear",     asp: 540, share: 0.18, baselineShare: 0.19 },
        { name: "FashionWearables",        asp: 1240,share: 0.15, baselineShare: 0.12 },
        { name: "Others",                  asp: 620, share: 0.17, baselineShare: 0.19 },
      ],
    },
  };

  let mode = "target";
  function d(){ return MODE_DATA[mode]; }

  function pct(v){ return (v*100).toFixed(1)+"%"; }
  function cr(v){ return "₹"+(v/1e7).toFixed(1)+" Cr"; }
  function lakh(v){ return (v/1e5).toFixed(1)+"L"; }
  function delta(a,b,invert){ const p=((a-b)/Math.abs(b)*100); const good = invert ? p<0 : p>0; return `<span class="stat ${good?"up":"down"}">${p>=0?"▲":"▼"} ${Math.abs(p).toFixed(1)}%</span>`; }
  function ppDelta(a,b,invert){ const pp=(a-b)*100; const good = invert ? pp<0 : pp>0; return `<span class="stat ${good?"up":"down"}">${pp>=0?"▲":"▼"} ${Math.abs(pp).toFixed(1)}pp</span>`; }
  function sev(impact){ if(Math.abs(impact)>15) return "bad"; if(Math.abs(impact)>7) return "warn"; return "ok"; }
  function badge(label,cls){ return `<span class="tag ${cls}" style="font-size:11px;padding:2px 7px">${label}</span>`; }

  function gmvGap(){ return d().actual - d().baseline; }
  function unitsImpact(){
    const gap = gmvGap();
    const unitsDelta = d().units.actual - d().units.baseline;
    return gap === 0 ? 0 : (unitsDelta * d().asp.baseline) / (gap * 1e7);
  }
  function aspImpact(){
    const gap = gmvGap();
    const aspDelta = d().asp.actual - d().asp.baseline;
    return gap === 0 ? 0 : (aspDelta * d().units.actual) / (gap * 1e7);
  }

  function buildInsight(){
    const gap = gmvGap();
    const uI = unitsImpact()*100, aI = aspImpact()*100;
    const dir = mode === "target" ? "miss" : "outperformance";
    const sign = gap < 0 ? "shortfall" : "surplus";
    const dominant = Math.abs(uI) > Math.abs(aI) ? `${Math.abs(uI).toFixed(0)}% driven by Units ${uI<0?"drop":"lift"}` : `${Math.abs(aI).toFixed(0)}% driven by ASP ${aI<0?"drop":"lift"}`;
    const funnelWorst = Object.entries(d().funnel).sort((a,b)=>((a[1].actual-a[1].baseline)/a[1].baseline)-((b[1].actual-b[1].baseline)/b[1].baseline))[0];
    const funnelLabel = {ppv:"PPV rate",cabn:"CABN rate",checkout:"Checkout rate",payment:"Payment rate"}[funnelWorst[0]];
    const funnelDelta = ((funnelWorst[1].actual - funnelWorst[1].baseline)/funnelWorst[1].baseline*100).toFixed(1);
    return `In <b>${mode==="target"?"Target Achievement":"YoY"} mode</b>, GMV ${sign} is <b>${cr(Math.abs(gap)*1e7)}</b>. Primary driver: ${dominant}. Weakest funnel step: <b>${funnelLabel}</b> at ${funnelDelta}% vs ${d().label}.`;
  }

  function treeNode(label, cy, base, unit, drivers, indent, causes){
    const delta_pct = base ? ((cy-base)/Math.abs(base)*100).toFixed(1) : "N/A";
    const cls = cy >= base ? "up" : "down";
    const causeHtml = causes ? `<span style="color:var(--muted);font-size:11px;margin-left:8px">${causes}</span>` : "";
    const driverHtml = drivers ? `<div style="margin-left:${indent+16}px;margin-top:4px;border-left:2px solid var(--border);padding-left:10px">${drivers}</div>` : "";
    const fmt = unit==="cr" ? cr : unit==="pct" ? pct : lakh;
    return `<div style="margin-left:${indent}px;padding:6px 0">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="min-width:180px">${label}</b>
        <span>${fmt(cy)}</span>
        <span style="color:var(--muted)">vs ${fmt(base)}</span>
        <span class="stat ${cls}">${cy>=base?"▲":"▼"} ${Math.abs(delta_pct)}%</span>
        ${causeHtml}
      </div>${driverHtml}</div>`;
  }

  function renderPage(){
    const D = d();
    const gap = gmvGap();
    const gapCr = gap * 1e7;
    const uPct = (unitsImpact()*100).toFixed(0);
    const aPct = (aspImpact()*100).toFixed(0);
    const trafficDelta = ((D.traffic.actual - D.traffic.baseline)/D.traffic.baseline*100).toFixed(1);
    const trafficCls = D.traffic.actual >= D.traffic.baseline ? "up" : "down";

    const tableRows = [
      { metric:"GMV", base: D.baseline+" Cr", actual: D.actual+" Cr", delta: ((D.actual-D.baseline)/D.baseline*100).toFixed(1)+"%", impact:"100%", cause: gap<0?"Primary shortfall":"Primary surplus" },
      { metric:"Units", base:lakh(D.units.baseline), actual:lakh(D.units.actual), delta:((D.units.actual-D.units.baseline)/D.units.baseline*100).toFixed(1)+"%", impact:uPct+"%", cause:D.units.actual<D.units.baseline?"Traffic & Conversion Drop":"Traffic & Conversion Gain" },
      { metric:"ASP", base:"₹"+D.asp.baseline, actual:"₹"+D.asp.actual, delta:((D.asp.actual-D.asp.baseline)/D.asp.baseline*100).toFixed(1)+"%", impact:aPct+"%", cause:"SC Mix Shift" },
      { metric:"Visits", base:lakh(D.traffic.baseline), actual:lakh(D.traffic.actual), delta:trafficDelta+"%", impact:"—", cause:"Direct + Indirect Traffic" },
      { metric:"PPV Rate", base:pct(D.funnel.ppv.baseline), actual:pct(D.funnel.ppv.actual), delta:((D.funnel.ppv.actual-D.funnel.ppv.baseline)*100).toFixed(1)+"pp", impact:"—", cause:"Pricing, EDD/Speed" },
      { metric:"CABN Rate", base:pct(D.funnel.cabn.baseline), actual:pct(D.funnel.cabn.actual), delta:((D.funnel.cabn.actual-D.funnel.cabn.baseline)*100).toFixed(1)+"pp", impact:"—", cause:"OOS, Shipping fee" },
      { metric:"Checkout Rate", base:pct(D.funnel.checkout.baseline), actual:pct(D.funnel.checkout.actual), delta:((D.funnel.checkout.actual-D.funnel.checkout.baseline)*100).toFixed(1)+"pp", impact:"—", cause:"OOS, Shipping fee" },
      { metric:"Payment Rate", base:pct(D.funnel.payment.baseline), actual:pct(D.funnel.payment.actual), delta:((D.funnel.payment.actual-D.funnel.payment.baseline)*100).toFixed(1)+"pp", impact:"—", cause:"PG Success, Coupon" },
    ];

    el.innerHTML = `
    <div class="card">
      <div class="cardhead">
        <div><h1>RCA — GMV Performance</h1><div class="sub">Root Cause Analysis · ${businessLabel()}</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="chart-mode-toggle" id="rcaModeToggle">
            <button class="${mode==="target"?"active":""}" data-mode="target">vs Target</button>
            <button class="${mode==="yoy"?"active":""}" data-mode="yoy">vs LY (YoY)</button>
          </div>
        </div>
      </div>

      <!-- Summary Cards -->
      <div class="grid g3" style="margin-top:12px">
        <div class="card kpi" style="border:2px solid ${gap<0?"var(--red)":"var(--green)"}">
          <label>GMV ${mode==="target"?"Achievement":"vs LY"}</label>
          <div class="value">${cr(D.actual*1e7)}</div>
          <div class="sub">${D.baselineLabel}</div>
          <div class="statrow">${delta(D.actual,D.baseline,false)}</div>
        </div>
        <div class="card kpi">
          <label>Units</label>
          <div class="value">${lakh(D.units.actual)}</div>
          <div class="sub">${D.label}: ${lakh(D.units.baseline)}</div>
          <div class="statrow">${delta(D.units.actual,D.units.baseline,false)}</div>
        </div>
        <div class="card kpi">
          <label>ASP</label>
          <div class="value">₹${D.asp.actual}</div>
          <div class="sub">${D.label}: ₹${D.asp.baseline}</div>
          <div class="statrow">${delta(D.asp.actual,D.asp.baseline,false)}</div>
        </div>
      </div>

      <!-- Attribution badge -->
      <div style="margin-top:10px;padding:10px 14px;background:var(--surface2);border-radius:8px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <b>GMV Gap Attribution:</b>
        <span>${badge("Units Impact: "+uPct+"%", Math.abs(Number(uPct))>50?"bad":"warn")}</span>
        <span>${badge("ASP Impact: "+aPct+"%", Math.abs(Number(aPct))>50?"bad":"warn")}</span>
      </div>
    </div>

    <!-- Insight -->
    <div class="card" style="margin-top:10px;background:var(--surface2);border-left:4px solid var(--blue)">
      <div style="font-size:13px;line-height:1.6">${buildInsight()}</div>
    </div>

    <!-- RCA Tree -->
    <div class="card" style="margin-top:10px">
      <div class="cardhead"><b>DIAGNOSTIC TREE</b><span class="tiny">Click nodes to expand</span></div>
      <div style="font-size:13px;line-height:1.8">

        ${treeNode("GMV Gap", D.actual*1e7, D.baseline*1e7, "cr", null, 0, null)}

        <div style="margin-left:16px;border-left:2px solid var(--border);padding-left:10px;margin-top:2px">

          <!-- Units branch -->
          <div style="padding:4px 0">
            <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
              <span style="font-size:16px" class="seg-toggle">▸</span>
              <b>Units Driver</b>
              <span>${lakh(D.units.actual)}</span><span style="color:var(--muted)">vs ${lakh(D.units.baseline)}</span>
              ${delta(D.units.actual,D.units.baseline,false)}
              ${badge("Impact: "+uPct+"%", sev(Math.abs(Number(uPct))))}
            </div>
            <div style="display:none;margin-left:24px;border-left:2px solid var(--border);padding-left:10px">

              <!-- Traffic -->
              <div style="padding:4px 0">
                <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
                  <span style="font-size:14px">▸</span><b>Traffic</b>
                  <span>${lakh(D.traffic.actual)}</span><span style="color:var(--muted)">vs ${lakh(D.traffic.baseline)}</span>
                  <span class="stat ${trafficCls}">${D.traffic.actual>=D.traffic.baseline?"▲":"▼"} ${Math.abs(trafficDelta)}%</span>
                </div>
                <div style="display:none;margin-left:24px;border-left:2px solid var(--border);padding-left:10px;font-size:12px">
                  <div style="padding:3px 0;display:flex;gap:8px;flex-wrap:wrap"><b>Direct</b> ${lakh(D.traffic.direct.actual)} vs ${lakh(D.traffic.direct.baseline)} ${delta(D.traffic.direct.actual,D.traffic.direct.baseline,false)}</div>
                  <div style="padding:3px 0;margin-left:16px;display:flex;gap:8px;flex-wrap:wrap;color:var(--muted)">Search ${lakh(D.traffic.direct.search.actual)} ${delta(D.traffic.direct.search.actual,D.traffic.direct.search.baseline,false)} · Merch ${lakh(D.traffic.direct.merch.actual)} ${delta(D.traffic.direct.merch.actual,D.traffic.direct.merch.baseline,false)} · Direct/Ref ${lakh(D.traffic.direct.direct.actual)} ${delta(D.traffic.direct.direct.actual,D.traffic.direct.direct.baseline,false)}</div>
                  <div style="padding:3px 0;display:flex;gap:8px;flex-wrap:wrap"><b>Indirect</b> ${lakh(D.traffic.indirect.actual)} vs ${lakh(D.traffic.indirect.baseline)} ${delta(D.traffic.indirect.actual,D.traffic.indirect.baseline,false)}</div>
                </div>
              </div>

              <!-- Funnel / Conversion -->
              <div style="padding:4px 0">
                <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
                  <span style="font-size:14px">▸</span><b>Conversion Funnel</b>
                </div>
                <div style="display:none;margin-left:24px;border-left:2px solid var(--border);padding-left:10px;font-size:12px">
                  ${[
                    ["PPV Rate",      D.funnel.ppv,      "Pricing, EDD/Speed"],
                    ["CABN Rate",     D.funnel.cabn,     "OOS, Shipping fee"],
                    ["Checkout Rate", D.funnel.checkout, "OOS, Shipping fee"],
                    ["Payment Rate",  D.funnel.payment,  "PG Success, Coupon failure"],
                  ].map(([label,f,cause])=>{
                    const pp=((f.actual-f.baseline)*100);
                    const cls2=f.actual>=f.baseline?"up":"down";
                    const sev2=Math.abs(pp)>5?"bad":Math.abs(pp)>2?"warn":"ok";
                    return `<div style="padding:4px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                      <b>${label}</b> ${pct(f.actual)} vs ${pct(f.baseline)}
                      <span class="stat ${cls2}">${pp>=0?"▲":"▼"} ${Math.abs(pp).toFixed(1)}pp</span>
                      ${badge(cause, sev2)}
                    </div>`;
                  }).join("")}
                </div>
              </div>
            </div>
          </div>

          <!-- ASP branch -->
          <div style="padding:4px 0">
            <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
              <span style="font-size:16px">▸</span>
              <b>ASP Driver</b>
              <span>₹${D.asp.actual}</span><span style="color:var(--muted)">vs ₹${D.asp.baseline}</span>
              ${delta(D.asp.actual,D.asp.baseline,false)}
              ${badge("SC Mix Shift", "warn")}
            </div>
            <div style="display:none;margin-left:24px;border-left:2px solid var(--border);padding-left:10px;font-size:12px">
              <table class="table" style="margin-top:6px">
                <thead><tr><th>SC</th><th>ASP</th><th>Actual Mix</th><th>${D.label} Mix</th><th>Mix Δ</th></tr></thead>
                <tbody>
                  ${D.scMix.map(s=>{
                    const mixDelta=(s.share-s.baselineShare)*100;
                    const cls3=mixDelta>=0?"up":"down";
                    return `<tr><td>${s.name}</td><td>₹${s.asp}</td><td>${pct(s.share)}</td><td>${pct(s.baselineShare)}</td><td class="${cls3}">${mixDelta>=0?"▲":"▼"} ${Math.abs(mixDelta).toFixed(1)}pp</td></tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- Metric Table -->
    <div class="card" style="margin-top:10px">
      <div class="cardhead"><b>METRIC & DRIVER BREAKDOWN</b></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Metric</th><th>${D.label}</th><th>Actual</th><th>Delta</th><th>Attribution</th><th>Primary Cause</th></tr></thead>
        <tbody>
          ${tableRows.map(r=>{
            const deltaNum = parseFloat(r.delta);
            const cls4 = r.metric==="ASP" ? (deltaNum>=0?"up":"down") : (deltaNum>=0?"up":"down");
            return `<tr><td><b>${r.metric}</b></td><td>${r.base}</td><td>${r.actual}</td><td class="${cls4}">${r.delta}</td><td>${r.impact}</td><td style="color:var(--muted);font-size:12px">${r.cause}</td></tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>
    `;

    // Wire mode toggle
    el.querySelectorAll("#rcaModeToggle button").forEach(btn => {
      btn.addEventListener("click", () => {
        if(btn.dataset.mode === mode) return;
        mode = btn.dataset.mode;
        renderPage();
      });
    });
  }

  renderPage();
}

function hydrateRca(){
  renderRcaPage();
}

/* ---------------- NAV + SHELL ---------------- */
let activePageId = null;

function renderNavAndPages(restorePageId){
  renderBusinessSwitcher();

  const navEl = document.getElementById("navGroups");
  const contentEl = document.getElementById("content");
  let navHtml = "", pagesHtml = "";
  let n = 1;

  NAV_GROUPS.forEach(group => {
    navHtml += `<div class="navgroup"><h5>${group.label}</h5><div class="nav">`;
    group.tabs.forEach(tabKey => {
      const config = TAB_CONFIGS[tabKey];
      const pageId = `${group.id}-${tabKey}`;
      navHtml += `<button data-page="${pageId}"><span class="num">${String(n++).padStart(2,"0")}</span>${config.title}</button>`;
      pagesHtml += `<div class="page" id="page-${pageId}"></div>`;
    });
    navHtml += `</div></div>`;
  });

  navEl.innerHTML = navHtml;
  contentEl.innerHTML = pagesHtml;

  const navButtons = [...navEl.querySelectorAll("button[data-page]")];
  navButtons.forEach(btn => btn.addEventListener("click", () => go(btn.dataset.page)));

  function go(pageId){
    activePageId = pageId;
    document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + pageId));
    navButtons.forEach(b => b.classList.toggle("active", b.dataset.page === pageId));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  NAV_GROUPS.forEach(group => {
    group.tabs.forEach(tabKey => {
      const pageId = `${group.id}-${tabKey}`;
      if(pageId === LIVE_PAGE_ID) hydrateLiveSales();
      else if(pageId === FUNNEL_PAGE_ID) hydrateLiveFunnel();
      else if(pageId === TRAFFIC_PAGE_ID) hydrateLiveTraffic();
      else if(pageId === CVP_PAGE_ID) hydrateCvp();
      else if(pageId === RCA_PAGE_ID) renderRcaPage();
      else if(pageId === SUMMARY_SALES_PAGE_ID)   hydrateEventSales();
      else if(pageId === SUMMARY_FUNNEL_PAGE_ID)   hydrateSummaryFunnel();
      else if(pageId === SUMMARY_TRAFFIC_PAGE_ID) hydrateSummaryTraffic();
      else renderComingSoon(group.id, tabKey);
    });
  });

  const validRestore = restorePageId && navButtons.some(b => b.dataset.page === restorePageId);
  go(validRestore ? restorePageId : `${NAV_GROUPS[0].id}-${NAV_GROUPS[0].tabs[0]}`);
}

/* Real browser date/time — no hardcoded event calendar. Refreshed every
   minute so "current hour" stays accurate on a long-open tab. */
function updateClock(){
  const dateEl = document.getElementById("eventDateRange");
  if(dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function renderShellMeta(){
  updateClock();
  setInterval(updateClock, 60000);
}

document.addEventListener("DOMContentLoaded", () => {
  renderShellMeta();
  renderNavAndPages();
});
