# ARCHITECTURAL_REVIEW.md

**Scope:** a first-principles review of the navigation system's design — not a bug hunt.
Every specific number below (node counts, degrees, distances, node IDs) was re-derived
directly against the shipped `backend/data/walkway_graph.json` and source files in this
session, not carried over from prior investigations' conclusions.

**Central thesis, stated up front:** this system is a *greedy, single-hypothesis, node-snapped,
unfused-raw-GPS* design. Every fix applied so far (accuracy-gated snap tie-break, route
stickiness, windowed map-matching, accuracy-scaled off-route hysteresis) is, individually,
a reasonable patch — but as a category, each one is independently reinventing a fragment of
what a probabilistic, multi-hypothesis, edge-based, sensor-fused design gets *for free*.
That's why the same class of bug keeps resurfacing in new disguises at the same physical
location: the underlying model has no principled way to represent "I'm not sure which of
these two branches you're on" — it commits to one discrete vertex every tick and only
retroactively patches specific bad commitments once someone reports them.

---

## 1. Design decisions I agree with

- **Building the graph from real surveyed GPX + KML data**, not invented straight-line
  campus geometry (`build_walkway_graph.py` pipeline docstring, steps 1-3). This is the
  same bootstrapping approach OSM-derived routers use — ground-truth-first is correct.
- **The stated target architecture for nodes vs. edges is correct in principle**: step 8's
  own docstring says *"a routing node should only exist at a junction, dead end, or
  destination connector — not at every recorded sample point."* That's the right model.
  (Section 3/5 below shows the shipped data doesn't fully match that intent — the *idea*
  is right, the *execution* is incomplete.)
- **Caching the static walkway graph in-process while re-reading `road_segments.json`
  fresh on every request** (`router.py::_load`). Correctly reasoned and explicitly
  justified in-code: one file is build-time-only, the other is a live admin-editable
  mirror. This is the right tradeoff, not an oversight.
- **No spatial index (k-d tree/R-tree) for nearest-node lookup.** At 193 nodes a linear
  scan is sub-millisecond; adding a spatial-index dependency here would be premature
  optimization. Explicitly justified in `_nearest_node`'s docstring. Correct call *for
  this graph size* — flagged in Section 7 as something to revisit if the graph grows.
- **`frontend/src/utils/geo.js`'s `matchToPath`/`projectOntoSegment`** is genuine
  perpendicular point-to-segment projection, clamped to `t ∈ [0,1]`, computed in a local
  tangent-plane projection valid at this scale. This is textbook-correct map-matching
  math — the right primitive already exists in this codebase (see Section 2 for where it
  *isn't* used, which is the more important observation).
- **`enableHighAccuracy: true, maximumAge: 0, timeout: 20000`** on `watchPosition`
  (`LocationProvider.jsx:581`). This is the correct Geolocation API configuration for a
  live turn-by-turn app — matches what Google/Apple Maps request. Ruled out, by direct
  reading, as a cause of the reported "slow convergence" (see Section 5).
- **Removing the service worker's `NetworkFirst` caching for `/api/*`** (`vite.config.js`,
  "Phase 4A.1" comment) after diagnosing it caused a *different* stale-data symptom
  (events/admin showing old data). Directly re-verified in the current `workbox.runtimeCaching`
  config: only OSM map tiles are cached now (`CacheFirst`, 7-day expiry). This rules out
  the service worker as a source of stale *routing* responses — good instinct, correctly
  scoped, and independently confirmed still in effect.
- **Accuracy-scaled off-route threshold with a consecutive-sample confirm** (`OFF_ROUTE_*`
  constants) instead of a fixed distance band. Directionally correct — real systems don't
  make off-route/reroute decisions off a single noisy sample either.

## 2. Design decisions I disagree with

- **Node-only snapping for live position (`router.py::_nearest_node`).** This is the
  central disagreement. The function only ever measures straight-line distance to 193
  fixed vertices (`_point_dist(lat, lng, n['lat'], n['lng'])` for each node) and never
  considers proximity to an *edge*. Every mainstream router (OSRM, GraphHopper, Valhalla,
  Google/Apple Maps) snaps to the nearest point on the nearest routable *edge* — a
  continuous projection, not a discrete vertex pick. The perpendicular-projection math
  for this (`projectOntoSegment`) already exists in this exact codebase, one layer up —
  it's just never applied to route *selection*, only to rendering an already-chosen route.
