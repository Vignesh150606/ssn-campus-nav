// Campus Copilot — Phase 1 orchestration.
//
// The backend (/api/copilot/chat) only classifies text. Everything that
// actually touches live data — which buildings exist, where the user is,
// which events are on today, how far/long a route is — happens here, using
// the *existing* api.js calls and utils/geo.js + utils/facilities.js
// helpers. Nothing here re-implements routing, distance math, or event
// logic that already exists elsewhere in the app.
//
// `runTurn(message, state, deps)` is the single entry point. `state` is a
// small plain object the caller (ChatbotWidget) persists between turns —
// this is the "context memory" / multi-turn conversation support: whatever
// was last shown is kept here so a follow-up like "navigate" or "which one
// is closest?" can be resolved without asking the backend again.
import { copilotChat } from './copilotApi'
import { haversine } from '../utils/geo'
import { nearestWithFacility } from '../utils/facilities'
import { getEvents, getRoute, getRouteFromCoords } from '../api'

const NEED_LABELS = {
  dining: 'somewhere to eat',
  water_station: 'a water station',
  restroom: 'a restroom',
  parking: 'parking',
  medical: 'the medical center',
}

function distanceLabel(meters) {
  if (meters == null) return null
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km away` : `${Math.round(meters)} m away`
}

function locationCard(loc, { position, actions = ['preview', 'start'], extraMeta = null } = {}) {
  const dist = position ? haversine(position.lat, position.lng, loc.lat, loc.lng) : null
  return {
    type: 'location',
    id: loc.id,
    title: loc.name,
    subtitle: extraMeta?.subtitleOverride ?? (dist != null ? distanceLabel(dist) : (loc.department || null)),
    distance: dist,
    description: loc.description,
    location: { id: loc.id, name: loc.name, lat: loc.lat, lng: loc.lng },
    meta: extraMeta,
    actions,
  }
}

function timeLabel(ev) {
  return `${ev.start_time}–${ev.end_time}`
}

function eventCard(ev) {
  return {
    type: 'event',
    id: ev.id,
    title: ev.name,
    subtitle: `${timeLabel(ev)} · ${ev.location?.name || ev.location_id}`,
    description: ev.description,
    thumbnail: ev.poster_url || null,
    fest: ev.fest,
    event: ev,
    location: ev.location ? { id: ev.location.id, name: ev.location.name, lat: ev.location.lat, lng: ev.location.lng } : null,
    actions: ['details', 'preview', 'start'],
  }
}

function infoCard(title, description) {
  return { type: 'info', title, description }
}

const todayStr = () => new Date().toISOString().slice(0, 10)
const nowHHMM = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function fetchVerifiedEvents() {
  const events = await getEvents()
  return events // backend already filters to status === 'verified'
}

function sortByDate(events) {
  return [...events].sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time))
}

async function handleEventIntent(intent) {
  const events = await fetchVerifiedEvents()
  const today = todayStr()
  const now = nowHHMM()

  let filtered
  let emptyMessage
  if (intent === 'event_now') {
    filtered = events.filter(e => e.date === today && e.start_time <= now && now <= e.end_time)
    emptyMessage = "Nothing is happening on campus right now — try asking for today's or upcoming events."
  } else if (intent === 'event_today') {
    filtered = events.filter(e => e.date === today)
    emptyMessage = "There's nothing scheduled for today."
  } else if (intent === 'event_upcoming') {
    filtered = events.filter(e => e.date > today || (e.date === today && e.start_time > now))
    emptyMessage = "I don't see any upcoming events posted yet."
  } else {
    filtered = events
    emptyMessage = 'No events have been posted yet.'
  }
  filtered = sortByDate(filtered)

  if (filtered.length === 0) {
    return { replyText: emptyMessage, cards: [], state: {} }
  }
  const label = { event_now: "Happening right now", event_today: "Today's events", event_upcoming: 'Coming up' }[intent] || 'Events'
  return {
    replyText: `${label} (${filtered.length}):`,
    cards: filtered.slice(0, 8).map(eventCard),
    state: { lastCandidates: filtered.map(e => ({ kind: 'event', id: e.id })) },
  }
}

function buildingFinderResultToCards(result, locationsById, position) {
  const matches = result.resolved_locations || []
  const cards = matches
    .filter(m => locationsById[m.id])
    .slice(0, 3)
    .map(m => locationCard(locationsById[m.id], { position }))
  return cards
}

async function handleNeedIntent(result, locationsById, allLocations, position) {
  const needType = result.need_type

  if (result.direct_location_id) {
    const loc = locationsById[result.direct_location_id]
    if (!loc) return { replyText: result.reply, cards: [], state: {} }
    return {
      replyText: result.reply,
      cards: [locationCard(loc, { position })],
      state: { lastCandidates: [{ kind: 'location', id: loc.id }], lastLocationId: loc.id },
    }
  }

  if (needType === 'dining') {
    const dining = allLocations.filter(l => l.category === 'dining')
    const withDist = dining.map(l => ({ l, d: position ? haversine(position.lat, position.lng, l.lat, l.lng) : null }))
    withDist.sort((a, b) => (a.d ?? 0) - (b.d ?? 0))
    const cards = withDist.slice(0, 5).map(({ l }) => locationCard(l, { position }))
    return {
      replyText: cards.length ? result.reply : "I couldn't find any dining spots in the system.",
      cards,
      state: { lastCandidates: withDist.map(({ l }) => ({ kind: 'location', id: l.id })), needType },
    }
  }

  if (needType === 'parking' || needType === 'medical') {
    const category = needType === 'parking' ? 'parking' : 'medical'
    const matches = allLocations.filter(l => l.category === category)
    const cards = matches.map(l => locationCard(l, { position }))
    return {
      replyText: cards.length ? result.reply : `I don't have a ${NEED_LABELS[needType]} location on record.`,
      cards,
      state: { lastCandidates: matches.map(l => ({ kind: 'location', id: l.id })) },
    }
  }

  // restroom / water_station — single nearest, via the existing helper.
  if (!position) {
    // No GPS fix yet — fall back to listing every building with that facility.
    const matches = allLocations.filter(l => l.facilities?.includes(needType))
    const cards = matches.map(l => locationCard(l, { position }))
    return {
      replyText: cards.length
        ? `I don't have your location yet, so here's every building with ${NEED_LABELS[needType]}:`
        : `I couldn't find a building with ${NEED_LABELS[needType]} on record.`,
      cards,
      state: { lastCandidates: matches.map(l => ({ kind: 'location', id: l.id })) },
    }
  }
  const best = nearestWithFacility(allLocations, position.lat, position.lng, needType)
  if (!best) {
    return { replyText: `I couldn't find a building with ${NEED_LABELS[needType]} on record.`, cards: [], state: {} }
  }
  return {
    replyText: result.reply,
    cards: [locationCard(best.location, { position })],
    state: { lastCandidates: [{ kind: 'location', id: best.location.id }], lastLocationId: best.location.id },
  }
}

