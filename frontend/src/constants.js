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
