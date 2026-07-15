/**
 * AdminAnalytics.jsx — Phase X (Feature 2: Navigation Analytics).
 *
 * Lazy-loaded from AdminDashboard.jsx (see PERFORMANCE: "lazy-load heavy
 * admin pages" in the brief) since it pulls a date-range's worth of
 * aggregated data and renders several tables/charts that public-facing
 * users never need to download.
 *
 * Self-contained like VenueMenuAdmin.jsx / PosterManager.jsx: own
 * API_BASE + token-bearer fetch helper rather than importing api.js,
 * matching this codebase's existing admin-subcomponent convention.
 */
import { useEffect, useState } from 'react'
import { API_BASE } from '../../apiBase'

async function adminGet(path, token) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || `Error ${res.status}`)
  }
  return res.json()
}

const RANGES = [7, 30, 90]

const card = {
  background: 'var(--surface)', borderRadius: 14, padding: '14px 16px', boxShadow: 'var(--shadow-sm)',
}
const cardLabel = { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6 }
const cardValue = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.5rem', color: 'var(--ink)' }
const sectionTitle = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.92rem', color: 'var(--ink)', margin: '18px 0 8px' }
const tableRow = { display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: '0.85rem' }

function Cards({ totals }) {
  const items = [
    ['Searches', totals.searches],
    ['No-result searches', totals.no_result_searches],
    ['Route requests', totals.route_requests],
    ['Reroutes', totals.reroutes],
    ['Trips started', totals.trips_started],
    ['Trips completed', totals.trips_completed],
    ['Trips cancelled', totals.trips_cancelled],
    ['Success rate', totals.navigation_success_rate != null ? `${Math.round(totals.navigation_success_rate * 100)}%` : '—'],
    ['Avg trip distance', totals.avg_trip_distance_m != null ? `${Math.round(totals.avg_trip_distance_m)} m` : '—'],
    ['Avg trip duration', totals.avg_trip_duration_s != null ? `${Math.round(totals.avg_trip_duration_s / 60)} min` : '—'],
    ['Avg GPS accuracy', totals.avg_gps_accuracy_m != null ? `${Math.round(totals.avg_gps_accuracy_m)} m` : '—'],
    ['Event page views', totals.event_page_views],
    ['Offline sessions', totals.offline_sessions],
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
      {items.map(([label, value]) => (
        <div key={label} style={card}>
          <div style={cardLabel}>{label}</div>
          <div style={cardValue}>{value ?? '—'}</div>
        </div>
      ))}
    </div>
  )
}

function TopList({ title, rows, emptyLabel = 'No data yet.' }) {
  return (
    <div style={card}>
      <div style={{ ...cardLabel, marginBottom: 8 }}>{title}</div>
      {(!rows || rows.length === 0) && <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{emptyLabel}</div>}
      {rows?.map((r) => (
        <div key={r.key} style={tableRow}>
          <span style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>{r.key}</span>
          <span style={{ color: 'var(--muted)', fontWeight: 700, flexShrink: 0 }}>{r.count}</span>
        </div>
      ))}
    </div>
  )
}

function UsageChart({ title, rows }) {
  const max = Math.max(1, ...(rows || []).map((r) => r.count))
  return (
    <div style={card}>
      <div style={{ ...cardLabel, marginBottom: 8 }}>{title}</div>
      {(!rows || rows.length === 0) && <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>No data yet.</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 90 }}>
        {rows?.map((r) => (
          <div key={r.period} title={`${r.period}: ${r.count}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
            <div style={{ width: '100%', maxWidth: 22, borderRadius: 4, background: 'var(--brand)', height: `${Math.max(3, (r.count / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function AdminAnalytics({ token }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    adminGet(`/api/admin/analytics/summary?days=${days}`, token)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, token])

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.05rem', color: 'var(--ink)' }}>
          Navigation Analytics
        </div>
        <div style={{ flex: 1 }} />
        {RANGES.map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            style={{
              padding: '6px 14px', borderRadius: 999, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer',
              background: days === d ? 'var(--ink)' : 'transparent', color: days === d ? 'var(--canvas)' : 'var(--ink)', border: '1px solid var(--line)',
            }}
          >
            {d}d
          </button>
        ))}
      </div>

      <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 14 }}>
        Anonymous, aggregate-only — no names, devices, or accounts are ever recorded.
      </div>

      {loading && <div className="state-message">Loading analytics…</div>}
      {error && <div style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</div>}

      {data && (
        <>
          <Cards totals={data.totals} />

          <div style={sectionTitle}>Usage over time</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <UsageChart title="Daily trips started" rows={data.daily_usage} />
            <UsageChart title="Weekly trips started" rows={data.weekly_usage} />
            <UsageChart title="Monthly trips started" rows={data.monthly_usage} />
          </div>

          <div style={sectionTitle}>Top lists</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <TopList title="🔍 Top searched" rows={data.top_searched} />
            <TopList title="🚫 Searches with no results" rows={data.no_result_search_terms} />
            <TopList title="📍 Top destinations" rows={data.top_destinations} />
            <TopList title="🚩 Most common starting points" rows={data.top_starting_points} />
            <TopList title="🔁 Most rerouted destinations" rows={data.most_rerouted_destinations} />
            <TopList title="✕ Most cancelled routes" rows={data.most_cancelled_destinations} />
            <TopList title="📷 Most viewed events (QR proxy)" rows={data.most_viewed_events} />
            <TopList title="📶 GPS weak-signal zones (walkway node)" rows={data.gps_weak_signal_zones} emptyLabel="No weak-signal samples yet." />
          </div>
        </>
      )}
    </div>
  )
}
