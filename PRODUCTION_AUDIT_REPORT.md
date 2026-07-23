# SSN Campus Navigator — Production Audit Report

**Scope:** full production-readiness audit of the routing/graph subsystem, GPS handling, security, and code quality, plus the requested Dev Tools panel and Account Settings feature. Working from the project as delivered after the RBAC pass (Super Admin / Fest Admin roles, fest schedule approval workflow already in place and untouched by this audit).

**Approach, per your instructions:** audit and prove first, change only where evidence justified it. Sections 1–6 are the audit (before any code was touched). Section 7 onward covers what actually changed and why.

---

## 1. Root Cause Analysis (summary)

No open, unresolved routing bug was found. The graph is structurally clean (single connected component, zero duplicate/zero-length/self-loop edges, zero internal duplicate points — see §3). One real bug *was* found and fixed, but it wasn't in routing: `frontend/src/offline/offlineBundle.js`'s online/offline status indicator had been silently non-functional since some earlier pass removed its only caller (see §10.3). Two smaller data-quality candidates were found and are flagged, not auto-fixed, because auto-fixing them would require assuming facts about campus geometry no amount of code review can confirm (see §2.4).

## 2. Architecture Review

- **Frontend:** React + Leaflet, `LocationProvider` context owns GPS watch state / route / off-route detection / rerouting; map-matching (`matchToPath`/`projectOntoSegment`) tracks progress along the active route.
- **Backend:** FastAPI, Supabase Postgres for admins/events/venues/road-segments/analytics/feedback; the walkway routing graph is a separate, static JSON file (`backend/data/walkway_graph.json`) read directly off disk by `utils/router.py`, not stored in Supabase — a deliberate separation (see `SUPABASE_MIGRATION.md`).
- **Routing pipeline:** client GPS fix → `/api/route/from-point` → nearest-node snap (accuracy-aware, sticky against flip-flopping — see §2.3) → Dijkstra → full path returned → client tracks progress locally every GPS tick via map-matching.
- **RBAC:** two roles (`superadmin`/`festadmin`) enforced via a FastAPI dependency (`require_role`) checked at the route level, not sprinkled through business logic — see §6.

### 2.1 Dijkstra implementation

`utils/router.py:_dijkstra` — standard lazy-deletion binary-heap Dijkstra (`heapq`), stale heap entries skipped via a `dist.get()` comparison, early-exits once the target is popped, non-negative edge weights only (all weights are haversine distances). No correctness issues found.

### 2.2 Graph connectivity

193 nodes, 244 edges, **1 connected component** (100% of nodes reachable from each other via the walkway graph itself) — see full statistics in §3.

### 2.3 Snapping logic (`_nearest_node`)

Already handles two failure modes that would otherwise be the most common source of live-navigation instability: (1) a fixed accuracy-aware tie-break margin (`STICKY_MIN_MARGIN_M`) so a route in progress doesn't flip between two similarly-costed branches on a few metres of GPS noise, and (2) an accuracy-aware sanity check on the chosen snap distance. Confirmed by code but also verified this pass with the smoke test / route-quality test in §8.

### 2.4 Findings requiring a human decision (not auto-fixed)

| Finding | Evidence | Why not auto-fixed |
|---|---|---|
| Dead-end node `n_74` sits **1.1m** from edge `n_2–n_3` (nearest other unconnected dead-end candidate) | Computed distance from `n_74` to every other edge in the graph; this was the only one under 8m — see `docs/graph/` and the validation report | 1.1m is consistent with GPS survey noise *or* a genuinely missing link — code can't tell which without ground truth (satellite imagery / a site visit). Auto-adding it risks creating exactly the "invalid shortcut" class of bug this audit was asked to guard against. |
| 2 edge pairs cross geometrically without sharing a junction node: `n_0–n_107`×`n_190–n_108` (crossing point 6.2m from node `n_108`) and `n_2–n_3`×`n_41–n_42` (crossing point 10.4m from node `n_42`) | Full segment-intersection scan across all 290 path segments — see `validate_walkway_graph.py`'s new crossing-edge check | Both crossings are close to an existing real junction node — most likely a survey/simplification artifact (the path bends near a junction and the simplified line overshoots slightly), not a missing connection. Flagged as a `validate_walkway_graph.py` **warning** (not error) for a human to glance at, not silently changed. |

