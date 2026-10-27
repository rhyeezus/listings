/*
 * Domain rescan, run in a browser tab that is on www.domain.com.au (Domain blocks server-side requests,
 * so this has to run in a real browser). Paste the whole file into the tab's console, or have Claude run it
 * in the browser pane, then:
 *
 *   await domainRescan()                       // scans the saved search below, about 1.5s per listing
 *   domainRescanHandoff('http://localhost:5174')  // opens the app with the results; it imports them
 *
 * Progress while it runs: window.__rescan (pages, done, total, failed).
 * The app posts the rows to the Apps Script web app (action "import"), which merges them like a
 * full scan: new listings added, price/inspections/availability/agency/photos/description/map position refreshed, other details only
 * filled where blank, and Domain listings missing from the scan marked gone.
 */

// Keep in step with the Search tab in the sheet.
const DOMAIN_SEARCH = {
  suburbs: ['elwood-vic-3184', 'st-kilda-vic-3182', 'st-kilda-east-vic-3183', 'st-kilda-west-vic-3182',
    'balaclava-vic-3183', 'ripponlea-vic-3185', 'elsternwick-vic-3185', 'gardenvale-vic-3185',
    'brighton-vic-3186', 'prahran-vic-3181', 'windsor-vic-3181'],
  bedrooms: '2', price: '0-650', excludeDepositTaken: true,
}

const nextData = html => JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]).props.pageProps.componentProps
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// "2026-10-30T16:00:00" (Melbourne time) -> parts, without letting the browser's own timezone in.
function parts(iso) {
  const [, y, mo, d, h, mi] = String(iso).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/).map(Number)
  return { y, mo, d, h, mi, wd: DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] }
}
const clock = p => (p.h % 12 || 12) + (p.mi ? ':' + String(p.mi).padStart(2, '0') : '') + (p.h >= 12 ? 'pm' : 'am')
// -> "Fri 30 Oct, 4pm - 4:10pm", the format the app's inspection parser reads.
const inspection = (a, b) => { const s = parts(a), e = parts(b); return `${s.wd} ${s.d} ${MONTHS[s.mo - 1]}, ${clock(s)} - ${clock(e)}` }

function available(iso) {
  if (!iso) return ''
  const p = parts(iso), today = new Date()
  const when = Date.UTC(p.y, p.mo - 1, p.d), now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return when <= now ? 'Now' : `${String(p.d).padStart(2, '0')} ${MONTHS[p.mo - 1]} ${p.y}`
}

const TYPES = { 'Apartment / Unit / Flat': 'Apartment/unit', 'House': 'House (per Domain)', 'Semi-Detached': 'Semi-detached' }
const shortStreet = s => String(s).replace(/\bStreet\b/, 'St').replace(/\bRoad\b/, 'Rd').replace(/\bAvenue\b/, 'Ave').replace(/\bParade\b/, 'Pde')

