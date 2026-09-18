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
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
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
SALES_SHEET_ID = "1zaFYp_PE0jIlRZjC_As18xLLAFCJM2qaitc_3sMt63Y"
SALES_SHEET_TAB_NAME = "Sales Live"
LY_SHEET_TAB_NAME = "Sales Live Historical"
BAU_SHEET_TAB_NAME = "BAU sales"
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
# Junk/duplicate Super Categories excluded from every aggregation (Sales KPIs,
# Sales SC/Mega-Cat breakdowns, BAU, filter-options dropdown, and Funnel's
# SC-level breakdowns) — not just hidden from a table, their rows don't count.
EXCLUDED_SUPER_CATEGORIES = {
    "LifeStyle", "GemsAndJewellery", "MensClothingEssentialsAndEthnic",
    "MensClothingCasualTopwear", "MenAccessory",
}

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

# TY <-> LY date correspondence isn't a fixed offset (event calendars don't
# align day-for-day) — resolved per-date from this authoritative mapping tab.
FUNNEL_DATE_MAP_TAB = "Date Mapping"                       # FUNNEL_LY_SHEET_ID

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
        if want and want != "All" and str(_cell(row, col[key])).strip() != want:
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
        mc_name = str(_cell(row, col["megaCat"]) or "Other").strip()

        oh = overall_by_hour.setdefault(hr, {"gmv": 0, "units": 0})
        oh["gmv"] += gmv
        oh["units"] += units

        scd = sc_data.setdefault(sc_name, {"gmv": 0, "units": 0, "byHour": {}, "payment": {"upi": 0, "cod": 0, "pbo": 0, "others": 0}})
        scd["gmv"] += gmv
        scd["units"] += units
        scd["payment"]["upi"] += upi
        scd["payment"]["cod"] += cod
        scd["payment"]["pbo"] += pbo
        scd["payment"]["others"] += others
        sh = scd["byHour"].setdefault(hr, {"gmv": 0, "units": 0})
        sh["gmv"] += gmv
        sh["units"] += units

        mcd = mc_data.setdefault(mc_name, {"gmv": 0, "units": 0, "byHour": {}, "payment": {"upi": 0, "cod": 0, "pbo": 0, "others": 0}})
        mcd["gmv"] += gmv
        mcd["units"] += units
        mcd["payment"]["upi"] += upi
        mcd["payment"]["cod"] += cod
        mcd["payment"]["pbo"] += pbo
        mcd["payment"]["others"] += others
        mh = mcd["byHour"].setdefault(hr, {"gmv": 0, "units": 0})
        mh["gmv"] += gmv
        mh["units"] += units

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
            }
            for name, v in sc_sorted
        ],
        "megaCategories": [
            {
                "name": name, "gmv": v["gmv"], "units": v["units"], "hourly": to_hourly(v["byHour"]),
                "paymentShare": payment_shares(v["payment"], v["units"]),
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


def breakdown_segments(business_key):
    """Top-level (label, predicate, [(childLabel, childPredicate), ...]) triples
    defining the rows of the breakdown table — each top row can be expanded
    into its Alpha/MP (or Branded/Unbranded) children."""
    is_apparel = lambda row, col: str(_cell(row, col["sc"])).strip() in LS_APPAREL_SC
    is_alpha = lambda row, col: str(_cell(row, col["alpha"])).strip() == ALPHA_VALUE
    is_mp = lambda row, col: str(_cell(row, col["alpha"])).strip() == MP_VALUE
    is_branded = lambda row, col: str(_cell(row, col["branded"])).strip() == "Branded"
    is_unbranded = lambda row, col: str(_cell(row, col["branded"])).strip() == "Unbranded"

    if business_key == "LS":
        is_non_apparel = lambda row, col: not is_apparel(row, col)
        return [
            ("Apparel", is_apparel, [
                ("Apparel x Alpha", lambda row, col: is_apparel(row, col) and is_alpha(row, col)),
                ("Apparel x MP", lambda row, col: is_apparel(row, col) and is_mp(row, col)),
            ]),
            ("Non-Apparel", is_non_apparel, [
                ("Non-Apparel x Alpha", lambda row, col: is_non_apparel(row, col) and is_alpha(row, col)),
                ("Non-Apparel x MP", lambda row, col: is_non_apparel(row, col) and is_mp(row, col)),
            ]),
        ]
    return [
        ("Alpha", is_alpha, [
            ("Alpha x Branded", lambda row, col: is_alpha(row, col) and is_branded(row, col)),
            ("Alpha x Unbranded", lambda row, col: is_alpha(row, col) and is_unbranded(row, col)),
        ]),
        ("MP", is_mp, [
            ("MP x Branded", lambda row, col: is_mp(row, col) and is_branded(row, col)),
            ("MP x Unbranded", lambda row, col: is_mp(row, col) and is_unbranded(row, col)),
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
    for label, predicate, children in breakdown_segments(business_key):
        row = row_for(label, predicate)
        row["children"] = [row_for(clabel, cpredicate) for clabel, cpredicate in children]
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
        if sc_name in EXCLUDED_SUPER_CATEGORIES:
            continue
        if sc_filter and sc_name != sc_filter:
            continue
        d = sc_data.setdefault(sc_name, {k: 0 for k in FUNNEL_METRIC_KEYS})
        for key in FUNNEL_METRIC_KEYS:
            d[key] += _num(row, col[key])
    sc_sorted = sorted(sc_data.items(), key=lambda kv: -kv[1]["visits"])
    return [dict({"name": name}, **totals) for name, totals in sc_sorted]


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
        bau_values = get_sheet_values(BAU_SHEET_TAB_NAME)
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
@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(ROOT, path)


if __name__ == "__main__":
    app.run(port=8934, debug=True)