- **The default trust posture on the connector segment is backwards.** Currently, an
  unvalidated straight line from the live point to the winning node is drawn *by default*,
  and only checked against a sanity threshold when the winner *isn't* the closest-by-distance
  candidate (`router.py:252-257`). The single closest node's own connector is never checked
  at all. That's safe on average (the closest point is usually open ground) but not
  guaranteed — and this exact cluster is locally dense enough (7 nodes within 60m of the
  IT Block/CSE Annexure midpoint) that "closest by straight-line distance" and "closest by
  walkable distance" are not reliably the same node here.
- **"Route-continuity stickiness" (`prefer_node_id`) as a bolt-on tie-break.** A system
  that tracked a continuous position along continuous edge geometry wouldn't need a
  separate mechanism to remember "which node did we snap to last time" — continuity would
  fall out of the tracking itself. This is a patch for the absence of the thing above.
- **No sensor fusion, no filtered position estimate.** `GPS_ACQUIRE_GRACE_MS`, hard/soft
  reject, and the off-route confirm-streak are all heuristic proxies for what a small
  complementary or Kalman filter (fusing GPS with the phone's own IMU — already partially
  read via `coords.speed`/`coords.heading`, and separately used for compass heading in
  `useNavCamera.js`) would give as one coherent, continuously-updated, confidence-weighted
  estimate, instead of a binary "show it / withhold it" decision made fresh each tick.
- **Up to 8 full Dijkstra runs per snap decision** (`NEAREST_NODE_CANDIDATES = 8`, one
  `_dijkstra` call per shortlisted candidate, `router.py:239-248`), on every single
  automatic reroute. Fine at 193 nodes — but it's solving "which of 8 discrete points is
  cheapest," which is the wrong *shape* of question. It doesn't get more correct as the
  graph grows, only slower.
- **No request-generation guard on async reroutes** (see Section 5 — this is a genuinely
  new finding, not a restatement of the snap-logic disagreement above).
- **No formal navigation state machine.** See Section 4.

## 3. Hidden assumptions in the current implementation

- That the closest-by-distance node's connector is always safe (never actually checked —
  see Section 2).
- That GPS fixes only need filtering for *accuracy*, never for *staleness after a
  background/foreground cycle* (no `visibilitychange`/resume handling found anywhere in
  the location pipeline — confirmed by grep, see Section 5).
- That an in-flight reroute response will still be relevant to the app's state by the time
  it resolves (no cancellation or generation check — see Section 5).
- That the accuracy-gated snap tie-break and the stickiness margin, both derived from
  *two specific worked examples in this one cluster* (per their own docstrings), generalize
  correctly to every other multi-branch junction on campus. Untested elsewhere by anything
  in this repo.
- That degree-2 contraction (build step 8) fully ran on the shipped graph. It didn't
  everywhere — see Section 5 for the count.
- That the backend's in-process graph cache (`router.py::_load`, `_graph_cache` global) is
  always in sync with whatever is currently on disk in `walkway_graph.json`. True only if
  the serving process was restarted after the most recent rebuild — see Section 7.
- That the Geolocation API's reported `accuracy` figure means the same statistical thing
  across devices/browsers. It's treated (correctly, for lack of a better signal) as the
  best available heuristic throughout this codebase, but it isn't a standardized,
  device-independent number — cheap Android chipsets are known to report overconfident
  accuracy under multipath/urban-canyon conditions, which tall buildings like the CSE
  Annexure cluster are exactly the geometry for.

## 4. Potential architectural flaws

1. Node-only snapping instead of edge-projection (Section 2) — the root shape of the
   recurring bug class.
2. No probabilistic/multi-hypothesis map-matching — every ambiguous position is force-
   committed to a single node, so every new ambiguous spot becomes a new one-off patch
   instead of an instance of a handled general case.
3. **No navigation state machine.** `LocationProvider.jsx` coordinates the nav lifecycle
   through roughly 15 independent `useState`/`useRef` flags (`tracking`, `hasRoute`,
   `offRoute`, `recalculating`, `acquiringGps`, `useSimulatedGPS`, `autoWalking`, plus
   internal refs like `recalculatingRef`, `offRouteRef`, `goodFixReceivedRef`,
   `shownPositionRef`...). Nothing structurally prevents an invalid combination (e.g.
   `recalculating=true` with no active route) — validity is maintained purely by
   convention across ~15 call sites, not by construction.
4. **No request-generation/cancellation guard on reroute fetches** (new finding — see
   Section 5 for the concrete race).
