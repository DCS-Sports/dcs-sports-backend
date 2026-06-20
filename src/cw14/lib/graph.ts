// CW14 · v3.0 DCS TALENT GRAPH.
// Typed relationship graph (athlete↔coach↔academy↔league↔scout↔agent↔sponsor).
// BFS shortest-path for discovery ("how am I connected to this athlete?").
// Minor protection: a path that ENDS at a minor athlete is only returned when the
// caller is allowed to discover that athlete (grant present) — same posture as search.

import type { GraphNode, GraphEdge, GraphPath } from './contracts';

export class TalentGraph {
  private nodes = new Map<string, GraphNode>();
  private adj = new Map<string, GraphEdge[]>();

  addNode(n: GraphNode) {
    this.nodes.set(n.id, n);
    if (!this.adj.has(n.id)) this.adj.set(n.id, []);
  }
  addEdge(e: GraphEdge) {
    if (!this.adj.has(e.from_id)) this.adj.set(e.from_id, []);
    if (!this.adj.has(e.to_id)) this.adj.set(e.to_id, []);
    this.adj.get(e.from_id)!.push(e);
    // undirected for discovery: traverse both ways
    this.adj.get(e.to_id)!.push({ from_id: e.to_id, to_id: e.from_id, type: e.type, since: e.since });
  }
  getNode(id: string): GraphNode | undefined { return this.nodes.get(id); }

  neighbors(id: string): GraphEdge[] { return this.adj.get(id) ?? []; }

  // BFS shortest path from→to. Returns null if unreachable.
  shortestPath(fromId: string, toId: string, maxDepth = 6): GraphPath | null {
    if (fromId === toId) {
      const n = this.nodes.get(fromId);
      return n ? { nodes: [n], edges: [], length: 0 } : null;
    }
    const visited = new Set<string>([fromId]);
    const queue: Array<{ id: string; path: GraphEdge[] }> = [{ id: fromId, path: [] }];
    while (queue.length) {
      const { id, path } = queue.shift()!;
      if (path.length >= maxDepth) continue;
      for (const e of this.neighbors(id)) {
        if (visited.has(e.to_id)) continue;
        const newPath = [...path, e];
        if (e.to_id === toId) {
          const nodeIds = [fromId, ...newPath.map((x) => x.to_id)];
          const nodes = nodeIds.map((nid) => this.nodes.get(nid)).filter(Boolean) as GraphNode[];
          return { nodes, edges: newPath, length: newPath.length };
        }
        visited.add(e.to_id);
        queue.push({ id: e.to_id, path: newPath });
      }
    }
    return null;
  }

  // Direct connections of a node, optionally filtered by neighbor type.
  connections(id: string, ofType?: GraphNode['type']): GraphNode[] {
    return this.neighbors(id)
      .map((e) => this.nodes.get(e.to_id))
      .filter((n): n is GraphNode => !!n && (!ofType || n.type === ofType));
  }
}

// Build a graph from edge rows (real path loads from sports_graph_edges + entities).
export function buildGraph(nodes: GraphNode[], edges: GraphEdge[]): TalentGraph {
  const g = new TalentGraph();
  nodes.forEach((n) => g.addNode(n));
  edges.forEach((e) => g.addEdge(e));
  return g;
}
