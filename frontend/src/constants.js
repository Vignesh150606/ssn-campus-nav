// Shared design tokens (mirrors src/index.css custom properties) and
// category -> color/label mapping used by the map markers, chips and lists.

export const CATEGORY_META = {
  academic:   { label: 'Academic block', color: '#3A6EA5' },
  hostel:     { label: 'Hostel',          color: '#8E6C88' },
  dining:     { label: 'Food & dining',   color: '#E07414' },
  gate:       { label: 'Gate',            color: '#1FB6A6' },
  library:    { label: 'Library',         color: '#5C6470' },
  auditorium: { label: 'Auditorium / venue', color: '#E03E52' },
  sports:     { label: 'Sports',          color: '#2E9E5B' },
  admin:      { label: 'Admin',           color: '#6B7280' },
  medical:    { label: 'Medical',         color: '#D7263D' },
  parking:    { label: 'Parking',         color: '#9AA5B1' },
  landmark:   { label: 'Landmark',        color: '#9C6ADE' },
}

export const FEST_META = {
  Invente:   { label: 'Invente · Tech Fest',     color: '#E03E52' },
  Instincts: { label: 'Instincts · Cultural Fest', color: '#1FB6A6' },
}

export const DEFAULT_ENTRY_ID = 'main-gate'

// Priority 4 — Campus naming consistency.
// The backend (Supabase `venues` table) still stores the old raw names for
// a handful of venues ("TCS Auditorium (Main)", "Ashwin's Food Court",
// "SSN Fountain / Clock Tower", etc). Renaming those rows isn't done here
// (out of scope — no Supabase schema/data changes), so every place in the
// frontend that displays a venue name goes through this ONE override map
// instead of each component keeping its own (previously-duplicated, and in
// two places out-of-date) copy. Do NOT change the ids — routing, the
// walkway graph and coordinates all key off the unchanged id.
export const LOCATION_NAME_OVERRIDES = {
  'tcs-auditorium': 'Main Auditorium',
  'mini-hall-1':    'Mini Auditorium',
  'clock-tower':    'SSN Clock Tower',
  'food-aswins':    'Aswins Food Court',
}

/** Canonical display name for a venue/location. Accepts either a location
 *  object ({id, name, ...}) or an id + fallback name pair. Always prefer
 *  this over reading `.name` directly when the value will be shown to a
 *  user (search, map, bottom sheet, navigation, copilot, admin, food menu,
 *  route preview, share links — anywhere a venue name appears). */
export function displayLocationName(locOrId, fallbackName) {
  if (locOrId && typeof locOrId === 'object') {
    const id = locOrId.id ?? locOrId.location_id
    return LOCATION_NAME_OVERRIDES[id] || locOrId.name || fallbackName || id || '—'
  }
  return LOCATION_NAME_OVERRIDES[locOrId] || fallbackName || locOrId || '—'
}
