import { create } from 'zustand'
import { nodeColor } from '@renderer/lib/nodeColors'
import { saveGraph, loadGraph as loadSavedGraph } from '@renderer/lib/graphPersistence'
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
  audioEngine,
  DEFAULT_EQ_BANDS,
  DEFAULT_REVERB,
  DEFAULT_DELAY,
  DEFAULT_CHORUS,
  DEFAULT_DISTORTION,
  DEFAULT_PAN,
  type EQBand,
  type AudioNodeType
} from '@renderer/audio/AudioEngine'

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

export type AudioFlowNode = Node<AudioNodeData & Record<string, unknown>>
export type AudioFlowEdge = Edge

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

const centerOffset = (): XYPosition => ({
  x: 220 + Math.random() * 320,
  y: 80 + Math.random() * 240
})

// ── Persistence wiring ──────────────────────────────────────────────────────

let graphLoaded = false
let autosaveBound = false
let saveTimer: number | undefined

/** Debounced save of the current graph (positions, params, connections). */
function scheduleSave(): void {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const { nodes, edges } = useAudioStore.getState()
    saveGraph(nodes, edges, nodeCounter)
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
    case 'application':
      await audioEngine.createApplicationNode(id, '', (data.sourceName as string) || '')
      if (data.sourceName) {
        const m = await window.api.findSourceByName(data.sourceName as string)
        if (m) await audioEngine.armApplicationCapture(id, m.id, data.sourceName as string)
      }
      break
    case 'output':
    case 'virtual':
      audioEngine.createOutputNode(id, type === 'virtual' ? 'virtual' : 'output')
      audioEngine.setGain(id, num(data.volume, 1))
      if (data.muted) audioEngine.muteNode(id, true)
      if (data.deviceId) await audioEngine.setOutputDevice(id, data.deviceId as string)
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

interface AudioStore {
  nodes: AudioFlowNode[]
  edges: AudioFlowEdge[]
  devices: { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }
  initialized: boolean

  onNodesChange: OnNodesChange<AudioFlowNode>
  onEdgesChange: OnEdgesChange
  onConnect: OnConnect

  addNode: (type: string, position?: XYPosition) => Promise<void>
  removeNode: (id: string) => void
  updateNodeData: (id: string, data: Partial<AudioNodeData>) => void
  setNodeChannels: (id: string, type: AudioNodeType, channels: number) => void

  initAudio: () => Promise<void>
  loadGraph: () => Promise<void>
  refreshDevices: () => Promise<void>
}

export const useAudioStore = create<AudioStore>((set, get) => ({
  nodes: [],
  edges: [],
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

    const ok = audioEngine.connect(connection.source, srcCh, connection.target, tgtCh)
    if (!ok) return

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
    const pos = position ?? centerOffset()

    switch (type) {
      case 'input': {
        const id = nextId('input')
        await audioEngine.createInputNode(id)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'input', position: pos,
            data: { label: 'Input', deviceId: '', deviceName: 'Default', gain: 1, muted: false, channels: 1 } as InputNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'application': {
        const id = nextId('app')
        // We start the node empty — the user picks a source from the AppPicker
        // which then calls back into createApplicationNode. So just register
        // a placeholder pass-through here.
        await audioEngine.createApplicationNode(id, '', '')
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'application', position: pos,
            data: { label: 'Application', sourceId: '', sourceName: '', channels: 1 } as ApplicationNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'output': {
        const id = nextId('output')
        audioEngine.createOutputNode(id, 'output')
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'output', position: pos,
            data: { label: 'Output', deviceId: '', deviceName: 'Default', volume: 1, muted: false, channels: 1 } as OutputNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'virtual': {
        const id = nextId('virtual')
        audioEngine.createOutputNode(id, 'virtual')
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'virtual', position: pos,
            data: { label: 'Virtual Output', deviceId: '', deviceName: 'Default', volume: 1, muted: false, channels: 1 } as OutputNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'volume': {
        const id = nextId('volume')
        audioEngine.createVolumeNode(id, 1)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'volume', position: pos,
            data: { label: 'Volume', gain: 1, muted: false, channels: 1 } as VolumeNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'eq': {
        const id = nextId('eq')
        audioEngine.createEQNode(id, 1)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'eq', position: pos,
            data: { label: 'Equalizer', bands: structuredClone(DEFAULT_EQ_BANDS), channels: 1 } as EQNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'compressor': {
        const id = nextId('comp')
        audioEngine.createCompressorNode(id, 1)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'compressor', position: pos,
            data: { label: 'Compressor', threshold: -24, knee: 6, ratio: 4, attack: 0.003, release: 0.25, channels: 1 } as CompressorNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'gate': {
        const id = nextId('gate')
        audioEngine.createGateNode(id, 1)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'gate', position: pos,
            data: { label: 'Gate', threshold: -50, attack: 0.005, release: 0.1, channels: 1 } as GateNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'reverb': {
        const id = nextId('reverb')
        audioEngine.createReverbNode(id, 1, DEFAULT_REVERB)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'reverb', position: pos,
            data: { label: 'Reverb', ...DEFAULT_REVERB, channels: 1 } as ReverbNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'delay': {
        const id = nextId('delay')
        audioEngine.createDelayNode(id, 1, DEFAULT_DELAY)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'delay', position: pos,
            data: { label: 'Delay', ...DEFAULT_DELAY, channels: 1 } as DelayNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'chorus': {
        const id = nextId('chorus')
        audioEngine.createChorusNode(id, 1, DEFAULT_CHORUS)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'chorus', position: pos,
            data: { label: 'Chorus', ...DEFAULT_CHORUS, channels: 1 } as ChorusNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'distortion': {
        const id = nextId('dist')
        audioEngine.createDistortionNode(id, 1, DEFAULT_DISTORTION)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'distortion', position: pos,
            data: { label: 'Distortion', ...DEFAULT_DISTORTION, channels: 1 } as DistortionNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'pan': {
        const id = nextId('pan')
        audioEngine.createPanNode(id, 1, DEFAULT_PAN)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'pan', position: pos,
            data: { label: 'Pan', ...DEFAULT_PAN, channels: 1 } as PanNodeData
          } as AudioFlowNode]
        }))
        break
      }
      case 'mixer': {
        const id = nextId('mixer')
        const channelCount = 4
        audioEngine.createMixerNode(id, channelCount)
        set(s => ({
          nodes: [...s.nodes, {
            id, type: 'mixer', position: pos,
            data: {
              label: 'Mixer',
              channelCount,
              channels: channelCount,
              masterGain: 1,
              channels_state: Array.from({ length: channelCount }, (_, i) => ({
                gain: 1, muted: false, label: `Ch ${i + 1}`
              }))
            } as MixerNodeData
          } as AudioFlowNode]
        }))
        break
      }
    }
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
   * exists. Type-specific recreation is delegated to the audio engine.
   */
  setNodeChannels: (id, type, channels) => {
    channels = Math.max(1, Math.min(8, Math.round(channels)))
    const lostEdges = audioEngine.getConnectionsBeyondChannel(id, channels)
    const actualChannels = audioEngine.setChannelCount(id, type, channels)

    set(s => {
      const nodes = s.nodes.map(n =>
        n.id === id ? { ...n, data: { ...n.data, channels: actualChannels } } : n
      )
      const edges = s.edges.filter(e => {
        // Drop edges that hit channels beyond the new count
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

  // ── Audio initialization ───────────────────────────────────────────────

  initAudio: async () => {
    await audioEngine.init()
    const devices = await audioEngine.getDevices()
    set({ devices })

    // Restore the saved graph (positions, params, connections) before marking
    // ready, so the canvas appears already wired.
    await get().loadGraph()
    set({ initialized: true })

    // Autosave the graph on any change (debounced). Bound once.
    if (!autosaveBound) {
      autosaveBound = true
      useAudioStore.subscribe(() => scheduleSave())
    }

    // Update devices when they change (e.g. plug/unplug)
    navigator.mediaDevices.addEventListener('devicechange', () => {
      get().refreshDevices().catch(console.error)
    })
  },

  /** Rebuild the engine graph + React Flow state from persisted storage. */
  loadGraph: async () => {
    if (graphLoaded) return
    graphLoaded = true
    const saved = loadSavedGraph()
    if (!saved || saved.nodes.length === 0) return

    // Continue id numbering past the restored nodes to avoid collisions.
    const maxFromIds = saved.nodes.reduce((max, n) => {
      const tail = parseInt(n.id.split('_').pop() ?? '0', 10)
      return Number.isFinite(tail) ? Math.max(max, tail) : max
    }, 0)
    nodeCounter = Math.max(saved.counter ?? 0, maxFromIds)

    // Recreate engine nodes first…
    for (const n of saved.nodes) {
      try {
        await rebuildEngineNode(n.type, n.id, n.data)
      } catch (e) {
        console.warn('Failed to restore node', n.id, e)
      }
    }

    // …then reconnect the edges that are still valid.
    const edges: AudioFlowEdge[] = []
    for (const e of saved.edges) {
      const src = parseHandle(e.sourceHandle)
      const tgt = parseHandle(e.targetHandle)
      const ok = audioEngine.connect(e.source, src?.channel ?? 0, e.target, tgt?.channel ?? 0)
      if (!ok) continue
      const srcType = saved.nodes.find(n => n.id === e.source)?.type
      edges.push({
        id: e.id, source: e.source, target: e.target,
        sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
        style: { stroke: nodeColor(srcType), strokeWidth: 2 }
      })
    }

    const nodes = saved.nodes.map(n => ({
      id: n.id, type: n.type, position: n.position, data: n.data
    })) as AudioFlowNode[]
    set({ nodes, edges })
  },

  refreshDevices: async () => {
    const devices = await audioEngine.getDevices()
    set({ devices })
  }
}))
