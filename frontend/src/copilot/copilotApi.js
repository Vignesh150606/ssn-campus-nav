// Thin client for the Campus Copilot text-understanding endpoint. Mirrors
// the style of ../api.js but lives separately since this is the one POST
// call the chatbot needs and everything else it does reuses ../api.js and
// the existing utils/* helpers directly.
//
// W4: the backend now answers overload with a TYPED body instead of a bare
// 503/429:  { detail: "<friendly text>", error: "busy" | "rate_limited" | "disabled", retry_after: <seconds> }
// copilotChat() turns that into a CopilotError so the chat UI can show a
// friendly message instead of the generic "couldn't reach the campus service".
import { API_BASE } from '../apiBase'

// Render's free instance can take a while to wake; BootGate normally covers
// that, so this only guards against a request hanging mid-session.
const REQUEST_TIMEOUT_MS = 20000

export class CopilotError extends Error {
  /**
   * @param {'busy'|'rate_limited'|'disabled'|'timeout'|'network'|'error'} code
   * @param {string} message  friendly text from the server (or a local fallback)
   * @param {number} retryAfter  seconds the caller should wait before retrying (0 = unknown)
   * @param {number} status  HTTP status, 0 if none
   */
  constructor(code, message, retryAfter = 0, status = 0) {
    super(message)
    this.name = 'CopilotError'
    this.code = code
    this.retryAfter = retryAfter
    this.status = status
  }

  /** true for "try again in a moment" situations (not a hard failure) */
  get isOverload() {
    return this.code === 'busy' || this.code === 'rate_limited'
  }
}

/**
 * Classify one chat message. `context` is whatever the caller wants echoed
 * back (Phase 1 doesn't require anything specific here — conversation
 * state lives in the frontend, see copilotEngine.js).
 */
export async function copilotChat(message, context) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`${API_BASE}/api/copilot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context: context || null }),
      signal: ctrl.signal,
    })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new CopilotError('timeout', 'Campus Copilot is taking too long right now. Please try again in a moment.', 5, 0)
    }
    throw new CopilotError('network', "Couldn't reach the campus service. Please try again.", 0, 0)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const headerRetry = Number(res.headers.get('Retry-After')) || 0
    const retryAfter = Number(body.retry_after) || headerRetry
    let code = typeof body.error === 'string' ? body.error : null
    if (!code) code = res.status === 429 ? 'rate_limited' : res.status === 503 ? 'busy' : 'error'
    const message = typeof body.detail === 'string' && body.detail
      ? body.detail
      : `Copilot request failed: ${res.status}`
    throw new CopilotError(code, message, retryAfter, res.status)
  }
  return res.json()
}
