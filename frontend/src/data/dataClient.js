/**
 * frontend/src/data/dataClient.js  --  W2: snapshot-first data layer
 *
 * Read-mostly datasets come from static JSON instead of the FastAPI backend:
 *   baked at build time (same-origin, served by Vercel):  /data/locations.json, /data/graph.json
 *   live snapshots (public Supabase Storage bucket `snapshots`, base URL from
 *   VITE_SNAPSHOT_BASE_URL):  schedule.json, menus.json, closures.json, posters.json
 *
 * Every function resolves to EXACTLY the shape the matching api.js function resolved to
 * before (arrays of venues / events / road segments, the raw graph object, one menu row),
 * so components don't change.
 *
 * Strategy per dataset (see DATASETS):
 *   1. memory fresh (< ttl)           -> return it, no network
 *   2. older memory/IndexedDB copy    -> return it NOW, revalidate in the background
 *                                         (stale-while-revalidate; subscribers get the update)
 *   3. no usable copy                  -> wait for snapshot, then the live API (short timeout)
 *   Network order: snapshot URL first; live API only when no usable data is cached.
 *   Only if both fail and nothing is cached
 *   does the call reject (same error behaviour as the old api.js).
 *
 * Writes the same IndexedDB keys the existing offline code already reads
 * ('locations', 'events', 'road-segments', 'graph' in offline/offlineBundle.js), so offline routing and
 * the old fallbacks keep working. Admin screens do NOT use this file; they stay on the live API.
 *
 * Env: VITE_SNAPSHOT_BASE_URL   e.g. https://<ref>.supabase.co/storage/v1/object/public/snapshots
 *      VITE_SNAPSHOT_BUCKET_SECONDS (optional)  if > 0, appends ?b=<time bucket> to live-snapshot URLs
 *                                    to bound staleness when the CDN won't revalidate (see handoff).
 */
import { API_BASE } from '../apiBase'
import { cacheBundleResource, getCachedBundleResource, setNavigationStatus,
  reportBackendReachability, reportPublicReachability, reportSynchronizationFailure } from '../offline/offlineBundle'
import { loadGraph } from '../routing/graphData'

const SNAP_BASE = (import.meta.env.VITE_SNAPSHOT_BASE_URL || '').replace(/\/+$/, '')
const BUCKET_S = Number(import.meta.env.VITE_SNAPSHOT_BUCKET_SECONDS) || 0

const MIN = 60_000
const DATASETS = {
  // baked: same-origin raw JSON, no envelope
  locations: { baked: true, file: '/data/locations.json', live: '/api/locations', idbKey: 'locations', ttl: 10 * MIN },
  // live snapshots: envelope {schema, version, updated_at, meta, data}
  schedule:  { file: '/schedule.json', live: '/api/events',        idbKey: 'events',          ttl: 30_000 },
  closures:  { file: '/closures.json', live: '/api/road-segments', idbKey: 'road-segments',   ttl: 30_000 },
  menus:     { file: '/menus.json',    live: null,                 idbKey: 'snapshot-menus',  ttl: 60_000 },
  posters:   { file: '/posters.json',  live: 'derive-from-events',  idbKey: 'snapshot-posters', ttl: 2 * MIN },
}

const mem = {}          // name -> { data, version, fetchedAt, meta, source }
const inflight = {}     // name -> Promise
const listeners = {}    // name -> Set<fn>
const refreshTimers = {} // Only actively displayed datasets are polled.

const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)))

function httpError(message, status) {
  const e = new Error(message)
  e.status = status
  return e
}

