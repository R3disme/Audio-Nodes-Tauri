import { create } from 'zustand'
import { nodeColor } from '@renderer/lib/nodeColors'
import { findCyclicEdgeIds } from '@renderer/lib/graphCycles'
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
  DEFAULT_FILTER,
  DEFAULT_LIMITER,
  DEFAULT_EXPANDER,
  DEFAULT_TREMOLO,
  DEFAULT_CRUSHER,
  type EQBand,
  type AudioNodeType
} from '@renderer/audio/AudioEngine'
import { audioEngine, ensureBackendAvailable, getActiveEngineKind } from '@renderer/audio/backend'

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
  /** Native per-process capture: park the app's own output while captured so it
   *  isn't heard twice (needs a virtual cable to park on). Default true. */
  takeover?: boolean
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

export interface FilterNodeData extends BaseNodeData {
  filterType: number   // 0 low-pass, 1 high-pass, 2 band-pass, 3 notch
  cutoff: number
  q: number
}

export interface LimiterNodeData extends BaseNodeData {
  threshold: number
  release: number
}

export interface ExpanderNodeData extends BaseNodeData {
  threshold: number
  ratio: number
  attack: number
  release: number
}

export interface TremoloNodeData extends BaseNodeData {
  mode: number   // 0 tremolo, 1 auto-pan
  shape: number  // 0 sine, 1 triangle
  rate: number
  depth: number
}

