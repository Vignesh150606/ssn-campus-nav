"""
Validates backend/data/walkway_graph.json against the requirements from the
graph-generation rebuild:
  - every destination is reachable from every other
  - no duplicate edges (same node pair twice)
  - no zero-length edges
  - no self loops
  - no duplicated/overlapping geometry between distinct edges
  - no obviously unnecessary detours (route distance vs straight-line ratio)
  - no duplicate node coordinates (two different node ids at the same spot)
  - no geometric edge crossings that aren't at a shared junction node
    (a crossing with no node there is either a survey/simplification
    artifact near a real junction, worth a human look, or — rarer — a
    genuinely missing connection; this check can't tell which, it just
    surfaces the candidates, see PRODUCTION_AUDIT_REPORT.md Part 1 for the
    two candidates found in the current graph and why neither was auto-fixed)

Run from backend/:  python3 scripts/validate_walkway_graph.py
Writes a machine-readable copy of everything below to
backend/data/validation_report.json (see Part 4 of the production audit).
"""
import json
import math
import os
import sys
from itertools import combinations

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'utils'))
sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))
sys.path.insert(0, BASE_DIR)

DATA_DIR = os.path.join(BASE_DIR, 'data')
GRAPH_PATH = os.path.join(DATA_DIR, 'walkway_graph.json')
LOCATIONS_PATH = os.path.join(DATA_DIR, 'locations.json')
REPORT_PATH = os.path.join(DATA_DIR, 'validation_report.json')

import router  # noqa: E402


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _to_xy(lat, lng, origin_lat):
    mlat = math.radians(origin_lat)
    return (lng * math.cos(mlat) * 111320.0, lat * 111320.0)


def _seg_intersect(p1, p2, p3, p4):
    """Proper-crossing test (excludes shared endpoints/collinear overlap)."""
    def sub(a, b): return (a[0] - b[0], a[1] - b[1])
    def cross(a, b): return a[0] * b[1] - a[1] * b[0]
    r, s = sub(p2, p1), sub(p4, p3)
    rxs = cross(r, s)
    if abs(rxs) < 1e-9:
        return None
    qp = sub(p3, p1)
    t, u = cross(qp, s) / rxs, cross(qp, r) / rxs
    if 1e-6 < t < 1 - 1e-6 and 1e-6 < u < 1 - 1e-6:
        return (p1[0] + t * r[0], p1[1] + t * r[1])
    return None


def find_crossing_edges(graph):
    """Edges whose path geometry crosses another edge's path geometry
    without sharing an endpoint node there. O(segments^2) — fine at this
    graph's size (a few hundred segments); would need a spatial index
    (e.g. an R-tree) well before this became a problem."""
    origin_lat = graph['nodes'][0]['lat']
    segs = []
    for ei, e in enumerate(graph['edges']):
        pts = [_to_xy(p['lat'], p['lng'], origin_lat) for p in e['path']]
        for si in range(len(pts) - 1):
            segs.append((ei, pts[si], pts[si + 1]))

    findings = []
    for i in range(len(segs)):
        ei, a1, a2 = segs[i]
        for j in range(i + 1, len(segs)):
            ej, b1, b2 = segs[j]
            if ei == ej:
                continue
            pt = _seg_intersect(a1, a2, b1, b2)
            if not pt:
                continue
            ea, eb = graph['edges'][ei], graph['edges'][ej]
            shares_node = len({ea['from'], ea['to']} & {eb['from'], eb['to']}) > 0
            # distance from the crossing point to the nearest real node —
            # small = likely a near-junction simplification artifact;
            # large = worth a closer look.
            best = min(
                math.hypot(_to_xy(n['lat'], n['lng'], origin_lat)[0] - pt[0], _to_xy(n['lat'], n['lng'], origin_lat)[1] - pt[1])
                for n in graph['nodes']
            )
            findings.append({
                "edge_a": [ea['from'], ea['to']], "edge_b": [eb['from'], eb['to']],
                "shares_a_node": shares_node, "nearest_node_distance_m": round(best, 1),
            })
    return findings


def find_duplicate_coordinates(graph):
    coord_map = {}
    for n in graph['nodes']:
        key = (round(n['lat'], 6), round(n['lng'], 6))
        coord_map.setdefault(key, []).append(n['id'])
    return {f"{k[0]},{k[1]}": v for k, v in coord_map.items() if len(v) > 1}


