"""
Walkway graph generation pipeline
==================================

Rebuilds backend/data/walkway_graph.json from the raw survey data instead of
treating every recorded GPS point as routing geometry.

Inputs  (backend/data/raw/):
    walkpathssn.gpx              - GPX track(s) actually walked on campus.
                                    Treated as ground truth for which roads
                                    exist, but NOT as clean geometry.
    google_maps_directions.kml   - Google Maps "Directions" KML export.
                                    Treated as clean road geometry, but not
                                    as proof that a road exists (a few of its
                                    routes run along public roads outside
                                    campus that we don't want as destinations,
                                    but we do want their geometry near campus).

Pipeline (see module docstrings on each step below for detail):
    1. Parse GPX tracks + KML LineStrings into raw point sequences ("ways").
    2. Per-way Ramer-Douglas-Peucker simplification (remove GPS noise).
    3. Snap GPX points onto nearby KML geometry (5-10m) to remove wobble
       while preserving the *existence* signal GPX provides.
    4. Cluster points that are close together but come from different
       recordings (different tracks/lines) into shared vertices. This is
       what collapses "I walked the same road twice" into one centreline,
       and what lets a KML route and a GPX walk of the same road merge.
    5. Build a raw multigraph from each way's point sequence.
    6. Fix sparse-sample skip-overs: split any edge whose straight segment
       passes very close to a *third* node it doesn't end at (this happens
       when a Google "Directions" polyline samples a long road with only a
       couple of points and silently skips a real junction in between).
    7. De-duplicate parallel edges between the same two nodes (prefer KML
       geometry; otherwise the shorter/cleaner of the duplicates) -> exactly
       one centreline per real road.
    8. Contract degree-2 "pass-through" nodes. A routing node should only
       exist at a junction, dead end, or destination connector -- not at
       every recorded sample point along a straight stretch of road.
    9. Final RDP pass per contracted edge (belt-and-braces noise removal).
   10. Snap every campus location onto its nearest network point, splitting
       an edge to create a new "destination connector" node where needed.
       No interior path geometry is invented for any location -- only this
       one connector segment.
   11. Tag edges inside the existing hostel-road bounding box as
       hostel_only, mirroring backend/data/road_segments.json's existing
       "Boys Hostel Gate Road" zone (keeps the router's hostel-avoidance
       behaviour for academic destinations unchanged).
   12. Assemble + write backend/data/walkway_graph.json in the same schema
       the existing router.py already consumes (no router changes needed).

Run:
    cd backend
    python3 scripts/build_walkway_graph.py

Then validate with scripts/validate_walkway_graph.py.
"""
import json
import math
import os
import xml.etree.ElementTree as ET
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")

GPX_PATH = os.path.join(RAW_DIR, "walkpathssn.gpx")
KML_PATH = os.path.join(RAW_DIR, "google_maps_directions.kml")
LOCATIONS_PATH = os.path.join(DATA_DIR, "locations.json")
OUT_PATH = os.path.join(DATA_DIR, "walkway_graph.json")

# ---------------------------------------------------------------------------
# Tunable parameters (all in meters unless noted)
# ---------------------------------------------------------------------------
SIMPLIFY_EPS = 2.0          # step 2: initial per-way RDP noise removal
SNAP_DIST = 8.0              # step 3: GPX -> KML snap threshold (spec: 5-10m)
CLUSTER_DIST = 6.0           # step 4: cross-way point clustering radius
MIN_SAME_WAY_GAP = 5         # step 4: index gap required for a same-way merge
SPLIT_DIST = 5.0             # step 6: node-on-edge detection tolerance
SPLIT_END_MARGIN = 3.0       # step 6: ignore hits this close to an existing endpoint
FINAL_SIMPLIFY_EPS = 1.5     # step 9: final per-edge RDP pass
NODE_SNAP_DIST = 3.0         # step 10: reuse an existing node within this distance
EDGE_END_MARGIN = 3.0        # step 10: snap to endpoint instead of splitting if this close

# Mirrors backend/data/road_segments.json's "seg_hostel_road" bounding box
# (Boys Hostel Gate Road) so the router's existing hostel-avoidance logic
# (HOSTEL_PENALTY in utils/router.py) keeps working unchanged.
HOSTEL_BBOX = {'lat_min': 12.7495, 'lat_max': 12.752, 'lng_min': 80.1985, 'lng_max': 80.2005}

