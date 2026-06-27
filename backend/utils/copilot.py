"""
Campus Copilot — Phase 1 NLU engine.

WHAT THIS IS
-------------
A deterministic, rule-based + fuzzy-matching text-understanding engine for
the campus chatbot. It classifies a user's message into one of a fixed set
of campus-related intents and extracts whatever entities it needs (a
building/department name, a classroom code, a "need" category, a follow-up
reference, ...), then hands back a small structured result plus a
human-readable reply. It does NOT look up live data (locations, events,
GPS distance) — main.py / the frontend do that with the *existing* APIs and
utilities, so this module never duplicates logic that already exists
elsewhere in the app.

WHY NOT A REAL LLM CALL
------------------------
The spec frames the AI features (intent understanding, multi-turn context,
typo/synonym handling) as "use the LLM for this, use local search for
everything else". For this phase, a closed, well-defined campus vocabulary
(31 locations, ~9 departments, a handful of "needs") is something a rule
+ fuzzy-match engine can classify correctly and *instantly*, with zero risk
of hallucinating a building or event that doesn't exist — which the spec
explicitly requires ("never hallucinate", "if information is unavailable,
say so honestly"). It also works with no network access and no API key.

`classify` below is the single entry point and is intentionally the only
thing main.py calls — if a true generative-LLM fallback is ever wanted for
genuinely open-ended phrasing, it can be slotted in right where the final
out_of_scope/unknown fallback returns, without changing the public
interface.
"""
import re
import difflib
from typing import Optional

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

# location_id -> extra free-text aliases people might actually type/say.
# (locations.json's own `name` / `department` / `id` fields are always
# included automatically — see _candidate_strings().)
LOCATION_ALIASES = {
    'eee-block':        ['eee', 'electrical', 'electrical engineering', 'electrical and electronics',
                          'electronics and electrical', 'eee dept', 'eee department', 'eee block'],
    'cse-block':        ['cse', 'computer science', 'computer science engineering', 'cs', 'comp sci',
                          'cse dept', 'cse department'],
    'ece-block':        ['ece', 'electronics and communication', 'electronics communication',
                          'ece dept', 'ece department'],
    'it-block':         ['information technology', 'it dept', 'it department'],
    'mech-block':       ['mech', 'mechanical', 'mechanical engineering', 'mech dept', 'mech department'],
    'civil-block':      ['civil', 'civil engineering', 'civil dept', 'civil department'],
    'biomed-block':     ['biomed', 'bme', 'biomedical', 'biomedical engineering', 'biomedical and chemical',
                          'chemical', 'chemical engineering', 'biomed dept', 'biomed department'],
    'admin-block':      ['admin', 'administration', 'admin office', 'administration office', 'admin dept'],
    'cdc-block':        ['cdc', 'placement', 'placement cell', 'placement office', 'career development',
                          'career development cell', 'career cell'],
    'central-library':  ['library', 'lib', 'central library'],
    'tcs-auditorium':   ['tcs auditorium', 'auditorium', 'tcs'],
    'mini-hall-1':      ['mini hall', 'mini hall 1', 'minihall'],
    'open-air-theatre':  ['oat', 'open air theatre', 'open air theater'],
    'main-gate':        ['main gate', 'gate', 'entrance', 'entry'],
    'parking':          ['parking', 'parking lot', 'car park', 'bike parking'],
    'medical-center':   ['medical center', 'medical centre', 'hospital', 'clinic', 'infirmary', 'sick bay'],
    'boys-hostel-gate': ['boys hostel', 'boys hostel gate', "men's hostel"],
    'boys-hostel-office': ['boys hostel office'],
    'girls-hostel':     ['girls hostel', "women's hostel", "ladies hostel"],
    'sports-complex':   ['sports complex', 'gym', 'stadium', 'sports'],
    'sports-complex-main': ['sports ground', 'main sports complex'],
    'ssn-cricket-ground': ['cricket ground', 'cricket field'],
    'ssn-football-ground': ['football ground', 'football field'],
    'clock-tower':      ['clock tower', 'clocktower'],
    'ssn-fountain':     ['fountain', 'ssn fountain'],
}

