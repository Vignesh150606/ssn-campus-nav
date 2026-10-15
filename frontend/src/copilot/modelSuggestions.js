/** A rejected model prediction is never an answer or executable action.
 * Offer a small choice of supported queries only; the user confirms by tapping.
 * Navigation commands and unknown locations are deliberately not synthesized.
 */
const QUERIES = {
  venue_menu: 'Show menu',
  event_now: "What's happening now?",
  event_today: "Today's schedule",
  event_upcoming: "What's upcoming?",
  event_list: 'Fest schedule',
  event_near_me: 'Events near me',
  event_upcoming_30: 'Events starting in 30 minutes',
  nearby_search: "What's nearby?",
  current_location: 'Where am I?',
  'need.dining': 'Nearest canteen',
  'need.water_station': 'Find drinking water',
  'need.restroom': 'Nearest restroom',
  'need.parking': 'Visitor parking',
  'need.medical': 'Where is the medical center?',
  'need.accessibility': 'Show wheelchair accessible buildings',
  'need.placement': 'Where is the placement cell?',
  'faq.usage': 'How do I use this app?',
  'faq.offline': 'Does this work offline?',
  'faq.gps': 'GPS not working',
  'faq.navigation': 'How do I start navigation?',
  'faq.rooms': 'Are classroom floors accurate?',
  'faq.hours': 'Campus opening hours',
  'faq.registration': 'How do I register for an event?',
  'faq.accessibility': 'Are routes wheelchair accessible?',
}

export function modelSuggestedQueries(prediction, state = {}, message = '') {
  if (!prediction || prediction.confidence < 0.65 || ['unknown', 'out_of_scope'].includes(prediction.label)) return []
  const choices = []
  for (const candidate of prediction.top || []) {
    if (candidate.score < 0.15) continue
    let query = QUERIES[candidate.label]
    // Reject obvious temporal/proximity contradictions rather than turn the
    // model's high score into a misleading suggestion.
    if (candidate.label === 'event_near_me' && /\b(future|upcoming|later|next|tomorrow)\b/i.test(message)
      && !/\b(near|nearby|closest|around me)\b/i.test(message)) continue
    if (state.lastLocationId && candidate.label === 'follow_up_eta') query = 'How long will it take?'
    if ((state.lastLocationId || state.lastCandidates?.length) && candidate.label === 'follow_up_details') query = 'Show details'
    if (state.lastCandidates?.length > 1 && candidate.label === 'follow_up_filter_closest') query = 'Which is closest?'
    if (state.lastCandidates?.length && candidate.label === 'follow_up_filter_unsupported') query = 'Vegetarian options only'
    if (query && !choices.includes(query)) choices.push(query)
  }
  return choices.slice(0, 3)
}