# Step 12.5 -- CSE Annexure building obstacle. Surveyed corners, supplied
# directly (not derived from OSM tile imagery -- this app has no other
# building-footprint data anywhere). Any edge whose geometry enters this
# footprint is dropped after final graph assembly; see
# `filter_obstacle_edges` below. This is a single, targeted obstacle for one
# building, not a general obstacle framework -- do not generalize this into
# a multi-building system unless a real second case shows up.
CSE_ANNEXURE_OBSTACLE = [
    (12.752056978358182, 80.19662242100897),
    (12.751880152753605, 80.19662490453447),
    (12.751887419561703, 80.1974121821163),
    (12.752061822893541, 80.19739728096334),
]

# Local tangent-plane projection origin (campus center) -- all geometric
# operations (distance, projection, simplification, clustering) happen in
# this flat meters space, which is accurate enough for a ~1km-wide campus
# and far simpler than doing every operation in spherical coordinates.
LAT0, LNG0 = 12.7513, 80.1975
_COS_LAT0 = math.cos(math.radians(LAT0))
M_PER_DEG_LAT = 110540.0
M_PER_DEG_LNG = 111320.0 * _COS_LAT0


def to_xy(lat, lng):
    return ((lng - LNG0) * M_PER_DEG_LNG, (lat - LAT0) * M_PER_DEG_LAT)


def to_latlng(x, y):
    return (LAT0 + y / M_PER_DEG_LAT, LNG0 + x / M_PER_DEG_LNG)


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def path_length_xy(xy):
    return sum(math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]) for i in range(len(xy) - 1))


def path_length_latlng(path):
    return sum(haversine(path[i]['lat'], path[i]['lng'], path[i + 1]['lat'], path[i + 1]['lng'])
               for i in range(len(path) - 1))


# ---------------------------------------------------------------------------
# Obstacle geometry (used only by filter_obstacle_edges, step 12.5)
# ---------------------------------------------------------------------------
def _point_in_polygon_xy(pt, poly_xy):
    """Ray-casting point-in-polygon test, in local xy metres."""
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
    """Standard 2D segment-segment intersection test (proper crossing)."""
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    d1, d2 = cross(q1, q2, p1), cross(q1, q2, p2)
    d3, d4 = cross(p1, p2, q1), cross(p1, p2, q2)
    return (((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)))


def path_intersects_obstacle(path_latlng, obstacle_latlng):
    """True if any point of path_latlng lies inside obstacle_latlng, or any
    segment of the path crosses any edge of the obstacle polygon."""
    obstacle_xy = [to_xy(lat, lng) for lat, lng in obstacle_latlng]
    path_xy = [to_xy(p['lat'], p['lng']) for p in path_latlng]
    for pt in path_xy:
        if _point_in_polygon_xy(pt, obstacle_xy):
            return True
    n = len(obstacle_xy)
    for i in range(len(path_xy) - 1):
        for j in range(n):
            if _segments_intersect_xy(path_xy[i], path_xy[i + 1], obstacle_xy[j], obstacle_xy[(j + 1) % n]):
                return True
    return False


def filter_obstacle_edges(graph, obstacle_latlng=CSE_ANNEXURE_OBSTACLE, verbose=True):
    """Step 12.5 -- drop any graph['edges'] entry whose path geometry enters
    the given obstacle footprint. Nodes and all other edges are left exactly
    as assembled; no replacement edges are added, so a node that loses its
    only connection here would simply become unreachable via that edge (not
    silently rerouted) -- surfaced by validate_walkway_graph.py's
    reachability check, not papered over here.

    location_edges are checked too but never auto-removed: deleting a
    destination's only connector would make that destination unreachable,
    which is a worse regression than the shortcut this exists to fix. Any
    hit there is reported so it can be looked at directly instead.
    """
    def log(*a):
        if verbose:
            print(*a)

    kept, removed = [], []
    for e in graph['edges']:
        if path_intersects_obstacle(e['path'], obstacle_latlng):
            removed.append(e)
        else:
            kept.append(e)
    graph['edges'] = kept

    loc_hits = [e for e in graph['location_edges'] if path_intersects_obstacle(e['path'], obstacle_latlng)]

    log(f"[12.5] CSE Annexure obstacle filter: removed {len(removed)} edge(s) crossing the footprint")
    for e in removed:
        log(f"        removed edge {e['from']} -> {e['to']} ({e['distance_m']}m)")
    if loc_hits:
        log(f"        WARNING: {len(loc_hits)} location_edge(s) cross the footprint and were NOT removed "
            f"(would orphan a destination) -- needs manual review:")
        for e in loc_hits:
            log(f"        {e['from']} -> {e['to']}")

    return graph, removed, loc_hits


