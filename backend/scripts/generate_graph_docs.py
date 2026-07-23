"""
Generates the routing graph's permanent documentation set (production audit
Parts 2 & 3): node list, edge list, statistics, and visual exports
(PNG/SVG/Graphviz/Mermaid), all overlaid on the graph's real campus
coordinates.

This is read-only with respect to walkway_graph.json — it documents the
graph, it never edits it. Run it again any time the graph changes (e.g.
after re-running build_walkway_graph.py) to refresh the docs.

Run from backend/:  python3 scripts/generate_graph_docs.py
Output:  docs/graph/  (created at the project root, alongside README.md)
"""
import json
import math
import os
import sys
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(BASE_DIR, 'data')
GRAPH_PATH = os.path.join(DATA_DIR, 'walkway_graph.json')
LOCATIONS_PATH = os.path.join(DATA_DIR, 'locations.json')
OUT_DIR = os.path.join(PROJECT_ROOT, 'docs', 'graph')


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def build_adjacency(graph):
    adj = defaultdict(set)
    for e in graph['edges']:
        adj[e['from']].add(e['to'])
        adj[e['to']].add(e['from'])
    return adj


def connected_components(nodes, adj):
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
    return components


def gather_statistics(graph):
    nodes = {n['id']: n for n in graph['nodes']}
    adj = build_adjacency(graph)
    degree = {nid: len(adj[nid]) for nid in nodes}
    components = connected_components(nodes, adj)
    loc_edge_targets = {e['to'] for e in graph['location_edges']}
    max_deg = max(degree.values()) if degree else 0

    return {
        "total_nodes": len(nodes),
        "total_edges": len(graph['edges']),
        "total_location_connectors": len(graph['location_edges']),
        "average_degree": round(sum(degree.values()) / len(degree), 3) if degree else 0,
        "max_degree": max_deg,
        "critical_junction_nodes": [n for n, d in degree.items() if d == max_deg],
        "connected_components": len(components),
        "component_sizes": [len(c) for c in components],
        "largest_component_fraction": round(len(components[0]) / len(nodes), 4) if components else 0,
        "dead_end_nodes": [n for n, d in degree.items() if d == 1],
        "dead_ends_at_a_building_entrance": sorted({n for n, d in degree.items() if d == 1} & loc_edge_targets),
        "isolated_nodes": [n for n, d in degree.items() if d == 0],
    }, degree, adj


def write_node_list(graph, degree, adj):
    rows = []
    for n in graph['nodes']:
        rows.append({
            "node_id": n['id'], "lat": n['lat'], "lng": n['lng'],
            "degree": degree[n['id']],
            "connected_neighbours": sorted(adj[n['id']]),
        })
    with open(os.path.join(OUT_DIR, 'node_list.json'), 'w') as f:
        json.dump(rows, f, indent=2)
    with open(os.path.join(OUT_DIR, 'node_list.csv'), 'w') as f:
        f.write("node_id,lat,lng,degree,connected_neighbours\n")
        for r in rows:
            f.write(f"{r['node_id']},{r['lat']},{r['lng']},{r['degree']},\"{';'.join(r['connected_neighbours'])}\"\n")
    return rows


def write_edge_list(graph):
    rows = []
    for i, e in enumerate(graph['edges']):
        rows.append({
            "edge_id": f"e_{i}", "from": e['from'], "to": e['to'],
            "distance_m": e['distance_m'], "bidirectional": True,  # router.py builds adjacency both ways for every edge — see main audit report Part 1
            "path_points": len(e['path']), "hostel_only": e.get('hostel_only', False),
        })
    for i, e in enumerate(graph['location_edges']):
        rows.append({
            "edge_id": f"loc_{i}", "from": e['from'], "to": e['to'],
            "distance_m": e['distance_m'], "bidirectional": True,
            "path_points": len(e['path']), "hostel_only": False, "is_location_connector": True,
        })
    with open(os.path.join(OUT_DIR, 'edge_list.json'), 'w') as f:
        json.dump(rows, f, indent=2)
    with open(os.path.join(OUT_DIR, 'edge_list.csv'), 'w') as f:
        f.write("edge_id,from,to,distance_m,bidirectional,path_points,hostel_only,is_location_connector\n")
        for r in rows:
            f.write(f"{r['edge_id']},{r['from']},{r['to']},{r['distance_m']},{r['bidirectional']},{r['path_points']},{r.get('hostel_only',False)},{r.get('is_location_connector',False)}\n")
    return rows


def write_graphviz(graph, degree):
    max_deg = max(degree.values()) if degree else 1
    lines = ["graph walkway_graph {", '  layout="neato";', '  node [shape=point, width=0.05];', '  edge [color="#3A6EA5", penwidth=0.6];']
    nodes = {n['id']: n for n in graph['nodes']}
    lat0 = sum(n['lat'] for n in graph['nodes']) / len(graph['nodes'])
    for n in graph['nodes']:
        x = (n['lng']) * math.cos(math.radians(lat0)) * 500
        y = n['lat'] * 500
        color = "#D7263D" if degree[n['id']] == max_deg else ("#E07414" if degree[n['id']] == 1 else "#2E9E5B")
        lines.append(f'  "{n["id"]}" [pos="{x:.2f},{y:.2f}!", tooltip="{n["id"]} (deg {degree[n["id"]]})", color="{color}"];')
    seen = set()
    for e in graph['edges']:
        key = frozenset((e['from'], e['to']))
        if key in seen:
            continue
        seen.add(key)
        lines.append(f'  "{e["from"]}" -- "{e["to"]}";')
    lines.append("}")
    with open(os.path.join(OUT_DIR, 'graph.dot'), 'w') as f:
        f.write("\n".join(lines))


