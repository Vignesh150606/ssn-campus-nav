/**
 * OfflineIndicator.jsx — subtle offline-state badge for the header.
 *
 * Phase X (Feature 1 — Offline-First Experience). "Offline state should be
 * subtle... no intrusive popups" — this renders nothing at all while
 * online, and a small static badge (no animation, no toast, no modal)
 * while offline. Reuses the existing --warning* theme tokens rather than
 * introducing new colors.
 */
import { useOnlineStatus } from '../offline/useOnlineStatus'

export default function OfflineIndicator() {
  const { online, hasCache } = useOnlineStatus()
  if (online) return null

  return (
    <div
      className="offline-indicator"
      role="status"
      aria-live="polite"
      title={
        hasCache
          ? "You're offline — navigation is using cached campus data."
          : "You're offline and this device has no cached campus data yet."
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: 'var(--warning-bg)',
        color: 'var(--warning-ink)',
        border: '1px solid var(--warning)',
        fontFamily: 'var(--font-sans)',
        fontSize: '0.72rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning-ink)', flexShrink: 0 }}
      />
      {/* UI/UX review — the "no cache yet" case needs the longer, more
          important warning (there's nothing this device can fall back on
          right now), but on the narrowest phones that text alone was
          wide enough to overlap the brand title next to it (confirmed
          against a real render). Splitting the "— limited" qualifier
          into its own span lets a narrow-viewport rule hide just that
          part — the shorter "Offline" still shows, the full detail is
          still one long-press/hover away via the title attribute above,
          and the common case (hasCache: true, just "Offline") is
          untouched either way. */}
      Offline{!hasCache && <span className="offline-indicator-detail"> — limited</span>}
    </div>
  )
}
