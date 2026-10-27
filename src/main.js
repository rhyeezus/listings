import './style.css'

const API = import.meta.env.VITE_API_URL || ''
const VOTERS = { rhys: 'Rhys', partner: 'Partner' }
const BAYSIDE = ['Elwood', 'Elsternwick', 'Ripponlea', 'Balaclava', 'St Kilda', 'St Kilda East', 'St Kilda West', 'Brighton', 'Gardenvale', 'Black Rock']
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

const state = {
  key: store.get('rs-key', ''),
  who: store.get('rs-who', ''),
  listings: [],
  loading: false,
  filter: 'mine',
  sort: 'score',
  onlyBoth: false,
  history: [],
  back: '', // direction of the last undone vote, so its card can fly back in
  fetchedAt: null,
  keep: new Set(), // listings opened on the inspections view: they stay in its list, whatever the vote, until you leave it
  sheet: null, // the open inspection ad sheet: { row, prev, next }
  sheetPushed: false, // the sheet was opened from the list, so closing it can go back in history
  focusKey: '', // the row to put focus back on once the sheet closes
  gateError: '', // shown on the passcode page after a passcode is turned down
}

const app = document.getElementById('app')
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const money = n => (n === '' || n == null) ? '' : '$' + Number(n).toLocaleString('en-AU')

/* ---------- data shaping ---------- */
function parseInspections(text) {
  // "Wed 28 Oct, 4:45 - 5pm; Thu 29 Oct, 12:30 - 12:45pm"
  const now = new Date()
  return String(text || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^\w{3} (\d{1,2}) (\w{3}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*-\s*(\d{1,2})(?::\d{2})?\s*(am|pm)/i)
    if (!m) return { label: s, start: null }
    const [, d, mon, h, mi, ap1, h2, ap2] = m
    let hour = +h
    const ap = (ap1 || ap2).toLowerCase()
    if (ap === 'pm' && hour !== 12) hour += 12
    if (!ap1 && ap2.toLowerCase() === 'pm' && +h > +h2) hour -= 12 // "11:45 - 12:05pm"
    let year = now.getFullYear()
    if (MONTHS[mon] < now.getMonth() - 6) year++
    return { label: s, start: new Date(year, MONTHS[mon], +d, hour, +(mi || 0)) }
  })
}
function score(l) {
  const f = String(l.flooring).toLowerCase(), o = String(l.outdoor).toLowerCase()
  let s = 0
  if (f.includes('carpet')) s -= 3
  if (f.includes('boards')) s += 2
  if (l.level === 'Ground') s += 2
  if (o.includes('courtyard')) s += (o.includes('shared') || o.includes('communal')) ? 1 : 3
  else if (o.includes('garden')) s += o.includes('communal') ? 1 : 2
  if (BAYSIDE.includes(l.suburb)) s += 1
  return s
}
function shape(raw) {
  const l = { ...raw }
  l.id = String(l.id)
  l.price = Number(l.price) || 0
  l.photos = String(l.photos || '').split(/\s+/).filter(Boolean) // one URL per line; listings scanned before photos were saved have only photo_url
  if (!l.photos.length && l.photo_url) l.photos = [l.photo_url]
  l.thumb = l.photo_url || l.photos[0] || ''
  l.insp = parseInspections(l.inspections)
  l.score = score(l)
  l.isNew = l.added_on && (Date.now() - new Date(l.added_on).getTime()) < 3 * 864e5
  return l
}
const upcoming = l => l.insp.filter(i => i.start && i.start >= new Date())
const nextInsp = l => upcoming(l)[0] || null
const myVote = l => l[state.who + '_vote'] || ''
const otherKey = () => state.who === 'rhys' ? 'partner' : 'rhys'
function combined(l) {
  if (l.status === 'gone') return 'gone'
  const a = l.rhys_vote, b = l.partner_vote
  if (a === 'no' || b === 'no') return 'out'
  if (a === 'yes' && b === 'yes') return 'both'
  if (a || b) return 'split'
  return 'none'
}
const active = () => state.listings.filter(l => l.status !== 'gone')

