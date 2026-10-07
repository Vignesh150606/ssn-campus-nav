import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
let missing = false, renamed = false, removed = false, closed = false
const server = createServer((request, response) => {
  const menus = request.url.endsWith('/menus.json')
  if (missing && menus) { response.writeHead(400); response.end('Bucket not found'); return }
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=60' })
  const data = menus ? {} : request.url.endsWith('/schedule.json') ? removed ? [] : [{ id: 'qa-event', name: renamed ? 'Edited' : 'Original' }]
    : request.url.endsWith('/closures.json') ? [{ id: 'qa-road', closed }] : []
  response.end(JSON.stringify({ schema: 1, version: 1, updated_at: '2026-10-06T00:00:00Z', meta: {}, data }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const script = fileURLToPath(new URL('./check_public_snapshots.mjs', import.meta.url))
const run = (...args) => new Promise(resolve => execFile(process.execPath, [script, `http://127.0.0.1:${server.address().port}/snapshots`, ...args], (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })))
try {
  const good = await run()
  assert.equal(good.code, 0, good.stderr)
  assert.equal(good.stdout.match(/PASS/g)?.length, 4)
  assert.equal((await run('--expect-event', 'qa-event', '--expect-name', 'Original', '--expect-open', 'qa-road')).code, 0)
  assert.equal((await run('--expect-event', 'new-event')).code, 1)
  assert.equal((await run('--expect-event', 'qa-event', '--expect-name', 'Edited')).code, 1)
  renamed = true; closed = true
  assert.equal((await run('--expect-event', 'qa-event', '--expect-name', 'Edited', '--expect-closed', 'qa-road')).code, 0)
  assert.equal((await run('--expect-open', 'qa-road')).code, 1)
  assert.equal((await run('--absent-event', 'qa-event')).code, 1)
  removed = true; closed = false
  assert.equal((await run('--absent-event', 'qa-event', '--expect-open', 'qa-road')).code, 0)
  missing = true
  const bad = await run()
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /FAIL menus: HTTP 400/)
  assert.equal(bad.stdout.match(/PASS/g)?.length, 3)
  console.log('PASS: read-only snapshot check detects missing files, unpublished creation/edit/deletion and closure/reopening; never requests Render.')
} finally { await new Promise(resolve => server.close(resolve)) }
