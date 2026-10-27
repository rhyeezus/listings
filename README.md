# Shortlist

A small rental-hunting app for two people. A Google Sheet holds every listing and both sets of votes; a static web app on Vercel shows them as cards to vote on, an inspection run sheet grouped by day, and a filterable grid.

```
Google Sheet (Listings / Inbox / Search)
        │  Apps Script web app (JSON API, passcode)
        ▼
Vite web app on Vercel  ──►  you and your partner, on any device
```

## 1. Set up the sheet (once, about 10 minutes)

1. In Google Drive, create a new Google Sheet called **Rental Shortlist**.
2. Rename the first tab to `Listings`, then **File → Import → Upload** `sheet/Listings.csv` and choose **Replace current sheet**.
3. Add a tab called `Inbox` and import `sheet/Inbox.csv` into it the same way (it's just the header row).
4. Add a tab called `Search` and import `sheet/Search.csv`.
5. **Extensions → Apps Script.** Replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo. Save.
6. In Apps Script, **Project Settings → Script properties → Add property**: `PASSCODE` = a code you'll share with your partner.
7. **Deploy → New deployment → Web app.** Execute as: **Me**. Who has access: **Anyone**. Deploy, approve the permissions, and copy the web app URL (ends in `/exec`).
8. Reload the sheet. A **Rental** menu appears. Run **Rental → Fill missing map locations** once.

"Anyone" means anyone with the URL can reach the script, but every request still needs the passcode.

## 2. Deploy the app

1. Import this repo into Vercel (framework preset: Vite).
2. Add an environment variable `VITE_API_URL` = the Apps Script `/exec` URL.
3. Deploy. Open the site, enter the passcode, pick who you are. Send the link and passcode to your partner.

Local development: `npm install`, then `VITE_API_URL=<url> npm run dev`.

## Rescans

The sheet is the source of truth. A rescan adds new listings, refreshes price, inspections and photos on existing ones, and never touches votes or notes.

**For now (manual):** ask Claude or Cowork to run the saved search on the `Search` tab and paste the results into the `Inbox` tab using its column headers. Then run **Rental → Merge inbox**:
- *keep missing listings* for a partial scan (one suburb, one page)
- *full scan: mark missing as gone* when the scan covered the whole search

**Later (automatic):** if Domain API access comes through, fill in `fetchScanResults_()` in `Code.gs` so it returns listings in the Listings column format. The app's **Rescan** button and a daily time trigger on `dailyRescan` then work with no other changes.

## Columns

`id` is the listing's stable key (Domain's URL slug). Rescans match on it.
Vote columns take `yes`, `maybe`, `no` or blank. The app derives:
- **Both yes**: both voted yes
- **Talk about it**: at least one vote, no "no"
- **Out**: either voted no
- **Gone**: `status` is `gone`

Inspection times are written like `Wed 28 Oct, 4:45 - 5pm`, separated by `; `.
