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
import logging

logger = logging.getLogger("ssn-campus-nav.router")

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
        _validate_cap_table_against_graph(_graph_cache)
    segs = json.load(open(SEG_PATH))
    return _graph_cache, segs


def _validate_cap_table_against_graph(graph):
    """Item 10 — UNVERIFIED_CONNECTOR_CAP_M (below) hardcodes specific
    field-verified node IDs as safety exceptions. `_nearest_node` looks
    them up with `.get(node_id, float('inf'))`, which means a node ID that
    no longer exists in the graph silently stops being capped at all — no
    error, no warning, the safety guard just quietly disappears — if the
    graph is ever regenerated (build_walkway_graph.py) with different node
    IDs. Checked once per process, when the graph is first loaded, against
    whatever's actually on disk right now."""
    node_ids = {n['id'] for n in graph.get('nodes', [])}
    missing = sorted(nid for nid in UNVERIFIED_CONNECTOR_CAP_M if nid not in node_ids)
    if missing:
        logger.warning(
            "UNVERIFIED_CONNECTOR_CAP_M in utils/router.py references node ID(s) "
            "%s which do not exist in the currently-loaded walkway_graph.json. "
            "These field-verified safety caps are silently NOT being applied. "
            "If the graph was recently regenerated, re-verify (or re-derive) "
            "these entries against the new node IDs.",
            ", ".join(missing),
        )


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