# Short department codes used specifically for classroom-code parsing
# (the FIRST token of a message like "EEE 302" or "Mech Lab 4").
CLASSROOM_DEPT_CODES = {
    'eee': 'eee-block', 'cse': 'cse-block', 'ece': 'ece-block', 'it': 'it-block',
    'mech': 'mech-block', 'me': 'mech-block', 'civil': 'civil-block', 'ce': 'civil-block',
    'biomed': 'biomed-block', 'bme': 'biomed-block', 'admin': 'admin-block', 'cdc': 'cdc-block',
}

# need_type -> phrases that imply it. Resolution against actual locations
# (nearest restroom, all dining spots, etc.) happens on the frontend with
# the existing utils/facilities.js helpers — this module only figures out
# *which* need the user means.
NEED_ALIASES = {
    'dining':       ['hungry', 'food', 'eat', 'something to eat', 'snack', 'snacks', 'canteen', 'mess',
                      'restaurant', 'cafe', 'coffee', 'tea', 'lunch', 'dinner', 'breakfast', 'hungry now'],
    'water_station': ['water', 'thirsty', 'drinking water', 'water station', 'water fountain', 'need water'],
    'restroom':     ['restroom', 'washroom', 'toilet', 'bathroom', 'loo', 'lavatory', 'rest room'],
    'parking':      ['parking', 'park my vehicle', 'park my car', 'park my bike', 'car park', 'where to park'],
    'medical':      ['sick', 'unwell', 'injured', 'first aid', 'medical help', 'not feeling well', 'hurt'],
}
# This "need" is a single specific place, not "nearest of several" — the
# frontend just resolves it straight to a location id.
NEED_DIRECT_LOCATION = {
    'placement': 'cdc-block',
}
NEED_ALIASES_DIRECT = {
    'placement': ['placement cell', 'placement office', 'placement', 'career development cell',
                  'career cell', 'i need the placement cell', 'job cell'],
}

GREETING_PHRASES = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'yo', 'sup', 'hai']

EVENT_NOW_PHRASES = ['happening now', 'going on now', 'right now', 'currently on', 'live now', 'now?']
EVENT_TODAY_PHRASES = ["today's events", 'today events', 'events today', 'what is today']
EVENT_UPCOMING_PHRASES = ['upcoming', 'coming up', 'next event', 'future events', 'what is next']
EVENT_GENERIC_PHRASES = ['events', 'event', 'fest schedule', 'schedule', 'whats on', "what's on"]

FOLLOWUP_NAVIGATE_PHRASES = ['take me there', 'navigate', 'navigate there', 'start navigation',
                              'go there', 'lets go', "let's go", 'start', 'go now', 'directions']
FOLLOWUP_PREVIEW_PHRASES = ['preview', 'preview route', 'show route', 'show the route', 'preview the route']
FOLLOWUP_ETA_PHRASES = ['how long', 'how far', 'eta', 'how much time', 'how many minutes',
                         'when will i reach', 'how much distance', 'duration']
FOLLOWUP_DETAILS_PHRASES = ['show details', 'details', 'more info', 'tell me more', 'more information', 'view details']
FOLLOWUP_CLOSEST_PHRASES = ['closest', 'nearest', 'which one is closest', 'which is nearest', 'which is closer']
FOLLOWUP_DIETARY_PHRASES = ['vegetarian', 'veg', 'non veg', 'non-veg', 'vegan']

CURRENT_LOCATION_PHRASES = ['where am i', "what's my location", 'my location', 'current location', 'my position']

DEPARTMENT_KEYWORDS = ['department', 'dept']

# Tokens that are real department codes but ALSO ordinary English words —
# safe to resolve when paired with "department"/"dept"/"block" (those
# branches strip the qualifier before matching, which is fine since the
# qualifier itself already removed the ambiguity), but too risky to resolve
# from a bare leftover token after stripping a generic command phrase like
# "where is" / "take me to", since that's exactly the shape of an ordinary
# pronoun reference ("where is it", "take me to it").
AMBIGUOUS_BARE_TOKENS = {'it'}

