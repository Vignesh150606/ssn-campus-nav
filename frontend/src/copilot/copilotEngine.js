// Campus Copilot — Phase 2 orchestration.
//
// Phase 2 additions (all new intents handled here; no routing/GPS code changed):
//  • event_near_me   — events sorted by distance from user
//  • event_upcoming_30 — events starting in next 30 min (fallback: next upcoming)
//  • distance_query  — "how far is X from Y?" — haversine + ETA
//  • nearby_search   — "what's near me?" — closest buildings + events + facilities
//  • info_mode flag  — "tell me about X" → shows description before nav card
//  • suggestions[]   — 2-4 contextual follow-up chips appended to every response
//  • follow_up_cancel_nav — cancel active navigation from chat
import { copilotChat } from './copilotApi'
import { haversine } from '../utils/geo'
import { nearestWithFacility } from '../utils/facilities'
import { getEvents, getRoute, getRouteFromCoords, getVenueMenu } from '../api'
import { displayLocationName } from '../constants'

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

// Priority 4 — the backend intent-classifier (utils/copilot.py) is
// deliberately "dumb": it builds its canned `reply` string from the venue's
// raw Supabase name before any of this file's canonical-name logic runs.
// Rather than teach the backend about display-name overrides too (a second
// copy of the same map), patch the one substring that can be wrong straight
// in the reply text, using the same override already applied to `loc`.
function fixReplyName(reply, loc) {
  if (!reply || !loc?.name) return reply
  const canonical = displayLocationName(loc)
  return canonical !== loc.name ? reply.split(loc.name).join(canonical) : reply
}

function locationCard(loc, { position, actions = ['preview', 'start'], extraMeta = null } = {}) {
  const dist = position ? haversine(position.lat, position.lng, loc.lat, loc.lng) : null
  const name = displayLocationName(loc)
  return {
    type: 'location',
    id: loc.id,
    title: name,
    subtitle: extraMeta?.subtitleOverride ?? (dist != null ? distanceLabel(dist) : (loc.department || null)),
    distance: dist,
    eta: dist ? Math.round(dist / 1.4 / 60) : null,
    description: loc.description,
    location: { id: loc.id, name, lat: loc.lat, lng: loc.lng },
    meta: extraMeta,
    actions,
  }
}

function timeLabel(ev) { return `${ev.start_time}–${ev.end_time}` }

function eventCard(ev, position) {
  const dist = (position && ev.location)
    ? haversine(position.lat, position.lng, ev.location.lat, ev.location.lng)
    : null
  const eta = dist ? Math.round(dist / 1.4 / 60) : null

  // Status badge: "Now" / "In X min" / date
  const today = todayStr()
  const now = nowHHMM()
  let statusBadge = null
  if (ev.date === today) {
    if (ev.start_time <= now && now <= ev.end_time) statusBadge = '🔴 Happening now'
    else if (ev.start_time > now) {
      const diffMin = hhmm2min(ev.start_time) - hhmm2min(now)
      statusBadge = diffMin <= 30 ? `⏰ Starts in ${diffMin} min` : null
    }
  }

  return {
    type: 'event',
    id: ev.id,
    title: ev.name,
    subtitle: `${timeLabel(ev)} · ${displayLocationName(ev.location || ev.location_id)}${dist ? ` · ${distanceLabel(dist)}` : ''}`,
    distance: dist,
    eta,
    statusBadge,
    description: ev.description,
    thumbnail: ev.poster_url || null,
    fest: ev.fest,
    event: ev,
    location: ev.location
      ? { id: ev.location.id, name: displayLocationName(ev.location), lat: ev.location.lat, lng: ev.location.lng }
      : null,
    actions: ['details', 'preview', 'start'],
  }
}

function infoCard(title, description) {
  return { type: 'info', title, description }
}

