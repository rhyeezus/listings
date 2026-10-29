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
  inspFilter: 'in', // the Inspections page shows: 'in' (all still in), 'both' (both yes) or 'fav' (favourites)
  inspPast: false, // the Inspections page lists past inspections (Past) instead of today's and upcoming ones, until you leave it
  history: [],
  back: '', // direction of the last undone vote, so its card can fly back in
  fetchedAt: null,
  scan: null, // the last Domain scan to reach the sheet: { at, found, added, updated, gone, goneChecked }
  keep: new Map(), // listings opened on the inspections view -> whether they were voted out then: each stays in that list, whatever the vote, until you leave the view
  sheet: null, // the open inspection ad sheet: { row, prev, next }
  card: null, // the opened swipe card: { l }
  overlayPushed: false, // the sheet or card was opened from its page, so closing it can go back in history
  focusSel: '', // what to put focus back on once the sheet or card closes
  pendingVote: '', // a vote made on the opened card, sent off once the deck is back
  gateError: '', // shown on the passcode page after a passcode is turned down
  pic: {}, // listing id -> the photo its card is showing
  mapFilter: 'in', // which listings the map shows (MAP_FILTERS)
  mapDay: '', // '' or a day ("Wednesday 28 Oct") to show only that day's inspections
  mapFocus: '', // a listing to close in on when the map next draws ("See on the map")
  picks: {}, // the day planner's ticks: "<id>|<inspection as written>" -> going or not, shared through the sheet's Plan tab
  sharedPlan: false, // the back end keeps the ticks (older back ends don't: then they stay on this device)
}

const app = document.getElementById('app')
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const money = n => (n === '' || n == null) ? '' : '$' + Number(n).toLocaleString('en-AU')

