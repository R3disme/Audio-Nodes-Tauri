// Feedback-cycle detection for the visual graph.
//
// The native engine silences any node caught in a feedback loop (there is no
// unit-delay element yet), and Web Audio likewise can't run a true cycle. Rather
// than let such a connection sit there mute with no explanation, we flag every
// edge that lies on a cycle so the UI can paint it as a warning.
//
// Pure + dependency-free (works on the minimal {id, source, target} shape) so it
// stays decoupled from the store types and is trivially testable.

interface CycleEdge {
  id: string
  source: string
  target: string
}

/**
 * Return the ids of edges that participate in a feedback cycle. An edge `u → v`
 * is on a cycle when `v` can reach back to `u` (or it is a self-loop `u → u`),
 * which marks the whole loop, not just one back-edge. Node count is implied by
 * the edges; isolated nodes never matter.
 */
export function findCyclicEdgeIds(edges: readonly CycleEdge[]): Set<string> {
  // Adjacency: source → targets.
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    const list = adj.get(e.source)
    if (list) list.push(e.target)
    else adj.set(e.source, [e.target])
  }

  // Memoised forward reachability from a node (BFS over the directed graph).
  const reachCache = new Map<string, Set<string>>()
  const reachableFrom = (start: string): Set<string> => {
    const cached = reachCache.get(start)
    if (cached) return cached
    const seen = new Set<string>()
    const stack = [...(adj.get(start) ?? [])]
    while (stack.length) {
      const n = stack.pop()!
      if (seen.has(n)) continue
      seen.add(n)
      for (const t of adj.get(n) ?? []) if (!seen.has(t)) stack.push(t)
    }
    reachCache.set(start, seen)
    return seen
  }

  const cyclic = new Set<string>()
  for (const e of edges) {
    if (e.source === e.target || reachableFrom(e.target).has(e.source)) {
      cyclic.add(e.id)
    }
  }
  return cyclic
}
