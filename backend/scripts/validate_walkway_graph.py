"""
Validates backend/data/walkway_graph.json against the requirements from the
graph-generation rebuild:
  - every destination is reachable from every other
  - no duplicate edges (same node pair twice)
  - no zero-length edges
  - no self loops
  - no duplicated/overlapping geometry between distinct edges
  - no obviously unnecessary detours (route distance vs straight-line ratio)

Run from backend/:  python3 scripts/validate_walkway_graph.py
"""
import json
import math
import os
import sys
from itertools import combinations

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'utils'))
sys.path.insert(0, BASE_DIR)

DATA_DIR = os.path.join(BASE_DIR, 'data')
GRAPH_PATH = os.path.join(DATA_DIR, 'walkway_graph.json')
LOCATIONS_PATH = os.path.join(DATA_DIR, 'locations.json')

import router  # noqa: E402


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    graph = json.load(open(GRAPH_PATH))
    locations = json.load(open(LOCATIONS_PATH))
    loc_by_id = {loc['id']: loc for loc in locations}

    errors = []
    warnings = []

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

    print(f"Structural checks: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges, "
          f"{len(graph['location_edges'])} location_edges")
    print(f"  duplicate edges: {dup_count}")
    print(f"  zero-length edges: {zero_len_count}")
    print(f"  self loops: {self_loop_count}")

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

    # --- summary -------------------------------------------------------------
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
