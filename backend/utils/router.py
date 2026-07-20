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


_graph_cache = None


def _load():
    # walkway_graph.json is build-time generated and never written to at
    # runtime (see backend/data_access.py's header comment: "the walkway
    # routing graph is never touched" by any admin action) -- unlike
    # road_segments.json below, so it's safe to cache in memory rather than
    # re-parsing ~45KB of JSON on every single /api/route call.
    #
    # road_segments.json is deliberately NOT cached here: it's a live
    # mirror of Supabase's road open/closed state (see main.py's admin
    # close/reopen endpoints -> data_access.set_segment_closed(), which
    # rewrites this file), and reading it fresh on every call is exactly
    # what makes an admin road closure take effect on the very next route
    # request rather than requiring a server restart. Caching it here
    # would silently break that.
    global _graph_cache
    if _graph_cache is None:
        _graph_cache = json.load(open(GRAPH_PATH))
    segs = json.load(open(SEG_PATH))
    return _graph_cache, segs


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
    Dijkstra runs from that node exactly as it always has, and a straight
    connector segment from the live GPS point to that node is prepended so
    the polyline starts where the user is actually standing. That connector
    is the one piece of a route response that isn't drawn from validated
    graph/location_edge geometry — everything beyond it comes from edges
    built from real surveyed GPX/KML data (see build_walkway_graph.py),
    which is what keeps the connector itself short and (in practice) clear
    of buildings: `_nearest_node`'s own sanity check below already
    discourages snapping to a farther candidate whose connector would be
    disproportionately long relative to the closest one. This never changes
    snap_id itself or anything Dijkstra returns — only how the live point is
    joined to it.

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

    # Connect the live GPS point to the route Dijkstra already chose with a
    # direct straight line to the snapped node. snap_id itself (which node
    # Dijkstra treats as the route start, and therefore the whole route
    # beyond this connector) is never touched by this — it only decides how
    # the last few metres from the user's live position to that unchanged
    # route are drawn. The walkway graph edges themselves are built from
    # real surveyed GPX/KML data and are not straight-line inventions, so
    # this connector is the only synthesized segment in the whole path.
    snap_node = next(n for n in graph['nodes'] if n['id'] == snap_id)
    full_path = [{'lat': lat, 'lng': lng}, {'lat': snap_node['lat'], 'lng': snap_node['lng']}] + full_path[1:]
    connector_dist = snap_dist

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
    }


def _path_length(pts):
    return sum(_point_dist(pts[i]['lat'], pts[i]['lng'], pts[i + 1]['lat'], pts[i + 1]['lng'])
               for i in range(len(pts) - 1))