/**
 * useVoiceGuidance — spoken navigation announcements via the browser's
 * SpeechSynthesis API.
 *
 * Owns:
 *  - persisted settings (enabled, volume, rate) in localStorage
 *  - one-shot tracking so each announcement fires exactly once per
 *    navigation session ("dist-200", "dist-100", "arrived", "nav-started",
 *    "turn-<lat>-<lng>" — keyed on the turn's own coordinates, which stay
 *    constant tick to tick, rather than its index in the shrinking
 *    remaining-path array, which doesn't)
 *  - the off-route announcement, which is allowed to repeat — but only once
 *    per *episode* of being off-route (it won't repeat every GPS tick while
 *    you're still drifting, only when offRoute flips false -> true again)
 *  - "Continue straight", which is allowed to repeat once per straight
 *    stretch — it fires when the path *becomes* straight again (including
 *    at the very start of a route), not on every tick while it stays
 *    straight, and not just once for the whole session
 *  - cancelling any in-progress/queued speech via cancel() — call this
 *    whenever navigation stops, the route is cleared, or tracking stops;
 *    it's also called automatically on unmount, so speech never outlives
 *    the component that started it
 *
 * This hook takes the live tracking values as arguments rather than reading
 * LocationContext itself, so it stays decoupled from that context and can
 * be reused (e.g. in a future indoor-navigation screen) without dragging
 * GPS/context wiring along with it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { computeUpcomingTurn } from '../utils/geo'

const STORAGE_KEY = 'ssn-nav-voice-settings'

const DEFAULT_SETTINGS = {
  enabled: true,
  volume: 1,     // 0..1
  rate: 1,       // 0.5..2 (SpeechSynthesisUtterance.rate)
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage unavailable (private browsing etc.) — settings just won't persist.
  }
}

export function useVoiceGuidance({ tracking, hasRoute, remainingDist, remainingPath, offRoute }) {
  const [settings, setSettings] = useState(loadSettings)
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window

  const spokenKeys      = useRef(new Set())
  const offRouteSpoken   = useRef(false)
  // Tracks whether the *previous* evaluation found an upcoming turn:
  // null = not evaluated yet, true = was approaching/at a turn, false =
  // was already on a straight stretch. Lets "Continue straight" fire once
  // per straight stretch (including the first one) instead of either
  // spamming every tick or only ever firing once per whole session.
  const lastHadTurnRef  = useRef(null)
  const settingsRef      = useRef(settings)

  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => { saveSettings(settings) }, [settings])

  /** Raw speak — always speaks if the API is supported, ignoring the
   *  enabled toggle and the one-shot dedup. Used by the Test Voice button. */
  const speakRaw = useCallback((text) => {
    if (!supported) return
    const utter = new SpeechSynthesisUtterance(text)
    utter.volume = settingsRef.current.volume
    utter.rate   = settingsRef.current.rate
    window.speechSynthesis.speak(utter)
  }, [supported])

  const speak = useCallback((text) => {
    if (!supported || !settingsRef.current.enabled) return
    speakRaw(text)
  }, [supported, speakRaw])

  const speakOnce = useCallback((key, text) => {
    if (spokenKeys.current.has(key)) return
    spokenKeys.current.add(key)
    speak(text)
  }, [speak])

  /** Stop any in-progress or queued speech immediately. Call this whenever
   *  navigation stops, the route is cleared, or tracking stops — it's also
   *  wired to fire automatically on unmount below, so speech never keeps
   *  playing after the thing that started it has gone away. */
  const cancel = useCallback(() => {
    if (!supported) return
    window.speechSynthesis.cancel()
  }, [supported])

  // Belt-and-suspenders: cancel speech if this hook's owning component
  // ever unmounts (e.g. navigating away from the page mid-utterance).
  useEffect(() => {
    return () => {
      if (supported) window.speechSynthesis.cancel()
    }
  }, [supported])

  /** Call when a brand-new navigation session starts (not on reroute —
   *  rerouting should NOT replay "Navigation started" or re-announce
   *  distances the user has already passed). */
  const resetForNewRoute = useCallback(() => {
    spokenKeys.current = new Set()
    offRouteSpoken.current = false
    lastHadTurnRef.current = null
  }, [])

  const announceNavigationStart = useCallback(() => {
    speakOnce('nav-started', 'Navigation started.')
  }, [speakOnce])

  const testVoice = useCallback(() => {
    speakRaw('Voice guidance is on. Turn left in 50 meters.')
  }, [speakRaw])

  const setEnabled = useCallback((enabled) => setSettings(s => ({ ...s, enabled })), [])
  const setVolume  = useCallback((volume)  => setSettings(s => ({ ...s, volume: Math.min(1, Math.max(0, volume)) })), [])
  const setRate    = useCallback((rate)    => setSettings(s => ({ ...s, rate: Math.min(2, Math.max(0.5, rate)) })), [])

  // Distance-based announcements (200m / 100m / arrived).
  useEffect(() => {
    if (remainingDist == null) return
    if (remainingDist <= 200) speakOnce('dist-200', 'You are 200 meters from your destination.')
    if (remainingDist <= 100) speakOnce('dist-100', 'You are 100 meters from your destination.')
    if (remainingDist <= 20)  speakOnce('arrived', 'You have arrived at your destination.')
  }, [remainingDist, speakOnce])

  // Off-route announcement — once per episode, not once per session.
  useEffect(() => {
    if (offRoute) {
      if (!offRouteSpoken.current) {
        offRouteSpoken.current = true
        speak('Off route detected. Recalculating route.')
      }
    } else {
      offRouteSpoken.current = false
    }
  }, [offRoute, speak])

  // Turn-by-turn — heuristic, based on where the remaining path bends.
  // See utils/geo.js computeUpcomingTurn() for the caveat about this not
  // being true street-level turn data.
  useEffect(() => {
    if (!tracking || !hasRoute || !remainingPath?.length) return
    const turn = computeUpcomingTurn(remainingPath)
    if (turn) {
      lastHadTurnRef.current = true
      if (turn.distanceM <= 50) {
        // Keyed on the turn's own coordinates (stable across ticks) rather
        // than turn.turnIndex (just a position within whatever — possibly
        // shrinking — array was passed in), so the same physical turn can
        // only ever be announced once.
        const turnKey = `turn-${turn.lat.toFixed(5)}-${turn.lng.toFixed(5)}`
        // Round to the nearest 5m for a natural-sounding distance, and say
        // "now" instead of "in 0 meters" right at the turn itself.
        const roundedDist = Math.round(turn.distanceM / 5) * 5
        const text = roundedDist <= 5
          ? `Turn ${turn.direction} now.`
          : `Turn ${turn.direction} in ${roundedDist} meters.`
        speakOnce(turnKey, text)
      }
    } else if (lastHadTurnRef.current !== false) {
      // The path ahead is straight. Only announce it on the *transition*
      // into a straight stretch (lastHadTurnRef was null — start of route
      // — or true — just passed a turn), not on every tick while it stays
      // straight, and not just once for the entire session.
      lastHadTurnRef.current = false
      speak('Continue straight.')
    }
  }, [remainingPath, tracking, hasRoute, speak, speakOnce])

  return {
    supported,
    settings,
    setEnabled,
    setVolume,
    setRate,
    testVoice,
    resetForNewRoute,
    announceNavigationStart,
    speak,  // exposed for one-off custom announcements (e.g. recalculation)
    cancel, // stop any in-progress/queued speech
  }
}
