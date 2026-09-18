# Deploying to Google Apps Script

This folder is the Apps Script version of the Event Reporting Center. Only
**Live Today → Sales** reads real data (from the Google Sheet configured in
`Code.gs`'s `SALES_SHEET_ID`); every other tab is an explicit "Coming Soon"
placeholder until it has a data source.

## First-time setup (one of these two)

### Option A — Copy-paste (no tooling required)

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Rename it (e.g. "Event Reporting Center").
3. Replace the default `Code.gs` content with this folder's `Code.gs`.
4. For each of `Index.html`, `Stylesheet.html`, `DataScript.html`, `MainScript.html`:
   click **+ → HTML**, name it exactly as shown (no `.html` needed), paste the contents.
5. Gear icon → Project Settings → check "Show `appsscript.json` manifest file" →
   replace its contents with this folder's `appsscript.json`.
6. **Deploy → New deployment → Web app** → Execute as **Me**, access **Anyone** → **Deploy**.
   Authorize when prompted (it needs Sheets read access).

### Option B — `clasp` (recommended if you'll be updating this often)

```bash
npm install -g @google/clasp
clasp login          # opens a browser to authorize once
```

Link `clasp` to your **existing** deployed project (don't use `clasp create`,
that makes a new, separate project):

1. Open your project at script.google.com → gear icon (Project Settings) →
   copy the **Script ID**.
2. In `apps-script/`, copy `.clasp.json.example` to `.clasp.json` and paste
   your Script ID in:
   ```bash
   cd apps-script
   cp .clasp.json.example .clasp.json
   # edit .clasp.json, replace PASTE_YOUR_SCRIPT_ID_HERE
   ```
3. `clasp push` — this uploads all 5 files (Code.gs + 4 HTML) in one command,
   overwriting what's in the editor. Confirm "yes" if it warns about overwriting.

## Fast updates with clasp (no copy-paste, ever again)

Once `.clasp.json` is set up, whenever you change `js/main.js`, `js/data.js`,
or `css/style.css` at the project root, run:

```bash
cd apps-script
./sync.sh
```

This regenerates `Stylesheet.html` / `DataScript.html` / `MainScript.html`
from the root source files and pushes everything with `clasp push` — one
command, no browser tab needed.

**Important**: `clasp push` updates the project's files, but your **live web
app URL keeps serving the old code** until you cut a new deployment version:

```bash
clasp deploy          # creates a new versioned deployment
```

Or in the editor: **Deploy → Manage deployments → ✏️ (edit) → New version → Deploy**.
(A bare `clasp push` alone is enough while testing via **Deploy → Test deployments**,
which always runs head/latest code — useful to skip the version-bump step while iterating.)

## Notes

- `Code.gs`: `doGet()` serves `Index.html`; `include()` inlines the CSS/JS
  files (Apps Script's HtmlService can't load separate `.css`/`.js` by URL);
  `getLiveSalesData()` reads and aggregates the Sheet for Live Today → Sales.
- `js/data.js` / `js/main.js` / `css/style.css` at the project root are the
  source of truth — always edit those, then run `sync.sh` (or the manual
  `cat`-and-paste steps) to propagate into this folder. Don't hand-edit
  `Stylesheet.html` / `DataScript.html` / `MainScript.html` directly, they get
  overwritten on the next sync.
