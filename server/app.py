#!/usr/bin/env python3
"""
Local dev backend for the Event Reporting Center — mirrors apps-script/Code.gs
so `Live Today > Sales` shows real, live Google Sheet data when running
locally (not just when deployed to Apps Script). Same JSON response shape as
Code.gs's getLiveSalesData()/getSalesDebugInfo(), consumed by js/main.js via
the same callBackend() abstraction that also supports google.script.run.

Setup: see server/README.md. Supports two auth modes (checked in this order):
  1. Service account (server/service-account.json) — the Sheet must be shared
     with that service account's client_email as a Viewer. No browser step.
  2. OAuth "Desktop app" client (server/credentials.json) — authenticates as
     you; one-time browser consent, then caches server/token.json.
Run:   python3 server/app.py        (serves the whole app on :8934)
"""
import os
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

# Load .env from project root if present (ANTHROPIC_API_KEY etc.)
_env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = Path(__file__).resolve().parent
SERVICE_ACCOUNT_PATH = SERVER_DIR / "service-account.json"
CREDENTIALS_PATH = SERVER_DIR / "credentials.json"
TOKEN_PATH = SERVER_DIR / "token.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Keep these in sync with apps-script/Code.gs's constants of the same name.
SALES_SHEET_ID = "1v3XKlF7YIgAQkeJd-sFxGTh1rrsJ1htCCNTJdszT1f0"
SALES_SHEET_TAB_NAME = "Hourly_sales_2026"
LY_SHEET_TAB_NAME = "Hourly_sales_2025"
DAILY_CY_TAB = "Daily_sales_2026"   # Event Summary Sales — CY, on SALES_SHEET_ID
DAILY_LY_TAB = "Daily_sales_2025"   # Event Summary Sales — LY, on SALES_SHEET_ID
DAILY_CY_START = 20260910           # BBD 2026 starts 10 Sept
DAILY_LY_START = 20250825           # BBD 2025 starts 25 Aug
# BAU lives in FUNNEL_LY_SHEET_ID (sheet 1zaFYp...), tab "BAU sales"
BAU_SHEET_TAB_NAME = "BAU sales"
BAU_SHEET_ID_KEY = "funnel_ly"      # read via get_funnel_sheet_values with FUNNEL_LY_SHEET_ID
# BAU sheet has no date column — gmv/units per row are already totals across
# this many days (CY = 8 days this year, LY = 11 days last year), so every
# BAU sum must be divided by the matching day count to get a per-day average.
BAU_DAY_COUNTS = {"cy": 8, "ly": 11}
BUSINESS_SHEET_MAP = {"LS": "LifeStyle", "BGM": "BGM", "Home": "Home", "Furniture": "Furniture"}

FILTER_KEYS = ("marketplace", "branded", "alpha", "pricePoint", "sc")
# query-string key -> sheet column name
FILTER_COLS = {
    "marketplace": "marketplace_id",
    "branded": "branded_flag",
    "alpha": "is_alpha_seller",
    "pricePoint": "asp_bucket",
    "sc": "analytic_super_category",
}
EXCLUDED_SUPER_CATEGORIES: set = set()  # all SCs included

AGGREGATE_CACHE_TTL = 300   # seconds — matches Code.gs's CacheService TTL
SHEET_READ_CACHE_TTL = 120  # seconds — raw sheet read is the expensive part

# ---------------- LIVE FUNNEL (two separate spreadsheets — CY grains live in
# FUNNEL_SHEET_ID, BU/SC-level LY grains live in FUNNEL_LY_SHEET_ID). Funnel and
# Traffic metrics are not additive across grains, so each grain (BU / Alpha-MP /
# SC / SC x Alpha-MP) has its own dedicated CY+LY tab pair — no summing across
# tabs of different grains. No marketplace/brand/price-point columns exist at
# any of these grains, so filters and the BAU-spike columns aren't available here.
FUNNEL_SHEET_ID = "16ukoxs3ZbTmo3STUIokbwSo141HpKhmo5YhQ-im3E1Y"
FUNNEL_LY_SHEET_ID = "1zaFYp_PE0jIlRZjC_As18xLLAFCJM2qaitc_3sMt63Y"

FUNNEL_CY_TAB = "BU_Hourly_Funnel_CY"                      # FUNNEL_SHEET_ID — BU level, CY
FUNNEL_LY_TAB = "BU_Hourly_funnel_LY"                      # FUNNEL_LY_SHEET_ID — BU level, LY
FUNNEL_SEGMENT_CY_TAB = "BUxA_MP_Hourly_Funnel_CY"         # FUNNEL_SHEET_ID — Alpha/MP level, CY
FUNNEL_SEGMENT_LY_TAB = "BUxA_MP_Hourly__Funnel_LY"        # FUNNEL_SHEET_ID — Alpha/MP level, LY
FUNNEL_SC_CY_TAB = "SC_Hourly_Funnel_CY"                   # FUNNEL_SHEET_ID — SC level, CY
FUNNEL_SC_LY_TAB = "SC_Hourly__Funnel_LY"                  # FUNNEL_LY_SHEET_ID — SC level, LY
FUNNEL_SC_ALPHA_CY_TAB = "SCxA_MP_Hourly_Funnel_CY"        # FUNNEL_SHEET_ID — SC x Alpha/MP level, CY
FUNNEL_SC_ALPHA_LY_TAB = "SCxA_MP_Hourly_Funnel_LY"        # FUNNEL_LY_SHEET_ID — SC x Alpha/MP level, LY

# Daily funnel tabs (Event Summary Funnel) — all 8 live in FUNNEL_SHEET_ID
FUNNEL_DAILY_BU_CY_TAB       = "BU_Daily_Funnel_CY"
FUNNEL_DAILY_SEG_CY_TAB      = "BUxA_MP_Daily__Funnel_CY"
FUNNEL_DAILY_SC_CY_TAB       = "SC_Daily_Funnel_CY"
FUNNEL_DAILY_SC_ALPHA_CY_TAB = "SCxA_MP_Daily__Funnel_CY"
FUNNEL_DAILY_BU_LY_TAB       = "BU_Daily_Funnel_LY"
FUNNEL_DAILY_SEG_LY_TAB      = "BUxA_MP_Daily__Funnel_LY"
FUNNEL_DAILY_SC_LY_TAB       = "SC_Daily_Funnel_LY"
FUNNEL_DAILY_SC_ALPHA_LY_TAB = "SCxA_MP_Daily__Funnel_LY"

FUNNEL_DAILY_SC_EXCLUDE = {"LifeStyle", "NA", "MensClothingCasualTopwear", "WomenAccessory", "MenAccessory"}

# TY <-> LY date correspondence isn't a fixed offset (event calendars don't
# align day-for-day) — resolved per-date from this authoritative mapping tab.
FUNNEL_DATE_MAP_TAB = "Date Mapping"                       # FUNNEL_LY_SHEET_ID

# ---------------- TRAFFIC — CY tabs in FUNNEL_SHEET_ID, LY tabs in TRAFFIC_LY_SHEET_ID.
TRAFFIC_BU_CY_TAB        = "BU_Hourly_Traffic_CY"
TRAFFIC_ALPHA_CY_TAB     = "BUxA_MP_Hourly_Traffic_CY"
TRAFFIC_SC_CY_TAB        = "SC_Hourly_Traffic_CY"
TRAFFIC_SC_ALPHA_CY_TAB  = "SCxA_MP_Hourly_Traffic_CY"

TRAFFIC_LY_SHEET_ID      = "1WgaSUWQkGbWVPUXAFj7IEHumVskp0DNTWGlv__hhKWE"
TRAFFIC_BU_LY_TAB        = "BU_Hourly_Traffic_LY"
TRAFFIC_ALPHA_LY_TAB     = "BUxA_MP_Hourly_Traffic_LY"
TRAFFIC_SC_LY_TAB        = "SC_Hourly_Traffic_LY"
TRAFFIC_SC_ALPHA_LY_TAB  = "SCxA_MP_Hourly_Traffic_LY"

# LY sheet uses different column names and 12-hour event_time instead of hour int.
# CY col -> LY col mapping (None = computed or same key logic applies)
TRAFFIC_METRICS = [
    ("visits",    "bu_visits",                  "Visits"),
    ("direct",    None,                         "Direct Visits"),   # computed: visits - indirect
    ("indirect",  "indirect_bu_visits",         "Indirect Visits"),
    ("search",    "fm_search_bu_visits",        "Search Visits"),
    ("merch",     "fm_merch_bu_visits",         "Merch Visits"),
    ("reco",      "fm_reco_bu_visits",          "Reco Visits"),
    ("crm",       "crm_bu_visits",              "CRM Visits"),
    ("perf",      "perf_bu_visits",             "Perf Visits"),
    ("reco_hp",   "hp_reco_overall_bu_visits",  "Reco HP Visits"),
    ("reco_pp",   "pp_reco_overall_bu_visits",  "Reco PP Visits"),
    ("wlm",       "pn_bu_visits",               "WLM"),
    ("infinite",  "infinite_bu_visits",         "Infinite"),
]
TRAFFIC_METRIC_KEYS = [m[0] for m in TRAFFIC_METRICS]

# LY column names differ from CY
TRAFFIC_LY_COL_MAP = {
    "bu_visits":                 "bu_visits",
    "indirect_bu_visits":        "indirect_bu_visits",
    "fm_search_bu_visits":       "search_bu_visits",
    "fm_merch_bu_visits":        "merch_bu_visits",
    "fm_reco_bu_visits":         "reco_bu_visits",
    "crm_bu_visits":             "crm_bu_visits",
    "perf_bu_visits":            "perf_bu_visits",
    "hp_reco_overall_bu_visits": "hp_reco_bu_visits",
    "pp_reco_overall_bu_visits": "pp_reco_bu_visits",
    "pn_bu_visits":              "pn_bu_visits",
    "infinite_bu_visits":        "infinite_bu_visits",
}

# ---------------- CVP INPUTS
CVP_SHEET_ID  = "12yGRArgcV7zpJ041k7sMrx6_3cGDHWAFzYiHurl3eKI"
CVP_CY_TAB    = "CY D0"
CVP_LY_TAB    = "LY D0"
# output_price_drop = sum(op_cur_asp)/sum(op_bau_asp) - 1
# input_price_drop  = sum(ip_cur_asp)/sum(ip_bau_asp) - 1

# (metricKey, cyColumn, lyColumn, label) — the 6 KPI/chart/table metrics.
FUNNEL_METRICS = [
    ("visits", "bu_visits", "r_bu_visits_hllpp", "Visits"),
    ("ppv", "ppvs", "ppvs", "PPV"),
    ("ppvVisits", "visits_with_ppvs", "r_visits_with_ppvs_hllpp", "Visits with PPV"),
    ("cabn", "visits_with_cabn", "r_visits_with_cabn_hllpp", "CABN Visits"),
    ("checkout", "visits_with_checkout_init", "r_visits_with_checkout_hllpp", "Checkout Visits"),
    ("summary", "visits_with_summary", "r_visits_with_summary_hllpp", "Summary Visits"),
    # LY has no "visits_with_payments" column; "summary_continue" (visits that
    # progressed past the summary step) is the closest available proxy.
    ("payment", "visits_with_payments", "r_visits_with_summary_continue_hllpp", "Payment Visits"),
    ("orders", "visits_with_orders", "r_visits_with_orders_hllpp", "Order Visits"),
]
FUNNEL_METRIC_KEYS = [m[0] for m in FUNNEL_METRICS]
# The two metrics shown (CY/LY/YoY) in the segment + super-category breakdown
# tables — mirrors Sales' GMV+Units as the "top of funnel" / "bottom of funnel" pair.
FUNNEL_BREAKDOWN_METRICS = ("visits", "orders")

_aggregate_cache = {}   # cache_key tuple -> (timestamp, result)
_sheet_cache = {}       # tab_name -> {"ts": ..., "values": ...}

app = Flask(__name__, static_folder=None)


def get_credentials():
    """Service account (preferred, no browser step) if present, else OAuth as
    the developer's own account (one-time browser consent, then cached)."""
    if SERVICE_ACCOUNT_PATH.exists():
        return service_account.Credentials.from_service_account_file(str(SERVICE_ACCOUNT_PATH), scopes=SCOPES)

    creds = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(GoogleRequest())
        else:
            if not CREDENTIALS_PATH.exists():
                raise RuntimeError(
                    "Missing server/service-account.json (or server/credentials.json for the "
                    "OAuth flow instead) — see server/README.md."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_PATH.write_text(creds.to_json())
    return creds


def get_sheet_values(tab_name, force=False):
    now = time.time()
    cache = _sheet_cache.setdefault(tab_name, {"ts": 0, "values": None})
    if not force and cache["values"] is not None and now - cache["ts"] < SHEET_READ_CACHE_TTL:
        return cache["values"]
    creds = get_credentials()
    service = build("sheets", "v4", credentials=creds)
    result = service.spreadsheets().values().get(
        spreadsheetId=SALES_SHEET_ID, range=f"'{tab_name}'"
    ).execute()
    values = result.get("values", [])
    cache["values"] = values
    cache["ts"] = now
    return values


def get_funnel_sheet_values(tab_name, sheet_id=FUNNEL_SHEET_ID, force=False):
    """Same caching pattern as get_sheet_values, but against a Funnel workbook
    (CY grains and LY grains live in two different spreadsheets)."""
    cache_key = f"funnel::{sheet_id}::{tab_name}"
    now = time.time()
    cache = _sheet_cache.setdefault(cache_key, {"ts": 0, "values": None})
    if not force and cache["values"] is not None and now - cache["ts"] < SHEET_READ_CACHE_TTL:
        return cache["values"]
    creds = get_credentials()
    service = build("sheets", "v4", credentials=creds)
    result = service.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=f"'{tab_name}'"
    ).execute()
    values = result.get("values", [])
    cache["values"] = values
    cache["ts"] = now
    return values


def get_funnel_date_map():
    """dates_current_year -> dates_last_year, from the authoritative Date
    Mapping tab (not a fixed offset — event calendars don't align day-for-day)."""
    values = get_funnel_sheet_values(FUNNEL_DATE_MAP_TAB, sheet_id=FUNNEL_LY_SHEET_ID)
    if not values:
        return {}
    header = [str(h).strip() for h in values[0]]
    cy_idx, ly_idx = header.index("dates_current_year"), header.index("dates_last_year")
    return {
        int(row[cy_idx]): int(row[ly_idx])
        for row in values[1:] if len(row) > max(cy_idx, ly_idx) and row[cy_idx] and row[ly_idx]
    }


def _cell(row, i):
    return row[i] if 0 <= i < len(row) else ""


def _num(row, i):
    try:
        return float(_cell(row, i) or 0)
    except (TypeError, ValueError):
        return 0.0


def _int(row, i):
    try:
        return int(float(_cell(row, i) or 0))
    except (TypeError, ValueError):
        return 0


def resolve_columns(header):
    def idx(name):
        return header.index(name) if name in header else -1
    return {
        "date": idx("order_date_key"), "hour": idx("hour_of_day"),
        "bu": idx("analytic_business_unit"), "sc": idx("analytic_super_category"),
        "megaCat": idx("mega_cat"),
        "gmv": idx("gmv"), "units": idx("units"),
        "upi": idx("upi_units"), "cod": idx("cod_units"), "pbo": idx("pbo_units"), "others": idx("others_units"),
        "marketplace": idx(FILTER_COLS["marketplace"]),
        "branded": idx(FILTER_COLS["branded"]),
        "alpha": idx(FILTER_COLS["alpha"]),
        "pricePoint": idx(FILTER_COLS["pricePoint"]),
    }


def row_passes_filters(row, col, filters):
    for key in FILTER_KEYS:
        want = filters.get(key)
        if not want or want == "All":
            continue
        val = str(_cell(row, col[key])).strip()
        if key == "pricePoint":
            val = _norm_pp(val)
        if val != want:
            return False
    return True


def sc_excluded(row, col):
    return str(_cell(row, col.get("sc", -1))).strip() in EXCLUDED_SUPER_CATEGORIES


def distinct_dates(values, col):
    dates = set()
    for row in values[1:]:
        d = _int(row, col["date"])
        if d:
            dates.add(d)
    return sorted(dates)


def max_hour_for_date(values, col, date_key):
    """Latest hour_of_day present for a date, across ALL rows (not just the
    filtered/business subset) — the event's most recent hour is still
    accumulating regardless of which business/filter slice you're looking at."""
    hours = [_int(row, col["hour"]) for row in values[1:] if _int(row, col["date"]) == date_key]
    return max(hours) if hours else None


MC_DISPLAY_NAMES = {
    "MC_Branded":   "Mens Clothing Branded",
    "MC_UnBranded": "Mens Clothing Unbranded",
    "WomenEthinc":  "Women Ethnic",
    "WomenWestern": "Women Western",
    "KidClothing":  "Kid Clothing",
    "Others":       None,   # drop "Others" megacat
}

