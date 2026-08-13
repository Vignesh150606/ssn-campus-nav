/**
 * isSafeUrl — security review (Aug 2026).
 *
 * A few event fields (registration_link, poster_url, photo_urls) are
 * admin-supplied text the admin dashboard lets someone paste an external
 * URL into, not just a file upload. Several places render these straight
 * into <a href> / <img src> (EventPage.jsx, the Copilot chat widget's event
 * cards). A `javascript:` URL there would run in a visitor's browser. The
 * backend now rejects anything but http(s) at the API boundary, but this
 * client-side check is a second layer that also covers any row written
 * before that validation existed.
 */
export function isSafeUrl(url) {
  if (!url) return false
  try {
    const parsed = new URL(url, window.location.href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
