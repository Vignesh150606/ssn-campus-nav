# KML_MERGE_REPORT.md
**Subject:** Incremental merge plan for `cseitroad.kml` into `backend/data/walkway_graph.json`.
**Status:** Plan only — not applied. Follows the stated constraints: preserve the existing graph, do not regenerate, do not rename node IDs, do not remove edges, do not simplify, reuse existing nodes wherever possible, create new nodes only if absolutely necessary.
**Explicitly unrelated to** `FIELD_TEST_INVESTIGATION_REPORT.md`'s routing finding (different location, different cluster — see §4 below for the one point of geographic overlap worth noting for the record).

---

## 1. Source data

`cseitroad.kml` contains a single `LineString` with 2 coordinate points and the description "path not in map as of now":

| Point | Longitude | Latitude | (lat, lng) |
|---|---|---|---|
| A (north end) | 80.1970728 | 12.7513717 | (12.7513717, 80.1970728) |
| B (south end) | 80.1970702 | 12.7510447 | (12.7510447, 80.1970702) |

Surveyed length (endpoint-to-endpoint, haversine): **36.36m**. Nearly perfectly north-south (longitude changes by ~0.3m across the whole segment).

---

## 2. Endpoint matching against the existing graph

Checked both endpoints against every existing walkway node and location in `walkway_graph.json` / `locations.json`:

| KML point | Nearest existing node | Distance | Next nearest |
|---|---|---|---|
| A (12.7513717, 80.1970728) | **`n_178`** | **6.10m** | `n_177` at 12.44m |
| B (12.7510447, 80.1970702) | **`n_122`** | **4.39m** | `n_178` at 42.40m |

Both distances are well within normal GPS survey error for a short walked track (typically 3-8m for consumer GPS). **No new nodes are needed** — both endpoints should reuse existing nodes.

**Consistency check:** the direct graph-node-to-graph-node distance between `n_178` and `n_122` (haversine, using their existing recorded coordinates) is **43.09m**, close to the KML's own 36.36m surveyed length — the ~7m difference is consistent with the KML track not running in a perfectly straight line between the exact two node positions, not a sign of a mismatch.

---

## 3. Proposed merge (not applied)

**Reused nodes:** `n_178`, `n_122` — no changes to either.

**New nodes:** none.

**New edge:**
```json
{
  "from": "n_178",
  "to": "n_122",
  "distance_m": 36.36,
  "path": [
    {"lat": 12.751426, "lng": 80.197065},
    {"lat": 12.7513717, "lng": 80.1970728},
    {"lat": 12.7510447, "lng": 80.1970702},
    {"lat": 12.75104, "lng": 80.19703}
  ]
}
```
(First and last points snapped to `n_178`'s and `n_122`'s existing recorded coordinates respectively, per "reuse existing nodes"; the two interior points are the KML's own surveyed coordinates, preserving the actual surveyed shape rather than collapsing it to a straight line.)

**Conflicts:** none found. No existing edge already connects `n_178` and `n_122`; no existing edge occupies this path; `n_178`'s and `n_122`'s existing edges are untouched.

---

## 4. Effect on the graph (for the record — informational only)

This is worth noting even though it's a separate concern from `FIELD_TEST_INVESTIGATION_REPORT.md`'s finding: `n_122` currently reaches `cse-block` only via a **412.1m** route (through `n_47`/`n_138` and around). With this new edge, `n_122 → n_178 → cse-block` would be **~59.6m** (36.36 + 23.21). This also gives `cse-block` a second point of graph access, where `ROOT_CAUSE_REPORT.md` §Q1/§Q4 previously found it had exactly one (the `n_177`/`n_8` chokepoint). Whether this is the field tester's intent or an incidental side effect of where this particular path happens to run is not something I can determine from the KML alone — flagged for awareness, not treated as part of this merge's justification.

Note this is a **different** node (`n_122`) from the one implicated in the field-test finding (`n_99`) — they are two separate points roughly 130m+ apart (per `FIELD_TEST_INVESTIGATION_REPORT.md` §2c's `n_99`/`n_136` measurements and this report's §2 `n_122` measurements). This KML does not close the `n_99` gap.

---

## 5. Recommended validation after applying (not run — no changes made yet)

- Re-run `backend/scripts/validate_walkway_graph.py` — expect the same 2 pre-existing unrelated crossing warnings, no new ones (this edge doesn't geometrically cross anything based on its coordinates).
- Re-run `backend/scripts/route_quality_test.py` — expect continued 100% pass; `cse-block` reachability improves (shorter paths from the `n_122`/`n_47` side), no regressions expected since only an edge is being added, not removed or altered.
