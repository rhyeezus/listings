/**
 * Rental Shortlist back end (Google Apps Script, bound to the Google Sheet).
 *
 * Tabs:
 *   Listings  one row per listing (header row 1). Votes and notes live in their own columns
 *             and are never touched by a rescan.
 *   Inbox     paste fresh scan results here (same columns as Listings, votes left blank),
 *             then run  Rental > Merge inbox.
 *   Search    the saved search criteria, used by automatic rescans and by whoever rescans by hand.
 *
 * Script properties (Project Settings > Script properties):
 *   PASSCODE              the shared code you and your partner type into the app once.
 *   DOMAIN_API_KEY        for automatic rescans (developer.domain.com.au, Agents & Listings package), or
 *   DOMAIN_CLIENT_ID +
 *   DOMAIN_CLIENT_SECRET  the OAuth client credentials for the same project instead of a key.
 */

const LISTINGS = 'Listings';
const INBOX = 'Inbox';
const VOTERS = ['rhys', 'partner'];
const VOTES = ['yes', 'maybe', 'no', ''];

const COLUMNS = [
  'id', 'address', 'suburb', 'price', 'bond', 'type', 'beds', 'flooring', 'level', 'outdoor',
  'pets', 'inspections', 'available', 'agency', 'notes', 'photo_url', 'listing_url', 'lat', 'lng',
  'source', 'added_on', 'last_seen', 'status',
  'rhys_vote', 'partner_vote', 'rhys_note', 'partner_note'
];
// Columns a rescan refreshes on an existing row whenever the scan has a value.
const SCAN_FIELDS = ['price', 'inspections', 'available', 'agency', 'listing_url'];
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
  return json_({ ok: true, listings: rows, fetchedAt: new Date().toISOString() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  if (!authorised_(body.key)) return json_({ ok: false, error: 'bad_passcode' });

  if (body.action === 'vote') return json_(writeVote_(body));
  if (body.action === 'rescan') return json_(rescan_());
  if (body.action === 'import') return json_(importScan_(body));
  return json_({ ok: false, error: 'unknown_action' });
}

// A Domain scan collected in a browser (scripts/domain-rescan.js), handed over by the app.
// Only listing columns are accepted; votes, notes and status are never set from a scan.
const IMPORT_FIELDS = COLUMNS.filter(c => !/_vote$|_note$/.test(c) && ['added_on', 'last_seen', 'status'].indexOf(c) < 0);
function importScan_(b) {
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 1000) return { ok: false, error: 'bad_rows', message: 'The scan had no listings, so nothing was changed.' };
  const rows = b.rows.map(r => {
    const o = {};
    IMPORT_FIELDS.forEach(f => { if (r[f] !== undefined && r[f] !== null) o[f] = typeof r[f] === 'number' ? r[f] : String(r[f]).slice(0, 2000); });
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
    const { sheet, header, rows } = readListings_();
    const today = Utilities.formatDate(new Date(), 'Australia/Melbourne', 'yyyy-MM-dd');
    const byId = {}; rows.forEach((r, i) => byId[String(r.id)] = i);
    const seen = {};
    let added = 0, updated = 0, gone = 0;
    const newRows = [];

    incoming.forEach(n => {
      const id = String(n.id || '').trim();
      if (!id) return;
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
