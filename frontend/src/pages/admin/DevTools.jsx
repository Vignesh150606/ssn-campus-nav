/**
 * DevTools.jsx — production audit recommendation: developer debugging
 * panel, Super Admin only (see AdminDashboard.jsx's role branch — a Fest
 * Admin never even reaches the component tree this is lazy-loaded from).
 *
 * REMOVAL: delete this file, delete backend/devtools.py, delete the two
 * lines in backend/main.py that mount it, and delete the 'devtools' tab
 * entry + content block + lazy import in AdminDashboard.jsx. Nothing else
 * in the app depends on any of this.
 *
 * One file by design (see the removal note above) — internal sub-tabs
 * for each of the 7 tools rather than 7 separate files.
 */
import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Marker, Circle, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { adminFetch, pill, inputStyle, selectStyle } from './adminShared'
import { API_BASE } from '../../apiBase'

const CAMPUS_CENTER = [12.7510, 80.1970]

const TOOLS = [
  ['graph', '🗺️ Graph Viewer'],
  ['gps', '📍 Live GPS Debug'],
  ['snap', '🎯 Snap Debug'],
  ['inspect', '🧭 Route Inspector'],
  ['stats', '📊 Graph Statistics'],
  ['replay', '🔍 Route Replay'],
  ['export', '📝 Export Graph'],
]

function TileBase() {
  return <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
}

// ── 1. Graph Viewer ─────────────────────────────────────────────────────
function GraphViewer({ token }) {
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    adminFetch('/api/admin/devtools/graph', 'GET', null, token).then(setGraph).catch(e => setError(e.message))
  }, [token])

  if (error) return <div style={{ color: '#D7263D', padding: 16 }}>{error}</div>
  if (!graph) return <div className="state-message">Loading graph…</div>

  const adjCount = {}
  for (const e of graph.edges) { adjCount[e.from] = (adjCount[e.from]||0)+1; adjCount[e.to] = (adjCount[e.to]||0)+1 }
  const maxDeg = Math.max(...Object.values(adjCount))

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <MapContainer center={CAMPUS_CENTER} zoom={17} style={{ height: '100%', width: '100%' }}>
          <TileBase />
          {graph.edges.map((e, i) => (
            <Polyline key={i} positions={e.path.map(p => [p.lat, p.lng])} pathOptions={{ color: '#3A6EA5', weight: 2, opacity: 0.7 }} />
          ))}
          {graph.location_edges.map((e, i) => (
            <Polyline key={'l'+i} positions={e.path.map(p => [p.lat, p.lng])} pathOptions={{ color: '#B8860B', weight: 1.5, dashArray: '4 4' }} />
          ))}
          {graph.nodes.map(n => {
            const d = adjCount[n.id] || 0
            const color = d === maxDeg ? '#D7263D' : d === 1 ? '#E07414' : '#2E9E5B'
            return (
              <CircleMarker key={n.id} center={[n.lat, n.lng]} radius={d === maxDeg ? 6 : d === 1 ? 5 : 3.5}
                pathOptions={{ color: 'white', weight: 1, fillColor: color, fillOpacity: 0.95 }}
                eventHandlers={{ click: () => setSelected(n) }}>
                <Popup>
                  <strong>{n.id}</strong><br/>degree {d}<br/>{n.lat.toFixed(6)}, {n.lng.toFixed(6)}
                </Popup>
              </CircleMarker>
            )
          })}
        </MapContainer>
      </div>
      <div style={{ width: 220, padding: 12, borderLeft: '1px solid var(--line)', overflowY: 'auto', fontSize: '0.78rem', color: 'var(--ink)' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Legend</div>
        <div>🔴 Critical junction (degree {maxDeg})</div>
        <div>🟠 Dead end (degree 1)</div>
        <div>🟢 Walkway node</div>
        <div style={{ marginTop: 8, color: 'var(--muted)' }}>Tap any node for its id/degree/coordinates.</div>
        {selected && (
          <div style={{ marginTop: 14, padding: 10, background: 'var(--surface)', borderRadius: 8 }}>
            <div><strong>{selected.id}</strong></div>
            <div>degree {adjCount[selected.id] || 0}</div>
            <div>{selected.lat.toFixed(6)}, {selected.lng.toFixed(6)}</div>
          </div>
        )}
        <div style={{ marginTop: 14, color: 'var(--muted)' }}>
          {graph.nodes.length} nodes · {graph.edges.length} edges · {graph.location_edges.length} location connectors
        </div>
      </div>
    </div>
  )
}

