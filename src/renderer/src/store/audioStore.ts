import { create } from 'zustand'
import { nodeColor } from '@renderer/lib/nodeColors'
import {
  serializeNodes,
  serializeEdges,
  saveWorkspaces,
  loadWorkspaces,
  type SavedGraph,
  type SavedNode,
  type SavedEdge,
  type SavedWorkspace
} from '@renderer/lib/graphPersistence'
import { useSettingsStore } from '@renderer/store/settingsStore'
import {
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type XYPosition,
  type Connection
} from '@xyflow/react'
import {
  DEFAULT_EQ_BANDS,
  DEFAULT_REVERB,
  DEFAULT_DELAY,
  DEFAULT_CHORUS,
  DEFAULT_DISTORTION,
  DEFAULT_PAN,
  type EQBand,
  type AudioNodeType
} from '@renderer/audio/AudioEngine'
import { audioEngine, ensureBackendAvailable } from '@renderer/audio/backend'

// ── Node data types ───────────────────────────────────────────────────────

interface BaseNodeData {
  label: string
  channels: number
}

export interface InputNodeData extends BaseNodeData {
  deviceId: string
  deviceName: string
  gain: number
  muted: boolean
}

export interface ApplicationNodeData extends BaseNodeData {
  sourceId: string
  sourceName: string
}

export interface OutputNodeData extends BaseNodeData {
  deviceId: string
  deviceName: string
  volume: number
  muted: boolean
}

export interface VolumeNodeData extends BaseNodeData {
  gain: number
  muted: boolean
}

export interface EQNodeData extends BaseNodeData {
  bands: EQBand[]
}

export interface CompressorNodeData extends BaseNodeData {
  threshold: number
  knee: number
  ratio: number
  attack: number
  release: number
}

export interface GateNodeData extends BaseNodeData {
  threshold: number
  attack: number
  release: number
}

export interface MixerNodeData extends BaseNodeData {
  channelCount: number          // legacy alias for `channels`; we use channels everywhere
  channels_state: { gain: number; muted: boolean; label: string }[]
  masterGain: number
}

export interface ReverbNodeData extends BaseNodeData {
  mix: number
  decay: number
  preDelay: number
}

export interface DelayNodeData extends BaseNodeData {
  time: number
  feedback: number
  mix: number
}

export interface ChorusNodeData extends BaseNodeData {
  rate: number
  depth: number
  mix: number
}

export interface DistortionNodeData extends BaseNodeData {
  drive: number
  mix: number
}

export interface PanNodeData extends BaseNodeData {
  pan: number
}

// Recording is transient engine state (not persisted); the node data carries only
// the common fields.
export type RecorderNodeData = BaseNodeData

export interface FilePlayerNodeData extends BaseNodeData {
  fileName: string
  loop: boolean
  gain: number
  muted: boolean
}

export type AudioNodeData =
  | InputNodeData
  | ApplicationNodeData
  | OutputNodeData
  | VolumeNodeData
  | EQNodeData
  | CompressorNodeData
  | GateNodeData
  | MixerNodeData
  | ReverbNodeData
  | DelayNodeData
  | ChorusNodeData
  | DistortionNodeData
  | PanNodeData
  | RecorderNodeData
  | FilePlayerNodeData

export type AudioFlowNode = Node<AudioNodeData & Record<string, unknown>>
export type AudioFlowEdge = Edge

/** One workspace ("table"): a named, independently-enabled graph. */
export interface Workspace {
  id: string
  name: string
  enabled: boolean
  nodes: AudioFlowNode[]
  edges: AudioFlowEdge[]
}

// ── Handle ID encoding ────────────────────────────────────────────────────
//
// "in-0", "in-1", … on the left side; "out-0", "out-1", … on the right side.
// Mixer is special: many "in-N" handles, single "out-0".
//
function parseHandle(handle: string | null | undefined): { kind: 'in' | 'out'; channel: number } | null {
  if (!handle) return null
  const m = handle.match(/^(in|out)-(\d+)$/)
  if (!m) return null
  return { kind: m[1] as 'in' | 'out', channel: parseInt(m[2], 10) }
}

