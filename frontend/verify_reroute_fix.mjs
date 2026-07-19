// Verification harness — reproduces the exact failure mode from the bug
// report against the REAL geo.js code (not a reimplementation), then
// proves the fix. Generic hairpin geometry (not tied to one campus
// building), matching the "Make U-Turn near Open Air Theatre" shape from
// the screenshots: an "up" leg and a "down" leg roughly 12m apart.
import { nearestIndex, haversine } from './src/utils/geo.js'

function m2deg(m) { return m / 111320 } // rough metres->degrees at this latitude

const baseLat = 12.7520, baseLng = 80.1970
const legOffsetLng = m2deg(12) // ~12m separation between the two legs

// Build a hairpin: walk "up" 10 points, U-turn, walk "down" 10 points on
// a parallel line ~12m to the east — the same shape a U-turn produces.
const path = []
for (let i = 0; i < 10; i++) path.push({ lat: baseLat + m2deg(i * 6), lng: baseLng })
for (let i = 9; i >= 0; i--) path.push({ lat: baseLat + m2deg(i * 6), lng: baseLng + legOffsetLng })

console.log(`Path has ${path.length} points. Up-leg = indices 0-9, down-leg = indices 10-19.`)
console.log(`Legs are ~${(legOffsetLng * 111320).toFixed(1)}m apart.\n`)

// Simulate: a few ticks of NORMAL on-route walking along the up-leg first
// (establishing a known-good previousIndex, exactly like real on-route
// tracking would), THEN the user drifts off-route into the gap between
// the two legs, ending up slightly closer to the down-leg by chance/GPS
// noise (60% of the way across the gap) — exactly the "off route, waiting
// for reroute" window from the bug report, with a realistic history.
const warmupTicks = [0, 1, 2, 3].map(i => ({ lat: baseLat + m2deg(i * 6), lng: baseLng }))
const driftTicks = []
for (let i = 4; i <= 8; i++) {
  driftTicks.push({ lat: baseLat + m2deg(i * 6), lng: baseLng + legOffsetLng * 0.6 })
}
const ticks = [...warmupTicks, ...driftTicks]
const warmupCount = warmupTicks.length

console.log('--- OLD behaviour: nearestIndex(lat, lng, path) — no continuity ---')
let prevOldIdx = null
let oldMaxJumpM = 0
ticks.forEach((t, n) => {
  const phase = n < warmupCount ? '[on-route warm-up]' : '[drifted off-route]'
  const { index, distance } = nearestIndex(t.lat, t.lng, path) // old call signature (still supported)
  const jumpM = prevOldIdx == null ? 0 : haversine(path[prevOldIdx].lat, path[prevOldIdx].lng, path[index].lat, path[index].lng)
  oldMaxJumpM = Math.max(oldMaxJumpM, jumpM)
  console.log(`  ${phase} tick lat=${t.lat.toFixed(6)} -> matched index ${index} (dist ${distance.toFixed(1)}m)` +
    (prevOldIdx != null ? `  [index jumped ${index - prevOldIdx >= 0 ? '+' : ''}${index - prevOldIdx}, ${jumpM.toFixed(1)}m chord from previous match]` : ''))
  prevOldIdx = index
})
console.log(`  => largest single-tick chord jump: ${oldMaxJumpM.toFixed(1)}m` +
  (oldMaxJumpM > 5 ? '  ⚠️  THIS is the diagonal in the screenshots.' : ''))

console.log('\n--- NEW behaviour: nearestIndex(lat, lng, path, previousIndex) — progress-biased ---')
let prevNewIdx = null
let newMaxJumpM = 0
ticks.forEach((t, n) => {
  const phase = n < warmupCount ? '[on-route warm-up]' : '[drifted off-route]'
  const { index, distance } = nearestIndex(t.lat, t.lng, path, prevNewIdx)
  const jumpM = prevNewIdx == null ? 0 : haversine(path[prevNewIdx].lat, path[prevNewIdx].lng, path[index].lat, path[index].lng)
  newMaxJumpM = Math.max(newMaxJumpM, jumpM)
  console.log(`  ${phase} tick lat=${t.lat.toFixed(6)} -> matched index ${index} (dist ${distance.toFixed(1)}m)` +
    (prevNewIdx != null ? `  [index moved ${index - prevNewIdx >= 0 ? '+' : ''}${index - prevNewIdx}, ${jumpM.toFixed(1)}m from previous match]` : ''))
  prevNewIdx = index
})
console.log(`  => largest single-tick chord jump: ${newMaxJumpM.toFixed(1)}m`)

console.log('\n--- Reality check: with the actual pipeline fix, this loop never runs at all while off-route ---')
console.log('LocationProvider.jsx now freezes remainingPath entirely once off-route (adaptive threshold')
console.log('exceeded) and only swaps in a fresh route atomically once maybeRecalculate resolves — so even')
console.log('the STABLE new nearestIndex above is never invoked against a stale array during that window.')

if (oldMaxJumpM > 10 && newMaxJumpM < oldMaxJumpM) {
  console.log('\n✅ VERIFIED: old code jumps far (diagonal reproduced), new code is stable/bounded.')
  process.exit(0)
} else {
  console.log('\n❌ Did not reproduce the expected gap between old and new behaviour.')
  process.exit(1)
}
