# FIELD_TEST_INVESTIGATION_REPORT.md
**Subject:** Investigation of live field-test evidence (2026-07-25 campus walk, 5 screenshots) against `ssn-campus-navigator-fixed__2_.zip` (Fix 1 + Fix 2 already applied — see `ROOT_CAUSE_REPORT.md`, `POST_FIX_INVESTIGATION_REPORT.md`).
**Status:** Investigation only. No source files modified. Positions used below were provided by the field tester as approximate, unlogged estimates (no `rerouteDebug` capture was available) — every conclusion below states its confidence level accordingly.

---

## Handoff brief (read this first if you're the Claude implementing a fix)

**Do not touch `_nearest_node`'s snapping/accuracy logic for this issue** — it is not at fault here (proven in §2). The bug this round is a **graph connectivity gap**: node `n_99` (12.75223, 80.1973) is only ~49-58m in a straight line from the `n_136`/`n_8` cluster that photo 3 correctly used, but has **zero graph edges** toward it — its only edges go west to `n_128`/`n_98`/`n_2`. Any position that legitimately snaps to `n_99` (which is correctly identified as the nearest node — this isn't a snapping bug) is forced into a ~380-420m loop through the SSN Fountain/Clock Tower corridor instead of a short direct hop. **Before adding an edge to close this gap, get field confirmation that a real walkable path exists there** — same discipline as the KML task below; do not invent survey data. See §2c for the full trace and §6 for the specific recommendation.

Separately, this round also included a small, genuinely unrelated KML survey (`cseitroad.kml`) that should be merged into the graph — see `KML_MERGE_REPORT.md` for the complete, ready-to-apply merge plan (no new nodes needed, reuses `n_178` and `n_122`).

---

## 0. Evidence inventory and confidence levels

| Evidence | Source | Confidence |
|---|---|---|
| Repo (`ssn-campus-navigator-fixed__2_.zip`, Fix 1 + Fix 2 applied) | Reused from prior round, unchanged | High — verified intact |
| 5 screenshots, all destination "CSE Block", dated 2026-07-25 | Field tester | High (directly observed) |
| Photo 3 position: 12°45'08.0"N 80°11'49.0"E → (12.752222, 80.196944) | Field tester estimate, converted from DMS | Stated as approximate by tester |
| Photo 4 position: (12.752231825303204, 80.19717248210814) | Field tester estimate | Stated as approximate by tester |
| `rerouteDebug` / console log | **Not available** — confirmed by tester (not remote-debugging during the walk) | N/A |
| `cseitroad.kml` (new survey) | Field tester, described as unrelated to this bug | High (small, unambiguous) |

---

## 1. Screenshot summary (all 5, for the record)

| # | Time | Maneuver | Landmark | Remaining | ETA |
|---|---|---|---|---|---|
| 1 | 9:09 | Turn Left in 44m | Near CDC - Career Development Cell | 201m | 2.4min |
| 2 | 9:09 | Turn Left in 46m | Near IT Block | 129m | 1.5min |
| 3 | 9:10 | Bear Right in 46m | Near IT Block | 118m | 1.4min |
| 4 | 9:09 | Bear Left in 59m | Near SSN Fountain / Clock Tower | **313m** | 3.7min |
| 5 | 9:10 | Bear Right in 3m | (destination imminent) | 381m | 4.5min |

Note the non-monotonic remaining-distance sequence (201→129→118→**313**→381) — consistent with what `ROOT_CAUSE_REPORT.md` already flagged as a recurring pattern in this exact cluster (distance jumping up mid-walk, not just down as the user approaches). Photos 4 and 5 are the two large jumps; the tester specifically identified photo 3 and 4 as illustrating the recalculation-produces-a-bad-route phenomenon, so those two are the focus of reproduction below.

---

## 2. Reproduction attempt

### 2a. Photo 3 — reproduced with high confidence, and it's correct (not a bug)

Queried the live, unmodified `find_route_from_point(12.752222, 80.196944, 'cse-block', ...)`:

```
accuracy=10  -> snapped_to=n_8   distance_m=114.4
accuracy=15  -> snapped_to=n_8   distance_m=114.4
accuracy=20  -> snapped_to=n_8   distance_m=114.4
accuracy=30  -> snapped_to=n_8   distance_m=114.4
accuracy=50  -> snapped_to=n_8   distance_m=114.4
accuracy=None-> snapped_to=n_8   distance_m=114.4
```

Identical result at every accuracy value (not near any decision boundary), and **114.4m computed vs. 118m displayed in-app — a 3.6m / 3% difference**, easily within normal GPS/position-estimate tolerance. **This reroute is correct.** Photo 3 is not evidence of a bug; it's a clean confirmation the short, direct route via `n_8` works as intended from this position.

### 2b. Photo 4 — root mechanism identified with high confidence; exact magnitude not fully pinned down

Queried the same function at the given position (12.752231825303204, 80.19717248210814):

```
accuracy=10  -> snapped_to=n_99  distance_m=391.9
accuracy=15  -> snapped_to=n_99  distance_m=391.9
... (identical at every tested accuracy value, and at accuracy=None)
```

Again accuracy-independent — **`n_99` is the genuine, unambiguous closest node here** (confirmed: `best_id == closest_id` at this position, so Fix 1's accuracy-gated sanity check isn't even invoked — it has nothing to override). This is not a snapping-logic defect.

App displayed **313m**; direct computation gives **391.9m — a 79m (25%) gap.** Investigated two ways:

