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
 *   DOMAIN_CLIENT_ID +
 *   DOMAIN_CLIENT_SECRET  for automatic rescans: the OAuth client (Client Credentials) of a project on
 *                         developer.domain.com.au with the Agents & Listings API, or
 *   DOMAIN_API_KEY        an API key for the same project instead.
 *   REA_SEEN, DOMAIN_SEEN set by the alert email import: the realestate.com.au and Domain alerts it has read.
 *
 * New listings also come from realestate.com.au's and Domain's saved-search alert emails in the owner's Gmail
 * (Rental > Preview ... alerts / Import alerts now); see "alert emails" below.
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
    .addItem('Check Domain API access', 'checkDomainApi')
    .addItem('Rescan Domain now', 'rescanFromMenu')
    .addItem('Turn on automatic rescans (every 3 hours)', 'enableAutoRescan')
    .addItem('Turn off automatic rescans', 'disableAutoRescan')
    .addSeparator()
    .addItem('Preview Domain alerts', 'previewDomainAlerts')
    .addItem('Preview realestate.com.au alerts', 'previewReaAlerts')
    .addItem('Import alerts now', 'alertsFromMenu')
    .addItem('Turn on hourly alert import', 'enableAlerts')
    .addItem('Turn off alert import', 'disableAlerts')
    .addSeparator()
    .addItem('Fill missing map locations', 'geocodeMissing')
    .addToUi();
}

