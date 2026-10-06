// Read-only deployment check. No SDK, credentials, .env loading or writes.
const base = process.argv[2]
if (!base) {
  console.error('Usage: node frontend/scripts/check_public_snapshots.mjs <public snapshot base URL>')
  process.exit(1)
}
const url = new URL(base)
if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
  throw new Error('Provide a public HTTP(S) bucket URL without credentials, query or fragment')
}
let failures = 0
for (const name of ['schedule', 'closures', 'menus', 'posters']) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000)
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/${name}.json`, { signal: ctl.signal, cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}: snapshot unavailable`)
    const reader = response.body.getReader(), chunks = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2_000_000) { await reader.cancel(); throw new Error('Snapshot exceeds 2 MB') }
      chunks.push(value)
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const data = envelope.data
    if (envelope.schema !== 1 || !Number.isFinite(envelope.version) || !Number.isFinite(Date.parse(envelope.updated_at)) ||
      !envelope.meta || typeof envelope.meta !== 'object' || Array.isArray(envelope.meta) ||
      (name === 'menus' ? !data || typeof data !== 'object' || Array.isArray(data) : !Array.isArray(data))) {
      throw new Error('Invalid snapshot envelope/dataset')
    }
    console.log(`PASS ${name}: ${(bytes / 1024).toFixed(1)} KB; published ${envelope.updated_at}; cache-control=${response.headers.get('cache-control') || 'missing'}${bytes > 150 * 1024 ? '; OVER 150 KB' : ''}`)
  } catch (err) {
    failures++
    console.error(`FAIL ${name}: ${err.name === 'AbortError' ? '8-second deadline exceeded' : err.message}`)
  } finally { clearTimeout(timer) }
}
process.exitCode = failures ? 1 : 0
