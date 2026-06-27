// Thin client for the Campus Copilot text-understanding endpoint. Mirrors
// the style of ../api.js but lives separately since this is the one POST
// call the chatbot needs and everything else it does reuses ../api.js and
// the existing utils/* helpers directly.
import { API_BASE } from '../api'

/**
 * Classify one chat message. `context` is whatever the caller wants echoed
 * back (Phase 1 doesn't require anything specific here — conversation
 * state lives in the frontend, see copilotEngine.js).
 */
export async function copilotChat(message, context) {
  const res = await fetch(`${API_BASE}/api/copilot/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context: context || null }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.detail || `Copilot request failed: ${res.status}`)
  }
  return res.json()
}