async function timedFetch(url, options = {}, timeoutMs = 8000, read = res => res) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await read(await fetch(url, { ...options, signal: ctl.signal }))
  } catch (e) {
    if (e.name === 'AbortError') {
      const t = new Error('Request timed out — check your connection and try again.')
      t.status = 0
      t.timeout = true
      throw t
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function timedJSON(url, options = {}, timeoutMs = 8000) {
  // Keep the abort deadline active while receiving/parsing the body too.
  return timedFetch(url, options, timeoutMs, async res => {
    let json
    try { json = await res.json() }
    catch (error) {
      if (res.ok || error.name === 'AbortError') throw error
      json = {}
    }
    return { res, json }
  })
}

async function liveJSON(path, timeoutMs = 8000) {
  const { res, json } = await timedJSON(`${API_BASE}${path}`, {}, timeoutMs)
  if (!res.ok) {
    throw httpError(json?.detail || `Request failed: ${res.status}`, res.status)
  }
  reportBackendReachability(true)
  return json
}

// ── validation: never let a malformed file replace good data ──────────────
function validShape(name, data) {
  if (name === 'locations') return Array.isArray(data) && data.length > 0 && new Set(data.map(l => l?.id)).size === data.length && data.every(l => l && typeof l.id === 'string' && l.id && Number.isFinite(l.lat) && Math.abs(l.lat) <= 90 && Number.isFinite(l.lng) && Math.abs(l.lng) <= 180)
  if (name === 'closures') return Array.isArray(data) && data.length > 0 && new Set(data.map(s => s?.id)).size === data.length && data.every(s => s && typeof s.id === 'string' && typeof s.closed === 'boolean' && s.bbox && ['lat_min', 'lat_max', 'lng_min', 'lng_max'].every(k => Number.isFinite(s.bbox[k])) && s.bbox.lat_min <= s.bbox.lat_max && s.bbox.lng_min <= s.bbox.lng_max)
  if (name === 'menus') return data && typeof data === 'object' && !Array.isArray(data)
  return Array.isArray(data)
}

// ── network sources ───────────────────────────────────────────────────────
async function fetchSnapshot(name, timeoutMs) {
  const def = DATASETS[name]
  if (!def.baked && !SNAP_BASE) throw new Error('VITE_SNAPSHOT_BASE_URL not set')
  let url = def.baked ? def.file : `${SNAP_BASE}${def.file}`
  if (!def.baked && BUCKET_S > 0) url += `?b=${Math.floor(Date.now() / (BUCKET_S * 1000))}`
  // Live snapshots: conditional request (cheap 304s) so the browser's own max-age can't add
  // another minute of staleness on top of the CDN's. Baked files use normal HTTP/SW caching.
  const { res, json } = await timedJSON(url, def.baked ? {} : { cache: 'no-cache' }, timeoutMs)
  if (!res.ok) throw httpError(`snapshot ${name}: HTTP ${res.status}`, res.status)
  if (def.baked) {
    if (!validShape(name, json)) throw new Error(`snapshot ${name}: bad data shape`)
    return { data: json, version: 0, meta: {}, source: 'snapshot' }
  }
  if (!json || json.schema !== 1 || !('data' in json)) throw new Error(`snapshot ${name}: bad envelope`)
  if (!validShape(name, json.data)) throw new Error(`snapshot ${name}: bad data shape`)
  if (res.headers.get('X-SSN-Snapshot-Source') !== 'sw-cache') reportPublicReachability()
  return { data: json.data, version: Number(json.version) || 0, meta: json.meta || {}, source: 'snapshot',
    revalidated: res.headers.get('X-SSN-Snapshot-Source') !== 'sw-cache' }
}

async function fetchLive(name, timeoutMs) {
  const def = DATASETS[name]
  if (!def.live) throw new Error(`no live fallback for ${name}`)
  if (def.live === 'derive-from-events') {
    const cachedSchedule = mem.schedule || await hydrate('schedule')
    const events = cachedSchedule ? cachedSchedule.data : await liveJSON('/api/events', timeoutMs)
    const data = events
      .filter((e) => e.poster_url || (e.photo_urls || []).length)
      .map((e) => ({ event_id: e.id, poster_url: e.poster_url || '', photo_urls: e.photo_urls || [] }))
    return { data, version: 0, meta: { live: !cachedSchedule }, source: cachedSchedule ? 'cache' : 'live', revalidated: !cachedSchedule }
  }
  return { data: await liveJSON(def.live, timeoutMs), version: 0, meta: { live: true }, source: 'live' }
}

// ── state ─────────────────────────────────────────────────────────────────
async function hydrate(name) {
  const def = DATASETS[name]
  const [data, meta] = await Promise.all([
    getCachedBundleResource(def.idbKey),
    getCachedBundleResource(`snapshot-meta:${name}`),
  ])
  if (!data || !validShape(name, data)) return undefined
  // Raw data written by the pre-W2 api.js has no meta record: treat as old (fetchedAt 0) but usable.
  return (mem[name] ||= { data, version: meta?.version ?? 0, fetchedAt: meta?.fetchedAt ?? 0, meta: meta?.meta ?? {}, source: 'cache' })
}

function commit(name, res) {
  if (!validShape(name, res.data)) throw new Error(`${name}: unexpected data shape`)
  const cur = mem[name]
  const now = res.revalidated === false ? 0 : Date.now()
  if (cur && res.revalidated === false) return cur
  if (cur && res.version && cur.version && res.version < cur.version) {
    // Older versions do not renew freshness.
    return cur
  }
  if (cur && res.version && res.version === cur.version) {
    cur.fetchedAt = now            // unchanged
    if (name === 'closures') setNavigationStatus({ closuresSyncedAt: now })
    cacheBundleResource(`snapshot-meta:${name}`, { version: cur.version, fetchedAt: now, meta: cur.meta })
    return cur
  }
  const st = { data: res.data, version: res.version, fetchedAt: now, meta: res.meta, source: res.source }
  mem[name] = st
  if (name === 'closures') setNavigationStatus({ closuresSyncedAt: st.fetchedAt })
  const def = DATASETS[name]
  cacheBundleResource(def.idbKey, st.data)
  cacheBundleResource(`snapshot-meta:${name}`, { version: st.version, fetchedAt: st.fetchedAt, meta: st.meta })
  listeners[name]?.forEach((fn) => { try { fn(clone(st.data)) } catch { /* listener bug must not break loading */ } })
  return st
}

function revalidate(name, timeoutMs = 6000) {
  if (inflight[name]) return inflight[name]
  inflight[name] = (async () => {
    try {
      let res
      try {
        res = await fetchSnapshot(name, timeoutMs)
      } catch (error) {
        // A snapshot outage must not turn every cached visitor's 30-second
        // refresh into a request to Render. Empty schedules are valid caches.
        // Hydrate here too: a subscriber can refresh before the first getter.
        const cached = mem[name] || await hydrate(name)
        if (cached) throw error
        res = await fetchLive(name, timeoutMs)
      }
      return commit(name, res)
    } catch (error) {
      reportSynchronizationFailure()
      throw error
    } finally {
      delete inflight[name]
    }
  })()
  return inflight[name]
}

async function load(name) {
  const def = DATASETS[name]
  const st = mem[name] || (await hydrate(name))
  const age = st ? Date.now() - st.fetchedAt : Infinity
  if (st && age < def.ttl) return st
  if (st) {
    // All public pages use known-good data immediately. Snapshot subscriptions
    // refresh it independently; a cold Render is never part of that refresh
    // when this dataset is already available, however old the cache is.
    if (typeof navigator === 'undefined' || navigator.onLine !== false) revalidate(name).catch(() => {})
    return st
  }
  if (name === 'closures') {
    try {
      const { res, json } = await timedJSON('/data/closures.json')
      if (!res.ok) throw new Error('No bootstrap road status')
      const initial = commit(name, { data: json, version: 0, meta: { bootstrap: true }, source: 'bootstrap', revalidated: false })
      revalidate(name).catch(() => {})
      return initial
    } catch { /* No build-time status: bootstrap from the live snapshot/API. */ }
  }
  return revalidate(name, 8000)
}

/** Successful admin writes expire, but never discard, public copies. This
 *  invalidates this browser's IndexedDB too; publication still owns truth and
 *  the existing 30-second subscriptions pick up the new Storage version. */
export function noteAdminMutation(path, method) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method?.toUpperCase())) return
  const pathname = path.split('?')[0]
  const names = pathname.startsWith('/api/admin/events') ? ['schedule', 'posters']
    : pathname.startsWith('/api/admin/road-segments') ? ['closures']
    : /^\/api\/admin\/locations\/[^/]+\/menu$/.test(pathname) ? ['menus'] : []
  for (const name of names) {
    // Non-blocking storage invalidation, never a new live API call on a write.
    ;(async () => {
      const st = mem[name] || await hydrate(name)
      if (!st) return
      st.fetchedAt = 0
      await cacheBundleResource(`snapshot-meta:${name}`, { version: st.version, fetchedAt: 0, meta: st.meta })
    })().catch(() => {})
  }
}

