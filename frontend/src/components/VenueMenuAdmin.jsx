/**
 * VenueMenuAdmin.jsx — Phase 4.2 Priority 3
 *
 * Admin panel for managing food court daily menus.
 * Each food/dining venue gets one menu image per day.
 * Supports: Upload | Replace | Delete | Preview
 */
import { useEffect, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('ssn_admin_token')
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `Request failed: ${res.status}`)
  }
  return res.json()
}

async function getVenueMenu(venueId, date) {
  const q = date ? `?date=${encodeURIComponent(date)}` : ''
  const res = await fetch(`${API_BASE}/api/locations/${encodeURIComponent(venueId)}/menu${q}`)
  if (!res.ok) return null
  return res.json()
}

async function uploadMenu(venueId, date, file, description) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('date', date)
  if (description) fd.append('description', description)
  return apiFetch(`/api/admin/locations/${encodeURIComponent(venueId)}/menu`, {
    method: 'POST',
    body: fd,
  })
}

async function deleteMenu(venueId, date) {
  return apiFetch(
    `/api/admin/locations/${encodeURIComponent(venueId)}/menu?date=${encodeURIComponent(date)}`,
    { method: 'DELETE' }
  )
}

const FOOD_CATEGORIES = ['food', 'dining']

export default function VenueMenuAdmin({ venues }) {
  const foodVenues = (venues || []).filter(v => FOOD_CATEGORIES.includes(v.category))

  const today = new Date().toISOString().slice(0, 10)

  const [selectedVenueId, setSelectedVenueId] = useState(foodVenues[0]?.id || '')
  const [selectedDate,    setSelectedDate]    = useState(today)
  const [menu,            setMenu]            = useState(null)   // current menu for selected venue+date
  const [loadingMenu,     setLoadingMenu]     = useState(false)
  const [description,     setDescription]     = useState('')
  const [uploading,       setUploading]       = useState(false)
  const [deleting,        setDeleting]        = useState(false)
  const [error,           setError]           = useState(null)
  const [success,         setSuccess]         = useState(null)
  const [preview,         setPreview]         = useState(null)

  function flash(msg) {
    setSuccess(msg)
    setTimeout(() => setSuccess(null), 3000)
  }

  function reload() {
    if (!selectedVenueId) return
    setLoadingMenu(true)
    getVenueMenu(selectedVenueId, selectedDate)
      .then(m => { setMenu(m); setDescription(m?.description || '') })
      .catch(() => setMenu(null))
      .finally(() => setLoadingMenu(false))
  }

  useEffect(() => { reload() }, [selectedVenueId, selectedDate])

  async function handleUpload() {
    const file = await pickFile()
    if (!file) return
    setUploading(true); setError(null)
    try {
      const m = await uploadMenu(selectedVenueId, selectedDate, file, description)
      setMenu(m)
      flash(menu ? 'Menu replaced successfully.' : 'Menu uploaded successfully.')
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete() {
    if (!confirm('Delete today\'s menu image? This cannot be undone.')) return
    setDeleting(true); setError(null)
    try {
      await deleteMenu(selectedVenueId, selectedDate)
      setMenu(null); setDescription('')
      flash('Menu deleted.')
    } catch (e) {
      setError(e.message)
    } finally {
      setDeleting(false)
    }
  }

  function pickFile() {
    return new Promise(resolve => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/jpeg,image/png,image/webp'
      input.onchange = e => resolve(e.target.files?.[0] || null)
      input.oncancel  = () => resolve(null)
      input.click()
    })
  }

  if (foodVenues.length === 0) {
    return <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>No food/dining venues found.</p>
  }

  const busy = uploading || deleting

  return (
    <div className="venue-menu-admin">
      <div className="venue-menu-admin-controls">
        <label className="venue-menu-admin-label">
          Venue
          <select
            className="venue-menu-admin-select"
            value={selectedVenueId}
            onChange={e => setSelectedVenueId(e.target.value)}
          >
            {foodVenues.map(v => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>

        <label className="venue-menu-admin-label">
          Date
          <input
            type="date"
            className="venue-menu-admin-date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
          />
        </label>
      </div>

      <label className="venue-menu-admin-label" style={{ marginTop: 12 }}>
        Description (optional)
        <input
          type="text"
          className="venue-menu-admin-desc"
          placeholder="e.g. Veg thali + biryani today"
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={120}
        />
      </label>

      {error   && <div className="venue-menu-admin-error">{error}</div>}
      {success && <div className="venue-menu-admin-success">✓ {success}</div>}

      {loadingMenu ? (
        <div className="venue-menu-admin-status">Loading…</div>
      ) : menu ? (
        <div className="venue-menu-admin-existing">
          <div className="venue-menu-admin-status">
            Menu already uploaded for this date
            {menu.description && <> — <em>{menu.description}</em></>}
          </div>
          <img
            src={menu.image_url}
            alt="Current menu"
            className="venue-menu-admin-preview-thumb"
            onClick={() => setPreview(menu.image_url)}
          />
          <div className="venue-menu-admin-btn-row">
            <button className="venue-menu-admin-btn preview" onClick={() => setPreview(menu.image_url)}>
              👁 Preview
            </button>
            <button className="venue-menu-admin-btn replace" onClick={handleUpload} disabled={busy}>
              🔄 Replace
            </button>
            <button className="venue-menu-admin-btn delete" onClick={handleDelete} disabled={busy}>
              🗑 Delete
            </button>
          </div>
        </div>
      ) : (
        <div className="venue-menu-admin-empty">
          <span>No menu uploaded for this date.</span>
          <button className="venue-menu-admin-btn upload" onClick={handleUpload} disabled={busy}>
            📷 Upload Menu Image
          </button>
        </div>
      )}

      {/* Lightbox */}
      {preview && (
        <div
          className="poster-mgr-lightbox"
          onClick={() => setPreview(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Menu preview"
        >
          <button className="poster-mgr-lightbox-close" onClick={() => setPreview(null)}>✕</button>
          <img
            src={preview}
            alt="Menu preview"
            className="poster-mgr-lightbox-img"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
