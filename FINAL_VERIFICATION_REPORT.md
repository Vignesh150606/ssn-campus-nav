# FINAL_VERIFICATION_REPORT.md

Subject: Independent verification of `ssn-campus-navigator-fixed__4_.zip`'s implementation
addressing `PHOTO2_REROUTE_DIAGNOSIS.md`.

Verifier stance: Every claim below was independently re-derived by executing the actual
code, not accepted from the implementer's narration or my own prior report. Where my prior
report (`PHOTO2_REROUTE_DIAGNOSIS.md`) is contradicted by evidence, I say so plainly. No
code modified during this verification.

## Executive Summary

The implementer correctly diagnosed a real, previously-unaddressed defect and built a
field-verified, narrowly-scoped fix for the exact reported incident — that part is solid,
and I independently reproduced every load-bearing number in their account. But two things
stop this from being production-ready as shipped:

1. **The fix's own fallback path bypasses itself.** I found 34 concrete GPS positions (a
   real, walkable area immediately east of `n_137`) where the new cap is silently ignored
   and the code returns exactly the kind of unverified long connector the fix exists to
   block — at up to 32.3m, more than double the 15m cap. This isn't a hypothetical; it's
   the same code path, executed, producing the same defect class.

2. **The underlying mechanism is not fixed — six specific instances of it are.** A
   campus-wide sweep using the same methodology as `POST_FIX_INVESTIGATION_REPORT.md` §B2
   found the identical failure pattern (a long, unverified-looking connector winning
   purely on total Dijkstra cost) at 50 other nodes, across 31 of the 32 campus
   destinations, unrelated to this fix. The six hardcoded entries address the one location
   that happened to get field-tested. The pattern that produced them is still fully live
   everywhere else.

Classification: **C — Not Production Ready.** Not because the approach is wrong-headed
(see Strengths — the field-verified-cap concept is a defensible interim measure, not a
hack that should be thrown out), but because there's a confirmed, reproducible regression
in the shipped code itself, plus a now-quantified gap in scope.

## What was implemented

Diffed repo_v3 → repo_v4 byte-for-byte. Exactly one file changed in substance:
`backend/utils/router.py`.

```python
UNVERIFIED_CONNECTOR_CAP_M = {
    'n_136': 15.0, 'n_98': 15.0, 'n_128': 15.0,
    'n_116': 15.0, 'n_127': 15.0, 'n_137': 15.0,
}
```

and the shortlist filter now additionally requires
`c[0] <= UNVERIFIED_CONNECTOR_CAP_M.get(c[1], float('inf'))`.

## Independent verification of every important claim

| Claim | Verification performed | Result |
|---|---|---|
| Only `router.py` changed; no graph/frontend changes | Full byte-diff of both repos | ✅ Confirmed exactly |
| `validate_walkway_graph.py`/`route_quality_test.py` still pass | Re-ran both fresh | ✅ Confirmed |
| Field-confirmed position previously snapped to `n_136`, ~123m | Ran on repo_v3 (pre-fix) | ✅ Confirmed — 115.9m |
| Now snaps to `n_99`, matching Photo 1, at every accuracy | Ran on repo_v4 across 6 accuracy values | ✅ Confirmed exactly — 398.6m at every value |
| "6 of 7 shortlist candidates share the same profile" | Reconstructed shortlist independently | ✅ Confirmed exactly |
| `matchToPath` mechanism real but not the cause of this incident | Recomputed the clock-tower route, checked self-proximity | ✅ Confirmed |
| `n_8`/51.8m case unaffected | Confirmed absent from the cap table | ✅ Confirmed |

## Strengths

- Correctly diagnosed the true mechanism rather than accepting either the `matchToPath`
  hypothesis or the initial single-node attempt.
- Caught the initial `n_136`-only mistake before shipping it.
- Transparent, evidence-linked code comments.
- Every existing regression test re-run and passing.

## Weaknesses / Regression findings

**Finding 1 — Confirmed: the cap's own fallback bypasses the cap.** `_nearest_node`'s
existing fallback (`if best_id is None: return candidates[0]`) fires when the shortlist
ends up empty after filtering — and `candidates[0]` is the unfiltered nearest node, cap or
no cap. Grid-scanned the area around all 6 capped nodes and found 34 positions where this
fires. Worked example:

```
Position: (12.75169801107917, 80.19762395087547)
Candidate shortlist within margin: n_137 (32.3m, capped) and n_136 (57.1m, capped) —
  the nearest genuinely-uncapped candidate, n_8, is at 62.5m, just outside the
  30m margin window.
Shortlist after cap filtering: EMPTY.
Result: fallback returns n_137 anyway, at 32.3m — more than double its own 15m cap.
```

Confidence: High — reproduced directly against the shipped code.

**Finding 2 — Confirmed: the underlying mechanism remains live campus-wide.** Repeated
`POST_FIX_INVESTIGATION_REPORT.md` §B2's methodology campus-wide, excluding the now-capped
nodes: 611 grid points flagged, collapsing to 64 distinct (destination, node) pairs, 31 of
32 destinations affected, 50 distinct nodes showing the pattern. No field confirmation
that any of these 50 are actually fictional — that's the point: a per-node table can only
ever cover what's already been walked and reported.

Confidence: High on the count/pattern; Medium on how many of the 50 are true bugs vs.
legitimate long connectors.

## Hardcoded behaviour

`UNVERIFIED_CONNECTOR_CAP_M` is a literal, hardcoded, per-node-ID dictionary — justified as
an interim, honestly-scoped patch for what's actually been field-verified; not a durable
solution to the mechanism, and the code comments don't claim otherwise. It demonstrably
masks a deeper algorithmic issue (Finding 2).

## Remaining risks

- Finding 1's fallback bug can reproduce the pre-fix defect immediately adjacent to the
  fixed area.
- Any of the ~50 flagged nodes could produce the same symptom as Photo 2 the next time
  someone walks near one.
- `UNVERIFIED_CONNECTOR_CAP_M` will keep growing indefinitely under the current approach.

## Final Recommendation

**C — Not Production Ready.** What would move this to B or A, in order:

1. Fix Finding 1 first — small and localized (the fallback needs to prefer the best
   non-excluded candidate over the pool, not the absolute-nearest regardless of cap).
2. Decide, as a product/engineering call: is a per-node field-verified table an acceptable
   long-term strategy given Finding 2's scope, or does this warrant reopening the
   algorithmic question? Either answer is defensible; shipping without an explicit
   decision either way is the part to flag.