5. **In-process graph cache with no reload-on-change awareness** — a rebuilt graph on
   disk doesn't take effect until the process restarts, and nothing in the repo signals
   whether that happened (Section 7).
6. **No app-lifecycle (background/foreground) handling** for the GPS watch (Section 5).
7. **Graph metadata gaps**: no indoor/outdoor flag, no path-type/accessibility tags, no
   directionality. The indoor/outdoor gap is the most directly relevant one here — the
   user's own report explicitly contrasts indoor vs. outdoor GPS behavior, but the graph
   and GPS pipeline have no concept of that distinction to act on.

## 5. Things previous investigations may have overlooked

These are derived fresh this session, verified against the actual data/code, not restated
from prior docstrings or reports.

**5.1 — The disputed cluster is locally overpopulated with un-contracted nodes.**
Build step 8 promises pass-through nodes get contracted away. Measured directly against
the shipped graph: **193 nodes, 244 edges**, degree distribution `{3: 86, 2: 68, 1: 21,
4: 17, 5: 1}`. Of the 68 degree-2 nodes, 21 are explained by a location connector
attaching there (legitimately keeping them as real junctions) — but **47 have no location
attached and no junction role**, contradicting step 8's own stated invariant. Of those 47,
**12 sit within 150m of the IT Block/CSE Annexure cluster** — `n_122, n_125, n_126, n_127,
n_128, n_136, n_137, n_138, n_161, n_162, n_163, n_164` — a 26% concentration in one small
part of an ~8.7km network. Within 60m of the IT Block/CSE Block midpoint alone there are
7 total candidate nodes, several of them (`n_122, n_127, n_136, n_137`) plain uncontracted
pass-through points. Every one of these is an extra, low-value entry competing in the
`NEAREST_NODE_CANDIDATES = 8` shortlist exactly where the tie-break logic already has to
work hardest. **This was not mentioned in `router.py`'s docstrings, `PRODUCTION_AUDIT_REPORT.md`,
or `validation_report.json`** (which checks connectivity/duplicates/geometric crossings,
not node *necessity*). Whether this is a bug in the contraction step or an intentional
exception is not answerable from the JSON alone — see Section 7.

**5.2 — Stale in-flight reroute responses are not guarded against.**
`maybeRecalculate` (`LocationProvider.jsx:235-340`) guards against firing a *second*
request while one is in flight (`recalculatingRef`), but its `.then()` handler
(`:296-327`) never re-checks that `destRef.current?.id` (or any route/session identity)
still matches what was requested before applying `r.path` to `routeRef.current`. Neither
`clearRoute()` nor `setRoute()` sets any flag the in-flight promise's callback checks.
Concretely: if a reroute-to-A is in flight and the user cancels or picks destination B
before it resolves, the late response for A can still land and silently overwrite the
active B route. No `AbortController`, no request-generation counter. This is a distinct
failure class from the CSE-Annexure snap-logic investigation entirely, and nothing in the
repo's history suggests it's been considered.

**5.3 — `rerouteDebug.js`'s "backend proven correct" claim may not be testing the graph
currently on disk.** `router.py::_load` caches the graph in memory for the life of the
process. `backend/data/validation_report.json`'s own `generated_from` path shows it was
regenerated from `/home/claude/investigate/.../backend/data/walkway_graph.json` — i.e. the
graph *has* been rebuilt at least once outside this delivery's own history. If the backend
process used to "directly query and prove the backend correct" for the disputed coordinates
was never restarted after that rebuild, that proof was run against a different graph than
whatever is on disk now — which would fully reconcile "backend proven correct" with "a real
walk still reproduced the bug," without requiring either finding to be wrong. This is not
verifiable from static files; it's listed as an open question in Section 7.

**5.4 — No handling for the GPS watch surviving a background/foreground cycle.**
Grep across `frontend/src` for `visibilitychange`/`pagehide`/`pageshow`/resume-handling
around the location pipeline returns nothing except an unrelated analytics listener.
Mobile browsers (Android Chrome especially) commonly throttle or suspend
`watchPosition` callbacks while a tab/app is backgrounded. `shownPositionRef` — the flag
that gates whether a position is ever withheld — latches `true` once per *session* and
never resets on resume. So a user who briefly backgrounds the app near the CSE Annexure
cluster (screen lock, app switch — ordinary phone behavior) and returns would have the
first post-resume fix treated as an ordinary tick, not a re-acquisition, with no grace
window and no filtering — a plausible, previously untested mechanism for a "position slowly
re-converges" symptom that looks identical to cold-start acquisition but has a different
trigger and would need a different fix.