# SC → MegaCat mapping for funnel (the funnel SC tab has no mega_cat column)
SC_TO_MC = {
    "MensClothingTopwearBranded":       "Mens Clothing Branded",
    "MensClothingBottomwearBranded":    "Mens Clothing Branded",
    "MensEssentialsEthnicBranded":      "Mens Clothing Branded",
    "MensSeasonalWinterBranded":        "Mens Clothing Branded",
    "MensClothingTopwearUnbranded":     "Mens Clothing Unbranded",
    "MensClothingBottomwearUnbranded":  "Mens Clothing Unbranded",
    "MensEssentialsEthnicUnbranded":    "Mens Clothing Unbranded",
    "MensSeasonalWinterUnbranded":      "Mens Clothing Unbranded",
    "WomenEthnicCore":                  "Women Ethnic",
    "WomenEthnicContemporary":          "Women Ethnic",
    "WomenWesternCore":                 "Women Western",
    "WomenWesternGrowth":               "Women Western",
    "KidClothing":                      "Kid Clothing",
}

def _mc_display(name):
    """Normalise megacat display name; returns None to drop the row."""
    return MC_DISPLAY_NAMES.get(name, name)


def aggregate_rows(values, col, target_bu, filters, date_key, hour_limit=None):
    """hour_limit: if set, only hours STRICTLY LESS than this are included
    (used to drop the partial in-progress hour, and to align LY to the same
    day-till-hour window as TY for a fair comparison)."""
    overall_by_hour = {}
    sc_data = {}
    mc_data = {}
    total_gmv = total_units = total_upi = total_cod = total_pbo = total_others = row_count = 0

    for row in values[1:]:
        if _int(row, col["date"]) != date_key:
            continue
        hr = _int(row, col["hour"])
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if not row_passes_filters(row, col, filters):
            continue
        if sc_excluded(row, col):
            continue

        gmv = _num(row, col["gmv"])
        units = _num(row, col["units"])
        upi = _num(row, col["upi"])
        cod = _num(row, col["cod"])
        pbo = _num(row, col["pbo"])
        others = _num(row, col["others"])
        sc_name = str(_cell(row, col["sc"]) or "Other").strip()
        mc_raw  = str(_cell(row, col["megaCat"]) or "Other").strip()
        mc_name = _mc_display(mc_raw)
        pp_name = _norm_pp(str(_cell(row, col.get("pricePoint", -1)) or "").strip()) or None

        oh = overall_by_hour.setdefault(hr, {"gmv": 0, "units": 0})
        oh["gmv"] += gmv
        oh["units"] += units

        scd = sc_data.setdefault(sc_name, {"gmv": 0, "units": 0, "byHour": {}, "payment": {"upi": 0, "cod": 0, "pbo": 0, "others": 0}, "pricePoints": {}})
        scd["gmv"] += gmv
        scd["units"] += units
        scd["payment"]["upi"] += upi
        scd["payment"]["cod"] += cod
        scd["payment"]["pbo"] += pbo
        scd["payment"]["others"] += others
        sh = scd["byHour"].setdefault(hr, {"gmv": 0, "units": 0})
        sh["gmv"] += gmv
        sh["units"] += units
        if pp_name:
            pp = scd["pricePoints"].setdefault(pp_name, {"gmv": 0, "units": 0})
            pp["gmv"] += gmv; pp["units"] += units

        if mc_name is not None:  # skip "Others"
            mcd = mc_data.setdefault(mc_name, {"gmv": 0, "units": 0, "byHour": {}, "payment": {"upi": 0, "cod": 0, "pbo": 0, "others": 0}, "pricePoints": {}})
            mcd["gmv"] += gmv
            mcd["units"] += units
            mcd["payment"]["upi"] += upi
            mcd["payment"]["cod"] += cod
            mcd["payment"]["pbo"] += pbo
            mcd["payment"]["others"] += others
            mh = mcd["byHour"].setdefault(hr, {"gmv": 0, "units": 0})
            mh["gmv"] += gmv
            mh["units"] += units
            if pp_name:
                pp = mcd["pricePoints"].setdefault(pp_name, {"gmv": 0, "units": 0})
                pp["gmv"] += gmv; pp["units"] += units

        total_gmv += gmv
        total_units += units
        total_upi += upi
        total_cod += cod
        total_pbo += pbo
        total_others += others
        row_count += 1

    def to_hourly(by_hour):
        return [{"hour": h, "gmv": by_hour[h]["gmv"], "units": by_hour[h]["units"]} for h in sorted(by_hour)]

    sc_sorted = sorted(sc_data.items(), key=lambda kv: -kv[1]["gmv"])
    mc_sorted = sorted(mc_data.items(), key=lambda kv: -kv[1]["gmv"])
    return {
        "dateKey": date_key, "rowCount": row_count,
        "totalGmv": total_gmv, "totalUnits": total_units,
        "paymentUnits": {"upi": total_upi, "cod": total_cod, "pbo": total_pbo, "others": total_others},
        "hourly": to_hourly(overall_by_hour),
        "superCategories": [
            {
                "name": name, "gmv": v["gmv"], "units": v["units"], "hourly": to_hourly(v["byHour"]),
                "paymentShare": payment_shares(v["payment"], v["units"]),
                "pricePoints": sorted(
                    [{"name": pp, "gmv": pv["gmv"], "units": pv["units"]} for pp, pv in v.get("pricePoints", {}).items()],
                    key=lambda r: r["name"]
                ),
            }
            for name, v in sc_sorted
        ],
        "megaCategories": [
            {
                "name": name, "gmv": v["gmv"], "units": v["units"], "hourly": to_hourly(v["byHour"]),
                "paymentShare": payment_shares(v["payment"], v["units"]),
                "pricePoints": sorted(
                    [{"name": pp, "gmv": pv["gmv"], "units": pv["units"]} for pp, pv in v.get("pricePoints", {}).items()],
                    key=lambda r: r["name"]
                ),
            }
            for name, v in mc_sorted
        ],
    }


# SCs classified as "Apparel" for LifeStyle's breakdown table (everything else is "Non-Apparel").
LS_APPAREL_SC = {
    "FashionWearables", "KidsFootwear", "LuggageAndTravelAccessories",
    "MensCnFFootwear", "MensOpenFootwear", "MensSportsFootwear", "WomenFW",
}
ALPHA_VALUE = "Diamond"
MP_VALUE = "Rest of MP"


def sum_rows(values, col, target_bu, filters, date_key, hour_limit, extra_ok):
    gmv = units = 0
    for row in values[1:]:
        if _int(row, col["date"]) != date_key:
            continue
        hr = _int(row, col["hour"])
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if not row_passes_filters(row, col, filters):
            continue
        if sc_excluded(row, col):
            continue
        if not extra_ok(row, col):
            continue
        gmv += _num(row, col["gmv"])
        units += _num(row, col["units"])
    return {"gmv": gmv, "units": units}


def resolve_bau_columns(header):
    """BAU sheet has no order_date_key — one row per (bau_year, hour_of_day,
    dimensions) is already the TOTAL across the whole BAU period, not a single
    day, so there's no per-row date to key on."""
    def idx(name):
        return header.index(name) if name in header else -1
    return {
        "year": idx("bau_year"), "hour": idx("hour_of_day"),
        "bu": idx("analytic_business_unit"), "sc": idx("analytic_super_category"),
        "megaCat": idx("mega_cat"),
        "gmv": idx("gmv"), "units": idx("units"),
        "marketplace": idx(FILTER_COLS["marketplace"]),
        "branded": idx(FILTER_COLS["branded"]),
        "alpha": idx(FILTER_COLS["alpha"]),
        "pricePoint": idx(FILTER_COLS["pricePoint"]),
    }


def bau_years(values, col):
    """(cyYear, lyYear) = (max, min) of the distinct bau_year values present —
    resolved dynamically so the sheet's actual year numbers don't need to be
    hardcoded here."""
    years = set()
    for row in values[1:]:
        y = str(_cell(row, col["year"])).strip()
        if y:
            try:
                years.add(int(float(y)))
            except ValueError:
                pass
    if not years:
        return None, None
    return max(years), min(years)


def bau_sum(values, col, target_bu, filters, year, hour_limit, extra_ok=None):
    gmv = units = 0
    for row in values[1:]:
        if str(_cell(row, col["year"])).strip() != str(year):
            continue
        hr = _int(row, col["hour"])
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if not row_passes_filters(row, col, filters):
            continue
        if sc_excluded(row, col):
            continue
        if extra_ok and not extra_ok(row, col):
            continue
        gmv += _num(row, col["gmv"])
        units += _num(row, col["units"])
    return {"gmv": gmv, "units": units}


def bau_per_day(values, col, target_bu, filters, year, day_count, hour_limit, extra_ok=None):
    totals = bau_sum(values, col, target_bu, filters, year, hour_limit, extra_ok)
    return {
        "gmv": totals["gmv"] / day_count if day_count else None,
        "units": totals["units"] / day_count if day_count else None,
    }


def spike_ratio(actual, per_day):
    if not per_day:
        return None
    return actual / per_day


# Normalize old asp_bucket labels to the current scheme.
PP_ALIAS = {
    "a) 0-500":   "a) 0-300",
    "b) 501-1k":  "c) 501-1000",
    "c) 1k-2.5k": "d) 1001-2500",
    "d) 1000+":   "d) 1001-2500",
    "d) 2.5k-5k": "e) 2500+",
    "e) 5k-7.5k": "e) 2500+",
    "f) 7.5k-10k":"e) 2500+",
    "g) 10k-15k": "e) 2500+",
    "h) 15k+":    "e) 2500+",
    "others":     None,          # drop "others" entirely
}

def _norm_pp(v):
    """Returns normalized bucket label, or None if the bucket should be dropped."""
    return PP_ALIAS.get(v, v)  # returns None for "others" via PP_ALIAS


def _get_price_points(values, col):
    """Collect distinct (normalized) asp_bucket labels that have gmv > 0."""
    pp_idx = col.get("pricePoint", -1)
    gmv_idx = col.get("gmv", -1)
    if pp_idx < 0: return []
    seen = set()
    for row in values[1:]:
        v = str(_cell(row, pp_idx)).strip()
        if not v or v == "nan": continue
        try:
            if gmv_idx >= 0 and float(row[gmv_idx] or 0) <= 0: continue
        except (ValueError, IndexError):
            continue
        normed = _norm_pp(v)
        if normed is not None:
            seen.add(normed)
    return sorted(seen)


def breakdown_segments(business_key, values=None, col=None):
    """Top-level (label, predicate, [(childLabel, childPredicate, [(grandLabel, grandPredicate)])]) triples.
    3 levels: segment → alpha/BMP/UMP → price point."""
    is_alpha    = lambda row, c: str(_cell(row, c["alpha"])).strip() == ALPHA_VALUE
    is_mp       = lambda row, c: str(_cell(row, c["alpha"])).strip() == MP_VALUE
    is_branded  = lambda row, c: str(_cell(row, c["branded"])).strip() == "Branded"
    is_unbranded= lambda row, c: str(_cell(row, c["branded"])).strip() == "Unbranded"
    is_bmp      = lambda row, c: is_mp(row, c) and is_branded(row, c)
    is_ump      = lambda row, c: is_mp(row, c) and is_unbranded(row, c)

    price_points = _get_price_points(values, col) if values and col else []

    def pp_children(parent_pred):
        return [(pp, lambda row, c, p=pp, pred=parent_pred:
                    pred(row, c) and _norm_pp(str(_cell(row, c.get("pricePoint",-1))).strip()) == p, [])
                for pp in price_points]

    if business_key == "LS":
        is_apparel = lambda row, c: str(_cell(row, c["sc"])).strip() in LS_APPAREL_SC
        is_non_apparel = lambda row, c: not is_apparel(row, c)
        return [
            ("Apparel", is_apparel, [
                ("Alpha", lambda row, c: is_apparel(row, c) and is_alpha(row, c), pp_children(lambda row, c: is_apparel(row, c) and is_alpha(row, c))),
                ("BMP",   lambda row, c: is_apparel(row, c) and is_bmp(row, c),  pp_children(lambda row, c: is_apparel(row, c) and is_bmp(row, c))),
                ("UMP",   lambda row, c: is_apparel(row, c) and is_ump(row, c),  pp_children(lambda row, c: is_apparel(row, c) and is_ump(row, c))),
            ]),
            ("Non-Apparel", is_non_apparel, [
                ("Alpha", lambda row, c: is_non_apparel(row, c) and is_alpha(row, c), pp_children(lambda row, c: is_non_apparel(row, c) and is_alpha(row, c))),
                ("BMP",   lambda row, c: is_non_apparel(row, c) and is_bmp(row, c),  pp_children(lambda row, c: is_non_apparel(row, c) and is_bmp(row, c))),
                ("UMP",   lambda row, c: is_non_apparel(row, c) and is_ump(row, c),  pp_children(lambda row, c: is_non_apparel(row, c) and is_ump(row, c))),
            ]),
        ]
    # BGM / Home / Furniture — Alpha → price points; MP → Branded/Unbranded → price points
    return [
        ("Alpha", is_alpha, pp_children(is_alpha)),
        ("MP", is_mp, [
            ("Branded MP",   is_bmp, pp_children(is_bmp)),
            ("Unbranded MP", is_ump, pp_children(is_ump)),
        ]),
    ]


def compute_breakdown(business_key, ty_values, ty_col, target_bu, filters, ty_date, ty_hour_limit,
                       ly_values, ly_col, ly_date, ly_hour_limit,
                       bau_values=None, bau_col=None, bau_cy_year=None, bau_ly_year=None):
    def row_for(label, predicate):
        ty = sum_rows(ty_values, ty_col, target_bu, filters, ty_date, ty_hour_limit, predicate)
        ly = {"gmv": 0, "units": 0}
        if ly_values is not None and ly_date is not None:
            ly = sum_rows(ly_values, ly_col, target_bu, filters, ly_date, ly_hour_limit, predicate)
        row = {"label": label, "tyGmv": ty["gmv"], "tyUnits": ty["units"], "lyGmv": ly["gmv"], "lyUnits": ly["units"]}
        if bau_values is not None and bau_cy_year is not None:
            cy_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_cy_year, BAU_DAY_COUNTS["cy"], ty_hour_limit, predicate)
            ly_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_ly_year, BAU_DAY_COUNTS["ly"], ty_hour_limit, predicate)
            row["cyGmvSpike"] = spike_ratio(ty["gmv"], cy_bau["gmv"])
            row["lyGmvSpike"] = spike_ratio(ly["gmv"], ly_bau["gmv"])
            row["cyUnitsSpike"] = spike_ratio(ty["units"], cy_bau["units"])
            row["lyUnitsSpike"] = spike_ratio(ly["units"], ly_bau["units"])
        else:
            row["cyGmvSpike"] = row["lyGmvSpike"] = row["cyUnitsSpike"] = row["lyUnitsSpike"] = None
        return row

    rows = []
    for label, predicate, children in breakdown_segments(business_key, ty_values, ty_col):
        row = row_for(label, predicate)
        child_rows = []
        for clabel, cpredicate, grandchildren in children:
            child_row = row_for(clabel, cpredicate)
            child_row["children"] = [row_for(glabel, gpredicate) for glabel, gpredicate, *_ in grandchildren]
            child_rows.append(child_row)
        row["children"] = child_rows
        rows.append(row)
    return rows


def payment_shares(payment_units, total_units):
    if not total_units:
        return {"upi": None, "cod": None, "pbo": None, "others": None}
    return {k: v / total_units for k, v in payment_units.items()}


def available_days(ty_dates):
    """The raw sheet only spans 2 days: D0 = the most recent (today, still live),
    D-1 = the day before (already complete). Returned newest-first."""
    days = []
    if ty_dates:
        days.append({"key": "D0", "dateKey": ty_dates[-1]})
    if len(ty_dates) > 1:
        days.append({"key": "D-1", "dateKey": ty_dates[-2]})
    return days


def resolve_funnel_cy_columns(header):
    """Shared by BU_Hourly_Funnel_CY, BUxA_MP_Hourly_Funnel_CY (+ seller_type)
    and SC_Hourly_Funnel_CY (+ super_category) — all three use the same date/
    hour/business_unit/metric column names."""
    def idx(name):
        return header.index(name) if name in header else -1
    cols = {
        "date": idx("date"), "hour": idx("hour"), "bu": idx("business_unit"),
        "sellerType": idx("seller_type"), "sc": idx("super_category"),
    }
    for key, cy_name, ly_name, label in FUNNEL_METRICS:
        cols[key] = idx(cy_name)
    return cols


