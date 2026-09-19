/* ==========================================================================
   DATA REGISTRY — Event Reporting Center
   No fabricated numbers live here. "Live Today > Sales" pulls real GMV/Units
   from the connected Google Sheet (see apps-script/Code.gs getLiveSalesData).
   Every other tab has no data source wired up yet and renders as
   "Coming Soon" — metric names below are only used as placeholder chips
   there, never as displayed values.
   ========================================================================== */

/* Only the event name is fixed; date/day/hour are computed live from the
   browser clock in main.js (renderShellMeta) — no hardcoded calendar here. */
const EVENT_META = {
  name: "Big Billion Days",
};

/* ---------------- MASTER BUSINESS SELECTOR ----------------
   Whole reporting center is scoped to exactly one business at a time.
   `label` is the exact business-unit string as it should be recognized —
   LS is shown/mapped as "LifeStyle" to match the source sheet. */
const BUSINESSES = [
  { key: "LS", label: "LifeStyle" },
  { key: "BGM", label: "BGM" },
  { key: "Home", label: "Home" },
  { key: "Furniture", label: "Furniture" },
];
const DEFAULT_BUSINESS = "LS";

/* Hours shown on the live hourly trend chart (sheet's hour_of_day is 0-23). */
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);

/* ---------------- METRIC REGISTRY (labels only, no mock values) ----------------
   unit: 'rs_cr' | 'cr' | 'l' | 'rs' | 'pct' | 'idx'
   goodDir: 'up' | 'down' — which direction would be favourable, once a data
   source exists; purely descriptive today. */
function M(name, unit, goodDir){ return { name, unit, goodDir }; }

const TAB_CONFIGS = {
  sales: {
    key: "sales", title: "Sales",
    metrics: [ M("GMV", "rs_cr", "up"), M("Units", "l", "up"), M("Orders", "l", "up"), M("ASP", "rs", "up") ],
  },
  traffic: {
    key: "traffic", title: "Traffic",
    metrics: [
      M("Visits", "cr", "up"), M("Direct Visits", "cr", "up"), M("Indirect Visits", "cr", "up"),
      M("Search Visits", "cr", "up"), M("Merch Visits", "cr", "up"), M("Reco Visits", "cr", "up"),
      M("CRM Visits", "cr", "up"), M("Perf Visits", "cr", "up"), M("Reco HP Visits", "cr", "up"),
      M("Reco PP Visits", "cr", "up"), M("WLM", "cr", "up"), M("Infinite", "cr", "up"),
    ],
  },
  funnel: {
    key: "funnel", title: "Funnel",
    metrics: [
      M("Visits", "cr", "up"), M("PPV", "cr", "up"), M("Visits with PPVs", "cr", "up"),
      M("Visits with CABN", "cr", "up"), M("Checkout Visits", "cr", "up"), M("Summary Visits", "cr", "up"),
      M("Payment Visits", "cr", "up"), M("Order Visits", "cr", "up"),
    ],
  },
  inputs: {
    key: "inputs", title: "CVP Inputs",
    metrics: [
      M("Output Price Drop", "pct", "down"), M("Input Price Drop", "pct", "down"),
    ],
  },
  customer: {
    key: "customer", title: "Customer",
    metrics: [ M("Overall Customers", "l", "up"), M("OO Customers", "l", "up"), M("ON Customers", "l", "up"), M("NN Customers", "l", "up") ],
  },
};

const TAB_CONFIGS_EXTRA = {
  rca: { key: "rca", title: "RCA" },
};
Object.assign(TAB_CONFIGS, TAB_CONFIGS_EXTRA);

const NAV_GROUPS = [
  { id: "live", label: "Live Today", tabs: ["sales", "traffic", "funnel", "inputs", "rca"] },
  { id: "event", label: "Event Summary", tabs: ["sales", "traffic", "funnel", "inputs", "customer"] },
];

/* Only these exact pages are wired to a real data source today. */
const LIVE_PAGE_ID         = "live-sales";
const FUNNEL_PAGE_ID       = "live-funnel";
const TRAFFIC_PAGE_ID      = "live-traffic";
const CVP_PAGE_ID_KEY      = "live-inputs";
const RCA_PAGE_ID          = "live-rca";
const SUMMARY_SALES_PAGE_ID = "event-sales";
