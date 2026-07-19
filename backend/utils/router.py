"""
Campus router — Dijkstra with:
1. Hostel gate road penalty (avoids hostel road for non-hostel destinations)
2. Admin road closures (segments marked closed are skipped, fallback to open graph)
3. Full waypoint path for live turn-by-turn guidance
"""
import json
import math
import heapq
import os

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRAPH_PATH  = os.path.join(BASE_DIR, 'data', 'walkway_graph.json')
SEG_PATH    = os.path.join(BASE_DIR, 'data', 'road_segments.json')

HOSTEL_DEST    = {'boys-hostel-gate', 'boys-hostel-office'}
HOSTEL_PENALTY = 8.0
CLOSURE_PENALTY = 999999.0  # effectively blocked but allows fallback
WALKING_MPS    = 1.4

# Mirrors CSE_ANNEXURE_OBSTACLE in backend/scripts/build_walkway_graph.py
# (same mirrored-constant pattern already used there for HOSTEL_BBOX, which
# mirrors road_segments.json's hostel zone). Duplicated rather than imported
# because router.py is imported directly by main.py at request time and
# must not depend on backend/scripts/ being on sys.path.
#
# This is used ONLY to keep the live-GPS -> snapped-node "connector" segment
# (the one piece of geometry in a route response that isn't drawn from
# validated graph/location_edges — see find_route_from_point) from being
# rendered straight through the building. It never touches which node
# Dijkstra treats as the route start, the graph, or any edge weight.
CSE_ANNEXURE_OBSTACLE = [
    (12.752056978358182, 80.19662242100897),
    (12.751880152753605, 80.19662490453447),
    (12.751887419561703, 80.1974121821163),
    (12.752061822893541, 80.19739728096334),
]

# Local tangent-plane origin for the obstacle check only -- consistent with
# build_walkway_graph.py's projection, but this is just a metres-accurate
# flat approximation for one small polygon, not anything shared with the
# graph itself.
_OBS_LAT0, _OBS_LNG0 = 12.7513, 80.1975
_OBS_M_LAT = 110540.0
_OBS_M_LNG = 111320.0 * math.cos(math.radians(_OBS_LAT0))


def _obs_xy(lat, lng):
    return ((lng - _OBS_LNG0) * _OBS_M_LNG, (lat - _OBS_LAT0) * _OBS_M_LAT)


