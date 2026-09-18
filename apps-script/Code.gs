/**
 * Event Reporting Center — Google Apps Script web app entry point.
 * Deploy: Extensions > Apps Script > paste these files > Deploy > New deployment > Web app.
 * Sales tab (Live Today) pulls real GMV/Units from SALES_SHEET_ID; every other
 * tab is still illustrative mock data (see js/data.js / MainScript.html).
 */

/** Source-of-truth sheet: https://docs.google.com/spreadsheets/d/<this id>/edit#gid=0 */
const SALES_SHEET_ID = '1zaFYp_PE0jIlRZjC_As18xLLAFCJM2qaitc_3sMt63Y';
/** The spreadsheet has multiple tabs ("Configs Rules", "Sales Live", ...) —
    getSheets()[0] silently grabbed the wrong (empty) one. Always read by name. */
const SALES_SHEET_TAB_NAME = 'Sales Live';

function getSalesSheet_(){
  const sheet = SpreadsheetApp.openById(SALES_SHEET_ID).getSheetByName(SALES_SHEET_TAB_NAME);
  if(!sheet) throw new Error(`Tab "${SALES_SHEET_TAB_NAME}" not found in the spreadsheet — check SALES_SHEET_TAB_NAME in Code.gs.`);
  return sheet;
}

/** Master business-switcher key -> exact analytic_business_unit value in the sheet. */
const BUSINESS_SHEET_MAP = { LS: 'LifeStyle', BGM: 'BGM', Home: 'Home', Furniture: 'Furniture' };

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Event Reporting Center')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used by Index.html's <?!= include('X'); ?> scriptlets to inline Stylesheet/DataScript/MainScript. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Aggregates the raw row-level sheet (order_date_key, hour_of_day,
 * analytic_business_unit, analytic_super_category, gmv, units, ...) for the
 * given master-business key, scoped to the sheet's most recent date present.
 * Called from MainScript.html via google.script.run for Live Today > Sales.
 *
 * Returns: { business, sheetBusinessUnit, dateKey, rowCount, totalGmv, totalUnits,
 *            hourly: [{hour, gmv, units}], superCategories: [{name, gmv, units, hourly}] }
 */
const CACHE_TTL_SECONDS = 300; // 5 min — sheet reads are slow on a large dataset

function getLiveSalesData(businessKey) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'liveSales_' + businessKey;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const targetBU = BUSINESS_SHEET_MAP[businessKey] || businessKey;
  const sheet = getSalesSheet_();
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(h => String(h).trim());
  const col = {
    date: header.indexOf('order_date_key'),
    hour: header.indexOf('hour_of_day'),
    bu: header.indexOf('analytic_business_unit'),
    sc: header.indexOf('analytic_super_category'),
    gmv: header.indexOf('gmv'),
    units: header.indexOf('units'),
  };

  let maxDate = 0;
  for (let i = 1; i < values.length; i++) {
    const d = Number(values[i][col.date]);
    if (d > maxDate) maxDate = d;
  }

  const overallByHour = {};
  const sc = {}; // name -> { gmv, units, byHour: { hour: {gmv, units} } }
  let totalGmv = 0, totalUnits = 0, rowCount = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (Number(row[col.date]) !== maxDate) continue;
    if (String(row[col.bu]).trim() !== targetBU) continue;

    const gmv = Number(row[col.gmv]) || 0;
    const units = Number(row[col.units]) || 0;
    const hr = Number(row[col.hour]);
    const scName = String(row[col.sc] || 'Other').trim();

    if (!overallByHour[hr]) overallByHour[hr] = { gmv: 0, units: 0 };
    overallByHour[hr].gmv += gmv;
    overallByHour[hr].units += units;

    if (!sc[scName]) sc[scName] = { gmv: 0, units: 0, byHour: {} };
    sc[scName].gmv += gmv;
    sc[scName].units += units;
    if (!sc[scName].byHour[hr]) sc[scName].byHour[hr] = { gmv: 0, units: 0 };
    sc[scName].byHour[hr].gmv += gmv;
    sc[scName].byHour[hr].units += units;

    totalGmv += gmv;
    totalUnits += units;
    rowCount++;
  }

  const toHourlyArray = byHour => Object.keys(byHour).map(Number).sort((a, b) => a - b)
    .map(h => ({ hour: h, gmv: byHour[h].gmv, units: byHour[h].units }));

  const result = {
    business: businessKey,
    sheetBusinessUnit: targetBU,
    dateKey: maxDate,
    rowCount: rowCount,
    totalGmv: totalGmv,
    totalUnits: totalUnits,
    hourly: toHourlyArray(overallByHour),
    superCategories: Object.keys(sc)
      .sort((a, b) => sc[b].gmv - sc[a].gmv)
      .map(name => ({ name: name, gmv: sc[name].gmv, units: sc[name].units, hourly: toHourlyArray(sc[name].byHour) })),
  };

  if (rowCount > 0) {
    // Don't cache empty results — a config fix (e.g. wrong tab/business name)
    // should take effect immediately, not wait out the TTL.
    try {
      cache.put(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
    } catch (e) {
      // Result too large for the 100KB cache value limit — just skip caching, not fatal.
    }
  }
  return result;
}

/** Bypasses the cache — call after fixing BUSINESS_SHEET_MAP or updating the sheet. */
function clearLiveSalesCache(){
  const cache = CacheService.getScriptCache();
  Object.keys(BUSINESS_SHEET_MAP).forEach(k => cache.remove('liveSales_' + k));
}

/**
 * Diagnostic helper — call this (temporarily, from the browser) when
 * getLiveSalesData() returns rowCount 0, to see exactly why: which business
 * unit strings actually exist in the sheet, whether they only show up on
 * some dates, and whether there's more than one sheet/tab in the file.
 */
function getSalesDebugInfo() {
  const ss = SpreadsheetApp.openById(SALES_SHEET_ID);
  const allSheets = ss.getSheets().map(s => ({ name: s.getName(), rows: s.getLastRow() }));
  const sheet = getSalesSheet_();
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(h => String(h).trim());
  const col = { date: header.indexOf('order_date_key'), bu: header.indexOf('analytic_business_unit') };

  let maxDate = 0;
  const buCountsOverall = {};
  for (let i = 1; i < values.length; i++) {
    const d = Number(values[i][col.date]);
    const bu = String(values[i][col.bu]).trim();
    if (d > maxDate) maxDate = d;
    buCountsOverall[bu] = (buCountsOverall[bu] || 0) + 1;
  }

  const buCountsAtMaxDate = {};
  for (let i = 1; i < values.length; i++) {
    if (Number(values[i][col.date]) !== maxDate) continue;
    const bu = String(values[i][col.bu]).trim();
    buCountsAtMaxDate[bu] = (buCountsAtMaxDate[bu] || 0) + 1;
  }

  return {
    numSheetsInFile: allSheets.length,
    allSheets: allSheets,
    activeSheetName: sheet.getName(),
    totalDataRows: values.length - 1,
    header: header,
    maxDate: maxDate,
    businessUnitCountsOverall: buCountsOverall,
    businessUnitCountsAtMaxDate: buCountsAtMaxDate,
    businessSheetMap: BUSINESS_SHEET_MAP,
  };
}