/* ---------- data shaping ---------- */
function parseInspections(text) {
  // "Wed 28 Oct, 4:45 - 5pm; Thu 29 Oct, 12:30 - 12:45pm". past_inspections adds the year ("Wed 28 Oct 2026, 4:45 - 5pm"),
  // which the label leaves out.
  const now = new Date()
  return String(text || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const label = s.replace(/^(\w{3} \d{1,2} \w{3}) \d{4},/, '$1,')
    const m = s.match(/^\w{3} (\d{1,2}) (\w{3})(?: (\d{4}))?,\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
    if (!m) return { label, start: null, end: null }
    const [, d, mon, y, h, mi, ap1, h2, mi2, ap2] = m
    const minutes = (hr, min, ap) => ((+hr % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0)) * 60 + +(min || 0)
    const endAt = minutes(h2, mi2, ap2)
    let startAt = minutes(h, mi, ap1 || ap2) // no am/pm on the start: the end's
    if (!ap1 && startAt > endAt) startAt -= 12 * 60 // "11:45 - 12:05pm" starts in the morning
    // No year: the closest such day to today (in January, December's times are last year's).
    let year = +y || now.getFullYear()
    if (!y && MONTHS[mon] < now.getMonth() - 6) year++
    else if (!y && MONTHS[mon] > now.getMonth() + 6) year--
    return { label, start: new Date(year, MONTHS[mon], +d, 0, startAt), end: new Date(year, MONTHS[mon], +d, 0, endAt) }
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
  // The uncropped version of each photo for the full-screen viewer, matched on Domain's file name (photos_large
  // comes from the listing page's gallery); a photo with no match uses its card-sized version.
  const large = String(l.photos_large || '').split(/\s+/).filter(Boolean), file = u => u.slice(u.lastIndexOf('/') + 1)
  l.big = l.photos.map(u => large.find(b => file(b) === file(u)) || u)
  l.thumb = l.photo_url || l.photos[0] || ''
  // Map position, ignoring anything outside Melbourne (the geocoder sometimes lands on "Australia").
  l.geo = +l.lat < -37.5 && +l.lat > -38.3 && +l.lng > 144.5 && +l.lng < 145.6 ? [+l.lat, +l.lng] : null
  // Inspection times: the ones listed now, then any a rescan has since dropped once they'd happened (past_inspections).
  const listed = parseInspections(l.inspections), at = new Set(listed.map(i => i.start?.getTime()))
  l.insp = listed.concat(parseInspections(l.past_inspections).filter(i => i.start && !at.has(i.start.getTime())))
  l.score = score(l)
  // The day it was added, as yyyy-mm-dd. Some rows hold the sheet's day number instead (days since 30 Dec 1899,
  // 46322 = 27 Oct 2026), which would otherwise sort ahead of every real date.
  if (/^\d{5}$/.test(String(l.added_on))) l.added_on = new Date(Date.UTC(1899, 11, 30) + l.added_on * 864e5).toISOString().slice(0, 10)
  l.isNew = l.added_on && (Date.now() - new Date(l.added_on).getTime()) < 3 * 864e5
  // The Enquired tick: the day either of you ticked it (yyyy-mm-dd) and who; a tick box put in the sheet by hand is TRUE.
  l.enquired = l.enquired === true ? 'yes' : String(l.enquired || '').trim()
  return l
}
const upcoming = l => l.insp.filter(i => i.start && i.end > new Date()) // not over yet: one on now still counts
const dayOf = d => d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' }) // "Wednesday 28 Oct"
const clockOf = d => (d.getHours() % 12 || 12) + (d.getMinutes() ? ':' + String(d.getMinutes()).padStart(2, '0') : '') + (d.getHours() < 12 ? 'am' : 'pm') // "9:45am"
const nextInsp = l => upcoming(l)[0] || null
const lastInsp = l => l.insp.filter(i => i.start && i.end <= new Date()).sort((a, b) => b.start - a.start)[0] || null // the latest one that's over
const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const PAST_DAYS = 30 // how far back the Inspections page's Past list goes
const myVote = l => l[state.who + '_vote'] || ''
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
// "28 Oct · you": when the Enquired tick went on, and who ticked it.
function enqWhen(l) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(l.enquired)
  return [m && new Date(+m[1], m[2] - 1, +m[3]).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
    VOTERS[l.enquired_by] && (l.enquired_by === state.who ? 'you' : VOTERS[l.enquired_by])].filter(Boolean).join(' · ')
}
const otherKey = () => state.who === 'rhys' ? 'partner' : 'rhys'
// A vote of "maybe" in the sheet is a Favourite (the star): a yes and then some. It counts as a yes everywhere,
// and starred listings get a badge and come first.
const VOTE_LABEL = { yes: 'Yes', maybe: 'Favourite', no: 'No' }
const keen = v => v === 'yes' || v === 'maybe'
const favs = l => [l.rhys_vote, l.partner_vote].filter(v => v === 'maybe').length // how many of you starred it
const star = l => favs(l) ? '★ ' : ''
function combined(l) {
  if (l.status === 'gone') return 'gone'
  const a = l.rhys_vote, b = l.partner_vote
  if (a === 'no' || b === 'no') return 'out'
  if (keen(a) && keen(b)) return 'both'
  if (a || b) return 'split' // one of you is keen, the other hasn't voted
  return 'none'
}
// The votes alone, whether or not the place has since gone (for the Inspections page's Past list).
const votedOut = l => l.rhys_vote === 'no' || l.partner_vote === 'no'
const bothKeen = l => keen(l.rhys_vote) && keen(l.partner_vote)
// Your No / Favourite / Yes buttons; attr is the data attribute the view wires up.
const voteButtons = (attr, v) => ['no', 'maybe', 'yes'].map(k =>
  `<button type="button" class="${k} ${v === k ? 'on' : ''}" data-${attr}="${k}" aria-pressed="${v === k}">${icon(k)}${VOTE_LABEL[k]}</button>`).join('')
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
    state.sharedPlan = !!j.plan
    state.picks = j.plan || store.get('rs-picks', {})
    state.scan = j.scan || null
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
// A day planner tick: shown straight away, saved to the sheet's Plan tab for both of you (or, with an older back end,
// kept on this device); put back if the save fails.
async function pick(key, going) {
  const was = state.picks[key]
  state.picks[key] = going
  render()
  if (!state.sharedPlan) return store.set('rs-picks', state.picks)
  try {
    const j = await post({ action: 'pick', inspection: key, going, who: state.who }) // (key is the passcode's field)
    if (!j.ok) throw new Error(j.error)
  } catch {
    if (was === undefined) delete state.picks[key]; else state.picks[key] = was
    toast('That tick didn’t save. Try again.')
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
// The Enquired tick (box is its checkbox): shared by both of you, shown straight away and saved to the sheet with the
// day and who ticked it; put back if the save fails. It updates its own label rather than re-rendering, so a map
// pin's card stays open.
async function enquire(box) {
  const l = state.listings.find(x => x.id === box.dataset.enq)
  if (!l) return
  const on = box.checked, was = [l.enquired, l.enquired_by], label = box.closest('.enq')
  const show = ([at, by]) => {
    l.enquired = at; l.enquired_by = by; box.checked = !!at
    label.classList.toggle('on', !!at); label.title = at ? 'Enquired ' + enqWhen(l) : ''
    const when = label.querySelector('.enq-when'); if (when) when.textContent = enqWhen(l)
  }
  show(on ? [isoDay(new Date()), state.who] : ['', ''])
  try {
    const j = await post({ action: 'vote', id: l.id, who: state.who, enquired: on })
    if (!j.ok) throw new Error(j.error)
  } catch {
    show(was)
    toast('That tick didn’t save. Try again.')
  }
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
// When the scheduled Domain scan runs: a Claude scheduled task on Rhys's Mac (README, Rescans).
const SCAN_TIMES = '7am and 6pm'
// When the last Domain scan reached the sheet, short for the button ("7:04am" today, "yesterday", "Mon" this
// week, else "28 Oct") or long for the toast ("today 7:04am", "Mon 6:02pm").
function scanWhen(at, long) {
  const d = new Date(at), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 864e5)
  const day = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? d.toLocaleDateString('en-AU', { weekday: 'short' }) : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
  return long ? `${day} ${clockOf(d)}` : days <= 0 ? clockOf(d) : day
}
const scanText = s => `Last scan ${scanWhen(s.at, true)}: ${s.found} listings, ${s.added} new, ${s.gone} marked gone${s.goneChecked ? '' : ' (gone check skipped: the scan looked partial)'}.`
async function rescan() {
  const b = $('#rescan'); if (b) b.disabled = true
  try {
    const j = await post({ action: 'rescan' })
    if (j.ok) { toast(`Rescan done: ${j.added} new, ${j.gone} gone.`); await load() }
    // No Domain API keys (it's a paid plan), so Domain is scanned in a browser on a schedule (scripts/domain-rescan.js).
    else if (j.error === 'not_configured') {
      toast(`Domain is scanned at ${SCAN_TIMES} from Rhys’s Mac. ${state.scan ? scanText(state.scan) : 'No scan has reached the sheet yet.'} Alert emails add new listings hourly too.`, 10000)
      await load()
    }
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
// The photo's corner badges: Gone or New, and ★ when either of you starred it.
function badge(l) {
  const b = (l.status === 'gone' ? '<span class="badge gone">Gone</span>' : l.isNew ? '<span class="badge">New</span>' : '')
    + (favs(l) ? `<span class="badge fav">★ ${favs(l) === 2 ? 'Both favourites' : 'Favourite'}</span>` : '')
  return b ? `<span class="badges">${b}</span>` : ''
}
// A listing's photos as a carousel, used on swipe cards, grid cards and the inspection sheet: flick sideways on
// a phone, arrows with a mouse, with a counter and dots. Photos off to the side load as they come near.
// state.pic remembers which photo each listing is on, across views and re-renders (wirePics scrolls back to it).
// controls = false (the cards behind the top swipe card) shows just that photo.
function pics(l, { eager = false, controls = true } = {}) {
  const ps = l.photos, n = ps.length, at = Math.min(state.pic[l.id] || 0, Math.max(n - 1, 0))
  const ph = `<div class="ph">${esc(l.suburb)}<span>No photo yet</span></div>`
  const img = (u, j) => `<img src="${esc(u)}" alt="${n > 1 ? `Photo ${j + 1} of ${n}` : ''}" ${eager && j === at ? '' : 'loading="lazy"'} draggable="false" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
  if (!controls || n < 2) return `<div class="pics" data-id="${esc(l.id)}">${ph}${n ? img(ps[at], at) : ''}${badge(l)}</div>`
  return `<div class="pics" data-id="${esc(l.id)}">${ph}
    <div class="pics-track">${ps.map(img).join('')}</div>
    ${badge(l)}
    <button class="gal-arrow prev" type="button" data-step="-1" aria-label="Previous photo">‹</button>
    <button class="gal-arrow next" type="button" data-step="1" aria-label="Next photo">›</button>
    <span class="gal-n" aria-live="polite">${at + 1} / ${n}</span>
    <div class="gal-dots" aria-hidden="true">${ps.map((_, j) => `<i${j === at ? ' class="on"' : ''}></i>`).join('')}</div>
  </div>`
}
// The ad's own description, cut to a few lines until "Read more" (clamp = false shows it all).
function about(l, clamp = true) {
  const d = String(l.description || '').trim()
  if (!d) return ''
  const long = clamp && d.length > 320, id = `about-${esc(l.id)}`
  return `<div class="about"><div class="lbl">About this place</div>
    <p class="about-text${long ? ' clamp' : ''}" id="${id}">${esc(d)}</p>
    ${long ? `<button class="ghost about-more" type="button" aria-expanded="false" aria-controls="${id}">Read more</button>` : ''}
  </div>`
}
function votesLine(l) {
  return `<div class="votes">${Object.entries(VOTERS).map(([k, name]) => {
    const v = l[k + '_vote'] || ''
    return `<span class="vote ${v}"><b>${k === state.who ? 'You' : name}</b> ${v === 'maybe' ? '★ ' : ''}${v ? VOTE_LABEL[v] : 'Not yet'}</span>`
  }).join('')}</div>`
}
// The Enquired tick on every card: whether either of you has asked the agent about the place. short (the swipe card and
// map pin card) leaves out when and who, which show on hover; live = false (the cards behind the top swipe card) keeps it out of the tab order.
function enquiredBox(l, { short = false, live = true } = {}) {
  const on = !!l.enquired
  return `<label class="enq${on ? ' on' : ''}" title="${on ? 'Enquired ' + esc(enqWhen(l)) : ''}"><input type="checkbox" data-enq="${esc(l.id)}" ${on ? 'checked' : ''} ${live ? '' : 'tabindex="-1"'}>Enquired${short ? '' : `<span class="enq-when">${esc(enqWhen(l))}</span>`}</label>`
}
function inspBlock(l) {
  const n = nextInsp(l), last = !n && lastInsp(l)
  if (last) return `<div class="insp none"><div class="lbl">Last inspection</div><div class="when">${esc(last.label)}. None coming up.</div></div>`
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
// Inspection, notes, votes, the Enquired tick, agency and links: shared by grid cards, the swipe card's details panel and the inspection
// sheet. lead replaces the opening inspection block (the sheet shows the row's own inspection and the description).
function detailsBody(l, lead = inspBlock(l)) {
  const other = l[otherKey() + '_note']
  const meta = [l.agency, l.available && `Available ${String(l.available).replace(/^Available /i, '').toLowerCase()}`].filter(Boolean)
  return `${lead}
    ${l.notes ? `<p class="note">${esc(l.notes)}</p>` : ''}
    ${other ? `<p class="note"><b>${VOTERS[otherKey()]}:</b> ${esc(other)}</p>` : ''}
    ${votesLine(l)}
    ${enquiredBox(l)}
    <div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>
    ${links(l)}`
}
// A grid card: the inspection sheet's layout (photos, rent, address, features, inspection, description, details).
function cardBody(l) {
  return `${pics(l)}<div class="inner">
    ${rentLine(l)}
    <div><div class="addr">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
    <div class="chips">${chips(l)}</div>
    ${detailsBody(l, inspBlock(l) + about(l))}
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

// One card in the swipe stack: photos, rent, address, features, the next inspection and the Enquired tick. Tapping it (or Details)
// opens the whole card (viewCard). i = 0 is the top (interactive) card; the ones behind are decoration.
function swipeCard(l, i, back) {
  const top = i === 0
  const n = nextInsp(l), last = !n && lastInsp(l)
  return `<article class="swipe-card${top ? ' top' : ''}${top && back ? ' back-' + back : ''}" style="--i:${i}" ${top ? `id="big" data-id="${esc(l.id)}"` : 'aria-hidden="true"'}>
    ${pics(l, { eager: i < 2, controls: top })}
    ${top ? '<span class="stamp yes" data-stamp="yes">Yes</span><span class="stamp no" data-stamp="no">Nope</span><span class="stamp maybe" data-stamp="maybe">Favourite</span>' : ''}
    <div class="sc-info">
      <div class="sc-head">${rentLine(l)}${top ? '<button class="ghost sc-more" id="more" type="button">Details</button>' : ''}</div>
      <div class="sc-row"><div><div class="addr">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>${enquiredBox(l, { short: true, live: top })}</div>
      <div class="chips">${chips(l)}</div>
      <div class="sc-when${n ? '' : ' none'}">${n ? `<span class="lbl">Inspect</span> ${esc(n.label)}` : last ? `<span class="lbl">Last inspection</span> ${esc(last.label.split(', ')[0])}, ${clockOf(last.start)}` : 'No inspection listed'}</div>
    </div>
  </article>`
}
// A listing opened up as a whole card, in the inspection sheet's layout: every photo and detail, with the vote
// buttons. Opened from the swipe deck (from = 'swipe', the top card) or a map pin (from = 'map'). Closing it
// (×, the backdrop, Escape, back) returns there; voting closes it too (and, on the deck, sends the card off).
function viewCard(l, opening, from) {
  state.card = { l, from }
  const v = myVote(l)
  return `<div class="sheet-back" id="sheet-back"></div>
    <section class="sheet full${opening ? ' opening' : ''}" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">
      <button class="sheet-x" id="sheet-x" type="button" aria-label="Close">${icon('no')}</button>
      <div class="sheet-body">${pics(l, { eager: true })}<div class="inner">
        ${rentLine(l)}
        <div><div class="addr" id="sheet-title">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
        <div class="chips">${chips(l)}</div>
        ${detailsBody(l, inspBlock(l) + about(l, false) + locMap(l))}
      </div></div>
      <div class="sheet-foot">
        <div class="mine big" role="group" aria-label="Your vote">${voteButtons('cv', v)}</div>
      </div>
    </section>`
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
      <button class="act small maybe" data-act="maybe" type="button" aria-label="Favourite (up arrow)" title="Favourite (↑)">${icon('maybe')}</button>
      <button class="act yes" data-act="yes" type="button" aria-label="Yes (right arrow)" title="Yes (→)">${icon('yes')}</button>
    </div>
  </section>`
}
// The Inspections page's rows, one per inspection: today's and upcoming ones, earliest first (today's stay all day,
// marked on now or done), or (Past) the ones before today from the last PAST_DAYS days, newest day first, places
// since gone included. key ("<id>/<start ms>", id URL-encoded) is the row's address in the #inspections/<key> hash
// that opens its sheet. out: either of you said no, so it's listed under Voted out (the filter only applies to the
// rest); a listing opened on this visit stays in the list it was in.
function inspRows() {
  const rows = [], now = new Date(), today = dayStart(now), past = state.inspPast, from = new Date(today - PAST_DAYS * 864e5)
  ;(past ? state.listings : active()).forEach(l => {
    const c = combined(l), kept = state.keep.has(l.id), out = kept ? state.keep.get(l.id) : votedOut(l)
    const hidden = (state.inspFilter === 'both' && !bothKeen(l)) || (state.inspFilter === 'fav' && !favs(l))
    if (!out && !kept && hidden) return
    l.insp.filter(i => i.start && (past ? i.start < today && i.start >= from : i.start >= today)).forEach(i => rows.push({ l, i, c, out,
      key: `${encodeURIComponent(l.id)}/${i.start.getTime()}`, day: dayOf(i.start),
      when: past ? '' : i.end <= now ? 'done' : i.start <= now ? 'now' : '' }))
  })
  const day = r => dayStart(r.i.start).getTime()
  return rows.sort((a, b) => (past ? day(b) - day(a) : 0) || a.i.start - b.i.start || favs(b.l) - favs(a.l) || (b.c === 'both') - (a.c === 'both'))
}
function viewInspections(rows) {
  const past = state.inspPast
  const head = `<div class="toolbar"><div><h2>Inspections</h2><p class="sub">${past ? `Inspections from the last ${PAST_DAYS} days, newest first.` : 'Today’s and upcoming inspections, grouped by day.'} Tap one to see the ad and vote. Places either of you said no to are listed separately, under Voted out.</p></div>
    <div class="segs"><div class="seg" role="group" aria-label="When">${[['', 'Upcoming'], ['past', 'Past']].map(([k, n]) => `<button type="button" data-iw="${k}" aria-pressed="${past === !!k}">${n}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Show">${[['in', 'All still in'], ['both', 'Both yes'], ['fav', '★ Favourites']].map(([k, n]) => `<button type="button" data-if="${k}" aria-pressed="${state.inspFilter === k}">${n}</button>`).join('')}</div></div></div>`
  const still = rows.filter(r => !r.out), out = rows.filter(r => r.out)
  const empty = past ? [`None of the places you’ve both said yes to had an inspection in the last ${PAST_DAYS} days.`, `None of your favourites had an inspection in the last ${PAST_DAYS} days.`, `No inspections in the last ${PAST_DAYS} days.`]
    : ['Nothing you’ve both said yes to has an inspection coming up.', 'None of your favourites has an inspection coming up.', 'No upcoming inspections.']
  return head + (still.length ? `<div class="run">${runDays(still, true)}</div>`
    : `<p class="empty">${{ both: empty[0], fav: empty[1] }[state.inspFilter] || empty[2]}</p>`)
    + (out.length ? `<section class="run-out" aria-labelledby="out-title"><h3 id="out-title">Voted out <span class="sub">${out.length}</span></h3>
      <p class="sub">Inspections for places either of you said no to, in case you want to look again.</p><div class="run">${runDays(out, false)}</div></section>` : '')
}
// One list's inspections grouped by day. voting: each day gets a count of the ones still to vote on, and a "Vote on"
// button that opens the sheet at the first of them.
function runDays(rows, voting) {
  const days = new Map()
  rows.forEach(r => { if (!days.has(r.day)) days.set(r.day, []); days.get(r.day).push(r) })
  let html = ''
  days.forEach((run, d) => {
    const open = run.filter(r => !myVote(r.l)), start = open[0] || run[0]
    const wd = run[0].i.start.toLocaleDateString('en-AU', { weekday: 'long' })
    html += `<div class="day"><span class="day-d">${esc(d)}</span>
      <span class="day-n">${run.length} inspection${run.length === 1 ? '' : 's'}${voting ? ` · ${open.length ? `${open.length} to vote on` : 'all voted'}` : ''}</span>
      ${voting ? `<a class="day-go" href="#inspections/${esc(start.key)}">${open.length ? 'Vote on' : 'Go through'} ${esc(wd)}</a>` : ''}</div>`
    run.forEach(({ l, i, c, key, when }) => {
      html += `<a class="row${when ? ' ' + when : ''}" href="#inspections/${esc(key)}" data-key="${esc(key)}" data-c="${c}">
        <span class="t">${esc(i.label.split(', ')[1] || '')}${when ? ` <span class="tag ${when}">${when === 'now' ? 'On now' : 'Done'}</span>` : ''}</span>
        <span class="thumb">${l.thumb ? `<img src="${esc(l.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
        <span class="a"><b>${star(l)}${esc(l.address)}</b><br><span>${esc(l.suburb)} · ${money(l.price)}/wk${c === 'gone' ? ' · <span class="tag gone">Gone</span>' : ''}</span></span>
        <span class="v">${Object.entries(VOTERS).map(([k, n]) => { const v = l[k + '_vote']; return `<span class="vote ${v || ''}" title="${n}">${k === state.who ? 'You' : n}: ${v ? VOTE_LABEL[v].toLowerCase() : '–'}</span>` }).join('')}</span>
      </a>`
    })
  })
  return html
}
// The ad for one inspection row, with your vote and prev/next through that day's inspections (in the same list:
// still in, or voted out). A bottom sheet on phones, a side panel on wider screens.
function viewSheet(rows, key, opening) {
  const row = rows.find(x => x.key === key) || rows.find(x => x.key.split('/')[0] === key.split('/')[0])
  if (!row) return ''
  const run = rows.filter(x => x.day === row.day && x.out === row.out), n = run.indexOf(row)
  state.sheet = { row, run, n, prev: run[n - 1], next: run[n + 1] }
  const { l, i } = row, v = myVote(l)
  const when = `<div class="insp"><div class="lbl">This inspection</div><div class="when">${esc(i.label)}</div></div>`
  return `<div class="sheet-back" id="sheet-back"></div>
    <section class="sheet${opening ? ' opening' : ''}" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">
      <button class="sheet-x" id="sheet-x" type="button" aria-label="Close">${icon('no')}</button>
      <div class="sheet-body">${pics(l, { eager: true })}<div class="inner">
        ${rentLine(l)}
        <div><div class="addr" id="sheet-title">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
        <div class="chips">${chips(l)}</div>
        ${detailsBody(l, when + about(l) + locMap(l))}
      </div></div>
      <div class="sheet-foot">
        <div class="mine big" role="group" aria-label="Your vote">${voteButtons('sv', v)}</div>
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
  ['fav', '★ Favourites', l => favs(l) > 0 && !['out', 'gone'].includes(combined(l))],
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
    return favs(b) - favs(a) || b.score - a.score || a.price - b.price // Best match: favourites first
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
          <div class="mine" role="group" aria-label="Your vote">${voteButtons('v', v)}</div>
          <textarea id="note-${esc(l.id)}" data-note="${esc(l.id)}" placeholder="Your notes">${esc(l[state.who + '_note'] || '')}</textarea>
        </div></article>`
    }).join('')}</div>` : '<p class="empty">Nothing here.</p>'}`
}

/* ---------- map ---------- */
// Every listing with a position as a pin, coloured by where your votes stand: price on the pin, or the
// inspection time once a day is picked (to plan a run). A pin opens a mini card; Open shows the whole card
// (#map/<id>) to vote from. Leaflet and the map tiles only load the first time the Map tab opens.
const MAP_FILTERS = [
  ['in', 'Still in', l => combined(l) !== 'out'],
  ['both', 'Both yes', l => combined(l) === 'both'],
  ['fav', '★ Favourites', l => favs(l) > 0 && combined(l) !== 'out'],
  ['mine', 'Needs my vote', l => !myVote(l)],
  ['all', 'Everything', () => true],
]
// Days with an upcoming inspection, soonest first: [day, inspections that day].
function mapDays() {
  const days = new Map()
  active().flatMap(upcoming).sort((a, b) => a.start - b.start).forEach(i => { const d = dayOf(i.start); days.set(d, (days.get(d) || 0) + 1) })
  return [...days]
}
// The listings the map shows, each with its inspection on the picked day (if a day is picked).
function mapItems() {
  const f = (MAP_FILTERS.find(x => x[0] === state.mapFilter) || MAP_FILTERS[0])[2]
  return active().filter(f).map(l => ({ l, insp: state.mapDay ? upcoming(l).find(i => dayOf(i.start) === state.mapDay) : null }))
    .filter(x => !state.mapDay || x.insp)
}
/* the day planner: the Map with a day picked */
// That day's inspections in time order, each with whether you're going (ticked in state.picks, shared by both of
// you; untouched, it's the places either of you said yes to that neither said no to, so it starts the same on both
// phones) and how it sits with the ones you're going to: overlapping one (clash), or starting too soon after the
// last one to get there (tight).
function planRows() {
  const rows = mapItems().filter(x => x.insp?.end).sort((a, b) => a.insp.start - b.insp.start)
    .map(x => ({ ...x, key: `${x.l.id}|${x.insp.label}` }))
  let n = 0
  rows.forEach(r => {
    const votes = [r.l.rhys_vote, r.l.partner_vote]
    r.on = r.key in state.picks ? state.picks[r.key] : votes.some(keen) && !votes.includes('no')
    if (r.on) r.n = ++n
  })
  rows.forEach((r, i) => {
    r.clash = rows.find(o => o !== r && o.on && o.insp.start < r.insp.end && r.insp.start < o.insp.end)
    const prev = rows.slice(0, i).reverse().find(o => o.on && o.insp.end <= r.insp.start)
    if (prev && prev.l.geo && r.l.geo) {
      r.from = prev; r.drive = driveMins(prev.l.geo, r.l.geo); r.gap = Math.round((r.insp.start - prev.insp.end) / 60000)
      r.tight = r.gap < r.drive
    }
  })
  return rows
}
// Minutes to drive between two places, roughly: the straight-line distance plus a third for the streets, at about
// 25 km/h (inner Melbourne), plus a few minutes to park and walk in.
function driveMins([lat1, lng1], [lat2, lng2]) {
  const rad = x => x * Math.PI / 180, dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1)
  const km = 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2))
  return Math.round(km * 1.35 / 25 * 60 + 3)
}
function planFlag(r) {
  if (r.clash) return `<span class="flag bad">Clashes with ${esc(r.clash.l.address)}</span>`
  if (r.tight) return `<span class="flag warn">Tight: about ${r.drive} min from ${esc(r.from.l.address)}, ${r.gap} min gap</span>`
  if (r.from && r.on) return `<span class="flag ok">About ${r.drive} min from ${esc(r.from.l.address)}, ${r.gap - r.drive} min spare</span>`
  if (!r.l.geo) return '<span class="flag">No map location yet</span>'
  return ''
}
function viewPlan(rows) {
  const going = rows.filter(r => r.on).length
  return `<section class="plan" aria-labelledby="plan-title">
    <div class="plan-head">
      <div><h3 id="plan-title">${esc(state.mapDay)}</h3><p class="sub">${rows.length} inspection${rows.length === 1 ? '' : 's'} · going to ${going}</p></div>
      <button class="primary plan-ics" id="plan-ics" type="button" ${going ? '' : 'disabled'}>Add ${going || ''} to calendar</button>
    </div>
    ${rows.length ? `<ol class="plan-list">${rows.map(r => `<li class="plan-row${r.on ? ' on' : ''}">
      <input type="checkbox" class="plan-pick" data-pick="${esc(r.key)}" ${r.on ? 'checked' : ''} aria-label="Going to ${esc(r.l.address)} at ${clockOf(r.insp.start)}">
      <span class="plan-n" aria-hidden="true">${r.on ? r.n : ''}</span>
      <div class="plan-body">
        <div class="plan-time">${clockOf(r.insp.start)} – ${clockOf(r.insp.end)}</div>
        <button type="button" class="plan-addr" data-focus="${esc(r.l.id)}"><i class="dot ${combined(r.l)}"></i>${star(r.l)}${esc(r.l.address)}</button>
        <div class="sub">${esc(r.l.suburb)} · ${money(r.l.price)}/wk</div>
        ${planFlag(r)}
      </div>
    </li>`).join('')}</ol>` : '<p class="empty">No inspections that day with these filters.</p>'}
    <p class="sub plan-note">${state.sharedPlan ? 'Ticks are shared: you both see the same run. ' : ''}Drive times are rough guesses from the distance between places.</p>
  </section>`
}
// The ticked inspections as a calendar file (.ics): times in UTC, each with the address and the listing's link.
function downloadIcs(rows) {
  const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const text = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')
  const fold = line => line.length <= 73 ? line : line.match(/.{1,73}/g).join('\r\n ')
  const events = rows.flatMap(({ l, insp }) => ['BEGIN:VEVENT', `UID:${l.id}-${insp.start.getTime()}@shortlist`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(insp.start)}`, `DTEND:${stamp(insp.end)}`, `SUMMARY:${text(`Inspect ${l.address}, ${l.suburb}`)}`,
    `LOCATION:${text(`${l.address}, ${l.suburb} VIC`)}`, `DESCRIPTION:${text(`${money(l.price)} per week${l.agency ? `, ${l.agency}` : ''}\n${l.listing_url}`)}`,
    `URL:${l.listing_url}`, 'END:VEVENT'])
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shortlist//Inspections//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n'
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
  a.download = `inspections-${state.mapDay.toLowerCase().replace(/\W+/g, '-')}.ics`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}
// A row's address: show its pin on the map, with the mini card open.
function focusPin(id) {
  ensureMap().then(ui => {
    const m = ui.markers?.[id]; if (!m) return
    ui.map.panTo(m.getLatLng()); m.openPopup()
    $('#map-slot')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}
function viewMap() {
  const days = mapDays()
  if (state.mapDay && !days.some(([d]) => d === state.mapDay)) state.mapDay = '' // that day has passed
  const items = mapItems(), placed = items.filter(x => x.l.geo).length
  const key = [['both', 'Both yes'], ['split', 'Talk about it'], ['none', 'Not voted yet'], ...(state.mapFilter === 'all' ? [['out', 'Out']] : [])]
  return `<div class="toolbar">
      <div class="seg" role="group" aria-label="Show">${MAP_FILTERS.map(([k, n]) => `<button type="button" data-mf="${k}" aria-pressed="${state.mapFilter === k}">${n}</button>`).join('')}</div>
      <label class="sub map-day">Inspecting
        <select id="map-day"><option value="">Any day</option>${days.map(([d, n]) => `<option value="${esc(d)}" ${state.mapDay === d ? 'selected' : ''}>${esc(d)} (${n})</option>`).join('')}</select>
      </label>
    </div>
    ${state.mapDay ? `<div class="map-split"><div class="map" id="map-slot"></div>${viewPlan(planRows())}</div>` : '<div class="map" id="map-slot"></div>'}
    <div class="map-foot">
      <div class="legend">${key.map(([c, n]) => `<span><i class="${c}"></i>${n}</span>`).join('')}</div>
      <span class="sub">${placed} on the map${items.length > placed ? ` · ${items.length - placed} without a location yet` : ''}</span>
    </div>`
}
// Leaflet loads once, the first time any map is shown (the Map tab or a listing's Location map).
let leafletReady = null
const loadLeaflet = () => leafletReady ||= Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([m]) => m.default)
// OpenStreetMap's own tiles (no key needed; darkened with a filter in dark mode, in the CSS).
const osmTiles = L => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
})
// A listing's pin: its label (price or time) coloured by where the votes stand.
const pinIcon = (L, l, label, extra = '') => L.divIcon({ className: '', html: `<span class="pin ${combined(l)}${favs(l) ? ' fav' : ''} ${extra}">${esc(star(l) + label)}</span>`, iconSize: null, popupAnchor: [0, -30] })
// The map ({ L, el, map, far, pins, fitFor }) is made once, by the first render that needs it (later renders
// share the same promise, even while it loads), and moved into each render's #map-slot.
let mapReady = null
const ensureMap = () => mapReady ||= makeMap()
async function makeMap() {
  const L = await loadLeaflet()
  const el = document.createElement('div'); el.className = 'map-canvas'
  const map = L.map(el, { zoomSnap: 0.5 }).setView([-37.87, 144.99], 13)
  osmTiles(L).addTo(map)
  // Zoomed out, the pins are dots (100-odd price labels would pile up); zoomed in to street level, or with a day
  // picked (only that day's few), they show their labels.
  const far = () => el.classList.toggle('far', map.getZoom() < 15 && !state.mapDay)
  map.on('zoomend', far)
  return { L, el, map, far, pins: L.layerGroup().addTo(map), fitFor: '' }
}
function placeMap() {
  ensureMap().then(ui => {
    const slot = $('#map-slot'); if (!slot) return // left the map while it loaded
    slot.appendChild(ui.el)
    ui.map.invalidateSize()
    drawPins(ui)
  }).catch(() => { mapReady = leafletReady = null; toast('The map didn’t load. Check your connection.') })
}
function drawPins(ui) {
  const { L, map, pins } = ui
  pins.clearLayers()
  const items = mapItems().filter(x => x.l.geo), markers = {}
  // With a day picked, the ones you're going to are numbered in order and joined up; the rest fade back.
  const plan = state.mapDay ? planRows() : [], planned = {}
  plan.forEach(r => { if (!planned[r.l.id] || r.on) planned[r.l.id] = r })
  items.forEach(({ l, insp }) => {
    const r = planned[l.id], label = insp ? clockOf(insp.start) : money(l.price)
    markers[l.id] = L.marker(l.geo, {
      icon: pinIcon(L, l, r?.on ? `${r.n} · ${label}` : label, r && !r.on ? 'skip' : ''),
      title: `${l.address}, ${l.suburb}`, riseOnHover: true, zIndexOffset: (r?.on ? 400 : 0) + favs(l) * 50 + ({ both: 300, split: 200, none: 100 }[combined(l)] || 0),
    }).bindPopup(() => pinCard(l, insp), { minWidth: 220, maxWidth: 240 }).addTo(pins)
  })
  const route = plan.filter(r => r.on && r.l.geo).map(r => r.l.geo)
  if (route.length > 1) L.polyline(route, { className: 'plan-line', interactive: false }).addTo(pins)
  ui.markers = markers
  // Fit the pins when the filter or day changes, not on every re-render (so a vote doesn't move the map).
  const key = state.mapFilter + '|' + state.mapDay
  if (ui.fitFor !== key && items.length) { map.fitBounds(L.latLngBounds(items.map(x => x.l.geo)), { padding: [40, 40], maxZoom: 15 }); ui.fitFor = key }
  // Arrived from a listing's "See on the map": close in on it, with its mini card open.
  const focus = state.mapFocus && markers[state.mapFocus]
  if (focus) { map.setView(focus.getLatLng(), 16); focus.openPopup() }
  state.mapFocus = ''
  ui.far()
}
// A listing's Location section (the inspection sheet and the opened card): a small map centred on it, which
// doesn't pan with a finger (so it can't trap the scroll) but has + and −, and a way into the full map.
function locMap(l) {
  if (!l.geo) return ''
  return `<div class="loc"><div class="lbl">Location</div>
    <div class="loc-map" data-id="${esc(l.id)}" role="img" aria-label="Map of ${esc(l.address)}, ${esc(l.suburb)}"></div>
    <button class="ghost loc-go" type="button" data-map="${esc(l.id)}">See on the map</button>
  </div>`
}
let miniMap = null // the open listing's Location map; removed before each render replaces it
function placeMiniMap() {
  const el = $('.loc-map'), l = el && state.listings.find(x => x.id === el.dataset.id)
  if (!l?.geo) return
  loadLeaflet().then(L => {
    if (!el.isConnected) return // re-rendered while Leaflet loaded
    miniMap = L.map(el, { dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false }).setView(l.geo, 15)
    osmTiles(L).addTo(miniMap)
    L.marker(l.geo, { icon: pinIcon(L, l, money(l.price)), interactive: false, keyboard: false }).addTo(miniMap)
  }).catch(() => { leafletReady = null })
}
// "See on the map": the Map tab, closed in on this listing (showing everything if the filters would hide it).
function showOnMap(id) {
  state.mapFocus = id
  if (!mapItems().some(x => x.l.id === id)) { state.mapFilter = 'all'; state.mapDay = '' }
  location.hash = '#map'
}
// The pin's mini card: photo, rent, address, inspection, votes and the Enquired tick, with Open for the whole card.
function pinCard(l, insp) {
  const n = insp || nextInsp(l), last = !n && lastInsp(l), el = document.createElement('div')
  el.className = 'pin-card'
  el.innerHTML = `${l.thumb ? `<img src="${esc(l.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="pin-body">
      <div class="pin-price">${money(l.price)}<small> /wk</small></div>
      <div><div class="pin-addr">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
      ${n ? `<div class="pin-when">Inspect ${esc(n.label)}</div>` : last ? `<div class="pin-when last">Last inspection ${esc(last.label)}</div>` : ''}
      ${votesLine(l)}
      ${enquiredBox(l, { short: true })}
      <button class="primary pin-open" type="button">Open</button>
    </div>`
  el.querySelector('[data-enq]').addEventListener('change', e => enquire(e.target))
  el.querySelector('.pin-open').addEventListener('click', () => { location.hash = '#map/' + encodeURIComponent(l.id) })
  return el
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
  if (r !== 'inspections') { state.keep.clear(); state.inspPast = false }
  const sheetKey = r === 'inspections' && sel.length === 2 ? sel.join('/') : ''
  if (sheetKey) { const id = decodeURIComponent(sel[0]), l = state.listings.find(x => x.id === id); if (l && !state.keep.has(id)) state.keep.set(id, votedOut(l)) }
  // An opened card: the deck's top card (#swipe/open) or a map pin's listing (#map/<id>).
  const cardFor = r === 'swipe' && sel[0] === 'open' ? queue()[0]
    : r === 'map' && sel.length ? state.listings.find(l => l.id === decodeURIComponent(sel.join('/'))) : null
  const left = queue().length
  const both = active().filter(l => combined(l) === 'both').length
  const rows = r === 'inspections' ? inspRows() : []
  const view = state.loading && !state.listings.length ? '<p class="empty">Loading listings…</p>'
    : r === 'inspections' ? viewInspections(rows) : r === 'all' ? viewAll() : r === 'map' ? viewMap() : viewSwipe()
  const was = state.sheet, wasOpen = !!(state.sheet || state.card), sheetTop = $('.sheet-body')?.scrollTop || 0
  state.sheet = null; state.card = null
  const sheet = sheetKey ? viewSheet(rows, sheetKey, !wasOpen) : cardFor ? viewCard(cardFor, !wasOpen, r) : ''
  const scrollY = window.scrollY
  if (miniMap) { miniMap.remove(); miniMap = null } // its element is about to go
  app.innerHTML = `<header class="bar"><div class="bar-in">
      <div class="brand">Shortlist <small>${active().length} listings</small></div>
      <nav class="tabs" aria-label="Views">
        <a href="#swipe" ${r === 'swipe' ? 'aria-current="page"' : ''}>Vote<span class="count">${left}</span></a>
        <a href="#inspections" ${r === 'inspections' ? 'aria-current="page"' : ''}>Inspections</a>
        <a href="#map" ${r === 'map' ? 'aria-current="page"' : ''}>Map</a>
        <a href="#all" ${r === 'all' ? 'aria-current="page"' : ''}>All<span class="count">${both} both yes</span></a>
      </nav>
      <div class="who">Voting as <b style="color:var(--ink)">${VOTERS[state.who]}</b>
        <button class="ghost" id="switch" type="button">Switch</button>
        <button class="ghost" id="rescan" type="button" ${state.scan ? `title="${scanText(state.scan)}"` : ''}>${state.scan ? 'Scanned ' + scanWhen(state.scan.at) : 'Rescan'}</button>
      </div>
    </div></header>
    <main class="view-${r}">${view}</main>${sheet}`
  const open = !!(state.sheet || state.card)
  document.documentElement.classList.toggle('lock', open) // the page behind the sheet or card stays put
  if (r === 'all' || r === 'inspections') window.scrollTo(0, scrollY)
  wire()
  if (r === 'map') placeMap()
  placeMiniMap()
  if (open && !wasOpen) $('#sheet').focus()
  else if (state.sheet && was?.row.key === state.sheet.row.key) $('.sheet-body').scrollTop = sheetTop
  if (!open && state.focusSel) $(state.focusSel)?.focus({ preventScroll: true })
  if (!open) state.focusSel = ''
  // A vote made on the opened card: now it's closed, send the top card off that way.
  if (!open && r === 'swipe' && state.pendingVote) { const v = state.pendingVote; state.pendingVote = ''; requestAnimationFrame(() => decideTop(v)) }
}
function wire() {
  $('#switch')?.addEventListener('click', () => { state.who = state.who === 'rhys' ? 'partner' : 'rhys'; store.set('rs-who', state.who); state.history = []; render() })
  $('#rescan')?.addEventListener('click', rescan)
  $('#undo')?.addEventListener('click', undo)
  document.querySelectorAll('.act[data-act]').forEach(b => b.addEventListener('click', () => decideTop(b.dataset.act)))
  const big = $('#big'); if (big) drag(big)
  $('#more')?.addEventListener('click', openCard)
  document.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.f; render() }))
  document.querySelectorAll('[data-if]').forEach(b => b.addEventListener('click', () => { state.inspFilter = b.dataset.if; render() }))
  document.querySelectorAll('[data-iw]').forEach(b => b.addEventListener('click', () => { state.inspPast = !!b.dataset.iw; state.keep.clear(); render(); window.scrollTo(0, 0) }))
  $('#sort')?.addEventListener('change', e => { state.sort = e.target.value; render() })
  document.querySelectorAll('.grid [data-v]').forEach(b => b.addEventListener('click', () => {
    const id = b.closest('.card').dataset.id, l = state.listings.find(x => x.id === id)
    vote(id, myVote(l) === b.dataset.v ? '' : b.dataset.v)
  }))
  document.querySelectorAll('[data-note]').forEach(t => t.addEventListener('input', () => saveNote(t.dataset.note, t.value)))
  document.querySelectorAll('[data-enq]').forEach(b => b.addEventListener('change', () => enquire(b)))
  $('#sheet-x')?.addEventListener('click', closeOverlay)
  $('#sheet-back')?.addEventListener('click', closeOverlay)
  $('#sheet-prev')?.addEventListener('click', () => goSheet(state.sheet?.prev))
  $('#sheet-next')?.addEventListener('click', () => goSheet(state.sheet?.next))
  document.querySelectorAll('[data-sv]').forEach(b => b.addEventListener('click', () => sheetVote(b.dataset.sv)))
  document.querySelectorAll('[data-cv]').forEach(b => b.addEventListener('click', () => cardVote(b.dataset.cv)))
  document.querySelectorAll('.about-more').forEach(b => b.addEventListener('click', () => {
    const open = !b.previousElementSibling.classList.toggle('clamp')
    b.textContent = open ? 'Show less' : 'Read more'; b.setAttribute('aria-expanded', String(open))
  }))
  // A tap on a photo opens it full screen; on the top swipe card it opens the card, like a tap anywhere on it.
  // (A flick through the carousel isn't a click, so it doesn't open anything.)
  document.querySelectorAll('.sheet .pics, .grid .pics').forEach(p => p.addEventListener('click', e => { if (!e.target.closest('button')) openViewer(p.dataset.id) }))
  $('#big .pics')?.addEventListener('click', e => { if (!e.target.closest('button')) openCard() })
  document.querySelectorAll('[data-mf]').forEach(b => b.addEventListener('click', () => { state.mapFilter = b.dataset.mf; render() }))
  $('#map-day')?.addEventListener('change', e => { state.mapDay = e.target.value; render() })
  document.querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', () => showOnMap(b.dataset.map)))
  document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('change', () => pick(b.dataset.pick, b.checked)))
  document.querySelectorAll('[data-focus]').forEach(b => b.addEventListener('click', () => focusPin(b.dataset.focus)))
  $('#plan-ics')?.addEventListener('click', () => downloadIcs(planRows().filter(r => r.on)))
  wirePics()
}
// Every carousel on the page: back to the listing's remembered photo, then keep the counter, dots and
// state.pic in step as it scrolls.
function wirePics() {
  document.querySelectorAll('.pics-track').forEach(t => {
    const p = t.parentElement, id = p.dataset.id, n = t.children.length, dots = p.querySelectorAll('.gal-dots i')
    if (state.pic[id]) t.scrollLeft = state.pic[id] * t.clientWidth
    t.addEventListener('scroll', () => {
      const i = Math.round(t.scrollLeft / t.clientWidth)
      state.pic[id] = i
      p.querySelector('.gal-n').textContent = `${i + 1} / ${n}`
      dots.forEach((d, j) => d.classList.toggle('on', j === i))
    }, { passive: true })
    p.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () =>
      t.scrollBy({ left: +b.dataset.step * t.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })))
  })
}

/* ---------- inspection sheet and opened card ---------- */
// A row opens the sheet by pushing #inspections/<key>, a tap on the top swipe card opens it by pushing
// #swipe/open, and a map pin's card is #map/<id>, so the phone's back button closes any of them. Prev and next
// replace the sheet's entry rather than adding more, so one back still returns to the list.
let lastRoute = route()
function replaceHash(h) { history.replaceState(null, '', h); lastRoute = route(); render() }
function goSheet(row) { if (row) replaceHash('#inspections/' + row.key) }
function openCard() { if ($('#big')) location.hash = '#swipe/open' }
function closeOverlay() {
  if (state.sheet) state.focusSel = `.row[data-key="${CSS.escape(state.sheet.row.key)}"]`
  else if (state.card) state.focusSel = state.card.from === 'swipe' ? '#more' : ''
  else return
  if (state.overlayPushed) history.back()
  else replaceHash('#' + route().split('/')[0])
}
function cardVote(v) {
  const c = state.card; if (!c) return
  if (c.from === 'swipe') state.pendingVote = v // render() sends the card off once the deck is back
  else vote(c.l.id, myVote(c.l) === v ? '' : v)
  closeOverlay()
}

/* ---------- photo viewer ---------- */
// One listing's photos full screen, uncropped (photos_large where a rescan has saved them), flicked or arrowed
// through. It lives outside #app so re-renders leave it alone, and pushes a history entry of its own so the
// phone's back button closes it. Closing leaves the card's carousel on the photo you were looking at.
let viewer = null // { el, id, track }
function openViewer(id) {
  const l = state.listings.find(x => x.id === id); if (!l || !l.photos.length || viewer) return
  const n = l.big.length, at = Math.min(state.pic[id] || 0, n - 1)
  const el = document.createElement('div')
  el.className = 'viewer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', `Photos of ${l.address}`); el.tabIndex = -1
  el.innerHTML = `<div class="viewer-track">${l.big.map((u, j) => `<div class="viewer-slide"><img src="${esc(u)}" alt="Photo ${j + 1} of ${n}" ${Math.abs(j - at) > 1 ? 'loading="lazy"' : ''} referrerpolicy="no-referrer"></div>`).join('')}</div>
    <span class="viewer-n" aria-live="polite">${at + 1} / ${n}</span>
    <button class="viewer-x" type="button" aria-label="Close photos">${icon('no')}</button>
    ${n > 1 ? '<button class="gal-arrow prev" type="button" data-vstep="-1" aria-label="Previous photo">‹</button><button class="gal-arrow next" type="button" data-vstep="1" aria-label="Next photo">›</button>' : ''}`
  document.body.appendChild(el)
  document.documentElement.classList.add('viewing')
  const track = el.querySelector('.viewer-track')
  track.scrollLeft = at * track.clientWidth
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / track.clientWidth)
    state.pic[id] = i; el.querySelector('.viewer-n').textContent = `${i + 1} / ${n}`
  }, { passive: true })
  el.querySelector('.viewer-x').addEventListener('click', () => history.back())
  el.querySelectorAll('[data-vstep]').forEach(b => b.addEventListener('click', () => stepViewer(+b.dataset.vstep)))
  viewer = { el, id, track }
  history.pushState({ viewer: true }, '')
  el.focus()
}
function stepViewer(dir) {
  const t = viewer?.track; if (t) t.scrollBy({ left: dir * t.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}
// Runs on the history entry being popped (the back button, ×, or Escape, which all go back).
function closeViewer() {
  if (!viewer) return
  const { el, id } = viewer
  viewer = null
  el.remove(); document.documentElement.classList.remove('viewing')
  document.querySelectorAll(`.pics[data-id="${CSS.escape(id)}"] .pics-track`).forEach(t => { t.scrollLeft = (state.pic[id] || 0) * t.clientWidth })
}
window.addEventListener('popstate', () => { if (viewer) closeViewer() })
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
    toast(`That’s ${t.row.i.start.toLocaleDateString('en-AU', { weekday: 'long' })} done: ${count('maybe')} favourite, ${count('yes')} yes, ${count('no')} no.`)
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
    // The photo carousel scrolls on its own, so a drag that starts on it flicks photos; the card swipes from below it.
    if (e.button !== 0 || e.target.closest('a, button, label, .pics-track')) return
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
    if (Math.hypot(dx, dy) < TAP_SLOP) { el.style.transform = ''; showDrag(el, 0, 0); return openCard() } // a tap, not a swipe
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
  if (/TEXTAREA|SELECT/.test(e.target.tagName) || (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox')) return
  if (viewer) {
    if (e.key === 'Escape') { e.preventDefault(); history.back() }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); stepViewer(e.key === 'ArrowLeft' ? -1 : 1) }
    return
  }
  if (state.card) { if (e.key === 'Escape') { e.preventDefault(); closeOverlay() } return }
  if (state.sheet) {
    if (e.key === 'Escape') { e.preventDefault(); closeOverlay() }
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
  const r = route(), base = r.split('/')[0]
  state.overlayPushed = lastRoute === base && r.startsWith(base + '/')
  lastRoute = r
  render()
})
// Pick up the other person's votes when the app comes back into view.
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.key && state.fetchedAt && Date.now() - state.fetchedAt > 60000) load() })

takeImport()
render()
if (state.key) load()