function checkDomainApi() { SpreadsheetApp.getUi().alert(checkDomainApi_()); }
function rescanFromMenu() {
  const res = rescan_();
  SpreadsheetApp.getUi().alert(res.ok ? `Rescan done: ${res.added} new, ${res.updated} updated, ${res.gone} marked gone` +
    (res.goneChecked ? '.' : ' (gone check skipped: the scan looked partial).') : res.message);
}
function enableAutoRescan() {
  if (!domainConfigured_()) { SpreadsheetApp.getUi().alert(NOT_CONFIGURED); return; }
  disableAutoRescan();
  ScriptApp.newTrigger('autoRescan').timeBased().everyHours(3).create();
  SpreadsheetApp.getUi().alert('Automatic rescans are on: Domain is checked every 3 hours. If one fails, Google emails you.');
}
function disableAutoRescan() {
  ScriptApp.getProjectTriggers().filter(t => ['autoRescan', 'dailyRescan'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
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
  return mergeDomainScan_(rows, b.full === true);
}

// A Domain scan (from a browser or the API) into the sheet. Only suburbs on the Search tab are kept (Domain pads
// searches with surrounding suburbs), and nothing is marked gone if the scan looks partial (fewer than 60% of the
// active Domain listings).
function mergeDomainScan_(rows, full) {
  const suburbs = readSearch_().suburbs.map(s => s.toLowerCase());
  const inArea = rows.filter(r => suburbs.indexOf(String(r.suburb || '').toLowerCase()) >= 0);
  const active = readListings_().rows.filter(r => r.status !== 'gone' && String(r.listing_url).includes('domain.com.au')).length;
  const goneChecked = full && inArea.length >= active * 0.6;
  const res = mergeListings_(inArea, goneChecked, 'domain.com.au');
  res.goneChecked = goneChecked;
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
// Rescans that run from here, through Domain's official API: Rental > Rescan Domain now, the automatic rescans and
// the app's Rescan button. They only run once Domain credentials are in Script properties.
const DOMAIN_SEARCH = 'https://api.domain.com.au/v1/listings/residential/_search';
const DOMAIN_LISTING = 'https://api.domain.com.au/v1/listings/';
// A listing new to the sheet gets one more call for its full ad text, availability and bond: at most this many a
// run, to spare the plan's daily allowance (the rest are picked up by the next run).
const DETAIL_LIMIT = 40;
const NOT_CONFIGURED = 'Automatic rescans aren’t set up yet: add DOMAIN_CLIENT_ID and DOMAIN_CLIENT_SECRET (from developer.domain.com.au) in Project Settings > Script properties, then run Rental > Check Domain API access. Until then, ask Claude to rescan Domain from a browser.';
const POSTCODES = { 'Elwood': '3184', 'St Kilda': '3182', 'St Kilda East': '3183', 'St Kilda West': '3182',
  'Balaclava': '3183', 'Ripponlea': '3185', 'Elsternwick': '3185', 'Gardenvale': '3185', 'Brighton': '3186',
  'Brighton East': '3187', 'Prahran': '3181', 'Windsor': '3181', 'Black Rock': '3193' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function domainConfigured_() {
  const p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('DOMAIN_API_KEY') || (p.getProperty('DOMAIN_CLIENT_ID') && p.getProperty('DOMAIN_CLIENT_SECRET')));
}

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

// A GET (no body) or POST (body) to Domain's API. Anything but a 200 throws, with Domain's own message.
function domainFetch_(url, headers, body) {
  const opts = { headers, muteHttpExceptions: true };
  if (body) Object.assign(opts, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body) });
  const res = UrlFetchApp.fetch(url, opts);
  if (res.getResponseCode() !== 200) throw new Error('Domain API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return res;
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

// The saved search as the API's request body, one page of 100 listings.
function searchBody_(page) {
  const s = readSearch_();
  return {
    listingType: 'Rent', minBedrooms: s.beds, maxBedrooms: s.beds, maxPrice: s.maxPrice,
    excludeDepositTaken: s.excludeDepositTaken, pageSize: 100, pageNumber: page,
    locations: s.suburbs.map(sub => ({ state: 'VIC', suburb: sub, postCode: POSTCODES[sub] || '', includeSurroundingSuburbs: false }))
  };
}

// Rental > Check Domain API access: signs in and runs the saved search once, without changing the sheet.
function checkDomainApi_() {
  if (!domainConfigured_()) return NOT_CONFIGURED;
  let res;
  try { res = domainFetch_(DOMAIN_SEARCH, domainHeaders_(), searchBody_(1)); }
  catch (err) { return 'Domain didn’t allow the search. ' + (err.message || err) + '\n\nIf that mentions the plan, scope or access, the project’s plan doesn’t include listing search.'; }
  const n = JSON.parse(res.getContentText()).length, h = res.getAllHeaders();
  const quota = Object.keys(h).filter(k => /quota|ratelimit|total-count/i.test(k)).map(k => `${k}: ${h[k]}`);
  return `Domain’s API works: the saved search found ${n === 100 ? '100 or more' : n} listings.` + (quota.length ? '\n\n' + quota.join('\n') : '');
}

// Every current listing matching the saved search, shaped like Listings rows. null = not set up.
// A listing already in the sheet with a description keeps its photos (a browser scan's are sized for phones); one new
// to the sheet, or still without a description, gets its details call.
function fetchScanResults_() {
  const headers = domainHeaders_();
  if (!headers) return null;
  const out = [];
  for (let page = 1; page <= 10; page++) { // the API stops at 1000 results
    const items = JSON.parse(domainFetch_(DOMAIN_SEARCH, headers, searchBody_(page)).getContentText());
    items.forEach(it => {
      if (it.type === 'PropertyListing' && it.listing) out.push(domainRow_(it.listing));
      else if (it.type === 'Project') (it.listings || []).forEach(l => out.push(domainRow_(l)));
    });
    if (items.length < 100) break;
  }
  // Rows already in the sheet, by id and, for Domain rows, by the listing number that ends the id (in case the API's
  // slug ever differs from the website's).
  const byId = {}, byNumber = {};
  readListings_().rows.forEach(r => {
    byId[String(r.id)] = r;
    const m = String(r.id).match(/-(\d{6,})$/);
    if (m && isDomain_(r.listing_url)) byNumber[m[1]] = r;
  });
  const suburbs = readSearch_().suburbs.map(s => s.toLowerCase());
  let details = 0;
  out.forEach(row => {
    const known = byId[row.id] || byNumber[row.domainId];
    if (known && isDomain_(known.listing_url)) { row.id = String(known.id); row.listing_url = known.listing_url; }
    if (known && String(known.description || '').trim()) { delete row.photos; delete row.photos_large; return; }
    // Outside the Search tab's suburbs: dropped by the merge, so not worth a call.
    if (details >= DETAIL_LIMIT || suburbs.indexOf(row.suburb.toLowerCase()) < 0) return;
    details++;
    try { Object.assign(row, domainDetails_(JSON.parse(domainFetch_(DOMAIN_LISTING + row.domainId, headers).getContentText()))); }
    catch (err) { /* keep what the search gave; the next run tries again */ }
  });
  return out;
}

const PROPERTY_TYPES = { ApartmentUnitFlat: 'Apartment/unit', House: 'House (per Domain)', Townhouse: 'Townhouse', SemiDetached: 'Semi-detached', Studio: 'Studio', Villa: 'Villa' };
const titleCase_ = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
// A listing's photo URLs, one per line. Domain's API links to the full-size originals (bucket-api.domain.com.au,
// redirecting to b.domainstatic.com.au), so the same list serves the cards and the photo viewer.
const domainPhotos_ = media => (media || []).filter(m => m.url && /image|photo/i.test(m.category || m.type || '') && !/floor/i.test(m.type || ''))
  .map(m => m.url).join('\n');

// One Domain API listing as a Listings row. Flooring, level and outdoor space are read from the ad text.
// domainId (Domain's listing number) isn't a column: it's for the details call.
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
  const photos = domainPhotos_(l.media);
  return {
    id: slug,
    domainId: String(l.id || ''),
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
    available: available_(l.dateAvailable),
    agency: (l.advertiser || {}).name || '',
    photo_url: photos.split('\n')[0],
    photos, photos_large: photos,
    listing_url: 'https://www.domain.com.au/' + slug,
    lat: d.latitude || '', lng: d.longitude || '',
    source: 'Domain'
  };
}

// The extra fields from a listing's details call (GET /v1/listings/{id}): the full ad text, every photo,
// availability and bond.
function domainDetails_(d) {
  const o = {};
  const text = String(d.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  if (text) o.description = text.slice(0, MAX_LENGTH.description);
  const photos = domainPhotos_(d.media);
  if (photos) { o.photos = photos; o.photos_large = photos; }
  if (d.dateAvailable) o.available = available_(d.dateAvailable);
  if (Number(d.bond) > 0) o.bond = Number(d.bond);
  return o;
}

// "2026-10-30T16:00:00", "2026-10-30T16:10:00" -> "Fri 30 Oct, 4pm - 4:10pm" (times are local; any offset is ignored).
function inspection_(from, to) {
  const t = s => { const m = String(s).match(/T(\d{2}):(\d{2})/); const h = +m[1]; return (h % 12 || 12) + (m[2] === '00' ? '' : ':' + m[2]) + (h >= 12 ? 'pm' : 'am'); };
  const [y, mo, d] = String(from).slice(0, 10).split('-').map(Number);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[mo - 1]}, ${t(from)} - ${t(to)}`;
}

// "2026-11-03T00:00:00" -> "03 Nov 2026", or "Now" once that day has come (the browser scan's format).
function available_(iso) {
  const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  if (m[0] <= Utilities.formatDate(new Date(), 'Australia/Melbourne', 'yyyy-MM-dd')) return 'Now';
  return `${m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

function rescan_() {
  let results;
  try { results = fetchScanResults_(); } catch (err) { return { ok: false, error: 'scan_failed', message: 'The rescan failed: ' + String(err.message || err) }; }
  if (!results) return { ok: false, error: 'not_configured', message: NOT_CONFIGURED };
  if (!results.length) return { ok: false, error: 'empty_scan', message: 'Domain returned no listings, so nothing was changed. Check the Search tab.' };
  return mergeDomainScan_(results, true);
}

// Trigger target (Rental > Turn on automatic rescans). A failed run throws, so Google emails the script's owner.
function autoRescan() {
  const res = rescan_();
  if (!res.ok) throw new Error(res.message);
}
function dailyRescan() { autoRescan(); } // the trigger name used before automatic rescans

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
    const byNumber = {}; rows.forEach((r, i) => { const k = domainNumber_(r.id, r.listing_url); if (k && !(k in byNumber)) byNumber[k] = i; });
    const seen = {};
    let added = 0, updated = 0, gone = 0;
    const newRows = [];

    incoming.forEach(n => {
      let id = String(n.id || '').trim();
      if (!id) return;
      // The same Domain listing under another id: an alert email can link to it by number alone (domain.com.au/
      // 2019000003). The row keeps the id that spells out the address (the website's slug, as the rescans use).
      const num = domainNumber_(id, n.listing_url);
      if (!(id in byId) && num && byNumber[num] !== undefined) {
        const i = byNumber[num], old = String(rows[i].id);
        if (/[a-z]/i.test(id) && !/[a-z]/i.test(old)) {
          ['id', 'listing_url'].forEach(f => { sheet.getRange(i + 2, header.indexOf(f) + 1).setValue(n[f]); rows[i][f] = n[f]; });
          byId[id] = i;
        } else { id = old; n = Object.assign({}, n, { id: old, listing_url: rows[i].listing_url }); }
      }
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

/* ---------------- alert emails (Gmail): realestate.com.au and Domain ---------------- */
// Neither site lets a server search its listings for free, but their saved-search alert emails carry each new
// listing's link, price, address and photo. These read them from the Gmail of the account the script runs as (the
// sheet's owner), add listings that aren't in the sheet yet, and note which emails they've read in a script property
// (REA_SEEN, DOMAIN_SEEN). They only read mail: nothing is labelled, moved or deleted. An email with no listings found
// (a newsletter, or an alert the parser doesn't understand yet) is tried again for 3 days, in case of a fix, then
// marked read so its links aren't followed every hour.
// https://www.realestate.com.au/property-apartment-vic-st+kilda-146000001 -> type, state, suburb, listing number
const REA_LISTING = /realestate\.com\.au\/property-([a-z]+)-([a-z]{2,3})-([a-z0-9+%.'-]+?)-(\d{6,})/i;
const REA_TYPES = { apartment: 'Apartment/unit', unit: 'Apartment/unit', flat: 'Apartment/unit', studio: 'Studio', house: 'House', townhouse: 'Townhouse', villa: 'Villa', semi: 'Semi-detached', duplex: 'Duplex' };
// https://www.domain.com.au/12-docker-street-elwood-vic-3184-2019000003 (or just /2019000003) -> slug words, number
const DOMAIN_LINK = /https?:\/\/(?:www\.)?domain\.com\.au\/(?:([a-z0-9-]+?)-)?(\d{8,})(?=[/?#&"']|$)/i;
const DOMAIN_TYPES = { 'apartment / unit / flat': 'Apartment/unit', apartment: 'Apartment/unit', unit: 'Apartment/unit', flat: 'Apartment/unit',
  studio: 'Studio', house: 'House (per Domain)', townhouse: 'Townhouse', villa: 'Villa', 'semi-detached': 'Semi-detached', duplex: 'Duplex' };
// Links never followed: the email's account, settings and social links.
const ACCOUNT_LINK = /unsubscribe|preference|manage|settings|privacy|terms|help|contact|feedback|edit|delete|pause|stop|app store|google play|facebook|instagram|twitter|youtube|linkedin/i;

// How each site's alerts are read. listing: a link to one listing; home: the site itself (never fetched); key: the
// listing's number; row: one card as a Listings row; skip: whether a listing is in the sheet already.
const ALERT_SITES = {
  rea: { name: 'realestate.com.au', query: 'from:realestate.com.au newer_than:21d', from: /realestate\.com\.au/i, seen: 'REA_SEEN',
    listing: REA_LISTING, home: /^https?:\/\/(www\.)?realestate\.com\.au\//i, key: hit => hit[4], row: reaRow_,
    // In the sheet already from Domain or added by hand (matched on address); a listing already here from an
    // earlier alert is updated.
    skip: (r, k) => { const at = k.byAddress[addressKey_(r.address, r.suburb)]; return !!at && String(at.id) !== r.id; } },
  domain: { name: 'Domain', query: 'from:domain.com.au newer_than:21d', from: /domain\.com\.au/i, seen: 'DOMAIN_SEEN',
    listing: DOMAIN_LINK, home: /^https?:\/\/(www\.)?domain\.com\.au\//i, key: hit => hit[2], row: domainAlertRow_,
    // Any Domain listing already here is left to the rescans, which have its full details (an alert's one photo
    // would replace the gallery); one here only from realestate.com.au is taken over (see mergeListings_).
    skip: (r, k) => { const at = k.byAddress[addressKey_(r.address, r.suburb)];
      return !!(k.byId[r.id] || k.byNumber[domainNumber_(r.id, r.listing_url)] || (at && isDomain_(at.listing_url))); } },
};

function previewReaAlerts() { SpreadsheetApp.getUi().alert(importAlerts_(ALERT_SITES.rea, true).message); }
function previewDomainAlerts() { SpreadsheetApp.getUi().alert(importAlerts_(ALERT_SITES.domain, true).message); }
function alertsFromMenu() { SpreadsheetApp.getUi().alert(importAllAlerts_().messages.join('\n\n')); }
// Trigger target (Rental > Turn on hourly alert import). A site that fails doesn't stop the other; the run then
// throws, so Google emails the script's owner.
function alertsHourly() {
  const res = importAllAlerts_();
  if (res.failed.length) throw new Error(res.failed.join('\n'));
}
function reaAlertsHourly() { alertsHourly(); } // the trigger name used before Domain alerts
function enableAlerts() {
  disableAlerts();
  ScriptApp.newTrigger('alertsHourly').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('realestate.com.au and Domain alerts will now be imported every hour.');
}
function disableAlerts() {
  ScriptApp.getProjectTriggers().filter(t => ['alertsHourly', 'reaAlertsHourly'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
}

function importAllAlerts_() {
  const messages = [], failed = [];
  Object.keys(ALERT_SITES).forEach(k => {
    const site = ALERT_SITES[k];
    try { messages.push(importAlerts_(site, false).message); }
    catch (err) { const m = `${site.name} alerts failed: ${err.message || err}`; messages.push(m); failed.push(m); }
  });
  return { messages, failed };
}

// dryRun: report what would be added without touching the sheet or the read list.
function importAlerts_(site, dryRun) {
  const props = PropertiesService.getScriptProperties();
  const seen = JSON.parse(props.getProperty(site.seen) || '[]');
  const messages = [];
  GmailApp.search(site.query, 0, 50).forEach(t => t.getMessages().forEach(m => {
    if (seen.indexOf(m.getId()) < 0 && site.from.test(m.getFrom())) messages.push(m);
  }));
  const suburbs = readSearch_().suburbs;
  const found = {}, read = [];
  let empty = 0;
  messages.forEach(m => {
    const listings = parseAlert_(m.getBody(), site, suburbs);
    listings.forEach(r => { found[r.id] = r; });
    if (!listings.length) empty++;
    if (listings.length || Date.now() - m.getDate().getTime() > 3 * 864e5) read.push(m.getId());
  });

  const wanted = suburbs.map(s => s.toLowerCase());
  const k = { byId: {}, byNumber: {}, byAddress: {} };
  readListings_().rows.forEach(r => {
    k.byId[String(r.id)] = r;
    const num = domainNumber_(r.id, r.listing_url);
    if (num) k.byNumber[num] = r;
    k.byAddress[addressKey_(r.address, r.suburb)] = r;
  });
  const rows = [];
  let already = 0, outOfArea = 0;
  Object.keys(found).forEach(id => {
    const r = found[id];
    if (wanted.indexOf(String(r.suburb).toLowerCase()) < 0) { outOfArea++; return; }
    if (site.skip(r, k)) { already++; return; }
    rows.push(r);
  });

  const total = Object.keys(found).length;
  const lines = [`${messages.length} new ${site.name} email${messages.length === 1 ? '' : 's'}, ${total} listing${total === 1 ? '' : 's'} in them.`,
    `${already} already in the sheet, ${outOfArea} outside your Search suburbs${empty ? `, ${empty} email${empty === 1 ? '' : 's'} with no listings found` : ''}.`];
  if (dryRun) {
    lines.push(rows.length ? `Would add or update ${rows.length}:` : 'Nothing to add.');
    rows.slice(0, 15).forEach(r => lines.push(`• ${r.address || '(no address found)'}, ${r.suburb}: ${r.price ? '$' + r.price + '/wk' : 'no price found'}`));
    return { ok: true, message: lines.join('\n') };
  }
  const res = rows.length ? mergeListings_(rows, false) : { added: 0, updated: 0 };
  props.setProperty(site.seen, JSON.stringify(seen.concat(read).slice(-300)));
  lines.push(`Added ${res.added}, updated ${res.updated}.`);
  return { ok: true, added: res.added, updated: res.updated, message: lines.join('\n') };
}

// One alert email's listings. Each listing's card is the stretch of the email from its first link to the next
// listing's: the photo, price and address are read from there. Links that go through an email click-tracker are
// followed (without loading the page) to see which listing they lead to; account links (unsubscribe, manage
// alerts and so on) and links to the site itself are never followed.
function parseAlert_(html, site, suburbs) {
  html = String(html || '');
  const links = [], re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) links.push({ at: m.index, url: m[1].replace(/&amp;/g, '&'), inner: m[2] });
  const resolved = {}, order = [], byKey = {};
  let lookups = 0;
  links.forEach(l => {
    let hit = l.url.match(site.listing) || decodeSafe_(l.url).match(site.listing);
    if (!hit && lookups < 40 && /^https?:/i.test(l.url) && !site.home.test(l.url) && !ACCOUNT_LINK.test(l.inner + ' ' + l.url)) {
      if (!(l.url in resolved)) { lookups++; resolved[l.url] = followRedirects_(l.url, site); }
      hit = resolved[l.url].match(site.listing);
    }
    if (!hit) return;
    const key = site.key(hit), o = byKey[key];
    if (!o) order.push(byKey[key] = { at: l.at, hit });
    else if (!o.hit[1] && hit[1]) o.hit = hit; // a later link with more of the address in it (Domain links can be the number alone)
  });
  return order.map((o, k) => {
    const card = html.slice(o.at, k + 1 < order.length ? order[k + 1].at : html.length);
    const before = html.slice(k ? order[k - 1].at : 0, o.at); // in case a card puts its price above its first link
    return site.row(o.hit, card, before, suburbs);
  });
}

// One realestate.com.au alert card as a Listings row.
function reaRow_(hit, card, before) {
  const [, kind, state, slug, num] = hit, suburb = titleCase_(decodeSafe_(slug.replace(/\+/g, ' ')).replace(/-/g, ' '));
  const text = textLines_(card), price = priceIn_(text) || priceIn_(textLines_(before).slice(-3));
  const beds = (text.join(' ').match(/(\d)\s*(?:bed|bedroom)s?\b/i) || [])[1];
  const photo = (card.match(/<img\b[^>]*?src\s*=\s*["'](https:\/\/[^"']*reastatic[^"']+)["']/i) || [])[1] || '';
  return {
    id: 'rea-' + num,
    address: addressIn_(text, suburb),
    suburb,
    price: price || '',
    type: REA_TYPES[kind.toLowerCase()] || titleCase_(kind),
    beds: beds ? Number(beds) : '',
    photo_url: photo.replace(/&amp;/g, '&'),
    photos: photo.replace(/&amp;/g, '&'),
    listing_url: `https://www.realestate.com.au/property-${kind}-${state}-${slug}-${num}`.toLowerCase(),
    source: 'realestate.com.au',
  };
}

// One Domain alert card as a Listings row. Its link's slug (12-docker-street-elwood-vic-3184-2019000003) is the id
// the rescans use, and gives the suburb and a fallback address; a link with only the number is matched up by
// mergeListings_ when a rescan finds the slug. Price, address, bedrooms and photo come from the card.
function domainAlertRow_(hit, card, before, suburbs) {
  const slug = (hit[1] ? hit[1] + '-' + hit[2] : hit[2]).toLowerCase();
  const text = textLines_(card), place = domainSlugPlace_(slug, suburbs);
  const suburb = place.suburb || suburbIn_(text, suburbs);
  const price = priceIn_(text) || priceIn_(textLines_(before).slice(-3));
  const beds = (text.join(' ').match(/(\d)\s*(?:bed|bedroom|bd)s?\b/i) || [])[1];
  const type = text.map(l => DOMAIN_TYPES[l.toLowerCase()]).find(Boolean) || '';
  const photo = ((card.match(/<img\b[^>]*?src\s*=\s*["'][^"']+["'][^>]*>/gi) || [])
    .map(tag => (tag.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1].replace(/&amp;/g, '&'))
    .find(src => /^https:\/\/[^/]*(domainstatic\.com\.au|bucket-api\.domain\.com\.au)\//i.test(src) && !/logo|icon|badge|avatar|agent|agency|contact/i.test(src))) || '';
  return {
    id: slug,
    address: (suburb && addressIn_(text, suburb)) || place.address,
    suburb,
    price: price || '',
    type,
    beds: beds ? Number(beds) : '',
    photo_url: photo,
    photos: photo,
    listing_url: 'https://www.domain.com.au/' + slug,
    source: 'Domain',
  };
}

// "5-10-chapel-street-windsor-vic-3181-2019000004" -> { address: '5/10 Chapel St', suburb: 'Windsor' }, using the
// Search tab's suburbs to tell where the street ends (empty when the slug has no address in it).
function domainSlugPlace_(slug, suburbs) {
  const m = slug.match(/^(.+)-(vic|nsw|qld|sa|wa|tas|act|nt)-\d{4}-\d+$/);
  if (!m) return { address: '', suburb: '' };
  const words = m[1], slugOf = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const sub = suburbs.filter(s => words.endsWith('-' + slugOf(s))).sort((a, b) => b.length - a.length)[0];
  let street, suburb;
  if (sub) { suburb = sub; street = words.slice(0, -(slugOf(sub).length + 1)).split('-'); }
  else { // not a Search suburb: it starts after the street's last street-type word
    const w = words.split('-'), types = Object.keys(STREET_TYPES).concat(Object.keys(STREET_TYPES).map(t => STREET_TYPES[t]));
    let i = w.length - 2;
    while (i > 0 && types.indexOf(w[i]) < 0) i--;
    if (i <= 0) return { address: '', suburb: '' };
    street = w.slice(0, i + 1); suburb = titleCase_(w.slice(i + 1).join(' '));
  }
  const unit = /^\d+[a-z]?$/.test(street[0]) && /^\d+[a-z]?$/.test(street[1] || '') ? street.shift() + '/' : '';
  return { address: shortStreet_(unit + titleCase_(street.join(' '))), suburb };
}
// The Search tab suburb a card names (", Elwood" or "Elwood VIC 3184"), longest name first.
function suburbIn_(lines, suburbs) {
  const all = lines.join('\n').toLowerCase();
  return suburbs.slice().sort((a, b) => b.length - a.length)
    .find(s => new RegExp('(,\\s*|\\n)' + s.toLowerCase().replace(/[^a-z0-9]+/g, '\\s+') + '(\\s*,|\\s+vic\\b|\\s+\\d{4}|\\n|$)').test(all)) || '';
}
// Domain's listing number, for rows that are Domain listings: the digits that end the id.
const domainNumber_ = (id, url) => isDomain_(url) ? (String(id).match(/(?:^|-)(\d{7,})$/) || [])[1] : undefined;

// Where a click-tracking link ends up, following up to four redirects without loading the final page (and without
// requesting the site itself, which blocks servers).
function followRedirects_(url, site) {
  for (let hop = 0; hop < 4; hop++) {
    if (site.listing.test(url)) return url;
    if (site.home.test(url)) return '';
    try {
      const res = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
      const h = res.getAllHeaders(), next = h.Location || h.location;
      if (res.getResponseCode() < 300 || res.getResponseCode() >= 400 || !next) return '';
      url = Array.isArray(next) ? next[0] : String(next);
    } catch (err) { return ''; }
  }
  return site.listing.test(url) ? url : '';
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