# ---------------------------------------------------------------------------
# Step 1 -- parsing
# ---------------------------------------------------------------------------
def parse_gpx_ways(path):
    """Survey data: roads that genuinely exist. NOT used directly as geometry."""
    ns = {'g': 'http://www.topografix.com/GPX/1/1'}
    root = ET.parse(path).getroot()
    ways = []
    for trk in root.findall('g:trk', ns):
        name_el = trk.find('g:name', ns)
        name = name_el.text if name_el is not None else None
        for seg in trk.findall('g:trkseg', ns):
            pts = [(float(p.get('lat')), float(p.get('lon'))) for p in seg.findall('g:trkpt', ns)]
            if len(pts) >= 2:
                ways.append({'source': 'gpx', 'name': name, 'points': pts})
    return ways


def parse_kml_ways(path):
    """Clean geometric guidance. NOT treated as proof a road exists."""
    ns = {'k': 'http://www.opengis.net/kml/2.2'}
    root = ET.parse(path).getroot()
    ways = []
    for pm in root.findall('.//k:Placemark', ns):
        line = pm.find('.//k:LineString', ns)
        if line is None:
            continue
        name_el = pm.find('k:name', ns)
        name = name_el.text if name_el is not None else None
        coords_el = line.find('k:coordinates', ns)
        if coords_el is None or not coords_el.text:
            continue
        pts = []
        for tok in coords_el.text.strip().split():
            lon_s, lat_s, *_rest = tok.split(',')
            pts.append((float(lat_s), float(lon_s)))
        if len(pts) >= 2:
            ways.append({'source': 'kml', 'name': name, 'points': pts})
    return ways


def load_ways():
    ways = []
    for w in parse_gpx_ways(GPX_PATH) + parse_kml_ways(KML_PATH):
        ways.append({'source': w['source'], 'name': w['name'],
                     'xy': [to_xy(lat, lng) for lat, lng in w['points']]})
    return ways


# ---------------------------------------------------------------------------
# Step 2 -- Ramer-Douglas-Peucker simplification
# ---------------------------------------------------------------------------
def rdp(points, epsilon):
    if len(points) < 3:
        return points[:]
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    seg_len2 = dx * dx + dy * dy
    max_dist, max_idx = -1.0, -1
    for i in range(1, len(points) - 1):
        px, py = points[i]
        if seg_len2 == 0:
            d = math.hypot(px - x1, py - y1)
        else:
            t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg_len2))
            d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
        if d > max_dist:
            max_dist, max_idx = d, i
    if max_dist > epsilon:
        left = rdp(points[:max_idx + 1], epsilon)
        right = rdp(points[max_idx:], epsilon)
        return left[:-1] + right
    return [points[0], points[-1]]


def simplify_ways(ways, eps=SIMPLIFY_EPS):
    for w in ways:
        w['xy'] = rdp(w['xy'], eps)
    return ways


# ---------------------------------------------------------------------------
# Geometry helpers: point-to-segment / point-to-polyline projection
# ---------------------------------------------------------------------------
def closest_point_on_segment(p, a, b):
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    seg_len2 = dx * dx + dy * dy
    if seg_len2 == 0:
        return a, math.hypot(px - ax, py - ay), 0.0
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg_len2))
    proj = (ax + t * dx, ay + t * dy)
    return proj, math.hypot(px - proj[0], py - proj[1]), t


def closest_point_on_polyline(p, poly):
    best = None
    for i in range(len(poly) - 1):
        proj, d, t = closest_point_on_segment(p, poly[i], poly[i + 1])
        if best is None or d < best[1]:
            best = (proj, d, i, t)
    return best


# ---------------------------------------------------------------------------
# Step 3 -- snap GPX points onto nearby KML geometry
# ---------------------------------------------------------------------------
def snap_gpx_to_kml(ways, snap_dist=SNAP_DIST):
    kml_ways = [w for w in ways if w['source'] == 'kml']
    n_snapped = 0
    for w in ways:
        if w['source'] != 'gpx':
            continue
        new_xy = []
        for p in w['xy']:
            best = None
            for kw in kml_ways:
                proj, d, _, _ = closest_point_on_polyline(p, kw['xy'])
                if best is None or d < best[1]:
                    best = (proj, d)
            if best is not None and best[1] <= snap_dist:
                new_xy.append(best[0])
                n_snapped += 1
            else:
                new_xy.append(p)
        w['xy'] = new_xy
    return n_snapped