def _point_in_obstacle_xy(pt, poly_xy):
    x, y = pt
    inside = False
    n = len(poly_xy)
    for i in range(n):
        x1, y1 = poly_xy[i]
        x2, y2 = poly_xy[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_at_y = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < x_at_y:
                inside = not inside
    return inside


def _segments_intersect_xy(p1, p2, q1, q2):
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    d1, d2 = cross(q1, q2, p1), cross(q1, q2, p2)
    d3, d4 = cross(p1, p2, q1), cross(p1, p2, q2)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def _connector_crosses_obstacle(lat1, lng1, lat2, lng2):
    """True if the straight line from (lat1,lng1) to (lat2,lng2) enters the
    CSE Annexure footprint. Used only for the raw-GPS connector segment."""
    poly_xy = [_obs_xy(lat, lng) for lat, lng in CSE_ANNEXURE_OBSTACLE]
    p1, p2 = _obs_xy(lat1, lng1), _obs_xy(lat2, lng2)
    if _point_in_obstacle_xy(p1, poly_xy) or _point_in_obstacle_xy(p2, poly_xy):
        return True
    n = len(poly_xy)
    for j in range(n):
        if _segments_intersect_xy(p1, p2, poly_xy[j], poly_xy[(j + 1) % n]):
            return True
    return False


def _nearest_visible_neighbor(adj, snap_id, nodes_by_id, lat, lng):
    """When the direct GPS -> snap_id connector is blocked by the obstacle,
    look for the closest node directly graph-connected to snap_id (a real,
    already-validated edge -- see backend/scripts/validate_walkway_graph.py's
    obstacle check, which confirms no edge anywhere crosses the footprint)
    whose own straight line from the GPS point is clear. This never touches
    Dijkstra or the route it already chose -- it only changes how the last
    few metres from the user's live position to that unchanged route are
    drawn. Only real graph nodes are considered (not destination ids), so
    the result can always be spliced onto the existing route using that
    edge's own real geometry, not an invented line.

    Returns (neighbor_node, path_neighbor_to_snap) or (None, None).
    """
    best = None  # (dist_from_gps, neighbor_node, path_snap_to_neighbor)
    for neighbor_id, _w, path_snap_to_neighbor in adj.get(snap_id, []):
        neighbor = nodes_by_id.get(neighbor_id)
        if neighbor is None:
            continue  # skip destination ids -- only real walkway nodes
        if _connector_crosses_obstacle(lat, lng, neighbor['lat'], neighbor['lng']):
            continue
        d = _point_dist(lat, lng, neighbor['lat'], neighbor['lng'])
        if best is None or d < best[0]:
            best = (d, neighbor, path_snap_to_neighbor)
    if best is None:
        return None, None
    _, neighbor, path_snap_to_neighbor = best
    return neighbor, list(reversed(path_snap_to_neighbor))


def _load():
    graph = json.load(open(GRAPH_PATH))
    segs  = json.load(open(SEG_PATH))
    return graph, segs


def _closed_bboxes(segs):
    return [s['bbox'] for s in segs if s.get('closed')]


def _in_bbox(lat, lng, bbox):
    return (bbox['lat_min'] <= lat <= bbox['lat_max'] and
            bbox['lng_min'] <= lng <= bbox['lng_max'])


def _build_adj(graph, segs, to_id):
    nodes         = {n['id']: n for n in graph['nodes']}
    closed_bboxes = _closed_bboxes(segs)
    going_to_hostel = to_id in HOSTEL_DEST

    adj = {}

    def add(a, b, w, path):
        adj.setdefault(a, []).append((b, w, path))
        adj.setdefault(b, []).append((a, w, list(reversed(path))))

    for e in graph['edges']:
        w    = e['distance_m']
        nf   = nodes.get(e['from'])
        nt   = nodes.get(e['to'])

        # Road closure penalty — very high weight but not completely blocked
        # so router can still find a path if no alternative exists
        if nf and nt and closed_bboxes:
            for bb in closed_bboxes:
                if _in_bbox(nf['lat'], nf['lng'], bb) and _in_bbox(nt['lat'], nt['lng'], bb):
                    w += CLOSURE_PENALTY
                    break

        # Hostel road penalty
        if e.get('hostel_only') and not going_to_hostel:
            w *= HOSTEL_PENALTY

        add(e['from'], e['to'], w, e['path'])

    for e in graph['location_edges']:
        add(e['from'], e['to'], e['distance_m'], e['path'])

    return adj


def _dijkstra(adj, from_id, to_id):
    dist = {from_id: 0.0}
    prev = {}
    pq   = [(0.0, from_id)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18):
            continue
        if u == to_id:
            break
        for v, w, _ in adj.get(u, []):
            nd = d + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    return dist, prev


def _stitch(adj, seq):
    full_path  = []
    real_dist  = 0.0
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i+1]
        for (nb, _, path_pts) in adj.get(a, []):
            if nb == b:
                pts = path_pts
                full_path.extend(pts if not full_path else pts[1:])
                real_dist += _path_length(pts)
                break
    return full_path, real_dist


NEAREST_NODE_CANDIDATES = 8  # how many closest-by-distance nodes to weigh by total route cost
SNAP_MARGIN_M = 30           # only weigh candidates within this many extra metres of the single closest node
STICKY_MIN_MARGIN_M = 20     # an alternative must beat the in-progress route's node by more than this to win


