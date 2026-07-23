"""
Dev Tools — backend for the Super-Admin-only debugging panel (production
audit: Graph Viewer, Snap Debug, Route Inspector, Graph Statistics, Export
Graph). Live GPS Debug and Route Replay are frontend-only (no backend
needed — they just read the browser's own Geolocation API / replay a
pasted trace on a map) and aren't in this file.

REMOVAL: this feature is deliberately isolated to make it trivial to pull
out later if you don't want it:
  1. Delete this file.
  2. In main.py, delete the two lines that import and mount it
     (search for "devtools").
  3. In frontend/src/pages/AdminDashboard.jsx, delete the 'devtools' tab
     entry, its content block, and the DevTools lazy import.
  4. Delete frontend/src/pages/admin/DevTools.jsx.
That's the whole surface area — nothing else in the app depends on any of
this (it doesn't touch routing, auth, events, or any other admin feature).

Every route here is read-only with respect to the live system (it
inspects the graph and the routing/snapping logic, it never writes
anything) — mounted under /api/admin/devtools, superadmin-only via the
router-level dependency below (not per-route, so a route added here later
can't accidentally ship unprotected).
"""
import math
import os
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_role
from utils import router as campus_router

router = APIRouter(
    prefix="/api/admin/devtools",
    tags=["devtools"],
    dependencies=[Depends(require_role("superadmin"))],
)


def _haversine(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@router.get("/graph")
def get_full_graph():
    """The full walkway graph as-is, for the Graph Viewer to render on a
    Leaflet map. Same data build_walkway_graph.py produces — this just
    hands it to the frontend rather than the frontend needing its own
    copy or a filesystem read it doesn't have access to."""
    graph, _segs = campus_router._load()
    locations_path = os.path.join(campus_router.BASE_DIR, 'data', 'locations.json')
    import json
    locations = json.load(open(locations_path))
    return {"nodes": graph["nodes"], "edges": graph["edges"],
            "location_edges": graph["location_edges"], "locations": locations}


@router.get("/stats")
def get_graph_statistics():
    """Same numbers as scripts/generate_graph_docs.py's graph_statistics.json,
    computed live here so this always reflects the graph actually loaded
    in memory right now (no risk of viewing a stale docs/ export)."""
    graph, _segs = campus_router._load()
    nodes = {n['id']: n for n in graph['nodes']}
    adj = defaultdict(set)
    for e in graph['edges']:
        adj[e['from']].add(e['to'])
        adj[e['to']].add(e['from'])
    degree = {nid: len(adj[nid]) for nid in nodes}

    visited, components = set(), []
    for nid in nodes:
        if nid in visited:
            continue
        stack, comp = [nid], set()
        while stack:
            cur = stack.pop()
            if cur in comp:
                continue
            comp.add(cur)
            visited.add(cur)
            stack.extend(nb for nb in adj[cur] if nb not in comp)
        components.append(comp)
    components.sort(key=len, reverse=True)

    loc_edge_targets = {e['to'] for e in graph['location_edges']}
    max_deg = max(degree.values()) if degree else 0

    return {
        "total_nodes": len(nodes), "total_edges": len(graph['edges']),
        "total_location_connectors": len(graph['location_edges']),
        "average_degree": round(sum(degree.values()) / len(degree), 3) if degree else 0,
        "max_degree": max_deg,
        "critical_junction_nodes": [n for n, d in degree.items() if d == max_deg],
        "connected_components": len(components),
        "component_sizes": [len(c) for c in components],
        "dead_end_nodes": sorted(n for n, d in degree.items() if d == 1),
        "dead_ends_at_a_building_entrance": sorted({n for n, d in degree.items() if d == 1} & loc_edge_targets),
        "isolated_nodes": sorted(n for n, d in degree.items() if d == 0),
    }


@router.get("/snap")
def snap_debug(lat: float = Query(...), lng: float = Query(...),
               accuracy_m: Optional[float] = Query(None), to_id: Optional[str] = Query(None)):
    """Which node a given lat/lng snaps to, and the snap distance — the
    exact same _nearest_node() the live app uses for reroute-on-deviation,
    just exposed directly for debugging instead of buried inside a full
    route response. Pass to_id to also see the route-continuity/candidate
    tie-break in action (matches what a real in-progress reroute would
    do); omit it for a simple closest-node snap."""
    graph, segs = campus_router._load()
    adj = campus_router._build_adj(graph, segs, to_id) if to_id else None
    snap_id, snap_dist = campus_router._nearest_node(graph, lat, lng, adj, to_id, accuracy_m)
    if snap_id is None:
        raise HTTPException(status_code=404, detail="No nodes in graph to snap to.")
    node = next(n for n in graph['nodes'] if n['id'] == snap_id)
    return {
        "query": {"lat": lat, "lng": lng, "accuracy_m": accuracy_m, "to_id": to_id},
        "snapped_to": snap_id, "snapped_node": {"lat": node['lat'], "lng": node['lng']},
        "snap_distance_m": round(snap_dist, 2),
    }


@router.get("/route-inspect")
def route_inspect(from_id: str = Query(...), to_id: str = Query(...)):
    """The exact node-by-node sequence Dijkstra chose for from_id -> to_id
    — find_route()'s own response only exposes the two endpoints in
    'junctions', not the full internal path node IDs. This reconstructs
    the same thing find_route() does internally (same _load/_build_adj/
    _dijkstra calls — this file never duplicates or reimplements the
    routing logic itself) and additionally reports the per-hop distance
    between each consecutive node."""
    graph, segs = campus_router._load()
    adj = campus_router._build_adj(graph, segs, to_id)
    if from_id not in adj:
        raise HTTPException(status_code=404, detail=f"No road connection for '{from_id}'")
    if to_id not in adj:
        raise HTTPException(status_code=404, detail=f"No road connection for '{to_id}'")

    dist, prev = campus_router._dijkstra(adj, from_id, to_id)
    if to_id not in dist:
        raise HTTPException(status_code=404, detail=f"No path from '{from_id}' to '{to_id}'")

    seq, cur = [], to_id
    while cur in prev:
        seq.append(cur)
        cur = prev[cur]
    seq.append(from_id)
    seq.reverse()

    nodes_by_id = {n['id']: n for n in graph['nodes']}
    hops = []
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i + 1]
        edge_dist = next((w for (nb, w, _pts) in adj.get(a, []) if nb == b), None)
        node = nodes_by_id.get(a) or {"lat": None, "lng": None}  # 'a' may be a location id, not a graph node, at the very first/last hop
        hops.append({"node": a, "lat": node.get('lat'), "lng": node.get('lng'), "distance_to_next_m": round(edge_dist, 1) if edge_dist is not None else None})
    last_node = nodes_by_id.get(seq[-1]) or {"lat": None, "lng": None}
    hops.append({"node": seq[-1], "lat": last_node.get('lat'), "lng": last_node.get('lng'), "distance_to_next_m": None})

    return {"from": from_id, "to": to_id, "total_distance_m": round(dist[to_id], 1), "node_sequence": seq, "hops": hops}


