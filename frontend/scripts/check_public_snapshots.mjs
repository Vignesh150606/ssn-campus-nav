// Read-only deployment check. No SDK, credentials, .env loading or writes.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const base = process.argv[2]
if (!base) {
  console.error('Usage: node frontend/scripts/check_public_snapshots.mjs <public snapshot base URL>')
  process.exit(1)
}
const url = new URL(base)
if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
  throw new Error('Provide a public HTTP(S) bucket URL without credentials, query or fragment')
}
const expectations = {}
const flags = new Set(['--expect-event', '--absent-event', '--expect-name', '--expect-closed', '--expect-open', '--from-dir'])
for (let i = 3; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1]
  if (!flags.has(flag) || !value || value.startsWith('--')) throw new Error(`Unknown or incomplete check option: ${flag}`)
  expectations[flag] = value
}
if (expectations['--expect-name'] && !expectations['--expect-event']) throw new Error('--expect-name requires --expect-event')
let failures = 0
for (const name of ['schedule', 'closures', 'menus', 'posters']) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000)
  try {
    // The PowerShell transport feeds the exact downloaded bytes and headers on
    // Windows networks where Node's HTTPS transport cannot reach Storage.
    const response = expectations['--from-dir']
      ? new Response(await readFile(join(expectations['--from-dir'], `${name}.json`)),
        { headers: JSON.parse(await readFile(join(expectations['--from-dir'], `${name}.headers.json`), 'utf8')) })
      : await fetch(`${base.replace(/\/+$/, '')}/${name}.json`, { signal: ctl.signal, cache: 'no-cache' })
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
    if (name === 'schedule') {
      const expectedId = expectations['--expect-event']
      const event = data.find(row => row.id === expectedId)
      if (expectedId && !event) throw new Error(`Expected event ${expectedId} not yet published`)
      if (expectations['--expect-name'] && event.name !== expectations['--expect-name']) throw new Error('Expected event edit not yet published')
      if (expectations['--absent-event'] && data.some(row => row.id === expectations['--absent-event'])) throw new Error('Deleted event still published')
    }
    if (name === 'closures') for (const [flag, closed] of [['--expect-closed', true], ['--expect-open', false]]) {
      if (!expectations[flag]) continue
      const segment = data.find(row => row.id === expectations[flag])
      if (!segment || segment.closed !== closed) throw new Error(`Expected road state ${expectations[flag]} not yet published`)
    }
    console.log(`PASS ${name}: ${(bytes / 1024).toFixed(1)} KB; version=${envelope.version}; published ${envelope.updated_at}; cache-control=${response.headers.get('cache-control') || 'missing'}; CDN=${response.headers.get('cf-cache-status') || 'unknown'}${bytes > 150 * 1024 ? '; OVER 150 KB' : ''}`)
  } catch (err) {
    failures++
    console.error(`FAIL ${name}: ${err.name === 'AbortError' ? '8-second deadline exceeded' : err.message}`)
  } finally { clearTimeout(timer) }
}
process.exitCode = failures ? 1 : 0