// One listing page -> a Listings row. Flooring, level and outdoor space come from the features and ad text.
// Photos are the search result's gallery (720x540, cropped to 4:3, phone-sized), falling back to the listing
// page's own; photos_large is the page's uncropped gallery.
function toRow(slug, html, fromSearch) {
  const cp = nextData(html)
  const feats = (cp.features || []).join(' | ')
  const text = [cp.headline, ...(cp.description || []), feats].join(' ').toLowerCase()
  const stats = Object.fromEntries(((cp.listingSummary || {}).stats || []).map(s => [s.key, s]))
  const floors = [/floorboard|timber floor|hardwood|polished (timber|board|floor)/.test(text) && 'boards',
    /carpet/.test(text) && 'carpet', /\btiled?\b|tiles/.test(text) && 'tiles'].filter(Boolean)
  const outdoor = [/courtyard/.test(text) && (/(shared|communal) courtyard/.test(text) ? 'Shared courtyard' : 'Courtyard'),
    /garden/.test(text) && !/courtyard/.test(text) && (/communal garden/.test(text) ? 'Communal garden' : 'Garden'),
    /balcon|deck/.test(text) && 'Balcony'].filter(Boolean)
  const price = (String((cp.listingSummary || {}).title || fromSearch.price || '').replace(/,/g, '').match(/\$\s*(\d{3,4})/) || [])[1]
  const thumb = (html.match(/https:\/\/rimh2\.domainstatic\.com\.au\/[^"'\s\\]+?=\/640x360\/filters:format\(webp\):quality\(85\)\/[^"'\s\\]+/) || [])[0]
  const addr = fromSearch.address || {}
  // The listing page's own gallery: uncropped, up to 1920px wide, for the app's full-screen photo viewer.
  const large = ((cp.gallery || {}).slides || []).filter(s => s.mediaType === 'image').map(s => ((s.images || {}).original || {}).url).filter(Boolean)
  const photos = (fromSearch.images || []).length ? fromSearch.images : large
  return {
    id: slug,
    address: shortStreet(addr.street || String((cp.inspection || {}).displayAddress || '').split(',')[0]),
    suburb: addr.suburb || cp.suburb || '',
    price: price ? Number(price) : '',
    bond: stats.bond ? Number(stats.bond.value) || '' : '',
    type: TYPES[cp.propertyType] || cp.propertyType || '',
    beds: (cp.listingSummary || {}).beds || '',
    flooring: floors.join(', '),
    level: /ground floor|ground level|ground-floor/.test(text) ? 'Ground' : /(first|second|third|top|upper) floor|upstairs|level [1-9]/.test(text) ? 'Upper' : '',
    outdoor: outdoor.join(', '),
    pets: /pets? (allowed|welcome|considered|friendly)/.test(text) ? 'Yes' : '',
    inspections: (((cp.inspection || {}).inspectionTimes) || []).map(t => inspection(t.openingDateTime, t.closingDateTime)).join('; '),
    available: available((stats.availableFrom || {}).iso8601Value),
    agency: cp.agencyName || '',
    photo_url: thumb || photos[0] || '',
    photos: photos.join('\n'),
    photos_large: large.join('\n'),
    description: (cp.description || []).join('\n').trim(),
    listing_url: 'https://www.domain.com.au/' + slug,
    lat: addr.lat || '', lng: addr.lng || '',
    source: 'Domain',
  }
}

async function domainRescan(search = DOMAIN_SEARCH) {
  // ssubs=0: no "surrounding suburbs" padding. Domain still pads some searches, so results are also
  // filtered to the listed suburbs ('st-kilda-east-vic-3183' -> 'st kilda east').
  const q = `suburb=${search.suburbs.join(',')}&ssubs=0&bedrooms=${search.bedrooms}&price=${search.price}${search.excludeDepositTaken ? '&excludedeposittaken=1' : ''}`
  const wanted = new Set(search.suburbs.map(s => s.replace(/-vic-\d{4}$/, '').replace(/-/g, ' ')))
  const st = window.__rescan = { pages: 0, totalPages: null, found: [], skipped: 0, done: 0, total: 0, rows: [], failed: [], finished: false }
  for (let page = 1; st.totalPages == null || page <= st.totalPages; page++) {
    const cp = nextData(await fetch(`/rent/?${q}&page=${page}`).then(r => r.text()))
    st.totalPages = cp.totalPages; st.pages = page
    cp.listingSearchResultIds.forEach(id => {
      const m = (cp.listingsMap[id] || {}).listingModel
      if (!m) return
      if (wanted.has(String((m.address || {}).suburb).toLowerCase())) st.found.push(m)
      else st.skipped++
    })
    await sleep(1000)
  }
  st.total = st.found.length
  for (const m of st.found) {
    const slug = m.url.replace(/^\//, '')
    try {
      const r = await fetch('/' + slug)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      st.rows.push(toRow(slug, await r.text(), m))
    } catch (e) { st.failed.push([slug, String(e.message || e)]) }
    st.done++
    await sleep(1200)
  }
  st.finished = true
  return { found: st.total, rows: st.rows.length, failed: st.failed }
}

// Opens the app with the scan attached; the app (signed in with the passcode) sends it to the sheet.
function domainRescanHandoff(appUrl) {
  const st = window.__rescan
  if (!st || !st.finished) throw new Error('Run domainRescan() first')
  location.href = appUrl.replace(/\/$/, '') + '/#import=' + encodeURIComponent(JSON.stringify({ full: st.failed.length === 0, rows: st.rows }))
}
