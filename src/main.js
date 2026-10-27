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
  fetchedAt: null,
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
  state.loading = true
  try {
    const r = await fetch(`${API}?key=${encodeURIComponent(state.key)}`)
    const j = await r.json()
    if (!j.ok) {
      if (j.error === 'bad_passcode') { state.key = ''; store.set('rs-key', ''); return render() }
      throw new Error(j.error)
    }
    state.listings = j.listings.map(shape)
    state.fetchedAt = new Date()
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
  state.history.push({ id, prev })
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
function photo(l) {
  const badge = l.status === 'gone' ? '<span class="badge gone">Gone</span>' : l.isNew ? '<span class="badge">New</span>' : ''
  const ph = `<div class="ph">${esc(l.suburb)}<span>No photo yet</span></div>`
  const img = l.photo_url ? `<img src="${esc(l.photo_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''
  return `<div class="photo">${ph}${img}${badge}</div>`
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
function cardBody(l) {
  const other = l[otherKey() + '_note']
  const meta = [l.agency, l.available && `Available ${String(l.available).replace(/^Available /i, '').toLowerCase()}`].filter(Boolean)
  return `${photo(l)}<div class="inner">
    <div class="rent"><span class="price">${money(l.price)}<small> /wk</small></span>${l.bond ? `<span class="bond">bond ${money(l.bond)}</span>` : ''}</div>
    <div><div class="addr">${esc(l.address)}</div><div class="subn">${esc(l.suburb)}</div></div>
    <div class="chips">${chips(l)}</div>
    ${inspBlock(l)}
    ${l.notes ? `<p class="note">${esc(l.notes)}</p>` : ''}
    ${other ? `<p class="note"><b>${VOTERS[otherKey()]}:</b> ${esc(other)}</p>` : ''}
    ${votesLine(l)}
    <div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>
    ${links(l)}
  </div>`
}

/* ---------- views ---------- */
function queue() {
  return active().filter(l => !myVote(l))
    .sort((a, b) => b.score - a.score || (nextInsp(a) ? 0 : 1) - (nextInsp(b) ? 0 : 1) || a.price - b.price)
}
function viewSwipe() {
  const q = queue()
  if (!q.length) return `<div class="card"><div class="inner"><h2>You’ve voted on everything.</h2><p class="sub">New listings from the next rescan will show up here. Check the inspection run for what you’re both keen on.</p><div><a href="#inspections">Go to inspections</a></div></div></div>`
  const l = q[0]
  return `<section class="deck">
    <div>
      <div class="stage">
        <span class="stamp yes" id="sy">Yes</span><span class="stamp no" id="sn">No</span>
        <article class="card big" id="big" data-id="${esc(l.id)}">${cardBody(l)}</article>
      </div>
      <div class="actions">
        <button class="act no" data-act="no" type="button">No<kbd>←</kbd></button>
        <button class="act maybe" data-act="maybe" type="button">Maybe<kbd>↓</kbd></button>
        <button class="act yes" data-act="yes" type="button">Yes<kbd>→</kbd></button>
      </div>
    </div>
    <aside class="side">
      <div><b>${q.length} left to vote on.</b> Best matches come first: floorboards, ground floor, a courtyard, bayside.</div>
      <div>Drag right for yes, left for no. On a keyboard: → yes, ↓ maybe, ← no, U undo.</div>
      <div>${VOTERS[otherKey()]} votes separately. Anything you both say yes to lands at the top of Inspections.</div>
      <div><button class="ghost" id="undo" type="button" ${state.history.length ? '' : 'disabled'}>Undo last vote</button></div>
    </aside>
  </section>`
}
function viewInspections() {
  const rows = []
  active().forEach(l => {
    const c = combined(l)
    if (c === 'out') return
    if (state.onlyBoth && c !== 'both') return
    upcoming(l).forEach(i => rows.push({ l, i, c }))
  })
  rows.sort((a, b) => a.i.start - b.i.start || (b.c === 'both') - (a.c === 'both'))
  const head = `<div class="toolbar"><div><h2>Inspections</h2><p class="sub">Upcoming inspections, grouped by day. Listings either of you said no to are hidden.</p></div>
    <div class="seg" role="group" aria-label="Show"><button type="button" data-both="0" aria-pressed="${!state.onlyBoth}">All still in</button><button type="button" data-both="1" aria-pressed="${state.onlyBoth}">Both yes</button></div></div>`
  if (!rows.length) return head + `<p class="empty">${state.onlyBoth ? 'Nothing you’ve both said yes to has an inspection coming up.' : 'No upcoming inspections.'}</p>`
  let html = '', day = ''
  rows.forEach(({ l, i }) => {
    const d = i.start.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' })
    if (d !== day) { day = d; html += `<div class="day">${esc(d)}</div>` }
    const t = i.label.split(', ')[1] || ''
    html += `<div class="row">
      <span class="t">${esc(t)}</span>
      <span class="thumb">${l.photo_url ? `<img src="${esc(l.photo_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
      <span class="a"><b><a href="${esc(l.listing_url)}" target="_blank" rel="noopener">${esc(l.address)}</a></b><br><span>${esc(l.suburb)} · ${money(l.price)}/wk</span></span>
      <span class="v">${Object.entries(VOTERS).map(([k, n]) => { const v = l[k + '_vote']; return `<span class="vote ${v || ''}" title="${n}">${k === state.who ? 'You' : n}: ${v || '–'}</span>` }).join('')}</span>
    </div>`
  })
  return head + `<div class="run">${html}</div>`
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
  app.innerHTML = `<main><form class="gate" id="gate">
    <h1>Shortlist</h1>
    ${API ? '' : '<div class="banner">This build has no back-end address. Set VITE_API_URL in Vercel and redeploy.</div>'}
    <label for="key">Passcode</label>
    <input id="key" type="password" autocomplete="current-password" value="${esc(state.key)}" required>
    <div>Who’s voting on this device?</div>
    <div class="row2">${Object.entries(VOTERS).map(([k, n]) => `<button type="button" class="ghost" data-who="${k}" aria-pressed="${state.who === k}" style="${state.who === k ? 'background:var(--ink);color:var(--bg)' : ''}">${n}</button>`).join('')}</div>
    <button class="primary" type="submit">Open shortlist</button>
  </form></main>`
  $('#gate').addEventListener('click', e => { const b = e.target.closest('[data-who]'); if (b) { state.who = b.dataset.who; gate() } })
  $('#gate').addEventListener('submit', e => {
    e.preventDefault()
    const k = $('#key').value.trim()
    if (!k || !state.who) return toast('Enter the passcode and pick who you are.')
    state.key = k; store.set('rs-key', k); store.set('rs-who', state.who)
    load()
  })
}
function route() { return (location.hash || '#swipe').slice(1) }
function render() {
  if (!state.key || !state.who) return gate()
  const r = route()
  const left = queue().length
  const both = active().filter(l => combined(l) === 'both').length
  const view = state.loading && !state.listings.length ? '<p class="empty">Loading listings…</p>'
    : r === 'inspections' ? viewInspections() : r === 'all' ? viewAll() : viewSwipe()
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
    <main>${view}</main>`
  if (r === 'all') window.scrollTo(0, scrollY)
  wire()
}
function wire() {
  $('#switch')?.addEventListener('click', () => { state.who = state.who === 'rhys' ? 'partner' : 'rhys'; store.set('rs-who', state.who); state.history = []; render() })
  $('#rescan')?.addEventListener('click', rescan)
  $('#undo')?.addEventListener('click', undo)
  document.querySelectorAll('.act').forEach(b => b.addEventListener('click', () => decideTop(b.dataset.act)))
  const big = $('#big'); if (big) drag(big)
  document.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.f; render() }))
  document.querySelectorAll('[data-both]').forEach(b => b.addEventListener('click', () => { state.onlyBoth = b.dataset.both === '1'; render() }))
  $('#sort')?.addEventListener('change', e => { state.sort = e.target.value; render() })
  document.querySelectorAll('.grid [data-v]').forEach(b => b.addEventListener('click', () => {
    const id = b.closest('.card').dataset.id, l = state.listings.find(x => x.id === id)
    vote(id, myVote(l) === b.dataset.v ? '' : b.dataset.v)
  }))
  document.querySelectorAll('[data-note]').forEach(t => t.addEventListener('input', () => saveNote(t.dataset.note, t.value)))
}
function drag(el) {
  let x0 = null, dx = 0
  el.addEventListener('pointerdown', e => { if (e.target.closest('a')) return; x0 = e.clientX; dx = 0; el.setPointerCapture(e.pointerId); el.classList.add('dragging') })
  el.addEventListener('pointermove', e => {
    if (x0 == null) return
    dx = e.clientX - x0
    el.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`
    $('#sy').style.opacity = Math.max(0, Math.min(1, dx / 120)); $('#sn').style.opacity = Math.max(0, Math.min(1, -dx / 120))
  })
  const end = () => {
    if (x0 == null) return
    el.classList.remove('dragging'); x0 = null
    if (dx > 110) return fling('yes'); if (dx < -110) return fling('no')
    el.style.transform = ''; $('#sy').style.opacity = 0; $('#sn').style.opacity = 0
  }
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end)
}
function fling(v) {
  const el = $('#big'); if (!el) return
  const id = el.dataset.id
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || v === 'maybe') return vote(id, v)
  el.style.transform = `translateX(${v === 'yes' ? 600 : -600}px) rotate(${v === 'yes' ? 18 : -18}deg)`; el.style.opacity = 0
  setTimeout(() => vote(id, v), 180)
}
function decideTop(v) { if ($('#big')) fling(v) }
function undo() {
  const h = state.history.pop(); if (!h) return
  const l = state.listings.find(x => x.id === h.id); if (!l) return
  const cur = l[state.who + '_vote']
  l[state.who + '_vote'] = h.prev; render()
  post({ action: 'vote', id: h.id, who: state.who, vote: h.prev }).then(j => { if (!j.ok) throw 0 })
    .catch(() => { l[state.who + '_vote'] = cur; toast('Undo didn’t save.'); render() })
}
let toastT
function toast(msg) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t) }
  t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 4000)
}

document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || route() !== 'swipe') return
  if (e.key === 'ArrowRight') { e.preventDefault(); decideTop('yes') }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); decideTop('no') }
  else if (e.key === 'ArrowDown') { e.preventDefault(); decideTop('maybe') }
  else if (e.key.toLowerCase() === 'u') undo()
})
window.addEventListener('hashchange', render)
// Pick up the other person's votes when the app comes back into view.
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.key && state.fetchedAt && Date.now() - state.fetchedAt > 60000) load() })

render()
if (state.key && state.who) load()
