/**
 * PosterManager.jsx — Phase 4.2 Priority 4
 *
 * Polished poster / gallery management for an event in the admin dashboard.
 * Supports: 📷 Upload Poster | 🔄 Replace Poster | 🗑 Delete Poster | 👁 Preview
 *
 * Works entirely through the existing backend endpoints:
 *   GET    /api/admin/events/:id/images        → list images
 *   POST   /api/admin/events/:id/images        → upload (is_poster=true|false)
 *   DELETE /api/admin/events/:id/images/:imgId → delete one image
 */
import { useEffect, useRef, useState } from 'react'

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

async function listImages(eventId) {
  return apiFetch(`/api/admin/events/${eventId}/images`)
}

async function uploadImage(eventId, file, isPoster) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('is_poster', isPoster ? 'true' : 'false')
  return apiFetch(`/api/admin/events/${eventId}/images`, { method: 'POST', body: fd })
}

async function deleteImage(eventId, imageId) {
  return apiFetch(`/api/admin/events/${eventId}/images/${imageId}`, { method: 'DELETE' })
}

export default function PosterManager({ eventId, onUpdated }) {
  const [images, setImages]     = useState(null)  // null = loading
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [preview, setPreview]   = useState(null)  // url to show in lightbox
  const uploadRef               = useRef()

  const poster    = images?.find(i => i.is_poster)
  const gallery   = images?.filter(i => !i.is_poster) || []

  function reload() {
    listImages(eventId)
      .then(setImages)
      .catch(e => setError(e.message))
  }

  useEffect(() => { if (eventId) reload() }, [eventId])

  async function handleUpload(isPoster, replaceExisting = false) {
    const file = await pickFile()
    if (!file) return
    setLoading(true); setError(null)
    try {
      // If replacing the poster, delete the old one first so Storage stays clean
      if (replaceExisting && poster) {
        await deleteImage(eventId, poster.id)
      }
      await uploadImage(eventId, file, isPoster)
      reload()
      onUpdated?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(imageId) {
    if (!confirm('Delete this image? This cannot be undone.')) return
    setLoading(true); setError(null)
    try {
      await deleteImage(eventId, imageId)
      reload()
      onUpdated?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/jpeg,image/png,image/webp,image/gif'
      input.onchange = (e) => resolve(e.target.files?.[0] || null)
      input.oncancel = () => resolve(null)
      input.click()
    })
  }

  if (images === null) {
    return <div className="poster-mgr-loading">Loading images…</div>
  }

  return (
    <div className="poster-mgr">
      {error && <div className="poster-mgr-error">{error}</div>}

      {/* ── Poster section ── */}
      <div className="poster-mgr-section">
        <div className="poster-mgr-section-label">Event Poster</div>
        {poster ? (
          <div className="poster-mgr-item">
            <img
              src={poster.url}
              alt="Current poster"
              className="poster-mgr-thumb"
              loading="lazy"
            />
            <div className="poster-mgr-actions">
              <button
                className="poster-mgr-btn preview"
                onClick={() => setPreview(poster.url)}
                aria-label="Preview poster"
              >👁 Preview</button>
              <button
                className="poster-mgr-btn replace"
                onClick={() => handleUpload(true, true)}
                disabled={loading}
                aria-label="Replace poster"
              >🔄 Replace</button>
              <button
                className="poster-mgr-btn delete"
                onClick={() => handleDelete(poster.id)}
                disabled={loading}
                aria-label="Delete poster"
              >🗑 Delete</button>
            </div>
          </div>
        ) : (
          <div className="poster-mgr-empty">
            <span>No poster uploaded yet.</span>
            <button
              className="poster-mgr-btn upload"
              onClick={() => handleUpload(true, false)}
              disabled={loading}
            >📷 Upload Poster</button>
          </div>
        )}
      </div>

      {/* ── Gallery section ── */}
      <div className="poster-mgr-section">
        <div className="poster-mgr-section-label">
          Photo Gallery
          <button
            className="poster-mgr-btn upload small"
            onClick={() => handleUpload(false, false)}
            disabled={loading}
            style={{ marginLeft: 12 }}
          >+ Add Photo</button>
        </div>
        {gallery.length === 0 ? (
          <div className="poster-mgr-empty-small">No gallery photos yet.</div>
        ) : (
          <div className="poster-mgr-gallery">
            {gallery.map(img => (
              <div key={img.id} className="poster-mgr-gallery-item">
                <img
                  src={img.url}
                  alt="Gallery photo"
                  className="poster-mgr-gallery-thumb"
                  loading="lazy"
                  onClick={() => setPreview(img.url)}
                />
                <div className="poster-mgr-gallery-actions">
                  <button
                    className="poster-mgr-btn preview small"
                    onClick={() => setPreview(img.url)}
                    aria-label="Preview photo"
                  >👁</button>
                  <button
                    className="poster-mgr-btn delete small"
                    onClick={() => handleDelete(img.id)}
                    disabled={loading}
                    aria-label="Delete photo"
                  >🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Lightbox ── */}
      {preview && (
        <div
          className="poster-mgr-lightbox"
          onClick={() => setPreview(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
        >
          <button
            className="poster-mgr-lightbox-close"
            onClick={() => setPreview(null)}
          >✕</button>
          <img
            src={preview}
            alt="Preview"
            className="poster-mgr-lightbox-img"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}

      <input ref={uploadRef} type="file" accept="image/*" style={{ display: 'none' }} />
    </div>
  )
}
