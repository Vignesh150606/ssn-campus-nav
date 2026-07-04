/**
 * NavSettingsPanel — overlay modal for all navigation-session preferences.
 *
 * Phase 4.2.4, Priority 1: previously the only in-navigation preference
 * was voice guidance (VoiceSettingsPanel) — Heading-Up had its own
 * separate always-visible floating toggle (NavCompass) and there was no
 * way to control auto-recenter/dynamic-zoom behaviour at all. This
 * consolidates all four into one panel:
 *
 *   Rotate Map While Walking  — headingUp preference (own state, Home.jsx)
 *   Voice Guidance            — reads/writes the EXISTING useVoiceGuidance
 *                                settings object directly; deliberately not
 *                                duplicated here, so there's one source of truth
 *   Auto Recenter             — autoRecenter (own state, Home.jsx)
 *   Dynamic Zoom              — dynamicZoom (own state, Home.jsx)
 *
 * Phase 4.2.7 (yellow Heading-Up control spec): removed the "Show
 * Compass" row that used to live here. NavCompass is now always visible
 * during navigation (Home.jsx) rather than an opt-in setting, so a
 * separate checkbox for its visibility would just be dead state that no
 * longer did anything.
 *
 * All remaining are plain in-memory React state owned by Home.jsx —
 * that's enough to satisfy "persist during the current navigation
 * session" (they live for as long as the app is open) without the added
 * complexity/risk of localStorage persistence, which voice guidance
 * already handles separately for the one setting that's meant to
 * survive across sessions.
 *
 * Reuses the existing .voice-settings-* CSS (overlay/panel/header/row
 * styling) rather than introducing a parallel set of class names.
 */
export default function NavSettingsPanel({
  voice, open, onClose,
  headingUp, onToggleHeadingUp,
  autoRecenter, onToggleAutoRecenter,
  dynamicZoom, onToggleDynamicZoom,
}) {
  if (!open) return null

  const { settings, setEnabled, setVolume, setRate, testVoice, supported } = voice

  return (
    <div className="voice-settings-overlay" onClick={onClose}>
      <div className="voice-settings-panel" onClick={e => e.stopPropagation()}>
        <div className="voice-settings-header">
          <span>Navigation Settings</span>
          <button className="voice-settings-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="voice-settings-row voice-toggle-row">
          <span>Rotate Map While Walking</span>
          <input type="checkbox" checked={headingUp} onChange={onToggleHeadingUp} />
        </div>

        <div className="voice-settings-row voice-toggle-row">
          <span>Auto Recenter</span>
          <input type="checkbox" checked={autoRecenter} onChange={e => onToggleAutoRecenter(e.target.checked)} />
        </div>

        <div className="voice-settings-row voice-toggle-row">
          <span>Dynamic Zoom</span>
          <input type="checkbox" checked={dynamicZoom} onChange={e => onToggleDynamicZoom(e.target.checked)} />
        </div>

        <div className="voice-settings-section-label">Voice Guidance</div>

        {!supported && (
          <p className="voice-settings-warning">
            ⚠ Your browser doesn't support speech synthesis. Voice guidance is unavailable.
          </p>
        )}

        <div className="voice-settings-row voice-toggle-row">
          <span>Enable voice</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!supported}
            onChange={e => setEnabled(e.target.checked)}
          />
        </div>

        <div className="voice-settings-row">
          <span>Volume</span>
          <input
            type="range" min="0" max="1" step="0.05"
            value={settings.volume}
            disabled={!supported || !settings.enabled}
            onChange={e => setVolume(parseFloat(e.target.value))}
          />
        </div>

        <div className="voice-settings-row">
          <span>Speed</span>
          <input
            type="range" min="0.5" max="2" step="0.1"
            value={settings.rate}
            disabled={!supported || !settings.enabled}
            onChange={e => setRate(parseFloat(e.target.value))}
          />
        </div>

        <button
          className="voice-test-btn"
          onClick={testVoice}
          disabled={!supported}
        >
          ▶  Test Voice
        </button>
      </div>
    </div>
  )
}
