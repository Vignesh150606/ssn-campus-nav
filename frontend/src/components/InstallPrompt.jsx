/**
 * InstallPrompt.jsx — PWA install banner.
 *
 * Priority 2 (PWA Install Experience). Captures the browser's
 * `beforeinstallprompt` event (Chrome/Edge/Android — iOS Safari never
 * fires this; there's no equivalent programmatic prompt there, so this
 * banner simply never appears on iOS) and shows a small, dismissible
 * banner offering to install the app, instead of letting the browser's
 * own generic mini-infobar handle it.
 *
 * "Don't annoy users by repeatedly prompting": the user's choice is
 * remembered in localStorage —
 *   - Install accepted  -> never shown again.
 *   - Install dismissed / "Later" tapped -> hidden for INSTALL_PROMPT
 *     cooldown days, so there's still a later chance without nagging
 *     every visit.
 * Also never shown at all if the app is already running installed
 * (standalone display mode / iOS's `navigator.standalone`).
 */
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'ssn_install_prompt_v1'
const DISMISS_COOLDOWN_DAYS = 14

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

function writeState(status) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ status, at: Date.now() }))
  } catch {
    /* storage quota / private mode — worst case the banner can reappear */
  }
}

function isStandalone() {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator?.standalone === true // iOS Safari, already added to home screen
  )
}

function shouldOfferPrompt() {
  const saved = readState()
  if (!saved) return true
  if (saved.status === 'installed') return false
  if (saved.status === 'dismissed') {
    const elapsedDays = (Date.now() - saved.at) / (1000 * 60 * 60 * 24)
    return elapsedDays >= DISMISS_COOLDOWN_DAYS
  }
  return true
}

export default function InstallPrompt() {
  const [deferredEvent, setDeferredEvent] = useState(null)
  const [visible, setVisible] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (isStandalone() || !shouldOfferPrompt()) return

    function onBeforeInstallPrompt(e) {
      e.preventDefault() // suppress the browser's own mini-infobar — we show our own
      setDeferredEvent(e)
      setVisible(true)
    }
    function onAppInstalled() {
      writeState('installed')
      setVisible(false)
      setDeferredEvent(null)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onAppInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onAppInstalled)
    }
  }, [])

  if (!visible || !deferredEvent) return null

  async function handleInstall() {
    setInstalling(true)
    deferredEvent.prompt()
    try {
      const { outcome } = await deferredEvent.userChoice
      writeState(outcome === 'accepted' ? 'installed' : 'dismissed')
    } catch {
      writeState('dismissed')
    } finally {
      setInstalling(false)
      setVisible(false)
      setDeferredEvent(null) // a prompt() event can only be used once
    }
  }

  function handleLater() {
    writeState('dismissed')
    setVisible(false)
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--line)',
        boxShadow: 'var(--shadow-xs)',
        flexShrink: 0,
      }}
    >
      <img
        src="/icons/icon-192.png"
        alt=""
        aria-hidden="true"
        style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-sans)', fontSize: '0.82rem', color: 'var(--ink)', lineHeight: 1.3 }}>
        Install SSN Campus Navigator for faster access.
      </div>
      <button
        type="button"
        onClick={handleLater}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--muted)',
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          fontSize: '0.8rem',
          padding: '8px 10px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Later
      </button>
      <button
        type="button"
        onClick={handleInstall}
        disabled={installing}
        style={{
          background: 'var(--brand)',
          border: 'none',
          color: '#fff',
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: '0.8rem',
          padding: '8px 16px',
          borderRadius: 999,
          cursor: 'pointer',
          opacity: installing ? 0.7 : 1,
          flexShrink: 0,
        }}
      >
        {installing ? 'Installing…' : 'Install'}
      </button>
    </div>
  )
}