**5.5 — The closest-node exemption is untested specifically in this cluster.** Restated
concretely from Section 2: the accuracy-gated sanity check only evaluates *non-closest*
candidates against the closest one (`router.py:252-257`). Nothing in any prior
investigation's evidence establishes that the single closest-by-distance node's own
connector was checked for building-crossing in this specific locally-dense cluster — every
worked example in the docstrings compares a *shortlisted* candidate against the closest
one, not the closest one against reality.

## 6. Alternative designs that would make this more robust

- **Point-to-edge projection for live-position snapping**, not just for rendering an
  already-chosen route. Apply `matchToPath`/`projectOntoSegment`'s existing logic (or its
  backend equivalent) one layer earlier: project the live point onto every nearby *edge*,
  and let "current position" be `(edge, t)` rather than "nearest of N vertices." This would
  likely make `SNAP_MARGIN_M`, `STICKY_MIN_MARGIN_M`, and `prefer_node_id` unnecessary as
  separate mechanisms, because there'd no longer be a discrete "which node" choice driving
  discontinuous jumps.
- **A lightweight complementary/Kalman filter** fusing GPS with the phone's already-read
  IMU data into one smoothed, confidence-weighted position, replacing the current
  raw-passthrough-plus-heuristics approach (`GPS_ACQUIRE_GRACE_MS`, hard/soft reject).
- **Multi-hypothesis map-matching**, even a simple 2-3-candidate weighted scheme short of
  a full HMM — so genuine ambiguity (branch A vs. branch B) is *represented* as uncertainty
  for a few ticks instead of committed-then-patched.
- **An explicit finite-state machine** for the navigation lifecycle (Idle → AcquiringGPS →
  RouteReady → Navigating → OffRoute → Recalculating → Arrived), replacing the current
  flag collection, so illegal state combinations become structurally unrepresentable.
- **Request-generation counters or `AbortController`** on reroute fetches, so a stale
  in-flight response is provably discarded instead of trusted by default (Section 5.2).
- **Graph metadata**: an indoor/outdoor flag (directly actionable for GPS confidence
  handling — the user's own report distinguishes these), path type/accessibility tags.
- **A reload-aware backend graph cache** — check the file's mtime, or expose an explicit
  "reload graph" admin action — so a rebuilt graph can't silently keep being shadowed by
  a stale in-memory copy without a full process restart (directly relevant to Section 5.3).
- **Completing (or explicitly documenting exceptions to) degree-2 contraction**, so the
  candidate pool actually matches the pipeline's own stated invariant, especially in this
  cluster (Section 5.1).

## 7. Questions that still cannot be answered from static code analysis

- Was the backend process used to "prove the route correct" for the disputed coordinates
  (`rerouteDebug.js`'s claim) ever restarted after the most recent `walkway_graph.json`
  rebuild? This determines whether that proof still applies to what's on disk now (5.3).
- What GPS accuracy value(s) were actually being reported at the moment the three
  screenshots' sessions showed the reported routing/drift behavior? Not visible in the
  screenshots themselves.
- Did the reported "slow convergence" happen after a backgrounding/foregrounding event
  (screen lock, app switch), or during continuous uninterrupted foreground tracking? Only
  a live session trace (or asking directly) can distinguish this from ordinary GPS
  cold-start acquisition (5.4).
- Is the specific phone/OS/browser combination in the screenshots one with known quirks
  in how `enableHighAccuracy` is honored? (Historically inconsistent across some Android
  WebViews/older Chrome versions.)
- Do the 47 uncontracted plain degree-2 nodes reflect an actual bug in
  `build_walkway_graph.py`'s contraction step, or an undocumented deliberate exception?
  Answering this needs tracing the contraction function against this cluster's raw
  GPX/KML input, not just reading its docstring's stated intent (5.1).
- Does Leaflet's own internal `setLatLng` transform animation compound with, or get fully
  superseded by, the app's explicit 0.4s CSS transition on `.user-marker-icon`
  (`MapView.jsx`)? This needs a real browser paint-timeline trace, not static reading.
- At what campus-wide scale (node count, concurrent users) would the "8 Dijkstra runs per
  snap, no spatial index" approach (each individually justified as fine *today*) start to
  matter? Not answerable without load data this repo doesn't contain.