// ── 2. Live GPS Debug ───────────────────────────────────────────────────
function LiveGpsDebug() {
  const [pos, setPos] = useState(null)
  const [error, setError] = useState(null)
  const [watching, setWatching] = useState(false)
  const watchIdRef = useRef(null)
  const [history, setHistory] = useState([])

  function start() {
    if (!navigator.geolocation) { setError('Geolocation API not available in this browser.'); return }
    setWatching(true); setError(null)
    watchIdRef.current = navigator.geolocation.watchPosition(
      (p) => {
        const entry = {
          lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy,
          altitude: p.coords.altitude, altitude_accuracy: p.coords.altitudeAccuracy,
          heading: p.coords.heading, speed: p.coords.speed, timestamp: p.timestamp,
        }
        setPos(entry)
        setHistory(h => [entry, ...h].slice(0, 20))
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 0 }
    )
  }
  function stop() {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current)
    watchIdRef.current = null; setWatching(false)
  }
  useEffect(() => () => { if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current) }, [])

  return (
    <div style={{ padding: 16, maxWidth: 520 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.95rem', marginBottom: 10, color: 'var(--ink)' }}>
        Live GPS Debug
      </div>
      <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 14 }}>
        Reads this device's own browser Geolocation API directly — the exact same source LocationProvider.jsx uses for live navigation, shown raw with no smoothing/filtering applied, for diagnosing whatever the phone/browser is actually reporting.
      </div>
      <button onClick={watching ? stop : start} style={{ ...pill, background: watching ? '#D7263D' : 'var(--brand)', color: '#fff', marginBottom: 14 }}>
        {watching ? '■ Stop watching' : '▶ Start watching'}
      </button>
      {error && <div style={{ color: '#D7263D', fontSize: '0.82rem', marginBottom: 10 }}>{error}</div>}
      {pos && (
        <div style={{ background: 'var(--surface)', borderRadius: 12, padding: 14, fontSize: '0.82rem', fontFamily: 'monospace', color: 'var(--ink)' }}>
          <div>lat: {pos.lat?.toFixed(7)}</div>
          <div>lng: {pos.lng?.toFixed(7)}</div>
          <div>accuracy: {pos.accuracy_m?.toFixed(1)} m</div>
          <div>heading: {pos.heading != null ? `${pos.heading.toFixed(1)}°` : 'null (device not moving / no compass)'}</div>
          <div>speed: {pos.speed != null ? `${pos.speed.toFixed(2)} m/s` : 'null'}</div>
          <div>altitude: {pos.altitude != null ? `${pos.altitude.toFixed(1)} m (±${pos.altitude_accuracy?.toFixed(1) ?? '?'} m)` : 'null'}</div>
          <div>timestamp: {new Date(pos.timestamp).toLocaleTimeString()}</div>
        </div>
      )}
      {history.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Last {history.length} fixes (newest first)</div>
          <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--muted)' }}>
            {history.map((h, i) => (
              <div key={i}>{new Date(h.timestamp).toLocaleTimeString()} — {h.lat.toFixed(6)},{h.lng.toFixed(6)} ±{h.accuracy_m?.toFixed(0)}m</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 3. Snap Debug ───────────────────────────────────────────────────────
function SnapDebug({ token }) {
  const [lat, setLat] = useState('12.7510')
  const [lng, setLng] = useState('80.1970')
  const [accuracy, setAccuracy] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function run() {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ lat, lng })
      if (accuracy) params.set('accuracy_m', accuracy)
      const res = await adminFetch(`/api/admin/devtools/snap?${params}`, 'GET', null, token)
      setResult(res)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(p => {
      setLat(String(p.coords.latitude)); setLng(String(p.coords.longitude)); setAccuracy(String(Math.round(p.coords.accuracy)))
    })
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 300, padding: 16, borderRight: '1px solid var(--line)', overflowY: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.92rem', marginBottom: 10, color: 'var(--ink)' }}>Snap Debug</div>
        <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginBottom: 12 }}>
          Runs the real _nearest_node() the app uses for reroute snapping — see which graph node any lat/lng resolves to, and how far away it is.
        </div>
        <label style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Latitude</label>
        <input value={lat} onChange={e => setLat(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
        <label style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Longitude</label>
        <input value={lng} onChange={e => setLng(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
        <label style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: 3 }}>Accuracy (m, optional)</label>
        <input value={accuracy} onChange={e => setAccuracy(e.target.value)} style={{ ...inputStyle, marginBottom: 10 }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button onClick={run} disabled={loading} style={{ ...pill, background: 'var(--brand)', color: '#fff', flex: 1 }}>{loading ? '…' : 'Snap'}</button>
          <button onClick={useMyLocation} style={{ ...pill, background: 'var(--canvas)', border: '1px solid var(--line)', color: 'var(--ink)' }}>📍 Mine</button>
        </div>
        {error && <div style={{ color: '#D7263D', fontSize: '0.78rem' }}>{error}</div>}
        {result && (
          <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 10, fontSize: '0.78rem', fontFamily: 'monospace', color: 'var(--ink)' }}>
            <div>snapped_to: <strong>{result.snapped_to}</strong></div>
            <div>distance: {result.snap_distance_m} m</div>
          </div>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <MapContainer center={[parseFloat(lat)||CAMPUS_CENTER[0], parseFloat(lng)||CAMPUS_CENTER[1]]} zoom={18} style={{ height: '100%', width: '100%' }}>
          <TileBase />
          {lat && lng && !isNaN(parseFloat(lat)) && <Marker position={[parseFloat(lat), parseFloat(lng)]} />}
          {result && <CircleMarker center={[result.snapped_node.lat, result.snapped_node.lng]} radius={8} pathOptions={{ color: 'white', weight: 2, fillColor: '#D7263D', fillOpacity: 1 }} />}
          {result && lat && lng && (
            <Polyline positions={[[parseFloat(lat), parseFloat(lng)], [result.snapped_node.lat, result.snapped_node.lng]]} pathOptions={{ color: '#D7263D', dashArray: '4 4' }} />
          )}
        </MapContainer>
      </div>
    </div>
  )
}

// ── 4. Route Inspector ──────────────────────────────────────────────────
function RouteInspector({ token }) {
  const [locations, setLocations] = useState([])
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    adminFetch('/api/admin/devtools/graph', 'GET', null, token).then(g => {
      setLocations(g.locations)
      if (g.locations.length > 1) { setFromId(g.locations[0].id); setToId(g.locations[1].id) }
    }).catch(e => setError(e.message))
  }, [token])

  async function run() {
    if (!fromId || !toId) return
    setLoading(true); setError(null)
    try {
      const res = await adminFetch(`/api/admin/devtools/route-inspect?from_id=${fromId}&to_id=${toId}`, 'GET', null, token)
      setResult(res)
    } catch (e) { setError(e.message); setResult(null) }
    finally { setLoading(false) }
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 300, padding: 16, borderRight: '1px solid var(--line)', overflowY: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.92rem', marginBottom: 10, color: 'var(--ink)' }}>Route Inspector</div>
        <label style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: 3 }}>From</label>
        <select value={fromId} onChange={e => setFromId(e.target.value)} style={{ ...selectStyle, marginBottom: 8 }}>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: 3 }}>To</label>
        <select value={toId} onChange={e => setToId(e.target.value)} style={{ ...selectStyle, marginBottom: 10 }}>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button onClick={run} disabled={loading} style={{ ...pill, background: 'var(--brand)', color: '#fff', width: '100%', marginBottom: 12 }}>
          {loading ? 'Computing…' : 'Inspect route'}
        </button>
        {error && <div style={{ color: '#D7263D', fontSize: '0.78rem', marginBottom: 10 }}>{error}</div>}
        {result && (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--ink)', marginBottom: 8 }}>
              Total: <strong>{result.total_distance_m} m</strong> · {result.node_sequence.length} nodes
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--muted)' }}>
              {result.hops.map((h, i) => (
                <div key={i}>{i}. {h.node}{h.distance_to_next_m != null ? ` → +${h.distance_to_next_m}m` : ''}</div>
              ))}
            </div>
          </>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <MapContainer center={CAMPUS_CENTER} zoom={17} style={{ height: '100%', width: '100%' }}>
          <TileBase />
          {result && (
            <Polyline positions={result.hops.filter(h => h.lat != null).map(h => [h.lat, h.lng])} pathOptions={{ color: '#D7263D', weight: 4 }} />
          )}
          {result && result.hops.filter(h => h.lat != null).map((h, i) => (
            <CircleMarker key={i} center={[h.lat, h.lng]} radius={4} pathOptions={{ color: 'white', weight: 1, fillColor: '#D7263D', fillOpacity: 1 }}>
              <Popup>{h.node}</Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
    </div>
  )
}

// ── 5. Graph Statistics ─────────────────────────────────────────────────
function GraphStatistics({ token }) {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    adminFetch('/api/admin/devtools/stats', 'GET', null, token).then(setStats).catch(e => setError(e.message))
  }, [token])

  if (error) return <div style={{ color: '#D7263D', padding: 16 }}>{error}</div>
  if (!stats) return <div className="state-message">Loading…</div>

  const rows = [
    ['Total nodes', stats.total_nodes], ['Total edges', stats.total_edges],
    ['Location connectors', stats.total_location_connectors], ['Average degree', stats.average_degree],
    ['Maximum degree', stats.max_degree], ['Critical junction node(s)', stats.critical_junction_nodes.join(', ')],
    ['Connected components', stats.connected_components],
    ['Largest component size', `${Math.max(...stats.component_sizes)} / ${stats.total_nodes}`],
    ['Dead ends', stats.dead_end_nodes.length], ['Dead ends at a building entrance', stats.dead_ends_at_a_building_entrance.length],
    ['Isolated nodes', stats.isolated_nodes.length],
  ]

  return (
    <div style={{ padding: 16, maxWidth: 480 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.95rem', marginBottom: 12, color: 'var(--ink)' }}>Graph Statistics</div>
      <div style={{ background: 'var(--surface)', borderRadius: 12, overflow: 'hidden' }}>
        {rows.map(([label, value], i) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 14px', borderTop: i ? '1px solid var(--line)' : 'none', fontSize: '0.84rem' }}>
            <span style={{ color: 'var(--muted)' }}>{label}</span>
            <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{value}</span>
          </div>
        ))}
      </div>
      {stats.isolated_nodes.length > 0 && (
        <div style={{ marginTop: 10, fontSize: '0.78rem', color: '#D7263D' }}>Isolated: {stats.isolated_nodes.join(', ')}</div>
      )}
    </div>
  )
}