1. **Grid search** (±90m around the given point) for the nearest match to 313m converges toward a cluster of points 44-97m from the given estimate, all snapping to `n_128`/`n_111` (immediate neighbors of `n_99`, same western branch) — consistent with ordinary imprecision in a manually-recalled "approx" position, not a different mechanism. (For scale: this exact area was already established in the prior round to be sensitive to sub-15cm differences at its tightest chokepoint — a 44-97m spread from a hand-estimated position is unsurprising.)
2. **Independent cross-check against the banner's own landmark text**, which doesn't depend on the position estimate's precision at all: the maneuver card reads *"Near SSN Fountain / Clock Tower."* The actual location record for that landmark (`clock-tower`, display name **"SSN Fountain / Clock Tower"**) sits at (12.752737, 80.196337). Every reconstructed route from this whole area (`n_99`, `n_128`, `n_111` alike) passes directly through that same corridor before looping back east — **this matches the banner text exactly**, and doesn't depend on getting the exact GPS point right. This is strong independent corroboration that the *qualitative* reconstruction (a real detour through the SSN Fountain corridor) is correct, even though the *exact* magnitude isn't fully pinned down from a hand-estimated position alone.

### 2c. Root cause: `n_99` is close in space but disconnected in the graph

Direct measurements:
- `n_99` (12.75223, 80.1973) to `n_136` (12.751827, 80.197114): **49.1m** straight-line.
- `n_99` to `n_8` (12.751768, 80.197052): **58.0m** straight-line.
- `n_99`'s actual graph edges: `n_128` (61.8m), `n_98` (30.5m), `n_2` (73.1m) — **all westward. None toward `n_136`/`n_8`/`n_127`.**

Consequence: a position that legitimately snaps to `n_99` (correctly identified as nearest — confirmed, not a bug in `_nearest_node`) has no short path into the `n_136`/`n_8`/`n_177`/`n_178` corridor that photo 3 used just fine. It's forced ~380-420m west through the SSN Fountain/Clock Tower loop and back, instead of a ~50-100m direct hop the straight-line distance suggests should be possible.

Checked whether this route uses any synthetic/unverified segment (the class of defect Fix 1 addressed): **no** — every edge past the initial ~14m raw-GPS-to-`n_99` connector is a pre-existing graph edge (`n_99-n_128`, `n_128-n_75`, etc.), not a fabricated straight line. This is a **different class of defect** from the original CSE-Annexure shortcut bug: not "trusts an unverified long straight line," but "correctly uses only real edges, and the real edges available happen to force a long way around because a short connection is missing from the survey."

---

## 3. Classification

| Question | Answer | Evidence |
|---|---|---|
| Regression (Fix 1 or Fix 2 caused this)? | **No** | `n_99` is closest==best; the accuracy-gated check isn't invoked at all here. Sticky staleness is irrelevant on a first-ever reroute at a fresh position. |
| Incomplete previous fix? | **No** | Different mechanism entirely — Fix 1/Fix 2 target the snapping/stickiness layer; this is a graph-data gap they were never meant to address. |
| Graph limitation / missing survey data? | **Yes** | §2c — a physically-plausible ~50m connection has no corresponding edge. |
| GPS limitation? | Partially, for the *residual* 79m magnitude gap only | The qualitative mechanism (§2b point 2) is confirmed independent of GPS precision. |
| Snapping issue? | **No** | `n_99` is genuinely nearest; no override needed or possible. |
| Rerouting issue? | **No** | Not tested as a stickiness scenario — nothing suggests one is needed to explain this. |
| Frontend / rendering issue? | **Not implicated** | Not tested this round (no evidence pointed at it); previously exonerated in `ROOT_CAUSE_REPORT.md` §Q6 for the general class of "does rendering differ from backend geometry." |
| User error? | **No** | Photo 3's clean, accurate match from the same tester on the same walk rules out gross estimation/GPS error as a general explanation. |

---

## 4. What would close the residual uncertainty (optional — not blocking a decision)

If a repeat walk with remote debugging (`window.__rerouteLog()`) or even a rough phone GPX export becomes available for the exact photo-4 moment, it would pin the magnitude gap down precisely. More valuable than that, though: **field confirmation of whether a real, walkable path exists between the SSN-Fountain-side plaza and the IT/CSE corridor near this spot** — this is the input that actually decides the fix in §6, more than the exact distance figure does.

---

## 5. Relationship to prior rounds

`ROOT_CAUSE_REPORT.md` (accuracy-gate direction + sticky-entrenchment) and `POST_FIX_INVESTIGATION_REPORT.md` (Fix 1's incomplete `None`-accuracy gap, Fix 1's undetected campus-wide instability shift, the rejected oscillation hypothesis, the unrelated race condition) remain valid for the mechanisms they each describe — nothing this round contradicts them. This round's finding is **additive**: a third, structurally distinct defect class in the same general cluster. Worth flagging for whoever prioritizes future work: three rounds have now each found a different kind of problem in this one small area (synthetic-shortcut snapping → campus-wide instability shift → real-edges-but-disconnected topology gap). That pattern may be worth a wider one-time graph audit of this cluster rather than continuing to patch one field report at a time — noted as an observation, not a recommendation to act on now.

---

## 6. Recommended fixes — NOT IMPLEMENTED

1. **Primary:** if field-confirmed that a real path connects the `n_99` area (or wherever the true photo-4 position turns out to be) to the `n_136`/`n_8` corridor, add exactly that edge — reusing `n_99` and `n_136` (or `n_8`) as endpoints, no new nodes unless the true path genuinely bends partway, following the same "reuse existing nodes, don't regenerate, don't rename" discipline used for the KML merge below.
2. **Do not** attempt to address this by modifying `_nearest_node` — it is not misbehaving (§2c, §3). Doing so risks an undetected regression of the kind already found in `POST_FIX_INVESTIGATION_REPORT.md` §B2.
3. Add the per-location instability regression test recommended in that same report as a standing test — while unrelated to this specific finding, it's still outstanding and would help catch the *next* thing before it ships.