def resolve_funnel_ly_columns(header):
    def idx(name):
        return header.index(name) if name in header else -1
    cols = {
        "dateTime": idx("day_time_key"), "hour": idx("hour"), "bu": idx("business_unit"),
        "sellerType": idx("seller_type"), "sc": idx("super_category"),
    }
    for key, cy_name, ly_name, label in FUNNEL_METRICS:
        cols[key] = idx(ly_name)
    return cols


def resolve_funnel_daily_columns(header):
    """Shared by all 8 daily funnel tabs (CY and LY) — no hour column.
    Both CY and LY daily tabs use the same metric column names (CY names)."""
    def idx(name): return header.index(name) if name in header else -1
    cols = {
        "dateTime": idx("day_time_key"), "date": idx("date"),
        "hour": -1,  # no hour in daily tabs
        "bu": idx("business_unit"),
        "sellerType": idx("seller_type"), "sc": idx("super_category"),
    }
    for key, cy_name, ly_name, label in FUNNEL_METRICS:
        cols[key] = idx(ly_name)   # daily tabs use r_*_hllpp names (same as LY hourly)
    return cols


def aggregate_funnel_daily_rows(values, col, target_bu, seller_filter=None, sc_filter=None):
    """Aggregate all rows for target_bu across all event dates (date >= DAILY_CY_START
    for CY tabs, or from a set of valid LY dates for LY tabs).
    Returns totals + per-date daily list sorted by dateIso."""
    totals = {k: 0 for k in FUNNEL_METRIC_KEYS}
    daily_by_date = {}   # dateIso -> {k: 0 ...}
    row_count = 0

    for row in values[1:]:
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col["sellerType"])).strip() != seller_filter:
            continue
        if sc_filter and str(_cell(row, col.get("sc", -1))).strip() != sc_filter:
            continue
        raw_dt = str(_cell(row, col["dateTime"]))
        if not raw_dt or raw_dt.lower() == "nan":
            continue
        date_iso = raw_dt[:10]  # "YYYY-MM-DD" prefix from ISO timestamp
        d = daily_by_date.setdefault(date_iso, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for key in FUNNEL_METRIC_KEYS:
            v = _num(row, col[key])
            d[key] += v
            totals[key] += v
        row_count += 1

    daily = [dict({"dateIso": iso}, **daily_by_date[iso]) for iso in sorted(daily_by_date)]
    return {"rowCount": row_count, "totals": totals, "daily": daily}


def aggregate_funnel_daily_rows_cy(values, col, target_bu, seller_filter=None, sc_filter=None, single_date_int=None):
    """Like aggregate_funnel_daily_rows but restricts to dates >= DAILY_CY_START.
    When single_date_int is set, restricts to exactly that date.
    Deduplicates by (dateIso, sellerType, sc) — pipeline sometimes writes identical rows twice."""
    # keyed_rows: dedup key -> metric dict (last write wins for identical rows)
    keyed_rows = {}

    for row in values[1:]:
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        date_int = _int(row, col["date"])
        if single_date_int is not None:
            if date_int != single_date_int:
                continue
        elif date_int < DAILY_CY_START:
            continue
        if seller_filter and str(_cell(row, col["sellerType"])).strip() != seller_filter:
            continue
        if sc_filter and str(_cell(row, col.get("sc", -1))).strip() != sc_filter:
            continue
        raw_dt = str(_cell(row, col["dateTime"]))
        if not raw_dt or raw_dt.lower() == "nan":
            continue
        date_iso = raw_dt[:10]
        seller = str(_cell(row, col["sellerType"])).strip()
        sc = str(_cell(row, col.get("sc", -1))).strip()
        dedup_key = (date_iso, seller, sc)
        keyed_rows[dedup_key] = {key: _num(row, col[key]) for key in FUNNEL_METRIC_KEYS}

    # Aggregate deduplicated rows by date
    daily_by_date = {}
    totals = {k: 0 for k in FUNNEL_METRIC_KEYS}
    for (date_iso, seller, sc), metrics in keyed_rows.items():
        d = daily_by_date.setdefault(date_iso, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for key in FUNNEL_METRIC_KEYS:
            d[key] += metrics[key]
            totals[key] += metrics[key]

    daily = [dict({"dateIso": iso}, **daily_by_date[iso]) for iso in sorted(daily_by_date)]
    return {"rowCount": len(keyed_rows), "totals": totals, "daily": daily}


def funnel_daily_sc_breakdown(values, col, target_bu, seller_filter=None, sc_filter=None, ly_dates=None):
    """Flat SC totals across all event days for the daily funnel.
    ly_dates: if set, only rows whose day_time_key prefix is in this set are counted."""
    sc_data = {}
    for row in values[1:]:
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col.get("sellerType", -1))).strip() != seller_filter:
            continue
        raw_dt = str(_cell(row, col["dateTime"]))
        if not raw_dt or raw_dt.lower() == "nan":
            continue
        date_iso = raw_dt[:10]
        if ly_dates is not None and date_iso not in ly_dates:
            continue
        sc_name = str(_cell(row, col["sc"]) or "Other").strip()
        if sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in FUNNEL_DAILY_SC_EXCLUDE:
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        d = sc_data.setdefault(sc_name, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for key in FUNNEL_METRIC_KEYS:
            d[key] += _num(row, col[key])
    sc_sorted = sorted(sc_data.items(), key=lambda kv: -kv[1]["visits"])
    return [dict({"name": name}, **totals) for name, totals in sc_sorted]


def funnel_daily_seg_breakdown(values, col, target_bu, ly_dates=None, sc_filter=None):
    """Alpha/MP segment breakdown for event-summary daily funnel."""
    seg_data = {}
    for row in values[1:]:
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        raw_dt = str(_cell(row, col["dateTime"]))
        if not raw_dt or raw_dt.lower() == "nan":
            continue
        date_iso = raw_dt[:10]
        if ly_dates is not None and date_iso not in ly_dates:
            continue
        if sc_filter and str(_cell(row, col.get("sc", -1))).strip() != sc_filter:
            continue
        seller = str(_cell(row, col.get("sellerType", -1))).strip() or "Other"
        d = seg_data.setdefault(seller, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for key in FUNNEL_METRIC_KEYS:
            d[key] += _num(row, col[key])
    return [{"label": label, "ty": v, "ly": None} for label, v in seg_data.items()]


def get_summary_funnel_data(business_key, alpha_filter="All", sc_filter="All", selected_day="All"):
    """Event Summary Funnel — cumulative across all event days, or a single day if selected_day set."""
    target_bu = BUSINESS_SHEET_MAP.get(business_key, business_key)
    alpha_active = bool(alpha_filter) and alpha_filter != "All"
    sc_active = bool(sc_filter) and sc_filter != "All"
    seller_filter = alpha_filter if alpha_active else None
    sc_filter_val = sc_filter if sc_active else None
    # When a specific day is selected, restrict to only that date int (YYYYMMDD)
    single_date_int = int(selected_day) if selected_day and selected_day != "All" else None

    # Pick the right grain tabs (same logic as live funnel)
    if alpha_active and sc_active:
        cy_tab = FUNNEL_DAILY_SC_ALPHA_CY_TAB
        ly_tab = FUNNEL_DAILY_SC_ALPHA_LY_TAB
        seg_cy_tab = FUNNEL_DAILY_SC_ALPHA_CY_TAB
        seg_ly_tab = FUNNEL_DAILY_SC_ALPHA_LY_TAB
        sc_cy_tab = FUNNEL_DAILY_SC_ALPHA_CY_TAB
        sc_ly_tab = FUNNEL_DAILY_SC_ALPHA_LY_TAB
    elif sc_active:
        cy_tab = FUNNEL_DAILY_SC_CY_TAB
        ly_tab = FUNNEL_DAILY_SC_LY_TAB
        seg_cy_tab = FUNNEL_DAILY_SC_ALPHA_CY_TAB
        seg_ly_tab = FUNNEL_DAILY_SC_ALPHA_LY_TAB
        sc_cy_tab = FUNNEL_DAILY_SC_CY_TAB
        sc_ly_tab = FUNNEL_DAILY_SC_LY_TAB
    elif alpha_active:
        cy_tab = FUNNEL_DAILY_SEG_CY_TAB
        ly_tab = FUNNEL_DAILY_SEG_LY_TAB
        seg_cy_tab = FUNNEL_DAILY_SEG_CY_TAB
        seg_ly_tab = FUNNEL_DAILY_SEG_LY_TAB
        sc_cy_tab = FUNNEL_DAILY_SC_ALPHA_CY_TAB
        sc_ly_tab = FUNNEL_DAILY_SC_ALPHA_LY_TAB
    else:
        cy_tab = FUNNEL_DAILY_BU_CY_TAB
        ly_tab = FUNNEL_DAILY_BU_LY_TAB
        seg_cy_tab = FUNNEL_DAILY_SEG_CY_TAB
        seg_ly_tab = FUNNEL_DAILY_SEG_LY_TAB
        sc_cy_tab = FUNNEL_DAILY_SC_CY_TAB
        sc_ly_tab = FUNNEL_DAILY_SC_LY_TAB

    empty = {
        "business": business_key, "rowCount": 0,
        "totals": {k: 0 for k in FUNNEL_METRIC_KEYS},
        "daily": [], "ly_daily": [], "days": [],
        "segments": [], "superCategories": [], "ly": None,
    }

    # Read CY main tab
    try:
        cy_values = get_funnel_sheet_values(cy_tab, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        cy_values = None
    if not cy_values:
        return empty

    cy_header = [str(h).strip() for h in cy_values[0]]
    cy_col = resolve_funnel_daily_columns(cy_header)
    cy_agg = aggregate_funnel_daily_rows_cy(cy_values, cy_col, target_bu, seller_filter=seller_filter, sc_filter=sc_filter_val, single_date_int=single_date_int)

    # Build event-day list from CY daily data
    date_map = get_funnel_date_map()
    days = []
    for i, d in enumerate(cy_agg["daily"]):
        iso = d["dateIso"]
        date_int = int(iso.replace("-", ""))
        days.append({"key": f"D{i}", "dateKey": date_int, "dateIso": iso})

    # LY — use date mapping to find which LY dates correspond to our CY event day(s)
    ly_iso_set = set()
    days_to_map = [d for d in days if single_date_int is None or d["dateKey"] == single_date_int]
    for d in days_to_map:
        ly_int = date_map.get(d["dateKey"])
        if ly_int:
            s = str(ly_int)
            ly_iso_set.add(f"{s[:4]}-{s[4:6]}-{s[6:8]}")

    ly_result = None
    ly_daily = []
    if ly_iso_set:
        try:
            ly_values = get_funnel_sheet_values(ly_tab, sheet_id=FUNNEL_SHEET_ID)
        except Exception:
            ly_values = None
        if ly_values:
            ly_col = resolve_funnel_daily_columns([str(h).strip() for h in ly_values[0]])
            ly_agg = aggregate_funnel_daily_rows(ly_values, ly_col, target_bu, seller_filter=seller_filter, sc_filter=sc_filter_val)
            # Filter to only the LY dates that correspond to our CY event days
            ly_daily_filtered = [d for d in ly_agg["daily"] if d["dateIso"] in ly_iso_set]
            ly_totals = {k: sum(d[k] for d in ly_daily_filtered) for k in FUNNEL_METRIC_KEYS}
            ly_result = {"totals": ly_totals}
            ly_daily = ly_daily_filtered

    # Segment breakdown (Alpha/MP) across all event days
    segments = []
    try:
        seg_cy_values = get_funnel_sheet_values(seg_cy_tab, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        seg_cy_values = None
    seg_ly_values = None
    if ly_iso_set:
        try:
            seg_ly_values = get_funnel_sheet_values(seg_ly_tab, sheet_id=FUNNEL_SHEET_ID)
        except Exception:
            seg_ly_values = None
    if seg_cy_values:
        seg_col = resolve_funnel_daily_columns([str(h).strip() for h in seg_cy_values[0]])
        for label, seller in (("Alpha", "Alpha"), ("MP", "MP")):
            # CY: filter to event dates only
            seg_totals = {k: 0 for k in FUNNEL_METRIC_KEYS}
            for row in seg_cy_values[1:]:
                if str(_cell(row, seg_col["bu"])).strip() != target_bu:
                    continue
                if str(_cell(row, seg_col["sellerType"])).strip() != seller:
                    continue
                date_int = _int(row, seg_col["date"])
                if single_date_int is not None:
                    if date_int != single_date_int:
                        continue
                elif date_int < DAILY_CY_START:
                    continue
                if sc_filter_val and str(_cell(row, seg_col.get("sc", -1))).strip() != sc_filter_val:
                    continue
                for key in FUNNEL_METRIC_KEYS:
                    seg_totals[key] += _num(row, seg_col[key])
            # LY
            ly_seg_totals = None
            if seg_ly_values and ly_iso_set:
                seg_ly_col = resolve_funnel_daily_columns([str(h).strip() for h in seg_ly_values[0]])
                ly_seg = {k: 0 for k in FUNNEL_METRIC_KEYS}
                for row in seg_ly_values[1:]:
                    if str(_cell(row, seg_ly_col["bu"])).strip() != target_bu:
                        continue
                    if str(_cell(row, seg_ly_col["sellerType"])).strip() != seller:
                        continue
                    raw_dt = str(_cell(row, seg_ly_col["dateTime"]))
                    if not raw_dt or raw_dt.lower() == "nan":
                        continue
                    if raw_dt[:10] not in ly_iso_set:
                        continue
                    if sc_filter_val and str(_cell(row, seg_ly_col.get("sc", -1))).strip() != sc_filter_val:
                        continue
                    for key in FUNNEL_METRIC_KEYS:
                        ly_seg[key] += _num(row, seg_ly_col[key])
                if sum(ly_seg.values()) > 0:
                    ly_seg_totals = ly_seg
            segments.append({"label": label, "ty": seg_totals, "ly": ly_seg_totals})

    # Super Category breakdown across all event days
    super_categories = []
    try:
        sc_values = get_funnel_sheet_values(sc_cy_tab, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        sc_values = None
    sc_ly_values = None
    if ly_iso_set:
        try:
            sc_ly_values = get_funnel_sheet_values(sc_ly_tab, sheet_id=FUNNEL_SHEET_ID)
        except Exception:
            sc_ly_values = None
    sc_ly_by_name = {}
    if sc_values:
        sc_col = resolve_funnel_daily_columns([str(h).strip() for h in sc_values[0]])
        # CY SC breakdown — filter to event dates
        sc_data_cy = {}
        for row in sc_values[1:]:
            if str(_cell(row, sc_col["bu"])).strip() != target_bu:
                continue
            date_int = _int(row, sc_col["date"])
            if single_date_int is not None:
                if date_int != single_date_int:
                    continue
            elif date_int < DAILY_CY_START:
                continue
            if seller_filter and str(_cell(row, sc_col.get("sellerType", -1))).strip() != seller_filter:
                continue
            sc_name = str(_cell(row, sc_col["sc"]) or "Other").strip()
            if sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in FUNNEL_DAILY_SC_EXCLUDE:
                continue
            if sc_filter_val and sc_name != sc_filter_val:
                continue
            d = sc_data_cy.setdefault(sc_name, {k: 0 for k in FUNNEL_METRIC_KEYS})
            for key in FUNNEL_METRIC_KEYS:
                d[key] += _num(row, sc_col[key])
        super_categories = sorted(
            [dict({"name": n}, **v) for n, v in sc_data_cy.items()],
            key=lambda r: -r["visits"]
        )

    if sc_ly_values and ly_iso_set:
        sc_ly_col = resolve_funnel_daily_columns([str(h).strip() for h in sc_ly_values[0]])
        sc_data_ly = {}
        for row in sc_ly_values[1:]:
            if str(_cell(row, sc_ly_col["bu"])).strip() != target_bu:
                continue
            raw_dt = str(_cell(row, sc_ly_col["dateTime"]))
            if not raw_dt or raw_dt.lower() == "nan":
                continue
            if raw_dt[:10] not in ly_iso_set:
                continue
            if seller_filter and str(_cell(row, sc_ly_col.get("sellerType", -1))).strip() != seller_filter:
                continue
            sc_name = str(_cell(row, sc_ly_col["sc"]) or "Other").strip()
            if sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in FUNNEL_DAILY_SC_EXCLUDE:
                continue
            if sc_filter_val and sc_name != sc_filter_val:
                continue
            d = sc_data_ly.setdefault(sc_name, {k: 0 for k in FUNNEL_METRIC_KEYS})
            for key in FUNNEL_METRIC_KEYS:
                d[key] += _num(row, sc_ly_col[key])
        sc_ly_by_name = sc_data_ly
    for r in super_categories:
        r["ly"] = sc_ly_by_name.get(r["name"])

    # MC and apparel groups (LS only)
    mega_categories = []
    apparel_groups = []
    if business_key == "LS" and super_categories:
        mega_categories = funnel_group_by_mc(super_categories)
        apparel_groups = funnel_group_by_apparel(super_categories)
        if sc_ly_by_name:
            ly_sc_rows = [dict({"name": n}, **v) for n, v in sc_ly_by_name.items()]
            ly_mc = {r["name"]: r for r in funnel_group_by_mc(ly_sc_rows)}
            ly_app = {r["name"]: r for r in funnel_group_by_apparel(ly_sc_rows)}
            for mc in mega_categories:
                mc["ly"] = {k: ly_mc[mc["name"]][k] for k in FUNNEL_METRIC_KEYS} if mc["name"] in ly_mc else None
            for ag in apparel_groups:
                ag["ly"] = {k: ly_app[ag["name"]][k] for k in FUNNEL_METRIC_KEYS} if ag["name"] in ly_app else None

    return {
        "business": business_key, "rowCount": cy_agg["rowCount"],
        "totals": cy_agg["totals"],
        "daily": cy_agg["daily"],
        "ly_daily": ly_daily,
        "days": days,
        "ly": ly_result,
        "segments": segments,
        "superCategories": super_categories,
        "megaCategories": mega_categories,
        "apparelGroups": apparel_groups,
    }


def aggregate_funnel_rows(values, col, target_bu, date_key, hour_limit=None, seller_filter=None, sc_filter=None, date_is_iso=False):
    """date_key: int YYYYMMDD for CY rows, or an ISO 'YYYY-MM-DD' string for LY
    rows (date_is_iso=True, matched by prefix against the ISO timestamp).
    seller_filter: None sums every seller_type; 'Alpha'/'MP' restricts to one.
    sc_filter: None sums every Super Category; a name restricts to one (only
    meaningful when `values` comes from an SC-grain tab)."""
    overall_by_hour = {}
    totals = {k: 0 for k in FUNNEL_METRIC_KEYS}
    row_count = 0

    for row in values[1:]:
        if date_is_iso:
            if not str(_cell(row, col["dateTime"])).startswith(date_key):
                continue
        else:
            if _int(row, col["date"]) != date_key:
                continue
        hr = _int(row, col["hour"])
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col["sellerType"])).strip() != seller_filter:
            continue
        if sc_filter and str(_cell(row, col.get("sc", -1))).strip() != sc_filter:
            continue

        oh = overall_by_hour.setdefault(hr, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for key in FUNNEL_METRIC_KEYS:
            v = _num(row, col[key])
            oh[key] += v
            totals[key] += v
        row_count += 1

    hourly = [dict({"hour": h}, **overall_by_hour[h]) for h in sorted(overall_by_hour)]
    return {"rowCount": row_count, "totals": totals, "hourly": hourly}


def funnel_sc_breakdown(values, col, target_bu, date_key, hour_limit, date_is_iso=False, seller_filter=None, sc_filter=None):
    """Flat Super-Category totals (Visits/Orders etc.) — no children, matched
    to LY by name (see get_funnel_data). seller_filter only applies when
    `values` comes from the SC x Alpha/MP grain (has a seller_type column)."""
    sc_data = {}
    for row in values[1:]:
        if date_is_iso:
            if not str(_cell(row, col["dateTime"])).startswith(date_key):
                continue
        else:
            if _int(row, col["date"]) != date_key:
                continue
        hr = _int(row, col["hour"])
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col.get("sellerType", -1))).strip() != seller_filter:
            continue
        sc_name = str(_cell(row, col["sc"]) or "Other").strip()
        if sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in {"LifeStyle", "NA", "MensClothingCasualTopwear", "WomenAccessory", "MenAccessory"}:
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        d = sc_data.setdefault(sc_name, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for key in FUNNEL_METRIC_KEYS:
            d[key] += _num(row, col[key])
    sc_sorted = sorted(sc_data.items(), key=lambda kv: -kv[1]["visits"])
    return [dict({"name": name}, **totals) for name, totals in sc_sorted]


def funnel_group_by_mc(sc_rows):
    """Aggregate SC-level funnel rows into MegaCat groups using SC_TO_MC mapping."""
    mc_data = {}
    for sc in sc_rows:
        mc = SC_TO_MC.get(sc["name"])
        if not mc:
            continue
        d = mc_data.setdefault(mc, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for k in FUNNEL_METRIC_KEYS:
            d[k] += sc.get(k, 0)
    return [dict({"name": mc}, **v) for mc, v in sorted(mc_data.items(), key=lambda kv: -kv[1]["visits"])]


def funnel_group_by_apparel(sc_rows):
    """Aggregate SC-level funnel rows into Apparel / Non-Apparel groups."""
    groups = {"Apparel": {k: 0 for k in FUNNEL_METRIC_KEYS}, "Non-Apparel": {k: 0 for k in FUNNEL_METRIC_KEYS}}
    for sc in sc_rows:
        g = "Apparel" if sc["name"] in LS_APPAREL_SC else "Non-Apparel"
        for k in FUNNEL_METRIC_KEYS:
            groups[g][k] += sc.get(k, 0)
    return [dict({"name": label}, **v) for label, v in groups.items()]


def funnel_grain_tabs(alpha_active, sc_active):
    """Picks the (cyTab, cySheet, lyTab, lySheet) tab pair matching which
    filters are active — Funnel/Traffic metrics aren't additive across grains,
    so a filtered view must read from its own dedicated grain, not be summed
    up from the unfiltered BU-level tab."""
    if alpha_active and sc_active:
        return FUNNEL_SC_ALPHA_CY_TAB, FUNNEL_SHEET_ID, FUNNEL_SC_ALPHA_LY_TAB, FUNNEL_LY_SHEET_ID
    if sc_active:
        return FUNNEL_SC_CY_TAB, FUNNEL_SHEET_ID, FUNNEL_SC_LY_TAB, FUNNEL_LY_SHEET_ID
    if alpha_active:
        return FUNNEL_SEGMENT_CY_TAB, FUNNEL_SHEET_ID, FUNNEL_SEGMENT_LY_TAB, FUNNEL_SHEET_ID
    return FUNNEL_CY_TAB, FUNNEL_SHEET_ID, FUNNEL_LY_TAB, FUNNEL_LY_SHEET_ID


def get_funnel_data(business_key, day_key="D0", alpha_filter="All", sc_filter="All"):
    target_bu = BUSINESS_SHEET_MAP.get(business_key, business_key)
    alpha_active = bool(alpha_filter) and alpha_filter != "All"
    sc_active = bool(sc_filter) and sc_filter != "All"
    seller_filter = alpha_filter if alpha_active else None
    sc_filter_val = sc_filter if sc_active else None

    cy_tab, cy_sheet, ly_tab, ly_sheet = funnel_grain_tabs(alpha_active, sc_active)
    cy_values = get_funnel_sheet_values(cy_tab, sheet_id=cy_sheet)
    if not cy_values:
        return {
            "business": business_key, "sheetBusinessUnit": target_bu, "dateKey": 0,
            "rowCount": 0, "totals": {k: 0 for k in FUNNEL_METRIC_KEYS}, "hourly": [],
            "days": [], "selectedDay": day_key, "ly": None, "segments": [], "superCategories": [],
        }

    cy_header = [str(h).strip() for h in cy_values[0]]
    col = resolve_funnel_cy_columns(cy_header)
    ty_dates = distinct_dates(cy_values, col)
    days = available_days(ty_dates)

    selected_day = day_key if any(d["key"] == day_key for d in days) else "D0"
    selected_date = next((d["dateKey"] for d in days if d["key"] == selected_day), (ty_dates[-1] if ty_dates else 0))
    is_current_day = ty_dates and selected_date == ty_dates[-1]

    latest_hour = max_hour_for_date(cy_values, col, selected_date) if is_current_day else None
    hour_limit = latest_hour if (is_current_day and latest_hour is not None and latest_hour < 24) else None

    ty_agg = aggregate_funnel_rows(cy_values, col, target_bu, selected_date, hour_limit=hour_limit, seller_filter=seller_filter, sc_filter=sc_filter_val)

    # LY date resolved from the authoritative Date Mapping tab, not a guessed
    # fixed offset — event calendars don't align day-for-day across years.
    date_map = get_funnel_date_map()
    ly_date_int = date_map.get(selected_date)
    ly_date_str = None
    if ly_date_int:
        s = str(ly_date_int)
        ly_date_str = f"{s[:4]}-{s[4:6]}-{s[6:8]}"

    # LY — same grain as the CY tab picked above (not the BU-level LY tab
    # unless no filters are active).
    ly_result = None
    if ly_date_str:
        try:
            ly_values = get_funnel_sheet_values(ly_tab, sheet_id=ly_sheet)
        except Exception:
            ly_values = None
        if ly_values:
            ly_col = resolve_funnel_ly_columns([str(h).strip() for h in ly_values[0]])
            ly_agg_full = aggregate_funnel_rows(ly_values, ly_col, target_bu, ly_date_str, hour_limit=None, seller_filter=seller_filter, sc_filter=sc_filter_val, date_is_iso=True)
            ly_agg_capped = ly_agg_full if hour_limit is None else \
                aggregate_funnel_rows(ly_values, ly_col, target_bu, ly_date_str, hour_limit=hour_limit, seller_filter=seller_filter, sc_filter=sc_filter_val, date_is_iso=True)
            if ly_agg_full["rowCount"] > 0:
                ly_result = {
                    "dateKey": ly_date_int, "rowCount": ly_agg_capped["rowCount"],
                    "totals": ly_agg_capped["totals"], "hourly": ly_agg_full["hourly"],
                }

    # Segment breakdown: Alpha vs MP. When an SC filter is active, the plain
    # Alpha/MP-grain tab has no SC column, so fall back to the SC x Alpha/MP
    # grain (restricted to that SC) to keep the breakdown consistent with the
    # active filter.
    segments = []
    seg_cy_tab, seg_cy_sheet = (FUNNEL_SC_ALPHA_CY_TAB, FUNNEL_SHEET_ID) if sc_active else (FUNNEL_SEGMENT_CY_TAB, FUNNEL_SHEET_ID)
    seg_ly_tab, seg_ly_sheet = (FUNNEL_SC_ALPHA_LY_TAB, FUNNEL_LY_SHEET_ID) if sc_active else (FUNNEL_SEGMENT_LY_TAB, FUNNEL_SHEET_ID)
    try:
        seg_cy_values = get_funnel_sheet_values(seg_cy_tab, sheet_id=seg_cy_sheet)
    except Exception:
        seg_cy_values = None
    seg_ly_values = seg_ly_col = None
    if ly_date_str:
        try:
            seg_ly_values = get_funnel_sheet_values(seg_ly_tab, sheet_id=seg_ly_sheet)
        except Exception:
            seg_ly_values = None
        if seg_ly_values:
            seg_ly_col = resolve_funnel_ly_columns([str(h).strip() for h in seg_ly_values[0]])
    if seg_cy_values:
        seg_col = resolve_funnel_cy_columns([str(h).strip() for h in seg_cy_values[0]])
        for label, seller in (("Alpha", "Alpha"), ("MP", "MP")):
            ty_seg = aggregate_funnel_rows(seg_cy_values, seg_col, target_bu, selected_date, hour_limit=hour_limit, seller_filter=seller, sc_filter=sc_filter_val)
            ly_seg_totals = None
            if seg_ly_values and ly_date_str:
                ly_seg = aggregate_funnel_rows(seg_ly_values, seg_ly_col, target_bu, ly_date_str, hour_limit=hour_limit, seller_filter=seller, sc_filter=sc_filter_val, date_is_iso=True)
                if ly_seg["rowCount"] > 0:
                    ly_seg_totals = ly_seg["totals"]
            segments.append({"label": label, "ty": ty_seg["totals"], "ly": ly_seg_totals})

    # Super Category breakdown. When an Alpha filter is active, the plain
    # SC-grain tab has no seller_type column, so fall back to the SC x
    # Alpha/MP grain (restricted to that seller) instead.
    super_categories = []
    sc_cy_tab, sc_cy_sheet = (FUNNEL_SC_ALPHA_CY_TAB, FUNNEL_SHEET_ID) if alpha_active else (FUNNEL_SC_CY_TAB, FUNNEL_SHEET_ID)
    sc_ly_tab, sc_ly_sheet = (FUNNEL_SC_ALPHA_LY_TAB, FUNNEL_LY_SHEET_ID) if alpha_active else (FUNNEL_SC_LY_TAB, FUNNEL_LY_SHEET_ID)
    try:
        sc_values = get_funnel_sheet_values(sc_cy_tab, sheet_id=sc_cy_sheet)
    except Exception:
        sc_values = None
    sc_ly_by_name = {}
    if ly_date_str:
        try:
            sc_ly_values = get_funnel_sheet_values(sc_ly_tab, sheet_id=sc_ly_sheet)
        except Exception:
            sc_ly_values = None
        if sc_ly_values:
            sc_ly_col = resolve_funnel_ly_columns([str(h).strip() for h in sc_ly_values[0]])
            for row in funnel_sc_breakdown(sc_ly_values, sc_ly_col, target_bu, ly_date_str, hour_limit, date_is_iso=True, seller_filter=seller_filter, sc_filter=sc_filter_val):
                sc_ly_by_name[row["name"]] = {k: row[k] for k in FUNNEL_METRIC_KEYS}
    if sc_values:
        sc_col = resolve_funnel_cy_columns([str(h).strip() for h in sc_values[0]])
        super_categories = funnel_sc_breakdown(sc_values, sc_col, target_bu, selected_date, hour_limit, seller_filter=seller_filter, sc_filter=sc_filter_val)
        for r in super_categories:
            r["ly"] = sc_ly_by_name.get(r["name"])

    # Mega-cat and apparel groups derived from SC rows (LS only)
    # LY SC data keyed by name for group aggregation
    mega_categories = []
    apparel_groups = []
    if business_key == "LS" and super_categories:
        mega_categories = funnel_group_by_mc(super_categories)
        apparel_groups = funnel_group_by_apparel(super_categories)
        # attach LY to each MC/apparel group by summing LY SC rows
        if sc_ly_by_name:
            ly_sc_rows = [dict({"name": n}, **v) for n, v in sc_ly_by_name.items()]
            ly_mc = {r["name"]: r for r in funnel_group_by_mc(ly_sc_rows)}
            ly_app = {r["name"]: r for r in funnel_group_by_apparel(ly_sc_rows)}
            for mc in mega_categories:
                mc["ly"] = {k: ly_mc[mc["name"]][k] for k in FUNNEL_METRIC_KEYS} if mc["name"] in ly_mc else None
            for ag in apparel_groups:
                ag["ly"] = {k: ly_app[ag["name"]][k] for k in FUNNEL_METRIC_KEYS} if ag["name"] in ly_app else None

    return {
        "business": business_key, "sheetBusinessUnit": target_bu, "dateKey": selected_date,
        "excludedHour": latest_hour if hour_limit is not None else None,
        "days": days, "selectedDay": selected_day,
        "rowCount": ty_agg["rowCount"], "totals": ty_agg["totals"], "hourly": ty_agg["hourly"],
        "ly": ly_result,
        "segments": segments,
        "superCategories": super_categories,
        "megaCategories": mega_categories,
        "apparelGroups": apparel_groups,
    }


def traffic_grain_tab(alpha_active, sc_active):
    if alpha_active and sc_active:
        return TRAFFIC_SC_ALPHA_CY_TAB
    if sc_active:
        return TRAFFIC_SC_CY_TAB
    if alpha_active:
        return TRAFFIC_ALPHA_CY_TAB
    return TRAFFIC_BU_CY_TAB


def resolve_traffic_columns(header):
    def idx(name):
        return header.index(name) if name in header else -1
    cols = {"date": idx("date"), "hour": idx("hour"), "bu": idx("business_unit"),
            "sellerType": idx("seller_type"), "sc": idx("super_category")}
    for key, col_name, _ in TRAFFIC_METRICS:
        cols[key] = idx(col_name) if col_name else -1
    return cols


def resolve_traffic_ly_columns(header):
    """LY traffic tabs use date_key, event_time (12h), business_unit, and different metric names."""
    def idx(name): return header.index(name) if name in header else -1
    cols = {
        "date": idx("date_key"), "eventTime": idx("event_time"),
        "bu": idx("business_unit"), "sellerType": idx("seller_type"),
        "sc": idx("super_category"),
    }
    for key, cy_col, _ in TRAFFIC_METRICS:
        ly_col = TRAFFIC_LY_COL_MAP.get(cy_col) if cy_col else None
        cols[key] = idx(ly_col) if ly_col else -1
    return cols


def _event_time_to_hour(event_time_str):
    """Convert '1:00 AM'/'12:00 PM' etc to 0-23 int."""
    try:
        s = str(event_time_str).strip().upper()
        parts = s.split()
        hm = parts[0].split(":")
        h = int(hm[0])
        ampm = parts[1] if len(parts) > 1 else "AM"
        if ampm == "AM":
            return 0 if h == 12 else h
        else:
            return 12 if h == 12 else h + 12
    except Exception:
        return -1


def aggregate_traffic_ly_rows(values, col, target_bu, date_key, hour_limit=None, seller_filter=None, sc_filter=None):
    """Aggregate LY traffic rows — same shape output as aggregate_traffic_rows."""
    totals = {k: 0 for k in TRAFFIC_METRIC_KEYS}
    by_hour = {}
    row_count = 0
    for row in values[1:]:
        if _int(row, col["date"]) != date_key:
            continue
        hr = _event_time_to_hour(_cell(row, col["eventTime"]))
        if hr < 0:
            continue
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col.get("sellerType", -1))).strip() != seller_filter:
            continue
        sc_name = str(_cell(row, col.get("sc", -1)) or "").strip()
        if sc_name and sc_name in EXCLUDED_SUPER_CATEGORIES:
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        visits   = _num(row, col["visits"])
        indirect = _num(row, col["indirect"])
        direct   = max(0, visits - indirect)
        oh = by_hour.setdefault(hr, {k: 0 for k in TRAFFIC_METRIC_KEYS})
        for k in TRAFFIC_METRIC_KEYS:
            v = direct if k == "direct" else _num(row, col[k])
            oh[k] += v
            totals[k] += v
        row_count += 1
    hourly = [dict({"hour": h}, **by_hour[h]) for h in sorted(by_hour)]
    return {"rowCount": row_count, "totals": totals, "hourly": hourly}


def traffic_ly_grain_tabs(alpha_active, sc_active):
    if alpha_active and sc_active:
        return TRAFFIC_SC_ALPHA_LY_TAB
    if sc_active:
        return TRAFFIC_SC_LY_TAB
    if alpha_active:
        return TRAFFIC_ALPHA_LY_TAB
    return TRAFFIC_BU_LY_TAB


def aggregate_traffic_rows(values, col, target_bu, date_key, hour_limit=None, seller_filter=None, sc_filter=None):
    totals = {k: 0 for k in TRAFFIC_METRIC_KEYS}
    by_hour = {}
    row_count = 0
    for row in values[1:]:
        if _int(row, col["date"]) != date_key:
            continue
        hr = _int(row, col["hour"])
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col["sellerType"])).strip() != seller_filter:
            continue
        sc_name = str(_cell(row, col.get("sc", -1)) or "").strip()
        if sc_name and sc_name in EXCLUDED_SUPER_CATEGORIES:
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        visits   = _num(row, col["visits"])
        indirect = _num(row, col["indirect"])
        direct   = max(0, visits - indirect)
        oh = by_hour.setdefault(hr, {k: 0 for k in TRAFFIC_METRIC_KEYS})
        for k in TRAFFIC_METRIC_KEYS:
            v = direct if k == "direct" else _num(row, col[k])
            oh[k] += v
            totals[k] += v
        row_count += 1
    hourly = [dict({"hour": h}, **by_hour[h]) for h in sorted(by_hour)]
    return {"rowCount": row_count, "totals": totals, "hourly": hourly}


