/**
 * VoiceSettingsPanel — overlay modal for controlling spoken
 * turn-by-turn guidance.
 *
 * Settings are owned by useVoiceGuidance() and persisted to localStorage
 * there; this component is purely presentational. It receives the whole
 * `voice` object returned by that hook (supported, settings, setEnabled,
 * setVolume, setRate, testVoice) plus `open`/`onClose` from the page.
 */
export default function VoiceSettingsPanel({ voice, open, onClose }) {
  if (!open) return null

  const { settings, setEnabled, setVolume, setRate, testVoice, supported } = voice

  return (
    <div className="voice-settings-overlay" onClick={onClose}>
      <div className="voice-settings-panel" onClick={e => e.stopPropagation()}>
        <div className="voice-settings-header">
          <span>Voice Navigation</span>
          <button className="voice-settings-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

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
