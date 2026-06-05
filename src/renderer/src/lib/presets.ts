// ────────────────────────────────────────────────────────────────────────────
// Starter presets — serialized graphs loaded via audioStore.loadPreset().
// Built with a small spec helper so the wiring stays readable.
// ────────────────────────────────────────────────────────────────────────────

import type { SavedGraph, SavedNode, SavedEdge } from './graphPersistence'
import {
  DEFAULT_EQ_BANDS, DEFAULT_REVERB, DEFAULT_DELAY, DEFAULT_CHORUS, DEFAULT_DISTORTION, DEFAULT_PAN
} from '@renderer/audio/AudioEngine'

type Data = Record<string, unknown>

function dataFor(type: string, overrides: Data = {}): Data {
  const base: Data = { channels: 1 }
  switch (type) {
    case 'input':       return { ...base, label: 'Input', deviceId: '', deviceName: 'Default', gain: 1, muted: false, ...overrides }
    case 'application': return { ...base, label: 'Application', sourceId: '', sourceName: '', ...overrides }
    case 'output':      return { ...base, label: 'Output', deviceId: '', deviceName: 'Default', volume: 1, muted: false, ...overrides }
    case 'virtual':     return { ...base, label: 'Virtual Output', deviceId: '', deviceName: '', volume: 1, muted: false, ...overrides }
    case 'volume':      return { ...base, label: 'Volume', gain: 1, muted: false, ...overrides }
    case 'eq':          return { ...base, label: 'Equalizer', bands: structuredClone(DEFAULT_EQ_BANDS), ...overrides }
    case 'compressor':  return { ...base, label: 'Compressor', threshold: -24, knee: 6, ratio: 4, attack: 0.003, release: 0.25, ...overrides }
    case 'gate':        return { ...base, label: 'Gate', threshold: -50, attack: 0.005, release: 0.1, ...overrides }
    case 'pan':         return { ...base, label: 'Pan', ...DEFAULT_PAN, ...overrides }
    case 'reverb':      return { ...base, label: 'Reverb', ...DEFAULT_REVERB, ...overrides }
    case 'delay':       return { ...base, label: 'Delay', ...DEFAULT_DELAY, ...overrides }
    case 'chorus':      return { ...base, label: 'Chorus', ...DEFAULT_CHORUS, ...overrides }
    case 'distortion':  return { ...base, label: 'Distortion', ...DEFAULT_DISTORTION, ...overrides }
    case 'mixer':       return {
      ...base, label: 'Mixer', channelCount: 4, channels: 4, masterGain: 1,
      channels_state: Array.from({ length: 4 }, (_, i) => ({ gain: 1, muted: false, label: `Ch ${i + 1}` })), ...overrides
    }
    default: return { ...base, label: type, ...overrides }
  }
}

interface NodeSpec { key: string; type: string; x: number; y: number; data?: Data }
type EdgeSpec = [from: string, outCh: number, to: string, inCh: number]

function build(nodes: NodeSpec[], edges: EdgeSpec[]): SavedGraph {
  const idByKey: Record<string, string> = {}
  let counter = 0
  const builtNodes: SavedNode[] = nodes.map(n => {
    const id = `${n.type}_${++counter}`
    idByKey[n.key] = id
    return { id, type: n.type, position: { x: n.x, y: n.y }, data: dataFor(n.type, n.data) }
  })
  const builtEdges: SavedEdge[] = edges.map(([fk, oc, tk, ic]) => ({
    id: `${idByKey[fk]}:${oc}->${idByKey[tk]}:${ic}`,
    source: idByKey[fk], target: idByKey[tk], sourceHandle: `out-${oc}`, targetHandle: `in-${ic}`
  }))
  return { nodes: builtNodes, edges: builtEdges, counter }
}

export interface Preset {
  id: string
  name: string
  description: string
  build: () => SavedGraph
}

export const PRESETS: Preset[] = [
  {
    id: 'mic-monitor',
    name: 'Mic → Speakers',
    description: 'A microphone with gain, straight to your output.',
    build: () => build(
      [
        { key: 'in', type: 'input', x: 80, y: 160 },
        { key: 'vol', type: 'volume', x: 360, y: 160 },
        { key: 'out', type: 'output', x: 640, y: 160 }
      ],
      [['in', 0, 'vol', 0], ['vol', 0, 'out', 0]]
    )
  },
  {
    id: 'podcast',
    name: 'Podcast vocal chain',
    description: 'Gate → EQ → Compressor → Volume for a clean spoken-word sound.',
    build: () => build(
      [
        { key: 'in', type: 'input', x: 60, y: 200 },
        { key: 'gate', type: 'gate', x: 320, y: 180 },
        { key: 'eq', type: 'eq', x: 600, y: 160 },
        { key: 'comp', type: 'compressor', x: 900, y: 180 },
        { key: 'vol', type: 'volume', x: 1200, y: 200 },
        { key: 'out', type: 'output', x: 1440, y: 200 }
      ],
      [['in', 0, 'gate', 0], ['gate', 0, 'eq', 0], ['eq', 0, 'comp', 0], ['comp', 0, 'vol', 0], ['vol', 0, 'out', 0]]
    )
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    description: 'Mic with reverb + echo, mixed with app/music audio to your speakers.',
    build: () => build(
      [
        { key: 'mic', type: 'input', x: 60, y: 80, data: { label: 'Mic' } },
        { key: 'rev', type: 'reverb', x: 340, y: 60 },
        { key: 'echo', type: 'delay', x: 620, y: 60, data: { label: 'Echo' } },
        { key: 'music', type: 'application', x: 60, y: 380, data: { label: 'Music' } },
        { key: 'mix', type: 'mixer', x: 920, y: 200 },
        { key: 'out', type: 'output', x: 1280, y: 200 }
      ],
      [['mic', 0, 'rev', 0], ['rev', 0, 'echo', 0], ['echo', 0, 'mix', 0], ['music', 0, 'mix', 1], ['mix', 0, 'out', 0]]
    )
  },
  {
    id: 'stream',
    name: 'Streaming mix',
    description: 'Mic (compressed) + app audio → mixer → speakers and a virtual cable.',
    build: () => build(
      [
        { key: 'mic', type: 'input', x: 60, y: 100, data: { label: 'Mic' } },
        { key: 'comp', type: 'compressor', x: 340, y: 80 },
        { key: 'app', type: 'application', x: 60, y: 360, data: { label: 'Game / App' } },
        { key: 'mix', type: 'mixer', x: 680, y: 200 },
        { key: 'out', type: 'output', x: 1040, y: 120 },
        { key: 'virt', type: 'virtual', x: 1040, y: 360 }
      ],
      [['mic', 0, 'comp', 0], ['comp', 0, 'mix', 0], ['app', 0, 'mix', 1], ['mix', 0, 'out', 0], ['mix', 0, 'virt', 0]]
    )
  }
]
