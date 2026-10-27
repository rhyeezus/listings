# Shortlist

A small rental-hunting app for two people. A Google Sheet holds every listing and both sets of votes; a static web app on Vercel shows them as cards to vote on, an inspection run sheet grouped by day, a map, and a filterable grid. Tap any card for the whole listing and any photo for the full-screen viewer.

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

**Updating the back end:** after `apps-script/Code.gs` changes, paste it over `Code.gs` in Apps Script, save, then **Deploy → Manage deployments**, edit the existing deployment, set **Version: New version** and deploy. That keeps the same `/exec` URL, so the app needs no change. New columns are added to the end of the `Listings` tab on the next rescan or merge.

## 2. Deploy the app

1. Import this repo into Vercel (framework preset: Vite).
2. Add an environment variable `VITE_API_URL` = the Apps Script `/exec` URL.
3. Deploy. Open the site, enter the passcode, pick who you are. Send the link and passcode to your partner.

Local development: `npm install`, then `VITE_API_URL=<url> npm run dev`.

## Rescans

The sheet is the source of truth. A rescan adds new listings and refreshes price, inspections, availability, agency, photos, the ad description and the map position on existing ones. Other details (type, flooring, level, outdoor, photo and so on) are only filled in where blank, and votes and notes are never touched.

**Domain, from a browser (the normal way):** Domain blocks requests from servers, so the scan runs in a real browser tab and the app hands the results to the sheet. Ask Claude to "rescan Domain", or do it yourself:
1. Open the app (local or deployed) and sign in, so it has the passcode.
2. In another tab, open any www.domain.com.au page, paste `scripts/domain-rescan.js` into the console, and run `await domainRescan()` (about 1.5 seconds per listing; progress is in `window.__rescan`). Keep `DOMAIN_SEARCH` at the top of the script in step with the `Search` tab.
3. Run `domainRescanHandoff('<app url>')`. That tab opens the app, which imports the scan and shows a summary.

The import merges like a full scan:
- new listings are added, with flooring, floor level and outdoor space read from the ad text and features
- Domain listings that no longer show up are marked `gone`; realestate.com.au and other listings never are
- if any listing page failed to load, or the scan returned under 60% of the active Domain listings, nothing is marked gone

**Domain API (needs a paid key):** `Code.gs` can also search through Domain's official API, which would make the app's **Rescan** button, **Rental → Rescan Domain now** and **Rental → Turn on daily rescan** work on their own. Domain's Agents & Listings package is "contact for price" with a business profile, so this is dormant: it only runs if `DOMAIN_API_KEY` (or `DOMAIN_CLIENT_ID` + `DOMAIN_CLIENT_SECRET`) is set in Script properties.

**Manual (any site):** ask Claude or Cowork to run the saved search on the `Search` tab and paste the results into the `Inbox` tab using its column headers. Then run **Rental → Merge inbox**:
- *keep missing listings* for a partial scan (one suburb, one page)
- *full scan: mark missing as gone* when the scan covered the whole search

## Columns

`id` is the listing's stable key (Domain's URL slug). Rescans match on it.
`photos` holds every photo URL from the listing, one per line (card-sized, cropped to 4:3), `photos_large` the same photos uncropped and full size for the photo viewer, and `description` the ad text. `photo_url` is the single thumbnail used in lists. `lat`/`lng` place the listing on the map: a rescan takes them from Domain, and **Rental → Fill missing map locations** geocodes any still blank.
Vote columns take `yes`, `maybe`, `no` or blank. The app derives:
- **Both yes**: both voted yes
- **Talk about it**: at least one vote, no "no"
- **Out**: either voted no
- **Gone**: `status` is `gone`

Inspection times are written like `Wed 28 Oct, 4:45 - 5pm`, separated by `; `.