def traffic_sc_breakdown(values, col, target_bu, date_key, hour_limit, seller_filter=None, sc_filter=None):
    sc_data = {}
    for row in values[1:]:
        if _int(row, col["date"]) != date_key:
            continue
        hr = _int(row, col["hour"])
        if hour_limit is not None and hr >= hour_limit:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col.get("sellerType", -1))).strip() != seller_filter:
            continue
        sc_name = str(_cell(row, col.get("sc", -1)) or "Other").strip()
        if sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in FUNNEL_DAILY_SC_EXCLUDE:
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        visits   = _num(row, col["visits"])
        indirect = _num(row, col["indirect"])
        direct   = max(0, visits - indirect)
        d = sc_data.setdefault(sc_name, {k: 0 for k in TRAFFIC_METRIC_KEYS})
        for k in TRAFFIC_METRIC_KEYS:
            d[k] += direct if k == "direct" else _num(row, col[k])
    return [dict({"name": name}, **v) for name, v in sorted(sc_data.items(), key=lambda kv: -kv[1]["visits"])]


def traffic_sc_ly_breakdown(values, col, target_bu, date_key, hour_limit, seller_filter=None, sc_filter=None):
    sc_data = {}
    for row in values[1:]:
        if _int(row, col["date"]) != date_key:
            continue
        hr = _event_time_to_hour(_cell(row, col["eventTime"]))
        if hr < 0 or (hour_limit is not None and hr >= hour_limit):
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if seller_filter and str(_cell(row, col.get("sellerType", -1))).strip() != seller_filter:
            continue
        sc_name = str(_cell(row, col.get("sc", -1)) or "Other").strip()
        if sc_name in EXCLUDED_SUPER_CATEGORIES:
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        visits   = _num(row, col["visits"])
        indirect = _num(row, col["indirect"])
        direct   = max(0, visits - indirect)
        d = sc_data.setdefault(sc_name, {k: 0 for k in TRAFFIC_METRIC_KEYS})
        for k in TRAFFIC_METRIC_KEYS:
            d[k] += direct if k == "direct" else _num(row, col[k])
    return [dict({"name": name}, **v) for name, v in sc_data.items()]


