/**
 * PosterManager.jsx — Phase 4.2 / 4.2.1
 *
 * Polished poster / gallery management for an event in the admin dashboard.
 * Supports: 📷 Upload Poster | 🔄 Replace Poster | 🗑 Delete Poster | 👁 Preview
 *
 * Phase 4.2.1 fix: token is passed as a prop from AdminDashboard (which holds
 * the real JWT in sessionStorage under 'ssn_admin_token_v1'). The old version
 * tried localStorage.getItem('ssn_admin_token') — wrong storage type + wrong
 * key — which always returned null and caused every request to 401.
 *
 * Backend endpoints:
 *   GET    /api/admin/events/:id/images        → list images
 *   POST   /api/admin/events/:id/images        → upload (is_poster=true|false)
 *   DELETE /api/admin/events/:id/images/:imgId → delete one image
 *
 * W2 (static snapshots) — images are now optimised for the fest crowd:
 *   - the browser shrinks/re-encodes to WebP (<=1080px) BEFORE uploading (saves
 *     admin mobile data; falls back to the original file if the browser can't);
 *   - the backend ALWAYS re-encodes to WebP <=150 KB and returns the final
 *     size, which is shown after each upload;
 *   - every image is lazy-loaded + async-decoded.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'

const MAX_UPLOAD_WIDTH = 1080

/** Best-effort client-side shrink. Resolves to a smaller WebP File, or the original
 *  file untouched if anything about it isn't supported (GIF, old Safari, decode error).
 *  The backend re-optimises regardless, so this is purely a bandwidth saver. */
async function shrinkImage(file) {
  try {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') return file
    if (typeof createImageBitmap !== 'function') return file
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_UPLOAD_WIDTH / bmp.width)
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
    bmp.close?.()
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
    // Browsers without WebP encoding silently hand back PNG: that would be bigger, so keep the original.
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' })
  } catch {
    return file
  }
}

async function apiFetch(path, options = {}, token) {
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

async function listImages(eventId, token) {
  return apiFetch(`/api/admin/events/${eventId}/images`, {}, token)
}

async function uploadImage(eventId, file, isPoster, token) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('is_poster', isPoster ? 'true' : 'false')
  return apiFetch(`/api/admin/events/${eventId}/images`, { method: 'POST', body: fd }, token)
}

async function deleteImage(eventId, imageId, token) {
  return apiFetch(`/api/admin/events/${eventId}/images/${imageId}`, { method: 'DELETE' }, token)
}

export default function PosterManager({ eventId, token, onUpdated }) {
  const [images, setImages]     = useState(null)  // null = loading
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [preview, setPreview]   = useState(null)
  const [notice, setNotice]     = useState(null)  // e.g. "Uploaded - 118 KB WebP"
  const uploadRef               = useRef()

  const poster  = images?.find(i => i.is_poster)
  const gallery = images?.filter(i => !i.is_poster) || []

  // Item 26 — eslint flagged this effect as missing `reload` from its
  // deps. Naively adding it as-is would refetch on every render (a plain
  // function declaration is a brand-new reference each render), so it's
  // wrapped in useCallback first — the effect now correctly declares its
  // real dependency, and only re-runs when eventId/token actually change,
  // exactly like before.
  const reload = useCallback(() => {
    if (!token) {
      setImages([])
      setError('Not authenticated — please log in again.')
      return
    }
    setError(null)
    listImages(eventId, token)
      .then(data => setImages(Array.isArray(data) ? data : []))
      .catch(e => {
        // Phase 4.2.1 fix: always exit loading state on error
        setImages([])
        setError(e.message)
      })
  }, [eventId, token])

  useEffect(() => { if (eventId) reload() }, [eventId, reload])

  async function handleUpload(isPoster, replaceExisting = false) {
    const file = await pickFile()
    if (!file) return
    setLoading(true); setError(null); setNotice(null)
    try {
      if (replaceExisting && poster) {
        await deleteImage(eventId, poster.id, token)
      }
      const res = await uploadImage(eventId, await shrinkImage(file), isPoster, token)
      if (res?.bytes) {
        setNotice(`Uploaded: ${Math.round(res.bytes / 1024)} KB${res.width ? ` WebP (${res.width}×${res.height})` : ''}. Visitors see it within about a minute.`)
      }
      reload(); onUpdated?.()
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
      await deleteImage(eventId, imageId, token)
      reload(); onUpdated?.()
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
      {notice && <div className="poster-mgr-notice" role="status" style={{ color: '#2e7d32', fontSize: 13, margin: '6px 0' }}>{notice}</div>}

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
              decoding="async"
              onClick={() => setPreview(poster.url)}
            />
            <div className="poster-mgr-actions">
              <button className="poster-mgr-btn preview" onClick={() => setPreview(poster.url)}>👁 Preview</button>
              <button className="poster-mgr-btn replace" onClick={() => handleUpload(true, true)} disabled={loading}>🔄 Replace</button>
              <button className="poster-mgr-btn delete"  onClick={() => handleDelete(poster.id)} disabled={loading}>🗑 Delete</button>
            </div>
          </div>
        ) : (
          <div className="poster-mgr-empty">
            <span>No posters uploaded yet.</span>
            <button className="poster-mgr-btn upload" onClick={() => handleUpload(true, false)} disabled={loading}>
              📷 Upload Poster
            </button>
          </div>
        )}
      </div>

      {/* ── Gallery section ── */}
      <div className="poster-mgr-section">
        <div className="poster-mgr-section-label">
          Photo Gallery
          <button className="poster-mgr-btn upload small" onClick={() => handleUpload(false, false)} disabled={loading} style={{ marginLeft: 12 }}>
            + Add Photo
          </button>
        </div>
        {gallery.length === 0 ? (
          <div className="poster-mgr-empty-small">No gallery photos yet.</div>
        ) : (
          <div className="poster-mgr-gallery">
            {gallery.map(img => (
              <div key={img.id} className="poster-mgr-gallery-item">
                <img src={img.url} alt="Gallery photo" className="poster-mgr-gallery-thumb" loading="lazy" decoding="async" onClick={() => setPreview(img.url)} />
                <div className="poster-mgr-gallery-actions">
                  <button className="poster-mgr-btn preview small" onClick={() => setPreview(img.url)}>👁</button>
                  <button className="poster-mgr-btn delete small"  onClick={() => handleDelete(img.id)} disabled={loading}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Lightbox ── */}
      {preview && (
        <div className="poster-mgr-lightbox" onClick={() => setPreview(null)} role="dialog" aria-modal="true" aria-label="Image preview">
          <button className="poster-mgr-lightbox-close" onClick={() => setPreview(null)}>✕</button>
          <img src={preview} alt="Preview" className="poster-mgr-lightbox-img" decoding="async" onClick={e => e.stopPropagation()} />
        </div>
      )}

      <input ref={uploadRef} type="file" accept="image/*" style={{ display: 'none' }} />
    </div>
  )
}
