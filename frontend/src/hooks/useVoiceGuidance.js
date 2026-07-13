/**
 * useVoiceGuidance — spoken navigation announcements via SpeechSynthesis API.
 *
 * Phase 9 fixes:
 * - Correct turn direction labels (slight left/right, u-turn)
 * - Pre-announce at 80m (early warning) + confirm at 25m
 * - Deduplicate via stable (lat,lng) turn key — never spams
 * - "Continue straight" only fires on transition, never on every tick
 * - No false turns: uses corrected 20° threshold from geo.js
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { computeUpcomingTurn } from '../utils/geo'

const STORAGE_KEY = 'ssn-nav-voice-settings'
const DEFAULT_SETTINGS = { enabled: true, volume: 1, rate: 1 }

// Pre-announce at this distance (early warning)
const PRE_ANNOUNCE_M = 80
// Confirm announcement at this distance (action prompt)
const CONFIRM_ANNOUNCE_M = 25

function directionText(dir) {
  switch (dir) {
    case 'slight left':  return 'Bear left'
    case 'slight right': return 'Bear right'
    case 'left':         return 'Turn left'
    case 'right':        return 'Turn right'
    case 'u-turn':       return 'Make a U-turn'
    default:             return 'Continue straight'
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { return DEFAULT_SETTINGS }
}

function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* localStorage unavailable */ }
}

export function useVoiceGuidance({ tracking, hasRoute, remainingDist, remainingPath, offRoute }) {
  const [settings, setSettings] = useState(loadSettings)
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window

  const spokenKeys      = useRef(new Set())
  const offRouteSpoken  = useRef(false)
  const lastHadTurnRef  = useRef(null)
  const settingsRef     = useRef(settings)

  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => { saveSettings(settings) }, [settings])

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

  const cancel = useCallback(() => {
    if (!supported) return
    window.speechSynthesis.cancel()
  }, [supported])

  useEffect(() => {
    return () => { if (supported) window.speechSynthesis.cancel() }
  }, [supported])

  // Bug found during production verification, reproducible from the code
  // (not observed live): a reroute can legitimately fire while a turn is
  // already inside its PRE_ANNOUNCE_M/CONFIRM_ANNOUNCE_M window — cutting a
  // corner during a turn is exactly the kind of deviation that trips
  // off-route detection, so this isn't a rare edge case, it's the most
  // likely moment for a reroute to happen. If the recalculated route still
  // has the same immediate upcoming turn (same point, which it usually
  // does — a reroute around a temporary deviation typically rejoins the
  // same path), wiping the whole spokenKeys set here causes that turn's
  // pre-announcement or confirm ("Turn left now") to fire a second time
  // seconds after the first, which sounds like a bug to the user even
  // though each individual announcement was itself correctly deduplicated.
  //
  // Fix: prune away keys for turns that are no longer upcoming (so a
  // genuinely new route still announces its new turns fresh), but keep
  // keys tied to whichever turn is still the immediate upcoming one, so
  // that turn isn't re-announced just because the route object changed.
  const resetForNewRoute = useCallback((newRemainingPath) => {
    const currentTurn = newRemainingPath ? computeUpcomingTurn(newRemainingPath) : null
    const currentKey = currentTurn ? `${currentTurn.lat.toFixed(5)},${currentTurn.lng.toFixed(5)}` : null
    const preserve = new Set(['nav-started'])
    if (currentKey) {
      preserve.add(`pre-${currentKey}`)
      preserve.add(`confirm-${currentKey}`)
    }
    spokenKeys.current = new Set([...spokenKeys.current].filter(k => preserve.has(k)))
    offRouteSpoken.current = false
    // Same reasoning as above: if we already know whether the new path is
    // currently in a turn or a straight stretch, reflect that directly
    // instead of resetting to null, which would otherwise re-fire
    // "Continue straight" immediately after a reroute that didn't actually
    // change the straight-vs-turn state.
    lastHadTurnRef.current = newRemainingPath ? !!currentTurn : null
  }, [])

  const announceNavigationStart = useCallback(() => {
    speakOnce('nav-started', 'Navigation started. Follow the highlighted path.')
  }, [speakOnce])

  const testVoice = useCallback(() => {
    speakRaw('Voice guidance is active. Turn left in 50 meters.')
  }, [speakRaw])

  const setEnabled = useCallback((enabled) => setSettings(s => ({ ...s, enabled })), [])
  const setVolume  = useCallback((volume)  => setSettings(s => ({ ...s, volume: Math.min(1, Math.max(0, volume)) })), [])
  const setRate    = useCallback((rate)    => setSettings(s => ({ ...s, rate: Math.min(2, Math.max(0.5, rate)) })), [])

  // Distance-based destination announcements
  useEffect(() => {
    if (remainingDist == null) return
    if (remainingDist <= 200) speakOnce('dist-200', 'You are 200 meters from your destination.')
    if (remainingDist <= 100) speakOnce('dist-100', 'You are 100 meters from your destination.')
    if (remainingDist <= 20)  speakOnce('arrived',  'You have arrived at your destination.')
  }, [remainingDist, speakOnce])

  // Off-route — once per episode
  useEffect(() => {
    if (offRoute) {
      if (!offRouteSpoken.current) {
        offRouteSpoken.current = true
        speak('Off route. Recalculating.')
      }
    } else {
      offRouteSpoken.current = false
    }
  }, [offRoute, speak])

  // Turn-by-turn — Phase 9 fixes:
  // 1. Pre-announce at PRE_ANNOUNCE_M (early warning)
  // 2. Confirm at CONFIRM_ANNOUNCE_M (action prompt)
  // 3. Each announcement fired exactly once per physical turn (keyed on lat,lng)
  // 4. "Continue straight" only on *transition* (not every tick)
  useEffect(() => {
    if (!tracking || !hasRoute || !remainingPath?.length) return
    const turn = computeUpcomingTurn(remainingPath)

    if (turn) {
      lastHadTurnRef.current = true
      const key = `${turn.lat.toFixed(5)},${turn.lng.toFixed(5)}`

      if (turn.distanceM <= PRE_ANNOUNCE_M) {
        // Pre-announcement: "In 80 meters, turn left"
        const preKey = `pre-${key}`
        if (!spokenKeys.current.has(preKey)) {
          const rounded = Math.round(turn.distanceM / 10) * 10
          speakOnce(preKey, `In ${rounded} meters, ${directionText(turn.direction)}.`)
        }
      }

      if (turn.distanceM <= CONFIRM_ANNOUNCE_M) {
        // Confirm: "Turn left now" or "Turn left in 20 meters"
        const confirmKey = `confirm-${key}`
        const rounded = Math.round(turn.distanceM / 5) * 5
        const text = rounded <= 5
          ? `${directionText(turn.direction)} now.`
          : `${directionText(turn.direction)} in ${rounded} meters.`
        speakOnce(confirmKey, text)
      }
    } else if (lastHadTurnRef.current !== false) {
      // Transition to straight — announce once per straight stretch
      lastHadTurnRef.current = false
      // Only say "continue straight" if we're mid-navigation (not at very start)
      if (spokenKeys.current.has('nav-started')) {
        speak('Continue straight.')
      }
    }
  }, [remainingPath, tracking, hasRoute, speak, speakOnce])

  return {
    supported, settings,
    setEnabled, setVolume, setRate,
    testVoice, resetForNewRoute, announceNavigationStart,
    speak, cancel,
  }
}
