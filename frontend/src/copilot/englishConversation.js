// English conversation and action guards around the existing local classifier.
// Replies use approved FAQ text and stored campus facts, never generated facts.
import { classifyLocal, normalize } from './localClassifier'
import vocabulary from './vocabulary.json'

const phraseIn = (text, phrase) => (` ${text} `).includes(` ${phrase} `)

function namedLocations(text, locations) {
  const matches = locations.flatMap(loc => [loc.name, loc.id.replaceAll('-', ' '), loc.department,
    ...(vocabulary.LOCATION_ALIASES[loc.id] || [])].filter(Boolean)
    .map(normalize).filter(alias => alias.length > 2 && phraseIn(text, alias))
    .map(alias => ({ alias, loc })))
  // A specific name such as "main auditorium" wins over a generic alias
  // "auditorium". Independent names such as CSE and ECE remain ambiguous.
  const specific = matches.filter(a => !matches.some(b => b.alias !== a.alias && phraseIn(b.alias, a.alias)))
  return [...new Map(specific.map(({ loc }) => [loc.id, { id: loc.id, name: loc.name, score: 1 }])).values()]
}

export function classifyEnglish(message, locations, state = {}) {
  const input = String(message || '').normalize('NFKC').replace(/[’‘]/g, "'")
  const text = normalize(input)
  const base = classifyLocal(input, locations)
  const answer = (intent, reply, extra = {}) => ({ ...base, intent, reply,
    resolved_locations: [], resolved_from: [], resolved_to: [], classroom: null,
    direct_location_id: null, need_type: null, info_mode: false, ...extra })
  const faq = canonical => ({ ...classifyLocal(canonical, locations), query_text: message, corrected_text: text })

  const actionWords = /\b(cancel|stop|exit|end|start|navigate|take|go|preview|directions)\b/
  const asksOffline = /\b(offline|without (?:internet|wi-?fi|a connection)|need (?:internet|wi-?fi))\b/.test(text)
    && /\b(app|this|you|chat|chatbot|work|use|navigation|directions|navigate)\b/.test(text)
  if (actionWords.test(text) && /\b(?:don t|do not|doesn t|not|never|no longer)\b/.test(text)) {
    // Negation must be checked before substring-based imperative matching.
    // A refusal is not permission to start/stop navigation or offer a new route.
    return answer('unknown', "Okay — I won't change your navigation. Tell me a destination when you want directions.", { preserve_context: true })
  }
  if (/\b(cancel|stop)\b/.test(text) && /\b(registration|booking|event|ticket)\b/.test(text)) {
    return answer('unknown', "I can't cancel event registrations or bookings. Check the event's posted instructions or contact its organizer.", { preserve_context: true })
  }
  if (actionWords.test(text) && /^(?:how (?:do|can|to)|what does|explain)\b/.test(text)) {
    if (asksOffline) return faq('does this work offline')
    return answer('faq', /\b(cancel|stop|exit|end)\b/.test(text)
      ? 'Use Exit navigation in the navigation panel to stop directions. Asking how to stop does not stop your current navigation.'
      : classifyLocal('how do i start navigation', locations).reply)
  }

  if (/^(?:thanks?(?: a lot| so much| very much| for (?:your|the) help)?|thank you(?: so much| very much| for (?:your|the) help)?|that helps|that was helpful|appreciate (?:it|your help)|great thanks|awesome thanks)$/.test(text)) {
    return answer('greeting', "You're welcome! Ask me for another campus place, or continue with your selected destination.")
  }
  if (/^(?:how are you(?: doing)?|how s it going|how do you do)$/.test(text)) {
    return answer('greeting', "I'm ready to help you get around SSN. Where would you like to go?")
  }
  if (/^(?:(?:hi|hey|hello)(?: there| bot| copilot)?|good (?:morning|afternoon|evening))$/.test(text)) {
    return answer('greeting', 'Hi! I can help with SSN places, walking directions, saved events and menus. What are you looking for?')
  }
  if (/^(?:no(?: thanks| thank you)?|never mind|nevermind|not now)$/.test(text)) {
    return answer('greeting', "No problem. I'm here when you need campus directions.")
  }
  if (/^(?:what can you (?:do|help me with)|can you help(?: me)?|i need help|help me|help)$/.test(text)) {
    return faq('what can you do')
  }
  if (asksOffline) {
    return faq('does this work offline')
  }
  if (/\b(opening hours|closing time|open|opens|close|closes|closed)\b/.test(text)
    && /\b(hours|time|when|is|does)\b/.test(text)
    && (namedLocations(text, locations).length || /\b(canteen|library|campus|hostel|it|there)\b/.test(text))) {
    return faq('campus opening hours')
  }
  if (/\b(gps|location)\b/.test(text) && /\b(wrong|not working|can t|cannot|enable|allow|inaccurate|permission)\b/.test(text)) {
    return faq('gps not working')
  }
  if (/\b(registration|register|fees?|organizer|organiser)\b/.test(text)
    && /\b(how|contact|cost|much|pay|register|fees?)\b/.test(text)) {
    return faq('how do i register for an event')
  }
  if (/^(?:where is it|where is that|tell me (?:more )?about it|what about it|show me that place)$/.test(text)) {
    return state.lastLocationId
      ? answer('follow_up_details', 'Here are the details of your selected destination.')
      : answer('unknown', 'Which campus place do you mean? Try a name such as CSE Block or Central Library.', { preserve_context: true })
  }

  if (['building_finder', 'department_finder'].includes(base.intent)) {
    const named = namedLocations(text, locations)
    if (named.length) return { ...base, resolved_locations: named,
      reply: base.info_mode ? `Here's what I know about ${named[0].name}.` : `Here's ${named[0].name}.` }
  }
  const commands = {
    follow_up_cancel_nav: /^(?:cancel|stop|exit|end) (?:(?:the|my|current|active) )?(?:navigation|route|directions)$/,
    follow_up_navigate: /^(?:take me there|navigate(?: me)?(?: there| to (?:the )?first one)?|start(?: navigation| directions)?|go there|go now|let s go|lets go|directions)$/,
    follow_up_preview: /^(?:preview(?: (?:the )?route)?|show (?:the )?route(?: preview)?)$/,
  }
  if (commands[base.intent]) {
    let command = text.replace(/(?: please| now)+$/, '')
    const courtesy = /^(?:thanks|thank you|okay|ok|please|can you|could you|would you|i want to|i would like to|i need to) /
    while (courtesy.test(command)) command = command.replace(courtesy, '')
    if (!commands[base.intent].test(command)) {
      // Mentioning/quoting a command is not the same as requesting it.
      return answer('unknown', 'Do you want to change navigation? Say "navigate there", "preview route" or "cancel navigation" when you are ready.', { preserve_context: true })
    }
  }
  return base
}
