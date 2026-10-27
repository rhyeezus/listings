/**
 * Rental Shortlist back end (Google Apps Script, bound to the Google Sheet).
 *
 * Tabs:
 *   Listings  one row per listing (header row 1). Votes and notes live in their own columns
 *             and are never touched by a rescan.
 *   Inbox     paste fresh scan results here (same columns as Listings, votes left blank),
 *             then run  Rental > Merge inbox.
 *   Search    the saved search criteria, used by automatic rescans and by whoever rescans by hand.
 *   Plan      the app's day planner ticks, shared by both of you (the app makes it on the first tick).
 *
 * Script properties (Project Settings > Script properties):
 *   PASSCODE              the shared code you and your partner type into the app once.
 *   DOMAIN_API_KEY        for automatic rescans (developer.domain.com.au, Agents & Listings package), or
 *   DOMAIN_CLIENT_ID +
 *   DOMAIN_CLIENT_SECRET  the OAuth client credentials for the same project instead of a key.
 *   REA_SEEN              set by the realestate.com.au alert import: the alert emails it has already read.
 *
 * realestate.com.au listings come from its saved-search alert emails in the owner's Gmail (Rental > Preview /
 * Import realestate.com.au alerts); see "realestate.com.au alerts" below.
 */

const LISTINGS = 'Listings';
const INBOX = 'Inbox';
const PLAN = 'Plan'; // the day planner's shared ticks (made on first use)
const VOTERS = ['rhys', 'partner'];
const VOTES = ['yes', 'maybe', 'no', ''];

// Columns missing from the Listings tab (photos, description and photos_large came later) are added to the end of its
// header row by ensureColumns_ before a merge, so the sheet never needs editing by hand.
const COLUMNS = [
  'id', 'address', 'suburb', 'price', 'bond', 'type', 'beds', 'flooring', 'level', 'outdoor',
  'pets', 'inspections', 'available', 'agency', 'notes', 'photo_url', 'listing_url', 'lat', 'lng',
  'source', 'added_on', 'last_seen', 'status',
  'rhys_vote', 'partner_vote', 'rhys_note', 'partner_note',
  'photos', 'description', 'photos_large'
];
// Columns a rescan refreshes on an existing row whenever the scan has a value.
// photos: the listing's photo URLs (card-sized), one per line. photos_large: the same photos uncropped and full
// size, for the app's photo viewer. description: the ad text. lat/lng: Domain's own map position for the listing.
const SCAN_FIELDS = ['price', 'inspections', 'available', 'agency', 'listing_url', 'photos', 'description', 'photos_large', 'lat', 'lng'];
// Columns a rescan only fills when the row's cell is empty, so hand-checked details and the
// small photo thumbnails aren't replaced by rougher scan values.
const FILL_FIELDS = ['bond', 'type', 'beds', 'flooring', 'level', 'outdoor', 'pets', 'notes', 'photo_url'];

