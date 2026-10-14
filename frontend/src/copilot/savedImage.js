/** CacheStorage lookup only: never fetch a poster/menu as a side effect of chat. */
export async function savedImageUrl(src) {
  if (!src || typeof caches === 'undefined') return null
  try {
    const response = await caches.match(src)
    if (!response?.ok || !response.headers.get('Content-Type')?.startsWith('image/')) return null
    const blob = await response.blob()
    if (!blob.size) return null
    return URL.createObjectURL(blob)
  } catch { return null }
}