const todayStr = () => new Date().toISOString().slice(0, 10)
const nowHHMM  = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const hhmm2min = (hhmm) => {
  const [h, m] = (hhmm || '00:00').split(':').map(Number)
  return h * 60 + m
}
const addMinutes = (hhmm, min) => {
  const total = hhmm2min(hhmm) + min
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

async function fetchVerifiedEvents() {
  const events = await getEvents()
  return events
}

function sortByDate(events) {
  return [...events].sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time))
}

// ── Event intent handlers ──────────────────────────────────────────────────

async function handleEventIntent(intent, position) {
  const events = await fetchVerifiedEvents()
  const today = todayStr()
  const now = nowHHMM()

  let filtered, emptyMessage
  if (intent === 'event_now') {
    filtered = events.filter(e => e.date === today && e.start_time <= now && now <= e.end_time)
    emptyMessage = "Nothing is happening right now — try asking for today's or upcoming events."
  } else if (intent === 'event_today') {
    filtered = events.filter(e => e.date === today)
    emptyMessage = "There's nothing scheduled for today."
  } else if (intent === 'event_upcoming') {
    filtered = events.filter(e => e.date > today || (e.date === today && e.start_time > now))
    emptyMessage = "No upcoming events posted yet."
  } else {
    filtered = events
    emptyMessage = 'No events have been posted yet.'
  }

  // Sort now/near-me by distance; others by time
  if (position && (intent === 'event_now')) {
    filtered = [...filtered].sort((a, b) => {
      const da = a.location ? haversine(position.lat, position.lng, a.location.lat, a.location.lng) : Infinity
      const db = b.location ? haversine(position.lat, position.lng, b.location.lat, b.location.lng) : Infinity
      return da - db
    })
  } else {
    filtered = sortByDate(filtered)
  }

  if (filtered.length === 0) {
    return {
      replyText: emptyMessage, cards: [], state: {},
      suggestions: ["Today's schedule", "What's upcoming?", "Events near me"],
    }
  }

  const label = {
    event_now: 'Happening right now',
    event_today: "Today's events",
    event_upcoming: 'Coming up',
  }[intent] || 'Events'

  return {
    replyText: `${label} (${filtered.length}):`,
    cards: filtered.slice(0, 8).map(ev => eventCard(ev, position)),
    state: { lastCandidates: filtered.map(e => ({ kind: 'event', id: e.id })) },
    suggestions: intent === 'event_now'
      ? ["Navigate to nearest", "Today's full schedule", "Events near me"]
      : ["What's happening now?", "Events near me", "What starts next?"],
  }
}

async function handleEventNearMe(position) {
  const events = await fetchVerifiedEvents()
  const today = todayStr()

  // All today's + upcoming events that have a location
  let filtered = events.filter(e =>
    (e.date === today || e.date > today) && e.location
  )

  if (!position) {
    filtered = sortByDate(filtered.filter(e => e.date === today)).slice(0, 8)
    return {
      replyText: filtered.length
        ? "Here are today's events (enable location for distance sorting):"
        : "No events today.",
      cards: filtered.map(ev => eventCard(ev, null)),
      state: { lastCandidates: filtered.map(e => ({ kind: 'event', id: e.id })) },
      suggestions: ["What's happening now?", "Today's schedule"],
    }
  }

  filtered.sort((a, b) => {
    const da = haversine(position.lat, position.lng, a.location.lat, a.location.lng)
    const db = haversine(position.lat, position.lng, b.location.lat, b.location.lng)
    return da - db
  })

  const cards = filtered.slice(0, 8).map(ev => eventCard(ev, position))
  return {
    replyText: filtered.length ? `Events sorted by distance from you (${filtered.length}):` : "No events found nearby.",
    cards,
    state: { lastCandidates: filtered.map(e => ({ kind: 'event', id: e.id })) },
    suggestions: ["Navigate to nearest", "What's on right now?", "Today's full schedule"],
  }
}

