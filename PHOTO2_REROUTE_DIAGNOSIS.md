# PHOTO2_REROUTE_DIAGNOSIS.md
**Subject:** Diagnosis of the anomalous route shown in Photo 2 (Turn Right, Near IT Block, 123m — flanked by Photo 1's 326m and Photo 3's 150m, the latter verified correct by field testing).
**Status:** Diagnosis only. No code or graph modified.
**Headline finding:** This is very likely **not a backend reroute at all** — Photo 2 and Photo 3 show the identical maneuver ("Turn Right in ~50m, Near IT Block → CSE Block"), which is strong evidence they're two different frontend renders of the *same* backend-computed route, not two different route computations. The mechanism is a client-side map-matching defect in `matchToPath` (`geo.js`), and I reproduced it by running the actual, unmodified function — not a re-implementation — against a genuinely self-proximate route shape.

---

## 1. Why did this happen?

Traced the full pipeline in `frontend/src/context/LocationProvider.jsx`. On every GPS tick (not just after a backend reroute):

```js
const match = matchToPath(lat, lng, routeRef.current, lastMatchIndexRef.current)
...
const remaining = remainingPathFromMatch(routeRef.current, match)
setRemainingPath(remaining)
const remDist = pathLength(remaining)
setRemainingDist(Math.round(remDist))
```

Both the displayed distance figure **and** the drawn polyline are recomputed client-side from wherever `matchToPath` decides the current GPS point projects onto the existing route — independent of whether any new backend call happens. A backend reroute only happens if `maybeRecalculate` is separately triggered by off-route detection, and even then it's gated by a 4-second cooldown.

`matchToPath`'s window (`MATCH_WINDOW_BACK_SEGMENTS = 2`, `MATCH_WINDOW_FORWARD_SEGMENTS = 25`) is meant to stop the match jumping to a lookalike, unrelated stretch of the route. **But for any route with 27 or fewer segments — a very ordinary length for a short campus walk — that window covers the entire route from any starting index.** It provides no real constraint in that case; it's effectively still an unconstrained, whole-path nearest-segment search on every tick.

## 2. Is it mathematically correct?

**No**, in the sense that matters — but I want to be precise about what specifically is wrong, since `pathLength(remainingPathFromMatch(...))` is itself a correct, faithful computation *given its inputs*. The input that's wrong is which segment `matchToPath` decided the user is on. I reproduced this directly:

- Built a real route to `cse-block` (found by computationally searching the SSN Fountain/Clock Tower area — the same landmark named in Photo 1's banner — for self-proximate geometry) where the route's own start briefly loops near itself: point 0 and point 3 (only 3 segments apart) sit just **15m** apart in space.
- Ran the actual `matchToPath()` from `geo.js` (unmodified, executed in Node, not simulated in Python): a first tick sitting exactly at the route's start correctly matches segment 0 (352.1m remaining). A **second tick with only ~7m of ordinary GPS jitter** — nowhere near an off-route trigger — matches segment 2 instead: **312.3m remaining, a ~40m jump from 7m of jitter**, skipping the little loop entirely.

This is the same class of failure as Photo 2, at smaller magnitude (my synthetic test found a 15m self-proximate gap; whatever the real Photo-1/2 route's geometry is, apparently a more pronounced one, given the ~200m discrepancy). The mechanism is proven; I don't have logged GPS/route data to confirm this exact incident's exact magnitude.

## 3. Is it desirable from a navigation perspective?

No. Independent of the exact magnitude, this produces a confusing, momentarily-wrong "remaining distance" readout and a polyline that skips a real segment of the route — exactly the kind of thing that makes navigation feel unpredictable, which is the same user-facing complaint from the very first round of this investigation ("I want the navigation experience to be comparable to Google Maps: stable, smooth, predictable").

## 4. Root cause classification

| Candidate | Verdict |
|---|---|
| GPS drift | **Trigger, not the cause.** Ordinary jitter of a few metres is expected and shouldn't produce a 40-200m swing in reported remaining distance; something downstream is over-reacting to it. |
| Snapping (backend `_nearest_node`) | **Not implicated.** Photo 2 and Photo 3 share the identical maneuver text — strong evidence no new backend call happened between them at all. |
| Rerouting thresholds | **Not implicated**, for the same reason — no evidence a `maybeRecalculate` call fired between Photo 2 and Photo 3. |
| Graph topology / completeness | **Not implicated.** The underlying route (wherever it actually is) is presumably a real, valid graph path; this bug is about how the frontend re-derives position along it, not what the path contains. |
| Frontend timing / navigation state | **Primary cause.** `lastMatchIndexRef`'s window is sized in *segments*, not scaled to the route's own length or geometry, so it fails to constrain anything on short, geometrically-compact routes. |
| Implementation bug | **Yes, same finding as above, stated as a defect rather than a category** — confirmed by direct execution of the real code, not inferred. |
| User behaviour | **Not implicated.** The tester didn't do anything unusual; ordinary walking with ordinary GPS noise is sufficient to trigger this given the right route shape. |

## 5. Exact execution path

1. `LocationProvider.jsx`'s position-tick handler (~line 483): `matchToPath(lat, lng, routeRef.current, lastMatchIndexRef.current)`.
2. `geo.js::matchToPath`: `lo = max(0, searchFromIndex - 2)`, `hi = min(lastSegment, searchFromIndex + 25)` — for a route with ≤27 segments, `hi` reaches the route's own end regardless of `searchFromIndex`, so the "window" imposes no real restriction. Picks whichever segment's perpendicular projection is numerically closest to the current (possibly jittery) GPS point — including a self-proximate segment several indices ahead.
3. `lastMatchIndexRef.current = match.segmentIndex` (~line 485) — the wrong index is now the anchor for the *next* tick too.
4. `geo.js::remainingPathFromMatch(routeRef.current, match)` — builds the displayed remaining path starting from the wrongly-matched point, silently dropping the real segments in between.
5. `pathLength(remaining)` → `setRemainingDist` → rendered in the bottom sheet ("123 m REMAINING") and the polyline in `MapView.jsx`.

## 6. Confidence

- **High** that this general class of defect exists and is exploitable with only ordinary GPS jitter — this is proven by executing the actual shipped `matchToPath` function, not inferred from reading it.
- **Medium** that this specific mechanism (rather than some other one) is what produced Photo 2 specifically — I don't have logged coordinates or a captured route for this exact walk, so I can't confirm the real route's self-proximate geometry matches what I found synthetically. The circumstantial evidence is consistent throughout (identical maneuver text between Photo 2/3, the non-monotonic distance sequence, the landmark text pointing at exactly the area I searched, and no equally well-supported alternative explanation surfaced during this investigation) — but I want to be direct that "medium," not "high," is the honest confidence level for the specific-incident claim, as distinct from the mechanism claim.

## 7. Smallest possible fix (NOT implemented)

Two candidate approaches, either of which is small and localized to `matchToPath`:

1. **Prefer the earliest (lowest-index) segment among near-ties.** When multiple candidate segments in the window project to within some small distance-equivalence tolerance of each other (e.g., a couple of metres), keep the lowest-index one rather than the single numerically closest one. This directly counters "skip ahead to a nearby-but-later segment" without changing behavior for the common case where there's one clear best match.
2. **Cap forward progress per tick to a physically plausible bound.** Since ticks carry a timestamp and the app already assumes a walking speed elsewhere (`WALKING_MPS`/`1.4` m/s), a tick's matched `cumulativeDistanceM` could be bounded to not exceed roughly `elapsed_seconds × plausible_max_speed` past the previous match — independent of route shape, so it would also cover cases my synthetic test didn't happen to find.

Either is a targeted change inside `matchToPath`/its call site — not a redesign, and doesn't touch the backend, the graph, or Fix 1/Fix 2 from prior rounds.