def get_traffic_data(business_key, day_key="D0", alpha_filter="All", sc_filter="All"):
    target_bu = BUSINESS_SHEET_MAP.get(business_key, business_key)
    alpha_active = bool(alpha_filter) and alpha_filter != "All"
    sc_active    = bool(sc_filter)    and sc_filter    != "All"
    seller_filter  = alpha_filter if alpha_active else None
    sc_filter_val  = sc_filter    if sc_active    else None

    cy_tab = traffic_grain_tab(alpha_active, sc_active)
    cy_values = get_funnel_sheet_values(cy_tab, sheet_id=FUNNEL_SHEET_ID)
    if not cy_values:
        return {"business": business_key, "sheetBusinessUnit": target_bu, "dateKey": 0,
                "rowCount": 0, "totals": {k: 0 for k in TRAFFIC_METRIC_KEYS}, "hourly": [],
                "days": [], "selectedDay": day_key, "superCategories": []}

    cy_header = [str(h).strip() for h in cy_values[0]]
    col = resolve_traffic_columns(cy_header)
    ty_dates = distinct_dates(cy_values, col)
    days = available_days(ty_dates)

    selected_day  = day_key if any(d["key"] == day_key for d in days) else "D0"
    selected_date = next((d["dateKey"] for d in days if d["key"] == selected_day), (ty_dates[-1] if ty_dates else 0))
    is_current_day = ty_dates and selected_date == ty_dates[-1]

    latest_hour = max_hour_for_date(cy_values, col, selected_date) if is_current_day else None
    hour_limit  = latest_hour if (is_current_day and latest_hour is not None and latest_hour < 24) else None

    ty_agg = aggregate_traffic_rows(cy_values, col, target_bu, selected_date, hour_limit=hour_limit,
                                    seller_filter=seller_filter, sc_filter=sc_filter_val)

    # LY — resolve date via date map, read from LY sheet with same grain
    date_map = get_funnel_date_map()
    ly_date_int = date_map.get(selected_date)
    ly_result = None
    if ly_date_int:
        ly_tab = traffic_ly_grain_tabs(alpha_active, sc_active)
        try:
            ly_values = get_funnel_sheet_values(ly_tab, sheet_id=TRAFFIC_LY_SHEET_ID)
        except Exception:
            ly_values = None
        if ly_values:
            ly_col = resolve_traffic_ly_columns([str(h).strip() for h in ly_values[0]])
            ly_full = aggregate_traffic_ly_rows(ly_values, ly_col, target_bu, ly_date_int,
                                                seller_filter=seller_filter, sc_filter=sc_filter_val)
            ly_capped = ly_full if hour_limit is None else \
                aggregate_traffic_ly_rows(ly_values, ly_col, target_bu, ly_date_int,
                                          hour_limit=hour_limit, seller_filter=seller_filter, sc_filter=sc_filter_val)
            if ly_full["rowCount"] > 0:
                ly_result = {"dateKey": ly_date_int, "totals": ly_capped["totals"], "hourly": ly_full["hourly"]}

    # SC breakdown — fall back to SC x Alpha/MP grain when alpha filter is active
    sc_tab = TRAFFIC_SC_ALPHA_CY_TAB if alpha_active else TRAFFIC_SC_CY_TAB
    try:
        sc_values = get_funnel_sheet_values(sc_tab, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        sc_values = None
    super_categories = []
    if sc_values:
        sc_col = resolve_traffic_columns([str(h).strip() for h in sc_values[0]])
        super_categories = traffic_sc_breakdown(sc_values, sc_col, target_bu, selected_date, hour_limit,
                                                seller_filter=seller_filter, sc_filter=sc_filter_val)
    # Attach LY to SC rows by name
    if ly_result and ly_date_int:
        ly_sc_tab = TRAFFIC_SC_ALPHA_LY_TAB if alpha_active else TRAFFIC_SC_LY_TAB
        try:
            ly_sc_vals = get_funnel_sheet_values(ly_sc_tab, sheet_id=TRAFFIC_LY_SHEET_ID)
        except Exception:
            ly_sc_vals = None
        if ly_sc_vals:
            ly_sc_col = resolve_traffic_ly_columns([str(h).strip() for h in ly_sc_vals[0]])
            ly_sc_rows = traffic_sc_ly_breakdown(ly_sc_vals, ly_sc_col, target_bu, ly_date_int,
                                                  hour_limit, seller_filter=seller_filter, sc_filter=sc_filter_val)
            ly_sc_by_name = {r["name"]: r for r in ly_sc_rows}
            for r in super_categories:
                r["ly"] = ly_sc_by_name.get(r["name"])

    # Segment (Alpha/MP) breakdown
    segments = []
    try:
        seg_cy_values = get_funnel_sheet_values(TRAFFIC_ALPHA_CY_TAB, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        seg_cy_values = None
    seg_ly_values = None
    if ly_date_int:
        try:
            seg_ly_values = get_funnel_sheet_values(TRAFFIC_ALPHA_LY_TAB, sheet_id=TRAFFIC_LY_SHEET_ID)
        except Exception:
            seg_ly_values = None
    if seg_cy_values:
        seg_col = resolve_traffic_columns([str(h).strip() for h in seg_cy_values[0]])
        seg_ly_col = resolve_traffic_ly_columns([str(h).strip() for h in seg_ly_values[0]]) if seg_ly_values else None
        for label, seller in (("Alpha", "Alpha"), ("MP", "MP")):
            ty_seg = aggregate_traffic_rows(seg_cy_values, seg_col, target_bu, selected_date,
                                            hour_limit=hour_limit, seller_filter=seller, sc_filter=sc_filter_val)
            ly_seg_totals = None
            if seg_ly_values and seg_ly_col and ly_date_int:
                ly_seg = aggregate_traffic_ly_rows(seg_ly_values, seg_ly_col, target_bu, ly_date_int,
                                                    hour_limit=hour_limit, seller_filter=seller, sc_filter=sc_filter_val)
                if ly_seg["rowCount"] > 0:
                    ly_seg_totals = ly_seg["totals"]
            segments.append({"label": label, "ty": ty_seg["totals"], "ly": ly_seg_totals})

    return {
        "business": business_key, "sheetBusinessUnit": target_bu, "dateKey": selected_date,
        "excludedHour": latest_hour if hour_limit is not None else None,
        "days": days, "selectedDay": selected_day,
        "rowCount": ty_agg["rowCount"], "totals": ty_agg["totals"], "hourly": ty_agg["hourly"],
        "ly": ly_result,
        "segments": segments,
        "superCategories": super_categories,
    }


def get_live_sales_data(business_key, filters, day_key="D0"):
    target_bu = BUSINESS_SHEET_MAP.get(business_key, business_key)

    ty_values = get_sheet_values(SALES_SHEET_TAB_NAME)
    if not ty_values:
        return {
            "business": business_key, "sheetBusinessUnit": target_bu, "dateKey": 0,
            "rowCount": 0, "totalGmv": 0, "totalUnits": 0, "hourly": [], "superCategories": [], "megaCategories": [],
            "ly": None, "days": [], "selectedDay": day_key, "breakdown": [], "bauSpike": None,
            "paymentShare": payment_shares({"upi": 0, "cod": 0, "pbo": 0, "others": 0}, 0),
        }

    ty_header = [str(h).strip() for h in ty_values[0]]
    ty_col = resolve_columns(ty_header)
    ty_dates = distinct_dates(ty_values, ty_col)
    days = available_days(ty_dates)

    # Resolve which actual date the requested day_key ("D0"/"D-1") points to.
    selected_day = day_key if any(d["key"] == day_key for d in days) else "D0"
    selected_date = next((d["dateKey"] for d in days if d["key"] == selected_day), (ty_dates[-1] if ty_dates else 0))
    is_current_day = ty_dates and selected_date == ty_dates[-1]

    # Only the actual latest day has an in-progress (partial) hour to drop.
    # D-1 is always a fully completed day, so it keeps all 24 hours.
    latest_hour = max_hour_for_date(ty_values, ty_col, selected_date) if is_current_day else None
    hour_limit = latest_hour if (is_current_day and latest_hour is not None and latest_hour < 24) else None

    ty_agg = aggregate_rows(ty_values, ty_col, target_bu, filters, selected_date, hour_limit=hour_limit)

    # Map to the corresponding LY day by index position — both tabs only span
    # 2 days each, so the selected TY day's index lines up with the same index
    # in the historical tab's own 2 days.
    #
    # Two different LY aggregations are needed:
    #  - "full"   (hour_limit=None): the LY hourly curve for the whole day, used
    #             ONLY to draw the chart line — the chart always shows a full day.
    #  - "capped" (same hour_limit as TY): used for every KPI/table total and
    #             YoY%, so a partial TY day is compared like-for-like against
    #             the same hour window last year, not a full LY day.
    ly_result = None
    ly_values = ly_col = ly_date = None
    try:
        ly_values = get_sheet_values(LY_SHEET_TAB_NAME)
    except Exception:
        ly_values = None
    if ly_values and ty_dates:
        ly_header = [str(h).strip() for h in ly_values[0]]
        ly_col = resolve_columns(ly_header)
        ly_dates = distinct_dates(ly_values, ly_col)
        ty_index = ty_dates.index(selected_date)
        if ty_index < len(ly_dates):
            ly_date = ly_dates[ty_index]
            ly_agg_full = aggregate_rows(ly_values, ly_col, target_bu, filters, ly_date, hour_limit=None)
            ly_agg_capped = ly_agg_full if hour_limit is None else \
                aggregate_rows(ly_values, ly_col, target_bu, filters, ly_date, hour_limit=hour_limit)

            empty_payment = payment_shares({"upi": 0, "cod": 0, "pbo": 0, "others": 0}, 0)

            def merge_full_and_capped(full_list, capped_list):
                full_by_name = {s["name"]: s for s in full_list}
                capped_by_name = {s["name"]: s for s in capped_list}
                return [
                    {
                        "name": name,
                        "gmv": (capped_by_name[name]["gmv"] if name in capped_by_name else 0),
                        "units": (capped_by_name[name]["units"] if name in capped_by_name else 0),
                        "paymentShare": (capped_by_name[name]["paymentShare"] if name in capped_by_name else empty_payment),
                        "hourly": full["hourly"],  # full day, for the chart
                        "pricePoints": (capped_by_name[name]["pricePoints"] if name in capped_by_name else []),
                    }
                    for name, full in full_by_name.items()
                ]

            merged_sc = merge_full_and_capped(ly_agg_full["superCategories"], ly_agg_capped["superCategories"])
            # Mega-cat breakdown is only surfaced for LifeStyle — skip the extra
            # merge work for other businesses.
            merged_mc = merge_full_and_capped(ly_agg_full["megaCategories"], ly_agg_capped["megaCategories"]) \
                if business_key == "LS" else []

            ly_result = {
                "dateKey": ly_date, "rowCount": ly_agg_capped["rowCount"],
                "totalGmv": ly_agg_capped["totalGmv"], "totalUnits": ly_agg_capped["totalUnits"],
                "hourly": ly_agg_full["hourly"],  # full day, for the chart
                "paymentShare": payment_shares(ly_agg_capped["paymentUnits"], ly_agg_capped["totalUnits"]),
                "superCategories": merged_sc,
                "megaCategories": merged_mc,
            }
        else:
            ly_date = None

    # BAU ("business as usual") sales — a normal-day baseline with no date
    # column: every row is already a TOTAL across the whole BAU period (8 days
    # this year, 11 days last year), so it must be divided by that day count
    # before comparing against a single live day (see BAU_DAY_COUNTS).
    bau_values = bau_col = None
    bau_cy_year = bau_ly_year = None
    try:
        bau_values = get_funnel_sheet_values(BAU_SHEET_TAB_NAME, sheet_id=FUNNEL_LY_SHEET_ID)
    except Exception:
        bau_values = None
    if bau_values:
        bau_header = [str(h).strip() for h in bau_values[0]]
        bau_col = resolve_bau_columns(bau_header)
        bau_cy_year, bau_ly_year = bau_years(bau_values, bau_col)

    bau_spike = None
    if bau_values and bau_cy_year is not None:
        cy_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_cy_year, BAU_DAY_COUNTS["cy"], hour_limit)
        ly_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_ly_year, BAU_DAY_COUNTS["ly"], hour_limit)
        bau_spike = {
            "gmv": {
                "cy": spike_ratio(ty_agg["totalGmv"], cy_bau["gmv"]),
                "ly": spike_ratio(ly_result["totalGmv"], ly_bau["gmv"]) if ly_result else None,
            },
            "units": {
                "cy": spike_ratio(ty_agg["totalUnits"], cy_bau["units"]),
                "ly": spike_ratio(ly_result["totalUnits"], ly_bau["units"]) if ly_result else None,
            },
        }
        ly_sc_by_name = {s["name"]: s for s in (ly_result["superCategories"] if ly_result else [])}
        for sc in ty_agg["superCategories"]:
            is_this_sc = lambda row, col, name=sc["name"]: str(_cell(row, col["sc"])).strip() == name
            cy_sc_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_cy_year, BAU_DAY_COUNTS["cy"], hour_limit, is_this_sc)
            ly_sc_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_ly_year, BAU_DAY_COUNTS["ly"], hour_limit, is_this_sc)
            ly_sc = ly_sc_by_name.get(sc["name"])
            sc["cyGmvSpike"] = spike_ratio(sc["gmv"], cy_sc_bau["gmv"])
            sc["cyUnitsSpike"] = spike_ratio(sc["units"], cy_sc_bau["units"])
            sc["lyGmvSpike"] = spike_ratio(ly_sc["gmv"], ly_sc_bau["gmv"]) if ly_sc else None
            sc["lyUnitsSpike"] = spike_ratio(ly_sc["units"], ly_sc_bau["units"]) if ly_sc else None

        if business_key == "LS":
            ly_mc_by_name = {s["name"]: s for s in (ly_result["megaCategories"] if ly_result else [])}
            for mc in ty_agg["megaCategories"]:
                is_this_mc = lambda row, col, name=mc["name"]: str(_cell(row, col["megaCat"])).strip() == name
                cy_mc_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_cy_year, BAU_DAY_COUNTS["cy"], hour_limit, is_this_mc)
                ly_mc_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_ly_year, BAU_DAY_COUNTS["ly"], hour_limit, is_this_mc)
                ly_mc = ly_mc_by_name.get(mc["name"])
                mc["cyGmvSpike"] = spike_ratio(mc["gmv"], cy_mc_bau["gmv"])
                mc["cyUnitsSpike"] = spike_ratio(mc["units"], cy_mc_bau["units"])
                mc["lyGmvSpike"] = spike_ratio(ly_mc["gmv"], ly_mc_bau["gmv"]) if ly_mc else None
                mc["lyUnitsSpike"] = spike_ratio(ly_mc["units"], ly_mc_bau["units"]) if ly_mc else None
    else:
        for sc in ty_agg["superCategories"]:
            sc["cyGmvSpike"] = sc["lyGmvSpike"] = sc["cyUnitsSpike"] = sc["lyUnitsSpike"] = None
        for mc in ty_agg["megaCategories"]:
            mc["cyGmvSpike"] = mc["lyGmvSpike"] = mc["cyUnitsSpike"] = mc["lyUnitsSpike"] = None

    breakdown = compute_breakdown(
        business_key, ty_values, ty_col, target_bu, filters, selected_date, hour_limit,
        ly_values, ly_col, ly_date, hour_limit,
        bau_values, bau_col, bau_cy_year, bau_ly_year,
    )

    return {
        "business": business_key, "sheetBusinessUnit": target_bu, "dateKey": selected_date,
        "excludedHour": latest_hour if hour_limit is not None else None,
        "days": days, "selectedDay": selected_day,
        "rowCount": ty_agg["rowCount"], "totalGmv": ty_agg["totalGmv"], "totalUnits": ty_agg["totalUnits"],
        "hourly": ty_agg["hourly"], "superCategories": ty_agg["superCategories"],
        "megaCategories": ty_agg["megaCategories"] if business_key == "LS" else [],
        "paymentShare": payment_shares(ty_agg["paymentUnits"], ty_agg["totalUnits"]),
        "ly": ly_result,
        "breakdown": breakdown,
        "bauSpike": bau_spike,
    }