def _nearest_node(graph, lat, lng, adj=None, to_id=None, accuracy_m=None, prefer_node_id=None):
    """Nearest walkway node to an arbitrary GPS point.

    465 nodes on this campus graph, so a plain scan (no spatial index) is
    a sub-millisecond operation per call — fine for an on-demand reroute,
    no need to add a dependency (e.g. a k-d tree) for this graph size.

    If `adj` and `to_id` are supplied, this doesn't just take the single
    closest node by straight-line distance — among nodes within
    SNAP_MARGIN_M of that closest node (so still genuinely nearby — this is
    a tie-break between close options, not a search for a better node
    anywhere on campus), it picks whichever minimizes (snap
    distance + remaining Dijkstra distance from that node to to_id). A node
    a few metres closer to the user but *behind* their direction of travel
    costs more in total this way than a slightly-farther-but-still-nearby
    node that's actually ahead on the path, because routing through the
    "closer" one means walking back to it and then forward again. This is
    exactly the snap-behind-the-user case that caused the reported
    zig-zag/backtrack routes.

    Root cause of the CSE-Annexure-shortcut bug (proven against the real
    graph, not guessed — see the routing-bug investigation for the full
    trace): the "snap distance" `d` fed into that sum is a raw straight-line
    distance — it is never checked against anything walkable, it's simply
    rendered as a straight segment onto the returned path. That assumption
    is safe for the single closest node (by definition the *shortest*
    possible straight line onto the network, essentially always open
    ground). It stops being safe for a farther shortlisted candidate,
    because a longer straight line is far more likely to cross a building.
    Nodes that sit right next to a *destination* (its own location_edge
    connector, e.g. 'it-block' -> n_177, 27m) are the worst case: their
    route-to-destination is tiny by construction, so they win the
    total-cost comparison even when their own snap segment is 3-4x longer
    than the closest candidate's — i.e. even when reaching them at all
    requires walking through whatever's physically in the way. That's
    exactly how a single noisy-but-"accurate-enough" fix near IT Block/CSE
    Annexure (a classic multipath spot between two adjacent buildings) got
    shortlisted next to n_177/n_178 and won.

    Two things distinguish that failure from a legitimate win (also proven
    against the real graph): in the bug, the candidate's total-cost
    improvement over the closest-by-distance node (14.4m) was *smaller*
    than the extra straight-line distance needed to reach it (27.6m) — i.e.
    trusting that unverified segment cost more than it saved. Compare a
    genuine case elsewhere on this graph where the closest-by-distance node
    happens to sit on a dead-end branch: the alternative there saves 479m
    for only 22m of extra unverified distance — an overwhelming, clearly
    legitimate win. `accuracy_m`, when supplied (the GPS fix's own reported
    accuracy — already collected and already treated as authoritative
    elsewhere in this codebase, not a new invented figure), gates *when*
    this sanity check applies at all: for a candidate no farther than
    accuracy_m past the closest node, the extra distance is inside this
    fix's own measurement noise and isn't worth second-guessing; only a
    candidate confidently farther than that (by more than the fix's own
    uncertainty) has its total-cost win checked against what it actually
    cost to reach it. Callers without an accuracy figure (e.g. the named
    from_id path) get the previous, unchanged behaviour.

    Without `adj`/`to_id` (e.g. called for something other than routing
    toward a specific destination), falls back to plain nearest-by-distance.

    `prefer_node_id`, when supplied, is the node the *currently in-progress*
    route was already snapped to (see find_route_from_point's caller in
    LocationProvider.jsx — it remembers the last reroute's `snapped_to` and
    passes it back in on the next one). This addresses a second, distinct
    failure mode found via a follow-up bug report in this exact IT Block /
    CSE Annexure area, after the fix above: two node clusters (e.g. one
    reached via n_126, the other via n_47) can have comparable — but not
    identical — total cost to the same destination, on either side of a
    walkway that has no single obviously-closest entry point (the true
    nearest node, e.g. n_190 here, is itself a poor/long route and never
    wins; the real contest is between two *other* shortlisted candidates).
    Because SNAP_MARGIN_M shortlisting is a hard cutoff, a several-metre
    GPS-noise shift is enough for one of those candidates to fall in or out
    of range of "within SNAP_MARGIN_M of the closest node" — and the moment
    it does, the total-cost winner can flip by more than the position
    actually moved (measured against the real graph: n_126 vs n_47 swap for
    a ~12m total-cost gap on a ~5m position shift). The existing sanity
    check above doesn't catch this, because it only compares the single
    closest-by-distance node against the winner — here the closest-by-
    distance node (n_190) is neither the previous nor the new winner, it's
    a third candidate that loses to both. Root-cause fix: once a route is
    already committed to a node, don't hand it to a different one for a
    marginal win — require the alternative to beat it by more than
    STICKY_MIN_MARGIN_M (chosen with headroom above that ~12m observed
    swing). The preferred node still has to be a real, currently-nearby,
    reachable candidate (within SNAP_MARGIN_M of the closest node, same as
    every other candidate) — this is a tie-breaker among genuinely close
    options, not a way to keep routing through a node the user has since
    walked away from.

    Returns (node_id, distance_m) or (None, None) if the graph has no nodes.
    """
    candidates = []
    for n in graph['nodes']:
        d = _point_dist(lat, lng, n['lat'], n['lng'])
        candidates.append((d, n['id']))
    if not candidates:
        return None, None
    candidates.sort(key=lambda c: c[0])

    if adj is None or to_id is None:
        d, node_id = candidates[0]
        return node_id, d

    nearest_dist = candidates[0][0]
    shortlist = [c for c in candidates[:NEAREST_NODE_CANDIDATES] if c[0] <= nearest_dist + SNAP_MARGIN_M]

    best_id, best_total, best_snap_dist = None, None, None
    closest_id, closest_total, closest_snap_dist = None, None, None  # the single nearest-by-distance candidate, if reachable
    for d, node_id in shortlist:
        dist, _ = _dijkstra(adj, node_id, to_id)
        route_dist = dist.get(to_id)
        if route_dist is None:
            continue  # this candidate can't reach the destination at all
        total = d + route_dist
        if closest_id is None:  # shortlist is sorted by distance, so the first reachable one is the closest
            closest_id, closest_total, closest_snap_dist = node_id, total, d
        if best_total is None or total < best_total:
            best_id, best_total, best_snap_dist = node_id, total, d

    # Sanity-check a win that isn't the closest-by-distance candidate — see
    # docstring above for the worked examples this is derived from.
    if (accuracy_m is not None and best_id is not None and closest_id is not None
            and best_id != closest_id):
        extra_snap  = best_snap_dist - closest_snap_dist
        improvement = closest_total - best_total
        if extra_snap > accuracy_m and improvement < extra_snap:
            best_id, best_total, best_snap_dist = closest_id, closest_total, closest_snap_dist

    # Route-continuity stickiness — see docstring above for the follow-up
    # failure mode this addresses (candidate-set-membership instability
    # between two comparably-costed branches, distinct from the
    # closest-vs-best check just above). Only kicks in once we already have
    # a route in progress (prefer_node_id supplied) and only holds onto it
    # while it's still a genuinely nearby, reachable candidate — this is a
    # tie-breaker among close options, not a way to keep routing through a
    # node the user has actually walked away from.
    if prefer_node_id is not None and best_id is not None and prefer_node_id != best_id:
        prefer_entry = next((c for c in candidates if c[1] == prefer_node_id), None)
        if prefer_entry is not None and prefer_entry[0] <= nearest_dist + SNAP_MARGIN_M:
            prefer_d = prefer_entry[0]
            prefer_dist, _ = _dijkstra(adj, prefer_node_id, to_id)
            prefer_route_dist = prefer_dist.get(to_id)
            if prefer_route_dist is not None:
                prefer_total = prefer_d + prefer_route_dist
                if best_total >= prefer_total - STICKY_MIN_MARGIN_M:
                    best_id, best_total, best_snap_dist = prefer_node_id, prefer_total, prefer_d

    if best_id is None:
        # None of the nearby candidates can reach to_id — fall back to the
        # plain closest node so we still return *something* usable; the
        # caller's own "no path" check further down will catch a truly
        # unreachable destination.
        d, node_id = candidates[0]
        return node_id, d

    return best_id, best_snap_dist


