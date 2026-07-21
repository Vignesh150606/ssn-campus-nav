// Shared between AdminDashboard.jsx (Super Admin), FestAdminDashboard.jsx,
// and admin/ManageFestAdmins.jsx — pulled out during the RBAC redesign so
// the location list, styles, and JWT-fetch helper have exactly one source
// instead of drifting between the Super Admin and Fest Admin dashboards.
import { API_BASE } from '../../apiBase'
import { LOCATION_NAME_OVERRIDES } from '../../constants'

// Phase 3 — JWT bearer auth (replaces the old shared `?secret=` query param).
export async function adminFetch(path, method = 'GET', body = null, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  if (body) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    })
  } catch {
    // Backend unreachable (cold start, offline, DNS, etc.) — distinct from
    // an authenticated-but-rejected response, so callers can tell the two
    // apart instead of treating "server didn't answer" the same as
    // "your session is invalid".
    const err = new Error('Could not reach the server. Please check your connection and try again.')
    err.status = 0
    throw err
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    const err = new Error(d.detail || `Error ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export const TOKEN_STORAGE_KEY = 'ssn_admin_token_v1'

// Decodes the JWT payload (username/role/sub) client-side so the UI knows
// which dashboard to render immediately on page load, without waiting on
// a network round trip. NOT a security check — the backend independently
// verifies the token's signature and re-checks role/disabled on every
// real request (see auth.py); a forged/edited payload here would just
// make the UI briefly show the wrong screen, not grant any actual access.
export function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64))
  } catch {
    return null
  }
}

// RBAC redesign — status now has 4 states instead of 3. 'verified' is kept
// as the internal/DB value for "Approved" (not renamed — see the schema
// migration's comment for why), STATUS_LABEL is what the UI shows instead.
export const STATUS_COLOR = { verified: '#2E9E5B', pending: '#E07414', rejected: '#D7263D', needs_changes: '#B8860B' }
export const STATUS_LABEL = { verified: 'Approved', pending: 'Pending Review', rejected: 'Rejected', needs_changes: 'Needs Changes' }

export const LOCATION_IDS = ['main-gate', 'parking', 'admin-block', 'central-library', 'eee-block',
  'cse-block', 'ece-block', 'it-block', 'mech-block', 'civil-block', 'biomed-block',
  'tcs-auditorium', 'mini-hall-1', 'food-rishabhs', 'food-snowcube', 'food-metro',
  'food-pr', 'food-aswins', 'sports-complex', 'boys-hostel-gate', 'boys-hostel-office',
  'girls-hostel', 'medical-center', 'clock-tower', 'cdc-block', 'ssn-fountain', 'snu-academic',
  'main-canteen']

// P8 — Updated display names (overrides backend names in the admin UI)
// Do NOT change the IDs above — routing, graph, and coordinates remain unchanged.
export const LOCATION_DISPLAY_NAMES = {
  'main-gate':          'Main Gate',
  'parking':            'Parking',
  'admin-block':        'Admin Block',
  'central-library':    'Central Library',
  'eee-block':          'EEE Block',
  'cse-block':          'CSE Block',
  'ece-block':          'ECE Block',
  'it-block':           'IT Block',
  'mech-block':         'Mech Block',
  'civil-block':        'Civil Block',
  'biomed-block':       'BioMed Block',
  'tcs-auditorium':     'Main Auditorium',   // was: TCS Auditorium
  'mini-hall-1':        'Mini Auditorium',   // was: Mini Hall 1
  'food-rishabhs':      "Rishabh's",
  'food-snowcube':      'Snow Cube',
  'food-metro':         'Metro',
  'food-pr':            'PR (Food Court)',
  'sports-complex':     'Sports Complex',
  'boys-hostel-gate':   'Boys Hostel Gate',
  'boys-hostel-office': 'Boys Hostel Office',
  'girls-hostel':       'Girls Hostel',
  'medical-center':     'Medical Center',
  'cdc-block':          'CDC Block',
  'ssn-fountain':       'SSN Fountain',
  'snu-academic':       'SNU Academic Block',
  'main-canteen':       'Main Canteen',
  // Priority 4 — these three always come from the single shared map in
  // constants.js so this list can't silently drift out of sync with the
  // rest of the app (Fest Schedule, Copilot, Search, Map, Food Menu, etc).
  ...LOCATION_NAME_OVERRIDES,
}

export const BLANK_EVENT_FORM = {
  name: '', fest: 'Invente', department: '', location_id: 'tcs-auditorium',
  date: '', start_time: '', end_time: '', description: '', open_to_external: true,
  organizer: '', category: '', contact_info: '', registration_link: '',
  poster_url: '', photo_urls: '',
  building: '', room_number: '', floor: '', wing: '',
}

// Task 3 — theme-aware input style; uses CSS variables so it works in both light + dark mode
export const inputStyle = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 10,
  border: '1px solid var(--line-strong)',
  fontFamily: 'var(--font-sans)',
  fontSize: '0.92rem',
  outline: 'none',
  background: 'var(--canvas)',
  color: 'var(--ink)',
  boxSizing: 'border-box',
}

export const textareaStyle = { ...inputStyle, resize: 'vertical' }
export const selectStyle = { ...inputStyle, background: 'var(--surface)' }
export const pill = { padding: '6px 14px', borderRadius: 999, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer' }
