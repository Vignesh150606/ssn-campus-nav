/** On-device counterpart of utils/copilot.py. Vocabulary parity is checked by
 * verify_local_copilot.mjs; existing cards/actions still live in copilotEngine.
 * No network, credentials or invented campus facts are needed to classify text.
 */
import v from './vocabulary.json'

export const normalize = text => (text || '').toLowerCase().trim().replace(/[?!.,;:'"]+/g, ' ').replace(/\s+/g, ' ').trim()
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const contains = (text, phrase) => !!phrase && new RegExp(`\\b${escape(phrase)}\\b`).test(text)
const hit = (text, phrases) => phrases.some(p => contains(text, p))

// Same contiguous matching-block ratio and tie order as SequenceMatcher for
// the short campus vocabulary. An edit-distance substitute changes rankings.
function ratio(a, b) {
  if (!a || !b || (Math.max(a.length, b.length) > 10 && Math.max(a.length, b.length) > 1.7 * Math.min(a.length, b.length))) return 0
  const positions = new Map()
  for (let j = 0; j < b.length; j++) {
    if (!positions.has(b[j])) positions.set(b[j], [])
    positions.get(b[j]).push(j)
  }
  let matched = 0
  const ranges = [[0, a.length, 0, b.length]]
  while (ranges.length) {
    const [alo, ahi, blo, bhi] = ranges.pop()
    let bestI = alo, bestJ = blo, size = 0, lengths = new Map()
    for (let i = alo; i < ahi; i++) {
      const next = new Map()
      for (const j of positions.get(a[i]) || []) {
        if (j < blo || j >= bhi) continue
        const n = (lengths.get(j - 1) || 0) + 1
        next.set(j, n)
        if (n > size) { bestI = i - n + 1; bestJ = j - n + 1; size = n }
      }
      lengths = next
    }
    if (!size) continue
    matched += size
    if (alo < bestI && blo < bestJ) ranges.push([alo, bestI, blo, bestJ])
    if (bestI + size < ahi && bestJ + size < bhi) ranges.push([bestI + size, ahi, bestJ + size, bhi])
  }
  return 2 * matched / (a.length + b.length)
}
const aliasScore = (text, phrases) => Math.max(0, ...phrases.map(p => Math.max(
  contains(text, p) || contains(p, text) ? 0.9 : 0, ratio(text, p))))

function strip(text) {
  let found = false, changed = true
  while (changed) {
    changed = false
    for (const p of v._COMMAND_PREFIXES) {
      if (text === p || text.startsWith(`${p} `)) {
        text = text.slice(p.length).trim(); found = true; changed = true
      }
    }
  }
  return [text.replace(/\b(please|now)\b/g, '').trim().replace(/\s+/g, ' '), found]
}

export function resolveLocations(query, locations, cutoff = 0.65) {
  query = query.trim()
  if (!query) return []
  return locations.map(loc => {
    const candidates = [loc.name.toLowerCase(), loc.id.replaceAll('-', ' '),
      ...(loc.department ? [loc.department.toLowerCase()] : []), ...(v.LOCATION_ALIASES[loc.id] || [])]
    const score = Math.max(...candidates.map(c => query === c ? 1
      : query && c && (c.includes(query) || contains(query, c))
        ? 0.82 + 0.1 * Math.min(query.length, c.length) / Math.max(query.length, c.length)
        : ratio(query, c)))
    return { id: loc.id, name: loc.name, score: Math.round(score * 1000) / 1000, eligible: score >= cutoff }
  }).filter(r => r.eligible).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(({ id, name, score }) => ({ id, name, score }))
}

const FAQs = [
  {
    questions: ['how do i use this app', 'how to use this app', 'what can you do', 'help me use the app', 'help'],
    reply: 'Search for a building or open an event from its QR code, then choose Get Directions. Preview the walking route and start navigation. I can find departments, rooms, food, water, restrooms and events.',
  },
  {
    questions: ['does this work offline', 'can i use it offline', 'do i need internet', 'does navigation need internet', 'how does offline navigation work'],
    reply: 'Open the app once with internet to save campus data. Directions, search and this assistant can then work on your phone. Only map tiles you have viewed may be available offline. Events, menus and road closures use the last saved data until a connection returns.',
  },
  {
    questions: ['why is my location wrong', 'gps not working', 'location not working', 'how to enable location', 'why can t you find my location'],
    reply: 'Allow location access for this site in your browser or phone settings. Try outdoors where GPS has a clearer signal. Without a usable position, you can still preview a route from the main gate; live tracking needs location access.',
  },
  {
    questions: ['how do i start navigation', 'how to get directions', 'how do i navigate', 'how to navigate'],
    reply: 'Choose a destination in search or an event page, tap Get Directions, then start navigation from the route preview. You can also ask me for a building and choose Navigate on its card.',
  },
  {
    questions: ['are room floors exact', 'are classroom floors accurate', 'how do i find my classroom', 'how to find a classroom'],
    reply: 'Try a room code such as ECE 302 or CSE Lab 4. I can guide you to the department building. Floor guesses from room numbers are estimates; confirm the room, floor and wing at the building directory.',
  },
  {
    questions: ['canteen opening hours', 'what time does the canteen open', 'what time does the library open', 'library opening hours', 'campus opening hours'],
    reply: 'I do not have verified opening hours. Please check with the venue staff. I can help you find the venue or show a menu if one has been uploaded.',
  },
  {
    questions: ['how to contact an organizer', 'how do i contact the organizer', 'organizer contact', 'registration fee', 'how do i register for an event'],
    reply: 'Open the event details and check its posted description for registration instructions. Organizer contact information may be hidden, and I cannot supply missing contact details or registration fees.',
  },
  {
    questions: ['is the route wheelchair accessible', 'are routes wheelchair accessible', 'can i avoid stairs'],
    reply: 'I can list venues marked wheelchair accessible, but the walkway graph does not verify a step-free route. Please confirm the path and entrance with campus staff.',
  },
]

export function classifyLocal(message, locations) {
  const raw = message || '', text = normalize(raw)
  const result = (intent, reply, extra = {}, query = raw) => ({ intent, query_text: query,
    corrected_text: text, reply, need_type: null, direct_location_id: null,
    resolved_locations: [], resolved_from: [], resolved_to: [], classroom: null, info_mode: false, ...extra })
  if (!text) return result('unknown', "Sorry, I didn't catch that — could you type your question?")
  const faq = FAQs.find(f => f.questions.includes(text))
  if (faq) return result('faq', faq.reply)
  if (v.GREETING_PHRASES.includes(text)) return result('greeting', 'Hi! I’m the SSN Campus Copilot. Ask me about a building, classroom, event, or nearby facility. You can also ask how to use the app offline.')

  const room = /^(eee|cse|ece|it|mech|me|civil|ce|biomed|bme|admin|cdc)[\s-]*(.+)$/.exec(text)
  if (room) {
    const part = room[2].replace(/\b(block|building|department|dept)\b/g, '').trim()
    const digits = /^(\d{1,4})[a-z]?$/.exec(part)?.[1]
    if (digits || /^lab[\s-]?\d+$/.test(part)) {
      const classroom = { dept_location_id: v.CLASSROOM_DEPT_CODES[room[1]],
        room_label: digits ? `${room[1].toUpperCase()}-${digits}` : part.toUpperCase().replaceAll('-', ' '),
        floor_guess: digits?.length >= 3 ? `${digits[0]} (estimated from room number)` : null }
      const name = locations.find(l => l.id === classroom.dept_location_id)?.name || classroom.dept_location_id
      return result('classroom_finder', `${classroom.room_label} is in ${name}.` + (classroom.floor_guess
        ? ` That's likely floor ${classroom.floor_guess}, but please confirm at the building entrance.`
        : " I don't have an exact floor/wing for this room — check the building directory on arrival."),
      { classroom, resolved_locations: [{ id: classroom.dept_location_id, name, score: 1 }] })
    }
  }
  if (v.DEPARTMENT_KEYWORDS.some(k => text.includes(k))) {
    const matches = resolveLocations(strip(text.replace(/\b(department|dept)\b/g, '').trim())[0], locations)
    return result('department_finder', matches.length ? `${matches[0].name} — here's the department info and a route.`
      : "I couldn't match that to a department I know. Try EEE, CSE, ECE, IT, Mechanical, Civil, Biomedical, Admin or the Placement Cell (CDC).", { resolved_locations: matches })
  }
  if (hit(text, v.MENU_PHRASES) || text.includes('menu')) {
    const query = strip(text)[0].replace(/\b(menu|today|show|available)\b/g, '').trim()
    let matches = resolveLocations(query, locations, 0.60)
    if (!matches.length) matches = locations.filter(l => ['food', 'dining'].includes(l.category)).map(l => ({ id: l.id, name: l.name, score: 1 }))
    return result('venue_menu', "Here are today's menus for SSN food courts.", { resolved_locations: matches })
  }
  if (v.NEED_ALIASES_DIRECT.placement.some(p => text.includes(p) || aliasScore(text, [p]) > 0.85)) {
    return result('need', "The Placement Cell (CDC) — here's the route.", { need_type: 'placement', direct_location_id: v.NEED_DIRECT_LOCATION.placement }, text)
  }
  let bestNeed = null, bestScore = 0
  for (const [need, phrases] of Object.entries(v.NEED_ALIASES)) {
    const score = Math.max(aliasScore(text, phrases), hit(text, phrases) ? 0.88 : 0)
    if (score > bestScore) { bestScore = score; bestNeed = need }
  }
  if (bestScore >= 0.72) {
    const replies = { dining: 'Looking for somewhere to eat — here are the nearest options.', water_station: "Here's the nearest water station.", restroom: "Here's the nearest restroom.", parking: "Here's where to park.", medical: "Here's the medical center — head there or ask campus security for first aid.", accessibility: 'Here are the wheelchair-accessible buildings on campus.' }
    return result('need', replies[bestNeed], { need_type: bestNeed }, text)
  }
  if (hit(text, v.EVENT_NEAR_ME_PHRASES)) return result('event_near_me', 'Here are the events nearest to you.')
  if (hit(text, v.EVENT_SOON_PHRASES) || (text.includes('start') && (text.includes('30') || text.includes('soon')) && text.includes('event'))) return result('event_upcoming_30', "Here's what's starting soon.")
  if (hit(text, v.NEARBY_SEARCH_PHRASES) || ['near me', 'nearby'].includes(text)) return result('nearby_search', "Here's what's around you.")
  const distance = /(?:how far is|how far from|how far are)\s+(.+?)\s+(?:from|to|and)\s+(.+?)$|(?:distance|how long|how far)\s+(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+?)$/.exec(text)
  if (distance) {
    const parts = distance.slice(1).filter(Boolean)
    const from = resolveLocations(parts[0], locations), to = resolveLocations(parts[1], locations)
    return result('distance_query', from.length && to.length ? `Calculating distance between ${from[0].name} and ${to[0].name}...`
      : "I couldn't identify both locations. Try: 'How far is Library from ECE Block?'", { resolved_from: from, resolved_to: to })
  }
  const [bare, foundPrefix] = strip(text)
  const info = v.INFO_QUERY_PREFIXES.some(p => text.startsWith(p))
  const matches = v.AMBIGUOUS_BARE_TOKENS.includes(bare) ? [] : resolveLocations(bare, locations)
  const building = () => result('building_finder', info ? `Here's info about ${matches[0].name}.` : `${matches[0].name} — here's the info and a route.`, { resolved_locations: matches, info_mode: info })
  if (foundPrefix && matches.length) return building()
  for (const [intent, phrases, extra, reply] of [
    ['event_now', v.EVENT_NOW_PHRASES, text.split(' ').includes('now') && text.includes('event'), "Here's what's happening right now."],
    ['event_today', v.EVENT_TODAY_PHRASES, text.includes('today') && text.includes('event'), "Here's today's schedule."],
    ['event_upcoming', v.EVENT_UPCOMING_PHRASES, text.includes('upcoming') && text.includes('event'), "Here's what's coming up."],
    ['event_list', v.EVENT_GENERIC_PHRASES, false, "Here's the fest schedule."],
  ]) if (extra || hit(text, phrases)) return result(intent, reply, {}, text)
  if (hit(text, v.CURRENT_LOCATION_PHRASES) || aliasScore(text, v.CURRENT_LOCATION_PHRASES) > 0.82) return result('current_location', "Here's where you are right now.")
  for (const [intent, phrases, reply] of [
    ['follow_up_filter_unsupported', v.FOLLOWUP_DIETARY_PHRASES, "I don't have dietary information (veg/non-veg) for these places yet — best to check at the counter."],
    ['follow_up_filter_closest', v.FOLLOWUP_CLOSEST_PHRASES, 'Sorting by distance from you…'],
    ['follow_up_eta', v.FOLLOWUP_ETA_PHRASES, 'Checking the distance and time…'],
    ['follow_up_preview', v.FOLLOWUP_PREVIEW_PHRASES, 'Previewing the route…'],
    ['follow_up_details', v.FOLLOWUP_DETAILS_PHRASES, 'Here are the details…'],
    ['follow_up_cancel_nav', v.CANCEL_NAV_PHRASES, 'Navigation stopped.'],
    ['follow_up_navigate', v.FOLLOWUP_NAVIGATE_PHRASES, 'Starting navigation…'],
  ]) if (hit(text, phrases)) return result(intent, reply, {}, text)
  if (matches.length) return building()
  return result(v.CAMPUS_KEYWORDS.some(k => text.includes(k)) ? 'unknown' : 'out_of_scope',
    'I can help with SSN buildings, classrooms, facilities, events and using the app. Try “Where is the library?”, “Nearest restroom”, “Today’s schedule” or “Does this work offline?”. I do not have verified answers to other questions.')
}