def _point_dist(lat1, lng1, lat2, lng2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(a))


def find_route_from_point(lat: float, lng: float, to_id: str, accuracy_m: float = None,
                           prefer_node_id: str = None) -> dict:
    """Same as find_route(), but starts from an arbitrary GPS coordinate
    instead of a named location id — used for automatic reroute-on-deviation,
    where the user's live position is rarely exactly on a graph node.

    The user's exact coordinate is snapped to the nearest walkway node,
    Dijkstra runs from that node exactly as it always has, and a connector
    segment from the live GPS point to that node is prepended so the
    polyline starts where the user is actually standing. That connector is
    the one piece of a route response that isn't drawn from validated
    graph/location_edge geometry — see CSE_ANNEXURE_OBSTACLE above — so
    before it's added it's checked against that footprint: if the direct
    line would cross it, the connector routes via the nearest directly-
    connected node with a clear line of sight instead (using that edge's
    own real geometry), or is dropped entirely if none exists, per
    _nearest_visible_neighbor. This never changes snap_id itself or
    anything Dijkstra returns — only how the live point is joined to it.

    `accuracy_m`, when supplied, is the GPS fix's own reported accuracy —
    passed straight through to `_nearest_node`, where it gates a sanity
    check on the candidate tie-break: a shortlisted node confidently
    farther away than this fix's own measured uncertainty only wins if its
    total-cost improvement actually exceeds the extra unverified straight-
    line distance needed to reach it. See `_nearest_node`'s docstring for
    the full derivation and worked examples: without it, a single noisy-
    but-"accurate-enough" fix near a destination's own connector node can
    win the tie-break on paper while its snap segment silently cuts through
    whatever's physically in the way.

    `prefer_node_id`, when supplied, is the node the in-progress route was
    last snapped to (the caller's own previous `snapped_to`) — also passed
    straight through to `_nearest_node`, where it prevents a route from
    flipping between two comparably-costed branches on nothing more than a
    few metres of GPS noise. See `_nearest_node`'s docstring for the
    worked example (the IT Block / CSE Annexure area again — a follow-up
    report after the fix above).
    """
    graph, segs = _load()
    adj         = _build_adj(graph, segs, to_id)

    if to_id not in adj:
        raise ValueError(f"No road connection for '{to_id}'")

    snap_id, snap_dist = _nearest_node(graph, lat, lng, adj, to_id, accuracy_m, prefer_node_id)
    if snap_id is None:
        raise ValueError("Walkway graph has no nodes to snap to")

    dist, prev = _dijkstra(adj, snap_id, to_id)
    if to_id not in dist:
        raise ValueError(f"No path from current location to '{to_id}'")

    seq, cur = [], to_id
    while cur in prev:
        seq.append(cur)
        cur = prev[cur]
    seq.append(snap_id)
    seq.reverse()

    full_path, real_dist = _stitch(adj, seq)

    # Connect the live GPS point to the route Dijkstra already chose. The
    # direct straight line to the snapped node is the default -- unchanged
    # behaviour everywhere on campus except here -- and is only replaced
    # when that specific line would cross the CSE Annexure obstacle.
    # snap_id itself (which node Dijkstra treats as the route start, and
    # therefore the whole route beyond this connector) is never touched.
    snap_node = next(n for n in graph['nodes'] if n['id'] == snap_id)

    # connector_point_count: how many points at the FRONT of `full_path`
    # are synthetic (the straight-line-ish jump from the caller's raw GPS
    # coordinate onto the graph) rather than real, validated graph/
    # location_edge geometry. Exactly one of two values:
    #   1 — a synthetic point (the raw lat/lng itself) was prepended, in
    #       either of the two branches below.
    #   0 — nothing was prepended; full_path already starts exactly at
    #       snap_id's own real coordinates (the "no clear line of sight"
    #       fallback just below).
    # This is the one piece of information a caller needs to tell "the
    # user's live position, joined by an unverified straight line" apart
    # from "the route Dijkstra actually computed" -- e.g. to measure
    # distance-from-route using only validated geometry, without a stale
    # or long connector segment silently counting as "on the path". See
    # LocationProvider.jsx (frontend) for the consumer.
    connector_point_count = 0

    if not _connector_crosses_obstacle(lat, lng, snap_node['lat'], snap_node['lng']):
        full_path = [{'lat': lat, 'lng': lng}, {'lat': snap_node['lat'], 'lng': snap_node['lng']}] + full_path[1:]
        connector_dist = snap_dist
        connector_point_count = 1
    else:
        nodes_by_id = {n['id']: n for n in graph['nodes']}
        neighbor, path_neighbor_to_snap = _nearest_visible_neighbor(adj, snap_id, nodes_by_id, lat, lng)
        if neighbor is not None:
            # Splice: GPS -> neighbor (verified clear of the obstacle) ->
            # that edge's own real geometry (already proven obstacle-free
            # by validate_walkway_graph.py) -> snap_id -> rest of route.
            gps_to_neighbor = _point_dist(lat, lng, neighbor['lat'], neighbor['lng'])
            connector_dist  = gps_to_neighbor + _path_length(path_neighbor_to_snap)
            full_path = [{'lat': lat, 'lng': lng}] + path_neighbor_to_snap + full_path[1:]
            connector_point_count = 1
        else:
            # No nearby node has a clear line of sight either -- don't draw
            # an unverified connector at all. full_path already starts
            # exactly at snap_node (see _stitch), so this leaves it as-is.
            connector_dist = 0.0

    real_dist += connector_dist
    eta = round(real_dist / WALKING_MPS / 60, 1)

    segs_closed = [s['name'] for s in segs if s.get('closed')]
    warning = f"Note: {', '.join(segs_closed)} is closed. Using alternate route." if segs_closed else None

    return {
        'path':        full_path,
        'distance_m':  round(real_dist, 1),
        'eta_minutes': eta,
        'junctions':   [snap_id, to_id],
        'warning':     warning,
        'snapped_to':  snap_id,
        'snap_distance_m': round(connector_dist, 1),
        'connector_point_count': connector_point_count,
    }


