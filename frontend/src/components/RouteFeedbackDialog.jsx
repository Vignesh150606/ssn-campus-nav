/**
 * RouteFeedbackDialog.jsx — "Was the route accurate?" prompt.
 *
 * Phase X (Feature 3 — Route Feedback System).
 *
 * Shown when navigation ends (destination reached, or the user exits
 * early) — see Home.jsx's handleClear, the single place every "navigation
 * is over" path already funnels through. Deliberately lightweight and easy
 * to dismiss (backdrop click, Skip, ✕) — "no intrusive popups" — and never
 * blocks anything else on screen; it's a small centered card, not a
 * full-screen takeover.
 */
import { useState } from 'react'
import { submitFeedback, uploadFeedbackScreenshot } from '../api'

const CATEGORIES = [
  { key: 'incorrect_route',   label: 'Incorrect route' },
  { key: 'blocked_path',      label: 'Blocked path' },
  { key: 'construction',      label: 'Construction' },
  { key: 'wrong_destination', label: 'Wrong destination' },
  { key: 'poor_gps',          label: 'Poor GPS' },
  { key: 'voice_issue',       label: 'Voice issue' },
  { key: 'other',             label: 'Other' },
]

const card = {
  width: 'min(420px, 92vw)',
  maxHeight: '86vh',
  overflowY: 'auto',
  background: 'var(--surface)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-lg)',
  padding: '20px 20px 16px',
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink)',
}
const chip = (active) => ({
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: '0.78rem',
  fontWeight: 600,
  cursor: 'pointer',
  border: `1px solid ${active ? 'var(--brand)' : 'var(--line-strong)'}`,
  background: active ? 'var(--brand)' : 'var(--canvas)',
  color: active ? '#fff' : 'var(--ink)',
})

export default function RouteFeedbackDialog({ open, context, onClose }) {
  const [rating, setRating] = useState(0)
  const [accurate, setAccurate] = useState(null) // true | false | null
  const [categories, setCategories] = useState([])
  const [comment, setComment] = useState('')
  const [screenshot, setScreenshot] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)

  if (!open) return null

  function reset() {
    setRating(0); setAccurate(null); setCategories([]); setComment('')
    setScreenshot(null); setSubmitting(false); setDone(false); setError(null)
  }

  function close() {
    reset()
    onClose?.()
  }

  function toggleCategory(key) {
    setCategories((cs) => (cs.includes(key) ? cs.filter((c) => c !== key) : [...cs, key]))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await submitFeedback({
        destination_id: context?.destinationId ?? null,
        destination_name: context?.destinationName ?? null,
        rating: rating || null,
        accurate,
        categories,
        comment,
        distance_m: context?.distanceM ?? null,
        arrived: !!context?.arrived,
      })
      if (screenshot && res?.feedback_id) {
        // Best-effort — a failed screenshot upload shouldn't undo an
        // otherwise-successful feedback submission.
        uploadFeedbackScreenshot(res.feedback_id, screenshot).catch(() => {})
      }
      setDone(true)
      setTimeout(close, 1400)
    } catch (e) {
      setError(e.message || 'Could not submit feedback — please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Route feedback"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.42)', padding: 16,
      }}
    >
      <div style={card}>
        {done ? (
          <div style={{ textAlign: 'center', padding: '18px 4px' }}>
            <div style={{ fontSize: '1.6rem', marginBottom: 6 }}>✓</div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>Thanks for the feedback!</div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.02rem' }}>
                  How was this route?
                </div>
                {context?.destinationName && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 2 }}>
                    to {context.destinationName}
                  </div>
                )}
              </div>
              <button
                onClick={close}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1 }}
              >
                ✕
              </button>
            </div>

            {/* Star rating */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setRating(n)}
                  aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.6rem', lineHeight: 1, padding: 0, color: n <= rating ? '#F5A623' : 'var(--line-strong)' }}
                >
                  ★
                </button>
              ))}
            </div>

            {/* Accurate? */}
            <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: 6 }}>Was the route accurate?</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <button onClick={() => setAccurate(true)} style={chip(accurate === true)}>👍 Yes</button>
              <button onClick={() => setAccurate(false)} style={chip(accurate === false)}>👎 No</button>
            </div>

            {/* Problem categories — only worth asking if something went wrong */}
            {accurate === false && (
              <>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: 6 }}>What went wrong?</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                  {CATEGORIES.map((c) => (
                    <button key={c.key} onClick={() => toggleCategory(c.key)} style={chip(categories.includes(c.key))}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            <textarea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional comments…"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                border: '1px solid var(--line-strong)', fontFamily: 'var(--font-sans)', fontSize: '0.85rem',
                background: 'var(--canvas)', color: 'var(--ink)', resize: 'vertical', marginBottom: 10,
              }}
            />

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 14, cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setScreenshot(e.target.files?.[0] || null)}
                style={{ fontSize: '0.75rem' }}
              />
              {screenshot ? '1 screenshot attached' : 'Attach a screenshot (optional)'}
            </label>

            {error && <div style={{ color: 'var(--danger)', fontSize: '0.78rem', marginBottom: 10 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={close}
                style={{ flex: 1, padding: '11px', borderRadius: 999, background: 'transparent', border: '1px solid var(--line-strong)', color: 'var(--ink)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer' }}
              >
                Skip
              </button>
              <button
                onClick={submit}
                disabled={submitting || (rating === 0 && accurate === null && !comment.trim())}
                style={{ flex: 1, padding: '11px', borderRadius: 999, background: 'var(--brand)', border: 'none', color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer', opacity: submitting ? 0.7 : 1 }}
              >
                {submitting ? 'Sending…' : 'Send feedback'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
