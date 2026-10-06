// 100 independent navigation clients, without allocating 100 map renderers
// on one laptop. Each worker has its own module state and REAL IndexedDB.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const harness = (req, res, next) => {
  const pathname = req.url.split('?')[0]
  if (pathname === '/__navigation-test') {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Navigation verification</title>'); return
  }
  if (pathname === '/__navigation-worker.js') {
    res.setHeader('Content-Type', 'text/javascript')
    res.end(`onmessage = async ({data: id}) => {
      const nativeOpen = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name, version) => nativeOpen(name + '-test-' + id, version);
      const realFetch = fetch;
      let routeRequests = 0;
      self.fetch = async (url, options) => {
        if (String(url).includes('/api/route?')) routeRequests++;
        if (String(url).startsWith('https://api.invalid')) return Response.json({detail:'Backend down'}, {status:503});
        return realFetch(url, options);
      };
      try {
        const start = performance.now();
        const {prepareClientRouting} = await import('/src/routing/clientRouting.js');
        const api = await import('/src/api.js');
        await prepareClientRouting();
        const loadedMs = performance.now() - start;
        const samples = [];
        for (let n=0;n<10;n++) {
          const t=performance.now();
          const route = await api.getRoute('main-gate','cse-block');
          const reroute = api.getRouteFromCoordsSync(12.7522,80.1975,'cse-block',10,null,{isReroute:true});
          if (!route.path.length || !reroute.path.length) throw Error('missing path');
          samples.push(performance.now()-t);
        }
        postMessage({id,loadedMs,samples,routeRequests,ok:true});
      } catch(e) { postMessage({id,ok:false,error:e.message}); }
    };`)
    return
  }
  next()
}
const server = await createServer({ root, configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  plugins: [{ name: 'navigation-test-harness', configureServer(s) { s.middlewares.use(harness) } }],
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid') },
  server: { host: '127.0.0.1', port: 4175, strictPort: true }, logLevel: 'error' })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:4175/__navigation-test')
  const results = await page.evaluate(async () => {
    const workers = Array.from({ length: 100 }, () => new Worker('/__navigation-worker.js', { type: 'module' }))
    try {
      return await Promise.all(workers.map((worker, id) => new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data)
        worker.onerror = event => reject(new Error(event.message))
        worker.postMessage(id)
      })))
    } finally { workers.forEach(w => w.terminate()) }
  })
  assert.equal(results.filter(r => !r.ok).length, 0, results.filter(r => !r.ok).map(r => r.error).join('\n'))
  assert.equal(results.reduce((n, r) => n + r.routeRequests, 0), 0)
  const values = results.flatMap(r => r.samples).sort((a, b) => a - b)
  const percentile = p => values[Math.floor((values.length - 1) * p)].toFixed(1)
  console.log(`PASS: 100 simultaneous isolated clients, 100 independent IndexedDB databases, 1000 routes + 1000 reroutes, ZERO Render route requests. Route + reroute pair p50=${percentile(0.5)}ms p95=${percentile(0.95)}ms max=${values.at(-1).toFixed(1)}ms. Concurrent bootstrap max=${Math.max(...results.map(r => r.loadedMs)).toFixed(1)}ms.`)
} finally { await browser?.close(); await server.close() }