/* ---------- api ---------- */
async function load() {
  if (!API) return render() // no back end in this build: never send the passcode anywhere
  state.loading = true
  try {
    const r = await fetch(`${API}?key=${encodeURIComponent(state.key)}`)
    const j = await r.json()
    if (!j.ok) {
      if (j.error === 'bad_passcode') { state.key = ''; store.set('rs-key', ''); state.gateError = 'That passcode didn’t work. Try again.'; return render() }
      throw new Error(j.error)
    }
    state.listings = j.listings.map(shape)
    state.fetchedAt = new Date()
    runImport()
  } catch (e) {
    toast('Couldn’t load listings. Check your connection and pull to refresh.')
  } finally {
    state.loading = false
    render()
  }
}
async function post(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: state.key, ...body }) })
  return r.json()
}
async function vote(id, v) {
  const l = state.listings.find(x => x.id === id)
  if (!l) return
  const field = state.who + '_vote'
  const prev = l[field] || ''
  state.history.push({ id, prev, v })
  l[field] = v
  render()
  try {
    const j = await post({ action: 'vote', id, who: state.who, vote: v })
    if (!j.ok) throw new Error(j.error)
  } catch {
    l[field] = prev
    state.history.pop()
    toast('That vote didn’t save. Try again.')
    render()
  }
}
const noteTimers = {}
function saveNote(id, text) {
  const l = state.listings.find(x => x.id === id)
  if (!l) return
  l[state.who + '_note'] = text
  clearTimeout(noteTimers[id])
  noteTimers[id] = setTimeout(async () => {
    try { const j = await post({ action: 'vote', id, who: state.who, note: text }); if (!j.ok) throw 0 }
    catch { toast('Your note didn’t save. Try again.') }
  }, 800)
}
// A Domain scan handed over by scripts/domain-rescan.js as #import=<json>. It waits in sessionStorage
// until the app is signed in, then goes to the sheet with the stored passcode.
function takeImport() {
  if (!location.hash.startsWith('#import=')) return
  try { sessionStorage.setItem('rs-import', decodeURIComponent(location.hash.slice(8))) } catch {}
  history.replaceState(null, '', location.pathname + location.search + '#swipe')
}
async function runImport() {
  if (!state.key) return
  let raw = null
  try { raw = sessionStorage.getItem('rs-import'); sessionStorage.removeItem('rs-import') } catch {}
  if (!raw) return
  const scan = JSON.parse(raw)
  toast(`Importing ${scan.rows.length} listings from Domain…`, 0)
  try {
    const j = await post({ action: 'import', rows: scan.rows, full: scan.full })
    if (!j.ok) throw new Error(j.message || j.error)
    toast(`Rescan done: ${j.added} new, ${j.updated} updated, ${j.gone} marked gone${j.goneChecked ? '' : ' (gone check skipped: the scan looked partial)'}.`, 10000)
    await load()
  } catch (e) { toast('The import didn’t go through: ' + (e.message || e), 10000) }
}
async function rescan() {
  const b = $('#rescan'); if (b) b.disabled = true
  try {
    const j = await post({ action: 'rescan' })
    if (j.ok) { toast(`Rescan done: ${j.added} new, ${j.gone} gone.`); await load() }
    else toast(j.message || 'Rescan didn’t run.')
  } catch { toast('Rescan didn’t run. Check your connection.') }
  if (b) b.disabled = false
}