@router.get("/export/{fmt}")
def export_graph(fmt: str):
    """fmt: 'json' (raw walkway_graph.json), 'geojson' (FeatureCollection —
    nodes as Point features, edges as LineString features, each carrying
    its metadata as GeoJSON properties), or 'graphviz' (.dot, geographic
    layout via 'neato' — same generator scripts/generate_graph_docs.py
    uses for the permanent docs/graph/ export, exposed here too for a
    quick one-off download without needing shell access)."""
    graph, _segs = campus_router._load()
    if fmt == "json":
        return graph

    if fmt == "geojson":
        features = []
        for n in graph['nodes']:
            features.append({
                "type": "Feature", "geometry": {"type": "Point", "coordinates": [n['lng'], n['lat']]},
                "properties": {"id": n['id'], "kind": "node"},
            })
        for e in graph['edges']:
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[p['lng'], p['lat']] for p in e['path']]},
                "properties": {"from": e['from'], "to": e['to'], "distance_m": e['distance_m'],
                               "hostel_only": e.get('hostel_only', False), "kind": "edge"},
            })
        for e in graph['location_edges']:
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[p['lng'], p['lat']] for p in e['path']]},
                "properties": {"from": e['from'], "to": e['to'], "distance_m": e['distance_m'], "kind": "location_connector"},
            })
        return {"type": "FeatureCollection", "features": features}

    if fmt == "graphviz":
        nodes = {n['id']: n for n in graph['nodes']}
        adj = defaultdict(set)
        for e in graph['edges']:
            adj[e['from']].add(e['to']); adj[e['to']].add(e['from'])
        degree = {nid: len(adj[nid]) for nid in nodes}
        max_deg = max(degree.values()) if degree else 1
        lat0 = sum(n['lat'] for n in graph['nodes']) / len(graph['nodes'])
        lines = ["graph walkway_graph {", '  layout="neato";', '  node [shape=point, width=0.05];', '  edge [color="#3A6EA5", penwidth=0.6];']
        for n in graph['nodes']:
            x = n['lng'] * math.cos(math.radians(lat0)) * 500
            y = n['lat'] * 500
            color = "#D7263D" if degree[n['id']] == max_deg else ("#E07414" if degree[n['id']] == 1 else "#2E9E5B")
            lines.append(f'  "{n["id"]}" [pos="{x:.2f},{y:.2f}!", color="{color}"];')
        seen = set()
        for e in graph['edges']:
            key = frozenset((e['from'], e['to']))
            if key in seen:
                continue
            seen.add(key)
            lines.append(f'  "{e["from"]}" -- "{e["to"]}";')
        lines.append("}")
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse("\n".join(lines), media_type="text/vnd.graphviz")

    raise HTTPException(status_code=400, detail="fmt must be one of: json, geojson, graphviz")
