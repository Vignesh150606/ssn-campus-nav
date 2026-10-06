/** Local navigation readiness and observed synchronization status. */
import { useOnlineStatus } from '../offline/useOnlineStatus'

export default function OfflineIndicator() {
  const { online, hasCache, graphUpdated, updateAvailable, storageError, closuresSyncedAt } = useOnlineStatus()
  if (online === true && !graphUpdated && !updateAvailable && !storageError && closuresSyncedAt) return null
  if (online === null && !storageError) return null
  const label = storageError ? 'Cache unavailable' : online === true ? (updateAvailable ? 'Map update available' : graphUpdated ? 'Map updated' : 'Saved road status') : 'Local mode'
  const compactLabel = storageError ? 'Unsaved' : online === true ? 'Map' : 'Local'

  return (
    <div
      className="offline-indicator"
      role="status"
      aria-live="polite"
      aria-label={`${label}${online === false ? ' — no sync' : ''}`}
      title={
        storageError || (hasCache
          ? `Navigation uses saved campus data. Road status: ${closuresSyncedAt ? new Date(closuresSyncedAt).toLocaleString() : 'build-time copy; waiting for synchronization'}.`
          : "Offline navigation is not saved on this device yet.")
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px var(--offline-badge-padding, 10px)',
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
      <span className="offline-indicator-label">{label}</span>
      <span className="offline-indicator-compact" aria-hidden="true">{compactLabel}</span>
      {online === false && <span className="offline-indicator-detail"> — no sync</span>}
    </div>
  )
}