Everything else that could plausibly be "the bug" — duplicate nodes, duplicate coordinates, zero-length edges, self-loops, duplicate edges, isolated nodes — came back **zero** across the whole graph.

## 3. Graph Statistics

| Metric | Value |
|---|---|
| Total nodes | 193 |
| Total edges | 244 |
| Location connectors | 32 |
| Average degree | 2.53 |
| Maximum degree | 5 (node `n_108`) |
| Connected components | **1** (fully connected) |
| Dead ends (degree 1) | 21 — 5 are legitimate building-entrance connectors, 16 are unconnected path spurs (cul-de-sacs / gate entrances — expected in real campus walkway data) |
| Isolated nodes | 0 |
| Duplicate nodes / coordinates | 0 |
| Zero-length edges | 0 |
| Internal duplicate points | 0 |

Full node list, edge list, statistics JSON, and visual exports (PNG/SVG/Graphviz/Mermaid) are in **`docs/graph/`** — see §11. Regenerate any time the graph changes: `python3 backend/scripts/generate_graph_docs.py`.

## 4. GPS Analysis

**You confirmed there's no active GPS problem right now** — this is a precautionary review, not a bug hunt, so per your own instruction ("do not make speculative fixes... only if justified") this section documents current behavior and explicitly recommends against implementing anything further without real evidence.

**What's already implemented** (all from the earlier routing-fix pass, confirmed still in place and working via the smoke/route-quality tests in §8):

- Off-route threshold **scales with the fix's own reported accuracy**: `accuracy_m × 1.3`, clamped to `[20m, 60m]` (`OFF_ROUTE_MIN_M`/`OFF_ROUTE_MAX_M`/`OFF_ROUTE_ACCURACY_FACTOR` in `LocationProvider.jsx`) — not a fixed threshold that a poor fix would trip constantly.
- A deviation must hold for **3 consecutive accepted fixes** (`OFF_ROUTE_CONFIRM_SAMPLES`) before the off-route state flips either way — absorbs single-sample GPS jitter.
- Map-matching (`matchToPath`) projects onto path *segments*, not just vertices, with a windowed search (2 segments back / 25 forward, `MATCH_WINDOW_BACK_SEGMENTS`/`MATCH_WINDOW_FORWARD_SEGMENTS`) around the previous match — prevents matching to an unrelated stretch of the route.
- Degenerate (near-zero-length) path segments are skipped in both the matcher and the turn-angle calculation, so a stray duplicate point (graph data or otherwise) can't produce a garbage bearing reading.

**What's NOT implemented, and why that's the right call today:** no Kalman filter, no explicit heading-based smoothing beyond what the accuracy-scaled threshold + 3-sample debounce already provide. These are real, standard techniques and the codebase would support adding them later, but implementing them now — with no live-GPS field data and no reported problem — would be exactly the kind of speculative, unjustified change both your instructions and general engineering judgment argue against. **If a specific problem ever surfaces** (a screen recording, console log, or `window.__navLog()` export showing genuinely poor behavior), that evidence is what should drive which of these techniques actually addresses it, not a default reach for "add a Kalman filter."

**Environmental factors** (outside/indoor/near-building GPS accuracy differences) are a property of phone GPS hardware and the Android/browser Geolocation API, not something the app's code can change — the app's job is to *tolerate* that variance gracefully, which the accuracy-scaled threshold above is specifically designed to do.

## 5. Route Quality