# A few generic campus words — used only to decide whether an unmatched
# message is plausibly campus-related (→ "unknown, please rephrase") vs.
# clearly unrelated (→ polite out-of-scope redirect). Deliberately broad.
CAMPUS_KEYWORDS = [
    'block', 'building', 'department', 'dept', 'room', 'floor', 'wing', 'event', 'fest',
    'navigate', 'direction', 'directions', 'route', 'canteen', 'food', 'water', 'restroom',
    'washroom', 'toilet', 'parking', 'hostel', 'library', 'auditorium', 'gate', 'college',
    'campus', 'class', 'classroom', 'lab', 'faculty', 'professor', 'admin', 'placement',
    'cdc', 'ground', 'sports', 'medical', 'clinic', 'hospital', 'tower', 'fountain', 'theatre',
    'theater', 'hall', 'cafe', 'mess',
]


# ---------------------------------------------------------------------------
# Small text helpers
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[?!.,;:'\"]+", ' ', text)
    text = re.sub(r"\s+", ' ', text)
    return text.strip()


_COMMAND_PREFIXES = [
    'take me to', 'navigate me to', 'navigate to', 'directions to', 'how do i get to',
    'how do i reach', 'where is', "where's", 'where is the', 'show me', 'find', 'go to',
    'i want to go to', 'i need to go to', 'i need', 'i want',
]


def strip_command_phrases(text: str):
    """Removes a leading command phrase ("take me to", "where is", ...) so
    what's left is just the entity the user is naming. Returns
    (cleaned_text, found_prefix) — `found_prefix` is True only if an actual
    command phrase was matched and removed, so callers can tell that apart
    from the unconditional trailing-filler cleanup (e.g. stripping a
    stray "now") which can change the text without indicating the message
    was really a "go to X" command."""
    t = text
    found_prefix = False
    changed = True
    while changed:
        changed = False
        for p in _COMMAND_PREFIXES:
            if t.startswith(p + ' '):
                t = t[len(p):].strip()
                changed = True
                found_prefix = True
            elif t == p:
                t = ''
                changed = True
                found_prefix = True
    # trailing politeness / filler (NOT "block"/"building" -- those are
    # part of real candidate strings like "it block" and stripping them
    # does more harm than good)
    t = re.sub(r'\b(please|now)\b', '', t).strip()
    t = re.sub(r"\s+", ' ', t)
    return t, found_prefix


def _phrase_hit(text: str, phrases) -> bool:
    return any(_contains_as_word(text, p) for p in phrases)


def _safe_ratio(a: str, b: str) -> float:
    """difflib ratio, but zeroed out when the two strings are wildly
    different lengths. Plain SequenceMatcher ratio on a long, unrelated
    sentence vs. a short vocabulary word can spike surprisingly high just
    from incidental shared characters (e.g. a whole question vs a 6-letter
    alias) — comparing length-mismatched strings this way is unreliable,
    so we only trust the ratio when the two strings are roughly comparable
    in length (which is exactly the case we need it for: a single
    mistyped word/short phrase vs. its correct vocabulary form)."""
    if not a or not b:
        return 0.0
    longer, shorter = max(len(a), len(b)), min(len(a), len(b))
    if longer > 10 and longer > shorter * 1.7:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _best_alias_score(text: str, phrases) -> float:
    """Best similarity between `text` and any phrase in `phrases`, boosted
    if one literally contains the other (handles short/partial queries).
    The phrase-inside-text direction requires a word boundary so a short
    alias like "eat" can't match merely because it's embedded inside an
    unrelated word ("weather")."""
    best = 0.0
    for p in phrases:
        if _contains_as_word(text, p) or _contains_as_word(p, text):
            best = max(best, 0.9)
        best = max(best, _safe_ratio(text, p))
    return best


# ---------------------------------------------------------------------------
# Building / department fuzzy resolution against the real locations.json
# ---------------------------------------------------------------------------

def _contains_as_word(query: str, cand: str) -> bool:
    """True if `cand` appears in `query` on a word boundary (not merely as
    a character substring buried inside a longer, unrelated word)."""
    if not cand:
        return False
    return re.search(r'\b' + re.escape(cand) + r'\b', query) is not None


def _candidate_strings(loc: dict):
    strs = [loc['name'].lower(), loc['id'].replace('-', ' ')]
    if loc.get('department'):
        strs.append(loc['department'].lower())
    strs.extend(LOCATION_ALIASES.get(loc['id'], []))
    return strs


def resolve_locations(query: str, locations: list, limit: int = 3, cutoff: float = 0.65):
    """Fuzzy-match `query` against every location's name/department/aliases.
    Returns up to `limit` {id, name, score} dicts, best first, score>=cutoff."""
    query = query.strip()
    if not query:
        return []
    scored = []
    for loc in locations:
        best = 0.0
        for cand in _candidate_strings(loc):
            if not cand:
                continue
            score = 0.0
            if query == cand:
                score = 1.0
            elif query in cand or _contains_as_word(query, cand):
                # substring match — strong signal, but longer unrelated
                # extra text should count for a bit less than an exact hit.
                # cand-in-query direction requires a word boundary (not
                # just any substring) so short codes like "it"/"ce" can't
                # accidentally match inside an unrelated word such as
                # "capital".
                score = 0.82 + 0.1 * (min(len(query), len(cand)) / max(len(query), len(cand)))
            else:
                score = _safe_ratio(query, cand)
            if score > best:
                best = score
        if best >= cutoff:
            scored.append({'id': loc['id'], 'name': loc['name'], 'score': round(best, 3)})
    scored.sort(key=lambda r: -r['score'])
    return scored[:limit]


# ---------------------------------------------------------------------------
# Classroom code parsing: "EEE 302", "CSE Lab 4", "IT-101"
# ---------------------------------------------------------------------------

_CLASSROOM_RE = re.compile(
    r'^(eee|cse|ece|it|mech|me|civil|ce|biomed|bme|admin|cdc)\b[\s\-]*(.+)$'
)
_ROOM_NUM_RE = re.compile(r'^(\d{1,4})[a-z]?$')
_LAB_RE = re.compile(r'^lab[\s\-]?\d+$')


def parse_classroom_code(text: str):
    """Returns {dept_location_id, room_label, floor_guess} or None."""
    m = _CLASSROOM_RE.match(text)
    if not m:
        return None
    dept_code, room_part = m.group(1), m.group(2).strip()
    room_part = re.sub(r'\bblock\b|\bbuilding\b|\bdepartment\b|\bdept\b', '', room_part).strip()
    if not room_part:
        return None  # just "EEE" alone — not a classroom code

    floor_guess = None
    label = room_part.upper()
    num_match = _ROOM_NUM_RE.match(room_part)
    if num_match:
        digits = num_match.group(1)
        if len(digits) >= 3:
            floor_guess = f"{digits[0]} (estimated from room number)"
        label = f"{dept_code.upper()}-{digits}"
    elif _LAB_RE.match(room_part):
        label = room_part.upper().replace('-', ' ')
    else:
        # doesn't look like a real room/lab reference (e.g. "IT block")
        return None

    return {
        'dept_location_id': CLASSROOM_DEPT_CODES[dept_code],
        'room_label': label,
        'floor_guess': floor_guess,
    }


# ---------------------------------------------------------------------------
# Main classification
# ---------------------------------------------------------------------------

def classify(message: str, locations: list, context: Optional[dict] = None) -> dict:
    """
    The single entry point. `locations` is the already-loaded
    locations.json list (main.py passes it in — this module never reads
    files itself). `context` is whatever the frontend chooses to echo back
    (Phase 1 only uses it to know whether there's a "last topic" to resolve
    a follow-up against; the frontend holds the actual data).
    """
    raw = message or ''
    text = normalize(raw)
    context = context or {}

    if not text:
        return _result('unknown', raw, text, reply="Sorry, I didn't catch that — could you type your question?")

    # 1) Greeting — checked first and strictly (exact match only) since
    #    these are short common words that could otherwise spuriously
    #    fuzzy-match something else entirely.
    if text in GREETING_PHRASES:
        return _result('greeting', raw, text,
                        reply="Hi! I'm the SSN Campus Copilot. Ask me things like \"Where is the library?\", "
                              "\"EEE 302\", \"Mechanical department\", \"What events are on today?\", or "
                              "\"I'm hungry\" — and I'll get you moving.")

    # 2) Classroom code — most specific pattern, check next.
    classroom = parse_classroom_code(text)
    if classroom:
        building = next((l for l in locations if l['id'] == classroom['dept_location_id']), None)
        building_name = building['name'] if building else classroom['dept_location_id']
        reply = f"{classroom['room_label']} is in {building_name}."
        if classroom['floor_guess']:
            reply += f" That's likely floor {classroom['floor_guess']}, but please confirm at the building entrance."
        else:
            reply += " I don't have an exact floor/wing for this room — check the building directory on arrival."
        return _result('classroom_finder', raw, text, reply=reply, classroom=classroom,
                        resolved_locations=[{'id': classroom['dept_location_id'], 'name': building_name, 'score': 1.0}])

    # 3) Department finder — explicit "X department/dept" phrasing.
    if any(k in text for k in DEPARTMENT_KEYWORDS):
        dept_query = re.sub(r'\b(department|dept)\b', '', text).strip()
        dept_query, _ = strip_command_phrases(dept_query)
        matches = resolve_locations(dept_query, locations)
        if matches:
            top = matches[0]
            return _result('department_finder', raw, text,
                            reply=f"{top['name']} — here's the department info and a route.",
                            resolved_locations=matches)
        return _result('department_finder', raw, text,
                        reply="I couldn't match that to a department I know. Try EEE, CSE, ECE, IT, "
                              "Mechanical, Civil, Biomedical, Admin or the Placement Cell (CDC).",
                        resolved_locations=[])

    # 4) "Need" detection (food/water/restroom/parking/medical/placement) —
    #    checked before generic command+entity resolution so "I need the
    #    placement cell" gets the nicer dedicated reply rather than being
    #    treated as a plain building lookup.
    need_hit = _classify_need(text)
    if need_hit:
        return need_hit

    # 5) Explicit command + named entity ("navigate to X", "directions to
    #    X", "where is X", "take me to X"). Checked before the generic
    #    follow-up keyword scan below so "navigate to IT Block" resolves
    #    to IT Block rather than being swallowed by the bare word
    #    "navigate" (a follow-up trigger when said with no target at all).
    prefix_stripped, found_prefix = strip_command_phrases(text)
    if found_prefix and prefix_stripped and prefix_stripped not in AMBIGUOUS_BARE_TOKENS:
        matches = resolve_locations(prefix_stripped, locations)
        if matches and matches[0]['score'] >= 0.65:
            top = matches[0]
            return _result('building_finder', raw, text,
                            reply=f"{top['name']} — here's the info and a route.",
                            resolved_locations=matches)

    # 6) Events.
    event_intent = _classify_event(text)
    if event_intent:
        return event_intent

    # 7) Current location.
    if _phrase_hit(text, CURRENT_LOCATION_PHRASES) or _best_alias_score(text, CURRENT_LOCATION_PHRASES) > 0.82:
        return _result('current_location', raw, text,
                        reply="Here's where you are right now.")

    # 8) Follow-ups. By this point any message with a clearly-named,
    #    resolvable destination has already returned above, so a bare
    #    "navigate" / "start" / "how long" here really is a contextual
    #    follow-up referring to whatever the conversation was last about.
    followup = _classify_followup(text)
    if followup:
        return followup

    # 9) Fall back to a generic building/department match (handles bare
    #    names like "library" or "EEE" with no command verb at all).
    bare_query, _ = strip_command_phrases(text)
    matches = resolve_locations(bare_query, locations) if bare_query not in AMBIGUOUS_BARE_TOKENS else []
    if matches:
        top = matches[0]
        return _result('building_finder', raw, text,
                        reply=f"{top['name']} — here's the info and a route.",
                        resolved_locations=matches)

    # 10) Genuinely unmatched — decide out_of_scope vs unknown.
    if any(k in text for k in CAMPUS_KEYWORDS):
        return _result('unknown', raw, text,
                        reply="I couldn't quite place that. I can help with buildings, departments, "
                              "classrooms, events, or nearby facilities — try rephrasing?")
    return _result('out_of_scope', raw, text,
                    reply="I'm dedicated to helping with SSN campus navigation and events, so I can't "
                          "help with general questions — but ask me about a building, department, "
                          "classroom, event, or facility and I'm on it!")


def _classify_need(text: str):
    # Placement is a direct single location, checked first since "placement
    # cell" would also loosely match nothing else.
    for phrase in NEED_ALIASES_DIRECT['placement']:
        if phrase in text or _best_alias_score(text, [phrase]) > 0.85:
            return _result('need', text, text, reply="The Placement Cell (CDC) — here's the route.",
                            need_type='placement', direct_location_id=NEED_DIRECT_LOCATION['placement'])

    best_need, best_score = None, 0.0
    for need_type, phrases in NEED_ALIASES.items():
        score = _best_alias_score(text, phrases)
        if _phrase_hit(text, phrases):
            score = max(score, 0.88)
        if score > best_score:
            best_score, best_need = score, need_type

    if best_need and best_score >= 0.72:
        replies = {
            'dining': "Looking for somewhere to eat — here are the nearest options.",
            'water_station': "Here's the nearest water station.",
            'restroom': "Here's the nearest restroom.",
            'parking': "Here's where to park.",
            'medical': "Here's the medical center — head there or ask campus security for first aid.",
        }
        return _result('need', text, text, reply=replies.get(best_need, "Here's what I found."),
                        need_type=best_need)
    return None


def _classify_event(text: str):
    if _phrase_hit(text, EVENT_NOW_PHRASES) or ('now' in text.split() and 'event' in text):
        return _result('event_now', text, text, reply="Here's what's happening right now.")
    if _phrase_hit(text, EVENT_TODAY_PHRASES) or ('today' in text and 'event' in text):
        return _result('event_today', text, text, reply="Here's today's schedule.")
    if _phrase_hit(text, EVENT_UPCOMING_PHRASES) or ('upcoming' in text and 'event' in text):
        return _result('event_upcoming', text, text, reply="Here's what's coming up.")
    if _phrase_hit(text, EVENT_GENERIC_PHRASES):
        return _result('event_list', text, text, reply="Here's the fest schedule.")
    return None


def _classify_followup(text: str):
    if _phrase_hit(text, FOLLOWUP_DIETARY_PHRASES):
        return _result('follow_up_filter_unsupported', text, text,
                        reply="I don't have dietary information (veg/non-veg) for these places yet — "
                              "best to check at the counter.")
    if _phrase_hit(text, FOLLOWUP_CLOSEST_PHRASES):
        return _result('follow_up_filter_closest', text, text, reply="Sorting by distance from you…")
    if _phrase_hit(text, FOLLOWUP_ETA_PHRASES):
        return _result('follow_up_eta', text, text, reply="Checking the distance and time…")
    if _phrase_hit(text, FOLLOWUP_PREVIEW_PHRASES):
        return _result('follow_up_preview', text, text, reply="Previewing the route…")
    if _phrase_hit(text, FOLLOWUP_DETAILS_PHRASES):
        return _result('follow_up_details', text, text, reply="Here are the details…")
    if _phrase_hit(text, FOLLOWUP_NAVIGATE_PHRASES):
        return _result('follow_up_navigate', text, text, reply="Starting navigation…")
    return None


def _result(intent, raw, normalized, reply, **extra):
    out = {
        'intent': intent,
        'query_text': raw,
        'corrected_text': normalized,
        'reply': reply,
        'need_type': None,
        'direct_location_id': None,
        'resolved_locations': [],
        'classroom': None,
    }
    out.update(extra)
    return out