/* ---------------- menu ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rental')
    .addItem('Merge inbox (keep missing listings)', 'mergeInboxPartial')
    .addItem('Merge inbox (full scan: mark missing as gone)', 'mergeInboxFull')
    .addSeparator()
    .addItem('Rescan Domain now', 'rescanFromMenu')
    .addItem('Turn on daily rescan (7am)', 'enableDailyRescan')
    .addItem('Turn off daily rescan', 'disableDailyRescan')
    .addSeparator()
    .addItem('Preview realestate.com.au alerts', 'previewReaAlerts')
    .addItem('Import realestate.com.au alerts now', 'reaAlertsFromMenu')
    .addItem('Turn on hourly alert import', 'enableReaAlerts')
    .addItem('Turn off alert import', 'disableReaAlerts')
    .addSeparator()
    .addItem('Fill missing map locations', 'geocodeMissing')
    .addToUi();
}

function rescanFromMenu() {
  const res = rescan_();
  SpreadsheetApp.getUi().alert(res.ok ? `Rescan done: ${res.added} new, ${res.updated} updated, ${res.gone} marked gone.` : res.message);
}
function enableDailyRescan() {
  disableDailyRescan();
  ScriptApp.newTrigger('dailyRescan').timeBased().everyDays(1).atHour(7).inTimezone('Australia/Melbourne').create();
  SpreadsheetApp.getUi().alert('Daily rescan is on: every morning around 7am.');
}
function disableDailyRescan() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyRescan').forEach(t => ScriptApp.deleteTrigger(t));
}

/* ---------------- web API ---------------- */
function doGet(e) {
  if (!authorised_(e.parameter.key)) return json_({ ok: false, error: 'bad_passcode' });
  const rows = readListings_().rows;
  return json_({ ok: true, listings: rows, plan: readPlan_(), fetchedAt: new Date().toISOString() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  if (!authorised_(body.key)) return json_({ ok: false, error: 'bad_passcode' });

  if (body.action === 'vote') return json_(writeVote_(body));
  if (body.action === 'rescan') return json_(rescan_());
  if (body.action === 'import') return json_(importScan_(body));
  if (body.action === 'pick') return json_(writePick_(body));
  return json_({ ok: false, error: 'unknown_action' });
}

// A Domain scan collected in a browser (scripts/domain-rescan.js), handed over by the app.
// Only listing columns are accepted; votes, notes and status are never set from a scan.
const IMPORT_FIELDS = COLUMNS.filter(c => !/_vote$|_note$/.test(c) && ['added_on', 'last_seen', 'status'].indexOf(c) < 0);
// Longest value kept per field (a sheet cell holds up to 50,000 characters).
const MAX_LENGTH = { photos: 20000, description: 10000, photos_large: 20000 };
function importScan_(b) {
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 1000) return { ok: false, error: 'bad_rows', message: 'The scan had no listings, so nothing was changed.' };
  const rows = b.rows.map(r => {
    const o = {};
    IMPORT_FIELDS.forEach(f => { if (r[f] !== undefined && r[f] !== null) o[f] = typeof r[f] === 'number' ? r[f] : String(r[f]).slice(0, MAX_LENGTH[f] || 2000); });
    return o;
  }).filter(r => r.id && String(r.listing_url || '').indexOf('https://www.domain.com.au/') === 0);
  // Only suburbs on the Search tab (Domain pads searches with surrounding suburbs).
  const suburbs = readSearch_().suburbs.map(s => s.toLowerCase());
  const inArea = rows.filter(r => suburbs.indexOf(String(r.suburb || '').toLowerCase()) >= 0);
  // Don't mark anything gone if the scan looks partial (fewer than 60% of the active Domain listings).
  const active = readListings_().rows.filter(r => r.status !== 'gone' && String(r.listing_url).includes('domain.com.au')).length;
  const full = b.full === true && inArea.length >= active * 0.6;
  const res = mergeListings_(inArea, full, 'domain.com.au');
  res.goneChecked = full;
  res.outOfArea = rows.length - inArea.length;
  return res;
}

function authorised_(key) {
  const pass = PropertiesService.getScriptProperties().getProperty('PASSCODE');
  return !!pass && key === pass;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- shared inspection plan ---------------- */
// The day planner's ticks, the same for both of you: a row on the Plan tab for each inspection either of you has
// ticked or unticked. key is "<listing id>|<inspection as written>", e.g. "8-14-macquarie-...|Wed 28 Oct, 9:45am - 10am".
function readPlan_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PLAN);
  if (!sheet) return {};
  const plan = {};
  sheet.getDataRange().getValues().slice(1).forEach(r => { if (r[0]) plan[String(r[0])] = r[1] === true || String(r[1]).toUpperCase() === 'TRUE'; });
  return plan;
}
// b.inspection is the tick's key (b.key is the passcode).
function writePick_(b) {
  if (VOTERS.indexOf(b.who) < 0) return { ok: false, error: 'bad_voter' };
  const key = String(b.inspection || '');
  if (!key || key.length > 300 || typeof b.going !== 'boolean') return { ok: false, error: 'bad_pick' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActive();
    let sheet = ss.getSheetByName(PLAN);
    if (!sheet) { sheet = ss.insertSheet(PLAN); sheet.getRange(1, 1, 1, 4).setValues([['key', 'going', 'by', 'updated']]); }
    const at = sheet.getDataRange().getValues().map(r => String(r[0])).indexOf(key);
    const row = [key, b.going, b.who, new Date().toISOString()];
    if (at > 0) sheet.getRange(at + 1, 1, 1, 4).setValues([row]); else sheet.appendRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- votes ---------------- */
function writeVote_(b) {
  if (VOTERS.indexOf(b.who) < 0) return { ok: false, error: 'bad_voter' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const { sheet, header, rows } = readListings_();
    const i = rows.findIndex(r => String(r.id) === String(b.id));
    if (i < 0) return { ok: false, error: 'not_found' };
    const rowNum = i + 2;
    if (b.vote !== undefined) {
      if (VOTES.indexOf(b.vote) < 0) return { ok: false, error: 'bad_vote' };
      sheet.getRange(rowNum, header.indexOf(b.who + '_vote') + 1).setValue(b.vote);
    }
    if (b.note !== undefined) {
      sheet.getRange(rowNum, header.indexOf(b.who + '_note') + 1).setValue(String(b.note).slice(0, 2000));
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- rescan (Domain API) ---------------- */
const DOMAIN_SEARCH = 'https://api.domain.com.au/v1/listings/residential/_search';
const POSTCODES = { 'Elwood': '3184', 'St Kilda': '3182', 'St Kilda East': '3183', 'St Kilda West': '3182',
  'Balaclava': '3183', 'Ripponlea': '3185', 'Elsternwick': '3185', 'Gardenvale': '3185', 'Brighton': '3186',
  'Brighton East': '3187', 'Prahran': '3181', 'Windsor': '3181', 'Black Rock': '3193' };

// Auth headers for Domain's API, or null when no credentials are set.
function domainHeaders_() {
  const p = PropertiesService.getScriptProperties();
  const key = p.getProperty('DOMAIN_API_KEY');
  if (key) return { 'X-Api-Key': key };
  const id = p.getProperty('DOMAIN_CLIENT_ID'), secret = p.getProperty('DOMAIN_CLIENT_SECRET');
  if (!id || !secret) return null;
  const res = UrlFetchApp.fetch('https://auth.domain.com.au/v1/connect/token', {
    method: 'post', muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) },
    payload: { grant_type: 'client_credentials', scope: 'api_listings_read' }
  });
  if (res.getResponseCode() !== 200) throw new Error('Domain sign-in failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  return { Authorization: 'Bearer ' + JSON.parse(res.getContentText()).access_token };
}

// The saved search on the Search tab (Setting / Value rows).
function readSearch_() {
  const o = {};
  SpreadsheetApp.getActive().getSheetByName('Search').getDataRange().getValues().slice(1)
    .forEach(r => { if (r[0]) o[String(r[0]).trim()] = String(r[1]).trim(); });
  return {
    suburbs: (o['Suburbs'] || '').split(',').map(s => s.trim()).filter(Boolean),
    beds: Number(o['Bedrooms']) || null,
    maxPrice: Number(o['Max rent per week']) || null,
    excludeDepositTaken: /^y/i.test(o['Exclude deposit taken'] || '')
  };
}

// Every current listing matching the saved search, shaped like Listings rows. null = not set up.
function fetchScanResults_() {
  const headers = domainHeaders_();
  if (!headers) return null;
  const s = readSearch_();
  const body = {
    listingType: 'Rent', minBedrooms: s.beds, maxBedrooms: s.beds, maxPrice: s.maxPrice,
    excludeDepositTaken: s.excludeDepositTaken, pageSize: 100,
    locations: s.suburbs.map(sub => ({ state: 'VIC', suburb: sub, postCode: POSTCODES[sub] || '', includeSurroundingSuburbs: false }))
  };
  const out = [];
  for (let page = 1; page <= 10; page++) { // the API stops at 1000 results
    body.pageNumber = page;
    const res = UrlFetchApp.fetch(DOMAIN_SEARCH, { method: 'post', contentType: 'application/json', headers, payload: JSON.stringify(body), muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Domain search failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
    const items = JSON.parse(res.getContentText());
    items.forEach(it => {
      if (it.type === 'PropertyListing' && it.listing) out.push(domainRow_(it.listing));
      else if (it.type === 'Project') (it.listings || []).forEach(l => out.push(domainRow_(l)));
    });
    if (items.length < body.pageSize) break;
  }
  return out;
}

const PROPERTY_TYPES = { ApartmentUnitFlat: 'Apartment/unit', House: 'House (per Domain)', Townhouse: 'Townhouse', SemiDetached: 'Semi-detached', Studio: 'Studio', Villa: 'Villa' };
const titleCase_ = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

// One Domain API listing as a Listings row. Flooring, level and outdoor space are read from the ad text.
function domainRow_(l) {
  const d = l.propertyDetails || {};
  const text = [l.headline, l.summaryDescription, (d.features || []).join(' ')].join(' ').toLowerCase();
  const price = (String((l.priceDetails || {}).displayPrice || '').replace(/,/g, '').match(/\$\s*(\d{3,4})/) || [])[1];
  const street = [d.streetNumber, d.street].filter(Boolean).join(' ')
    .replace(/\bStreet$/, 'St').replace(/\bRoad$/, 'Rd').replace(/\bAvenue$/, 'Ave').replace(/\bParade$/, 'Pde');
  const floors = [/floorboard|timber floor|hardwood|polished (timber|board|floor)/.test(text) && 'boards', /carpet/.test(text) && 'carpet', /\btiled?\b|tiles/.test(text) && 'tiles'].filter(Boolean);
  const outdoor = [/courtyard/.test(text) && (/(shared|communal) courtyard/.test(text) ? 'Shared courtyard' : 'Courtyard'),
    /garden/.test(text) && (/communal garden/.test(text) ? 'Communal garden' : 'Garden'), /balcon/.test(text) && 'Balcony'].filter(Boolean);
  const slug = l.listingSlug || String(l.id);
  return {
    id: slug,
    address: street ? (d.unitNumber ? d.unitNumber + '/' : '') + street : String(d.displayableAddress || '').split(',')[0],
    suburb: titleCase_(d.suburb),
    price: price ? Number(price) : '',
    type: PROPERTY_TYPES[d.propertyType] || d.propertyType || '',
    beds: d.bedrooms || '',
    flooring: floors.join(', '),
    level: /ground floor|ground level|ground-floor/.test(text) ? 'Ground' : /(first|second|third|top|upper) floor|upstairs|level [1-9]/.test(text) ? 'Upper' : '',
    outdoor: outdoor.join(', '),
    pets: (d.features || []).some(f => /pet/i.test(f)) ? 'Yes' : '',
    inspections: ((l.inspectionSchedule || {}).times || []).map(t => inspection_(t.openingTime, t.closingTime)).join('; '),
    agency: (l.advertiser || {}).name || '',
    photo_url: ((l.media || []).find(m => m.category === 'Image') || {}).url || '',
    listing_url: 'https://www.domain.com.au/' + slug,
    lat: d.latitude || '', lng: d.longitude || '',
    source: 'Domain'
  };
}

// "2026-10-30T16:00:00", "2026-10-30T16:10:00" -> "Fri 30 Oct, 4pm - 4:10pm" (times are local; any offset is ignored).
function inspection_(from, to) {
  const t = s => { const m = String(s).match(/T(\d{2}):(\d{2})/); const h = +m[1]; return (h % 12 || 12) + (m[2] === '00' ? '' : ':' + m[2]) + (h >= 12 ? 'pm' : 'am'); };
  const [y, mo, d] = String(from).slice(0, 10).split('-').map(Number);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1];
  return `${wd} ${d} ${mon}, ${t(from)} - ${t(to)}`;
}

function rescan_() {
  let results;
  try { results = fetchScanResults_(); } catch (err) { return { ok: false, error: 'scan_failed', message: String(err.message || err) }; }
  if (!results) return { ok: false, error: 'not_configured', message: 'Rescans run from a browser: ask Claude to rescan Domain. (Domain’s API needs a paid key, so the button can’t do it on its own.)' };
  if (!results.length) return { ok: false, error: 'empty_scan', message: 'Domain returned no listings, so nothing was changed. Check the Search tab.' };
  return mergeListings_(results, true, 'domain.com.au');
}

// Daily trigger target (Rental > Turn on daily rescan).
function dailyRescan() { rescan_(); }

function mergeInboxPartial() { mergeInbox_(false); }
function mergeInboxFull() { mergeInbox_(true); }

function mergeInbox_(full) {
  const ss = SpreadsheetApp.getActive();
  const inbox = ss.getSheetByName(INBOX);
  const values = inbox.getDataRange().getValues();
  if (values.length < 2) { SpreadsheetApp.getUi().alert('The Inbox tab is empty.'); return; }
  const head = values[0].map(String);
  const incoming = values.slice(1).filter(r => r.join('') !== '').map(r => {
    const o = {}; head.forEach((h, j) => o[h] = r[j]); return o;
  });
  const res = mergeListings_(incoming, full);
  inbox.getRange(2, 1, Math.max(inbox.getLastRow() - 1, 1), inbox.getLastColumn()).clearContent();
  SpreadsheetApp.getUi().alert(`Merged: ${res.added} new, ${res.updated} updated, ${res.gone} marked gone.`);
}

// full: mark active rows the scan didn't return as gone. goneScope: only rows whose listing_url contains
// it can be marked gone (an automatic Domain scan can't speak for realestate.com.au listings).
function mergeListings_(incoming, full, goneScope) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureColumns_();
    const { sheet, header, rows } = readListings_();
    const today = Utilities.formatDate(new Date(), 'Australia/Melbourne', 'yyyy-MM-dd');
    const byId = {}; rows.forEach((r, i) => byId[String(r.id)] = i);
    const byAddress = {}; rows.forEach((r, i) => { const k = addressKey_(r.address, r.suburb); if (!(k in byAddress)) byAddress[k] = i; });
    const seen = {};
    let added = 0, updated = 0, gone = 0;
    const newRows = [];

    incoming.forEach(n => {
      const id = String(n.id || '').trim();
      if (!id) return;
      // A Domain listing already in the sheet from somewhere else (a realestate.com.au alert, or added by hand):
      // it takes that row over, keeping its votes and notes, so later rescans keep it up to date.
      const at = byAddress[addressKey_(n.address, n.suburb)];
      if (!(id in byId) && at !== undefined && isDomain_(n.listing_url) && !isDomain_(rows[at].listing_url) && !seen[String(rows[at].id)]) {
        ['id', 'listing_url', 'source'].forEach(f => {
          sheet.getRange(at + 2, header.indexOf(f) + 1).setValue(n[f]);
          rows[at][f] = n[f];
        });
        byId[id] = at;
      }
      seen[id] = true;
      if (id in byId) {
        const i = byId[id], rowNum = i + 2;
        SCAN_FIELDS.forEach(f => {
          if (n[f] !== undefined && n[f] !== '' && String(n[f]) !== String(rows[i][f])) {
            sheet.getRange(rowNum, header.indexOf(f) + 1).setValue(n[f]);
          }
        });
        FILL_FIELDS.forEach(f => {
          if (n[f] !== undefined && n[f] !== '' && String(rows[i][f]).trim() === '') {
            sheet.getRange(rowNum, header.indexOf(f) + 1).setValue(n[f]);
          }
        });
        sheet.getRange(rowNum, header.indexOf('last_seen') + 1).setValue(today);
        if (rows[i].status === 'gone') sheet.getRange(rowNum, header.indexOf('status') + 1).setValue('active');
        updated++;
      } else {
        const o = {};
        COLUMNS.forEach(c => o[c] = n[c] !== undefined ? n[c] : '');
        o.added_on = today; o.last_seen = today; o.status = 'active';
        VOTERS.forEach(v => { o[v + '_vote'] = ''; o[v + '_note'] = ''; });
        newRows.push(header.map(h => o[h] !== undefined ? o[h] : ''));
        added++;
      }
    });

    if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, header.length).setValues(newRows);

    if (full) {
      rows.forEach((r, i) => {
        if (r.status !== 'gone' && !seen[String(r.id)] && (!goneScope || String(r.listing_url).includes(goneScope))) {
          sheet.getRange(i + 2, header.indexOf('status') + 1).setValue('gone');
          gone++;
        }
      });
    }
    geocodeMissing();
    return { ok: true, added, updated, gone };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- realestate.com.au alerts (Gmail) ---------------- */
// realestate.com.au has no API, but its saved-search alert emails carry each new listing's link, price, address
// and photo. These read them from the Gmail of the account the script runs as (the sheet's owner), add listings
// that aren't in the sheet yet (matched on address, so one already there from Domain isn't added twice), and
// note which emails they've read in the REA_SEEN script property. They only read mail: nothing is labelled,
// moved or deleted. An email with no listings found isn't marked read, so it's tried again after a fix.
const REA_QUERY = 'from:realestate.com.au newer_than:21d';
// https://www.realestate.com.au/property-apartment-vic-st+kilda-146000001 -> type, state, suburb, listing number
const REA_LISTING = /realestate\.com\.au\/property-([a-z]+)-([a-z]{2,3})-([a-z0-9+%.'-]+?)-(\d{6,})/i;
const REA_TYPES = { apartment: 'Apartment/unit', unit: 'Apartment/unit', flat: 'Apartment/unit', studio: 'Studio', house: 'House', townhouse: 'Townhouse', villa: 'Villa', semi: 'Semi-detached', duplex: 'Duplex' };

function previewReaAlerts() { SpreadsheetApp.getUi().alert(importReaAlerts_(true).message); }
function reaAlertsFromMenu() { SpreadsheetApp.getUi().alert(importReaAlerts_(false).message); }
function reaAlertsHourly() { importReaAlerts_(false); }
function enableReaAlerts() {
  disableReaAlerts();
  ScriptApp.newTrigger('reaAlertsHourly').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('realestate.com.au alerts will now be imported every hour.');
}
function disableReaAlerts() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'reaAlertsHourly').forEach(t => ScriptApp.deleteTrigger(t));
}

// dryRun: report what would be added without touching the sheet or the read list.
function importReaAlerts_(dryRun) {
  const props = PropertiesService.getScriptProperties();
  const seen = JSON.parse(props.getProperty('REA_SEEN') || '[]');
  const messages = [];
  GmailApp.search(REA_QUERY, 0, 50).forEach(t => t.getMessages().forEach(m => {
    if (seen.indexOf(m.getId()) < 0 && /realestate\.com\.au/i.test(m.getFrom())) messages.push(m);
  }));
  const found = {}, read = [];
  let empty = 0;
  messages.forEach(m => {
    const listings = parseReaAlert_(m.getBody());
    listings.forEach(r => { found[r.id] = r; });
    if (listings.length) read.push(m.getId()); else empty++;
  });

  const suburbs = readSearch_().suburbs.map(s => s.toLowerCase());
  const known = {};
  readListings_().rows.forEach(r => { known[addressKey_(r.address, r.suburb)] = String(r.id); });
  const rows = [];
  let already = 0, outOfArea = 0;
  Object.keys(found).forEach(id => {
    const r = found[id], at = known[addressKey_(r.address, r.suburb)];
    if (suburbs.indexOf(String(r.suburb).toLowerCase()) < 0) { outOfArea++; return; }
    if (at && at !== r.id) { already++; return; } // in the sheet already, from Domain or added by hand
    rows.push(r);
  });

  const lines = [`${messages.length} new realestate.com.au email${messages.length === 1 ? '' : 's'}, ${Object.keys(found).length} listing${Object.keys(found).length === 1 ? '' : 's'} in them.`,
    `${already} already in the sheet, ${outOfArea} outside your Search suburbs${empty ? `, ${empty} email${empty === 1 ? '' : 's'} with no listings found` : ''}.`];
  if (dryRun) {
    lines.push(rows.length ? `Would add or update ${rows.length}:` : 'Nothing to add.');
    rows.slice(0, 15).forEach(r => lines.push(`• ${r.address || '(no address found)'}, ${r.suburb}: ${r.price ? '$' + r.price + '/wk' : 'no price found'}`));
    return { ok: true, message: lines.join('\n') };
  }
  const res = rows.length ? mergeListings_(rows, false) : { added: 0, updated: 0 };
  props.setProperty('REA_SEEN', JSON.stringify(seen.concat(read).slice(-300)));
  lines.push(`Added ${res.added}, updated ${res.updated}.`);
  return { ok: true, added: res.added, updated: res.updated, message: lines.join('\n') };
}

// One alert email's listings. Each listing's card is the stretch of the email from its first link to the next
// listing's: the photo, price and address are read from there. Links that go through an email click-tracker are
// followed (without loading the page) to see which listing they lead to; account links (unsubscribe, manage
// alerts and so on) are never followed.
function parseReaAlert_(html) {
  html = String(html || '');
  const links = [], re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) links.push({ at: m.index, url: m[1].replace(/&amp;/g, '&'), inner: m[2] });
  const resolved = {}, order = [], first = {};
  let lookups = 0;
  links.forEach(l => {
    let hit = l.url.match(REA_LISTING) || decodeSafe_(l.url).match(REA_LISTING);
    if (!hit && lookups < 40 && /^https?:/i.test(l.url) && !/www\.realestate\.com\.au/i.test(l.url)
        && !/unsubscribe|preference|manage|settings|privacy|terms|help|contact|feedback|edit|delete|pause|stop|app store|google play|facebook|instagram|twitter|youtube|linkedin/i.test(l.inner + ' ' + l.url)) {
      if (!(l.url in resolved)) { lookups++; resolved[l.url] = followRedirects_(l.url); }
      hit = resolved[l.url].match(REA_LISTING);
    }
    if (!hit) return;
    const id = hit[4];
    if (!(id in first)) { first[id] = l.at; order.push({ id, hit }); }
  });
  return order.map((o, k) => {
    const card = html.slice(first[o.id], k + 1 < order.length ? first[order[k + 1].id] : html.length);
    const before = html.slice(k ? first[order[k - 1].id] : 0, first[o.id]); // in case a card puts its price above its first link
    const [, kind, state, slug] = o.hit, suburb = titleCase_(decodeSafe_(slug.replace(/\+/g, ' ')).replace(/-/g, ' '));
    const text = textLines_(card), price = priceIn_(text) || priceIn_(textLines_(before).slice(-3));
    const beds = (text.join(' ').match(/(\d)\s*(?:bed|bedroom)s?\b/i) || [])[1];
    const photo = (card.match(/<img\b[^>]*?src\s*=\s*["'](https:\/\/[^"']*reastatic[^"']+)["']/i) || [])[1] || '';
    return {
      id: 'rea-' + o.id,
      address: addressIn_(text, suburb),
      suburb,
      price: price || '',
      type: REA_TYPES[kind.toLowerCase()] || titleCase_(kind),
      beds: beds ? Number(beds) : '',
      photo_url: photo.replace(/&amp;/g, '&'),
      photos: photo.replace(/&amp;/g, '&'),
      listing_url: `https://www.realestate.com.au/property-${kind}-${state}-${slug}-${o.id}`.toLowerCase(),
      source: 'realestate.com.au',
    };
  });
}

// Where a click-tracking link ends up, following up to four redirects without loading the final page.
function followRedirects_(url) {
  for (let hop = 0; hop < 4; hop++) {
    if (REA_LISTING.test(url)) return url;
    try {
      const res = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
      const h = res.getAllHeaders(), next = h.Location || h.location;
      if (res.getResponseCode() < 300 || res.getResponseCode() >= 400 || !next) return '';
      url = Array.isArray(next) ? next[0] : String(next);
    } catch (err) { return ''; }
  }
  return REA_LISTING.test(url) ? url : '';
}
function decodeSafe_(s) { try { return decodeURIComponent(s); } catch (err) { return s; } }
// An email's HTML as lines of text.
function textLines_(html) {
  return String(html).replace(/<(br|\/p|\/div|\/td|\/tr|\/h\d|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#36;|&dollar;/gi, '$').replace(/&#0?39;|&rsquo;|&apos;/gi, "'").replace(/&#x2F;|&#47;/gi, '/')
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
// The weekly rent: the first dollar amount that looks like one ($650, $650 per week, $650pw).
function priceIn_(lines) {
  for (const line of lines) {
    const m = line.replace(/,/g, '').match(/\$\s?(\d{3,4})(?!\d)/);
    if (m && +m[1] >= 150 && +m[1] <= 5000) return Number(m[1]);
  }
  return null;
}
// The street address: the line that ends ", <suburb>" (maybe with state and postcode), or one that starts with a number.
function addressIn_(lines, suburb) {
  const sub = suburb.toLowerCase();
  for (const line of lines) {
    const i = line.toLowerCase().lastIndexOf(', ' + sub);
    if (i > 2 && /^[,\s]*(vic\b.*)?$/i.test(line.slice(i + 2 + sub.length))) return shortStreet_(line.slice(0, i).trim());
  }
  const numbered = lines.find(l => /^\d+[a-z]?(\/\d+[a-z]?)?(-\d+)?\s+\S+/i.test(l) && l.length < 60 && !/\$/.test(l));
  return numbered ? shortStreet_(numbered.split(',')[0]) : '';
}
const shortStreet_ = s => String(s).replace(/\bStreet\b/i, 'St').replace(/\bRoad\b/i, 'Rd').replace(/\bAvenue\b/i, 'Ave').replace(/\bParade\b/i, 'Pde');

// An address as a matching key, so "Unit 2, 81 Grosvenor Street" and "2/81 Grosvenor St" (same suburb) match.
const STREET_TYPES = { street: 'st', road: 'rd', avenue: 'ave', parade: 'pde', crescent: 'cres', court: 'ct', place: 'pl', grove: 'gr',
  drive: 'dr', terrace: 'tce', highway: 'hwy', boulevard: 'bvd', lane: 'ln', close: 'cl', esplanade: 'esp', square: 'sq', circuit: 'cct' };
function addressKey_(address, suburb) {
  const a = String(address || '').toLowerCase()
    .replace(/\b(unit|apartment|apt|flat|level|lot)\b\.?\s*/g, '')
    .replace(/^(\d+[a-z]?)\s*,\s*(?=\d)/, '$1/')
    .replace(/[^a-z0-9/\- ]/g, ' ')
    .split(/\s+/).filter(Boolean).map(w => STREET_TYPES[w] || w).join(' ');
  return a + '|' + String(suburb || '').toLowerCase().trim();
}
const isDomain_ = url => /domain\.com\.au/.test(String(url || ''));

/* ---------------- geocoding ---------------- */
function geocodeMissing() {
  const { sheet, header, rows } = readListings_();
  const latC = header.indexOf('lat') + 1, lngC = header.indexOf('lng') + 1;
  const geocoder = Maps.newGeocoder().setRegion('au');
  let done = 0;
  rows.forEach((r, i) => {
    if (r.lat !== '' && r.lng !== '') return;
    if (done >= 60) return; // stay well inside the daily quota; run again for the rest
    try {
      const res = geocoder.geocode(`${r.address}, ${r.suburb} VIC, Australia`);
      const loc = res.results && res.results[0] && res.results[0].geometry.location;
      if (loc) {
        sheet.getRange(i + 2, latC).setValue(loc.lat);
        sheet.getRange(i + 2, lngC).setValue(loc.lng);
      }
      done++;
      Utilities.sleep(150);
    } catch (err) { /* leave blank, retry next run */ }
  });
}

/* ---------------- helpers ---------------- */
// Adds any of COLUMNS the Listings header row is missing, at the end.
function ensureColumns_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(LISTINGS);
  const width = sheet.getLastColumn();
  const header = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  const missing = COLUMNS.filter(c => header.indexOf(c) < 0);
  if (!missing.length) return;
  const need = width + missing.length - sheet.getMaxColumns();
  if (need > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), need);
  sheet.getRange(1, width + 1, 1, missing.length).setValues([missing]);
}

function readListings_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(LISTINGS);
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(String);
  const rows = values.slice(1).filter(r => r[0] !== '').map(r => {
    const o = {}; header.forEach((h, j) => o[h] = r[j] instanceof Date
      ? Utilities.formatDate(r[j], 'Australia/Melbourne', 'yyyy-MM-dd') : r[j]);
    return o;
  });
  return { sheet, header, rows };
}
