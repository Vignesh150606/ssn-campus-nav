"""
Python half of the routing parity test (see parity.mjs).

Runs backend/utils/router.py UNMODIFIED over a list of cases written by
parity.mjs and writes back compact, directly comparable digests.

    python3 py_router_runner.py <cases.json> <results.json>

Closure scenarios work by pointing router.SEG_PATH (read fresh by
router._load() on every call) at a temp file holding that scenario's
segments — no change to router.py is needed or made.
"""
import hashlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, '..', '..', 'backend'))
sys.path.insert(0, BACKEND)

from utils import router  # noqa: E402


def digest(r):
    path = r['path']
    sig = hashlib.sha1()
    for p in path:
        sig.update(f"{p['lat']:.9f},{p['lng']:.9f};".encode())
    return {
        'ok': True,
        'nodes': [p['id'] for p in path if p['id'] is not None],
        'n': len(path),
        'junc': ''.join('1' if p['junction'] else '0' for p in path),
        'sig': sig.hexdigest()[:16],
        'dist': r['distance_m'],
        'eta': r['eta_minutes'],
        'snap': r.get('snapped_to'),
        'snapd': r.get('snap_distance_m'),
        'warn': r['warning'],
        'jn': r['junctions'],
    }


def run_case(case):
    try:
        if case[1] == 'x':
            return {'ok': True, 'v': round(case[2], 1)}
        if case[1] == 'd':
            return {'ok': True, 'v': router._point_dist(case[2], case[3], case[4], case[5])}
        if case[1] == 'r':
            _, _, from_id, to_id = case
            return digest(router.find_route(from_id, to_id))
        _, _, lat, lng, to_id, acc, prefer = case
        return digest(router.find_route_from_point(lat, lng, to_id, accuracy_m=acc, prefer_node_id=prefer))
    except ValueError as e:
        return {'ok': False, 'err': str(e)}


def main():
    cases_path, out_path = sys.argv[1], sys.argv[2]
    payload = json.load(open(cases_path))
    scenarios = payload['scenarios']  # list of segment arrays, indexed by case[0]
    cases = payload['cases']

    results = [None] * len(cases)
    by_scenario = {}
    for i, c in enumerate(cases):
        by_scenario.setdefault(c[0], []).append(i)

    original_seg_path = router.SEG_PATH
    tmp_dir = tempfile.mkdtemp(prefix='parity_segs_')
    try:
        for sid, idxs in by_scenario.items():
            seg_file = os.path.join(tmp_dir, f'segs_{sid}.json')
            json.dump(scenarios[sid], open(seg_file, 'w'))
            router.SEG_PATH = seg_file
            for i in idxs:
                results[i] = run_case(cases[i])
    finally:
        router.SEG_PATH = original_seg_path

    meta = {
        'graph_path': os.path.realpath(router.GRAPH_PATH),
        'constants': {
            'HOSTEL_DEST': sorted(router.HOSTEL_DEST),
            'HOSTEL_PENALTY': router.HOSTEL_PENALTY,
            'CLOSURE_PENALTY': router.CLOSURE_PENALTY,
            'WALKING_MPS': router.WALKING_MPS,
            'NEAREST_NODE_CANDIDATES': router.NEAREST_NODE_CANDIDATES,
            'SNAP_MARGIN_M': router.SNAP_MARGIN_M,
            'STICKY_MIN_MARGIN_M': router.STICKY_MIN_MARGIN_M,
            'UNVERIFIED_CONNECTOR_CAP_M': router.UNVERIFIED_CONNECTOR_CAP_M,
        },
    }
    json.dump({'meta': meta, 'results': results}, open(out_path, 'w'))


if __name__ == '__main__':
    main()