export interface BitcrusherNodeData extends BaseNodeData {
  bits: number
  downsample: number
  mix: number
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
  | FilterNodeData
  | LimiterNodeData
  | ExpanderNodeData
  | TremoloNodeData
  | BitcrusherNodeData
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
      return { idPrefix: 'app', data: { label: 'Application', sourceId: '', sourceName: '', takeover: true, channels: 1 } }
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
    case 'filter':
      return { idPrefix: 'filter', data: { label: 'Filter', filterType: DEFAULT_FILTER.type, cutoff: DEFAULT_FILTER.cutoff, q: DEFAULT_FILTER.q, channels: 1 } }
    case 'limiter':
      return { idPrefix: 'limiter', data: { label: 'Limiter', ...DEFAULT_LIMITER, channels: 1 } }
    case 'expander':
      return { idPrefix: 'exp', data: { label: 'Expander', ...DEFAULT_EXPANDER, channels: 1 } }
    case 'tremolo':
      return { idPrefix: 'trem', data: { label: 'Tremolo', ...DEFAULT_TREMOLO, channels: 1 } }
    case 'bitcrusher':
      return { idPrefix: 'crush', data: { label: 'Bitcrusher', ...DEFAULT_CRUSHER, channels: 1 } }
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
      await audioEngine.createInputNode(id, (data.deviceId as string) || undefined, data.deviceName as string | undefined)
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
    case 'application': {
      await audioEngine.createApplicationNode(id, '', (data.sourceName as string) || '')
      const sid = (data.sourceId as string) || ''
      if (sid.startsWith('pid:')) {
        // Native per-process capture. Pids churn across restarts, so re-resolve
        // the saved exe against the live session list (pid 0 = system audio is
        // stable and re-arms directly). On a Web Audio session a pid source
        // can't be armed — the user re-picks a window.
        if (getActiveEngineKind() === 'native') {
          const takeover = data.takeover !== false
          const exe = sid.split(':')[2] || ''
          if (!exe) {
            await audioEngine.armApplicationCapture(id, 'pid:0:', (data.sourceName as string) || 'System audio', takeover)
          } else {
            const apps = await window.api.audio.listAudioApps().catch(() => [] as AudioAppInfo[])
            const m = apps.find(a => a.exe.toLowerCase() === exe.toLowerCase())
            if (m) await audioEngine.armApplicationCapture(id, `pid:${m.pid}:${m.exe}`, (data.sourceName as string) || m.name, takeover)
          }
        }
      } else if (data.sourceName) {
        const m = await window.api.findSourceByName(data.sourceName as string)
        if (m) await audioEngine.armApplicationCapture(id, m.id, data.sourceName as string)
      }
      break
    }
    case 'output':
      audioEngine.createOutputNode(id, 'output')
      audioEngine.setGain(id, num(data.volume, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      // Open the device explicitly ('' ⇒ system default); the engine no longer
      // auto-opens output streams on create.
      await audioEngine.setOutputDevice(id, (data.deviceId as string) || '', data.deviceName as string | undefined)
      break
    case 'virtual':
      audioEngine.createOutputNode(id, 'virtual')
      audioEngine.setGain(id, num(data.volume, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      // Only open a stream once a real virtual cable is chosen — a device-less
      // Virtual Output stays silent rather than grabbing the default device (which
      // would contend with the Output node).
      if (data.deviceId) await audioEngine.setOutputDevice(id, data.deviceId as string, data.deviceName as string | undefined)
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
    case 'filter':
      audioEngine.createFilterNode(id, ch, {
        type: num(data.filterType, DEFAULT_FILTER.type), cutoff: num(data.cutoff, DEFAULT_FILTER.cutoff), q: num(data.q, DEFAULT_FILTER.q)
      })
      break
    case 'limiter':
      audioEngine.createLimiterNode(id, ch, { threshold: num(data.threshold, DEFAULT_LIMITER.threshold), release: num(data.release, DEFAULT_LIMITER.release) })
      break
    case 'expander':
      audioEngine.createExpanderNode(id, ch, {
        threshold: num(data.threshold, DEFAULT_EXPANDER.threshold), ratio: num(data.ratio, DEFAULT_EXPANDER.ratio),
        attack: num(data.attack, DEFAULT_EXPANDER.attack), release: num(data.release, DEFAULT_EXPANDER.release)
      })
      break
    case 'tremolo':
      audioEngine.createTremoloNode(id, ch, {
        mode: num(data.mode, DEFAULT_TREMOLO.mode), shape: num(data.shape, DEFAULT_TREMOLO.shape),
        rate: num(data.rate, DEFAULT_TREMOLO.rate), depth: num(data.depth, DEFAULT_TREMOLO.depth)
      })
      break
    case 'bitcrusher':
      audioEngine.createBitcrusherNode(id, ch, {
        bits: num(data.bits, DEFAULT_CRUSHER.bits), downsample: num(data.downsample, DEFAULT_CRUSHER.downsample), mix: num(data.mix, DEFAULT_CRUSHER.mix)
      })
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

/**
 * Recompute feedback-cycle flags for `edges` and restyle them: edges on a cycle
 * (which the engine silences) are painted with the warning color + dashed, the
 * rest fall back to their source node's accent. Call this after any edge add/remove
 * so the flag stays in sync with the topology. Cheap (graphs are small).
 */
function applyCycleStyles(nodes: AudioFlowNode[], edges: AudioFlowEdge[]): AudioFlowEdge[] {
  // Proxy edges (collapsed-group connectors) aren't part of the audio graph — they
  // keep their own dashed style and never participate in cycle detection.
  const real = edges.filter(e => !isProxyEdge(e))
  const cyclic = findCyclicEdgeIds(real)
  return edges.map(e => {
    if (isProxyEdge(e)) return e
    const isCyclic = cyclic.has(e.id)
    const base = edgeStrokeFor(nodes.find(n => n.id === e.source))
    return {
      ...e,
      data: { ...(e.data ?? {}), cyclic: isCyclic },
      style: {
        ...e.style,
        stroke: isCyclic ? 'var(--edge-cyclic, #ef4444)' : base,
        strokeWidth: 2,
        strokeDasharray: isCyclic ? '6 4' : undefined
      }
    } as AudioFlowEdge
  })
}

// ── Collapsed-group edge proxies ─────────────────────────────────────────────
// A collapsed group hides its members, so React Flow can't draw the real edges
// that touch them. To keep connections that cross the group boundary *visible*,
// we hide those real edges and add display-only **proxy** edges that anchor the
// hidden endpoint to the group container's handles. Proxies are marked
// `data.proxy` and are skipped by the engine, persistence and cycle detection.
const PROXY_PREFIX = 'proxy-'

export function isProxyEdge(e: AudioFlowEdge): boolean {
  return e.id.startsWith(PROXY_PREFIX) || !!(e.data as { proxy?: boolean } | undefined)?.proxy
}

/**
 * Recompute edge visibility + proxies from the current collapsed-group state.
 * Strips any existing proxies, hides real edges touching a hidden member, and
 * adds one proxy per boundary-crossing connection (deduped by endpoint pair).
 * Pure — returns a new edge array.
 */
function recomputeGroupVisibility(nodes: AudioFlowNode[], edges: AudioFlowEdge[]): AudioFlowEdge[] {
  const collapsed = new Set(
    nodes.filter(n => n.type === 'subgraph' && (n.data as { collapsed?: boolean } | undefined)?.collapsed).map(n => n.id)
  )
  // hidden member id → its collapsed group id
  const memberGroup = new Map<string, string>()
  if (collapsed.size > 0) {
    for (const n of nodes) {
      if (n.parentId && collapsed.has(n.parentId)) memberGroup.set(n.id, n.parentId)
    }
  }

  const real = edges.filter(e => !isProxyEdge(e))
  if (memberGroup.size === 0) {
    // Nothing collapsed: just make sure no real edge is left hidden.
    return real.map(e => (e.hidden ? { ...e, hidden: false } : e))
  }

  const out: AudioFlowEdge[] = []
  const seen = new Set<string>()
  for (const e of real) {
    const sHidden = memberGroup.has(e.source)
    const tHidden = memberGroup.has(e.target)
    if (!sHidden && !tHidden) {
      out.push(e.hidden ? { ...e, hidden: false } : e)
      continue
    }
    // Touches a hidden member → hide the real edge.
    out.push({ ...e, hidden: true })
    // Resolve each hidden endpoint to its (visible) group container.
    const src = sHidden ? memberGroup.get(e.source)! : e.source
    const tgt = tHidden ? memberGroup.get(e.target)! : e.target
    if (src === tgt) continue // fully internal to one collapsed group — no connector
    const srcHandle = sHidden ? 'group-source' : e.sourceHandle
    const tgtHandle = tHidden ? 'group-target' : e.targetHandle
    const key = `${src}:${srcHandle}>${tgt}:${tgtHandle}`
    if (seen.has(key)) continue // collapse parallel crossings into one connector
    seen.add(key)
    out.push({
      id: PROXY_PREFIX + e.id,
      source: src,
      target: tgt,
      sourceHandle: srcHandle,
      targetHandle: tgtHandle,
      data: { proxy: true },
      selectable: false,
      deletable: false,
      style: { stroke: 'var(--c-accent)', strokeWidth: 2, strokeDasharray: '5 4', opacity: 0.85 }
    } as AudioFlowEdge)
  }
  return out
}

/**
 * When `subgraph` group nodes are about to be removed, release their children:
 * restore absolute positions and clear `parentId`/`extent` so React Flow is never
 * left with a child pointing at a deleted parent (which breaks rendering). Returns the
 * node list with children released; the caller still removes the group nodes themselves.
 */
function releaseGroupChildren(nodes: AudioFlowNode[], removedIds: Set<string>): AudioFlowNode[] {
  const removedGroups = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    if (removedIds.has(n.id) && n.type === 'subgraph') removedGroups.set(n.id, n.position)
  }
  if (removedGroups.size === 0) return nodes
  return nodes.map(n => {
    const origin = n.parentId ? removedGroups.get(n.parentId) : undefined
    if (!origin) return n
    return {
      ...n,
      parentId: undefined,
      extent: undefined,
      hidden: false,
      position: { x: n.position.x + origin.x, y: n.position.y + origin.y }
    }
  })
}

/** Rehydrate plain saved nodes/edges into React Flow objects (no engine work). */
function deserializeGraph(savedNodes: SavedNode[], savedEdges: SavedEdge[]): { nodes: AudioFlowNode[]; edges: AudioFlowEdge[] } {
  const nodes = savedNodes.map(n => {
    const node: Record<string, unknown> = { id: n.id, type: n.type, position: n.position, data: n.data }
    if (n.parentId) { node.parentId = n.parentId; node.extent = 'parent' }
    if (typeof n.width === 'number' || typeof n.height === 'number') {
      node.style = { ...(n.width != null ? { width: n.width } : {}), ...(n.height != null ? { height: n.height } : {}) }
    }
    return node
  }) as AudioFlowNode[]
  // React Flow requires a parent node to precede its children in the array.
  nodes.sort((a, b) => Number(b.type === 'subgraph') - Number(a.type === 'subgraph'))

  // Re-apply collapsed-group visibility: hide member nodes (their edges + proxy
  // connectors are recomputed below).
  for (const g of nodes) {
    if (g.type === 'subgraph' && (g.data as Record<string, unknown>)?.collapsed) {
      for (const c of nodes) {
        if (c.parentId === g.id) c.hidden = true
      }
    }
  }

  let edges = savedEdges.map(e => {
    const srcNode = savedNodes.find(n => n.id === e.source)
    return {
      id: e.id, source: e.source, target: e.target,
      sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
      style: { stroke: edgeStrokeFor(srcNode), strokeWidth: 2 }
    }
  }) as AudioFlowEdge[]
  edges = applyCycleStyles(nodes, edges)
  // Re-create collapsed-group edge visibility + proxy connectors.
  edges = recomputeGroupVisibility(nodes, edges)
  // Flag any feedback cycles in the loaded graph so they paint as warnings.
  return { nodes, edges }
}

function materializeWorkspace(w: SavedWorkspace): Workspace {
  const { nodes, edges } = deserializeGraph(w.nodes, w.edges)
  return { id: w.id, name: w.name, enabled: w.enabled, nodes, edges }
}

/** Build engine nodes + connections for a graph (used when a workspace activates). */
async function buildEngine(nodes: AudioFlowNode[], edges: AudioFlowEdge[]): Promise<void> {
  for (const n of nodes) {
    if (n.type === 'subgraph') continue // visual container — no engine node
    try {
      await rebuildEngineNode(n.type ?? '', n.id, n.data as Record<string, unknown>)
    } catch (e) {
      console.warn('Failed to build node', n.id, e)
    }
  }
  for (const e of edges) {
    if (isProxyEdge(e)) continue // display-only collapsed-group connector
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

  // ── Grouping (visual sub-graphs; the audio graph is unchanged) ──
  /** Collapse the current node selection into a movable group container. */
  groupSelection: () => void
  /** Dissolve a group, restoring its members to absolute positions. */
  ungroup: (groupId: string) => void
  /** Collapse/expand a group (hides its members + their edges when collapsed). */
  toggleGroupCollapsed: (groupId: string) => void

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
      set(s => {
        const removed = new Set(changes.filter(c => c.type === 'remove').map(c => c.id))
        // Release any deleted group's children before the group is removed.
        const base = removed.size ? releaseGroupChildren(s.nodes, removed) : s.nodes
        return { nodes: applyNodeChanges(changes, base) as AudioFlowNode[] }
      })
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
      set(s => ({ edges: applyCycleStyles(s.nodes, applyEdgeChanges(changes, s.edges)) }))
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
        edges: applyCycleStyles(
          s.nodes,
          addEdge(
            {
              ...connection,
              id: `${connection.source}:${srcCh}->${connection.target}:${tgtCh}`,
              style: { stroke, strokeWidth: 2 }
            },
            s.edges
          )
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
      set(s => {
        // If `id` is a group, release its children first so none are left orphaned.
        const released = releaseGroupChildren(s.nodes, new Set([id]))
        const nodes = released.filter(n => n.id !== id)
        const edges = s.edges.filter(e => e.source !== id && e.target !== id)
        return { nodes, edges: applyCycleStyles(nodes, edges) }
      })
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
          return { nodes, edges: applyCycleStyles(nodes, edges) }
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
        return { nodes, edges: applyCycleStyles(nodes, edges) }
      })
    },

    /** Override a single node's accent color (null clears it), recoloring its edges. */
    setNodeColor: (id, color) => {
      set(s => {
        const nodes = s.nodes.map(n =>
          n.id === id ? { ...n, data: { ...n.data, color: color ?? undefined } as AudioNodeData & Record<string, unknown> } : n
        )
        // Recompute every edge's stroke (picks up the new accent) and keep cyclic
        // edges painted as warnings rather than recoloring them to the accent.
        const edges = applyCycleStyles(nodes, s.edges)
        return { nodes, edges }
      })
    },

    // ── Grouping (visual sub-graphs) ────────────────────────────────────────────
    // A `group` node is a movable container; members get `parentId` so they move with
    // it and clip to it. The audio engine never sees group nodes (buildEngine skips
    // them), so grouping is purely organizational — connections keep working.

    groupSelection: () => {
      set(s => {
        const members = s.nodes.filter(n => n.selected && n.type !== 'subgraph' && !n.parentId)
        if (members.length < 2) return {}
        const PAD = 28
        const HEADER = 30
        const dim = (n: AudioFlowNode): { w: number; h: number } => ({
          w: n.measured?.width ?? 220,
          h: n.measured?.height ?? 120
        })
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of members) {
          const { w, h } = dim(n)
          minX = Math.min(minX, n.position.x)
          minY = Math.min(minY, n.position.y)
          maxX = Math.max(maxX, n.position.x + w)
          maxY = Math.max(maxY, n.position.y + h)
        }
        const originX = minX - PAD
        const originY = minY - PAD - HEADER
        const width = (maxX - minX) + PAD * 2
        const height = (maxY - minY) + PAD * 2 + HEADER
        const gid = nextId('subgraph')
        const memberIds = new Set(members.map(m => m.id))
        const groupNode = {
          id: gid,
          type: 'subgraph',
          position: { x: originX, y: originY },
          data: { label: 'Group', collapsed: false, expandedWidth: width, expandedHeight: height },
          style: { width, height },
          selected: false
        } as unknown as AudioFlowNode
        const updated = s.nodes.map(n =>
          memberIds.has(n.id)
            ? {
                ...n,
                parentId: gid,
                extent: 'parent' as const,
                selected: false,
                position: { x: n.position.x - originX, y: n.position.y - originY }
              }
            : n
        )
        // Group must precede its children in the array (React Flow requirement).
        return { nodes: [groupNode, ...updated] }
      })
    },

    ungroup: (groupId) => {
      set(s => {
        const group = s.nodes.find(n => n.id === groupId && n.type === 'subgraph')
        if (!group) return {}
        const ox = group.position.x
        const oy = group.position.y
        const nodes = s.nodes
          .filter(n => n.id !== groupId)
          .map(n =>
            n.parentId === groupId
              ? {
                  ...n,
                  parentId: undefined,
                  extent: undefined,
                  hidden: false,
                  position: { x: n.position.x + ox, y: n.position.y + oy }
                }
              : n
          )
        // The group is gone, so recompute proxies/visibility from scratch (drops
        // this group's connectors and unhides its members' real edges).
        const edges = recomputeGroupVisibility(nodes, s.edges)
        return { nodes, edges }
      })
    },

    toggleGroupCollapsed: (groupId) => {
      set(s => {
        const group = s.nodes.find(n => n.id === groupId && n.type === 'subgraph')
        if (!group) return {}
        const data = group.data as Record<string, unknown>
        const collapsed = !data.collapsed
        const memberIds = new Set(s.nodes.filter(n => n.parentId === groupId).map(n => n.id))
        const style = group.style as { width?: number; height?: number } | undefined
        const expandedWidth = (data.expandedWidth as number) ?? style?.width ?? 240
        const expandedHeight = (data.expandedHeight as number) ?? style?.height ?? 160
        const nodes = s.nodes.map(n => {
          if (n.id === groupId) {
            return {
              ...n,
              data: { ...data, collapsed, expandedWidth, expandedHeight },
              // Collapsed: shrink to the header (no height → sizes to content).
              style: collapsed ? { width: 200 } : { width: expandedWidth, height: expandedHeight }
            } as unknown as AudioFlowNode
          }
          if (memberIds.has(n.id)) return { ...n, hidden: collapsed }
          return n
        })
        // Hide real edges touching members + (when collapsing) add boundary
        // connectors so connections leaving the group stay visible.
        const edges = recomputeGroupVisibility(nodes, s.edges)
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
      // Apply the persisted latency + device modes now the engine is up (native; Web
      // Audio no-ops). Device mode must be set before any output stream opens.
      audioEngine.setLatencyMode(useSettingsStore.getState().latencyMode)
      audioEngine.setDeviceMode(useSettingsStore.getState().deviceMode)
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