// ── public API ────────────────────────────────────────────────────────────
export async function getLocations(category) {
  const list = clone((await load('locations')).data)
  if (!category) return list
  const c = category.toLowerCase()
  return list.filter((l) => (l.category || '').toLowerCase() === c)
}

/** One venue by id. The validated destination list is authoritative. */
export async function getLocation(id) {
  const found = (await load('locations')).data.find((l) => l.id === id)
  if (found) return clone(found)
  throw httpError('Campus destination not found.', 404)
}

/** The raw walkway graph. Shared object (large): treat as read-only. */
export async function getGraph() {
  return loadGraph(await getLocations())
}

/** Same array as GET /api/events (verified events, `location` = {id,name,lat,lng}). */
export async function getSchedule({ fest, date } = {}) {
  let list = clone((await load('schedule')).data)
  if (fest) list = list.filter((e) => (e.fest || '').toLowerCase() === fest.toLowerCase())
  if (date) list = list.filter((e) => e.date === date)
  return list
}

/** Same object as GET /api/events/{id}: location is the full venue row. 404 error if unknown. */
export async function getEvent(id, { refresh = false } = {}) {
  // An explicit Retry bypasses the memory TTL, but still obeys the cached-data
  // protection in revalidate(). Subscription callbacks never force a refresh.
  if (refresh) await revalidate('schedule').catch(() => {})
  const ev = (await load('schedule')).data.find((e) => e.id === id)
  // An absent id is not a reason to wake Render. Newly published events arrive
  // through the schedule subscription, including recovery on the QR page.
  if (!ev) throw httpError('This event is not in the published schedule. It may be awaiting approval or have been removed.', 404)
  const out = clone(ev)
  try {
    const venue = (await load('locations')).data.find((l) => l.id === ev.location_id)
    if (venue) out.location = clone(venue)
  } catch { /* keep the minimal location */ }
  return out
}

