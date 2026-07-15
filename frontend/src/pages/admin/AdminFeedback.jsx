/**
 * AdminFeedback.jsx — Phase X (Feature 3: Route Feedback System).
 *
 * Lazy-loaded from AdminDashboard.jsx. Self-contained like
 * VenueMenuAdmin.jsx / PosterManager.jsx (own API_BASE + token-bearer
 * fetch helper) rather than importing api.js.
 */
import { useEffect, useState } from 'react'
import { API_BASE } from '../../apiBase'

async function adminFetch(path, method, body, token) {
  const headers = { Authorization: `Bearer ${token}` }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : null })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.detail || `Error ${res.status}`)
  }
  return res.json()
}

const STATUS_COLOR = { pending: '#E07414', reviewed: '#4f8fd8', resolved: '#2E9E5B' }
const RESOLUTION_COLOR = { accepted: '#2E9E5B', rejected: '#D7263D', fixed: '#2E9E5B' }
const FILTERS = [['', 'All'], ['pending', 'Pending'], ['reviewed', 'Reviewed'], ['resolved', 'Resolved']]

const pill = { padding: '6px 12px', borderRadius: 999, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.76rem', cursor: 'pointer', border: 'none' }

function CategoryLabel(key) {
  return {
    incorrect_route: 'Incorrect route', blocked_path: 'Blocked path', construction: 'Construction',
    wrong_destination: 'Wrong destination', poor_gps: 'Poor GPS', voice_issue: 'Voice issue', other: 'Other',
  }[key] || key
}

export default function AdminFeedback({ token }) {
  const [filter, setFilter] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)

  function load() {
    setLoading(true); setError(null)
    const q = filter ? `?status=${filter}` : ''
    adminFetch(`/api/admin/feedback${q}`, 'GET', null, token)
      .then(setItems)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [filter, token])

  function flash(text) { setMsg(text); setTimeout(() => setMsg(null), 3000) }

  async function updateStatus(id, patch) {
    try {
      await adminFetch(`/api/admin/feedback/${id}`, 'PATCH', patch, token)
      flash('Updated.')
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.05rem', color: 'var(--ink)' }}>
          Route Feedback
        </div>
        <div style={{ flex: 1 }} />
        {msg && <span style={{ fontSize: '0.8rem', color: '#2E9E5B' }}>{msg}</span>}
        {FILTERS.map(([val, label]) => (
          <button
            key={val || 'all'}
            onClick={() => setFilter(val)}
            style={{ ...pill, background: filter === val ? 'var(--ink)' : 'transparent', color: filter === val ? 'var(--canvas)' : 'var(--ink)', border: '1px solid var(--line)' }}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="state-message">Loading feedback…</div>}
      {error && <div style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</div>}
      {!loading && items.length === 0 && <div className="state-message">No feedback in this view.</div>}

      {items.map((f) => (
        <div key={f.id} style={{ background: 'var(--surface)', borderRadius: 14, padding: '14px 18px', boxShadow: 'var(--shadow-md)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.95rem', color: 'var(--ink)' }}>
                {f.destination_name || f.destination_id || 'Unknown destination'}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 2 }}>
                {new Date(f.created_at).toLocaleString()} · {f.arrived ? 'Arrived' : 'Exited early'}
                {f.distance_m != null && ` · ${Math.round(f.distance_m)}m`}
              </div>
            </div>
            <span style={{
              fontSize: '0.68rem', fontWeight: 700, padding: '3px 10px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.05em',
              background: `${STATUS_COLOR[f.status]}22`, color: STATUS_COLOR[f.status], border: `1px solid ${STATUS_COLOR[f.status]}`,
            }}>
              {f.status}
            </span>
            {f.resolution && (
              <span style={{
                fontSize: '0.68rem', fontWeight: 700, padding: '3px 10px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: `${RESOLUTION_COLOR[f.resolution]}22`, color: RESOLUTION_COLOR[f.resolution], border: `1px solid ${RESOLUTION_COLOR[f.resolution]}`,
              }}>
                {f.resolution}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            {f.rating != null && <span style={{ color: '#F5A623', fontSize: '0.9rem' }}>{'★'.repeat(f.rating)}{'☆'.repeat(5 - f.rating)}</span>}
            {f.accurate != null && <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>{f.accurate ? '👍 Accurate' : '👎 Not accurate'}</span>}
          </div>

          {f.categories?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {f.categories.map((c) => (
                <span key={c} style={{ fontSize: '0.72rem', padding: '3px 10px', borderRadius: 999, background: 'var(--canvas)', border: '1px solid var(--line)', color: 'var(--ink)' }}>
                  {CategoryLabel(c)}
                </span>
              ))}
            </div>
          )}

          {f.comment && <div style={{ fontSize: '0.85rem', color: 'var(--ink-2)', marginTop: 8, lineHeight: 1.5 }}>{f.comment}</div>}

          {f.screenshot_url && (
            <a href={f.screenshot_url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 8 }}>
              <img src={f.screenshot_url} alt="Feedback screenshot" style={{ maxWidth: 160, maxHeight: 120, borderRadius: 8, border: '1px solid var(--line)' }} />
            </a>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {f.status === 'pending' && (
              <button onClick={() => updateStatus(f.id, { status: 'reviewed' })} style={{ ...pill, background: '#4f8fd8', color: '#fff' }}>
                Mark Reviewed
              </button>
            )}
            {f.status !== 'resolved' && (
              <>
                <button onClick={() => updateStatus(f.id, { status: 'resolved', resolution: 'accepted' })} style={{ ...pill, background: '#2E9E5B', color: '#fff' }}>
                  ✓ Accept
                </button>
                <button onClick={() => updateStatus(f.id, { status: 'resolved', resolution: 'fixed' })} style={{ ...pill, background: '#2E9E5B', color: '#fff' }}>
                  🔧 Mark Fixed
                </button>
                <button onClick={() => updateStatus(f.id, { status: 'resolved', resolution: 'rejected' })} style={{ ...pill, background: '#D7263D', color: '#fff' }}>
                  ✗ Reject
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