# ---------------------------------------------------------------------------
# Step 4 -- cross-way point clustering
# ---------------------------------------------------------------------------
class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, a):
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def cluster_points(ways, cluster_dist=CLUSTER_DIST, min_same_way_gap=MIN_SAME_WAY_GAP):
    flat = [(wi, pi, x, y, w['source'])
            for wi, w in enumerate(ways) for pi, (x, y) in enumerate(w['xy'])]
    n = len(flat)
    uf = UnionFind(n)

    cell = cluster_dist
    grid = defaultdict(list)
    for idx, (wi, pi, x, y, src) in enumerate(flat):
        grid[(math.floor(x / cell), math.floor(y / cell))].append(idx)

    for idx, (wi, pi, x, y, src) in enumerate(flat):
        cx, cy = math.floor(x / cell), math.floor(y / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for jdx in grid.get((cx + dx, cy + dy), []):
                    if jdx <= idx:
                        continue
                    wj, pj, xj, yj, _ = flat[jdx]
                    if wi == wj and abs(pi - pj) < min_same_way_gap:
                        continue
                    if math.hypot(x - xj, y - yj) <= cluster_dist:
                        uf.union(idx, jdx)

    groups = defaultdict(list)
    for idx in range(n):
        groups[uf.find(idx)].append(idx)

    cluster_xy = {}
    for r, idxs in groups.items():
        kml_pts = [(flat[i][2], flat[i][3]) for i in idxs if flat[i][4] == 'kml']
        pts = kml_pts if kml_pts else [(flat[i][2], flat[i][3]) for i in idxs]
        cluster_xy[r] = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    point_cluster = {(wi, pi): uf.find(idx) for idx, (wi, pi, *_rest) in enumerate(flat)}

    # Refinement pass: two clusters can end up sitting right on top of each
    # other (e.g. a couple of metres apart) without ever merging above, if
    # every point that would have bridged them came from the *same* way
    # within min_same_way_gap of each other (intentionally excluded there to
    # avoid chaining merges down an entire corridor). Once points are
    # already aggregated into cluster centroids, merging any two centroids
    # that are still within a tight distance carries no chaining risk -- a
    # road's real waypoints are spaced much further apart than this after
    # RDP simplification, so this only catches genuine coincident junctions.
    point_cluster, cluster_xy = merge_close_cluster_centroids(point_cluster, cluster_xy)
    return point_cluster, cluster_xy


CLUSTER_MERGE_DIST = 2.5  # tight threshold for the centroid-merge refinement pass


def merge_close_cluster_centroids(point_cluster, cluster_xy, merge_dist=CLUSTER_MERGE_DIST):
    ids = list(cluster_xy.keys())
    idx_of = {cid: i for i, cid in enumerate(ids)}
    uf = UnionFind(len(ids))

    cell = merge_dist
    grid = defaultdict(list)
    for cid in ids:
        x, y = cluster_xy[cid]
        grid[(math.floor(x / cell), math.floor(y / cell))].append(cid)

    for cid in ids:
        x, y = cluster_xy[cid]
        cx, cy = math.floor(x / cell), math.floor(y / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ocid in grid.get((cx + dx, cy + dy), []):
                    if ocid <= cid:
                        continue
                    ox, oy = cluster_xy[ocid]
                    if math.hypot(x - ox, y - oy) <= merge_dist:
                        uf.union(idx_of[cid], idx_of[ocid])

    new_groups = defaultdict(list)
    for cid in ids:
        new_groups[ids[uf.find(idx_of[cid])]].append(cid)

    new_cluster_xy = {}
    remap = {}
    for rep, members in new_groups.items():
        xs = [cluster_xy[m][0] for m in members]
        ys = [cluster_xy[m][1] for m in members]
        new_cluster_xy[rep] = (sum(xs) / len(xs), sum(ys) / len(ys))
        for m in members:
            remap[m] = rep

    new_point_cluster = {key: remap[cid] for key, cid in point_cluster.items()}
    return new_point_cluster, new_cluster_xy


# ---------------------------------------------------------------------------
# Step 5 -- raw multigraph edges from each way's point sequence
# ---------------------------------------------------------------------------
def build_raw_edges(ways, point_cluster, cluster_xy):
    raw_edges = []
    for wi, w in enumerate(ways):
        seq = [(point_cluster[(wi, pi)], p) for pi, p in enumerate(w['xy'])]
        cur_cluster = seq[0][0]
        cur_geom = [cluster_xy[cur_cluster]]
        for cid, p in seq[1:]:
            if cid == cur_cluster:
                continue
            cur_geom.append(cluster_xy[cid])
            raw_edges.append({'u': cur_cluster, 'v': cid, 'xy': cur_geom, 'source': w['source']})
            cur_cluster = cid
            cur_geom = [cluster_xy[cur_cluster]]
    return raw_edges


# ---------------------------------------------------------------------------
# Step 6 -- split edges that pass close to a third node (sparse-sample fix)
# ---------------------------------------------------------------------------
def split_edges_through_nodes(raw_edges, cluster_xy, node_ids=None, split_dist=SPLIT_DIST, end_margin=SPLIT_END_MARGIN):
    all_node_ids = list(cluster_xy.keys()) if node_ids is None else list(node_ids)
    edges = list(raw_edges)
    changed, iterations = True, 0
    while changed and iterations < 6:
        changed = False
        iterations += 1
        new_edges = []
        for e in edges:
            xy = e['xy']
            hit = None
            for i in range(len(xy) - 1):
                a, b = xy[i], xy[i + 1]
                if math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6:
                    continue
                for cid in all_node_ids:
                    if cid == e['u'] or cid == e['v']:
                        continue
                    proj, d, _ = closest_point_on_segment(cluster_xy[cid], a, b)
                    if d > split_dist:
                        continue
                    d_to_u = math.hypot(proj[0] - xy[0][0], proj[1] - xy[0][1])
                    d_to_v = math.hypot(proj[0] - xy[-1][0], proj[1] - xy[-1][1])
                    if d_to_u <= end_margin or d_to_v <= end_margin:
                        continue
                    hit = (i, cid, proj)
                    break
                if hit:
                    break
            if hit is None:
                new_edges.append(e)
                continue
            i, cid, proj = hit
            changed = True
            new_edges.append({'u': e['u'], 'v': cid, 'xy': xy[:i + 1] + [cluster_xy[cid]], 'source': e['source']})
            new_edges.append({'u': cid, 'v': e['v'], 'xy': [cluster_xy[cid]] + xy[i + 1:], 'source': e['source']})
        edges = new_edges
    return edges


# ---------------------------------------------------------------------------
# Step 7 -- de-duplicate parallel edges -> one centreline per road
# ---------------------------------------------------------------------------
def dedupe_edges(edges):
    groups = defaultdict(list)
    for e in edges:
        if e['u'] != e['v']:
            groups[frozenset((e['u'], e['v']))].append(e)

    result = []
    for group in groups.values():
        kml_edges = [e for e in group if e['source'] == 'kml']
        pool = kml_edges if kml_edges else group
        # xy[0] == cluster_xy[u] and xy[-1] == cluster_xy[v] always holds by
        # construction (build_raw_edges / split_edges_through_nodes), so the
        # chosen edge can be used exactly as-is.
        result.append(min(pool, key=lambda e: path_length_xy(e['xy'])))
    return result


# ---------------------------------------------------------------------------
# Step 8 -- contract degree-2 pass-through nodes
# ---------------------------------------------------------------------------
def contract_degree2(edges, keep_ids=frozenset()):
    adj = defaultdict(dict)
    for e in edges:
        adj[e['u']][e['v']] = e
        adj[e['v']][e['u']] = e

    changed = True
    while changed:
        changed = False
        for n in list(adj.keys()):
            if n in keep_ids or len(adj[n]) != 2:
                continue
            (n1, e1), (n2, e2) = list(adj[n].items())
            if n1 == n2:
                continue  # pure loop back to the same neighbor -> leave as junction
            g1 = e1['xy'] if e1['v'] == n else list(reversed(e1['xy']))
            g2 = e2['xy'] if e2['u'] == n else list(reversed(e2['xy']))
            merged_xy = g1[:-1] + g2
            new_edge = {'u': n1, 'v': n2, 'xy': merged_xy,
                        'source': e1['source'] if e1['source'] == e2['source'] else 'mixed'}
            del adj[n1][n]
            del adj[n2][n]
            del adj[n]
            if n2 in adj[n1] and path_length_xy(new_edge['xy']) >= path_length_xy(adj[n1][n2]['xy']):
                changed = True
                break
            adj[n1][n2] = new_edge
            adj[n2][n1] = new_edge
            changed = True
            break
    seen, final = set(), []
    for n, nbrs in adj.items():
        for m, e in nbrs.items():
            key = frozenset((n, m))
            if key in seen:
                continue
            seen.add(key)
            final.append(e)
    return final


# ---------------------------------------------------------------------------
# Step 9 -- final per-edge RDP pass
# ---------------------------------------------------------------------------
def simplify_final_edges(edges, eps=FINAL_SIMPLIFY_EPS):
    return [{**e, 'xy': rdp(e['xy'], eps)} for e in edges]


# ---------------------------------------------------------------------------
# Step 9.5 -- bound maximum edge length (live GPS-tracking safeguard)
# ---------------------------------------------------------------------------
# utils/router.py's _nearest_node() snaps an arbitrary live GPS point to the
# nearest *graph node* (not the nearest point on an edge's path), and its
# SNAP_MARGIN_M=30 tie-break window assumes nodes a person could be near are
# generally within a few tens of metres of each other -- its own docstring
# cites "465 nodes on this campus graph" as that density assumption. With
# routing nodes now only at junctions/dead-ends/connectors, a handful of
# long straight stretches (the campus's perimeter/loop roads) collapse to a
# single edge 100-260m long with no intermediate node at all, so someone
# walking the middle of one of those roads would snap (and get a straight
# "you are here" jump-line) to a junction up to ~130m away -- reintroducing,
# from a different cause, exactly the jarring mis-snap that SNAP_MARGIN_M
# was added to prevent. We are not allowed to touch GPS tracking/router.py,
# so the fix has to live here: cap the *graph's* maximum edge length by
# inserting plain shape-point nodes along (only) the handful of edges that
# exceed it. This does not reintroduce "a node per GPX sample" -- it adds
# nodes only where an edge is still too long after every other cleaning
# step, spaced evenly along that edge's already-clean geometry (so it adds
# no wobble; a straight road stays perfectly straight, just with one or two
# more named points on it).
MAX_EDGE_LEN = 100.0  # the pre-rebuild graph itself had edges up to 241m (9.7% over 80m),
                       # and that density was apparently fine for live tracking already -- this
                       # cap meaningfully improves the worst case (263m -> 100m) without adding
                       # far more nodes than the previous graph had for no real benefit

def subdivide_long_edges(edges, cluster_xy, max_len=MAX_EDGE_LEN):
    cluster_xy = dict(cluster_xy)
    next_id = (max(cluster_xy.keys()) + 1) if cluster_xy else 0
    out_edges = []
    for e in edges:
        xy = e['xy']
        if path_length_xy(xy) <= max_len:
            out_edges.append(e)
            continue
        ids = [None] * len(xy)
        ids[0], ids[-1] = e['u'], e['v']
        for i in range(1, len(xy) - 1):
            cluster_xy[next_id] = xy[i]
            ids[i] = next_id
            next_id += 1
        for i in range(len(xy) - 1):
            a, b = xy[i], xy[i + 1]
            seg_len = math.hypot(b[0] - a[0], b[1] - a[1])
            if seg_len <= max_len:
                out_edges.append({'u': ids[i], 'v': ids[i + 1], 'xy': [a, b], 'source': e['source']})
                continue
            k = math.ceil(seg_len / max_len)
            prev_id, prev_pt = ids[i], a
            for j in range(1, k):
                t = j / k
                pt = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
                cluster_xy[next_id] = pt
                out_edges.append({'u': prev_id, 'v': next_id, 'xy': [prev_pt, pt], 'source': e['source']})
                prev_id, prev_pt, next_id = next_id, pt, next_id + 1
            out_edges.append({'u': prev_id, 'v': ids[i + 1], 'xy': [prev_pt, b], 'source': e['source']})
    return out_edges, cluster_xy


# ---------------------------------------------------------------------------
# Step 10 -- location connectors (snap-or-split, no invented interior paths)
# ---------------------------------------------------------------------------
def add_location_connectors(edges, cluster_xy, locations,
                             node_snap_dist=NODE_SNAP_DIST, edge_end_margin=EDGE_END_MARGIN):
    edges = list(edges)
    cluster_xy = dict(cluster_xy)
    live_node_ids = {n for e in edges for n in (e['u'], e['v'])}
    next_id = (max(cluster_xy.keys()) + 1) if cluster_xy else 0
    connectors = []

    for loc in locations:
        p = to_xy(loc['lat'], loc['lng'])

        best_node, best_node_d = None, None
        for cid in live_node_ids:
            xy = cluster_xy[cid]
            d = math.hypot(p[0] - xy[0], p[1] - xy[1])
            if best_node_d is None or d < best_node_d:
                best_node, best_node_d = cid, d

        best_edge, best_edge_d, best_edge_i, best_edge_proj = None, None, None, None
        for e in edges:
            proj, d, seg_i, _ = closest_point_on_polyline(p, e['xy'])
            if best_edge_d is None or d < best_edge_d:
                best_edge, best_edge_d, best_edge_i, best_edge_proj = e, d, seg_i, proj

        if best_edge is None or best_node_d <= node_snap_dist:
            use_node, snap_xy, snap_d = best_node, cluster_xy[best_node], best_node_d
        else:
            d_to_u = math.hypot(best_edge_proj[0] - best_edge['xy'][0][0], best_edge_proj[1] - best_edge['xy'][0][1])
            d_to_v = math.hypot(best_edge_proj[0] - best_edge['xy'][-1][0], best_edge_proj[1] - best_edge['xy'][-1][1])
            if d_to_u <= edge_end_margin:
                use_node = best_edge['u']
                snap_xy, snap_d = cluster_xy[use_node], math.hypot(p[0] - cluster_xy[use_node][0], p[1] - cluster_xy[use_node][1])
            elif d_to_v <= edge_end_margin:
                use_node = best_edge['v']
                snap_xy, snap_d = cluster_xy[use_node], math.hypot(p[0] - cluster_xy[use_node][0], p[1] - cluster_xy[use_node][1])
            elif best_edge_d < best_node_d:
                new_id = next_id
                next_id += 1
                cluster_xy[new_id] = best_edge_proj
                live_node_ids.add(new_id)
                xy, i = best_edge['xy'], best_edge_i
                edges.remove(best_edge)
                edges.append({'u': best_edge['u'], 'v': new_id, 'xy': xy[:i + 1] + [best_edge_proj], 'source': best_edge['source']})
                edges.append({'u': new_id, 'v': best_edge['v'], 'xy': [best_edge_proj] + xy[i + 1:], 'source': best_edge['source']})
                use_node, snap_xy, snap_d = new_id, best_edge_proj, best_edge_d
            else:
                use_node, snap_xy, snap_d = best_node, cluster_xy[best_node], best_node_d

        connectors.append({'location_id': loc['id'], 'node_id': use_node,
                            'loc_xy': p, 'snap_xy': snap_xy, 'dist': snap_d})

    return edges, cluster_xy, connectors


# ---------------------------------------------------------------------------
# Step 11 -- hostel tagging + step 12 final assembly
# ---------------------------------------------------------------------------
def in_hostel_bbox(lat, lng):
    b = HOSTEL_BBOX
    return b['lat_min'] <= lat <= b['lat_max'] and b['lng_min'] <= lng <= b['lng_max']


def assemble_graph(edges, cluster_xy, connectors):
    # Only keep nodes actually referenced by an edge (no orphaned raw points).
    used_ids = set()
    for e in edges:
        used_ids.add(e['u'])
        used_ids.add(e['v'])
    ids_sorted = sorted(used_ids)
    id_map = {cid: f"n_{i}" for i, cid in enumerate(ids_sorted)}

    nodes = []
    for cid in ids_sorted:
        lat, lng = to_latlng(*cluster_xy[cid])
        nodes.append({'id': id_map[cid], 'lat': round(lat, 6), 'lng': round(lng, 6)})

    out_edges = []
    for e in edges:
        path = [{'lat': round(lat, 6), 'lng': round(lng, 6)} for lat, lng in (to_latlng(*pt) for pt in e['xy'])]
        edge_obj = {'from': id_map[e['u']], 'to': id_map[e['v']],
                    'distance_m': round(path_length_latlng(path), 2), 'path': path}
        if in_hostel_bbox(path[0]['lat'], path[0]['lng']) and in_hostel_bbox(path[-1]['lat'], path[-1]['lng']):
            edge_obj['hostel_only'] = True
        out_edges.append(edge_obj)

    out_location_edges = []
    for c in connectors:
        loc_lat, loc_lng = to_latlng(*c['loc_xy'])
        snap_lat, snap_lng = to_latlng(*c['snap_xy'])
        path = [{'lat': round(loc_lat, 6), 'lng': round(loc_lng, 6)},
                {'lat': round(snap_lat, 6), 'lng': round(snap_lng, 6)}]
        out_location_edges.append({'from': c['location_id'], 'to': id_map[c['node_id']],
                                    'distance_m': round(path_length_latlng(path), 2), 'path': path})

    return {'nodes': nodes, 'edges': out_edges, 'location_edges': out_location_edges}


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------
def build(verbose=True):
    def log(*a):
        if verbose:
            print(*a)

    ways = load_ways()
    log(f"[1] Loaded ways: {len(ways)} ({sum(len(w['xy']) for w in ways)} raw points)")

    simplify_ways(ways)
    log(f"[2] After per-way RDP simplify: {sum(len(w['xy']) for w in ways)} points")

    n_snapped = snap_gpx_to_kml(ways)
    log(f"[3] Snapped {n_snapped} GPX points onto KML geometry")

    point_cluster, cluster_xy = cluster_points(ways)
    log(f"[4] Clustered into {len(cluster_xy)} unique vertices")

    raw_edges = build_raw_edges(ways, point_cluster, cluster_xy)
    log(f"[5] Raw multigraph edges: {len(raw_edges)}")

    split_edges = split_edges_through_nodes(raw_edges, cluster_xy)
    log(f"[6] After skip-over correction: {len(split_edges)} edges")

    deduped = dedupe_edges(split_edges)
    log(f"[7] After de-duplication (one centreline per road): {len(deduped)} edges")

    contracted = contract_degree2(deduped)
    contracted_nodes = {n for e in contracted for n in (e['u'], e['v'])}
    log(f"[8] After degree-2 contraction: {len(contracted_nodes)} nodes, {len(contracted)} edges")

    # Belt-and-braces: merging edges through a contracted node can produce a
    # new long edge that happens to pass close to a *different* surviving
    # node without ending there (the skip-over check in step 6 only ever
    # saw the pre-contraction pieces). Re-run the split+dedupe+contract
    # cycle against the current node set until it stops changing anything.
    for i in range(3):
        node_ids_now = {n for e in contracted for n in (e['u'], e['v'])}
        re_split = split_edges_through_nodes(contracted, cluster_xy, node_ids=node_ids_now)
        if len(re_split) == len(contracted):
            break
        contracted = contract_degree2(dedupe_edges(re_split))
        contracted_nodes = {n for e in contracted for n in (e['u'], e['v'])}
        log(f"[8.{i+1}] Post-contraction skip-over fix: {len(contracted_nodes)} nodes, {len(contracted)} edges")

    simplified = simplify_final_edges(contracted)

    bounded_edges, bounded_cluster_xy = subdivide_long_edges(simplified, cluster_xy)
    n_shape_nodes = len(bounded_cluster_xy) - len(cluster_xy)
    log(f"[9.5] Bounded max edge length to {MAX_EDGE_LEN:.0f}m: +{n_shape_nodes} shape nodes, "
        f"{len(simplified)} -> {len(bounded_edges)} edges")

    locations = json.load(open(LOCATIONS_PATH, encoding='utf-8'))
    final_edges, final_cluster_xy, connectors = add_location_connectors(bounded_edges, bounded_cluster_xy, locations)
    log(f"[10] Added {len(connectors)} location connectors -> {len(final_edges)} edges total")

    graph = assemble_graph(final_edges, final_cluster_xy, connectors)
    hostel_count = sum(1 for e in graph['edges'] if e.get('hostel_only'))
    log(f"[11] Tagged {hostel_count} hostel-internal edges")
    log(f"[12] Final graph: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges, "
        f"{len(graph['location_edges'])} location_edges")

    graph, obstacle_removed, obstacle_loc_hits = filter_obstacle_edges(graph, verbose=verbose)

    return graph


if __name__ == '__main__':
    graph = build()
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(graph, f, indent=2)
        f.write('\n')
    print(f"\nWrote {OUT_PATH}")