// ── 6. Route Replay ─────────────────────────────────────────────────────
function RouteReplay() {
  const [raw, setRaw] = useState('')
  const [trace, setTrace] = useState(null)
  const [step, setStep] = useState(0)
  const [error, setError] = useState(null)
  const [playing, setPlaying] = useState(false)
  const intervalRef = useRef(null)

  function load() {
    setError(null)
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Expected a non-empty JSON array of {lat, lng} points.')
      for (const p of parsed) {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') throw new Error('Every point needs numeric lat and lng.')
      }
      setTrace(parsed); setStep(0)
    } catch (e) { setError(e.message); setTrace(null) }
  }

  function play() {
    if (!trace) return
    setPlaying(true)
    intervalRef.current = setInterval(() => {
      setStep(s => {
        if (s >= trace.length - 1) { clearInterval(intervalRef.current); setPlaying(false); return s }
        return s + 1
      })
    }, 500)
  }
  function pause() { clearInterval(intervalRef.current); setPlaying(false) }
  useEffect(() => () => clearInterval(intervalRef.current), [])

  const current = trace?.[step]

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 300, padding: 16, borderRight: '1px solid var(--line)', overflowY: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.92rem', marginBottom: 8, color: 'var(--ink)' }}>Route Replay</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 10 }}>
          Paste a JSON array of GPS points (e.g. from <code>window.__navLog()</code> during live navigation, reshaped to <code>[&#123;lat,lng,accuracy_m?&#125;,…]</code>) to step or play back the trace on the map.
        </div>
        <textarea rows={6} value={raw} onChange={e => setRaw(e.target.value)}
          placeholder='[{"lat":12.751,"lng":80.197,"accuracy_m":12}, ...]'
          style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '0.74rem', resize: 'vertical', marginBottom: 8 }} />
        <button onClick={load} style={{ ...pill, background: 'var(--brand)', color: '#fff', width: '100%', marginBottom: 10 }}>Load trace</button>
        {error && <div style={{ color: '#D7263D', fontSize: '0.78rem', marginBottom: 10 }}>{error}</div>}
        {trace && (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--ink)', marginBottom: 8 }}>Point {step + 1} / {trace.length}</div>
            <input type="range" min={0} max={trace.length - 1} value={step} onChange={e => setStep(Number(e.target.value))} style={{ width: '100%', marginBottom: 8 }} />
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button onClick={playing ? pause : play} style={{ ...pill, background: 'var(--canvas)', border: '1px solid var(--line)', color: 'var(--ink)', flex: 1 }}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button onClick={() => setStep(0)} style={{ ...pill, background: 'var(--canvas)', border: '1px solid var(--line)', color: 'var(--ink)' }}>⏮</button>
            </div>
            {current && (
              <div style={{ fontSize: '0.76rem', fontFamily: 'monospace', color: 'var(--muted)' }}>
                {current.lat.toFixed(6)}, {current.lng.toFixed(6)}{current.accuracy_m ? ` ±${current.accuracy_m}m` : ''}
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <MapContainer center={CAMPUS_CENTER} zoom={17} style={{ height: '100%', width: '100%' }}>
          <TileBase />
          {trace && <Polyline positions={trace.slice(0, step + 1).map(p => [p.lat, p.lng])} pathOptions={{ color: '#3A6EA5', weight: 3 }} />}
          {current && <Marker position={[current.lat, current.lng]} />}
          {current?.accuracy_m && <Circle center={[current.lat, current.lng]} radius={current.accuracy_m} pathOptions={{ color: '#3A6EA5', fillOpacity: 0.1 }} />}
        </MapContainer>
      </div>
    </div>
  )
}

// ── 7. Export Graph ─────────────────────────────────────────────────────
function ExportGraph({ token }) {
  const [busy, setBusy] = useState(null)

  async function download(fmt, filename) {
    setBusy(fmt)
    try {
      const res = await fetch(`${API_BASE}/api/admin/devtools/export/${fmt}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) { alert(e.message) }
    finally { setBusy(null) }
  }

  return (
    <div style={{ padding: 16, maxWidth: 420 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.95rem', marginBottom: 12, color: 'var(--ink)' }}>Export Graph</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button onClick={() => download('json', 'walkway_graph.json')} disabled={busy} style={{ ...pill, background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)', textAlign: 'left', padding: '12px 16px' }}>
          {busy === 'json' ? 'Downloading…' : '⬇ walkway_graph.json'} <span style={{ color: 'var(--muted)', fontWeight: 400 }}> — raw graph, same shape the backend uses</span>
        </button>
        <button onClick={() => download('geojson', 'walkway_graph.geojson')} disabled={busy} style={{ ...pill, background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)', textAlign: 'left', padding: '12px 16px' }}>
          {busy === 'geojson' ? 'Downloading…' : '⬇ walkway_graph.geojson'} <span style={{ color: 'var(--muted)', fontWeight: 400 }}> — opens directly in QGIS / geojson.io</span>
        </button>
        <button onClick={() => download('graphviz', 'walkway_graph.dot')} disabled={busy} style={{ ...pill, background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)', textAlign: 'left', padding: '12px 16px' }}>
          {busy === 'graphviz' ? 'Downloading…' : '⬇ walkway_graph.dot'} <span style={{ color: 'var(--muted)', fontWeight: 400 }}> — Graphviz, render with `dot -Tpng` or `neato`</span>
        </button>
      </div>
      <div style={{ marginTop: 16, fontSize: '0.76rem', color: 'var(--muted)' }}>
        Same exports also live permanently in <code>docs/graph/</code> in the repo (generated by <code>backend/scripts/generate_graph_docs.py</code>) — these buttons are for a quick one-off download without shell access.
      </div>
    </div>
  )
}

export default function DevTools({ token }) {
  const [tool, setTool] = useState('graph')

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', flexShrink: 0 }}>
        {TOOLS.map(([id, label]) => (
          <button key={id} onClick={() => setTool(id)} style={{
            ...pill, padding: '5px 12px', fontSize: '0.74rem',
            background: tool === id ? 'var(--ink)' : 'transparent',
            color: tool === id ? 'var(--canvas)' : 'var(--ink)', border: '1px solid var(--line)',
          }}>{label}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tool === 'graph' && <GraphViewer token={token} />}
        {tool === 'gps' && <LiveGpsDebug />}
        {tool === 'snap' && <SnapDebug token={token} />}
        {tool === 'inspect' && <RouteInspector token={token} />}
        {tool === 'stats' && <GraphStatistics token={token} />}
        {tool === 'replay' && <RouteReplay />}
        {tool === 'export' && <ExportGraph token={token} />}
      </div>
    </div>
  )
}
