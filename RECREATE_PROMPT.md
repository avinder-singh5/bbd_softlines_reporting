# Prompt: Recreate the "Event Reporting Center" Dashboard

Copy everything inside the fenced block below and give it to another AI coding
agent (Claude Code, Cursor, etc.) as a single instruction to rebuild this
project from scratch as an exact replica.

````
Build a web app called "Event Reporting Center" — a single-page e-commerce
event-reporting dashboard (built for a sale event like "Big Billion Days").
It must run two ways from the SAME frontend code: (1) locally via a Python
Flask backend that reads live data from a Google Sheet, and (2) deployable to
Google Apps Script (HtmlService web app) reading the same Sheet. Build and
verify the Flask version first.

============================================================
1. FILE STRUCTURE
============================================================
/index.html
/css/style.css
/js/data.js          (static config: nav structure, metric labels, business list — NO fabricated numbers)
/js/main.js          (all render logic + backend abstraction)
/server/app.py        (Flask backend, local dev)
/server/requirements.txt   (flask, google-auth, google-auth-oauthlib, google-api-python-client)
/server/README.md     (setup instructions — service account vs OAuth)
/server/.gitignore     (credentials.json, token.json, service-account.json, venv/, __pycache__/, *.pyc)
/apps-script/Code.gs, Index.html, Stylesheet.html, DataScript.html, MainScript.html, appsscript.json
  (Apps Script mirror of the Flask backend + frontend, for production deployment via clasp)

============================================================
2. OVERALL UX / LAYOUT
============================================================
- Fixed left sidebar (236px wide, dark navy gradient background #071a38→#06132c),
  containing:
  - Brand block: emoji/logo tile + "EVENT REPORTING CENTER" title + "Enterprise Ecommerce" subtitle.
  - Event mini block: event name (e.g. "Big Billion Days") + a live pulsing green
    dot + a small line showing today's real date (from the browser clock, e.g.
    "9 Sept 2026"), refreshed every 60s. NOT a hardcoded event calendar.
  - "BUSINESS" switcher: a 2-column grid of pill buttons for 4 businesses,
    e.g. LS ("LifeStyle"), BGM, Home, Furniture. Exactly one is active
    (highlighted amber/gold) at a time. Switching business resets all filters
    and the day selector back to defaults and re-renders every page.
  - Nav groups below, each with a header label and a vertical list of tab
    buttons, numbered "01", "02", etc. Two groups: "Live Today" (tabs: Sales,
    Traffic, Funnel, Business Inputs) and "Event Summary" (tabs: Sales,
    Traffic, Funnel, Business Inputs, Customer). Only "Live Today → Sales" is
    wired to real data; every other tab renders a generic "Coming Soon" page
    (see section 8).
  - Sidebar bottom: a small "DATA QUALITY" box showing "🚧 Coming Soon".
- Main content area (margin-left 236px): a single scrollable page area. No
  top header bar / no sticky filters bar above the content — each page owns
  its own header inside its first card.
- A tiny centered footer note under the content explaining only Sales is live.
- Design tokens (CSS variables): navy #071a38/#0b2550, blue accent #2563eb,
  background #f5f7fb, card white #fff, text #12213a, muted #6b7890,
  green #12945b/bg #e8f7ef, red #d63a3a/bg #fdecec, amber #c77a00/bg #fff5dc.
  Cards: 10px radius, 1px border #e4e9f2, soft shadow. Font: Inter / system
  sans-serif. Everything is small/dense (9–19px font sizes), enterprise
  dashboard aesthetic, not consumer-flashy.
- Responsive breakpoints: at ≤1180px sidebar shrinks to 196px and 4/5/6-column
  grids collapse to 2–3 columns; at ≤800px sidebar goes static/full-width and
  all grids become single-column.

============================================================
3. DATA SOURCE (Google Sheet)
============================================================
One Google Sheet with two tabs:
  - "Sales Live" — this year's (TY) data, spans exactly 2 calendar days: the
    most recent day (still accumulating hour-by-hour, "D0") and the day
    before it (fully complete, "D-1").
  - "Sales Live Historical" — last year's (LY) data, ALSO spans exactly 2
    days, aligned to TY's 2 days by INDEX POSITION (not by matching calendar
    date) — i.e. TY's D0 maps to LY's most recent date, TY's D-1 maps to
    LY's earlier date.