def resolve_daily_columns(header):
    """Like resolve_columns but daily sheets have order_date_key and no hour_of_day."""
    def idx(name): return header.index(name) if name in header else -1
    return {
        "date": idx("order_date_key"),
        "hour": -1,   # no hour in daily sheets
        "bu": idx("analytic_business_unit"), "sc": idx("analytic_super_category"),
        "megaCat": idx("mega_cat"),
        "gmv": idx("gmv"), "units": idx("units"),
        "upi": idx("upi_units"), "cod": idx("cod_units"), "pbo": idx("pbo_units"), "others": idx("others_units"),
        "marketplace": idx(FILTER_COLS["marketplace"]),
        "branded": idx(FILTER_COLS["branded"]),
        "alpha": idx(FILTER_COLS["alpha"]),
        "pricePoint": idx(FILTER_COLS["pricePoint"]),
    }


def aggregate_daily_rows(values, col, target_bu, filters, min_date=None):
    """Like aggregate_rows but groups by date (day) instead of hour_of_day.
    Returns totalGmv, totalUnits, daily=[{day, gmv, units}], superCategories, etc."""
    daily_by_date = {}
    overall_gmv = overall_units = 0
    payment_units = {"upi": 0, "cod": 0, "pbo": 0, "others": 0}
    sc_data = {}
    mc_data = {}
    row_count = 0

    for row in values[1:]:
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if not row_passes_filters(row, col, filters):
            continue
        date_key = _int(row, col["date"])
        if min_date and date_key < min_date:
            continue

        gmv = _num(row, col["gmv"])
        units = _num(row, col["units"])
        sc_name = str(_cell(row, col["sc"]) or "Other").strip()
        mc_raw = str(_cell(row, col["megaCat"]) or "Other").strip()
        mc_name = _mc_display(mc_raw)
        pp_name = _norm_pp(str(_cell(row, col.get("pricePoint", -1)) or "").strip()) or None

        row_count += 1
        overall_gmv += gmv
        overall_units += units
        payment_units["upi"] += _num(row, col["upi"])
        payment_units["cod"] += _num(row, col["cod"])
        payment_units["pbo"] += _num(row, col["pbo"])
        payment_units["others"] += _num(row, col["others"])

        dd = daily_by_date.setdefault(date_key, {"gmv": 0, "units": 0})
        dd["gmv"] += gmv
        dd["units"] += units

        scd = sc_data.setdefault(sc_name, {"gmv": 0, "units": 0, "pricePoints": {}})
        scd["gmv"] += gmv
        scd["units"] += units
        if pp_name:
            ppd = scd["pricePoints"].setdefault(pp_name, {"gmv": 0, "units": 0})
            ppd["gmv"] += gmv
            ppd["units"] += units

        if mc_name:
            mcd = mc_data.setdefault(mc_name, {"gmv": 0, "units": 0, "pricePoints": {}})
            mcd["gmv"] += gmv
            mcd["units"] += units
            if pp_name:
                ppd = mcd["pricePoints"].setdefault(pp_name, {"gmv": 0, "units": 0})
                ppd["gmv"] += gmv
                ppd["units"] += units

    sc_sorted = sorted(sc_data.items(), key=lambda kv: -kv[1]["gmv"])
    mc_sorted = sorted(mc_data.items(), key=lambda kv: -kv[1]["gmv"])

    def pp_list(ppd):
        return sorted([{"name": n, "gmv": v["gmv"], "units": v["units"]} for n, v in ppd.items()],
                      key=lambda x: x["name"])

    return {
        "rowCount": row_count,
        "totalGmv": overall_gmv,
        "totalUnits": overall_units,
        "paymentUnits": payment_units,
        "daily": [{"day": d, "gmv": v["gmv"], "units": v["units"]}
                  for d, v in sorted(daily_by_date.items())],
        "superCategories": [{"name": n, "gmv": v["gmv"], "units": v["units"],
                              "pricePoints": pp_list(v["pricePoints"])} for n, v in sc_sorted],
        "megaCategories": [{"name": n, "gmv": v["gmv"], "units": v["units"],
                             "pricePoints": pp_list(v["pricePoints"])} for n, v in mc_sorted],
    }


def compute_daily_breakdown(business_key, ty_values, ty_col, target_bu, filters,
                            ly_values, ly_col,
                            bau_values=None, bau_col=None, bau_cy_year=None, bau_ly_year=None):
    """Same shape as compute_breakdown but sums across event window only."""
    def row_for_daily(label, predicate):
        ty = {"gmv": 0, "units": 0}
        ly = {"gmv": 0, "units": 0}
        for row in (ty_values[1:] if ty_values else []):
            if str(_cell(row, ty_col["bu"])).strip() != target_bu: continue
            if not row_passes_filters(row, ty_col, filters): continue
            if _int(row, ty_col["date"]) < DAILY_CY_START: continue
            if predicate and not predicate(row, ty_col): continue
            ty["gmv"] += _num(row, ty_col["gmv"])
            ty["units"] += _num(row, ty_col["units"])
        for row in (ly_values[1:] if ly_values else []):
            if str(_cell(row, ly_col["bu"])).strip() != target_bu: continue
            if not row_passes_filters(row, ly_col, filters): continue
            if _int(row, ly_col["date"]) < DAILY_LY_START: continue
            if predicate and not predicate(row, ly_col): continue
            ly["gmv"] += _num(row, ly_col["gmv"])
            ly["units"] += _num(row, ly_col["units"])
        row = {"label": label, "tyGmv": ty["gmv"], "tyUnits": ty["units"],
               "lyGmv": ly["gmv"], "lyUnits": ly["units"]}
        if bau_values and bau_cy_year:
            cy_b = bau_per_day(bau_values, bau_col, target_bu, filters, bau_cy_year, BAU_DAY_COUNTS["cy"], None, predicate)
            ly_b = bau_per_day(bau_values, bau_col, target_bu, filters, bau_ly_year, BAU_DAY_COUNTS["ly"], None, predicate)
            row["cyGmvSpike"] = spike_ratio(ty["gmv"], cy_b["gmv"] * BAU_DAY_COUNTS["cy"])
            row["lyGmvSpike"] = spike_ratio(ly["gmv"], ly_b["gmv"] * BAU_DAY_COUNTS["ly"])
            row["cyUnitsSpike"] = spike_ratio(ty["units"], cy_b["units"] * BAU_DAY_COUNTS["cy"])
            row["lyUnitsSpike"] = spike_ratio(ly["units"], ly_b["units"] * BAU_DAY_COUNTS["ly"])
        else:
            row["cyGmvSpike"] = row["lyGmvSpike"] = row["cyUnitsSpike"] = row["lyUnitsSpike"] = None
        return row

    rows = []
    for label, predicate, children in breakdown_segments(business_key, ty_values, ty_col):
        row = row_for_daily(label, predicate)
        child_rows = []
        for clabel, cpredicate, grandchildren in children:
            child_row = row_for_daily(clabel, cpredicate)
            child_row["children"] = [row_for_daily(glabel, gpredicate) for glabel, gpredicate, *_ in grandchildren]
            child_rows.append(child_row)
        row["children"] = child_rows
        rows.append(row)
    return rows


def get_summary_sales_data(business_key, filters):
    """Event Summary Sales — daily trend across entire event, same structure as
    get_live_sales_data but uses Daily_sales_2026/2025 and no hour filtering."""
    target_bu = BUSINESS_SHEET_MAP.get(business_key, business_key)

    ty_values = None
    try:
        ty_values = get_sheet_values(DAILY_CY_TAB)
    except Exception:
        pass
    if not ty_values:
        return {"business": business_key, "rowCount": 0, "totalGmv": 0, "totalUnits": 0,
                "daily": [], "superCategories": [], "megaCategories": [], "ly": None,
                "breakdown": [], "bauSpike": None,
                "paymentShare": payment_shares({"upi": 0, "cod": 0, "pbo": 0, "others": 0}, 0)}

    ty_header = [str(h).strip() for h in ty_values[0]]
    ty_col = resolve_daily_columns(ty_header)
    ty_agg = aggregate_daily_rows(ty_values, ty_col, target_bu, filters, min_date=DAILY_CY_START)

    ly_values = ly_col = None
    ly_agg = None
    try:
        ly_values = get_sheet_values(DAILY_LY_TAB)
    except Exception:
        pass
    if ly_values:
        ly_header = [str(h).strip() for h in ly_values[0]]
        ly_col = resolve_daily_columns(ly_header)
        ly_agg = aggregate_daily_rows(ly_values, ly_col, target_bu, filters, min_date=DAILY_LY_START)

    ly_result = None
    if ly_agg:
        ly_result = {
            "totalGmv": ly_agg["totalGmv"], "totalUnits": ly_agg["totalUnits"],
            "daily": ly_agg["daily"],
            "paymentShare": payment_shares(ly_agg["paymentUnits"], ly_agg["totalUnits"]),
            "superCategories": ly_agg["superCategories"],
            "megaCategories": ly_agg["megaCategories"] if business_key == "LS" else [],
        }

    bau_values = bau_col = bau_cy_year = bau_ly_year = None
    try:
        bau_values = get_funnel_sheet_values(BAU_SHEET_TAB_NAME, sheet_id=FUNNEL_LY_SHEET_ID)
    except Exception:
        pass
    if bau_values:
        bau_header = [str(h).strip() for h in bau_values[0]]
        bau_col = resolve_bau_columns(bau_header)
        bau_cy_year, bau_ly_year = bau_years(bau_values, bau_col)

    bau_spike = None
    if bau_values and bau_cy_year:
        # For event-level spike: compare total event GMV vs BAU total (per-day * event_days)
        cy_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_cy_year, BAU_DAY_COUNTS["cy"], None)
        ly_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_ly_year, BAU_DAY_COUNTS["ly"], None)
        event_cy_days = len(ty_agg["daily"]) or BAU_DAY_COUNTS["cy"]
        event_ly_days = len(ly_agg["daily"]) if ly_agg else BAU_DAY_COUNTS["ly"]
        bau_spike = {
            "gmv": {
                "cy": spike_ratio(ty_agg["totalGmv"], cy_bau["gmv"] * event_cy_days),
                "ly": spike_ratio(ly_result["totalGmv"], ly_bau["gmv"] * event_ly_days) if ly_result else None,
            },
            "units": {
                "cy": spike_ratio(ty_agg["totalUnits"], cy_bau["units"] * event_cy_days),
                "ly": spike_ratio(ly_result["totalUnits"], ly_bau["units"] * event_ly_days) if ly_result else None,
            },
        }
        ly_sc_by_name = {s["name"]: s for s in (ly_result["superCategories"] if ly_result else [])}
        for sc in ty_agg["superCategories"]:
            is_this_sc = lambda row, col, name=sc["name"]: str(_cell(row, col["sc"])).strip() == name
            cy_sc_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_cy_year, BAU_DAY_COUNTS["cy"], None, is_this_sc)
            ly_sc_bau = bau_per_day(bau_values, bau_col, target_bu, filters, bau_ly_year, BAU_DAY_COUNTS["ly"], None, is_this_sc)
            ly_sc = ly_sc_by_name.get(sc["name"])
            sc["cyGmvSpike"] = spike_ratio(sc["gmv"], cy_sc_bau["gmv"] * event_cy_days)
            sc["cyUnitsSpike"] = spike_ratio(sc["units"], cy_sc_bau["units"] * event_cy_days)
            sc["lyGmvSpike"] = spike_ratio(ly_sc["gmv"], ly_sc_bau["gmv"] * event_ly_days) if ly_sc else None
            sc["lyUnitsSpike"] = spike_ratio(ly_sc["units"], ly_sc_bau["units"] * event_ly_days) if ly_sc else None
    else:
        for sc in ty_agg["superCategories"]:
            sc["cyGmvSpike"] = sc["lyGmvSpike"] = sc["cyUnitsSpike"] = sc["lyUnitsSpike"] = None
        for mc in ty_agg["megaCategories"]:
            mc["cyGmvSpike"] = mc["lyGmvSpike"] = mc["cyUnitsSpike"] = mc["lyUnitsSpike"] = None

    breakdown = compute_daily_breakdown(
        business_key, ty_values, ty_col, target_bu, filters,
        ly_values, ly_col, bau_values, bau_col, bau_cy_year, bau_ly_year,
    )

    return {
        "business": business_key, "rowCount": ty_agg["rowCount"],
        "totalGmv": ty_agg["totalGmv"], "totalUnits": ty_agg["totalUnits"],
        "daily": ty_agg["daily"],
        "paymentShare": payment_shares(ty_agg["paymentUnits"], ty_agg["totalUnits"]),
        "superCategories": ty_agg["superCategories"],
        "megaCategories": ty_agg["megaCategories"] if business_key == "LS" else [],
        "ly": ly_result,
        "breakdown": breakdown,
        "bauSpike": bau_spike,
    }


