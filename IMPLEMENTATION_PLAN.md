# IMPLEMENTATION_PLAN.md

**Purpose:** running ledger for the CSE Annexure routing / GPS investigation.
A second, independent Claude investigation is feeding findings into this
thread. This document tracks every finding through the same pipeline:

```
Finding received → verified independently against this repo → confirmed / rejected / partial
                  → (if confirmed) minimal safe fix designed → implemented → tested
```

**Rules this document follows:**
- A finding from the other investigation is a **hypothesis**, not a fact, until re-derived
  against this repo's actual code/data/state.
- A finding is never accepted *or* rejected without evidence recorded here.
- Nothing gets implemented until it's marked **✅ Confirmed**.
- If new evidence overturns something already marked Confirmed or Rejected, that entry is
  revised in place with a note explaining why — history isn't deleted, superseded reasoning
  is struck through and dated.

**Status legend:** 🔵 Pending verification · ✅ Confirmed · ❌ Rejected · ⚠️ Partially confirmed (needs more evidence) · 🛠️ Fix implemented · 🧪 Fix tested

---

## 0. Baseline — self-identified during initial repo read (this Claude, before any external findings)

These came from reading the code/graph directly, not from the other investigation. Flagged
here under the same discipline: none are "confirmed" bugs yet, just leads worth checking
against whatever evidence arrives.

| # | Finding | Status | Notes |
|---|---|---|---|
| B1 | `it-block`→`n_177` (27m) and `cse-block`→`n_178` (23m) location-connectors, plus the 6.7m `n_177`↔`n_178` edge between them, are unverified straight lines sitting between two adjacent buildings — the class of segment `router.py`'s own docstring identifies as never checked against walkability | ✅ Confirmed | Superseded by the far more precise external investigation's Q5/Q7 (Section 1, F5/F7) — this was the right neighborhood but not yet the actual mechanism. n_178 is exactly the node the confirmed accuracy-gate bug (F5) snaps to. |
| B2 | GPS marker "drift" is architecturally ambiguous: `processPosition` never smooths/adjusts the coordinate (only a 0.4s CSS transition on the marker DOM node exists), so a multi-second convergence is consistent with *either* genuine phone GPS chip acquisition *or* a real regression | ⚠️ Partially confirmed | External investigation's §3 (F-marker-drift below) reaches the same architectural conclusion independently and adds a plausible alternative: extra testing/rerouting time spent at this one spot could itself explain the reported correlation with location. Neither of us instrumented a real trace — still open. |
| B3 | `backend/data/validation_report.json` (already regenerated, in this delivery) lists **4** geometric edge-crossings without a shared node; `PRODUCTION_AUDIT_REPORT.md` only documents 2 of them | ❌ Rejected (self-correction) | Re-ran `validate_walkway_graph.py` fresh myself: only **2** crossings don't share a node (`(n_0,n_107)×(n_190,n_108)` 6.2m, `(n_2,n_3)×(n_41,n_42)` 10.4m) — the other 2 I originally lumped in **do** share a node (`n_12`, `n_26` respectively), which the validator itself labels "expected near any junction," not a defect. I mis-read my own earlier output. Matches the external investigation's Q2 exactly (see F2). |
| B4 | `frontend/src/utils/rerouteDebug.js` is still present, marked TEMPORARY, and states the backend was proven correct for disputed coordinates while the frontend could not be exonerated — this is an open thread, not a resolved one, despite `PRODUCTION_AUDIT_REPORT.md`'s "no open routing bug" conclusion | ✅ Confirmed as the actual bug | The external investigation's Q5+Q7 explain exactly why "backend proven correct" and "real walk still reproduced the bug" were both true simultaneously: the backend *was* correct for whichever accuracy value that one proof happened to use, but the sanity check's accuracy-gate was backwards, so a different (worse) accuracy value on a real walk reproduced it. Not a stale-cache issue as I'd speculated — a logic-direction bug. |

---

## 1. Findings from the independent investigation

**Received:** `ROOT_CAUSE_REPORT.md` + `flip_points_evidence.json` (101 points), this session.
**Verification method:** ran the repo's own `_load()`/`_build_adj()`/`_nearest_node()`/
`find_route_from_point()` directly (not re-derived from reading), re-ran
`validate_walkway_graph.py` and `route_quality_test.py` fresh (unmodified at time of
verification), and used `networkx` independently for the graph-theoretic claims.