// ── ID generation ─────────────────────────────────────────────────────────

let nodeCounter = 0
const nextId = (prefix: string): string => `${prefix}_${++nodeCounter}`
const genWorkspaceId = (): string => `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Highest numeric suffix among a set of node ids (for restoring the counter). */
function maxIdTail(ids: string[]): number {
  return ids.reduce((max, id) => {
    const tail = parseInt(id.split('_').pop() ?? '0', 10)
    return Number.isFinite(tail) ? Math.max(max, tail) : max
  }, 0)
}

const centerOffset = (): XYPosition => ({
  x: 220 + Math.random() * 320,
  y: 80 + Math.random() * 240
})

// ── Default node data factory ───────────────────────────────────────────────
//
// One place that produces the initial data + id prefix for every node type, so
// `addNode` stays tiny and engine rebuilds (which read the same `data`) never
// drift from creation defaults.

interface NodeSpec { idPrefix: string; data: AudioNodeData & Record<string, unknown> }

function makeNodeSpec(type: string): NodeSpec | null {
  switch (type) {
    case 'input':
      return { idPrefix: 'input', data: { label: 'Input', deviceId: '', deviceName: 'Default', gain: 1, muted: false, channels: 1 } }
    case 'fileplayer':
      return { idPrefix: 'file', data: { label: 'File Player', fileName: '', loop: false, gain: 1, muted: false, channels: 1 } }
    case 'application':
      return { idPrefix: 'app', data: { label: 'Application', sourceId: '', sourceName: '', channels: 1 } }
    case 'output':
      return { idPrefix: 'output', data: { label: 'Output', deviceId: '', deviceName: 'Default', volume: 1, muted: false, channels: 1 } }
    case 'virtual':
      return { idPrefix: 'virtual', data: { label: 'Virtual Output', deviceId: '', deviceName: '', volume: 1, muted: false, channels: 1 } }
    case 'recorder':
      return { idPrefix: 'rec', data: { label: 'Recorder', channels: 1 } }
    case 'volume':
      return { idPrefix: 'volume', data: { label: 'Volume', gain: 1, muted: false, channels: 1 } }
    case 'eq':
      return { idPrefix: 'eq', data: { label: 'Equalizer', bands: structuredClone(DEFAULT_EQ_BANDS), channels: 1 } }
    case 'compressor':
      return { idPrefix: 'comp', data: { label: 'Compressor', threshold: -24, knee: 6, ratio: 4, attack: 0.003, release: 0.25, channels: 1 } }
    case 'gate':
      return { idPrefix: 'gate', data: { label: 'Gate', threshold: -50, attack: 0.005, release: 0.1, channels: 1 } }
    case 'reverb':
      return { idPrefix: 'reverb', data: { label: 'Reverb', ...DEFAULT_REVERB, channels: 1 } }
    case 'delay':
      return { idPrefix: 'delay', data: { label: 'Delay', ...DEFAULT_DELAY, channels: 1 } }
    case 'chorus':
      return { idPrefix: 'chorus', data: { label: 'Chorus', ...DEFAULT_CHORUS, channels: 1 } }
    case 'distortion':
      return { idPrefix: 'dist', data: { label: 'Distortion', ...DEFAULT_DISTORTION, channels: 1 } }
    case 'pan':
      return { idPrefix: 'pan', data: { label: 'Pan', ...DEFAULT_PAN, channels: 1 } }
    case 'mixer': {
      const channelCount = 4
      return {
        idPrefix: 'mixer',
        data: {
          label: 'Mixer',
          channelCount,
          channels: channelCount,
          masterGain: 1,
          channels_state: Array.from({ length: channelCount }, (_, i) => ({ gain: 1, muted: false, label: `Ch ${i + 1}` }))
        }
      }
    }
    default:
      return null
  }
}

// ── Persistence wiring ──────────────────────────────────────────────────────

let graphLoaded = false
let autosaveBound = false
let saveTimer: number | undefined

/** Snapshot the active workspace's live nodes/edges back into the workspaces array. */
function flushActive(s: { workspaces: Workspace[]; activeWorkspaceId: string; nodes: AudioFlowNode[]; edges: AudioFlowEdge[] }): Workspace[] {
  return s.workspaces.map(w =>
    w.id === s.activeWorkspaceId ? { ...w, nodes: s.nodes, edges: s.edges } : w
  )
}

/** Debounced save of all workspaces (positions, params, connections, enabled). */
function scheduleSave(): void {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const s = useAudioStore.getState()
    const workspaces: SavedWorkspace[] = flushActive(s).map(w => ({
      id: w.id, name: w.name, enabled: w.enabled,
      nodes: serializeNodes(w.nodes), edges: serializeEdges(w.edges)
    }))
    saveWorkspaces({ workspaces, activeId: s.activeWorkspaceId, counter: nodeCounter })
  }, 500)
}

/** Recreate one audio-engine node from saved node data. */
async function rebuildEngineNode(type: string, id: string, data: Record<string, unknown>): Promise<void> {
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)
  const ch = num(data.channels, 1)
  switch (type) {
    case 'input':
      await audioEngine.createInputNode(id, (data.deviceId as string) || undefined)
      audioEngine.setGain(id, num(data.gain, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      break
    case 'fileplayer':
      // The picked file is a transient blob URL, so it isn't restored here — the
      // node is recreated empty; the user re-loads a file. Gain/mute/loop persist.
      audioEngine.createFilePlayerNode(id)
      audioEngine.setGain(id, num(data.gain, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      if (data.loop) audioEngine.setFilePlayerLoop(id, true)
      break
    case 'application':
      await audioEngine.createApplicationNode(id, '', (data.sourceName as string) || '')
      if (data.sourceName) {
        const m = await window.api.findSourceByName(data.sourceName as string)
        if (m) await audioEngine.armApplicationCapture(id, m.id, data.sourceName as string)
      }
      break
    case 'output':
      audioEngine.createOutputNode(id, 'output')
      audioEngine.setGain(id, num(data.volume, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      // Open the device explicitly ('' ⇒ system default); the engine no longer
      // auto-opens output streams on create.
      await audioEngine.setOutputDevice(id, (data.deviceId as string) || '')
      break
    case 'virtual':
      audioEngine.createOutputNode(id, 'virtual')
      audioEngine.setGain(id, num(data.volume, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      // Only open a stream once a real virtual cable is chosen — a device-less
      // Virtual Output stays silent rather than grabbing the default device (which
      // would contend with the Output node).
      if (data.deviceId) await audioEngine.setOutputDevice(id, data.deviceId as string)
      break
    case 'recorder':
      audioEngine.createRecorderNode(id)
      break
    case 'volume':
      audioEngine.createVolumeNode(id, ch)
      audioEngine.setGain(id, num(data.gain, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      break
    case 'eq':
      audioEngine.createEQNode(id, ch, data.bands as EQBand[] | undefined)
      break
    case 'compressor':
      audioEngine.createCompressorNode(id, ch)
      audioEngine.setCompressor(id, {
        threshold: data.threshold as number, knee: data.knee as number, ratio: data.ratio as number,
        attack: data.attack as number, release: data.release as number
      })
      break
    case 'gate':
      audioEngine.createGateNode(id, ch)
      audioEngine.setGate(id, { threshold: data.threshold as number, attack: data.attack as number, release: data.release as number })
      break
    case 'pan':
      audioEngine.createPanNode(id, ch, { pan: num(data.pan, DEFAULT_PAN.pan) })
      break
    case 'reverb':
      audioEngine.createReverbNode(id, ch, {
        mix: num(data.mix, DEFAULT_REVERB.mix), decay: num(data.decay, DEFAULT_REVERB.decay), preDelay: num(data.preDelay, DEFAULT_REVERB.preDelay)
      })
      break
    case 'delay':
      audioEngine.createDelayNode(id, ch, {
        time: num(data.time, DEFAULT_DELAY.time), feedback: num(data.feedback, DEFAULT_DELAY.feedback), mix: num(data.mix, DEFAULT_DELAY.mix)
      })
      break
    case 'chorus':
      audioEngine.createChorusNode(id, ch, {
        rate: num(data.rate, DEFAULT_CHORUS.rate), depth: num(data.depth, DEFAULT_CHORUS.depth), mix: num(data.mix, DEFAULT_CHORUS.mix)
      })
      break
    case 'distortion':
      audioEngine.createDistortionNode(id, ch, { drive: num(data.drive, DEFAULT_DISTORTION.drive), mix: num(data.mix, DEFAULT_DISTORTION.mix) })
      break
    case 'mixer': {
      const mc = num(data.channelCount, num(data.channels, 4))
      audioEngine.createMixerNode(id, mc)
      audioEngine.setMixerMaster(id, num(data.masterGain, 1))
      const cs = data.channels_state as Array<{ gain: number; muted: boolean }> | undefined
      cs?.forEach((c, i) => audioEngine.setMixerChannel(id, i, c.muted ? 0 : c.gain))
      break
    }
  }
}

// ── Store ─────────────────────────────────────────────────────────────────

/** Edge stroke for a connection from `srcNode` — its per-node override or type color. */
function edgeStrokeFor(srcNode?: { type?: string; data?: Record<string, unknown> }): string {
  const override = srcNode?.data?.color
  return typeof override === 'string' && override ? override : nodeColor(srcNode?.type)
}

/** Rehydrate plain saved nodes/edges into React Flow objects (no engine work). */
function deserializeGraph(savedNodes: SavedNode[], savedEdges: SavedEdge[]): { nodes: AudioFlowNode[]; edges: AudioFlowEdge[] } {
  const nodes = savedNodes.map(n => ({
    id: n.id, type: n.type, position: n.position, data: n.data
  })) as AudioFlowNode[]
  const edges = savedEdges.map(e => {
    const srcNode = savedNodes.find(n => n.id === e.source)
    return {
      id: e.id, source: e.source, target: e.target,
      sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
      style: { stroke: edgeStrokeFor(srcNode), strokeWidth: 2 }
    }
  }) as AudioFlowEdge[]
  return { nodes, edges }
}

function materializeWorkspace(w: SavedWorkspace): Workspace {
  const { nodes, edges } = deserializeGraph(w.nodes, w.edges)
  return { id: w.id, name: w.name, enabled: w.enabled, nodes, edges }
}

/** Build engine nodes + connections for a graph (used when a workspace activates). */
async function buildEngine(nodes: AudioFlowNode[], edges: AudioFlowEdge[]): Promise<void> {
  for (const n of nodes) {
    try {
      await rebuildEngineNode(n.type ?? '', n.id, n.data as Record<string, unknown>)
    } catch (e) {
      console.warn('Failed to build node', n.id, e)
    }
  }
  for (const e of edges) {
    const src = parseHandle(e.sourceHandle)
    const tgt = parseHandle(e.targetHandle)
    audioEngine.connect(e.source, src?.channel ?? 0, e.target, tgt?.channel ?? 0)
  }
}

/** Destroy engine nodes for a graph (used when a workspace deactivates). */
function teardownEngine(nodes: AudioFlowNode[]): void {
  for (const n of nodes) audioEngine.destroyNode(n.id)
}

/** Tear down every currently-enabled workspace's engine graph. */
function teardownAllEngines(): void {
  const s = useAudioStore.getState()
  for (const w of s.workspaces) {
    if (!w.enabled) continue
    teardownEngine(w.id === s.activeWorkspaceId ? s.nodes : w.nodes)
  }
}

/** Build engines for the enabled workspaces, then publish them to the store. */
async function applyWorkspaces(workspaces: Workspace[], activeId: string): Promise<void> {
  for (const w of workspaces) if (w.enabled) await buildEngine(w.nodes, w.edges)
  const active = workspaces.find(w => w.id === activeId) ?? workspaces[0]
  useAudioStore.setState({ workspaces, activeWorkspaceId: active.id, nodes: active.nodes, edges: active.edges })
}

export interface ExportedConfig {
  version: number
  workspaces?: SavedWorkspace[]
  activeWorkspaceId?: string
  counter?: number
  /** Legacy single-graph payload (older exports) — imported into one workspace. */
  graph?: SavedGraph
  theme: unknown
  sidebarCollapsed: boolean
  nodeScale: number
}

interface AudioStore {
  nodes: AudioFlowNode[]
  edges: AudioFlowEdge[]
  workspaces: Workspace[]
  activeWorkspaceId: string
  devices: { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }
  initialized: boolean

  onNodesChange: OnNodesChange<AudioFlowNode>
  onEdgesChange: OnEdgesChange
  onConnect: OnConnect

  addNode: (type: string, position?: XYPosition) => Promise<void>
  removeNode: (id: string) => void
  updateNodeData: (id: string, data: Partial<AudioNodeData>) => void
  setNodeChannels: (id: string, type: AudioNodeType, channels: number) => void
  setNodeColor: (id: string, color: string | null) => void

  // ── Workspaces ──
  addWorkspace: () => void
  removeWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  setActiveWorkspace: (id: string) => void
  setWorkspaceEnabled: (id: string, enabled: boolean) => Promise<void>
  setAllWorkspacesEnabled: (enabled: boolean) => Promise<void>

  initAudio: () => Promise<void>
  loadGraph: () => Promise<void>
  clearGraph: () => void
  loadPreset: (graph: SavedGraph) => Promise<void>
  exportConfig: () => ExportedConfig
  importConfig: (cfg: ExportedConfig) => Promise<void>
  refreshDevices: () => Promise<void>
}

export const useAudioStore = create<AudioStore>((set, get) => {
  /** Whether the active workspace's audio graph is live (engine calls apply). */
  const activeEnabled = (): boolean => {
    const s = get()
    return s.workspaces.find(w => w.id === s.activeWorkspaceId)?.enabled ?? true
  }

  return {
    nodes: [],
    edges: [],
    workspaces: [],
    activeWorkspaceId: '',
    devices: { inputs: [], outputs: [] },
    initialized: false,

    // ── React Flow change handlers ───────────────────────────────────────────

    onNodesChange: (changes) => {
      changes.forEach(c => {
        if (c.type === 'remove') audioEngine.destroyNode(c.id)
      })
      set(s => ({ nodes: applyNodeChanges(changes, s.nodes) as AudioFlowNode[] }))
    },

    onEdgesChange: (changes) => {
      changes.forEach(c => {
        if (c.type === 'remove') {
          const edge = get().edges.find(e => e.id === c.id)
          if (edge?.source && edge?.target) {
            const src = parseHandle(edge.sourceHandle)
            const tgt = parseHandle(edge.targetHandle)
            audioEngine.disconnect(
              edge.source, src?.channel ?? 0,
              edge.target, tgt?.channel ?? 0
            )
          }
        }
      })
      set(s => ({ edges: applyEdgeChanges(changes, s.edges) }))
    },

    onConnect: (connection: Connection) => {
      if (!connection.source || !connection.target) return
      // Reject self-connections — they would form an audio feedback loop.
      if (connection.source === connection.target) return
      const src = parseHandle(connection.sourceHandle)
      const tgt = parseHandle(connection.targetHandle)

      // Validate: only out → in
      if (src && src.kind !== 'out') return
      if (tgt && tgt.kind !== 'in') return

      const srcCh = src?.channel ?? 0
      const tgtCh = tgt?.channel ?? 0

      // When the active workspace is disabled it has no live engine graph, so we
      // only record the visual edge; it wires up when the workspace is enabled.
      if (activeEnabled()) {
        const ok = audioEngine.connect(connection.source, srcCh, connection.target, tgtCh)
        if (!ok) return
      }

      // Blender-style: draw the edge in the source node's accent color.
      const sourceType = get().nodes.find(n => n.id === connection.source)?.type
      const stroke = nodeColor(sourceType)

      set(s => ({
        edges: addEdge(
          {
            ...connection,
            id: `${connection.source}:${srcCh}->${connection.target}:${tgtCh}`,
            style: { stroke, strokeWidth: 2 }
          },
          s.edges
        )
      }))
    },

    // ── Node creation ────────────────────────────────────────────────────────

    addNode: async (type, position) => {
      const spec = makeNodeSpec(type)
      if (!spec) return
      const id = nextId(spec.idPrefix)
      const pos = position ?? centerOffset()

      // Only touch the engine when the active workspace is live; a disabled
      // workspace stays visual-only until it is enabled.
      if (activeEnabled()) {
        try {
          await rebuildEngineNode(type, id, spec.data as Record<string, unknown>)
        } catch (e) {
          console.warn('addNode: engine build failed', id, e)
        }
      }

      set(s => ({
        nodes: [...s.nodes, { id, type, position: pos, data: spec.data } as AudioFlowNode]
      }))
    },

    removeNode: (id) => {
      audioEngine.destroyNode(id)
      set(s => ({
        nodes: s.nodes.filter(n => n.id !== id),
        edges: s.edges.filter(e => e.source !== id && e.target !== id)
      }))
    },

    updateNodeData: (id, data) => {
      set(s => ({
        nodes: s.nodes.map(n =>
          n.id === id ? { ...n, data: { ...n.data, ...data } as AudioNodeData & Record<string, unknown> } : n
        )
      }))
    },

    /**
     * Change a node's channel count. Removes edges whose channel index no longer
     * exists. Type-specific recreation is delegated to the audio engine (when the
     * active workspace is live); otherwise it is a purely visual edit.
     */
    setNodeChannels: (id, type, channels) => {
      channels = Math.max(1, Math.min(8, Math.round(channels)))

      if (!activeEnabled()) {
        // Visual-only: update the count and prune edges that reference channels
        // beyond the new range.
        set(s => {
          const nodes = s.nodes.map(n => (n.id === id ? { ...n, data: { ...n.data, channels } } : n))
          const edges = s.edges.filter(e => {
            if (e.source === id && (parseHandle(e.sourceHandle)?.channel ?? 0) >= channels) return false
            if (e.target === id && (parseHandle(e.targetHandle)?.channel ?? 0) >= channels) return false
            return true
          })
          return { nodes, edges }
        })
        return
      }

      const lostEdges = audioEngine.getConnectionsBeyondChannel(id, channels)
      const actualChannels = audioEngine.setChannelCount(id, type, channels)

      set(s => {
        const nodes = s.nodes.map(n =>
          n.id === id ? { ...n, data: { ...n.data, channels: actualChannels } } : n
        )
        const edges = s.edges.filter(e => {
          for (const lost of lostEdges) {
            if (e.source === lost.source && e.target === lost.target &&
                e.sourceHandle === `out-${lost.sourceChannel}` &&
                e.targetHandle === `in-${lost.targetChannel}`) {
              return false
            }
          }
          return true
        })
        return { nodes, edges }
      })
    },

    /** Override a single node's accent color (null clears it), recoloring its edges. */
    setNodeColor: (id, color) => {
      set(s => {
        const nodes = s.nodes.map(n =>
          n.id === id ? { ...n, data: { ...n.data, color: color ?? undefined } as AudioNodeData & Record<string, unknown> } : n
        )
        const srcNode = nodes.find(n => n.id === id)
        const stroke = edgeStrokeFor(srcNode)
        const edges = s.edges.map(e => (e.source === id ? { ...e, style: { ...e.style, stroke } } : e))
        return { nodes, edges }
      })
    },

    // ── Workspaces ────────────────────────────────────────────────────────────

    addWorkspace: () => {
      const id = genWorkspaceId()
      set(s => {
        const workspaces = flushActive(s)
        const name = `Workspace ${workspaces.length + 1}`
        return {
          workspaces: [...workspaces, { id, name, enabled: true, nodes: [], edges: [] }],
          activeWorkspaceId: id,
          nodes: [],
          edges: []
        }
      })
    },

    removeWorkspace: (id) => {
      const s = get()
      if (s.workspaces.length <= 1) return // always keep at least one
      const target = s.workspaces.find(w => w.id === id)
      if (target?.enabled) teardownEngine(id === s.activeWorkspaceId ? s.nodes : target.nodes)

      const remaining = flushActive(s).filter(w => w.id !== id)
      const activeId = id === s.activeWorkspaceId ? remaining[0].id : s.activeWorkspaceId
      const active = remaining.find(w => w.id === activeId) ?? remaining[0]
      set({ workspaces: remaining, activeWorkspaceId: active.id, nodes: active.nodes, edges: active.edges })
    },

    renameWorkspace: (id, name) => {
      set(s => ({ workspaces: s.workspaces.map(w => (w.id === id ? { ...w, name } : w)) }))
    },

    setActiveWorkspace: (id) => {
      set(s => {
        if (id === s.activeWorkspaceId) return {}
        const workspaces = flushActive(s)
        const w = workspaces.find(x => x.id === id)
        if (!w) return { workspaces }
        return { workspaces, activeWorkspaceId: id, nodes: w.nodes, edges: w.edges }
      })
    },

    setWorkspaceEnabled: async (id, enabled) => {
      const flushed = flushActive(get())
      const w = flushed.find(x => x.id === id)
      if (!w || w.enabled === enabled) return
      if (enabled) await buildEngine(w.nodes, w.edges)
      else teardownEngine(w.nodes)
      set({ workspaces: flushed.map(x => (x.id === id ? { ...x, enabled } : x)) })
    },

    setAllWorkspacesEnabled: async (enabled) => {
      const flushed = flushActive(get())
      for (const w of flushed) {
        if (w.enabled === enabled) continue
        if (enabled) await buildEngine(w.nodes, w.edges)
        else teardownEngine(w.nodes)
      }
      set({ workspaces: flushed.map(w => ({ ...w, enabled })) })
    },

    // ── Audio initialization ───────────────────────────────────────────────

    initAudio: async () => {
      // Native is the default; if its addon isn't built, transparently use Web
      // Audio this session so there's always sound.
      await ensureBackendAvailable()
      await audioEngine.init()
      // Apply the persisted latency mode now the engine is up (native; Web Audio no-ops).
      audioEngine.setLatencyMode(useSettingsStore.getState().latencyMode)
      const devices = await audioEngine.getDevices()
      set({ devices })

      // Restore saved workspaces (and build the enabled ones) before marking
      // ready, so the canvas appears already wired.
      await get().loadGraph()
      set({ initialized: true })

      // Autosave on any change (debounced). Bound once.
      if (!autosaveBound) {
        autosaveBound = true
        useAudioStore.subscribe(() => scheduleSave())
      }

      // Update devices when they change (e.g. plug/unplug) and auto-recover I/O.
      navigator.mediaDevices.addEventListener('devicechange', () => {
        get().refreshDevices().catch(console.error)
        audioEngine.recoverInputs().catch(console.error)
        audioEngine.recoverOutputs().catch(console.error)
      })
    },

    /** Rebuild all workspaces from persisted storage; build the enabled graphs. */
    loadGraph: async () => {
      if (graphLoaded) return
      graphLoaded = true
      const saved = loadWorkspaces()
      if (!saved || saved.workspaces.length === 0) {
        const id = genWorkspaceId()
        set({ workspaces: [{ id, name: 'Workspace 1', enabled: true, nodes: [], edges: [] }], activeWorkspaceId: id, nodes: [], edges: [] })
        return
      }
      nodeCounter = Math.max(saved.counter ?? 0, nodeCounter, maxIdTail(saved.workspaces.flatMap(w => w.nodes.map(n => n.id))))
      const workspaces = saved.workspaces.map(materializeWorkspace)
      await applyWorkspaces(workspaces, saved.activeId)
    },

    clearGraph: () => {
      const s = get()
      if (activeEnabled()) teardownEngine(s.nodes)
      set(st => ({
        nodes: [], edges: [],
        workspaces: st.workspaces.map(w => (w.id === st.activeWorkspaceId ? { ...w, nodes: [], edges: [] } : w))
      }))
      scheduleSave()
    },

    loadPreset: async (graph) => {
      const s = get()
      if (activeEnabled()) teardownEngine(s.nodes)
      nodeCounter = Math.max(nodeCounter, graph.counter ?? 0, maxIdTail(graph.nodes.map(n => n.id)))
      const { nodes, edges } = deserializeGraph(graph.nodes, graph.edges)
      if (activeEnabled()) await buildEngine(nodes, edges)
      set(st => ({
        nodes, edges,
        workspaces: st.workspaces.map(w => (w.id === st.activeWorkspaceId ? { ...w, nodes, edges } : w))
      }))
      scheduleSave()
    },

    exportConfig: () => {
      const s = get()
      const settings = useSettingsStore.getState()
      const workspaces: SavedWorkspace[] = flushActive(s).map(w => ({
        id: w.id, name: w.name, enabled: w.enabled,
        nodes: serializeNodes(w.nodes), edges: serializeEdges(w.edges)
      }))
      return {
        version: 2,
        workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
        counter: nodeCounter,
        theme: settings.theme,
        sidebarCollapsed: settings.sidebarCollapsed,
        nodeScale: settings.nodeScale
      }
    },

    importConfig: async (cfg) => {
      teardownAllEngines()

      let workspaces: Workspace[]
      let activeId: string
      if (Array.isArray(cfg.workspaces) && cfg.workspaces.length > 0) {
        workspaces = cfg.workspaces.map(materializeWorkspace)
        activeId = cfg.activeWorkspaceId ?? workspaces[0].id
        nodeCounter = Math.max(nodeCounter, cfg.counter ?? 0, maxIdTail(cfg.workspaces.flatMap(w => w.nodes.map(n => n.id))))
      } else if (cfg.graph?.nodes) {
        const id = genWorkspaceId()
        const { nodes, edges } = deserializeGraph(cfg.graph.nodes, cfg.graph.edges)
        workspaces = [{ id, name: 'Workspace 1', enabled: true, nodes, edges }]
        activeId = id
        nodeCounter = Math.max(nodeCounter, cfg.graph.counter ?? 0, maxIdTail(cfg.graph.nodes.map(n => n.id)))
      } else {
        const id = genWorkspaceId()
        workspaces = [{ id, name: 'Workspace 1', enabled: true, nodes: [], edges: [] }]
        activeId = id
      }

      await applyWorkspaces(workspaces, activeId)
      useSettingsStore.getState().importSettings({
        theme: cfg.theme,
        sidebarCollapsed: cfg.sidebarCollapsed,
        nodeScale: cfg.nodeScale
      })
      scheduleSave()
    },

    refreshDevices: async () => {
      const devices = await audioEngine.getDevices()
      set({ devices })
    }
  }
})