def parse_filters(args):
    return {k: args.get(k, "All") for k in FILTER_KEYS}


def cache_key_for(business, filters, day_key):
    return (business, day_key) + tuple(filters.get(k, "All") for k in FILTER_KEYS)


@app.route("/api/live-sales")
def api_live_sales():
    business = request.args.get("business", "LS")
    day_key = request.args.get("day", "D0")
    filters = parse_filters(request.args)
    key = cache_key_for(business, filters, day_key)
    now = time.time()
    cached = _aggregate_cache.get(key)
    if cached and now - cached[0] < AGGREGATE_CACHE_TTL:
        return jsonify(cached[1])
    try:
        result = get_live_sales_data(business, filters, day_key)
    except Exception as e:  # noqa: BLE001 — surface any auth/API error to the UI
        return jsonify({"error": str(e)}), 500
    # Only cache when both TY and LY are present — avoids serving a stale
    # ly=None result after the LY sheet is populated mid-session.
    if result["rowCount"] > 0 and result.get("ly") is not None:
        _aggregate_cache[key] = (now, result)
    return jsonify(result)


@app.route("/api/summary-sales")
def api_summary_sales():
    business = request.args.get("business", "LS")
    filters = parse_filters(request.args)
    key = ("summary-sales", business) + tuple(filters.get(k, "All") for k in FILTER_KEYS)
    now = time.time()
    cached = _aggregate_cache.get(key)
    if cached and now - cached[0] < AGGREGATE_CACHE_TTL:
        return jsonify(cached[1])
    try:
        result = get_summary_sales_data(business, filters)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["rowCount"] > 0:
        _aggregate_cache[key] = (now, result)
    return jsonify(result)


@app.route("/api/funnel-data")
def api_funnel_data():
    business = request.args.get("business", "LS")
    day_key = request.args.get("day", "D0")
    alpha_filter = request.args.get("alpha", "All")
    sc_filter = request.args.get("sc", "All")
    key = ("funnel", business, day_key, alpha_filter, sc_filter)
    now = time.time()
    cached = _aggregate_cache.get(key)
    if cached and now - cached[0] < AGGREGATE_CACHE_TTL:
        return jsonify(cached[1])
    try:
        result = get_funnel_data(business, day_key, alpha_filter, sc_filter)
    except Exception as e:  # noqa: BLE001 — surface any auth/API error to the UI
        return jsonify({"error": str(e)}), 500
    if result["rowCount"] > 0:
        _aggregate_cache[key] = (now, result)
    return jsonify(result)


# ---- Daily Traffic tabs constants (all in FUNNEL_SHEET_ID) ----
TRAFFIC_DAILY_BU_CY_TAB       = "BU_Daily_Traffic_CY"
TRAFFIC_DAILY_SEG_CY_TAB      = "BUxA_MP_Daily_Traffic_CY"
TRAFFIC_DAILY_SC_CY_TAB       = "SC_Daily_Traffic_CY"
TRAFFIC_DAILY_SC_ALPHA_CY_TAB = "SCxA_MP_Daily_Traffic_CY"
TRAFFIC_DAILY_BU_LY_TAB       = "BU_Daily_Traffic_LY"
TRAFFIC_DAILY_SEG_LY_TAB      = "BUxA_MP_Daily_Traffic_LY"
TRAFFIC_DAILY_SC_LY_TAB       = "SC_Daily_Traffic_LY"
TRAFFIC_DAILY_SC_ALPHA_LY_TAB = "SCxA_MP_Daily_Traffic_LY"


def resolve_traffic_daily_columns(header):
    """Daily traffic tabs use date_key + plain col names (same as LY hourly col map values).
    Stops at blank column (the tab has two sets of columns separated by an empty header)."""
    try:
        empty_idx = header.index("")
        header = header[:empty_idx]
    except ValueError:
        pass
    def idx(name): return header.index(name) if name in header else -1
    cols = {
        "date": idx("date_key"), "bu": idx("business_unit"),
        "sellerType": idx("seller_type"), "sc": idx("super_category"),
    }
    # Daily traffic uses the LY-style col names (search_bu_visits, not fm_search_bu_visits)
    ly_col_name = {v: v for _, _, _ in []}  # identity
    for key, cy_col, _ in TRAFFIC_METRICS:
        daily_col = TRAFFIC_LY_COL_MAP.get(cy_col) if cy_col else None
        cols[key] = idx(daily_col) if daily_col else -1
    return cols


def aggregate_traffic_daily_rows(values, col, target_bu, seller_filter=None, sc_filter=None,
                                  single_date_int=None, allowed_iso_dates=None):
    """Aggregate daily traffic rows. Returns totals + per-day list.
    allowed_iso_dates: if set, only aggregate rows whose dateIso is in this set (used for LY).
    Otherwise CY mode: single_date_int exact match OR date >= DAILY_CY_START."""
    # Dedup by (date_int, bu, sellerType, sc) — pipeline can produce duplicate rows
    keyed_rows = {}
    for row in values[1:]:
        date_int = _int(row, col["date"])
        s = str(date_int)
        date_iso = f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 else s
        if allowed_iso_dates is not None:
            if date_iso not in allowed_iso_dates:
                continue
        elif single_date_int is not None:
            if date_int != single_date_int:
                continue
        elif date_int < DAILY_CY_START:
            continue
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        seller = str(_cell(row, col.get("sellerType", -1))).strip()
        if seller_filter and seller != seller_filter:
            continue
        sc_name = str(_cell(row, col.get("sc", -1)) or "").strip()
        if sc_name and (sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in FUNNEL_DAILY_SC_EXCLUDE):
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        dedup_key = (date_iso, seller, sc_name)
        keyed_rows[dedup_key] = (date_iso, row)

    daily_by_date = {}
    totals = {k: 0 for k in TRAFFIC_METRIC_KEYS}
    for (_, seller, sc_name), (date_iso, row) in keyed_rows.items():
        d = daily_by_date.setdefault(date_iso, {k: 0 for k in TRAFFIC_METRIC_KEYS})
        visits   = _num(row, col["visits"])
        indirect = _num(row, col["indirect"])
        direct   = max(0, visits - indirect)
        for k in TRAFFIC_METRIC_KEYS:
            v = direct if k == "direct" else _num(row, col[k])
            d[k] += v
            totals[k] += v
    daily = [dict({"dateIso": iso}, **daily_by_date[iso]) for iso in sorted(daily_by_date)]
    return {"rowCount": len(daily), "totals": totals, "daily": daily}