def write_mermaid(graph):
    # Mermaid renders poorly past a few dozen nodes — the full 193-node
    # graph is included for completeness, but graph.svg/graph.png (below)
    # are the actually-readable full-graph documentation. Mermaid is more
    # useful pasted into a doc for a specific small subgraph.
    lines = ["graph TD"]
    seen = set()
    for e in graph['edges']:
        key = frozenset((e['from'], e['to']))
        if key in seen:
            continue
        seen.add(key)
        lines.append(f'  {e["from"]}["{e["from"]}"] --- {e["to"]}["{e["to"]}"]')
    with open(os.path.join(OUT_DIR, 'graph.mmd'), 'w') as f:
        f.write("\n".join(lines))


def write_visual(graph, degree, locations):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    nodes = {n['id']: n for n in graph['nodes']}
    max_deg = max(degree.values()) if degree else 1

    fig, ax = plt.subplots(figsize=(16, 20), dpi=150)

    # Edges
    for e in graph['edges']:
        lats = [p['lat'] for p in e['path']]
        lngs = [p['lng'] for p in e['path']]
        ax.plot(lngs, lats, color='#8FB3D9', linewidth=1.0, zorder=1)

    # Location connectors (dashed, distinguishes "spur to a building" from a walkway edge)
    for e in graph['location_edges']:
        lats = [p['lat'] for p in e['path']]
        lngs = [p['lng'] for p in e['path']]
        ax.plot(lngs, lats, color='#B8860B', linewidth=0.8, linestyle='--', zorder=1)

    # Nodes, colored by role
    xs, ys, colors, sizes = [], [], [], []
    for n in graph['nodes']:
        d = degree[n['id']]
        xs.append(n['lng']); ys.append(n['lat'])
        if d == max_deg:
            colors.append('#D7263D'); sizes.append(45)   # critical junction
        elif d == 1:
            colors.append('#E07414'); sizes.append(28)   # dead end
        else:
            colors.append('#2E9E5B'); sizes.append(16)
    ax.scatter(xs, ys, c=colors, s=sizes, zorder=3, edgecolors='white', linewidths=0.4)

    # Node ID labels (small, only way this stays legible at 193 nodes)
    for n in graph['nodes']:
        ax.annotate(n['id'].replace('n_', ''), (n['lng'], n['lat']), fontsize=3.2,
                    color='#333333', zorder=4, xytext=(1.5, 1.5), textcoords='offset points')

    # Location markers (building entrances)
    for loc in locations:
        ax.scatter([loc['lng']], [loc['lat']], marker='s', c='#3A6EA5', s=20, zorder=5, edgecolors='white', linewidths=0.5)
        ax.annotate(loc['id'], (loc['lng'], loc['lat']), fontsize=4, color='#1a3a5c', zorder=6,
                    xytext=(3, 3), textcoords='offset points', weight='bold')

    legend_elems = [
        Line2D([0], [0], marker='o', color='w', markerfacecolor='#D7263D', markersize=8, label=f'Critical junction (degree {max_deg})'),
        Line2D([0], [0], marker='o', color='w', markerfacecolor='#E07414', markersize=7, label='Dead end (degree 1)'),
        Line2D([0], [0], marker='o', color='w', markerfacecolor='#2E9E5B', markersize=6, label='Walkway node'),
        Line2D([0], [0], marker='s', color='w', markerfacecolor='#3A6EA5', markersize=7, label='Location / building entrance'),
        Line2D([0], [0], color='#8FB3D9', linewidth=1.5, label='Walkway edge'),
        Line2D([0], [0], color='#B8860B', linewidth=1.5, linestyle='--', label='Location connector'),
    ]
    ax.legend(handles=legend_elems, loc='upper left', fontsize=7, framealpha=0.9)
    ax.set_title('SSN Campus Navigator — Walkway Routing Graph', fontsize=14, weight='bold')
    ax.set_xlabel('Longitude', fontsize=8)
    ax.set_ylabel('Latitude', fontsize=8)
    ax.set_aspect(1.0 / math.cos(math.radians(sum(n['lat'] for n in graph['nodes']) / len(graph['nodes']))))
    ax.tick_params(labelsize=6)

    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, 'graph.png'), dpi=150)
    fig.savefig(os.path.join(OUT_DIR, 'graph.svg'))
    plt.close(fig)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    graph = json.load(open(GRAPH_PATH))
    locations = json.load(open(LOCATIONS_PATH))

    stats, degree, adj = gather_statistics(graph)
    with open(os.path.join(OUT_DIR, 'graph_statistics.json'), 'w') as f:
        json.dump(stats, f, indent=2)
    print("Wrote graph_statistics.json:", stats)

    node_rows = write_node_list(graph, degree, adj)
    print(f"Wrote node_list.json / .csv ({len(node_rows)} nodes)")

    edge_rows = write_edge_list(graph)
    print(f"Wrote edge_list.json / .csv ({len(edge_rows)} edges)")

    write_graphviz(graph, degree)
    print("Wrote graph.dot (Graphviz — render with: dot -Tpng graph.dot -o graph_dot.png, or 'neato' for the geographic layout above)")

    write_mermaid(graph)
    print("Wrote graph.mmd (Mermaid)")

    try:
        write_visual(graph, degree, locations)
        print("Wrote graph.png and graph.svg")
    except ImportError as e:
        print(f"Skipped PNG/SVG — matplotlib not installed ({e}). Node/edge lists and Graphviz/Mermaid were still written.")

    print(f"\nAll documentation written to {OUT_DIR}/")


if __name__ == '__main__':
    main()
