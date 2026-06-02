// ────────────────────────────────────────────────────────────────────────────
// Graph persistence — serialize the visual graph (node types, positions, params
// and connections) to localStorage so a session survives an app restart.
// Only plain data is stored; the audio engine is rebuilt from it on load.
// ────────────────────────────────────────────────────────────────────────────

import type { AudioFlowNode, AudioFlowEdge } from '@renderer/store/audioStore'

const KEY = 'audio-nodes.graph.v1'

export interface SavedNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export interface SavedEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface SavedGraph {
  nodes: SavedNode[]
  edges: SavedEdge[]
  counter: number
}

/** Build a plain serializable snapshot of the graph. */
export function serializeGraph(nodes: AudioFlowNode[], edges: AudioFlowEdge[], counter: number): SavedGraph {
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      type: n.type ?? 'unknown',
      position: { x: n.position.x, y: n.position.y },
      data: n.data as Record<string, unknown>
    })),
    edges: edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle
    })),
    counter
  }
}

export function saveGraph(nodes: AudioFlowNode[], edges: AudioFlowEdge[], counter: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(serializeGraph(nodes, edges, counter)))
  } catch {
    /* storage unavailable / quota — non-fatal */
  }
}

export function loadGraph(): SavedGraph | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const g = JSON.parse(raw) as SavedGraph
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null
    return g
  } catch {
    return null
  }
}

export function clearGraph(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
