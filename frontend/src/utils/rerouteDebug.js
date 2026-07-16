/**
 * rerouteDebug.js — TEMPORARY diagnostic instrumentation for the live-
 * navigation "route through CSE Annexure" investigation. The live backend
 * has been directly queried and proven to return the correct route for the
 * disputed coordinates; this exists to capture what the FRONTEND actually
 * did during a real walk that still reproduced the bug, since that could
 * not be reproduced against the backend directly.
 *
 * REMOVE THIS FILE (and its call sites in LocationProvider.jsx) once the
 * root cause is confirmed and fixed — it is not meant to ship long-term.
 *
 * Not gated behind devModeAvailable (unlike DevLocationPanel) — this has to
 * work on the production build, since that's what's being debugged.
 *
 * Every entry is:
 *  (a) printed to the console immediately — visible if remote debugging
 *      (chrome://inspect over USB, or Safari Web Inspector over cable) is
 *      attached during the walk, and
 *  (b) appended to localStorage under REROUTE_LOG_KEY, so nothing is lost
 *      if DevTools can't be open live while walking — pull it up after.
 *
 * To review after a walk, open the console (remote debugging, or on
 * desktop after reproducing there) and run:
 *   window.__rerouteLog()
 * which prints and returns the full captured history. To clear it between
 * test runs: window.__clearRerouteLog()
 *
 * THE SINGLE MOST IMPORTANT FIELD in each entry is `source` — the backend
 * (main.py) stamps every response "local" (walked live from the on-disk
 * graph, whatever /api/route actually returned) or "offline" (never
 * reached the backend at all — served entirely client-side from
 * offlineRouter.js against whatever graph happens to be cached in this
 * device's IndexedDB, which is only refreshed opportunistically and could
 * predate any backend fix). If `source` is ever "offline" during a
 * reproduction of the bug, that is the root cause, full stop — everything
 * else in the entry is there to confirm why the offline path was taken.
 */

const REROUTE_LOG_KEY = 'ssn-reroute-debug-log'
const MAX_ENTRIES = 200 // keep localStorage bounded across a long walk

export function logRerouteEvent(entry) {
  const withTimestamp = { loggedAt: new Date().toISOString(), ...entry }
  console.log('[reroute-debug]', withTimestamp)
  try {
    const existing = JSON.parse(localStorage.getItem(REROUTE_LOG_KEY) || '[]')
    existing.push(withTimestamp)
    while (existing.length > MAX_ENTRIES) existing.shift()
    localStorage.setItem(REROUTE_LOG_KEY, JSON.stringify(existing))
  } catch {
    // storage full or unavailable -- the console.log above still has it
  }
}

export function getRerouteLog() {
  try {
    return JSON.parse(localStorage.getItem(REROUTE_LOG_KEY) || '[]')
  } catch {
    return []
  }
}

export function clearRerouteLog() {
  try { localStorage.removeItem(REROUTE_LOG_KEY) } catch { /* ignore */ }
}

// Always-available console helpers, independent of any dev-mode gate.
if (typeof window !== 'undefined') {
  window.__rerouteLog = () => { const log = getRerouteLog(); console.log(log); return log }
  window.__clearRerouteLog = clearRerouteLog
}
