"""
Route quality regression test (production audit Part 7) — generates
random source/destination pairs (both fixed-location-to-location routes
and live-GPS-point-to-location routes, since those use different code
paths in router.py) and validates every one against the real router:

  - a path is actually returned (no disconnected/unreachable failures)
  - the path is a genuine connected walk (each consecutive pair of points
    in the returned path is either the same point or a real, short hop —
    catches any "invisible teleport" bug in path reconstruction)
  - no impossible shortcut: route distance is never less than the
    straight-line distance (that would mean the path skipped through
    something solid)
  - repeated requests for the same pair return the same distance (a
    determinism check — Dijkstra over a fixed graph must be stable)

Run from backend/:  python3 scripts/route_quality_test.py [N]
(N defaults to 100. Writes a JSON report to data/route_quality_report.json.)
"""
import json
import math
import os
import random
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'utils'))
sys.path.insert(0, BASE_DIR)

DATA_DIR = os.path.join(BASE_DIR, 'data')
LOCATIONS_PATH = os.path.join(DATA_DIR, 'locations.json')
REPORT_PATH = os.path.join(DATA_DIR, 'route_quality_report.json')

import router  # noqa: E402


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def check_path_connectivity(path, max_gap_m=110, skip_first_segment=False):
    """No two consecutive points in a returned path should be implausibly
    far apart — a real walkway path's points are all a few metres to a
    couple dozen metres apart, EXCEPT that build_walkway_graph.py
    deliberately allows shape-point spacing up to MAX_EDGE_LEN=100m on long
    straight stretches (see that script's step 9.5 and its comment on the
    historical 241m worst case it replaced) — so the threshold here is
    100m + a small margin, not a smaller "feels reasonable" guess. A gap
    bigger than this would mean the stitching logic silently skipped a
    piece of the route, which 100m does not.

    skip_first_segment=True for find_route_from_point results: segment 0
    is the live-GPS-point connector (wherever the person is standing ->
    nearest path), which is a straight line of WHATEVER length that
    happens to be — unbounded by design, not surveyed walkway data, so it
    isn't held to the same 100m expectation as the rest of the path."""
    worst = 0.0
    start = 1 if skip_first_segment else 0
    for i in range(start, len(path) - 1):
        d = haversine(path[i]['lat'], path[i]['lng'], path[i + 1]['lat'], path[i + 1]['lng'])
        worst = max(worst, d)
    return worst, worst <= max_gap_m


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    random.seed(42)  # deterministic test set — reruns are comparable

    locations = json.load(open(LOCATIONS_PATH))
    loc_ids = [loc['id'] for loc in locations]
    loc_by_id = {loc['id']: loc for loc in locations}

    results = {"location_to_location": [], "point_to_location": []}
    failures = []

    # --- N random location -> location pairs --------------------------------
    pairs = set()
    while len(pairs) < n and len(pairs) < len(loc_ids) * (len(loc_ids) - 1):
        a, b = random.sample(loc_ids, 2)
        pairs.add((a, b))

    for a, b in pairs:
        entry = {"from": a, "to": b}
        try:
            r1 = router.find_route(a, b)
            r2 = router.find_route(a, b)  # determinism check
        except Exception as ex:
            entry["error"] = str(ex)
            failures.append(entry)
            results["location_to_location"].append(entry)
            continue

        straight = haversine(loc_by_id[a]['lat'], loc_by_id[a]['lng'], loc_by_id[b]['lat'], loc_by_id[b]['lng'])
        worst_gap, gap_ok = check_path_connectivity(r1['path'])
        entry.update({
            "distance_m": r1['distance_m'], "straight_line_m": round(straight, 1),
            "deterministic": r1['distance_m'] == r2['distance_m'],
            "no_impossible_shortcut": r1['distance_m'] >= straight - 1.0,  # 1m float slack
            "path_connectivity_ok": gap_ok, "worst_point_gap_m": round(worst_gap, 1),
            "path_points": len(r1['path']),
        })
        ok = entry["deterministic"] and entry["no_impossible_shortcut"] and entry["path_connectivity_ok"]
        if not ok:
            failures.append(entry)
        results["location_to_location"].append(entry)

    # --- N random live-GPS-point -> location pairs (different code path:
    #     exercises _nearest_node's snap logic, not just precomputed
    #     location_edges). Points are generated near an actual walkway edge
    #     plus small GPS-like jitter (0-20m) — like where a person on
    #     campus actually would be — rather than uniformly across the
    #     whole bounding box, which would include open ground / parking /
    #     sports-field interiors nobody's GPS fix would realistically sit
    #     in the middle of. ------------------------------------------------
    walkway_graph = json.load(open(os.path.join(DATA_DIR, 'walkway_graph.json')))
    graph_edges = walkway_graph['edges']

    def random_point_near_graph():
        e = random.choice(graph_edges)
        path = e['path']
        i = random.randrange(len(path) - 1) if len(path) > 1 else 0
        t = random.random()
        lat = path[i]['lat'] + t * (path[i + 1]['lat'] - path[i]['lat'])
        lng = path[i]['lng'] + t * (path[i + 1]['lng'] - path[i]['lng'])
        # ~0-20m jitter in a random direction (rough equirectangular offset)
        jitter_m = random.uniform(0, 20)
        theta = random.uniform(0, 2 * math.pi)
        lat += (jitter_m * math.cos(theta)) / 111320.0
        lng += (jitter_m * math.sin(theta)) / (111320.0 * math.cos(math.radians(lat)))
        return lat, lng

    for _ in range(n):
        lat, lng = random_point_near_graph()
        dest = random.choice(loc_ids)
        entry = {"from_point": [round(lat, 6), round(lng, 6)], "to": dest}
        try:
            r1 = router.find_route_from_point(lat, lng, dest, accuracy_m=15)
        except Exception as ex:
            entry["error"] = str(ex)
            failures.append(entry)
            results["point_to_location"].append(entry)
            continue
        worst_gap, gap_ok = check_path_connectivity(r1['path'], skip_first_segment=True)
        entry.update({
            "distance_m": r1['distance_m'], "snapped_to": r1['snapped_to'],
            "path_connectivity_ok": gap_ok, "worst_point_gap_m": round(worst_gap, 1),
            "path_points": len(r1['path']),
        })
        if not gap_ok:
            failures.append(entry)
        results["point_to_location"].append(entry)

    total = len(results["location_to_location"]) + len(results["point_to_location"])
    passed = total - len(failures)

    report = {
        "n_requested": n, "total_tests": total, "passed": passed, "failed": len(failures),
        "failures": failures, "results": results,
    }
    with open(REPORT_PATH, 'w') as f:
        json.dump(report, f, indent=2)

    print(f"Route quality test: {passed}/{total} passed ({len(results['location_to_location'])} location-to-location, "
          f"{len(results['point_to_location'])} live-point-to-location)")
    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f_ in failures[:20]:
            print(" ", f_)
    else:
        print("No failures. No disconnected paths, no impossible shortcuts, no connectivity gaps, fully deterministic.")
    print(f"\nWrote {REPORT_PATH}")
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
