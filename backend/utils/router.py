"""
Campus router — Dijkstra with:
1. Hostel gate road penalty (avoids hostel road for non-hostel destinations)
2. Admin road closures (segments marked closed are skipped, fallback to open graph)
3. Full waypoint path for live turn-by-turn guidance
"""
import json, math, heapq, os

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRAPH_PATH  = os.path.join(BASE_DIR, 'data', 'walkway_graph.json')
SEG_PATH    = os.path.join(BASE_DIR, 'data', 'road_segments.json')

HOSTEL_DEST    = {'boys-hostel-gate', 'boys-hostel-office'}
HOSTEL_PENALTY = 8.0
CLOSURE_PENALTY = 999999.0  # effectively blocked but allows fallback
WALKING_MPS    = 1.4


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


def _nearest_node(graph, lat, lng, adj=None, to_id=None):
    """Nearest walkway node to an arbitrary GPS point.

    465 nodes on this campus graph, so a plain scan (no spatial index) is
    a sub-millisecond operation per call — fine for an on-demand reroute,
    no need to add a dependency (e.g. a k-d tree) for this graph size.

    If `adj` and `to_id` are supplied, this doesn't just take the single
    closest node by straight-line distance — among nodes within
    SNAP_MARGIN_M of that closest node (so still genuinely nearby — this is
    a tie-break between close options, not a search for a better node
    anywhere on campus), it picks whichever minimizes (snap distance +
    remaining Dijkstra distance from that node to to_id). A node a few
    metres closer to the user but *behind* their direction of travel costs
    more in total this way than a slightly-farther-but-still-nearby node
    that's actually ahead on the path, because routing through the
    "closer" one means walking back to it and then forward again. This is
    exactly the snap-behind-the-user case that caused the reported
    zig-zag/backtrack routes. The margin cap matters: without it, a node
    much farther away can occasionally look cheaper purely because its
    graph distance to the destination happens to be marginally shorter,
    which would replace a small backtrack with a much worse, visually
    jarring long jump across campus — worth avoiding even though it
    technically minimizes total path length. Running a handful of extra
    Dijkstra passes over a graph this size is still sub-millisecond work,
    and this only runs on an on-demand reroute (already cooldown-limited
    on the frontend), not on every request.

    Without `adj`/`to_id` (e.g. called for something other than routing
    toward a specific destination), falls back to plain nearest-by-distance.

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
    for d, node_id in shortlist:
        dist, _ = _dijkstra(adj, node_id, to_id)
        route_dist = dist.get(to_id)
        if route_dist is None:
            continue  # this candidate can't reach the destination at all
        total = d + route_dist
        if best_total is None or total < best_total:
            best_id, best_total, best_snap_dist = node_id, total, d

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
    dp = math.radians(lat2 - lat1); dl = math.radians(lng2 - lng1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(a))


def find_route_from_point(lat: float, lng: float, to_id: str) -> dict:
    """Same as find_route(), but starts from an arbitrary GPS coordinate
    instead of a named location id — used for automatic reroute-on-deviation,
    where the user's live position is rarely exactly on a graph node.

    The user's exact coordinate is snapped to the nearest walkway node,
    Dijkstra runs from that node, and the snap segment (straight line from
    the live GPS point to the snapped node) is prepended to the returned
    path so the polyline starts exactly where the user is standing rather
    than a few metres off on the nearest path.
    """
    graph, segs = _load()
    adj         = _build_adj(graph, segs, to_id)

    if to_id not in adj:
        raise ValueError(f"No road connection for '{to_id}'")

    snap_id, snap_dist = _nearest_node(graph, lat, lng, adj, to_id)
    if snap_id is None:
        raise ValueError("Walkway graph has no nodes to snap to")

    dist, prev = _dijkstra(adj, snap_id, to_id)
    if to_id not in dist:
        raise ValueError(f"No path from current location to '{to_id}'")

    seq, cur = [], to_id
    while cur in prev:
        seq.append(cur); cur = prev[cur]
    seq.append(snap_id)
    seq.reverse()

    full_path, real_dist = _stitch(adj, seq)

    # Prepend the live GPS point -> snapped node segment.
    snap_node = next(n for n in graph['nodes'] if n['id'] == snap_id)
    full_path = [{'lat': lat, 'lng': lng}, {'lat': snap_node['lat'], 'lng': snap_node['lng']}] + full_path[1:]
    real_dist += snap_dist

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
        'snap_distance_m': round(snap_dist, 1),
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
        seq.append(cur); cur = prev[cur]
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
    def hav(lat1, lng1, lat2, lng2):
        R = 6371000
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dp = math.radians(lat2-lat1); dl = math.radians(lng2-lng1)
        a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
        return 2*R*math.asin(math.sqrt(a))
    return sum(hav(pts[i]['lat'], pts[i]['lng'], pts[i+1]['lat'], pts[i+1]['lng'])
               for i in range(len(pts)-1))