def get_summary_traffic_data(business_key, alpha_filter="All", sc_filter="All", selected_day="All"):
    """Event Summary Traffic — cumulative across all event days, or a single day."""
    target_bu = BUSINESS_SHEET_MAP.get(business_key, business_key)
    alpha_active = bool(alpha_filter) and alpha_filter != "All"
    sc_active = bool(sc_filter) and sc_filter != "All"
    seller_filter = alpha_filter if alpha_active else None
    sc_filter_val = sc_filter if sc_active else None
    single_date_int = int(selected_day) if selected_day and selected_day != "All" else None

    # Pick grain tabs
    if alpha_active and sc_active:
        cy_tab = seg_cy_tab = sc_cy_tab = TRAFFIC_DAILY_SC_ALPHA_CY_TAB
        ly_tab = seg_ly_tab = sc_ly_tab = TRAFFIC_DAILY_SC_ALPHA_LY_TAB
    elif sc_active:
        cy_tab = TRAFFIC_DAILY_SC_CY_TAB; ly_tab = TRAFFIC_DAILY_SC_LY_TAB
        seg_cy_tab = TRAFFIC_DAILY_SEG_CY_TAB; seg_ly_tab = TRAFFIC_DAILY_SEG_LY_TAB
        sc_cy_tab = TRAFFIC_DAILY_SC_CY_TAB; sc_ly_tab = TRAFFIC_DAILY_SC_LY_TAB
    elif alpha_active:
        cy_tab = seg_cy_tab = TRAFFIC_DAILY_SEG_CY_TAB
        ly_tab = seg_ly_tab = TRAFFIC_DAILY_SEG_LY_TAB
        sc_cy_tab = TRAFFIC_DAILY_SC_ALPHA_CY_TAB; sc_ly_tab = TRAFFIC_DAILY_SC_ALPHA_LY_TAB
    else:
        cy_tab = TRAFFIC_DAILY_BU_CY_TAB; ly_tab = TRAFFIC_DAILY_BU_LY_TAB
        seg_cy_tab = TRAFFIC_DAILY_SEG_CY_TAB; seg_ly_tab = TRAFFIC_DAILY_SEG_LY_TAB
        sc_cy_tab = TRAFFIC_DAILY_SC_CY_TAB; sc_ly_tab = TRAFFIC_DAILY_SC_LY_TAB

    empty = {"business": business_key, "rowCount": 0,
             "totals": {k: 0 for k in TRAFFIC_METRIC_KEYS},
             "daily": [], "ly_daily": [], "days": [],
             "segments": [], "superCategories": [], "ly": None}

    try:
        cy_values = get_funnel_sheet_values(cy_tab, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        cy_values = None
    if not cy_values:
        return empty

    cy_col = resolve_traffic_daily_columns([str(h).strip() for h in cy_values[0]])
    cy_agg = aggregate_traffic_daily_rows(cy_values, cy_col, target_bu, seller_filter=seller_filter,
                                          sc_filter=sc_filter_val, single_date_int=single_date_int)

    date_map = get_funnel_date_map()
    days = [{"key": f"D{i}", "dateKey": int(d["dateIso"].replace("-", "")), "dateIso": d["dateIso"]}
            for i, d in enumerate(cy_agg["daily"])]

    ly_iso_set = set()
    days_to_map = [d for d in days if single_date_int is None or d["dateKey"] == single_date_int]
    for d in days_to_map:
        ly_int = date_map.get(d["dateKey"])
        if ly_int:
            s = str(ly_int)
            ly_iso_set.add(f"{s[:4]}-{s[4:6]}-{s[6:8]}")

    ly_result = None
    ly_daily = []
    if ly_iso_set:
        try:
            ly_values = get_funnel_sheet_values(ly_tab, sheet_id=FUNNEL_SHEET_ID)
        except Exception:
            ly_values = None
        if ly_values:
            ly_col = resolve_traffic_daily_columns([str(h).strip() for h in ly_values[0]])
            ly_agg = aggregate_traffic_daily_rows(ly_values, ly_col, target_bu, seller_filter=seller_filter,
                                                  sc_filter=sc_filter_val, allowed_iso_dates=ly_iso_set)
            ly_daily = ly_agg["daily"]
            ly_totals = {k: sum(d[k] for d in ly_daily) for k in TRAFFIC_METRIC_KEYS}
            if sum(ly_totals.values()) > 0:
                ly_result = {"totals": ly_totals}

    # Segment breakdown (Alpha/MP)
    segments = []
    try:
        seg_cy_values = get_funnel_sheet_values(seg_cy_tab, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        seg_cy_values = None
    seg_ly_values = None
    if ly_iso_set:
        try:
            seg_ly_values = get_funnel_sheet_values(seg_ly_tab, sheet_id=FUNNEL_SHEET_ID)
        except Exception:
            seg_ly_values = None
    if seg_cy_values:
        seg_col = resolve_traffic_daily_columns([str(h).strip() for h in seg_cy_values[0]])
        seg_ly_col = resolve_traffic_daily_columns([str(h).strip() for h in seg_ly_values[0]]) if seg_ly_values else None
        for label, seller in (("Alpha", "Alpha"), ("MP", "MP")):
            cy_seg_agg = aggregate_traffic_daily_rows(seg_cy_values, seg_col, target_bu,
                                                      seller_filter=seller, sc_filter=sc_filter_val,
                                                      single_date_int=single_date_int)
            seg_totals = cy_seg_agg["totals"]
            ly_seg_totals = None
            if seg_ly_values and seg_ly_col and ly_iso_set:
                ly_seg_agg = aggregate_traffic_daily_rows(seg_ly_values, seg_ly_col, target_bu,
                                                          seller_filter=seller, sc_filter=sc_filter_val,
                                                          allowed_iso_dates=ly_iso_set)
                ly_seg = ly_seg_agg["totals"]
                if sum(ly_seg.values()) > 0:
                    ly_seg_totals = ly_seg
            segments.append({"label": label, "ty": seg_totals, "ly": ly_seg_totals})

    # SC breakdown
    super_categories = []
    try:
        sc_values = get_funnel_sheet_values(sc_cy_tab, sheet_id=FUNNEL_SHEET_ID)
    except Exception:
        sc_values = None
    sc_ly_values = None
    if ly_iso_set:
        try:
            sc_ly_values = get_funnel_sheet_values(sc_ly_tab, sheet_id=FUNNEL_SHEET_ID)
        except Exception:
            sc_ly_values = None
    if sc_values:
        sc_col = resolve_traffic_daily_columns([str(h).strip() for h in sc_values[0]])
        sc_data_cy = {}
        for row in sc_values[1:]:
            if str(_cell(row, sc_col["bu"])).strip() != target_bu:
                continue
            date_int = _int(row, sc_col["date"])
            if single_date_int is not None:
                if date_int != single_date_int: continue
            elif date_int < DAILY_CY_START:
                continue
            if seller_filter and str(_cell(row, sc_col.get("sellerType", -1))).strip() != seller_filter:
                continue
            sc_name = str(_cell(row, sc_col.get("sc", -1)) or "Other").strip()
            if sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in FUNNEL_DAILY_SC_EXCLUDE:
                continue
            if sc_filter_val and sc_name != sc_filter_val:
                continue
            d = sc_data_cy.setdefault(sc_name, {k: 0 for k in TRAFFIC_METRIC_KEYS})
            visits = _num(row, sc_col["visits"])
            indirect = _num(row, sc_col["indirect"])
            direct = max(0, visits - indirect)
            for k in TRAFFIC_METRIC_KEYS:
                d[k] += direct if k == "direct" else _num(row, sc_col[k])
        super_categories = sorted([dict({"name": n}, **v) for n, v in sc_data_cy.items()], key=lambda r: -r["visits"])

    if sc_ly_values and ly_iso_set:
        sc_ly_col = resolve_traffic_daily_columns([str(h).strip() for h in sc_ly_values[0]])
        sc_data_ly = {}
        for row in sc_ly_values[1:]:
            if str(_cell(row, sc_ly_col["bu"])).strip() != target_bu:
                continue
            date_int = _int(row, sc_ly_col["date"])
            s = str(date_int)
            date_iso = f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 else s
            if date_iso not in ly_iso_set:
                continue
            if seller_filter and str(_cell(row, sc_ly_col.get("sellerType", -1))).strip() != seller_filter:
                continue
            sc_name = str(_cell(row, sc_ly_col.get("sc", -1)) or "Other").strip()
            if sc_name in EXCLUDED_SUPER_CATEGORIES or sc_name in FUNNEL_DAILY_SC_EXCLUDE:
                continue
            d = sc_data_ly.setdefault(sc_name, {k: 0 for k in TRAFFIC_METRIC_KEYS})
            visits = _num(row, sc_ly_col["visits"])
            indirect = _num(row, sc_ly_col["indirect"])
            direct = max(0, visits - indirect)
            for k in TRAFFIC_METRIC_KEYS:
                d[k] += direct if k == "direct" else _num(row, sc_ly_col[k])
        for r in super_categories:
            if r["name"] in sc_data_ly:
                r["ly"] = sc_data_ly[r["name"]]

    return {
        "business": business_key, "rowCount": cy_agg["rowCount"],
        "totals": cy_agg["totals"], "daily": cy_agg["daily"],
        "ly_daily": ly_daily, "days": days,
        "ly": ly_result,
        "segments": segments,
        "superCategories": super_categories,
    }


@app.route("/api/summary-traffic-data")
def api_summary_traffic_data():
    business = request.args.get("business", "LS")
    alpha_filter = request.args.get("alpha", "All")
    sc_filter = request.args.get("sc", "All")
    selected_day = request.args.get("day", "All")
    key = ("summary-traffic", business, alpha_filter, sc_filter, selected_day)
    now = time.time()
    cached = _aggregate_cache.get(key)
    if cached and now - cached[0] < AGGREGATE_CACHE_TTL:
        return jsonify(cached[1])
    try:
        result = get_summary_traffic_data(business, alpha_filter, sc_filter, selected_day)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if result["rowCount"] > 0:
        _aggregate_cache[key] = (now, result)
    return jsonify(result)


@app.route("/api/summary-funnel-data")
def api_summary_funnel_data():
    business = request.args.get("business", "LS")
    alpha_filter = request.args.get("alpha", "All")
    sc_filter = request.args.get("sc", "All")
    selected_day = request.args.get("day", "All")
    key = ("summary-funnel", business, alpha_filter, sc_filter, selected_day)
    now = time.time()
    cached = _aggregate_cache.get(key)
    if cached and now - cached[0] < AGGREGATE_CACHE_TTL:
        return jsonify(cached[1])
    try:
        result = get_summary_funnel_data(business, alpha_filter, sc_filter, selected_day)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    if result["rowCount"] > 0:
        _aggregate_cache[key] = (now, result)
    return jsonify(result)


@app.route("/api/funnel-filter-options")
def api_funnel_filter_options():
    business = request.args.get("business", "LS")
    target_bu = BUSINESS_SHEET_MAP.get(business, business)
    try:
        values = get_funnel_sheet_values(FUNNEL_SC_CY_TAB)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    sc_set = set()
    if values:
        col = resolve_funnel_cy_columns([str(h).strip() for h in values[0]])
        for row in values[1:]:
            if str(_cell(row, col["bu"])).strip() != target_bu:
                continue
            name = str(_cell(row, col["sc"]) or "").strip()
            if name and name not in EXCLUDED_SUPER_CATEGORIES:
                sc_set.add(name)
    return jsonify({"alpha": ["Alpha", "MP"], "sc": sorted(sc_set)})


@app.route("/api/traffic-data")
def api_traffic_data():
    business     = request.args.get("business", "LS")
    day_key      = request.args.get("day", "D0")
    alpha_filter = request.args.get("alpha", "All")
    sc_filter    = request.args.get("sc", "All")
    key = ("traffic", business, day_key, alpha_filter, sc_filter)
    now = time.time()
    cached = _aggregate_cache.get(key)
    if cached and now - cached[0] < AGGREGATE_CACHE_TTL:
        return jsonify(cached[1])
    try:
        result = get_traffic_data(business, day_key, alpha_filter, sc_filter)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    if result["rowCount"] > 0:
        _aggregate_cache[key] = (now, result)
    return jsonify(result)


@app.route("/api/traffic-filter-options")
def api_traffic_filter_options():
    business  = request.args.get("business", "LS")
    target_bu = BUSINESS_SHEET_MAP.get(business, business)
    try:
        values = get_funnel_sheet_values(TRAFFIC_SC_CY_TAB, sheet_id=FUNNEL_SHEET_ID)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    sc_set = set()
    if values:
        col = resolve_traffic_columns([str(h).strip() for h in values[0]])
        for row in values[1:]:
            if str(_cell(row, col["bu"])).strip() != target_bu:
                continue
            name = str(_cell(row, col.get("sc", -1)) or "").strip()
            if name and name not in EXCLUDED_SUPER_CATEGORIES:
                sc_set.add(name)
    return jsonify({"alpha": ["Alpha", "MP"], "sc": sorted(sc_set)})


def _cvp_sheet_values(tab):
    key = f"cvp::{tab}"
    now = time.time()
    cached = _sheet_cache.get(key)
    if cached and now - cached["ts"] < SHEET_READ_CACHE_TTL:
        return cached["values"]
    creds = get_credentials()
    service = build("sheets", "v4", credentials=creds)
    result = service.spreadsheets().values().get(
        spreadsheetId=CVP_SHEET_ID, range=f"'{tab}'"
    ).execute()
    values = result.get("values", [])
    _sheet_cache[key] = {"ts": now, "values": values}
    return values


NB_HOURLY_TAB = "NB_Hourly_Raw"


def _nb_sheet_values():
    key = f"cvp::{NB_HOURLY_TAB}"
    now = time.time()
    cached = _sheet_cache.get(key)
    if cached and now - cached["ts"] < SHEET_READ_CACHE_TTL:
        return cached["values"]
    creds = get_credentials()
    service = build("sheets", "v4", credentials=creds)
    result = service.spreadsheets().values().get(
        spreadsheetId=CVP_SHEET_ID, range=f"'{NB_HOURLY_TAB}'"
    ).execute()
    values = result.get("values", [])
    _sheet_cache[key] = {"ts": now, "values": values}
    return values


def _nb_resolve_col(header):
    def idx(name): return header.index(name) if name in header else -1
    return {
        "bu":   idx("bu"),
        "sc":   idx("super_category"),
        "hour": idx("hour"),
        "ppvs": idx("ppvs"),
        "nb":   idx("NB_PPVS"),
        "ns":   idx("NS"),
        "oos":  idx("OOS"),
    }


def _nb_agg_rows(values, col, target_bu, hour_limit=None, sc_filter=None):
    totals = {"ppvs": 0, "nb": 0, "ns": 0, "oos": 0}
    by_hour = {}
    sc_data = {}
    for row in values[1:]:
        max_col = max(col["ppvs"], col["nb"], col["ns"], col["oos"], col["bu"])
        if len(row) <= max_col: continue
        if str(row[col["bu"]]).strip() != target_bu: continue
        sc_name = str(row[col["sc"]] if col["sc"] >= 0 and len(row) > col["sc"] else "").strip()
        if sc_name in EXCLUDED_SUPER_CATEGORIES: continue
        if sc_filter and sc_name != sc_filter: continue
        try:
            hr = int(row[col["hour"]]) if col["hour"] >= 0 and len(row) > col["hour"] else 0
            if hour_limit is not None and hr >= hour_limit: continue
            ppvs = float(row[col["ppvs"]] or 0)
            nb   = float(row[col["nb"]]   or 0)
            ns   = float(row[col["ns"]]   or 0)
            oos  = float(row[col["oos"]]  or 0)
        except (ValueError, IndexError):
            continue
        for k, v in [("ppvs", ppvs), ("nb", nb), ("ns", ns), ("oos", oos)]:
            totals[k] += v
        oh = by_hour.setdefault(hr, {"ppvs": 0, "nb": 0, "ns": 0, "oos": 0})
        oh["ppvs"] += ppvs; oh["nb"] += nb; oh["ns"] += ns; oh["oos"] += oos
        if sc_name:
            sd = sc_data.setdefault(sc_name, {"ppvs": 0, "nb": 0, "ns": 0, "oos": 0})
            sd["ppvs"] += ppvs; sd["nb"] += nb; sd["ns"] += ns; sd["oos"] += oos

    def metrics(d):
        ppvs = d["ppvs"]
        return {
            "nsPct":  (d["ns"]  / ppvs) if ppvs else None,
            "nbPct":  (d["nb"]  / ppvs) if ppvs else None,
            "oosPct": (d["oos"] / ppvs) if ppvs else None,
            "ppvs":   ppvs,
        }

    hourly = [dict({"hour": h}, **metrics(by_hour[h])) for h in sorted(by_hour)]
    sc_rows = sorted(
        [dict({"name": n}, **metrics(v)) for n, v in sc_data.items()],
        key=lambda r: -(r["oosPct"] or 0)
    )
    return {"totals": metrics(totals), "hourly": hourly, "superCategories": sc_rows}


def _cvp_resolve_col(header):
    def idx(name): return header.index(name) if name in header else -1
    return {
        "bu":     idx("analytic_business_unit"),
        "sc":     idx("analytic_super_category"),
        "hour":   idx("hour_of_day"),
        "ip_cur": idx("ip_cur_asp"), "ip_bau": idx("ip_bau_asp"),
        "op_cur": idx("op_cur_asp"), "op_bau": idx("op_bau_asp"),
    }


def _cvp_agg_rows(values, col, target_bu, hour_limit=None, sc_filter=None):
    """Aggregate CY or LY CVP rows — returns totals, hourly series, and SC breakdown."""
    totals = {"ip_cur": 0, "ip_bau": 0, "op_cur": 0, "op_bau": 0}
    by_hour = {}
    sc_data = {}
    for row in values[1:]:
        if len(row) <= col["op_bau"]: continue
        if str(row[col["bu"]]).strip() != target_bu: continue
        sc_name = str(row[col["sc"]] if col["sc"] >= 0 and len(row) > col["sc"] else "").strip()
        if sc_name in EXCLUDED_SUPER_CATEGORIES: continue
        if sc_filter and sc_name != sc_filter: continue
        try:
            hr = int(row[col["hour"]]) if col["hour"] >= 0 and len(row) > col["hour"] else 0
            if hour_limit is not None and hr >= hour_limit: continue
            ip_cur = float(row[col["ip_cur"]] or 0)
            ip_bau = float(row[col["ip_bau"]] or 0)
            op_cur = float(row[col["op_cur"]] or 0)
            op_bau = float(row[col["op_bau"]] or 0)
        except (ValueError, IndexError):
            continue
        for k, v in [("ip_cur", ip_cur), ("ip_bau", ip_bau), ("op_cur", op_cur), ("op_bau", op_bau)]:
            totals[k] += v
        oh = by_hour.setdefault(hr, {"ip_cur": 0, "ip_bau": 0, "op_cur": 0, "op_bau": 0})
        oh["ip_cur"] += ip_cur; oh["ip_bau"] += ip_bau
        oh["op_cur"] += op_cur; oh["op_bau"] += op_bau
        if sc_name:
            sd = sc_data.setdefault(sc_name, {"ip_cur": 0, "ip_bau": 0, "op_cur": 0, "op_bau": 0})
            sd["ip_cur"] += ip_cur; sd["ip_bau"] += ip_bau
            sd["op_cur"] += op_cur; sd["op_bau"] += op_bau

    def metrics(d):
        op = (d["op_cur"] / d["op_bau"] - 1) if d["op_bau"] else None
        ip = (d["ip_cur"] / d["ip_bau"] - 1) if d["ip_bau"] else None
        return {"outputPriceDrop": op, "inputPriceDrop": ip}

    hourly = [dict({"hour": h}, **metrics(by_hour[h])) for h in sorted(by_hour)]
    sc_rows = sorted(
        [dict({"name": n}, **metrics(v)) for n, v in sc_data.items()],
        key=lambda r: -(abs(r["outputPriceDrop"] or 0))
    )
    return {"totals": metrics(totals), "hourly": hourly, "superCategories": sc_rows, "rowCount": len(by_hour)}


def get_cvp_data(business_key, sc_filter="All"):
    target_bu  = BUSINESS_SHEET_MAP.get(business_key, business_key)
    sc_filter_val = sc_filter if sc_filter and sc_filter != "All" else None

    cy_values = _cvp_sheet_values(CVP_CY_TAB)
    ly_values = _cvp_sheet_values(CVP_LY_TAB)

    if not cy_values:
        return {"business": business_key, "cy": None, "ly": None,
                "hourly": [], "superCategories": [], "lyHourly": []}

    cy_col = _cvp_resolve_col([str(h).strip() for h in cy_values[0]])
    cy = _cvp_agg_rows(cy_values, cy_col, target_bu, sc_filter=sc_filter_val)

    ly = None
    ly_hourly = []
    if ly_values:
        ly_col = _cvp_resolve_col([str(h).strip() for h in ly_values[0]])
        ly_agg = _cvp_agg_rows(ly_values, ly_col, target_bu, sc_filter=sc_filter_val)
        ly = ly_agg["totals"]
        ly_hourly = ly_agg["hourly"]

    # SC-level LY matched by name
    sc_ly_by_name = {}
    if ly_values:
        ly_col2 = _cvp_resolve_col([str(h).strip() for h in ly_values[0]])
        ly_sc = _cvp_agg_rows(ly_values, ly_col2, target_bu)
        sc_ly_by_name = {r["name"]: r for r in ly_sc["superCategories"]}
    for r in cy["superCategories"]:
        r["ly"] = sc_ly_by_name.get(r["name"])

    # NB / NS / OOS metrics from NB_Hourly_Raw
    nb_values = _nb_sheet_values()
    nb_data = {"totals": None, "hourly": [], "superCategories": []}
    if nb_values:
        nb_col = _nb_resolve_col([str(h).strip() for h in nb_values[0]])
        nb_agg = _nb_agg_rows(nb_values, nb_col, target_bu, sc_filter=sc_filter_val)
        nb_data = nb_agg
        # Merge NB metrics into CVP SC rows by name
        nb_sc_by_name = {r["name"]: r for r in nb_agg["superCategories"]}
        for r in cy["superCategories"]:
            r["nb"] = nb_sc_by_name.get(r["name"])

    # SC filter options
    sc_set = sorted({r["name"] for r in cy["superCategories"]})

    return {
        "business": business_key, "cy": cy["totals"], "ly": ly,
        "hourly": cy["hourly"], "lyHourly": ly_hourly,
        "superCategories": cy["superCategories"],
        "filterOptions": {"sc": sc_set},
        "rowCount": cy["rowCount"],
        "nb": nb_data["totals"],
        "nbHourly": nb_data["hourly"],
    }


@app.route("/api/cvp-data")
def api_cvp_data():
    business  = request.args.get("business", "LS")
    sc_filter = request.args.get("sc", "All")
    key = ("cvp", business, sc_filter)
    now = time.time()
    cached = _aggregate_cache.get(key)
    if cached and now - cached[0] < AGGREGATE_CACHE_TTL:
        return jsonify(cached[1])
    try:
        result = get_cvp_data(business, sc_filter)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    if result.get("cy"):
        _aggregate_cache[key] = (now, result)
    return jsonify(result)


@app.route("/api/filter-options")
def api_filter_options():
    business = request.args.get("business", "LS")
    target_bu = BUSINESS_SHEET_MAP.get(business, business)
    try:
        values = get_sheet_values(SALES_SHEET_TAB_NAME)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    if not values:
        return jsonify({k: [] for k in FILTER_KEYS})

    header = [str(h).strip() for h in values[0]]
    col = resolve_columns(header)
    distinct = {k: set() for k in FILTER_KEYS}
    for row in values[1:]:
        if str(_cell(row, col["bu"])).strip() != target_bu:
            continue
        if sc_excluded(row, col):
            continue
        for k in FILTER_KEYS:
            v = str(_cell(row, col[k])).strip()
            if v:
                distinct[k].add(v)
    return jsonify({k: sorted(vs) for k, vs in distinct.items()})


@app.route("/api/sales-debug")
def api_sales_debug():
    try:
        values = get_sheet_values(SALES_SHEET_TAB_NAME)
        creds = get_credentials()
        service = build("sheets", "v4", credentials=creds)
        meta = service.spreadsheets().get(spreadsheetId=SALES_SHEET_ID).execute()
        all_sheets = [
            {"name": s["properties"]["title"], "rows": s["properties"].get("gridProperties", {}).get("rowCount", 0)}
            for s in meta["sheets"]
        ]
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500

    header = [str(h).strip() for h in values[0]] if values else []
    bu_i = header.index("analytic_business_unit") if "analytic_business_unit" in header else -1
    date_i = header.index("order_date_key") if "order_date_key" in header else -1

    max_date = 0
    bu_overall, bu_at_max = {}, {}
    for row in values[1:]:
        d = _int(row, date_i)
        bu = str(_cell(row, bu_i)).strip()
        if d > max_date:
            max_date = d
        bu_overall[bu] = bu_overall.get(bu, 0) + 1
    for row in values[1:]:
        if _int(row, date_i) != max_date:
            continue
        bu = str(_cell(row, bu_i)).strip()
        bu_at_max[bu] = bu_at_max.get(bu, 0) + 1

    return jsonify({
        "numSheetsInFile": len(all_sheets),
        "allSheets": all_sheets,
        "activeSheetName": SALES_SHEET_TAB_NAME,
        "totalDataRows": max(len(values) - 1, 0),
        "header": header,
        "maxDate": max_date,
        "businessUnitCountsOverall": bu_overall,
        "businessUnitCountsAtMaxDate": bu_at_max,
        "businessSheetMap": BUSINESS_SHEET_MAP,
    })


# ---- serve the same static frontend as the plain python http.server did ----
@app.route("/api/insights", methods=["POST"])
def api_insights():
    try:
        import anthropic as _anthropic
        body = request.get_json(force=True) or {}
        prompt = body.get("prompt", "")
        if not prompt:
            return jsonify({"error": "empty prompt"}), 400
        client = _anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text if msg.content else ""
        return jsonify({"text": text})
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(ROOT, path)


if __name__ == "__main__":
    app.run(port=8934, debug=True)