def main():
    graph = json.load(open(GRAPH_PATH))
    locations = json.load(open(LOCATIONS_PATH))
    loc_by_id = {loc['id']: loc for loc in locations}

    errors = []
    warnings = []
    report = {"generated_from": GRAPH_PATH}

    # --- structural checks -------------------------------------------------
    seen_pairs = set()
    dup_count = 0
    zero_len_count = 0
    self_loop_count = 0
    for e in graph['edges']:
        if e['from'] == e['to']:
            self_loop_count += 1
            errors.append(f"Self-loop edge at node {e['from']}")
        key = frozenset((e['from'], e['to']))
        if key in seen_pairs:
            dup_count += 1
            errors.append(f"Duplicate edge between {e['from']} and {e['to']}")
        seen_pairs.add(key)
        if e['distance_m'] < 0.3:
            zero_len_count += 1
            errors.append(f"Near-zero-length edge {e['from']}->{e['to']} ({e['distance_m']}m)")

    # Consecutive-duplicate points WITHIN an edge's path — distinct from
    # the "near-zero-length EDGE" check above, which only looks at the
    # edge's total distance_m and so completely misses a zero-length
    # segment buried inside an otherwise normal-length multi-point edge
    # (exactly how this shipped undetected before: a genuinely found bug,
    # not a hypothetical one — see dedupe_consecutive_points() in
    # build_walkway_graph.py for the full story and root cause). A
    # zero-length segment doesn't affect distance/reachability at all, but
    # it does produce an undefined bearing wherever anything computes a
    # turn angle across consecutive path points (frontend
    # utils/geo.js:computeUpcomingTurn) — that's what actually surfaces it,
    # as a live turn-by-turn instruction flipping unpredictably for a
    # metre or two of GPS noise right at that point.
    internal_dup_count = 0
    for e in graph['edges'] + graph['location_edges']:
        path = e['path']
        for i in range(len(path) - 1):
            if path[i]['lat'] == path[i + 1]['lat'] and path[i]['lng'] == path[i + 1]['lng']:
                internal_dup_count += 1
                errors.append(
                    f"Duplicate consecutive point inside edge {e['from']}->{e['to']} "
                    f"at index {i} ({path[i]['lat']}, {path[i]['lng']})"
                )

    print(f"Structural checks: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges, "
          f"{len(graph['location_edges'])} location_edges")
    print(f"  duplicate edges: {dup_count}")
    print(f"  zero-length edges: {zero_len_count}")
    print(f"  self loops: {self_loop_count}")
    print(f"  internal duplicate points (zero-length segments inside an edge): {internal_dup_count}")

    # --- duplicate coordinates (two different node ids at the same spot) ---
    dup_coords = find_duplicate_coordinates(graph)
    if dup_coords:
        for k, ids in dup_coords.items():
            errors.append(f"Duplicate coordinates at {k}: node ids {ids}")
    print(f"  duplicate node coordinates: {len(dup_coords)}")

    # --- geometric crossing edges (see find_crossing_edges docstring) ------
    crossings = find_crossing_edges(graph)
    # Only the "doesn't share a node" ones are flagged as warnings — see the
    # module docstring for why this is a warning to look at, not an auto-fix.
    unshared_crossings = [c for c in crossings if not c["shares_a_node"]]
    if unshared_crossings:
        warnings.append(f"{len(unshared_crossings)} edge-pair(s) cross geometrically without sharing a junction node (see PRODUCTION_AUDIT_REPORT.md Part 1)")
    print(f"  geometric crossings not at a shared node: {len(unshared_crossings)} "
          f"({len(crossings) - len(unshared_crossings)} more at a shared node, expected near any junction)")

    report["structural"] = {
        "nodes": len(graph['nodes']), "edges": len(graph['edges']), "location_edges": len(graph['location_edges']),
        "duplicate_edges": dup_count, "zero_length_edges": zero_len_count, "self_loops": self_loop_count,
        "internal_duplicate_points": internal_dup_count, "duplicate_coordinates": dup_coords,
        "geometric_crossings": crossings,
    }

    # node ids referenced by edges/location_edges must all exist
    node_ids = {n['id'] for n in graph['nodes']}
    for e in graph['edges']:
        for k in ('from', 'to'):
            if e[k] not in node_ids:
                errors.append(f"Edge references missing node id {e[k]}")
    for e in graph['location_edges']:
        if e['to'] not in node_ids:
            errors.append(f"location_edge references missing node id {e['to']}")
        if e['from'] not in loc_by_id:
            errors.append(f"location_edge references unknown location id {e['from']}")

    # every location must have at least one location_edge
    locs_with_edge = {e['from'] for e in graph['location_edges']}
    for loc in locations:
        if loc['id'] not in locs_with_edge:
            errors.append(f"Location '{loc['id']}' has no location_edge (unreachable)")

    # --- reachability + detour sanity check across all location pairs ------
    print(f"\nTesting all {len(locations) * (len(locations) - 1)} directed location pairs...")
    unreachable = []
    detour_flags = []
    n_ok = 0
    for a, b in combinations([loc['id'] for loc in locations], 2):
        try:
            result = router.find_route(a, b)
        except Exception as ex:
            unreachable.append((a, b, str(ex)))
            continue
        n_ok += 1
        straight = haversine(loc_by_id[a]['lat'], loc_by_id[a]['lng'], loc_by_id[b]['lat'], loc_by_id[b]['lng'])
        route_d = result['distance_m']
        if straight > 15 and route_d > straight * 3.0:
            detour_flags.append((a, b, round(straight, 1), route_d))

    print(f"  reachable pairs: {n_ok}/{len(locations) * (len(locations) - 1) // 2}")
    if unreachable:
        print(f"  UNREACHABLE pairs: {len(unreachable)}")
        for a, b, msg in unreachable[:20]:
            print(f"    {a} -> {b}: {msg}")
            errors.append(f"Unreachable: {a} -> {b}")
    else:
        print("  All location pairs reachable.")

    if detour_flags:
        print(f"\n  Routes with route/straight-line ratio > 3x ({len(detour_flags)}):")
        for a, b, straight, route_d in sorted(detour_flags, key=lambda t: -(t[3] / t[2]))[:20]:
            print(f"    {a:24s} -> {b:24s} straight={straight:7.1f}m  route={route_d:7.1f}m  ratio={route_d/straight:.2f}x")
        warnings.append(f"{len(detour_flags)} location pairs have route/straight-line ratio > 3x (see above)")

    report["reachability"] = {
        "total_pairs": len(locations) * (len(locations) - 1) // 2, "reachable": n_ok,
        "unreachable": [{"from": a, "to": b, "error": msg} for a, b, msg in unreachable],
        "detour_over_3x": [{"from": a, "to": b, "straight_m": s, "route_m": r} for a, b, s, r in detour_flags],
    }

    # --- geometry overlap sanity check (no two distinct edges sharing the
    #     same sub-segment, which would indicate leftover duplicate roads) --
    def seg_key(p, q, decimals=5):
        a = (round(p['lat'], decimals), round(p['lng'], decimals))
        b = (round(q['lat'], decimals), round(q['lng'], decimals))
        return frozenset((a, b))

    seg_owner = {}
    overlap_count = 0
    for e in graph['edges']:
        path = e['path']
        for i in range(len(path) - 1):
            k = seg_key(path[i], path[i + 1])
            owner = (e['from'], e['to'])
            if k in seg_owner and seg_owner[k] != owner and frozenset(seg_owner[k]) != frozenset(owner):
                overlap_count += 1
            else:
                seg_owner[k] = owner
    print(f"\nRepeated/overlapping micro-segments between distinct edges: {overlap_count}")
    if overlap_count:
        warnings.append(f"{overlap_count} repeated micro-segments across distinct edges")
    report["overlapping_micro_segments"] = overlap_count

    # --- summary -------------------------------------------------------------
    report["errors"] = errors
    report["warnings"] = warnings
    report["passed"] = len(errors) == 0
    with open(REPORT_PATH, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nWrote {REPORT_PATH}")

    print("\n" + "=" * 60)
    if errors:
        print(f"FAILED: {len(errors)} error(s)")
        for e in errors[:40]:
            print("  -", e)
    else:
        print("PASSED: no structural errors found")
    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings:
            print("  -", w)
    print("=" * 60)
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