/** Same array as GET /api/road-segments. */
export async function getClosures() {
  const st = await load('closures')
  setNavigationStatus({ closuresSyncedAt: st.fetchedAt })
  return clone(st.data)
}

/** { [venueId]: { [YYYY-MM-DD]: menuRow } } for yesterday..+14 days (UTC dates, like the backend). */
export async function getMenus() {
  return clone((await load('menus')).data)
}

const utcToday = () => new Date().toISOString().slice(0, 10)

/** Same result/rejection as GET /api/locations/{id}/menu: a menu row, or an Error with .status 404. */
export async function getVenueMenu(venueId, date) {
  const d = date || utcToday()
  let st
  try { st = await load('menus') } catch { st = null }
  const { date_from: from, date_to: to } = st?.meta || {}
  if (st && from && to && d >= from && d <= to) {
    const row = st.data?.[venueId]?.[d]
    if (row) return clone(row)
    throw httpError("Today's menu has not been uploaded.", 404)
  }
  return liveJSON(`/api/locations/${encodeURIComponent(venueId)}/menu?date=${encodeURIComponent(d)}`) // outside snapshot window / no snapshot
}

/** [{event_id, poster_url, photo_urls}] for verified events that have images. */
export async function getPosters() {
  return clone((await load('posters')).data)
}

/** QR image: use Storage when snapshots are configured, never an automatic
 *  Render image request because a cached envelope lacks qr_ids. The admin QR
 *  download still uses the authenticated dashboard's live endpoint. */
export function qrUrl(eventId) {
  if (SNAP_BASE) return `${SNAP_BASE}/qr/${encodeURIComponent(eventId)}.png`
  return `${API_BASE}/api/events/${encodeURIComponent(eventId)}/qr`
}

/** Called with a fresh copy of the data whenever a background refresh actually changed it. */
export function subscribe(name, fn) {
  if (!DATASETS[name]) throw new Error(`unknown dataset ${name}`)
  ;(listeners[name] ||= new Set()).add(fn)
  if (!DATASETS[name].baked && !refreshTimers[name]) {
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      revalidate(name).catch(() => {})
    }
    const timer = setInterval(refresh, DATASETS[name].ttl)
    timer.unref?.() // SSR verification must not be kept alive by a browser poll.
    refreshTimers[name] = { timer, refresh }
    if (typeof window !== 'undefined') window.addEventListener('online', refresh)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh)
  }
  return () => {
    listeners[name].delete(fn)
    if (!listeners[name].size && refreshTimers[name]) {
      const { timer, refresh } = refreshTimers[name]
      clearInterval(timer)
      if (typeof window !== 'undefined') window.removeEventListener('online', refresh)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh)
      delete refreshTimers[name]
    }
  }
}

/** An old cache is sufficient to show the app while health/network refreshes run. */
export async function hasCachedBootData() {
  const entries = await Promise.all(['locations', 'closures', 'schedule'].map(name => mem[name] || hydrate(name)))
  return entries.some(Boolean)
}

/** Warm everything the home screen needs; never rejects. */
export function prefetchAll() {
  return Promise.allSettled([getGraph(), ...['locations', 'closures', 'schedule'].map(load)])
}

/** Test/debug helper. */
export function _state() { return mem }