async function handleEventUpcoming30(position) {
  const events = await fetchVerifiedEvents()
  const today = todayStr()
  const now = nowHHMM()
  const in30 = addMinutes(now, 30)

  let soon = events.filter(e =>
    e.date === today && e.start_time > now && e.start_time <= in30
  )
  soon = sortByDate(soon)

  if (soon.length > 0) {
    return {
      replyText: `Starting in the next 30 minutes (${soon.length}):`,
      cards: soon.map(ev => eventCard(ev, position)),
      state: { lastCandidates: soon.map(e => ({ kind: 'event', id: e.id })) },
      suggestions: ["Navigate to first one", "What's on right now?", "Today's full schedule"],
    }
  }

  // Fallback: next upcoming events (today or future)
  const upcoming = sortByDate(
    events.filter(e => e.date > today || (e.date === today && e.start_time > now))
  ).slice(0, 5)

  if (upcoming.length === 0) {
    return {
      replyText: "Nothing coming up soon.",
      cards: [], state: {},
      suggestions: ["What's happening now?", "Today's schedule"],
    }
  }

  return {
    replyText: `Nothing in the next 30 minutes — here's what's coming up next:`,
    cards: upcoming.map(ev => eventCard(ev, position)),
    state: { lastCandidates: upcoming.map(e => ({ kind: 'event', id: e.id })) },
    suggestions: ["Navigate to first one", "What's on right now?", "Today's full schedule"],
  }
}

// ── Building / location handlers ──────────────────────────────────────────

function buildingFinderResultToCards(result, locationsById, position) {
  const matches = result.resolved_locations || []
  return matches
    .filter(m => locationsById[m.id])
    .slice(0, 3)
    .map(m => locationCard(locationsById[m.id], { position }))
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
      suggestions: ['Navigate there', 'How long will it take?'],
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
      suggestions: cards.length > 1 ? ['Which is closest?', 'Navigate to first one'] : ['Navigate there'],
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
      suggestions: ['Navigate there'],
    }
  }

  // restroom / water_station — single nearest
  if (!position) {
    const matches = allLocations.filter(l => l.facilities?.includes(needType))
    const cards = matches.map(l => locationCard(l, { position }))
    return {
      replyText: cards.length
        ? `I don't have your location yet, so here's every building with ${NEED_LABELS[needType]}:`
        : `I couldn't find a building with ${NEED_LABELS[needType]} on record.`,
      cards,
      state: { lastCandidates: matches.map(l => ({ kind: 'location', id: l.id })) },
      suggestions: ['Enable location for nearest result'],
    }
  }
  const best = nearestWithFacility(allLocations, position.lat, position.lng, needType)
  if (!best) return { replyText: `I couldn't find a building with ${NEED_LABELS[needType]} on record.`, cards: [], state: {} }
  return {
    replyText: result.reply,
    cards: [locationCard(best.location, { position })],
    state: { lastCandidates: [{ kind: 'location', id: best.location.id }], lastLocationId: best.location.id },
    suggestions: ['Navigate there', 'How long will it take?'],
  }
}

function currentLocationTurn(allLocations, position) {
  if (!position) {
    return {
      replyText: "I don't have a GPS fix yet — enable location to see where you are.",
      cards: [], state: {},
      suggestions: ["What's happening today?", "Where is the Library?"],
    }
  }
  let nearest = null
  for (const loc of allLocations) {
    const d = haversine(position.lat, position.lng, loc.lat, loc.lng)
    if (!nearest || d < nearest.d) nearest = { loc, d }
  }
  if (!nearest) return { replyText: "No campus locations to compare against.", cards: [], state: {} }
  return {
    replyText: `You're closest to ${displayLocationName(nearest.loc)} (${distanceLabel(nearest.d)}).`,
    cards: [locationCard(nearest.loc, { position })],
    state: { lastLocationId: nearest.loc.id, lastCandidates: [{ kind: 'location', id: nearest.loc.id }] },
    suggestions: ["What's nearby?", "Nearest canteen", "What's on today?"],
  }
}