Automated test (`backend/scripts/route_quality_test.py`) generating **100 random location→location pairs and 100 random live-GPS-point→location pairs** (the point tests use realistic points — near an actual walkway edge plus 0–20m jitter, not uniformly random across campus, which would include the interior of open fields nobody's GPS fix would realistically be sitting in). Validates: a path is actually returned, no impossible shortcut (route distance ≥ straight-line distance), no connectivity gap between consecutive path points beyond the graph's own intentional 100m shape-point bound (`MAX_EDGE_LEN` in `build_walkway_graph.py`), and deterministic repeat results.

**Result: 200/200 passed.** Worth noting honestly: the *first* run of this test flagged 166 "failures" — investigation showed the test's own distance threshold was wrong (60m, when the graph legitimately allows shape-point spacing up to 100m by design) and its random-point generator was unrealistic (uniform over the whole bounding box). Both were fixed in the test itself, not the app — see the corrected script's comments for the full reasoning. Documenting this because it's a direct example of the audit's own "prove every conclusion with evidence" standard catching a false positive before it became a false bug report.

## 6. Security Audit

Every `/api/admin/*` route was enumerated and its auth dependency verified (see the full list in the PR/diff) — no route was found without an appropriate gate. Summary:

- **Password hashing:** bcrypt via `passlib`, unchanged and correct.
- **JWT:** HS256, secret from `JWT_SECRET` env var (random fallback in dev, which is itself a safeguard — tokens stop working across a dev restart, forcing a real secret before deploy). 12-hour expiry.
- **Role permissions:** `require_role("superadmin")` gates every Super-Admin-only route (Manage Fest Admins, audit log, event verify/reject/request-changes/delete, road closures, menus, analytics, feedback); `get_current_active_admin` (both roles, but with a live disabled-check — see below) gates the Fest-Admin-reachable ones (submit/edit own event, own images, account settings).
- **Privilege escalation:** no HTTP route exists anywhere that can create, promote, or modify a `superadmin` account — that's deliberately CLI-only (`scripts/create_admin.py`), by design from the RBAC pass and re-confirmed this pass. A Fest Admin cannot reach any Super-Admin-only route (tested explicitly — see §8).
- **Immediate account disable:** disabling a Fest Admin invalidates their access on their *very next request*, not whenever their JWT happens to expire — verified in the smoke test (§8, "disabled fest admin's existing token is rejected immediately").
- **Found and fixed — no brute-force protection on login.** There was no rate limiting or lockout of any kind on `/api/admin/login` before this pass: unlimited password guesses against any known username. Added a lightweight in-memory sliding-window lockout (5 failed attempts / 15 minutes, keyed by username) in `auth.py`. Verified directly: 6th consecutive wrong attempt returns 429, and a *correct* password is also rejected while locked out (can't be used to distinguish "wrong password" from "rate limited" as an oracle). Documented limitation: in-memory means this resets on a backend restart and isn't shared across multiple server instances — an acceptable trade-off at this project's scale; a Redis-backed counter would be the natural next step if that ever changes, not a rewrite of this.
- **CORS:** `allow_origins=["*"]` with `allow_credentials=False` — safe for a Bearer-token API (unlike cookies, browsers don't attach an `Authorization` header cross-origin automatically), left unchanged.
- **SQL injection:** all data access goes through the Supabase client's parameterized query builder, no raw SQL string concatenation anywhere in `data_access.py`.

## 7. Improvement Plan (what this pass actually did, beyond the audit itself)

1. Extended `validate_walkway_graph.py` with the two checks Part 4 asked for that weren't there yet: duplicate coordinates, geometric edge crossings — plus a machine-readable `validation_report.json` export.
2. Built `scripts/generate_graph_docs.py` — permanent node/edge list, statistics, Graphviz/Mermaid, and PNG/SVG documentation (Parts 2–3), reproducible any time the graph changes.
3. Added GeoJSON as a third optional input source to `build_walkway_graph.py` (Part 5) — purely additive, the pipeline behaves identically to before if no GeoJSON file is present (verified — see §8).
4. Built `scripts/route_quality_test.py` (Part 7).
5. Built the Dev Tools panel (Graph Viewer / Live GPS Debug / Snap Debug / Route Inspector / Graph Statistics / Route Replay / Export Graph), Super-Admin-only, isolated for easy removal (§9).
6. Built Account Settings (Part 8).
7. Fixed the login brute-force gap (§6) and the offline-indicator bug (§10.3) found while auditing.

---

## 8. Regression Tests / Verification

- **`backend/scripts/smoke_test_rbac.py`** (kept in the project — run with `python scripts/smoke_test_rbac.py`, no live DB needed): drives the real FastAPI app end-to-end against a fake in-memory database. **40/40 checks pass**, including every role-gate 403, ownership scoping, the full submit→needs_changes→edit→pending→approve cycle, and the immediate-disable property.
- **`backend/scripts/validate_walkway_graph.py`**: passes clean. Reachability 496/496 location pairs (unchanged from the routing-fix baseline). 2 warnings, both explained in §2.4.
- **`backend/scripts/route_quality_test.py 100`**: 200/200 passed (§5).
- **`build_walkway_graph.py`'s `load_ways()`** re-verified to load the identical 8 ways from GPX+KML with no GeoJSON file present (0 GeoJSON ways) — confirming the new optional third input source is genuinely non-breaking. Separately smoke-tested the GeoJSON parser itself against a synthetic file covering `LineString`, `MultiLineString`, and a `Point` (correctly skipped) — all parsed correctly.
- **Frontend build** (`npm run build`): clean. Dev Tools compiles to its own 20.1KB lazy chunk, Account Settings 3.4KB — neither is downloaded by a Fest Admin or a public visitor.
- **Frontend lint** (`npm run lint`): 23 problems (21 errors, 2 warnings) — **zero new issues** versus the pre-this-pass baseline of 23 (the 2 new files' `setState`-in-effect pattern matches the same accepted pattern already used by `AdminAnalytics.jsx`/`AdminFeedback.jsx`, not a new category).
- **Zero routing-fix files touched** — re-confirmed via a fresh diff against the delivery before this pass: `geo.js`, `LocationProvider.jsx`, `router.py`, `build_walkway_graph.py`'s existing logic, `walkway_graph.json`'s existing edges are all unchanged (only the new GeoJSON parser function and its wiring were added).

## 9. Dev Tools Panel — design notes

Deliberately isolated so it's trivial to remove later if you decide you don't want it:

- **Backend:** one file, `backend/devtools.py`, mounted with two lines in `main.py`. Every route in it is gated at the *router* level (`dependencies=[Depends(require_role("superadmin"))]`), so a route added to this file later can't accidentally ship unprotected.
- **Frontend:** one file, `frontend/src/pages/admin/DevTools.jsx`, lazy-loaded exactly like the other Super-Admin-only pages — a Fest Admin's browser never downloads it (verified in the build output).
- **To remove entirely:** delete `backend/devtools.py`, delete the 2-line mount in `main.py`, delete `frontend/src/pages/admin/DevTools.jsx`, delete its tab entry/content/import in `AdminDashboard.jsx`. Nothing else in the app references any of it.
- **Live GPS Debug** and **Route Replay** are frontend-only (they read the browser's own Geolocation API / replay a pasted trace) — no backend endpoint for either.
- **Graph Viewer / Snap Debug / Route Inspector / Graph Statistics / Export Graph** all call the new read-only `backend/devtools.py` endpoints, which never modify the graph or any other data — every one of them is a GET.

## 10. Code Quality

### 10.1 Dead code removed
`frontend/src/offline/offlineBundle.js` trimmed from ~155 lines to ~65: `fetchAndCacheBundle`, `getCachedBundle`, `initOfflineSync`, `hasCachedBundleSync`, `bundleLocationsById`, `searchLocationsOffline`, `cachedEventsOffline` were all unreachable from anywhere in the app (confirmed via a full grep before removing each one) — leftovers from an "Offline-First Experience" feature whose other half (the fallback logic in `api.js`) was removed in an earlier pass. Kept: `subscribeOfflineStatus`/`getOfflineStatus`, which `useOnlineStatus.js` → `OfflineIndicator.jsx` actually use.

### 10.2 New regression-test assets kept in the project
`backend/scripts/smoke_test_rbac.py`, `backend/scripts/route_quality_test.py`, `backend/scripts/generate_graph_docs.py` — all runnable standalone, all documented with usage instructions in their own docstrings.

### 10.3 Bug found and fixed while removing dead code
`initOfflineSync` (now deleted) was the *only* code that ever registered the browser's `online`/`offline` event listeners that update the header's offline-status badge — and nothing in the app ever called it. Practical effect: the offline indicator only ever reflected connectivity at the moment the page first loaded, and silently never updated again for the rest of the session, no matter how many times the device actually went on/offline. Fixed by registering those two listeners directly in the trimmed `offlineBundle.js` at module load (which happens exactly once, when the app starts) instead of inside a function nothing was calling.

---

## 11. Graph Documentation (Parts 2 & 3 deliverables)

All in **`docs/graph/`** (regenerate any time with `python3 backend/scripts/generate_graph_docs.py`):

- `node_list.json` / `.csv` — every node's id, lat, lng, degree, connected neighbours
- `edge_list.json` / `.csv` — every edge's endpoints, distance, path-point count, bidirectionality
- `graph_statistics.json` — the numbers in §3, machine-readable
- `graph.dot` — Graphviz, geographic layout (`dot -Tpng graph.dot -o out.png` or, better, `neato -Tpng`)
- `graph.mmd` — Mermaid (full 193-node graph is included for completeness, but Mermaid renders poorly much past a few dozen nodes — `graph.svg`/`graph.png` below are the actually-readable full-graph view; Mermaid is more useful pasted into a doc for one specific small subgraph)
- `graph.png` / `graph.svg` — full visual, nodes colored by role (red = critical junction, orange = dead end, green = normal), location markers, legend

## 12. Files Changed, This Pass

**New:**
- `backend/devtools.py` — Dev Tools backend (§9)
- `backend/scripts/generate_graph_docs.py`, `backend/scripts/route_quality_test.py`, `backend/scripts/smoke_test_rbac.py`
- `frontend/src/pages/admin/DevTools.jsx`, `frontend/src/pages/admin/AccountSettings.jsx`
- `docs/graph/*` (generated documentation)
- This report

**Changed:**
- `backend/auth.py` — login rate-limiting (§6)
- `backend/main.py` — Account Settings endpoint, devtools router mount
- `backend/data_access.py` — `get_admin_with_hash`, `update_own_account`
- `backend/scripts/validate_walkway_graph.py` — duplicate-coordinate + crossing-edge checks, JSON report export
- `backend/scripts/build_walkway_graph.py` — optional GeoJSON input source (§7.3), purely additive
- `backend/requirements.txt` — `httpx` (test-only), `matplotlib` (doc-generation-only)
- `frontend/src/pages/AdminDashboard.jsx` — Account Settings + Dev Tools tabs
- `frontend/src/offline/offlineBundle.js` — dead code removed, real bug fixed (§10.3)

**Not touched (verified via diff):** every routing-fix file (`geo.js`, `LocationProvider.jsx`, `router.py`, `walkway_graph.json`'s existing content, `MapView.jsx`), every RBAC file beyond the two additive account/devtools endpoints.

## 13. Performance Impact

Negligible and isolated. Dev Tools (+20.1KB) and Account Settings (+3.4KB) are both lazy-loaded chunks a regular visitor or Fest Admin never downloads. `get_current_active_admin`'s extra DB round-trip (for the immediate-disable property) only applies to Fest-Admin-reachable and Manage-Fest-Admins routes, unchanged from the RBAC pass — nothing new added there this pass. The graph-documentation and route-quality scripts are standalone dev tools, never run as part of a live request.

## 14. Future Recommendations

- If a real GPS problem is ever reported, get a `window.__navLog()` export or screen recording from the actual walk before implementing anything — see §4.
- Consider field-verifying the `n_74` near-miss and the two geometric crossings (§2.4) next time you're on campus — a 2-minute look would resolve them definitively either way.
- The login rate-limiter (§6) is in-memory; move it to something shared (Redis, or a Supabase table) if this ever runs as more than one backend instance.
- `docs/graph/` is now real documentation — worth a habit of re-running `generate_graph_docs.py` after any future manual graph edit, so it doesn't drift stale.