/* ---------- pieces ---------- */
function chips(l) {
  const c = [], f = String(l.flooring).toLowerCase(), o = String(l.outdoor).toLowerCase()
  if (f.includes('carpet')) c.push('<span class="chip bad">Carpet mentioned</span>')
  if (f.includes('boards')) c.push(`<span class="chip good">${f.includes('timber-look') ? 'Timber-look floors' : 'Floorboards'}</span>`)
  if (f.includes('tile')) c.push('<span class="chip">Tiles</span>')
  if (f.includes('terrazzo')) c.push('<span class="chip good">Terrazzo</span>')
  if (!f) c.push('<span class="chip unk">Flooring not stated</span>')
  if (l.level === 'Ground') c.push('<span class="chip good">Ground floor</span>')
  else if (l.level) c.push(`<span class="chip">${l.level === 'Upper' ? 'Upstairs' : esc(l.level)}</span>`)
  if (o.includes('courtyard') && !o.includes('shared') && !o.includes('communal')) c.push('<span class="chip good">Courtyard</span>')
  else if (o.includes('courtyard')) c.push('<span class="chip">Shared courtyard</span>')
  else if (o.includes('garden') && !o.includes('communal')) c.push('<span class="chip good">Garden</span>')
  if (o.includes('communal garden')) c.push('<span class="chip">Communal garden</span>')
  if (o.includes('balcony')) c.push('<span class="chip">Balcony</span>')
  if (o.includes('outdoor')) c.push('<span class="chip">Outdoor area</span>')
  if (/yes|true/i.test(String(l.pets))) c.push('<span class="chip">Pets listed</span>')
  if (/house|semi|townhouse/i.test(l.type)) c.push(`<span class="chip">${esc(String(l.type).replace(' (per Domain)', ''))}</span>`)
  if (Number(l.beds) && Number(l.beds) !== 2) c.push(`<span class="chip">${Number(l.beds)} bed</span>`)
  return c.join('')
}
const badge = l => l.status === 'gone' ? '<span class="badge gone">Gone</span>' : l.isNew ? '<span class="badge">New</span>' : ''
function photo(l) {
  const ph = `<div class="ph">${esc(l.suburb)}<span>No photo yet</span></div>`
  const img = l.thumb ? `<img src="${esc(l.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''
  return `<div class="photo">${ph}${img}${badge(l)}</div>`
}
// Every photo, side by side: swipe on a phone, arrows with a mouse. Used in the inspection sheet.
function gallery(l) {
  const ps = l.photos, n = ps.length
  if (n < 2) return photo(l)
  return `<div class="gal">
    <div class="gal-track" id="gal-track">${ps.map((u, i) => `<img src="${esc(u)}" alt="Photo ${i + 1} of ${n}" ${i ? 'loading="lazy"' : ''} referrerpolicy="no-referrer" draggable="false">`).join('')}</div>
    ${badge(l)}
    <button class="gal-arrow prev" id="gal-prev" type="button" aria-label="Previous photo">‹</button>
    <button class="gal-arrow next" id="gal-next" type="button" aria-label="Next photo">›</button>
    <span class="gal-n" id="gal-n" aria-live="polite">1 / ${n}</span>
    <div class="gal-dots" aria-hidden="true">${ps.map((_, i) => `<i${i ? '' : ' class="on"'}></i>`).join('')}</div>
  </div>`
}
// The ad's own description, cut to a few lines until "Read more".
function about(l) {
  const d = String(l.description || '').trim()
  if (!d) return ''
  const long = d.length > 320
  return `<div class="about"><div class="lbl">About this place</div>
    <p class="about-text${long ? ' clamp' : ''}" id="about-text">${esc(d)}</p>
    ${long ? '<button class="ghost about-more" id="about-more" type="button" aria-expanded="false" aria-controls="about-text">Read more</button>' : ''}
  </div>`
}
function votesLine(l) {
  return `<div class="votes">${Object.entries(VOTERS).map(([k, name]) => {
    const v = l[k + '_vote'] || ''
    return `<span class="vote ${v}"><b>${k === state.who ? 'You' : name}</b> ${v ? v[0].toUpperCase() + v.slice(1) : 'Not yet'}</span>`
  }).join('')}</div>`
}
function inspBlock(l) {
  const n = nextInsp(l)
  if (!n) return '<div class="insp none"><div class="when">No inspection listed. Book through the agent.</div></div>'
  const more = upcoming(l).length - 1
  return `<div class="insp"><div class="lbl">Next inspection</div><div class="when">${esc(n.label)}${more > 0 ? ` <span style="color:var(--muted)">+${more} more</span>` : ''}</div></div>`
}
function links(l) {
  const q = encodeURIComponent(`${l.address}, ${l.suburb} VIC`)
  const site = /realestate\.com\.au/.test(l.listing_url) ? 'realestate.com.au' : 'Listing & photos'
  return `<div class="links">
    <a href="${esc(l.listing_url)}" target="_blank" rel="noopener">${site} ↗</a>
    <a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Map ↗</a>
    <a href="https://www.google.com/maps/search/train+station+near+${q}" target="_blank" rel="noopener">Nearest trains ↗</a>
  </div>`
}
function rentLine(l) {
  return `<div class="rent"><span class="price">${money(l.price)}<small> /wk</small></span>${l.bond ? `<span class="bond">bond ${money(l.bond)}</span>` : ''}</div>`
}
// Inspection, notes, votes, agency and links: shared by grid cards, the swipe card's details panel and the inspection
// sheet. lead replaces the opening inspection block (the sheet shows the row's own inspection and the description).
function detailsBody(l, lead = inspBlock(l)) {
  const other = l[otherKey() + '_note']
  const meta = [l.agency, l.available && `Available ${String(l.available).replace(/^Available /i, '').toLowerCase()}`].filter(Boolean)
  return `${lead}
    ${l.notes ? `<p class="note">${esc(l.notes)}</p>` : ''}
    ${other ? `<p class="note"><b>${VOTERS[otherKey()]}:</b> ${esc(other)}</p>` : ''}
    ${votesLine(l)}
    <div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>
    ${links(l)}`
}
function cardBody(l) {
  return `${photo(l)}<div class="inner">
    ${rentLine(l)}
    <div><div class="addr">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
    <div class="chips">${chips(l)}</div>
    ${detailsBody(l)}
  </div>`
}

/* ---------- views ---------- */
function queue() {
  return active().filter(l => !myVote(l))
    .sort((a, b) => b.score - a.score || (nextInsp(a) ? 0 : 1) - (nextInsp(b) ? 0 : 1) || a.price - b.price)
}
const ICONS = {
  no: '<path d="M6 6l12 12M18 6L6 18"/>',
  maybe: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  yes: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
}
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`

// One card in the swipe stack. i = 0 is the top (interactive) card; the ones behind are decoration.
function swipeCard(l, i, back) {
  const top = i === 0
  const n = nextInsp(l)
  return `<article class="swipe-card${top ? ' top' : ''}${top && back ? ' back-' + back : ''}" style="--i:${i}" ${top ? `id="big" data-id="${esc(l.id)}"` : 'aria-hidden="true"'}>
    <div class="sc-photo"><span class="sc-ph">${esc(l.suburb)}</span>${l.photos[0] ? `<img src="${esc(l.photos[0])}" alt="" draggable="false" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>
    ${l.isNew ? '<span class="badge">New</span>' : ''}
    ${top ? '<span class="stamp yes" data-stamp="yes">Yes</span><span class="stamp no" data-stamp="no">Nope</span><span class="stamp maybe" data-stamp="maybe">Maybe</span>' : ''}
    <div class="sc-info">
      ${rentLine(l)}
      <div><div class="addr">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
      <div class="sc-when">${n ? `Inspect ${esc(n.label)}` : 'No inspection listed'}</div>
      ${top ? `<div class="chips">${chips(l)}</div><button class="sc-more" id="more" type="button" aria-expanded="false" aria-controls="details">Details</button>` : ''}
    </div>
    ${top ? `<div class="sc-details" id="details" hidden><button class="ghost sc-less" id="less" type="button">Hide details</button>${detailsBody(l)}</div>` : ''}
  </article>`
}
function viewSwipe() {
  const q = queue()
  const back = state.back; state.back = ''
  if (!q.length) return `<div class="card"><div class="inner"><h2>You’ve voted on everything.</h2><p class="sub">New listings from the next rescan will show up here. Check the inspection run for what you’re both keen on.</p><div><a href="#inspections">Go to inspections</a></div></div></div>`
  // Four cards: the fourth sits invisible behind the third so the stack never pops when the top one flies off.
  const cards = q.slice(0, 4).map((l, i) => swipeCard(l, i, back)).reverse().join('')
  return `<section class="deck">
    <div class="stack" id="stack">${cards}</div>
    <div class="actions">
      <button class="act small undo" id="undo" type="button" aria-label="Undo last vote (U)" title="Undo (U)" ${state.history.length ? '' : 'disabled'}>${icon('undo')}</button>
      <button class="act no" data-act="no" type="button" aria-label="No (left arrow)" title="No (←)">${icon('no')}</button>
      <button class="act small maybe" data-act="maybe" type="button" aria-label="Maybe (up arrow)" title="Maybe (↑)">${icon('maybe')}</button>
      <button class="act yes" data-act="yes" type="button" aria-label="Yes (right arrow)" title="Yes (→)">${icon('yes')}</button>
    </div>
  </section>`
}
// Upcoming inspections, earliest first, one row per inspection. key ("<id>/<start ms>", id URL-encoded) is the
// row's address in the #inspections/<key> hash that opens its sheet.
function inspRows() {
  const rows = []
  active().forEach(l => {
    const c = combined(l)
    if (!state.keep.has(l.id) && (c === 'out' || (state.onlyBoth && c !== 'both'))) return
    upcoming(l).forEach(i => rows.push({ l, i, c, key: `${encodeURIComponent(l.id)}/${i.start.getTime()}`,
      day: i.start.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' }) }))
  })
  return rows.sort((a, b) => a.i.start - b.i.start || (b.c === 'both') - (a.c === 'both'))
}
function viewInspections(rows) {
  const head = `<div class="toolbar"><div><h2>Inspections</h2><p class="sub">Upcoming inspections, grouped by day. Tap one to see the ad and vote. Listings either of you said no to are hidden.</p></div>
    <div class="seg" role="group" aria-label="Show"><button type="button" data-both="0" aria-pressed="${!state.onlyBoth}">All still in</button><button type="button" data-both="1" aria-pressed="${state.onlyBoth}">Both yes</button></div></div>`
  if (!rows.length) return head + `<p class="empty">${state.onlyBoth ? 'Nothing you’ve both said yes to has an inspection coming up.' : 'No upcoming inspections.'}</p>`
  const days = new Map()
  rows.forEach(r => { if (!days.has(r.day)) days.set(r.day, []); days.get(r.day).push(r) })
  let html = ''
  // Each day's "Vote on" button opens the sheet at the first inspection you haven't voted on that day.
  days.forEach((run, d) => {
    const open = run.filter(r => !myVote(r.l)), start = open[0] || run[0]
    const wd = run[0].i.start.toLocaleDateString('en-AU', { weekday: 'long' })
    html += `<div class="day"><span class="day-d">${esc(d)}</span>
      <span class="day-n">${run.length} inspection${run.length === 1 ? '' : 's'} · ${open.length ? `${open.length} to vote on` : 'all voted'}</span>
      <a class="day-go" href="#inspections/${esc(start.key)}">${open.length ? 'Vote on' : 'Go through'} ${esc(wd)}</a></div>`
    run.forEach(({ l, i, c, key }) => {
      html += `<a class="row" href="#inspections/${esc(key)}" data-key="${esc(key)}" data-c="${c}">
        <span class="t">${esc(i.label.split(', ')[1] || '')}</span>
        <span class="thumb">${l.thumb ? `<img src="${esc(l.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
        <span class="a"><b>${esc(l.address)}</b><br><span>${esc(l.suburb)} · ${money(l.price)}/wk</span></span>
        <span class="v">${Object.entries(VOTERS).map(([k, n]) => { const v = l[k + '_vote']; return `<span class="vote ${v || ''}" title="${n}">${k === state.who ? 'You' : n}: ${v || '–'}</span>` }).join('')}</span>
      </a>`
    })
  })
  return head + `<div class="run">${html}</div>`
}
// The ad for one inspection row, with your vote and prev/next through that day's inspections.
// A bottom sheet on phones, a side panel on wider screens.
function viewSheet(rows, key, opening) {
  const row = rows.find(x => x.key === key) || rows.find(x => x.key.split('/')[0] === key.split('/')[0])
  if (!row) return ''
  const run = rows.filter(x => x.day === row.day), n = run.indexOf(row)
  state.sheet = { row, run, n, prev: run[n - 1], next: run[n + 1] }
  const { l, i } = row, v = myVote(l)
  const when = `<div class="insp"><div class="lbl">This inspection</div><div class="when">${esc(i.label)}</div></div>`
  return `<div class="sheet-back" id="sheet-back"></div>
    <section class="sheet${opening ? ' opening' : ''}" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">
      <button class="sheet-x" id="sheet-x" type="button" aria-label="Close">${icon('no')}</button>
      <div class="sheet-body">${gallery(l)}<div class="inner">
        ${rentLine(l)}
        <div><div class="addr" id="sheet-title">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
        <div class="chips">${chips(l)}</div>
        ${detailsBody(l, when + about(l))}
      </div></div>
      <div class="sheet-foot">
        <div class="mine big" role="group" aria-label="Your vote">${['no', 'maybe', 'yes'].map(k => `<button type="button" class="${k} ${v === k ? 'on' : ''}" data-sv="${k}" aria-pressed="${v === k}">${icon(k)}${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
        <div class="sheet-nav">
          <button class="ghost" id="sheet-prev" type="button" aria-label="Previous inspection" ${state.sheet.prev ? '' : 'disabled'}>‹ Prev</button>
          <span>${n + 1} of ${run.length} · ${esc(i.start.toLocaleDateString('en-AU', { weekday: 'long' }))}</span>
          <button class="ghost" id="sheet-next" type="button" aria-label="Next inspection" ${state.sheet.next ? '' : 'disabled'}>Next ›</button>
        </div>
      </div>
    </section>`
}
const FILTERS = [
  ['mine', 'Needs my vote', l => l.status !== 'gone' && !myVote(l)],
  ['both', 'Both yes', l => combined(l) === 'both'],
  ['split', 'Talk about it', l => combined(l) === 'split'],
  ['out', 'Out', l => combined(l) === 'out'],
  ['all', 'All active', l => l.status !== 'gone'],
  ['gone', 'Gone', l => l.status === 'gone'],
]
function viewAll() {
  const f = FILTERS.find(x => x[0] === state.filter) || FILTERS[0]
  const L = state.listings.filter(f[2]).sort((a, b) => {
    if (state.sort === 'price') return a.price - b.price
    if (state.sort === 'insp') return (nextInsp(a)?.start || Infinity) - (nextInsp(b)?.start || Infinity)
    if (state.sort === 'new') return String(b.added_on).localeCompare(String(a.added_on)) || b.score - a.score
    if (state.sort === 'suburb') return a.suburb.localeCompare(b.suburb) || a.price - b.price
    return b.score - a.score || a.price - b.price
  })
  const counts = Object.fromEntries(FILTERS.map(([k, , fn]) => [k, state.listings.filter(fn).length]))
  return `<div class="toolbar">
      <div class="seg" role="group" aria-label="Filter">${FILTERS.map(([k, n]) => `<button type="button" data-f="${k}" aria-pressed="${state.filter === k}">${n} <span style="font-family:var(--f-data);opacity:.7">${counts[k]}</span></button>`).join('')}</div>
      <label class="sub" style="display:flex;gap:8px;align-items:center;margin:0">Sort
        <select id="sort">${[['score', 'Best match'], ['price', 'Price, low first'], ['insp', 'Next inspection'], ['new', 'Newest'], ['suburb', 'Suburb']].map(([v, n]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </label>
    </div>
    ${L.length ? `<div class="grid">${L.map(l => {
      const v = myVote(l)
      return `<article class="card" data-c="${combined(l)}" data-id="${esc(l.id)}">${cardBody(l)}
        <div class="inner" style="padding-top:0">
          <div class="mine" role="group" aria-label="Your vote">${['yes', 'maybe', 'no'].map(k => `<button type="button" class="${k} ${v === k ? 'on' : ''}" data-v="${k}" aria-pressed="${v === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
          <textarea id="note-${esc(l.id)}" data-note="${esc(l.id)}" placeholder="Your notes">${esc(l[state.who + '_note'] || '')}</textarea>
        </div></article>`
    }).join('')}</div>` : '<p class="empty">Nothing here.</p>'}`
}

/* ---------- shell ---------- */
function gate() {
  const err = state.gateError
  app.innerHTML = `<main><form class="gate" id="gate">
    <div><h1>Shortlist</h1><p class="sub">The rentals we’re looking at, together.</p></div>
    ${API ? '' : '<div class="banner">This build has no back-end address. Set VITE_API_URL in Vercel and redeploy.</div>'}
    <label for="key">Passcode</label>
    <input id="key" type="password" autocomplete="current-password" required ${API ? '' : 'disabled'} ${err ? 'aria-invalid="true" aria-describedby="key-err"' : ''}>
    ${err ? `<p class="err" id="key-err" role="alert">${esc(err)}</p>` : ''}
    <button class="primary" type="submit" ${API ? '' : 'disabled'}>Open shortlist</button>
  </form></main>`
  $('#gate').addEventListener('submit', e => {
    e.preventDefault()
    const k = $('#key').value.trim()
    if (!k || !API) return
    state.key = k; store.set('rs-key', k); state.gateError = ''
    const b = $('#gate .primary'); b.disabled = true; b.textContent = 'Opening…'
    load()
  })
}
// Asked once per device, after the passcode works. Votes and notes are saved under this name; Switch in the top bar changes it.
function pickWho() {
  app.innerHTML = `<main><div class="gate">
    <div><h1>Who’s on this device?</h1><p class="sub">Your votes and notes are saved under your name. You can switch any time from the top bar.</p></div>
    <div class="row2">${Object.entries(VOTERS).map(([k, n]) => `<button type="button" class="ghost" data-who="${k}">${n}</button>`).join('')}</div>
  </div></main>`
  document.querySelectorAll('[data-who]').forEach(b => b.addEventListener('click', () => { state.who = b.dataset.who; store.set('rs-who', state.who); render() }))
}
function route() { return (location.hash || '#swipe').slice(1) }
function render() {
  if (!state.key || !API) return gate() // without a back end, stay on the sign-in page and its warning
  if (!state.who) return pickWho()
  const [r, ...sel] = route().split('/')
  if (r !== 'inspections') state.keep.clear()
  const sheetKey = r === 'inspections' && sel.length === 2 ? sel.join('/') : ''
  if (sheetKey) state.keep.add(decodeURIComponent(sel[0]))
  const left = queue().length
  const both = active().filter(l => combined(l) === 'both').length
  const rows = r === 'inspections' ? inspRows() : []
  const view = state.loading && !state.listings.length ? '<p class="empty">Loading listings…</p>'
    : r === 'inspections' ? viewInspections(rows) : r === 'all' ? viewAll() : viewSwipe()
  const was = state.sheet, sheetTop = $('.sheet-body')?.scrollTop || 0, galLeft = $('#gal-track')?.scrollLeft || 0
  state.sheet = null
  const sheet = sheetKey ? viewSheet(rows, sheetKey, !was) : ''
  const scrollY = window.scrollY
  app.innerHTML = `<header class="bar"><div class="bar-in">
      <div class="brand">Shortlist <small>${active().length} listings</small></div>
      <nav class="tabs" aria-label="Views">
        <a href="#swipe" ${r === 'swipe' ? 'aria-current="page"' : ''}>Vote<span class="count">${left}</span></a>
        <a href="#inspections" ${r === 'inspections' ? 'aria-current="page"' : ''}>Inspections</a>
        <a href="#all" ${r === 'all' ? 'aria-current="page"' : ''}>All<span class="count">${both} both yes</span></a>
      </nav>
      <div class="who">Voting as <b style="color:var(--ink)">${VOTERS[state.who]}</b>
        <button class="ghost" id="switch" type="button">Switch</button>
        <button class="ghost" id="rescan" type="button">Rescan</button>
      </div>
    </div></header>
    <main class="view-${r}">${view}</main>${sheet}`
  document.documentElement.classList.toggle('lock', !!state.sheet) // the list behind the sheet stays put
  if (r === 'all' || r === 'inspections') window.scrollTo(0, scrollY)
  wire()
  if (state.sheet && !was) $('#sheet').focus()
  else if (state.sheet && was.row.key === state.sheet.row.key) {
    $('.sheet-body').scrollTop = sheetTop
    if ($('#gal-track')) $('#gal-track').scrollLeft = galLeft
  }
  if (!state.sheet && state.focusKey) $(`.row[data-key="${CSS.escape(state.focusKey)}"]`)?.focus({ preventScroll: true })
  if (!state.sheet) state.focusKey = ''
}
function wire() {
  $('#switch')?.addEventListener('click', () => { state.who = state.who === 'rhys' ? 'partner' : 'rhys'; store.set('rs-who', state.who); state.history = []; render() })
  $('#rescan')?.addEventListener('click', rescan)
  $('#undo')?.addEventListener('click', undo)
  document.querySelectorAll('.act[data-act]').forEach(b => b.addEventListener('click', () => decideTop(b.dataset.act)))
  const big = $('#big'); if (big) drag(big)
  $('#more')?.addEventListener('click', () => showDetails(true))
  $('#less')?.addEventListener('click', () => showDetails(false))
  document.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.f; render() }))
  document.querySelectorAll('[data-both]').forEach(b => b.addEventListener('click', () => { state.onlyBoth = b.dataset.both === '1'; render() }))
  $('#sort')?.addEventListener('change', e => { state.sort = e.target.value; render() })
  document.querySelectorAll('.grid [data-v]').forEach(b => b.addEventListener('click', () => {
    const id = b.closest('.card').dataset.id, l = state.listings.find(x => x.id === id)
    vote(id, myVote(l) === b.dataset.v ? '' : b.dataset.v)
  }))
  document.querySelectorAll('[data-note]').forEach(t => t.addEventListener('input', () => saveNote(t.dataset.note, t.value)))
  $('#sheet-x')?.addEventListener('click', closeSheet)
  $('#sheet-back')?.addEventListener('click', closeSheet)
  $('#sheet-prev')?.addEventListener('click', () => goSheet(state.sheet?.prev))
  $('#sheet-next')?.addEventListener('click', () => goSheet(state.sheet?.next))
  document.querySelectorAll('[data-sv]').forEach(b => b.addEventListener('click', () => sheetVote(b.dataset.sv)))
  $('#about-more')?.addEventListener('click', e => {
    const open = !$('#about-text').classList.toggle('clamp')
    e.target.textContent = open ? 'Show less' : 'Read more'; e.target.setAttribute('aria-expanded', String(open))
  })
  wireGallery()
}
function wireGallery() {
  const t = $('#gal-track'); if (!t) return
  const n = t.children.length, dots = document.querySelectorAll('.gal-dots i')
  const show = () => {
    const i = Math.round(t.scrollLeft / t.clientWidth)
    $('#gal-n').textContent = `${i + 1} / ${n}`
    dots.forEach((d, j) => d.classList.toggle('on', j === i))
  }
  const step = dir => t.scrollBy({ left: dir * t.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  t.addEventListener('scroll', show, { passive: true })
  $('#gal-prev').addEventListener('click', () => step(-1))
  $('#gal-next').addEventListener('click', () => step(1))
}
function showDetails(open) {
  const d = $('#details'); if (!d) return
  d.hidden = !open
  $('#more').setAttribute('aria-expanded', String(open))
  ;(open ? $('#less') : $('#more')).focus()
}

/* ---------- inspection sheet ---------- */
// A row opens the sheet by pushing #inspections/<key>, so the phone's back button closes it. Prev and next
// replace that entry rather than adding more, so one back still returns to the list.
let lastRoute = route()
function replaceHash(h) { history.replaceState(null, '', h); lastRoute = route(); render() }
function goSheet(row) { if (row) replaceHash('#inspections/' + row.key) }
function closeSheet() {
  if (!state.sheet) return
  state.focusKey = state.sheet.row.key
  if (state.sheetPushed) history.back()
  else replaceHash('#inspections')
}
function sheetVote(v) {
  const s = state.sheet; if (!s) return
  const next = myVote(s.row.l) === v ? '' : v
  vote(s.row.l.id, next)
  if (!next) return
  // Let the button show the vote for a beat, then move on to the next inspection that day you haven't voted on.
  setTimeout(() => {
    const t = state.sheet; if (t?.row.key !== s.row.key || myVote(t.row.l) !== next) return // moved on, or the vote was taken back
    const open = r => !myVote(r.l)
    const to = t.run.slice(t.n + 1).find(open) || t.run.slice(0, t.n).find(open)
    if (to) return goSheet(to)
    const count = k => t.run.filter(r => myVote(r.l) === k).length
    toast(`That’s ${t.row.i.start.toLocaleDateString('en-AU', { weekday: 'long' })} done: ${count('yes')} yes, ${count('maybe')} maybe, ${count('no')} no.`)
  }, 250)
}

/* ---------- swipe physics ---------- */
const clamp01 = n => Math.max(0, Math.min(1, n))
const SWIPE_DIST = 120, FLICK_SPEED = 0.6, TAP_SLOP = 6 // px, px/ms, px
// Stamps fade in with drag distance; --p on the stack (0..1) slides the cards behind up one slot.
function showDrag(el, dx, dy) {
  const up = -dy > Math.abs(dx)
  el.querySelector('[data-stamp="yes"]').style.opacity = up ? 0 : clamp01(dx / 100)
  el.querySelector('[data-stamp="no"]').style.opacity = up ? 0 : clamp01(-dx / 100)
  el.querySelector('[data-stamp="maybe"]').style.opacity = up ? clamp01(-dy / 100) : 0
  $('#stack').style.setProperty('--p', clamp01(Math.hypot(dx, dy) / 160))
}
function drag(el) {
  let s = null
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('a, button, .sc-details')) return
    s = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, t: e.timeStamp, vx: 0, vy: 0 }
    el.setPointerCapture(e.pointerId); el.classList.add('dragging')
  })
  el.addEventListener('pointermove', e => {
    if (!s) return
    const dx = e.clientX - s.x, dy = e.clientY - s.y, dt = Math.max(1, e.timeStamp - s.t)
    s.vx = 0.7 * (dx - s.dx) / dt + 0.3 * s.vx; s.vy = 0.7 * (dy - s.dy) / dt + 0.3 * s.vy
    s.dx = dx; s.dy = dy; s.t = e.timeStamp
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 16}deg)`
    showDrag(el, dx, dy)
  })
  const end = e => {
    if (!s) return
    const held = e.timeStamp - s.t > 100 // paused before letting go: not a flick
    const { dx, dy } = s, vx = held ? 0 : s.vx, vy = held ? 0 : s.vy
    s = null
    el.classList.remove('dragging')
    if (Math.hypot(dx, dy) < TAP_SLOP) { el.style.transform = ''; showDrag(el, 0, 0); return showDetails(true) } // a tap, not a swipe
    const flickX = Math.abs(vx) > FLICK_SPEED && Math.abs(dx) > 40
    if (-dy > Math.abs(dx) && (dy < -SWIPE_DIST || (vy < -FLICK_SPEED && dy < -40))) return fling('maybe', dx, dy)
    if (dx > SWIPE_DIST || (flickX && vx > 0)) return fling('yes', dx, dy)
    if (dx < -SWIPE_DIST || (flickX && vx < 0)) return fling('no', dx, dy)
    el.style.transform = ''; showDrag(el, 0, 0) // spring back
  }
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end)
}
function fling(v, dx = 0, dy = 0) {
  const el = $('#big'); if (!el || el.dataset.flung) return
  el.dataset.flung = '1'
  const id = el.dataset.id
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return vote(id, v)
  el.querySelector(`[data-stamp="${v}"]`).style.opacity = 1
  $('#stack').style.setProperty('--p', 1)
  const side = v === 'yes' ? 1 : -1
  el.classList.add('flying')
  el.style.transform = v === 'maybe'
    ? `translate(${dx}px, ${-window.innerHeight - 200}px)`
    : `translate(${side * (window.innerWidth + 300)}px, ${dy + 60}px) rotate(${side * 30}deg)`
  setTimeout(() => vote(id, v), 280)
}
function decideTop(v) { if ($('#big')) fling(v) }
function undo() {
  const h = state.history.pop(); if (!h) return
  const l = state.listings.find(x => x.id === h.id); if (!l) return
  const cur = l[state.who + '_vote']
  state.back = h.v // the card flies back in from the side it left
  l[state.who + '_vote'] = h.prev; render()
  post({ action: 'vote', id: h.id, who: state.who, vote: h.prev }).then(j => { if (!j.ok) throw 0 })
    .catch(() => { l[state.who + '_vote'] = cur; toast('Undo didn’t save.'); render() })
}
let toastT
function toast(msg, ms = 4000) { // ms = 0 keeps it up until the next toast
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t) }
  t.textContent = msg; clearTimeout(toastT); if (ms) toastT = setTimeout(() => t.remove(), ms)
}

document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
  if (state.sheet) {
    if (e.key === 'Escape') { e.preventDefault(); closeSheet() }
    else if (e.key === 'ArrowLeft' && state.sheet.prev) { e.preventDefault(); goSheet(state.sheet.prev) }
    else if (e.key === 'ArrowRight' && state.sheet.next) { e.preventDefault(); goSheet(state.sheet.next) }
    return
  }
  if (route() !== 'swipe') return
  if (e.key === 'ArrowRight') { e.preventDefault(); decideTop('yes') }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); decideTop('no') }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); decideTop('maybe') }
  else if (e.key.toLowerCase() === 'u') undo()
})
window.addEventListener('hashchange', () => {
  const r = route()
  state.sheetPushed = lastRoute === 'inspections' && r.startsWith('inspections/')
  lastRoute = r
  render()
})
// Pick up the other person's votes when the app comes back into view.
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.key && state.fetchedAt && Date.now() - state.fetchedAt > 60000) load() })

takeImport()
render()
if (state.key) load()