// Phase 2 — Nearby search: top 5 closest locations
function nearbySearchTurn(allLocations, position) {
  if (!position) {
    return {
      replyText: "Enable location to see what's near you.",
      cards: [], state: {},
      suggestions: ["Where is the Library?", "What's happening today?"],
    }
  }
  const sorted = [...allLocations]
    .map(l => ({ ...l, _dist: haversine(position.lat, position.lng, l.lat, l.lng) }))
    .sort((a, b) => a._dist - b._dist)
    .slice(0, 6)

  return {
    replyText: "Here's what's near you:",
    cards: sorted.map(l => locationCard(l, { position })),
    state: { lastCandidates: sorted.map(l => ({ kind: 'location', id: l.id })) },
    suggestions: ["What events are near me?", "Nearest canteen", "Nearest restroom"],
  }
}

// Phase 2 — Distance query: haversine between two locations
function distanceQueryTurn(result, locationsById, position) {
  const fromLoc = result.resolved_from?.[0]?.id ? locationsById[result.resolved_from[0].id] : null
  const toLoc   = result.resolved_to?.[0]?.id   ? locationsById[result.resolved_to[0].id]   : null

  if (!fromLoc || !toLoc) {
    return {
      replyText: result.reply || "I couldn't identify both locations. Try: \"How far is Library from ECE Block?\"",
      cards: [], state: {},
      suggestions: ["How far is Library from ECE?", "Where is the Library?"],
    }
  }

  const dist  = haversine(fromLoc.lat, fromLoc.lng, toLoc.lat, toLoc.lng)
  const eta   = Math.round(dist / 1.4 / 60)
  const dStr  = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`

  return {
    replyText: `${displayLocationName(fromLoc)} → ${displayLocationName(toLoc)}: about ${dStr} (${eta} min walking).`,
    cards: [locationCard(toLoc, { position })],
    state: { lastLocationId: toLoc.id, lastCandidates: [{ kind: 'location', id: toLoc.id }] },
    suggestions: ['Navigate there', 'How long will it take?', "What's nearby?"],
  }
}

async function etaForLocation(locId, position) {
  try {
    return position
      ? await getRouteFromCoords(position.lat, position.lng, locId)
      : await getRoute('main-gate', locId)
  } catch { return null }
}

async function handleFollowUp(intent, state, locationsById, position) {
  const last = (state.lastCandidates || [])
  const lastLocId = state.lastLocationId || (last.length === 1 && last[0].kind === 'location' ? last[0].id : null)

  if (intent === 'follow_up_filter_closest') {
    const locCandidates = last.filter(c => c.kind === 'location').map(c => locationsById[c.id]).filter(Boolean)
    if (locCandidates.length === 0 || !position) {
      return { replyText: "I don't have enough information to compare distances.", cards: [], state: {} }
    }
    const sorted = [...locCandidates].sort((a, b) =>
      haversine(position.lat, position.lng, a.lat, a.lng) - haversine(position.lat, position.lng, b.lat, b.lng))
    return {
      replyText: `${displayLocationName(sorted[0])} is the closest.`,
      cards: [locationCard(sorted[0], { position })],
      state: { lastLocationId: sorted[0].id },
      suggestions: ['Navigate there', 'How long will it take?'],
    }
  }

  if (intent === 'follow_up_filter_unsupported') {
    return { replyText: "I don't have dietary info (veg/non-veg) yet — best to check at the counter.", cards: [], state: {} }
  }

  if (intent === 'follow_up_eta') {
    if (!lastLocId || !locationsById[lastLocId]) {
      return { replyText: "Tell me a destination first and I can estimate the time.", cards: [], state: {} }
    }
    const route = await etaForLocation(lastLocId, position)
    if (!route) return { replyText: "I couldn't calculate a route right now.", cards: [], state: {} }
    const dist = route.distance_m >= 1000 ? `${(route.distance_m / 1000).toFixed(1)} km` : `${Math.round(route.distance_m)} m`
    return {
      replyText: `About ${route.eta_minutes} min (${dist}) to ${displayLocationName(locationsById[lastLocId])}.`,
      cards: [locationCard(locationsById[lastLocId], { position })],
      state: { lastLocationId: lastLocId },
      suggestions: ['Navigate there', 'Show route preview'],
    }
  }

  if (intent === 'follow_up_navigate' || intent === 'follow_up_preview') {
    if (!lastLocId || !locationsById[lastLocId]) {
      return {
        replyText: "I don't have a destination in mind — ask about a building, department, or facility first.",
        cards: [], state: {},
      }
    }
    return {
      replyText: null, cards: [], state: { lastLocationId: lastLocId },
      action: { type: intent === 'follow_up_navigate' ? 'start_navigation' : 'preview_route', locationId: lastLocId },
    }
  }

  if (intent === 'follow_up_details') {
    const lastEvent = last.find(c => c.kind === 'event')
    if (lastEvent) {
      return { replyText: null, cards: [], state: {}, action: { type: 'view_event_details', eventId: lastEvent.id } }
    }
    if (lastLocId && locationsById[lastLocId]) {
      const loc = locationsById[lastLocId]
      const cards = [locationCard(loc, { position })]
      if (loc.description) cards.unshift(infoCard(displayLocationName(loc), loc.description))
      return { replyText: loc.description ? null : 'No further details available.', cards, state: {} }
    }
    return { replyText: "Nothing to show details for yet.", cards: [], state: {} }
  }

  if (intent === 'follow_up_cancel_nav') {
    return {
      replyText: "Navigation stopped.",
      cards: [], state: {},
      action: { type: 'cancel_navigation' },
    }
  }

  return { replyText: "I'm not sure what to do with that yet.", cards: [], state: {} }
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function runTurn(message, state, deps) {
  const { locations, position } = deps
  const locationsById = Object.fromEntries(locations.map(l => [l.id, l]))

  const result = await copilotChat(message, { hasPending: !!(state.lastCandidates?.length) })
  const intent = result.intent

  const isFollowUp = intent.startsWith('follow_up_')
  const baseState  = isFollowUp ? state : {}

  let outcome

  switch (intent) {
    case 'classroom_finder': {
      const loc  = locationsById[result.classroom.dept_location_id]
      const meta = { room: result.classroom.room_label, floor: result.classroom.floor_guess, wing: null, building: loc ? displayLocationName(loc) : null }
      outcome = loc
        ? {
            replyText: fixReplyName(result.reply, loc),
            cards: [locationCard(loc, { position, extraMeta: meta })],
            state: { lastLocationId: loc.id, lastCandidates: [{ kind: 'location', id: loc.id }], pendingClassroom: meta },
            suggestions: ['Navigate there', 'How long will it take?'],
          }
        : { replyText: result.reply, cards: [], state: {} }
      break
    }

    case 'building_finder':
    case 'department_finder': {
      const cards = buildingFinderResultToCards(result, locationsById, position)

      if (result.info_mode && cards.length > 0) {
        // "Tell me about X" → info card first, then nav card
        const topLoc = locationsById[cards[0].id]
        const allCards = []
        if (topLoc?.description) {
          let desc = topLoc.description
          if (topLoc.department) desc += `\n\nDepartment: ${topLoc.department}`
          if (topLoc.floors)     desc += `\nFloors: ${topLoc.floors}`
          allCards.push(infoCard(displayLocationName(topLoc), desc))
        }
        allCards.push(...cards)
        outcome = {
          replyText: fixReplyName(result.reply, topLoc),
          cards: allCards,
          state: cards.length ? { lastLocationId: cards[0].id, lastCandidates: cards.map(c => ({ kind: 'location', id: c.id })) } : {},
          suggestions: ['Navigate there', 'What events are happening there?', "What's nearby?"],
        }
      } else {
        outcome = {
          replyText: fixReplyName(result.reply, locationsById[cards[0]?.id]),
          cards,
          state: cards.length ? { lastLocationId: cards[0].id, lastCandidates: cards.map(c => ({ kind: 'location', id: c.id })) } : {},
          suggestions: cards.length > 1
            ? ['Which is closest?', 'Navigate to first one']
            : ['Navigate there', 'How long will it take?', "What's nearby?"],
        }
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
      outcome = await handleEventIntent(intent, position)
      break

    case 'event_near_me':
      outcome = await handleEventNearMe(position)
      break

    case 'event_upcoming_30':
      outcome = await handleEventUpcoming30(position)
      break

    case 'nearby_search':
      outcome = nearbySearchTurn(locations, position)
      break

    case 'distance_query':
      outcome = distanceQueryTurn(result, locationsById, position)
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
    case 'follow_up_cancel_nav':
      outcome = await handleFollowUp(intent, state, locationsById, position)
      break

    case 'venue_menu': {
      // "What's today's menu?" / "Show Main Canteen menu."
      const menuLocs = (result.resolved_locations || [])
        .map(r => locationsById[r.id])
        .filter(Boolean)
        .filter(l => ['food','dining'].includes(l?.category))
      if (menuLocs.length === 0) {
        // Fall back to all food venues
        const all = locations.filter(l => ['food','dining'].includes(l?.category))
        outcome = {
          replyText: all.length
            ? `Here are today's menus for SSN food courts.`
            : `I don't have any food courts on record.`,
          cards: all.map(l => locationCard(l, { position })),
          state: {},
          suggestions: all.length ? ['Navigate to Main Canteen', 'Nearest canteen'] : [],
        }
      } else {
        // Specific venue(s) requested — also attempt to fetch menu image.
        // This is the same getVenueMenu() call (same /api/locations/{id}/menu
        // endpoint) that VenueMenuCard uses, so Copilot never disagrees with
        // what the food court preview panel shows — one data source, not two.
        const cards = await Promise.all(menuLocs.map(async (l) => {
          const base = locationCard(l, { position })
          try {
            const menu = await getVenueMenu(l.id)
            if (menu?.image_url) {
              base.menuImageUrl = menu.image_url
              base.menuDescription = menu.description || null
            } else {
              base.noMenuToday = true
            }
          } catch (err) {
            if (err.status === 404) {
              base.noMenuToday = true   // genuinely no menu today — card still shown, flagged
            } else {
              base.menuError = true     // real backend failure — must not be shown as "no menu"
            }
          }
          return base
        }))
        // result.reply is a canned string from the NLU layer, written before
        // any real menu data was looked up ("Here's today's menu at X") — it
        // can't be trusted once we actually know whether a menu exists, so
        // build the reply from the fetched data instead of the canned text.
        const withMenu = cards.filter(c => c.menuImageUrl)
        const withError = cards.filter(c => c.menuError)
        const replyText = withMenu.length
          ? `Here's today's menu at ${withMenu[0].title}.`
          : withError.length
            ? `I couldn't load the menu right now — the menu service seems to be having an issue. Try again in a bit.`
            : `No menu uploaded for today at ${menuLocs.map(l => displayLocationName(l)).join(', ')}.`
        outcome = {
          replyText,
          cards,
          state: { lastLocationId: menuLocs[0].id },
          suggestions: ['Navigate there', 'Nearest canteen'],
        }
      }
      break
    }

    case 'greeting':
    case 'out_of_scope':
    case 'unknown':
    default:
      outcome = {
        replyText: result.reply, cards: [], state: {},
        suggestions: ['Where is the Library?', "What's happening today?", 'Nearest canteen', 'ECE 302'],
      }
      break
  }

  return {
    replyText: outcome.replyText,
    cards:       outcome.cards       || [],
    action:      outcome.action      || null,
    suggestions: outcome.suggestions || [],
    newState: { ...baseState, ...outcome.state, lastIntent: intent },
  }
}
