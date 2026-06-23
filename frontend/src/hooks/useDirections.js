/**
 * Fetches walking route from our own FastAPI backend (no Google API needed).
 * Returns path, distance, eta and triggers live tracking updates.
 */
import { useState, useCallback } from 'react'
import { getRoute } from '../api'

export function useDirections() {
  const [path, setPath]       = useState(null)
  const [distance, setDistance] = useState(null)
  const [eta, setEta]         = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  const fetchDirections = useCallback(async (fromId, toId, onPathReady) => {
    setLoading(true)
    setError(null)
    try {
      const r = await getRoute(fromId, toId)
      setPath(r.path)
      setDistance(r.distance_m)
      setEta(r.eta_minutes)
      if (onPathReady) onPathReady(r.path)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const clear = useCallback(() => {
    setPath(null)
    setDistance(null)
    setEta(null)
    setError(null)
  }, [])

  return { path, distance, eta, loading, error, fetchDirections, clear }
}
