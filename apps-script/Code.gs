/**
 * Rental Shortlist back end (Google Apps Script, bound to the Google Sheet).
 *
 * Tabs:
 *   Listings  one row per listing (header row 1). Votes and notes live in their own columns
 *             and are never touched by a rescan.
 *   Inbox     paste fresh scan results here (same columns as Listings, votes left blank),
 *             then run  Rental > Merge inbox.
 *   Search    the saved search criteria (for whoever runs the rescan, and for a future API hook).
 *
 * Script property (Project Settings > Script properties):
 *   PASSCODE  the shared code you and your partner type into the app once.
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
// Columns a rescan is allowed to overwrite on an existing row.
const SCAN_FIELDS = ['price', 'bond', 'type', 'beds', 'flooring', 'level', 'outdoor', 'pets',
  'inspections', 'available', 'agency', 'notes', 'photo_url', 'listing_url'];

/* ---------------- menu ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rental')
    .addItem('Merge inbox (keep missing listings)', 'mergeInboxPartial')
    .addItem('Merge inbox (full scan: mark missing as gone)', 'mergeInboxFull')
    .addSeparator()
    .addItem('Fill missing map locations', 'geocodeMissing')
    .addToUi();
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
  return json_({ ok: false, error: 'unknown_action' });
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

/* ---------------- rescan ---------------- */
// Hook for an automatic source (e.g. Domain's developer API, if access is granted).
// Return an array of objects keyed by COLUMNS (scan fields only). Until then it returns null.
function fetchScanResults_() {
  return null;
}

function rescan_() {
  const results = fetchScanResults_();
  if (!results) return { ok: false, error: 'not_configured', message: 'Automatic rescans are not connected yet. Ask Claude or Cowork to rescan, then merge the Inbox tab.' };
  return mergeListings_(results, true);
}

// Daily trigger target (set up in Triggers once fetchScanResults_ is connected).
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

function mergeListings_(incoming, full) {
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
        if (r.status !== 'gone' && !seen[String(r.id)]) {
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
