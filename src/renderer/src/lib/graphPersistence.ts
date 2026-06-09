// ────────────────────────────────────────────────────────────────────────────
// Graph persistence — serialize the visual graph (node types, positions, params
// and connections) to localStorage so a session survives an app restart.
// Only plain data is stored; the audio engine is rebuilt from it on load.
//
// As of the multi-workspace release the canvas holds several independent graphs
// ("workspaces"/tables), each individually enable-able. They are stored together
// under `audio-nodes.workspaces.v1`. The legacy single-graph key
// (`audio-nodes.graph.v1`) is migrated into one default workspace on first load.
// ────────────────────────────────────────────────────────────────────────────

import type { AudioFlowNode, AudioFlowEdge } from '@renderer/store/audioStore'

const KEY = 'audio-nodes.graph.v1'                 // legacy single-graph (migrated away)
const WORKSPACES_KEY = 'audio-nodes.workspaces.v1' // current multi-workspace store

export interface SavedNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, unknown>
  /** Group membership: a child node's containing group id (position is relative to it). */
  parentId?: string
  /** Container size for `group` nodes (so the box restores at the right dimensions). */
  width?: number
  height?: number
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

/** One persisted workspace: a named, independently-enabled graph. */
export interface SavedWorkspace {
  id: string
  name: string
  enabled: boolean
  nodes: SavedNode[]
  edges: SavedEdge[]
}

/** The whole multi-workspace document. `counter` is the shared node-id counter. */
export interface SavedWorkspaces {
  workspaces: SavedWorkspace[]
  activeId: string
  counter: number
}

// ── Serialization helpers ───────────────────────────────────────────────────

export function serializeNodes(nodes: AudioFlowNode[]): SavedNode[] {
  return nodes.map(n => {
    const style = n.style as { width?: number; height?: number } | undefined
    return {
      id: n.id,
      type: n.type ?? 'unknown',
      position: { x: n.position.x, y: n.position.y },
      data: n.data as Record<string, unknown>,
      ...(n.parentId ? { parentId: n.parentId } : {}),
      ...(typeof style?.width === 'number' ? { width: style.width } : {}),
      ...(typeof style?.height === 'number' ? { height: style.height } : {})
    }
  })
}

export function serializeEdges(edges: AudioFlowEdge[]): SavedEdge[] {
  return edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle
  }))
}

/** Build a plain serializable snapshot of a single graph. */
export function serializeGraph(nodes: AudioFlowNode[], edges: AudioFlowEdge[], counter: number): SavedGraph {
  return { nodes: serializeNodes(nodes), edges: serializeEdges(edges), counter }
}

// ── Multi-workspace storage ─────────────────────────────────────────────────

export function saveWorkspaces(data: SavedWorkspaces): void {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(data))
  } catch {
    /* storage unavailable / quota — non-fatal */
  }
}

/**
 * Load all workspaces. Falls back to migrating the legacy single-graph key into
 * one default (enabled) workspace, then returns null only when nothing is stored.
 */
export function loadWorkspaces(): SavedWorkspaces | null {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY)
    if (raw) {
      const w = JSON.parse(raw) as SavedWorkspaces
      if (Array.isArray(w.workspaces)) {
        // Defensive: ensure each workspace has the expected shape.
        w.workspaces = w.workspaces.filter(ws => Array.isArray(ws.nodes) && Array.isArray(ws.edges))
        if (w.workspaces.length > 0) return w
      }
    }
  } catch {
    /* fall through to migration / empty */
  }

  // Migrate a legacy single graph, if present.
  const legacy = loadGraph()
  if (legacy && legacy.nodes.length > 0) {
    const id = 'ws_legacy'
    return {
      workspaces: [{ id, name: 'Workspace 1', enabled: true, nodes: legacy.nodes, edges: legacy.edges }],
      activeId: id,
      counter: legacy.counter ?? 0
    }
  }
  return null
}

export function clearWorkspaces(): void {
  try { localStorage.removeItem(WORKSPACES_KEY) } catch { /* ignore */ }
}

// ── Legacy single-graph storage (read-only path kept for migration) ──────────

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
