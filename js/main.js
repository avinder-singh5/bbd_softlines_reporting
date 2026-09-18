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
    case "rs_cr": return `₹${n} Cr`;
    case "cr": return `${n} Cr`;
    case "l": return `${n} L`;
    case "m": return `${n} M`;
    case "rs": return `₹${Math.round(v)}`;
    case "pct": return `${n}%`;
    case "idx": return `${n}`;
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
      FUNNEL_FILTERS = { alpha: "All", sc: "All" };
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
  { key: "asp", label: "ASP", unit: "rs", pick: h => (h.units ? h.gmv / h.units : null) },
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

function populateLiveFilterOptions(){
  callBackend("getFilterOptions", [CURRENT_BUSINESS], opts => {
    if(!opts || opts.error) return;
    LIVE_FILTER_KEYS.forEach(key => {
      const sel = document.getElementById(`liveFilter-${key}`);
      if(!sel) return;
      const values = opts[key] || [];
      sel.innerHTML = `<option value="All">${LIVE_FILTER_LABELS[key]}: All</option>` +
        values.map(v => `<option value="${escapeHtml(v)}" ${LIVE_FILTERS[key]===v?"selected":""}>${escapeHtml(v)}</option>`).join("");
      sel.onchange = () => { LIVE_FILTERS[key] = sel.value; hydrateLiveSales(); };
    });
  }, () => { /* filter options are a nice-to-have; ignore failures silently */ });
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

/* Segment breakdown table: business-specific top rows (Apparel/Non-Apparel for
   LS, Alpha/MP for others) with GMV and Units each shown as CY / LY / YoY.
   Each top row expands (click the ▸) into its Alpha/MP (or Branded/Unbranded)
   children without cluttering the default view. */
function renderLiveTable(targetId, agg){
  const rows = agg.breakdown || [];
  const cell = (cy, ly, unit) => {
    const yoy = ly ? yoyPct(cy, ly) : null;
    return `<td>${fmtVal(cy, unit)}</td><td>${ly ? fmtVal(ly, unit) : "—"}</td>${yoyCell(yoy)}`;
  };
  const rowHtml = (r, parentIdx) => `
    <tr class="${parentIdx===null ? "seg-parent" : "seg-child hidden"}" ${parentIdx===null ? "" : `data-parent="${parentIdx}"`}>
      <td>${parentIdx===null ? `<span class="seg-toggle">▸</span>` : ""}${escapeHtml(r.label)}</td>
      ${cell(r.tyGmv / 1e7, r.lyGmv / 1e7, "rs_cr")}${spikeCell(r.cyGmvSpike)}${spikeCell(r.lyGmvSpike)}
      ${cell(r.tyUnits / 1e5, r.lyUnits / 1e5, "l")}${spikeCell(r.cyUnitsSpike)}${spikeCell(r.lyUnitsSpike)}
    </tr>`;
  const tbody = document.getElementById(targetId);
  tbody.innerHTML = rows.map((r, i) => rowHtml(r, null) + (r.children || []).map(c => rowHtml(c, i)).join("")).join("");
  tbody.querySelectorAll(".seg-parent").forEach((tr, i) => {
    const toggle = tr.querySelector(".seg-toggle");
    tr.addEventListener("click", () => {
      const expanded = toggle.textContent === "▾";
      toggle.textContent = expanded ? "▸" : "▾";
      tbody.querySelectorAll(`tr[data-parent="${i}"]`).forEach(child => child.classList.toggle("hidden", expanded));
    });
  });
}
function yoyCell(delta){
  return `<td class="${delta===null?'':delta>=0?'up':'down'}">${delta===null?"N/A":(delta>=0?"▲":"▼")+" "+Math.abs(delta).toFixed(1)+"%"}</td>`;
}
function spikeCell(spike){
  return `<td>${spike===null||spike===undefined?"N/A":spike.toFixed(2)+"x"}</td>`;
}

/* Same CY/LY/YoY/Spike layout as the segment breakdown table, but one flat
   row per named group (matched to LY by name) instead of the business
   segments — shared by the Super Category and (LS-only) Mega Category
   breakdown tables. */
function renderNamedBreakdownTable(targetId, agg, fieldName){
  const cell = (cy, ly, unit) => {
    const yoy = ly !== null ? yoyPct(cy, ly) : null;
    return `<td>${fmtVal(cy, unit)}</td><td>${ly !== null ? fmtVal(ly, unit) : "—"}</td>${yoyCell(yoy)}`;
  };
  const lyByName = {};
  ((agg.ly && agg.ly[fieldName]) || []).forEach(s => { lyByName[s.name] = s; });
  const rows = agg[fieldName] || [];
  document.getElementById(targetId).innerHTML = rows.map(r => {
    const ly = lyByName[r.name] || null;
    return `<tr><td>${escapeHtml(r.name)}</td>
      ${cell(r.gmv / 1e7, ly ? ly.gmv / 1e7 : null, "rs_cr")}${spikeCell(r.cyGmvSpike)}${spikeCell(r.lyGmvSpike)}
      ${cell(r.units / 1e5, ly ? ly.units / 1e5 : null, "l")}${spikeCell(r.cyUnitsSpike)}${spikeCell(r.lyUnitsSpike)}
    </tr>`;
  }).join("");
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

    <div style="margin-top:10px" class="card">
      <div class="cardhead"><b>SEGMENT BREAKDOWN — CUMULATIVE TILL HOUR</b><span class="tiny">00:00 → ${String(hourCount-1).padStart(2,"0")}:00</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Segment</th><th>GMV CY</th><th>GMV LY</th><th>GMV YoY</th><th>GMV CY Spike</th><th>GMV LY Spike</th><th>Units CY</th><th>Units LY</th><th>Units YoY</th><th>Units CY Spike</th><th>Units LY Spike</th></tr></thead>
        <tbody id="liveTableRows"></tbody>
      </table></div>
    </div>

    ${CURRENT_BUSINESS === "LS" ? `
    <div style="margin-top:10px" class="card">
      <div class="cardhead"><b>MEGA CATEGORY BREAKDOWN — CUMULATIVE TILL HOUR</b><span class="tiny">00:00 → ${String(hourCount-1).padStart(2,"0")}:00</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Mega Category</th><th>GMV CY</th><th>GMV LY</th><th>GMV YoY</th><th>GMV CY Spike</th><th>GMV LY Spike</th><th>Units CY</th><th>Units LY</th><th>Units YoY</th><th>Units CY Spike</th><th>Units LY Spike</th></tr></thead>
        <tbody id="liveMcTableRows"></tbody>
      </table></div>
    </div>
    ` : ""}

    <div style="margin-top:10px" class="card">
      <div class="cardhead"><b>SUPER CATEGORY BREAKDOWN — CUMULATIVE TILL HOUR</b><span class="tiny">00:00 → ${String(hourCount-1).padStart(2,"0")}:00</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Super Category</th><th>GMV CY</th><th>GMV LY</th><th>GMV YoY</th><th>GMV CY Spike</th><th>GMV LY Spike</th><th>Units CY</th><th>Units LY</th><th>Units YoY</th><th>Units CY Spike</th><th>Units LY Spike</th></tr></thead>
        <tbody id="liveScTableRows"></tbody>
      </table></div>
    </div>

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
  document.getElementById(targetId).innerHTML = FUNNEL_METRICS.map(m => {
    if(m.type === "ratio"){
      const cy = totals[m.den] ? (totals[m.num] / totals[m.den]) * 100 : null;
      const ly = lyTotals && lyTotals[m.den] ? (lyTotals[m.num] / lyTotals[m.den]) * 100 : null;
      return `<div class="card kpi"><label>${m.label}</label><div class="value">${fmtVal(cy, m.unit)}</div><div class="statrow">${ppBadge(cy !== null ? cy / 100 : null, ly !== null ? ly / 100 : null)}</div></div>`;
    }
    const cy = totals[m.key] / 1e6;
    const ly = lyTotals ? lyTotals[m.key] / 1e6 : null;
    const yoy = ly !== null ? yoyPct(cy, ly) : null;
    return `<div class="card kpi"><label>${m.label}</label><div class="value">${fmtVal(cy, m.unit)}</div><div class="statrow">${yoyBadge(yoy)}</div></div>`;
  }).join("");
}

/* Shared by the Segment (Alpha/MP) and Super Category breakdown tables —
   rows are normalized to {label, ty:{visits,orders}, ly:{visits,orders}|null}.
   showOV adds an O/V (orders ÷ visits) block — SC table only. */
function renderFunnelBreakdownTable(targetId, rows, showOV){
  const cell = (cy, ly, unit) => {
    const yoy = (ly !== null && ly !== undefined) ? yoyPct(cy, ly) : null;
    return `<td>${fmtVal(cy, unit)}</td><td>${(ly !== null && ly !== undefined) ? fmtVal(ly, unit) : "—"}</td>${yoyCell(yoy)}`;
  };
  const ovCell = r => {
    const cy = r.ty.visits ? (r.ty.orders / r.ty.visits) * 100 : null;
    const ly = (r.ly && r.ly.visits) ? (r.ly.orders / r.ly.visits) * 100 : null;
    const deltaPp = (cy !== null && ly !== null) ? cy - ly : null;
    const cls = deltaPp === null ? "" : deltaPp >= 0 ? "up" : "down";
    return `<td>${cy === null ? "N/A" : cy.toFixed(2) + "%"}</td><td>${ly === null ? "—" : ly.toFixed(2) + "%"}</td><td class="${cls}">${deltaPp === null ? "N/A" : (deltaPp >= 0 ? "▲" : "▼") + " " + Math.abs(deltaPp).toFixed(1) + "pp"}</td>`;
  };
  document.getElementById(targetId).innerHTML = rows.map(r => `
    <tr><td>${escapeHtml(r.label)}</td>
      ${cell(r.ty.visits / 1e5, r.ly ? r.ly.visits / 1e5 : null, "l")}
      ${cell(r.ty.orders / 1e5, r.ly ? r.ly.orders / 1e5 : null, "l")}
      ${showOV ? ovCell(r) : ""}
    </tr>`).join("");
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

      <div class="grid g3" id="funnelKpiRow" style="margin-top:10px"></div>
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

    <div style="margin-top:10px" class="card">
      <div class="cardhead"><b>SEGMENT BREAKDOWN — CUMULATIVE TILL HOUR</b><span class="tiny">00:00 → ${String(hourCount-1).padStart(2,"0")}:00</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Segment</th><th>Visits CY</th><th>Visits LY</th><th>Visits YoY</th><th>Orders CY</th><th>Orders LY</th><th>Orders YoY</th></tr></thead>
        <tbody id="funnelSegmentRows"></tbody>
      </table></div>
    </div>

    <div style="margin-top:10px" class="card">
      <div class="cardhead"><b>SUPER CATEGORY BREAKDOWN — CUMULATIVE TILL HOUR</b><span class="tiny">00:00 → ${String(hourCount-1).padStart(2,"0")}:00</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Super Category</th><th>Visits CY</th><th>Visits LY</th><th>Visits YoY</th><th>Orders CY</th><th>Orders LY</th><th>Orders YoY</th><th>O/V CY</th><th>O/V LY</th><th>O/V YoY</th></tr></thead>
        <tbody id="funnelScRows"></tbody>
      </table></div>
    </div>
  `;

  populateFunnelDaySelect(data.days, data.selectedDay);
  populateFunnelFilterOptions();
  const clearBtn = document.getElementById("funnelFilterClear");
  if(clearBtn) clearBtn.addEventListener("click", () => {
    FUNNEL_FILTER_KEYS.forEach(k => FUNNEL_FILTERS[k] = "All");
    hydrateLiveFunnel();
  });
  renderFunnelKpiCards("funnelKpiRow", data.totals, data.ly ? data.ly.totals : null);
  renderFunnelBreakdownTable("funnelSegmentRows", data.segments || []);
  renderFunnelBreakdownTable("funnelScRows", (data.superCategories || []).map(sc => ({ label: sc.name, ty: sc, ly: sc.ly || null })), true);
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
