/**
 * debugLog.js — TEMPORARY diagnostic instrumentation for the
 * "Fest Schedule / Admin blank on first visit, refresh fixes it" bug.
 *
 * Every call prints a timestamped, tagged line to the console so the full
 * init → mount → fetch → render sequence can be read back in order and
 * compared between a first visit and a refresh.
 *
 * HOW TO USE THIS TO DEBUG:
 *   1. Open the deployed site in an Incognito/Private window (guarantees a
 *      genuinely first-ever visit — no cached SW, no localStorage).
 *   2. Open DevTools → Console BEFORE navigating, so nothing is missed.
 *   3. Load the site, then click through to Fest Schedule (or Admin).
 *   4. Copy the full sequence of [BOOT]/[SW]/[EventsList] lines.
 *   5. Hit a normal refresh on the same page, copy the sequence again.
 *   6. Compare the two — the exact point where they diverge is the root
 *      cause. Send both sequences back for the next diagnosis step.
 *
 * Also open DevTools → Network, find the GET request to /api/events, and
 * note: (a) its Status column, (b) its Size column — if it says
 * "(ServiceWorker)" instead of a number, the service worker answered the
 * request instead of the network, which is the #1 suspect right now.
 * Also check DevTools → Application → Service Workers for more than one
 * registered worker, or one stuck in "waiting".
 *
 * REMOVE THIS FILE (and its call sites) once the root cause is confirmed
 * and fixed — it is not meant to ship long-term.
 */

let seq = 0

export function dlog(tag, ...args) {
  seq += 1
  const t = performance.now().toFixed(1)
  console.log(`%c[${seq}] %c+${t}ms %c[${tag}]`,
    'color:#888;font-weight:normal',
    'color:#0a84ff;font-weight:normal',
    'color:#fff;background:#7c3aed;border-radius:3px;padding:1px 5px;font-weight:700',
    ...args)
}

export function dwarn(tag, ...args) {
  seq += 1
  const t = performance.now().toFixed(1)
  console.warn(`[${seq}] +${t}ms [${tag}]`, ...args)
}
