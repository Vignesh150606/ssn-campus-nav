import { createContext, useContext } from 'react'

export const LocationContext = createContext(null)

export function useLocationContext() {
  const ctx = useContext(LocationContext)
  if (!ctx) {
    throw new Error('useLocationContext must be used within a <LocationProvider>')
  }
  return ctx
}