Both tabs share this column schema (exact header names, order doesn't
matter — resolve by name):
  order_date_key           (int, YYYYMMDD, e.g. 20260909)
  hour_of_day               (int, 0–23)
  analytic_business_unit    (string — must exactly match one of the 4 business
                              labels: "LifeStyle", "BGM", "Home", "Furniture")
  analytic_super_category   (string — e.g. "FashionWearables", "WomenFW",
                              "AutoAccessorys", etc. — the "SC" dimension)
  gmv                        (number)
  units                      (number)
  upi_units, cod_units, pbo_units, others_units   (numbers — payment split of `units`)
  marketplace_id             (string — e.g. "FLIPKART", "HYPERLOCAL")
  branded_flag               (string — "Branded" / "Unbranded")
  is_alpha_seller            (string — "Diamond" = Alpha seller, "Rest of MP" = Marketplace seller)
  asp_bucket                 (string — price-point bucket, e.g. "a) 0-300", "b) 301-500", ...)
Each row is one (date, hour, business, super-category, marketplace, brand,
alpha, price-bucket) combination's aggregated GMV/units/payment-split.

Apparel SC set for LifeStyle only (used by the segment breakdown table, see
section 6): FashionWearables, GemsAndJewellery, KidsFootwear,
LuggageAndTravelAccessories, MensCnFFootwear, MensOpenFootwear,
MensSportsFootwear, WomenFW. Every other SC for LS counts as "Non-Apparel".

============================================================
4. BACKEND (server/app.py — Flask, port 8934)
============================================================
Auth (try in this order, first one whose file exists wins):
  1. Service account JSON at server/service-account.json (Sheets API,
     read-only scope). The Sheet must be shared with the service account's
     client_email as Viewer.
  2. OAuth "Desktop app" client at server/credentials.json — one-time browser
     consent flow, caches server/token.json afterward.
Read the Sheet via the Sheets API v4 `spreadsheets().values().get()` call
(range = the tab name in quotes). Cache raw sheet reads in memory for 120s
per tab (avoid re-fetching on every request), and cache computed aggregate
responses in memory for 300s per (business, day, filters) cache key. Never
cache an empty/zero-row result.

Constants:
  SALES_SHEET_ID = "<the spreadsheet ID>"
  SALES_SHEET_TAB_NAME = "Sales Live"
  LY_SHEET_TAB_NAME = "Sales Live Historical"
  BUSINESS_SHEET_MAP = {"LS": "LifeStyle", "BGM": "BGM", "Home": "Home", "Furniture": "Furniture"}
  FILTER_KEYS = ("marketplace", "branded", "alpha", "pricePoint", "sc")
  FILTER_COLS mapping each filter key to its sheet column name (marketplace_id,
  branded_flag, is_alpha_seller, asp_bucket, analytic_super_category).

Core aggregation function `aggregate_rows(values, col, target_bu, filters,
date_key, hour_limit=None)`:
  - Iterate all data rows; keep only rows matching date_key, business unit,
    and all active filters (a filter value of "All" always matches).
  - If hour_limit is set, DROP any row whose hour_of_day >= hour_limit (used
    both to exclude the still-accumulating partial hour of "today", and to
    cap LY to the same hour window as TY for a fair like-for-like comparison).
  - Accumulate: totalGmv, totalUnits, per-payment-method unit totals (upi/cod/
    pbo/others), an hour-by-hour {hour, gmv, units} series, row count, and a
    per-Super-Category breakdown (name, gmv, units, its own hourly series,
    its own payment-share), sorted by descending GMV.
  - Return this as one aggregate object.

"Day-till-hour" partial-day rule:
  - Find the max hour_of_day present for the selected date across ALL rows
    (not just the filtered subset) — call it latest_hour.
  - ONLY if the selected day is the most-recent date in the sheet (i.e. it's
    "today", not a completed prior day), and latest_hour < 24, treat
    latest_hour as hour_limit and drop that hour everywhere for TY. A "D-1"
    (already-complete) day always keeps all 24 hours — never apply this
    exclusion to it.

Dual LY aggregation (both computed every request):
  - "full" (hour_limit=None): LY's entire day, 24 hours. Used ONLY to draw
    the LY line on the hourly trend chart — the chart always shows a full
    24h LY curve regardless of how much of TY's day has elapsed.
  - "capped" (hour_limit = same value used for TY): used for every KPI card,
    every table total, and every YoY% — so a partial "today" is compared
    against the SAME hour window last year, not a full LY day (which would
    make YoY% look artificially bad).
  - Merge these two into one `ly` object: totals/paymentShare/superCategories
    come from the "capped" aggregation; the `hourly` array (top-level and
    per-SC) comes from the "full" aggregation.

Day selector: expose the 2 available TY dates as
  days = [{"key":"D0","dateKey":<latest date>}, {"key":"D-1","dateKey":<previous date>}]