function currentLocationTurn(allLocations, position) {
  if (!position) {
    return { replyText: "I don't have a GPS fix yet — enable location to see where you are.", cards: [], state: {} }
  }
  let nearest = null
  for (const loc of allLocations) {
    const d = haversine(position.lat, position.lng, loc.lat, loc.lng)
    if (!nearest || d < nearest.d) nearest = { loc, d }
  }
  if (!nearest) return { replyText: "I don't have any campus locations to compare against.", cards: [], state: {} }
  return {
    replyText: `You're closest to ${nearest.loc.name} (${distanceLabel(nearest.d)}).`,
    cards: [locationCard(nearest.loc, { position, actions: ['preview', 'start'] })],
    state: { lastLocationId: nearest.loc.id, lastCandidates: [{ kind: 'location', id: nearest.loc.id }] },
  }
}

async function etaForLocation(locId, position) {
  try {
    const route = position ? await getRouteFromCoords(position.lat, position.lng, locId) : await getRoute('main-gate', locId)
    return route
  } catch {
    return null
  }
}

async function handleFollowUp(intent, state, locationsById, position) {
  const last = (state.lastCandidates || [])
  const lastLocId = state.lastLocationId || (last.length === 1 && last[0].kind === 'location' ? last[0].id : null)

  if (intent === 'follow_up_filter_closest') {
    const locCandidates = last.filter(c => c.kind === 'location').map(c => locationsById[c.id]).filter(Boolean)
    if (locCandidates.length === 0 || !position) {
      return { replyText: "I don't have enough information to compare distances right now.", cards: [], state: {} }
    }
    const sorted = [...locCandidates].sort((a, b) =>
      haversine(position.lat, position.lng, a.lat, a.lng) - haversine(position.lat, position.lng, b.lat, b.lng))
    return {
      replyText: `${sorted[0].name} is the closest.`,
      cards: [locationCard(sorted[0], { position })],
      state: { lastLocationId: sorted[0].id },
    }
  }

  if (intent === 'follow_up_filter_unsupported') {
    return { replyText: "I don't have dietary information (veg/non-veg) for these places yet — best to check at the counter.", cards: [], state: {} }
  }

  if (intent === 'follow_up_eta') {
    if (!lastLocId || !locationsById[lastLocId]) {
      return { replyText: "Let me know a destination first and I can estimate the time.", cards: [], state: {} }
    }
    const route = await etaForLocation(lastLocId, position)
    if (!route) return { replyText: "I couldn't calculate a route right now.", cards: [], state: {} }
    const dist = route.distance_m >= 1000 ? `${(route.distance_m / 1000).toFixed(1)} km` : `${Math.round(route.distance_m)} m`
    return {
      replyText: `About ${route.eta_minutes} min (${dist}) to ${locationsById[lastLocId].name}.`,
      cards: [locationCard(locationsById[lastLocId], { position })],
      state: { lastLocationId: lastLocId },
    }
  }

  if (intent === 'follow_up_navigate' || intent === 'follow_up_preview') {
    if (!lastLocId || !locationsById[lastLocId]) {
      return {
        replyText: "I don't have a destination in mind yet — ask me for a building, department, or facility first.",
        cards: [], state: {},
      }
    }
    return {
      replyText: null, // signal: caller should perform the actual navigation/preview action
      cards: [],
      state: { lastLocationId: lastLocId },
      action: { type: intent === 'follow_up_navigate' ? 'start_navigation' : 'preview_route', locationId: lastLocId },
    }
  }

  if (intent === 'follow_up_details') {
    const lastEvent = last.find(c => c.kind === 'event')
    if (lastEvent) {
      return { replyText: null, cards: [], state: {}, action: { type: 'view_event_details', eventId: lastEvent.id } }
    }
    if (lastLocId && locationsById[lastLocId]) {
      return { replyText: locationsById[lastLocId].description || 'No further details available.', cards: [locationCard(locationsById[lastLocId], { position })], state: {} }
    }
    return { replyText: "I don't have anything to show details for yet.", cards: [], state: {} }
  }

  return { replyText: "I'm not sure what to do with that yet.", cards: [], state: {} }
}

