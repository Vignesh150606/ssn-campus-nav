/**
 * NavSettingsPanel — overlay modal for all navigation-session preferences.
 *
 * Phase 4.2.4, Priority 1: previously the only in-navigation preference
 * was voice guidance (VoiceSettingsPanel) — Heading-Up had its own
 * separate always-visible floating toggle (NavCompass) and there was no
 * way to control the compass display or auto-recenter/dynamic-zoom
 * behaviour at all. This consolidates all six into one panel:
 *
 *   Rotate Map While Walking  — headingUp preference (own state, Home.jsx).
 *                                Phase 4.3: the Heading-Up toggle itself is
 *                                the native Leaflet rotate control (see the
 *                                L.Control.Rotate override in MapView.jsx),
 *                                a separate, ALWAYS-visible control during
 *                                navigation — this setting only decides
 *                                whether the map actually rotates, never
 *                                whether that button is shown.
 *   Heading-Up Mode           — headingMode preference (own state, Home.jsx).
 *                                Phase 4.5: Native Leaflet (default) hands
 *                                rotation to leaflet-rotate's own
 *                                compassBearing handler, wrapped with a
 *                                small dead-zone + light smoothing around
 *                                map.setBearing() to blunt magnetometer
 *                                jitter. Smart = our own GPS-course/
 *                                confidence/cooldown fusion pipeline,
 *                                still selectable for anyone who wants
 *                                its heavier stabilization — see
 *                                MapView.jsx's NavigationController for
 *                                how the two are kept from ever running
 *                                at once. The button above still just
 *                                flips headingUp either way; this only
 *                                decides which system answers that toggle.
 *   Show Compass              — showCompass (own state, Home.jsx) — purely
 *                                the decorative NavCompass needle overlay;
 *                                independent of Heading-Up in both
 *                                directions (toggling one never touches
 *                                the other)
 *   Voice Guidance            — reads/writes the EXISTING useVoiceGuidance
 *                                settings object directly; deliberately not
 *                                duplicated here, so there's one source of truth
 *   Auto Recenter             — autoRecenter (own state, Home.jsx)
 *   Dynamic Zoom              — dynamicZoom (own state, Home.jsx)
 *
 * All six are plain in-memory React state owned by Home.jsx — that's
 * enough to satisfy "persist during the current navigation session"
 * (they live for as long as the app is open) without the added
 * complexity/risk of localStorage persistence, which voice guidance
 * already handles separately for the one setting that's meant to
 * survive across sessions.
 *
 * Reuses the existing .voice-settings-* CSS (overlay/panel/header/row
 * styling) rather than introducing a parallel set of class names — the
 * one addition is .heading-mode-toggle/-btn for the Smart/Native segmented
 * control, since nothing multi-option already existed to reuse.
 */
export default function NavSettingsPanel({
  voice, open, onClose,
  headingUp, onToggleHeadingUp,
  headingMode, onSetHeadingMode,
  showCompass, onToggleShowCompass,
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

        {/* Priority 1 (Phase 4.5) — switch between the default Native
            rotation (leaflet-rotate's own compass handler, lightly
            debounced) and our Smart fusion pipeline. See the header
            comment above / MapView.jsx's NavigationController. */}
        <div className="voice-settings-row">
          <span>Heading-Up Mode</span>
          <div className="heading-mode-toggle" role="radiogroup" aria-label="Heading-Up mode">
            <button
              type="button"
              className={`heading-mode-btn${headingMode === 'native' ? ' active' : ''}`}
              aria-pressed={headingMode === 'native'}
              onClick={() => onSetHeadingMode('native')}
            >
              Native Leaflet
            </button>
            <button
              type="button"
              className={`heading-mode-btn${headingMode === 'smart' ? ' active' : ''}`}
              aria-pressed={headingMode === 'smart'}
              onClick={() => onSetHeadingMode('smart')}
            >
              Smart
            </button>
          </div>
        </div>
        {headingMode === 'smart' && (
          <p className="voice-settings-warning">
            ℹ Smart adds fuller GPS-course fusion and stationary-lock
            smoothing on top of the compass — steadier in some spots, but
            reacts a little slower to turns than Native (default).
          </p>
        )}

        <div className="voice-settings-row voice-toggle-row">
          <span>Show Compass</span>
          <input type="checkbox" checked={showCompass} onChange={e => onToggleShowCompass(e.target.checked)} />
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