(D-1 only included if 2+ distinct dates exist). Requests pick a day by key
("D0"/"D-1"), default "D0".

Segment breakdown table data — `compute_breakdown(business_key, ...)`:
  Build a hierarchical list of {label, tyGmv, tyUnits, lyGmv, lyUnits,
  children:[...]} rows (children have the same 4 numeric fields, no further
  nesting), using the SAME hour_limit/capped-LY logic as everything else:
  - If business_key == "LS":
      - "Apparel"      (SC in the Apparel set) → children "Apparel x Alpha",
        "Apparel x MP" (Apparel AND is_alpha_seller == "Diamond"/"Rest of MP")
      - "Non-Apparel"   (SC not in the Apparel set) → children
        "Non-Apparel x Alpha", "Non-Apparel x MP"
  - Else (BGM / Home / Furniture):
      - "Alpha"  (is_alpha_seller == "Diamond") → children "Alpha x Branded",
        "Alpha x Unbranded" (branded_flag == "Branded"/"Unbranded")
      - "MP"     (is_alpha_seller == "Rest of MP") → children "MP x Branded",
        "MP x Unbranded"
  Every row/child is computed by summing gmv/units over rows matching its own
  predicate PLUS the currently active filters — i.e. this table still
  respects marketplace/brand/alpha/price-point/SC filters if the user has
  set any, it's not exempt from them.

Response shape for `GET /api/live-sales?business=<key>&day=<D0|D-1>&<filter
key>=<value>...` (all filter params default to "All" if omitted):
  {
    business, sheetBusinessUnit, dateKey, excludedHour (int or null),
    days: [...], selectedDay,
    rowCount, totalGmv, totalUnits,
    hourly: [{hour, gmv, units}, ...],
    superCategories: [{name, gmv, units, hourly, paymentShare}, ...],
    paymentShare: {upi, cod, pbo, others} (fractions 0..1, or nulls if totalUnits is 0),
    ly: { dateKey, rowCount, totalGmv, totalUnits, hourly, paymentShare,
          superCategories: [{name, gmv, units, paymentShare, hourly}] } or null,
    breakdown: [ {label, tyGmv, tyUnits, lyGmv, lyUnits, children:[...]}, ... ]
  }
If the sheet has zero rows or the endpoint hits an error, return a
best-effort empty shape (or a `{"error": "..."}` body with HTTP 500) rather
than crashing — the frontend must be able to show a clean error state.

Other endpoints:
  - `GET /api/filter-options?business=<key>` → for each FILTER_KEYS entry,
    return the sorted list of distinct values present for that business unit
    in the TY sheet (used to populate the filter dropdowns).
  - `GET /api/sales-debug` → diagnostics: list of all tabs in the spreadsheet
    with row counts, the resolved header, total data rows, the max date
    present, row counts per business unit overall and at the max date, and
    the BUSINESS_SHEET_MAP — shown to the user when "no live rows found" so
    they can self-diagnose a business-unit-name mismatch.
  - `GET /` and `GET /<path:path>` → serve index.html / static files from the
    project root (so one `python3 server/app.py` serves the whole app on
    :8934, no separate static server needed).

============================================================
5. FRONTEND — BACKEND ABSTRACTION (js/main.js)
============================================================
Write a `callBackend(fnName, args, onSuccess, onError)` function that:
  - If `google.script.run` exists (i.e. running as a deployed Apps Script web
    app), call `google.script.run.withSuccessHandler(onSuccess)
    .withFailureHandler(onError)[fnName](...args)`.
  - Otherwise (local dev), `fetch()` a URL built from a `BACKEND_ROUTES` map
    (one entry per backend function name → a URL-builder function), parse
    JSON, and treat a JSON body with an `error` key (or a non-2xx status) as
    a failure. Distinguish "no /api route at all" (plain static server, no
    backend running) from "backend running but returned an error" in the
    error message shown to the user.
This is the ONLY place that needs to know which backend is active — every
render function calls `callBackend("getLiveSalesData", [business, filters,
day], onSuccess, onError)` etc. without caring.

============================================================
6. FRONTEND — "LIVE TODAY → SALES" PAGE (the only real page)
============================================================
This page is rebuilt (full innerHTML replace) every time data loads. Layout,
top to bottom, each block its own `.card`:

A) Header card:
   - Title "Live Today — Sales", subtitle line: "Hourly performance, live
     from Google Sheet · <formatted TY date> · <hours summary>" where the
     hours summary is either "hours 00:00–HH:00 (current hour excluded,
     still in progress)" when a partial-hour exclusion applied, or "all 24
     hours (completed day)" otherwise.
   - A small green "ok" tag showing the current business label (top right).
   - A filter/day bar (chip-row style) below the header: "Day:" label + a
     `<select>` populated with the 2 available days (formatted as "D0 (9
     Sept)" / "D-1 (8 Sept)"); then "Filters:" label + one `<select>` per
     filter key (Marketplace, Brand, Alpha/MP, Price Point, Super Category —
     in that order), each defaulting to "All", populated from
     `/api/filter-options`; changing ANY of these (day or filter) re-fetches
     and re-renders the whole page. If any filter ≠ "All", show a small
     "Clear filters" chip that resets them all back to "All" and re-fetches.
   - A 6-column single-row KPI grid (see part B).

B) KPI cards (6, ALL IN ONE ROW — grid-template-columns: repeat(6, 1fr)):
   GMV, Units, ASP, UPI Share, COD Share, PBO Share. Each card: small
   uppercase muted label, large bold value, and a colored YoY badge below
   (▲ green if favorable/positive, ▼ red if negative). GMV/Units/ASP use a
   normal relative "±X.X% YoY" badge; the 3 payment-share cards (already
   percentages) use a PERCENTAGE-POINT delta badge instead ("±X.Xpp YoY" =
   TY share minus LY share, ×100), not a relative %. Do not label these
   cards "LIVE" or show any row-count/debug text anywhere on this page.

C) "HOURLY TREND — OVERALL" card:
   - Header row: title on the left; on the right, an Hourly/Cumulative
     2-button pill toggle (Hourly active by default) immediately followed by
     a metric `<select>` (GMV / Units / ASP).
   - Below: a custom SVG line chart (no charting library) plotting TY (solid
     blue #2563eb) and LY (dashed green #39a66a, dash pattern e.g. 7,5) as
     two lines across a 24-hour x-axis (00:00..23:00 labels, showing every
     ~3rd hour). Y-axis has a numeric "nice-number" grid (4 evenly-spaced
     ticks computed from the data's max value, rounded to a clean 1/2/5×10^n
     step), formatted with the metric's unit (₹ Cr / L / ₹). TY's line always
     stops at the excluded/current hour (later hours are null/no-data, shown
     as a gap, not zero); LY's line always shows the FULL 24 hours.
   - Chart must look smooth/polished, not jagged: use Catmull-Rom-to-Bezier
     smoothing per contiguous run of real data points (so real gaps still
     show as gaps), rounded line caps/joins, ~3px stroke width, and a subtle
     gradient area fill under the TY (first) series only, fading from ~16%
     opacity of its color down to 0 at the baseline. Use a generous internal
     SVG coordinate space (e.g. 1000×340 viewBox) with light, crisp gridlines
     and readable 12px axis labels.
   - HOVER INTERACTIVITY: on mousemove over the chart, show a vertical
     crosshair line at the nearest hour, a small filled dot on each series
     at that hour (skip series with no data at that hour), and a dark
     tooltip near the cursor listing the hour label plus each series' color
     dot + label + formatted value. Hide everything on mouseleave. Implement
     this as an absolutely-positioned HTML overlay (not by mutating SVG
     elements) using the SAME coordinate-scale math as the chart renderer
     (factor the x/y-scale + max/step calculation into one shared function
     used by both the chart-drawing code and the hover-overlay code, so they
     never disagree), converting real mouse pixel coordinates → chart
     viewBox coordinates via a scale factor (viewBox size ÷ rendered
     bounding-rect size).
   - CUMULATIVE TOGGLE: clicking "Cumulative" transforms both series into a
     running/cascading total (sum of all real values so far in that series)
     before plotting — re-render on toggle without re-fetching data. Hours
     with no data yet must stay null (not carry the running sum forward into
     "the future"). Clicking back to "Hourly" restores the raw per-hour
     values. The currently selected metric persists across the toggle.
   - Below the chart: a small legend with two dots — solid blue dot labeled
     with the TY date + "(This Year)" (e.g. "9 Sept (This Year)"), dashed
     green dot labeled with the mapped LY date + "(Last Year)" (e.g.
     "1 Sept (Last Year)") — using the SAME short "D Mon" date formatting as
     the day-select dropdowns (see part F), not raw "YYYYMMDD".

D) "SEGMENT BREAKDOWN — CUMULATIVE TILL HOUR" card:
   - Header shows the hour window ("00:00 → HH:00") on the right.
   - A table with columns: Segment | GMV CY | GMV LY | GMV YoY | Units CY |
     Units LY | Units YoY (GMV in ₹ Cr, Units in Lakhs, YoY as "±X.X%" or
     "N/A" colored green/red).
   - Rows come from the backend's `breakdown` array: 2 TOP-LEVEL rows by
     default (Apparel/Non-Apparel for LS; Alpha/MP for others), each
     collapsed, with a small "▸" toggle in front of the label. Clicking a
     top-level row (or its toggle) expands it in place to reveal its 2
     indented, muted-colored child rows directly beneath it (▸ becomes ▾);
     clicking again collapses them. Children never fetch anything new — they
     come from the same API response.

