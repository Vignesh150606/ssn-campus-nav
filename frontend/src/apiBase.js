// Split out from api.js so modules api.js itself depends on (the analytics
// client) can read the API base URL without creating a circular import
// back into api.js.
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'
