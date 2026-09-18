# Local dev backend (real live Sheet data, no Apps Script needed)

This Flask server does the same thing `apps-script/Code.gs` does in
production — reads and aggregates the `Sales Live` tab of the Google Sheet —
but runs locally so `Live Today > Sales` shows real numbers while you iterate,
without touching the Apps Script deployment.

## One-time setup

### 1. Install dependencies

```bash
cd server
python3 -m venv venv          # optional but recommended
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Set up auth — pick ONE of these

**Option A — Service account (recommended, no browser step)**

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the
   **Google Sheets API**, then create a **Service Account**
   (IAM & Admin → Service Accounts → Create).
2. Create a **key** for it (Keys tab → Add Key → JSON) and save the downloaded
   file as `server/service-account.json` (exact filename — it's gitignored).
3. **Share the Google Sheet** with the service account's email (found in the
   JSON as `client_email`, looks like `xxx@yyy.iam.gserviceaccount.com`) —
   Viewer access is enough. Service accounts don't inherit your own Drive
   access, so this step is required or you'll get a permission error.

**Option B — OAuth as yourself (no sheet-sharing needed, but a browser step every setup)**

1. **APIs & Services → OAuth consent screen** → set it up (Internal is fine if
   your Google Workspace allows it; External + "Testing" mode also works —
   add your own email as a test user).
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   application type **Desktop app**, download the JSON.
3. Save it as `server/credentials.json` (exact filename — it's gitignored).
4. First run opens a browser to sign in and approve read-only Sheets access;
   after approving once, it caches `server/token.json` and won't ask again.

If both files are present, the service account takes priority.

### 3. Run it

```bash
python3 app.py
```

### 4. Open the dashboard

Visit **http://localhost:8934** — same UI as the plain static server, but
`Live Today > Sales` now fetches real data from `/api/live-sales` instead of
showing "Preview mode".

## Notes

- `SALES_SHEET_ID`, `SALES_SHEET_TAB_NAME`, and `BUSINESS_SHEET_MAP` in
  `app.py` are kept in sync with the same constants in `apps-script/Code.gs`.
  If you change the sheet/tab/business mapping, update both places.
- Responses are cached in-memory for 5 minutes per business (same TTL as the
  Apps Script `CacheService` cache) so switching tabs/businesses repeatedly
  doesn't re-read the whole sheet every time. Restart the server to clear it.
- `service-account.json`, `credentials.json`, and `token.json` are secrets —
  never commit or share them (already covered by `.gitignore`). If a service
  account key is ever pasted somewhere it shouldn't be (chat, a doc, a PR),
  rotate it: Cloud Console → IAM & Admin → Service Accounts → Keys → delete
  the old key, add a new one.
- This server only implements `/api/live-sales` and `/api/sales-debug`
  (mirroring Code.gs). Every other tab is still "Coming Soon" regardless of
  backend, since those simply have no data source wired up yet.
