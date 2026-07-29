// Split out from api.js so modules api.js itself depends on (the analytics
// client) can read the API base URL without creating a circular import
// back into api.js.
//
// Deliberately read as its own variable rather than folded straight into
// `import.meta.env.VITE_API_BASE || fallback` — that collapses "the env
// var was never set" and "someone explicitly set it to this value" into
// the same branch, so a forgotten VITE_API_BASE in a production deploy
// silently shipped a build permanently pointed at 127.0.0.1:8000 — a URL
// that only ever resolves on the developer's own machine, never a real
// visitor's. Same bug class as the backend's FRONTEND_BASE_URL guard in
// main.py; fail loudly at load time instead, the same way.
const envApiBase = import.meta.env.VITE_API_BASE

if (import.meta.env.PROD && !envApiBase) {
  throw new Error(
    'VITE_API_BASE is not set in this production build. Set it in your ' +
    "deployment platform's environment variables (see README.md / " +
    'SUPABASE_MIGRATION.md) and rebuild — without it every API call would ' +
    'silently target 127.0.0.1:8000, which does not exist for real visitors.'
  )
}

export const API_BASE = envApiBase || 'http://127.0.0.1:8000'