### F1 (Q1): Graph completeness — raw survey points near the chokepoint underrepresented
**Claim:** single connected component, 0 structural defects; 23/56 (41%) raw GPX trackpoints
within 90m of the n_177/n_178/n_8 chokepoint sit >12m from the nearest graph node (worst
case 43.9m) — suggestive of missing detail, not proof of a missing path.

**Independent verification:** re-ran `validate_walkway_graph.py` fresh — confirms 0
duplicate/zero-length/self-loop/duplicate-coordinate defects, 496/496 reachable. Parsed
`backend/data/raw/walkpathssn.gpx` myself and computed distances directly: **55** trackpoints
within 90m (vs. claimed 56), **24** (43.6%) over 12m from nearest node (vs. claimed 23,
41%), worst case **34.0m** (vs. claimed 43.9m). Same order of magnitude and same
conclusion; minor deltas plausibly explained by GPX parsing/dedup differences, immaterial
to the claim.

**Verdict:** ✅ Confirmed (as the report itself frames it — suggestive, not conclusive; not
actionable without a human/field check).

### F2 (Q2): Topology — 2 unrelated geometric crossings without a shared node
**Claim:** `(n_0,n_107)×(n_190,n_108)` at 6.2m and `(n_2,n_3)×(n_41,n_42)` at 10.4m are real
topology defects, both 90m+ from the CSE Annexure cluster, unrelated to this investigation.

**Independent verification:** re-ran `validate_walkway_graph.py` fresh. Output matches
exactly: `geometric crossings not at a shared node: 2 (2 more at a shared node, expected
near any junction)`. Inspected `validation_report.json`'s `structural.geometric_crossings`
directly — the exact same two node pairs and distances are recorded, `shares_a_node: false`
for both. The other two crossings the validator also reports (`n_12`/`n_80`/`n_19` and
`n_26`/`n_101`/`n_39`) do share a node and are correctly excluded from this claim — this
also corrects my own B3 above.

**Verdict:** ✅ Confirmed exactly. Not implicated in the CSE Annexure bug; separate,
low-priority defect. **Not fixed this pass** — out of scope of the confirmed CSE Annexure
mechanism, and the report itself recommends a separate ticket.

### F3 (Q3): Snapping instability is systemic campus-wide, not unique to CSE Annexure
**Claim:** a 15×15 grid scan (±35m) around each of 32 locations, comparing `_nearest_node`
at accuracy 15 vs. 30, shows `cse-block` (9.3%) and `it-block` (13.8%) ranking mid-pack
(18th/11th of 31) — but a specific point at the chokepoint has a razor-thin boundary where
an 11cm coordinate rounding flips the outcome.