# Field-verified exceptions to SNAP_MARGIN_M: specific nodes whose live-GPS "connector"
# segment has been directly confirmed, by walking there, to NOT correspond to real
# walkable ground beyond a short distance. A candidate is excluded from the shortlist if
# its snap distance exceeds ITS OWN cap here -- this is per-node and evidence-linked, not
# a general distance rule, and it does not touch SNAP_MARGIN_M or any other node's
# behaviour. In particular it does NOT affect the separately field-confirmed-legitimate
# 51.8m connector to n_8 from a different position in this same cluster (round 2 of this
# investigation) -- that's a different node, with no cap here, precisely because distance
# alone was already proven not to predict walkability (51.8m fine there, 43.9m not fine
# here). Add entries here ONLY from direct field confirmation, never from inference or
# graph-geometry alone -- see IMPLEMENTATION_PLAN.md for the specific investigation
# behind each entry.
#
# n_136: field-confirmed 2026-07-25 -- a live position ~43.9m north of n_136 (near
# 12.752222, 80.197111 / photo 2 of that round's field test) has no real path to n_136,
# and the field tester confirmed no alternate pedestrian shortcut exists from that area
# either -- the only real route from there is the long way via n_99 / the SSN Fountain
# corridor (photo 1 of the same round). 15m is a conservative cap: comfortably below the
# confirmed-fictional 43.9m, and in line with how short every other *real* connector onto
# this node actually is (n_136's real graph edges to n_8 and n_137 are 9.4m and 27.9m).
#
# n_98, n_128, n_116, n_127, n_137: same field test, same position, follow-up check.
# Excluding n_136 alone was NOT sufficient -- the router simply promoted the next
# margin-eligible candidate (n_127, 49.5m) to the winner, which shares the identical
# "long unverified connector in this same tightly-built cluster" profile as n_136 and had
# no more field support than n_136 originally did. The field tester's own statement is
# comprehensive, not node-specific: "the only practical route is the longer route shown in
# Photo 1" rules out every short-connector candidate from this position at once, not just
# whichever one the router happened to pick first. Capped at the same conservative 15m for
# the same reason. n_99 itself (the true closest node, reached via its own real, if long,
# graph edges -- matching Photo 1) is deliberately NOT in this table; it needs no cap
# because it was never in question.
UNVERIFIED_CONNECTOR_CAP_M = {
    'n_136': 15.0,
    'n_98': 15.0,
    'n_128': 15.0,
    'n_116': 15.0,
    'n_127': 15.0,
    'n_137': 15.0,
    # n_193, n_194: csepathway.kml merge. The KML edge between them (the
    # surveyed shortcut itself, n_193<->n_194) is field-verified ground
    # truth per the person who surveyed it — NOT capped, same as every
    # other real surveyed edge on this graph. What IS capped is each new
    # node's own connector back into the existing graph (n_193<->n_99,
    # 30.35m; n_194<->n_137, 23.7m) — those two segments are NOT part of
    # the surveyed KML, they're this merge's own straight-line best guess
    # at how the new path ties into the network, in the exact same
    # tightly-built n_99/n_136/n_137/n_98 cluster already flagged above as
    # having multiple unverified connectors that turned out not to be
    # real. Capping prevents a live GPS position from snapping onto n_193/
    # n_194 from far away and trusting an unverified connector segment it
    # has no real evidence for, without in any way affecting whether
    # Dijkstra can use the surveyed n_193<->n_194 edge once genuinely
    # reached — same scoping as every entry above.
    'n_193': 15.0,
    'n_194': 15.0,
}


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
    elsewhere in this codebase, not a new invented figure), is added to the
    margin `improvement` must clear over `extra_snap` for a non-closest
    candidate to be trusted at all — so a *worse* (larger) accuracy_m makes
    this check *more* conservative, requiring a bigger win before trusting
    a longer unverified segment, not less. (An earlier version of this
    check instead gated *whether* it ran at all behind `extra_snap >
    accuracy_m`, which had the opposite effect: a worse fix raised the bar
    for the check to engage in the first place, so poor accuracy made this
    protection weaker exactly when it mattered most. Root-caused,
    reproduced, and corrected — see IMPLEMENTATION_PLAN.md Fix 1.) Callers
    without an accuracy figure (e.g. the named from_id path) skip this
    check entirely, same as before.

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
    shortlist = [
        c for c in candidates[:NEAREST_NODE_CANDIDATES]
        if c[0] <= nearest_dist + SNAP_MARGIN_M
        and c[0] <= UNVERIFIED_CONNECTOR_CAP_M.get(c[1], float('inf'))
    ]

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
    #
    # Root-cause fix (confirmed + reproduced against the live graph — see
    # IMPLEMENTATION_PLAN.md Fix 1 / ROOT_CAUSE_REPORT.md Q5): the previous
    # version gated this check behind `extra_snap > accuracy_m`, which ran
    # backwards — a *worse* (larger) accuracy_m made `extra_snap` less
    # likely to exceed it, so the safety net triggered *less* often for
    # poor fixes. That's the opposite of what you want: a poor fix is
    # exactly when we're least sure where the user actually is, so an
    # unverified long straight-line "shortcut" segment deserves MORE
    # scrutiny, not less. Reproduced at the IT Block/CSE Annexure
    # chokepoint: any accuracy reading >= ~20m (ordinary near buildings)
    # disabled this check entirely under the old formula.
    #
    # Fix: accuracy_m is now added to the bar `improvement` must clear,
    # instead of gating whether the comparison runs at all. A worse fix
    # now requires the far candidate to win by *more* to be trusted, not
    # less — and the check still always compares the true winner against
    # the closest-by-distance node regardless of accuracy.
    if (accuracy_m is not None and best_id is not None and closest_id is not None
            and best_id != closest_id):
        extra_snap  = best_snap_dist - closest_snap_dist
        improvement = closest_total - best_total
        if improvement < extra_snap + accuracy_m:
            best_id, best_total, best_snap_dist = closest_id, closest_total, closest_snap_dist

    # Route-continuity stickiness — see docstring above for the follow-up
    # failure mode this addresses (candidate-set-membership instability
    # between two comparably-costed branches, distinct from the
    # closest-vs-best check just above). Only kicks in once we already have
    # a route in progress (prefer_node_id supplied) and only holds onto it
    # while it's still a genuinely nearby, reachable candidate — this is a
    # tie-breaker among close options, not a way to keep routing through a
    # node the user has actually walked away from.
    #
    # Bugfix (cap-bypass regression, found via direct reproduction against
    # this graph, not guessed): this branch re-checked SNAP_MARGIN_M but
    # never UNVERIFIED_CONNECTOR_CAP_M, so once a route had ever stuck to
    # one of the capped nodes (e.g. n_193 in the Gents Hostel / CSE
    # Annexure corridor), a later reroute could re-select it from up to
    # SNAP_MARGIN_M (30m) away even though that same node is only supposed
    # to be trusted from within its own, much shorter cap (15m) — silently
    # reintroducing the unverified-straight-line-shortcut risk the cap
    # exists to prevent. Reproduced directly: from a point 26.4m past the
    # csepathway.kml turn, a fresh (unprefered) lookup correctly rejects
    # n_193 and snaps to n_2 (284.0m total); with prefer_node_id='n_193' it
    # wrongly snapped back to n_193 (190.5m total) from that same point.
    # Fix: the preferred node must clear its own cap here too, exactly like
    # every other shortlist candidate above — a stale sticky preference can
    # no longer override a safety limit the ordinary path already enforces.
    if prefer_node_id is not None and best_id is not None and prefer_node_id != best_id:
        prefer_entry = next((c for c in candidates if c[1] == prefer_node_id), None)
        if (prefer_entry is not None and prefer_entry[0] <= nearest_dist + SNAP_MARGIN_M
                and prefer_entry[0] <= UNVERIFIED_CONNECTOR_CAP_M.get(prefer_node_id, float('inf'))):
            prefer_d = prefer_entry[0]
            prefer_dist, _ = _dijkstra(adj, prefer_node_id, to_id)
            prefer_route_dist = prefer_dist.get(to_id)
            if prefer_route_dist is not None:
                prefer_total = prefer_d + prefer_route_dist
                if best_total >= prefer_total - STICKY_MIN_MARGIN_M:
                    best_id, best_total, best_snap_dist = prefer_node_id, prefer_total, prefer_d

    if best_id is None:
        # None of the shortlisted candidates can reach to_id — fall back to
        # the plain closest node so we still return *something* usable; the
        # caller's own "no path" check further down will catch a truly
        # unreachable destination.
        #
        # Bugfix (round 6, field-verified regression): this used to return
        # candidates[0] unconditionally — the single closest node by raw
        # distance, straight from the UNFILTERED candidates list — which
        # bypasses UNVERIFIED_CONNECTOR_CAP_M entirely whenever the
        # shortlist ends up empty (which capping a node can itself cause,
        # if that node was also the closest-by-distance one: nearest_dist
        # stays anchored to its raw distance, so the SNAP_MARGIN_M window
        # built from it can end up excluding otherwise-good, uncapped
        # candidates too). Confirmed reproducible: at
        # (12.75169801107917, 80.19762395087547), n_137 — capped at 15m —
        # sits at 32.3m and was STILL being returned via this exact branch,
        # defeating the cap it exists to enforce. Fixed by applying the
        # same per-node cap check here that the main shortlist filter above
        # already uses, walking the full candidate list in distance order
        # and returning the first one that isn't cap-excluded.
        for d, node_id in candidates:
            if d <= UNVERIFIED_CONNECTOR_CAP_M.get(node_id, float('inf')):
                return node_id, d
        # Every single node on the whole graph is both cap-excluded and
        # farther than its own cap — cannot happen with the current
        # 6-entry table (it only ever excludes 6 of the graph's 193 nodes),
        # but if the table ever grew enough to reach this: returning
        # (None, None) is correct and safe here, not a new failure mode —
        # find_route_from_point already raises a clear "Walkway graph has
        # no nodes to snap to" error for exactly this return value, rather
        # than silently handing back a node the cap table says not to trust.
        return None, None

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