def find_route(from_id: str, to_id: str) -> dict:
    graph, segs = _load()
    adj         = _build_adj(graph, segs, to_id)

    if from_id not in adj:
        raise ValueError(f"No road connection for '{from_id}'")
    if to_id not in adj:
        raise ValueError(f"No road connection for '{to_id}'")

    dist, prev = _dijkstra(adj, from_id, to_id)

    if to_id not in dist:
        raise ValueError(f"No path from '{from_id}' to '{to_id}'")

    # Reconstruct
    seq, cur = [], to_id
    while cur in prev:
        seq.append(cur)
        cur = prev[cur]
    seq.append(from_id)
    seq.reverse()

    full_path, real_dist = _stitch(adj, seq)
    eta = round(real_dist / WALKING_MPS / 60, 1)

    # Detect if route used a closed segment (warning for frontend)
    segs_closed = [s['name'] for s in segs if s.get('closed')]
    warning = f"Note: {', '.join(segs_closed)} is closed. Using alternate route." if segs_closed else None

    return {
        'path':        full_path,
        'distance_m':  round(real_dist, 1),
        'eta_minutes': eta,
        'junctions':   [from_id, to_id],
        'warning':     warning,
        # No synthetic GPS connector here -- from_id is a named location
        # whose own coordinates ARE the graph/location_edge start point.
        # See find_route_from_point's connector_point_count for why this
        # field exists.
        'connector_point_count': 0,
    }


def _path_length(pts):
    return sum(_point_dist(pts[i]['lat'], pts[i]['lng'], pts[i + 1]['lat'], pts[i + 1]['lng'])
               for i in range(len(pts) - 1))