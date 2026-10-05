/**
 * graphData.js — the walkway graph the client router runs on.
 *
 * This is NOT a copy. '@graph' is a Vite alias for backend/data (see
 * vite.config.js), so this imports the exact same walkway_graph.json file
 * that backend/utils/router.py reads from disk — including every merged
 * survey edge (cseitroad.kml etc.) it contains. Regenerating the graph
 * with backend/scripts/build_walkway_graph.py updates both routers at once;
 * there is no second file to keep in sync. scripts/routing_parity/parity.mjs
 * fails if a second walkway_graph.json ever appears in the repo.
 *
 * Bundled at build time (not fetched) on purpose: routing must work
 * synchronously, with zero network, from the very first launch.
 */
import graph from '@graph/walkway_graph.json'

export const WALKWAY_GRAPH = graph