E) "SUPER CATEGORY BREAKDOWN — CUMULATIVE TILL HOUR" card:
   - Same exact column layout/format as (D), but one flat row per Super
     Category (from the response's top-level `superCategories`, matched to
     its `ly.superCategories` entry by name for the LY/YoY columns — no
     children/expansion here, no separate fetch, just a different slice of
     the same response data).

F) Date formatting: anywhere a sheet date (YYYYMMDD int) is shown to the
   user — day-select options, the chart legend, etc. — format it as a short
   "D Mon" string (e.g. "9 Sept"), never the raw ISO/int form.

Loading / error states for this page (each also full innerHTML replace):
  - While fetching: header card with an amber "⏳ Connecting…" tag and a
    "Loading live GMV/Units data for <business>…" message.
  - No rows returned: header card with a red "⚠ No data" tag, an explanatory
    message naming the business + the sheet business-unit it mapped to, and
    a "Diagnostics" block below fetched from `/api/sales-debug` showing the
    sheet's tabs, resolved header, total rows, max date, and business-unit
    row counts (overall and at the max date) in two side-by-side mini
    tables — so a business-unit-name mismatch is self-diagnosable.
  - Fetch/backend error (e.g. missing credentials): header card with the red
    "⚠ No data" tag and the raw error message, pointing at server/README.md.

============================================================
7. FRONTEND — GLOBAL STATE
============================================================
  CURRENT_BUSINESS (default "LS")
  LIVE_FILTERS = {marketplace, branded, alpha, pricePoint, sc} all "All"
  LIVE_DAY = "D0"
Switching business resets LIVE_FILTERS to all-"All" and LIVE_DAY to "D0",
then re-renders the whole nav (which re-hydrates the Sales page and shows
"Coming Soon" for every other tab).

============================================================
8. "COMING SOON" PAGES (every tab except Live Today → Sales)
============================================================
Each renders a static card: title "<group label> — <tab title>", subtitle
"Not connected to a data source yet", the business tag, an amber "🚧 Coming
Soon" tag, an explanatory callout ("This tab isn't wired to a live data
source yet, so it intentionally shows no numbers instead of illustrative
placeholders. Only Live Today → Sales is currently connected..."), and a
"Planned Metrics" section listing that tab's metric names as plain chips (no
values) — metric names only, defined in js/data.js, e.g. Traffic tab lists
Visits/Direct Visits/Search Visits/etc., Funnel lists PPV/Checkout
Visits/etc., Business Inputs lists Input Price Drop/OOS/SLA/etc., Customer
lists Overall/OO/ON/NN Customers. NEVER fabricate numeric values for these —
the whole point of this app is that only Sales is real.

============================================================
9. BUILD ORDER
============================================================
1. Scaffold index.html (sidebar + empty content mount) + css/style.css
   (design tokens + layout) + js/data.js (nav config, business list, metric
   labels — no numbers) + js/main.js (nav rendering, "Coming Soon" pages).
   Get the shell + business switcher + Coming Soon pages working first.
2. Build server/app.py against a real Google Sheet with the schema in
   section 3 (ask the user for the Sheet ID and to share it with a service
   account, or set up OAuth). Implement `/api/live-sales`,
   `/api/filter-options`, `/api/sales-debug` exactly as in section 4. Add a
   `.claude/launch.json`-style dev-server config (or just document `python3
   server/app.py`) so the whole app serves from one Flask process on :8934.
3. Wire up `callBackend`/`BACKEND_ROUTES` and build the Live Today → Sales
   page per section 6, in this order: KPI cards → segment table → hourly
   chart → filters/day selector → chart hover → cumulative toggle → super
   category table. Test each against the real backend after every step
   (reload the page, verify numbers/interactions in the browser) — don't
   move on with an unverified step.
4. Only after the Flask version is fully correct and visually polished,
   port the identical logic to apps-script/Code.gs (Apps Script backend)
   and the Apps Script HTML templates, so the same frontend can be deployed
   as a Google Apps Script web app via `clasp push && clasp deploy`.

Do not fabricate example data anywhere in the committed code — every number
shown must trace back to a real Sheet read. If the Sheet isn't reachable yet,
show the loading/error/no-data states from section 6, not placeholder
numbers.
````