**Independent verification:** reimplemented the same grid-scan methodology independently
(own script, not copied) and ran it for `cse-block`, `it-block`, `food-rishabhs`, `main-gate`.
Results: `cse-block` **9.3%** (21/225) — exact match. `it-block` **14.7%** vs. claimed 13.8%,
`food-rishabhs` **32.9%** vs. claimed 32.0% — both close, small deltas fully explained by
grid-alignment/spacing differences (the report's own "~10m spacing" for a 15-point, ±35m
grid is internally a ~5m spacing; exact alignment wasn't specified). `main-gate` **0.0%**
matches exactly. Directly re-ran the specific chokepoint coordinate at accuracy 15 with
full precision (`12.75170625, 80.19693333333333`) vs. 6-decimal-rounded
(`12.751706, 80.196933`) — full precision gives `n_8`/14.6m, rounded gives `n_178`/34.3m,
i.e. an ~11cm rounding difference really does flip the outcome. Confirmed directly, not
inferred.

**Verdict:** ✅ Confirmed, including the specific razor-thin-boundary claim.

### F4 (Q4): n_177/n_8 are shared articulation points for cse-block + it-block
**Claim:** `networkx.articulation_points`/`bridges` on the full graph finds 61 articulation
points, 72 bridges; removing either `n_177` or `n_8` disconnects both `cse-block` and
`it-block` simultaneously — they share one physical corridor.

**Independent verification:** built the graph fresh into a `networkx.Graph` myself
(edges + location_edges) and ran the same analysis. **61 articulation points, 72 bridges —
exact match.** Removing `n_177` (and separately `n_8`) and testing reachability to
`main-gate`: both `cse-block` and `it-block` become unreachable in both cases — confirms
the shared-corridor claim exactly.

**Verdict:** ✅ Confirmed exactly. Real structural fact, not a data artifact — context for
F1, not itself a bug requiring a code fix.

### F5 (Q5): Accuracy-gated sanity check in `_nearest_node` is directionally backwards — PRIMARY DEFECT
**Claim:** the `if extra_snap > accuracy_m and improvement < extra_snap:` check
(`router.py`, then-lines ~252-257) means *worse* accuracy makes the safety net trigger
*less* often — backwards from the intent. At the chokepoint, any accuracy ≥ ~20m disables
protection entirely.

**Independent verification:** ran the report's exact reproduction recipe against the live,
unmodified `_nearest_node`/`find_route_from_point` before touching any code:
```
accuracy=15 -> n_8   (14.6m, real surveyed path)
accuracy=20 -> n_178 (34.3m, straight-line-only connector)
accuracy=30 -> n_178 (34.3m, straight-line-only connector)
```
Exact match to the claim. Read the live source at the cited location and confirmed the
quoted code block is verbatim what's in the repo (`router.py:252-257` pre-fix). Also
reproduced the resulting bad route geometry exactly (raw point → 34.28m unsurveyed
straight line → n_178 → cse-block).

**Verdict:** ✅ Confirmed exactly, root cause and mechanism both verified by direct
execution, not just by reading. **This is the primary defect — fixed this pass, see Fix 1.**

### F6 (Q6): Frontend rendering — no independent rendering defect found
**Claim:** `MapView.jsx`'s `<Polyline>` usage is a direct, untransformed 1:1 map of backend
path points; `remainingPathFromMatch`'s truncation is deliberate, by design. One residual,
not-fully-closed risk: `matchToPath`'s unconstrained whole-path search immediately after a
reroute could theoretically match the wrong segment on a self-intersecting route, though 4
tested reroute scenarios found no instance of two path points closer than 15m appart.

**Independent verification:** read `MapView.jsx`'s `<Polyline positions={...}>` call sites
directly — confirms a plain `path.map(p => [p.lat, p.lng])`, no decimation/reprojection.
Did not independently re-run the 4-scenario self-proximity test myself this pass (low
priority given it found nothing, and rendering was never a live symptom in the user's
screenshots).

**Verdict:** ✅ Confirmed as described (exonerated, with an honestly-flagged residual risk
carried forward, not closed). No fix needed or attempted this pass.

### F7 (Q7): Sticky node preference has no mid-session reset — PERSISTENCE DEFECT
**Claim:** `lastSnappedNodeRef` (frontend) locks onto whatever node the *first* reroute of a
session snapped to and is only reset in 3 places (stop, new destination, new route-start) —
never as GPS accuracy improves mid-session. A bad first fix stays wrong for the whole walk.

**Independent verification:** `grep`'d every `lastSnappedNodeRef` reference in
`LocationProvider.jsx` — confirmed exactly 3 reset-to-null sites (`stop()`, `setRoute()`,
`clearRoute()`), and exactly one set-after-response site (post-reroute `.then()`). Ran the
report's exact sticky-entrenchment recipe against the live `_nearest_node`:
```
accuracy sequence (30, 15, 15, 15), prefer fed forward each time:
30, prefer=None -> n_178
15, prefer=n_178 -> n_178   (stuck — a fresh 15m fix alone would have picked n_8)
15, prefer=n_178 -> n_178
15, prefer=n_178 -> n_178
```
Reversed order (good fix first) stays correctly on `n_8` throughout. Exact match to claim.

**Verdict:** ✅ Confirmed exactly, reproduced end-to-end. **Fixed this pass, see Fix 2.**

### F8 (Q8): Multi-cause classification
**Claim:** GPS variance (trigger, not a bug) + backwards accuracy gate (F5, root mechanism)
+ sticky entrenchment (F7, persistence mechanism) + unusually tight local topology (F3/F4,
why it's visible here) are jointly necessary; rendering (F6) is exonerated; graph
completeness (F1) is a separate open question.

**Verdict:** ✅ Confirmed — this is exactly what F1-F7 above independently support.

### F-marker-drift: GPS marker convergence — architecturally separate from the routing bug
**Claim:** the displayed marker is the raw, unsnapped coordinate; `_nearest_node`/rerouting
never touch it. `GPS_ACQUIRE_GRACE_MS` (acquisition withholding) and the `.user-marker-icon`
CSS transition are plausible visual mechanisms, not instrumented/measured this pass. No
evidence ties this specifically to CSE Annexure beyond user-reported correlation, which
could equally be explained by more time spent testing/rerouting at this one spot.

**Independent verification:** matches my own B2 finding from the architectural review,
reached independently before this report arrived. No new evidence either way; still open.

**Verdict:** ⚠️ Partially confirmed — architecturally plausible, not measured. **Not fixed
this pass** (would need a real device accuracy-over-time trace to distinguish from ordinary
GPS cold-start behavior — out of scope for a static/backend-reproducible fix).

### F-flip-evidence: `flip_points_evidence.json` (101 points)
**Independent verification:** spot-checked 6 rows directly against live `_nearest_node`
before any fix — 5/6 matched exactly; the 6th (`12.751706, 80.196933`) returned `n_178` at
accuracy 15 instead of the file's claimed `n_8`. This is not an error in the evidence file —
it's the *same* sub-15cm rounding sensitivity the report documents in Q3: the file's printed
6-decimal coordinates are a rounded display of whatever exact float generated the row, so
this one row isn't independently reproducible from its own printed digits alone. Confirmed
this is exactly the phenomenon at play, not a data-quality problem, by re-checking against
the full-precision chokepoint value.

**Verdict:** ✅ Confirmed reliable (with the one documented, self-consistent caveat above).
Used directly as a regression suite for Fix 1 (see Fix 1's testing section) — all 101 points
independently re-derived from the graph, matching the file exactly.

---

## 2. Confirmed fixes (implemented)

### Fix 1: Correct the direction of the accuracy-gated sanity check in `_nearest_node`
- **Root cause:** `_nearest_node`'s protection against trusting a distant, unverified
  "shortcut" node only fired when `extra_snap > accuracy_m` — so a *worse* (larger)
  `accuracy_m` made the extra distance *less* likely to trip the threshold, disabling the
  safety net exactly when GPS is least trustworthy. See F5.
- **Evidence:** F5 above — reproduced against the live graph before any change: accuracy
  15 correctly picked `n_8` (real path), accuracy 20/30 picked `n_178` (34.3m unverified
  straight line through the building gap).
- **Files changed:** `backend/utils/router.py` — the sanity-check conditional
  (`_nearest_node`, previously lines 250-257) and its preceding docstring paragraph
  (updated to describe the corrected behavior instead of the since-removed backwards one).
- **Why this implementation is correct:** replaced the accuracy-gated *on/off* switch with
  an accuracy-scaled *margin*: `improvement < extra_snap + accuracy_m` now always
  evaluates (whenever a non-closest candidate wins) and requires the win to clear a bar
  that *grows* with `accuracy_m`, so worse accuracy now demands a bigger margin before
  trusting the far candidate — the intended direction. The `accuracy_m is None` branch
  (skip the check entirely) is untouched — same behavior as before for callers that don't
  supply an accuracy figure, keeping the change scoped to exactly the confirmed defect.
- **Regression risks:** this check runs for every reroute campus-wide, not just at CSE
  Annexure (confirmed systemic per F3), so a directional change could in principle affect
  other locations' snap decisions. Mitigated by testing below — no regressions found.
- **Testing performed:**
  - Reproduction recipe (F5): all four accuracy values (15/20/30/50) now resolve to `n_8`
    at the chokepoint, previously flipped at 20/30.
  - Full `flip_points_evidence.json` (101 points, F-flip-evidence): **101/101 now stable**
    (accuracy-15 and accuracy-30 pick the same node), 0 remaining flips, 0 regressions
    against the file's own recorded accuracy-15 baseline.
  - `backend/scripts/validate_walkway_graph.py` (unmodified): re-run post-fix — still
    passes, same 2 warnings as pre-fix (F2's unrelated topology defects; 8 long-ratio
    pairs) — no new structural issues introduced.
  - `backend/scripts/route_quality_test.py 400` (unmodified): re-run post-fix — **800/800
    passed**, no disconnected paths, no impossible shortcuts, fully deterministic.
  - `python3 -m py_compile utils/router.py` — clean.

### Fix 2: Sticky node preference now decays when a meaningfully better fix arrives
- **Root cause:** `lastSnappedNodeRef` (frontend) is only reset to `null` on
  stop/new-destination/new-route — never mid-session as accuracy improves — so whichever
  node the *first* reroute happened to snap to (even from a poor fix) was fed back as
  `prefer_node` on every subsequent reroute for the rest of the walk. See F7.
- **Evidence:** F7 above — reproduced against the live backend: accuracy sequence
  (30, 15, 15, 15) with the preference fed forward stayed on the wrong node (`n_178`) for
  all four calls, despite three consecutive good (15m) fixes after the first.
- **Files changed:** `frontend/src/context/LocationProvider.jsx` —
  - added `STICKY_ACCURACY_IMPROVEMENT_TO_RESET_M = 10` constant,
  - added a paired `lastSnappedAccuracyRef` (remembers the accuracy behind the *current*
    sticky preference, not just the node id), reset alongside `lastSnappedNodeRef` at all
    3 existing reset sites (`stop()`, `setRoute()`, `clearRoute()`),
  - `maybeRecalculate` now computes `stickyIsStale` (true when the current fix's accuracy
    is at least 10m better than the fix that set the current preference) and only sends
    `prefer_node_id` when the preference isn't stale; the actual `getRouteFromCoords` call
    (previously read `lastSnappedNodeRef.current` directly) now uses this computed value,
  - the post-response handler now stores `lastSnappedAccuracyRef.current = accuracyM`
    alongside `lastSnappedNodeRef.current = r.snapped_to`.
- **Why this implementation is correct:** this doesn't remove stickiness (still needed —
  see F7/docstring's separate n_126-vs-n_47-style ambiguous-branch case, which Fix 1 alone
  doesn't address since neither candidate there is an implausible long-jump). It makes
  stickiness conditional on the preference still being the best-available evidence: a fix
  that's about the same or worse than the one that set the preference doesn't reopen the
  question (preserves the anti-flip-flop behavior); a fix that's decisively better (≥10m
  improvement — chosen well above ordinary tick-to-tick GPS jitter) does, letting the
  backend re-decide from scratch with that better information, then re-anchoring the
  sticky preference to it. Desk-checked the exact reported sequence: fix 1 (30m, no prior
  preference) sets the anchor; fix 2 (15m, a 15m improvement ≥ the 10m bar) drops the
  stale preference and lets a fresh pick happen; fixes 3-4 (15m, no further improvement
  over the now-15m anchor) correctly stay sticky. This self-corrects within one reroute of
  a genuinely better fix arriving, instead of for the rest of the session.
- **Regression risks:** changes when `prefer_node_id` is sent, not the backend's handling
  of it — so backend behavior for a given `(lat, lng, accuracy, prefer_node_id)` tuple is
  unchanged (still covered by Fix 1's `route_quality_test.py`/`validate_walkway_graph.py`
  runs). The new 10m threshold is a judgment call — set well above typical successive-fix
  jitter (a few metres) but could theoretically be tuned lower/higher; flagged here rather
  than silently assumed correct.
- **Testing performed:**
  - Code-level desk-check of the exact reported (30,15,15,15) and reversed (15,30,15,15)
    sequences against the new `stickyIsStale` formula — both resolve as intended (see
    reasoning above).
  - `npm install && npm run build` in `frontend/` — clean production build, 0 errors, all
    116 modules transform successfully, confirms the edited file is syntactically valid
    and the app still builds end-to-end.
  - **Not performed:** a real browser/device end-to-end test of the full reroute sequence
    (would need live or simulated GPS in an actual running session) — noted as a gap, not
    silently assumed away.

---

## 3. Rejected findings

Nothing from `ROOT_CAUSE_REPORT.md` or `flip_points_evidence.json` was rejected — every
claim checked (F1-F8, F-marker-drift, F-flip-evidence) was independently reproduced or
corroborated by direct execution against the live repo, not just plausible on reading.

The only rejection this round was of my **own** earlier baseline finding B3 (Section 0) —
"4 crossings" was a misreading of my own earlier validator output; the real count,
independently re-confirmed against a fresh validator run, is 2. See B3's entry above.

---

## 4. In progress — live field test against the fixed build (2026-07-25)

**Received:** 5 field screenshots + 1 graph visualization, from testing the delivered fixed
zip live on campus. No reroute logs (not connected to remote debugging while walking).
Two approximate GPS fixes supplied: "photo 3" (12°45'08.0"N 80°11'49.0"E, DMS) and "photo 4"
(12.752231825303204, 80.19717248210814, decimal). Both fixes are ~57-64m **north** of the
n_177/n_178/n_8 chokepoint Fix 1/Fix 2 targeted — a different part of the local path
network, near the "SSN Fountain / Clock Tower" instruction banner visible in photo 4.

**What I ran (against the current, already-fixed code, not a hypothetical):**
`find_route_from_point`/`_nearest_node` directly on both coordinates.

- **Photo 3 fix** (12.752222, 80.196944): closest node by straight-line is `n_128` (23.2m),
  but the router picks `n_8` (51.8m) instead. Checked this is **not** a repeat of the F5
  bug: computed both nodes' true Dijkstra cost to `cse-block` by hand —
  `n_128`: 23.2m connector + 316.3m walk = 339.5m total. `n_8`: 51.8m connector + 62.5m
  walk = **114.4m total**. `improvement` (225.1m) clears Fix 1's required margin
  (`extra_snap` 28.6m + `accuracy_m`) at every accuracy tested (15/30/50) by a wide margin.
  **Fix 1 is working correctly here.**

- **Photo 4 fix** (12.752232, 80.197172): snaps cleanly to `n_99` (13.8m), total 392.0m.

### ⚠️ Self-correction — my own follow-up hypothesis about `SNAP_MARGIN_M` was wrong

Before the external `FIELD_TEST_INVESTIGATION_REPORT.md` arrived, I brute-forced every node
within 150m of photo4 (bypassing `SNAP_MARGIN_M`/`NEAREST_NODE_CANDIDATES`) and found `n_178`
scoring better on paper (113.6m) than the router's actual choice (392.0m), and provisionally
flagged this as a candidate-shortlist defect worth fixing — reproduced the same pattern along
a perturbation scan between photo3 and photo4 and found a sharp discontinuity at the last
~6m of that walk. **This was a real observation but the wrong conclusion.** The "113.6m" figure
used an **unverified 90.4m straight-line haversine distance** from the live point to `n_178`
as if it were free — exactly the class of unverified-connector risk `SNAP_MARGIN_M` exists to
prevent, in the same tightly-built cluster as the original bug. I was about to recommend
loosening or restructuring the exact safeguard that protects against the original bug's
mechanism, based on a number that assumed the thing being protected against was fine.

`FIELD_TEST_INVESTIGATION_REPORT.md` (external, this round) reached the correct conclusion
independently: `n_99` is the genuine, unambiguous closest node (confirmed:
`best_id == closest_id` at this exact position, so Fix 1's check isn't even invoked — there's
nothing to override), and the real mechanism is that `n_99` has real graph edges only westward
(`n_128`, `n_98`, `n_2`) — genuinely no short path toward the `n_136`/`n_8` cluster exists in
the graph. **Re-verified every one of that report's specific claims independently, by direct
execution, before accepting the correction:**

| Claim | My independent check | Result |
|---|---|---|
| `n_99`'s edges are only `n_128` (61.8m), `n_98` (30.5m), `n_2` (73.1m) | Iterated the raw edge list for `n_99` myself | ✅ exact match |
| `n_99`→`n_136` straight-line 49.1m, `n_99`→`n_8` 58.0m | Recomputed with haversine | ✅ exact match (49.14m, 57.99m) |
| Photo 3: 114.4m computed vs. 118m displayed (3.6m/3% gap) | Recomputed | ✅ exact match |
| Photo 4: 391.9m computed vs. 313m displayed (79m/25% gap) | Recomputed (392.0m) | ✅ matches within rounding |
| Regression check: neither Fix 1 nor Fix 2 caused this | Confirmed `best_id==closest_id` (Fix 1 never triggers) and this is a first-ever reroute at a fresh position (Fix 2's staleness logic isn't relevant) | ✅ confirmed independently |

**Verdict on my own prior hypothesis: ❌ Rejected, by my own further testing**, not just on the
other report's say-so — see the follow-up check below, which is what actually convinced me.

### Follow-up: checked for *real, already-collected* survey evidence before ruling either way

Before accepting "this needs a new edge" *or* "don't touch anything," I checked whether the
project's own raw GPX survey (`data/raw/walkpathssn.gpx` — already in the repo, not new data)
contains any trackpoints in the `n_99`↔`n_136` gap that the graph-build pipeline might have
missed. Found 13 raw trackpoints within 20m of that hypothetical line — promising at first —
but checking each one's distance to *every existing edge's polyline* (not just nearby nodes)
showed **all 13 are already shape points of edges that exist in the graph today**
(`n_99`-`n_128`, `n_99`-`n_98`, `n_2`-`n_99`, `n_136`-`n_137` — distances 0.3-3.1m, clearly
already-claimed geometry, not orphaned data). **No raw survey evidence supports a direct
`n_99`↔`n_136` connector.** This is a clean negative result, not an absence of looking.

**Conclusion, independently reached and now doubly-confirmed:** the `n_99` gap is a genuine
**missing graph data** issue (classification: graph topology / missing data, **High
confidence** — reproduced by direct execution, cross-checked against two independent lines
of evidence, and confirmed there's no already-collected data to build the fix from).
**Not fixed this round** — adding an edge here would mean inventing survey data, which both
this investigation and the external report explicitly rule out. The responsible next step is
a short dedicated GPS-logged walk of just that ~50m corridor, not a code change.

---

## 4a. KML merge — implemented

**Received:** `cseitroad.kml` (2-point LineString, "path not in map as of now") +
`KML_MERGE_REPORT.md` (external, proposing the merge). User was explicit this KML is
unrelated to the routing investigation above and should be judged independently — treated
accordingly; it is not offered as evidence for or against the `n_99` finding.

**Independent verification of the external merge report, before applying anything:**
loaded the raw KML myself, recomputed every distance in the report from scratch.

| Claim | My check | Result |
|---|---|---|
| KML points A (12.7513717,80.1970728) / B (12.7510447,80.1970702) | Read raw KML directly | ✅ exact match |
| A nearest existing node = `n_178` @ 6.10m | Checked against every node in the graph | ✅ exact match |
| B nearest existing node = `n_122` @ 4.39m | Checked against every node in the graph | ✅ exact match |
| `n_178`↔`n_122` direct distance 43.09m | Recomputed | ✅ exact match |
| No existing edge already connects them | Searched the full edge list | ✅ confirmed |
| `n_122`→`cse-block` currently 412.1m | Ran `_dijkstra` myself | ✅ exact match (412.13m) |
| `n_99` (this investigation's gap) is a different, ~130m+-distant node from `n_122` | Recomputed | ✅ exact match (135.5m) — confirms the two reports' findings are genuinely unrelated, not the same thing twice |

**One correction to the external report before implementing:** it proposed `distance_m:
36.36` for the new edge — the KML survey's own raw endpoint-to-endpoint length. But every
existing edge in this graph uses `distance_m` = the *cumulative* haversine length of its
actual `path` array (verified against an existing edge: `n_17`-`n_106`'s recorded 15.23m
matches its 2-point path exactly). The path being merged starts at `n_178`'s own coordinate
and ends at `n_122`'s own coordinate (per "reuse existing nodes" — not the KML's raw
endpoints, which are 6.1m/4.4m away from those), so its true cumulative length is
**46.85m** (6.10 + 36.36 + 4.39m across the 3 segments), not 36.36m. Used the corrected
value — this is what Dijkstra actually uses as edge weight, so getting it right matters for
route-cost accuracy, not just bookkeeping.

**Implemented:** appended one edge to `backend/data/walkway_graph.json`:
```json
{
  "from": "n_178", "to": "n_122", "distance_m": 46.85,
  "path": [
    {"lat": 12.751426, "lng": 80.197065},
    {"lat": 12.7513717, "lng": 80.1970728},
    {"lat": 12.7510447, "lng": 80.1970702},
    {"lat": 12.75104, "lng": 80.19703}
  ]
}
```
No nodes added, renamed, or removed. No existing edges modified, simplified, or removed.
193 nodes unchanged, 244→245 edges, 32 location_edges unchanged.

**Regression testing:**
- `validate_walkway_graph.py`: still passes, same 2 pre-existing crossing warnings (unrelated,
  F2), **no new warnings**. The "long route/straight-line ratio" warning count actually
  *improved* (8→5 pairs), consistent with this edge shortening some previously-circuitous
  routes — a positive side effect, not something I optimized for.
- `route_quality_test.py 400`: 800/800 passed post-merge, same as pre-merge.
- Confirmed the predicted improvement directly: `n_122`→`cse-block` now costs **70.06m**
  (46.85 + `n_178`'s existing 23.21m), down from 412.13m — matches 46.85+23.21 exactly,
  confirming the corrected `distance_m` is what the router actually uses.
- Confirmed this merge does **not** touch the `n_99` cluster: re-ran the photo-4 query
  post-merge, identical result (392.0m, snapped to `n_99`) — the two findings are genuinely
  independent, as expected.

## 5. Open questions / evidence still needed

**Resolved this round** (kept here, struck through, for the record — not deleted):
- ~~Exact GPS coordinates from a walk that reproduced the bad route near CSE Annexure~~ —
  the external investigation supplied the exact chokepoint coordinate and a full
  reproduction recipe; independently re-run and confirmed (F5, F7).
- ~~Confirmation of whether `walkway_graph.json` changed since `PRODUCTION_AUDIT_REPORT.md`~~
  — moot: F5/F7 show the bug was a logic-direction defect in `_nearest_node`/the frontend's
  stickiness ref, not a stale-graph-cache issue as B4 had speculated.

**Still open, deliberately not addressed this pass:**
- GPS marker "drift" (F-marker-drift / B2) — still needs a real device accuracy-over-time
  trace to distinguish ordinary GPS cold-start behavior from a code regression. Not
  reproducible from static analysis or backend-only testing; out of scope for this round's
  backend/frontend logic fixes.
- F1's raw-survey-point underrepresentation near the chokepoint — the report's own
  recommendation stands: needs a human/field walk-through before treating it as a missing
  path, not a code change.
- F2's 2 unrelated topology crossings, and the 8 long route/straight-line-ratio pairs —
  confirmed real, explicitly out of scope of the CSE Annexure mechanism, left for a
  separate pass per the report's own recommendation.
- F6's residual `matchToPath` unconstrained-search-after-reroute risk — exonerated as a
  cause of anything reported so far, but not exhaustively tested (4 scenarios only).
- Fix 2's `STICKY_ACCURACY_IMPROVEMENT_TO_RESET_M = 10` threshold is a reasoned judgment
  call, not derived from field data — worth revisiting if real sessions show it's too
  eager or too sluggish to unstick.

**This round's additions:**
- ~~Whether photo3/photo4 field evidence indicates a code defect~~ — resolved: photo3 is
  Fix 1 working correctly; photo4 is a genuine missing-edge gap (`n_99`↔`n_136`), not a
  code defect, confirmed via two independent lines of evidence (external report +
  raw-GPX orphan-point check finding none).
- **New, still open:** the `n_99`↔`n_136`/`n_8` graph gap (§4 above). High-confidence
  diagnosis, deliberately **not** fixed — no already-collected survey data supports a
  specific edge geometry, and inventing one would repeat the exact mistake this whole
  investigation chain has been careful to avoid. Needs a dedicated ~50m GPS-logged walk
  between those two clusters, same discipline as the `cseitroad.kml` merge that was
  possible this round precisely because that survey data existed.
- F1's raw-survey-point underrepresentation near the *original* n_177/n_178/n_8 chokepoint
  (as opposed to the newly-found n_99 gap, a different location) — still genuinely open,
  still needs field verification, still not the same question as the n_99 gap above.
