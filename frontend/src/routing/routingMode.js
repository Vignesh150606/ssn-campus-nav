/**
 * routingMode.js — which engine answers route / reroute requests.
 *
 *   VITE_ROUTING_MODE=client   (default) every route is computed in the
 *                              browser; no routing request ever leaves it.
 *   VITE_ROUTING_MODE=server   escape hatch: ask GET /api/route first, as
 *                              the app did before client routing, and only
 *                              compute on-device if that request fails.
 *
 * Read once at build time (Vite inlines VITE_* variables). An unrecognised
 * value falls back to 'client' with a console warning rather than throwing,
 * so a typo in a deployment env var can't take routing down.
 */
const raw = String(import.meta.env.VITE_ROUTING_MODE ?? 'client').trim().toLowerCase()

if (raw !== 'client' && raw !== 'server') {
  console.warn(`VITE_ROUTING_MODE="${raw}" is not 'client' or 'server' — using 'client'.`)
}

export const ROUTING_MODE = raw === 'server' ? 'server' : 'client'
