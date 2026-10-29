# Shortlist

A small rental-hunting app for two people. A Google Sheet holds every listing and both sets of votes; a static web app on Vercel shows them as cards to vote on, an inspection run sheet grouped by day (today's inspections stay on it all day, and **Past** lists the last 30 days' so you can vote on the places you've seen), a map (pick a day to plan an inspection run: clashes and tight gaps flagged, and an Add to calendar), and a filterable grid. Tap any card for the whole listing (with a map of where it is) and any photo for the full-screen viewer.

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

## Search area

The search is the `Search` tab's suburbs: Elwood, St Kilda, St Kilda East, St Kilda West, Balaclava, Ripponlea, Elsternwick, Gardenvale, Caulfield South, Brighton, Brighton East, Windsor, Prahran, South Yarra, Richmond, Hawthorn and Hawthorn East. The app shows every listing in the sheet.
- Rescans and alert imports skip listings outside these suburbs, and a rescan only marks listings in them as gone, so dropping a suburb doesn't mark its listings gone.
- Keep `DOMAIN_SEARCH` at the top of `scripts/domain-rescan.js`, and the saved searches on Domain and realestate.com.au that send the alert emails, in step with it.

## Rescans

The sheet is the source of truth. A rescan adds new listings and refreshes price, inspections, availability, agency, photos, the ad description and the map position on existing ones. Other details (type, flooring, level, outdoor, photo and so on) are only filled in where blank, and votes and notes are never touched.

**Domain, from a browser (works without an API key):** Domain's website blocks requests from servers, so this scan runs in a real browser tab and the app hands the results to the sheet.
- **On a schedule:** a Claude scheduled task, "Shortlist Domain rescan", runs it at 7am and 6pm in the Claude desktop app on Rhys's Mac. It opens Domain in the app's browser pane, runs `scripts/domain-rescan.js`, and hands the scan to the live site, which is signed in there. The Mac has to be awake with the Claude app open; a run missed while the app is closed happens when it next opens. If you change the times (in the app's scheduled tasks), change `SCAN_TIMES` in `src/main.js` to match.
- **The Rescan button** shows when the last scan reached the sheet ("Scanned 7:04am"), and pressing it says what that scan found. `Code.gs` keeps the last scan in the `LAST_SCAN` script property.
- **By hand:** ask Claude to "rescan Domain", or do it yourself:
  1. Open the app (local or deployed) and sign in, so it has the passcode.
  2. In another tab, open any www.domain.com.au page, paste `scripts/domain-rescan.js` into the console, and run `await domainRescan()` (about 1.5 seconds per listing; progress is in `window.__rescan`). Keep `DOMAIN_SEARCH` at the top of the script in step with the `Search` tab.
  3. Run `domainRescanHandoff('<app url>')`. That tab opens the app, which imports the scan and shows a summary. Chrome won't open a link over 2MB, so a scan that big leaves out the full-size photos (the sheet keeps the ones it has).

The import merges like a full scan:
- new listings are added, with flooring, floor level and outdoor space read from the ad text and features
- Domain listings that no longer show up are marked `gone`; realestate.com.au and other listings never are
- if any listing page failed to load, or the scan returned under 60% of the active Domain listings, nothing is marked gone

**Domain, automatically (through Domain's API):** `Code.gs` can search Domain's official API itself, so no browser is needed. Once it's set up, the app's **Rescan** button and **Rental → Rescan Domain now** work on their own, and **Rental → Turn on automatic rescans** checks Domain every 3 hours. It merges like the browser scan, including the gone check and the 60% rule.
- A listing new to the sheet gets one more call for its full ad text, availability and bond (at most 40 a run, to spare the daily allowance).
- Listings already in the sheet keep their photos and description, so the browser scan's phone-sized photos aren't replaced. Photos from the API are Domain's full-size originals.

This needs paid access: on developer.domain.com.au, **Agents & Listings** (the listing search) is "Contact for Price", and the account needs a business profile first (checked October 2026). It stays switched off until credentials are set. If you ever get access:
1. Sign up at [developer.domain.com.au](https://developer.domain.com.au) (**Get started**: GitHub, Google or email).
2. **Projects → Create Project**. Under **API Access**, check that **Agents & Listings** is on the project, and note its plan and daily allowance. If adding it asks for payment or a sales contact, stop: keep using the browser rescan.
3. **Credentials → Create OAuth Client**, choose **Client Credentials**, then add a client secret.
4. In Apps Script, **Project Settings → Script properties**, add `DOMAIN_CLIENT_ID` and `DOMAIN_CLIENT_SECRET` (an API key in `DOMAIN_API_KEY` works instead).
5. Reload the sheet and run **Rental → Check Domain API access**. It runs the saved search once without changing the sheet, and shows how many listings came back and the plan's allowance. If Domain refuses, the plan doesn't include listing search.
6. Run **Rental → Rescan Domain now**, check the sheet, then **Rental → Turn on automatic rescans**. If a run fails, Google emails you.

**New listings from alert emails (Domain and realestate.com.au):** both sites email you new listings from a saved search, for free. `Code.gs` reads those emails from the Gmail of the account that owns the sheet and adds the listings that aren't already there. It only reads mail; nothing is labelled, moved or deleted.
- **Domain:** the alert's link gives the listing's id, the same one rescans use, so the next browser rescan fills in its photos, inspections and description. Domain listings already in the sheet are left alone, and one that's only here from realestate.com.au is taken over, keeping your votes and notes.
- **realestate.com.au:** matched on address, so a listing that's also on Domain isn't added twice.
- An email with no listings found (a newsletter, or an alert layout the import doesn't understand yet) is tried again for 3 days, then skipped.

To set it up, for each site:
1. Sign in to domain.com.au or realestate.com.au with the **same Google account that owns the sheet** (the alerts have to land in that Gmail).
2. Search **Rent** with the suburbs, bedrooms and maximum rent from the `Search` tab (on Domain, also tick the filter that excludes deposit taken). Save the search with email alerts on, as often as it allows (as soon as listings are added, or daily). On Domain that's **Save search** (the bell) on the results; check **Account → Preferences → Email preferences** has property alerts on.
3. When the first alert has arrived, run **Rental → Preview Domain alerts** (or **Preview realestate.com.au alerts**). Google asks you to allow Gmail access the first time. Check the list looks right; if it says no listings were found, the email layout needs a tweak.
4. Run **Rental → Import alerts now**, then **Rental → Turn on hourly alert import** (one import covers both sites).

Listings from alerts have one photo and no inspection times or description until a rescan finds them. realestate.com.au listings aren't marked gone automatically (the emails don't say when a place is leased); Domain ones are, by the next full Domain rescan that doesn't find them. If Domain lists a realestate.com.au place later, the Domain alert or rescan takes over the row, filling in its details and keeping your votes and notes.

**Manual (any site):** ask Claude or Cowork to run the saved search on the `Search` tab and paste the results into the `Inbox` tab using its column headers. Then run **Rental → Merge inbox**:
- *keep missing listings* for a partial scan (one suburb, one page)
- *full scan: mark missing as gone* when the scan covered the whole search

## Columns

`id` is the listing's stable key (Domain's URL slug). Rescans match on it.
`photos` holds every photo URL from the listing, one per line (card-sized, cropped to 4:3), `photos_large` the same photos uncropped and full size for the photo viewer, and `description` the ad text. `photo_url` is the single thumbnail used in lists. `lat`/`lng` place the listing on the map: a rescan takes them from Domain, and **Rental → Fill missing map locations** geocodes any still blank.
Vote columns take `yes`, `maybe`, `no` or blank. `maybe` is a **Favourite** (the star in the app): a yes and then some, so it counts as a yes everywhere, and starred listings get a ★ badge, come first, and have their own filter. The app derives:
- **Both yes**: both voted yes or favourite
- **Talk about it**: one of you voted yes or favourite, the other hasn't voted
- **Out**: either voted no
- **Gone**: `status` is `gone`

`enquired` is the day either of you ticked **Enquired** on a card (you've asked the agent about the place), and `enquired_by` who ticked it. The tick is shared, so it shows for both of you. The two columns are added to the end of the `Listings` tab the first time someone ticks it, and rescans never change them.

The `Plan` tab holds the day planner's ticks, shared by both of you: one row per inspection (`<listing id>|<inspection>`), whether you're going, and who last changed it.

Inspection times are written like `Wed 28 Oct, 4:45 - 5pm`, separated by `; `. When a rescan replaces a listing's times, the ones that have already happened move to `past_inspections` with their year (`Wed 28 Oct 2026, 4:45 - 5pm`), so the Inspections page's **Past** list can still show them. Rescans never clear it, and times dropped before they happened (cancelled or moved) aren't kept. The column is added to the end of the `Listings` tab the first time a rescan moves a time there.