/**
 * The single entry point. `deps = { locations, position }`. Returns
 * { replyText, cards, newState, action }. `action`, when present, tells
 * the caller (ChatbotWidget, which has access to Home's real navigation
 * handlers) to actually start/preview navigation or open an event page —
 * this engine never touches routing or navigation state directly.
 */
export async function runTurn(message, state, deps) {
  const { locations, position } = deps
  const locationsById = Object.fromEntries(locations.map(l => [l.id, l]))

  const result = await copilotChat(message, { hasPending: !!(state.lastCandidates?.length) })
  const intent = result.intent

  // Anything that isn't a follow-up is a fresh topic — start from a clean
  // slate so leftover context (e.g. a classroom's room/floor info, or a
  // previous candidate list) can't leak into an unrelated later request.
  const isFollowUp = intent.startsWith('follow_up_')
  const baseState = isFollowUp ? state : {}

  let outcome
  switch (intent) {
    case 'classroom_finder': {
      const loc = locationsById[result.classroom.dept_location_id]
      const meta = { room: result.classroom.room_label, floor: result.classroom.floor_guess, wing: null, building: loc?.name }
      outcome = loc
        ? { replyText: result.reply, cards: [locationCard(loc, { position, extraMeta: meta })], state: { lastLocationId: loc.id, lastCandidates: [{ kind: 'location', id: loc.id }], pendingClassroom: meta } }
        : { replyText: result.reply, cards: [], state: {} }
      break
    }
    case 'building_finder':
    case 'department_finder': {
      const cards = buildingFinderResultToCards(result, locationsById, position)
      outcome = {
        replyText: result.reply,
        cards,
        state: cards.length ? { lastLocationId: cards[0].id, lastCandidates: cards.map(c => ({ kind: 'location', id: c.id })) } : {},
      }
      break
    }
    case 'need':
      outcome = await handleNeedIntent(result, locationsById, locations, position)
      break
    case 'event_now':
    case 'event_today':
    case 'event_upcoming':
    case 'event_list':
      outcome = await handleEventIntent(intent)
      break
    case 'current_location':
      outcome = currentLocationTurn(locations, position)
      break
    case 'follow_up_navigate':
    case 'follow_up_preview':
    case 'follow_up_eta':
    case 'follow_up_details':
    case 'follow_up_filter_closest':
    case 'follow_up_filter_unsupported':
      outcome = await handleFollowUp(intent, state, locationsById, position)
      break
    case 'greeting':
    case 'out_of_scope':
    case 'unknown':
    default:
      outcome = { replyText: result.reply, cards: [], state: {} }
      break
  }

  return {
    replyText: outcome.replyText,
    cards: outcome.cards || [],
    action: outcome.action || null,
    newState: { ...baseState, ...outcome.state, lastIntent: intent },
  }
}

export { locationCard, eventCard, infoCard, distanceLabel }
