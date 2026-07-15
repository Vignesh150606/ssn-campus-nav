/**
 * useOnlineStatus.js — subscribes a component to the offline bundle's
 * reactive status (online/offline, whether a cache exists, last sync time).
 *
 * Phase X (Feature 1 — Offline-First Experience).
 */
import { useEffect, useState } from 'react'
import { getOfflineStatus, subscribeOfflineStatus } from './offlineBundle'

export function useOnlineStatus() {
  const [status, setStatus] = useState(getOfflineStatus())
  useEffect(() => subscribeOfflineStatus(setStatus), [])
  return status
}
