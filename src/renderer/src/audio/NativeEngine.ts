// ────────────────────────────────────────────────────────────────────────────
// NativeEngine
//
// Renderer-side proxy for the Rust audio engine. Implements the `AudioBackend`
// contract by forwarding to the native addon over IPC (`window.api.audio.*`,
// bridged in src/main/index.ts). Control calls are one-way; meters are polled
// each frame and dispatched to the same `subscribeMeter` subscribers the Web
// Audio engine uses, so VUMeter.tsx is unchanged.
//
// Phase 1 scope: input → [volume] → output with VU meters. Effect node types
// (eq, gate, reverb, …) are created as transparent passthrough in the engine —
// their parameter setters here are no-ops until those DSP nodes are ported.
// ────────────────────────────────────────────────────────────────────────────

import type { AudioBackend } from './AudioBackend'
import type {
  AudioNodeType,
  EQBand,
  ReverbParams,
  DelayParams,
  ChorusParams,
  DistortionParams,
  PanParams
} from './AudioEngine'

class NativeEngine implements AudioBackend {
  private initialized = false
  private meterSubs = new Map<string, Set<(db: number) => void>>()
  private rafId: number | null = null

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const info = await window.api.audio.info()
      if (info) {
        console.info(`[native engine] addon v${info.version} (${info.backend}); audioReady=${info.audioReady}`)
      } else {
        console.warn('[native engine] addon not built — run "npm run build:native". Native mode produces no audio.')
      }
    } catch (e) {
      console.warn('[native engine] init failed:', e)
    }
    this.startMeterLoop()
  }

  getLatencyMs(): number {
    return 0
  }

  // ── Meters: poll the addon each frame, dispatch to DOM subscribers ─────────

  private startMeterLoop(): void {
    if (this.rafId !== null) return
    let busy = false
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick)
      if (busy || this.meterSubs.size === 0) return
      busy = true
      window.api.audio
        .pollMeters()
        .then((frame) => {
          busy = false
          for (const [key, subs] of this.meterSubs) {
            const db = frame[key]
            if (db === undefined) continue
            for (const cb of subs) cb(db)
          }
        })
        .catch(() => {
          busy = false
        })
    }
    this.rafId = requestAnimationFrame(tick)
  }

  subscribeMeter(key: string, cb: (db: number) => void): () => void {
    let set = this.meterSubs.get(key)
    if (!set) {
      set = new Set()
      this.meterSubs.set(key, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  subscribeNodeChanges(_cb: () => void): () => void {
    return () => {}
  }

  getCompressorReduction(_id: string, _channel = 0): number {
    return 0
  }

  // ── Input / application ───────────────────────────────────────────────────

  async createInputNode(id: string, deviceId?: string): Promise<void> {
    window.api.audio.createNode(id, 'input', 1, deviceId ?? '')
  }

  isInputActive(_id: string): boolean {
    return true
  }

  async recoverInputs(): Promise<void> {}

  async createApplicationNode(id: string, _sourceId: string, _sourceName: string): Promise<void> {
    // Per-app loopback capture lands in Phase 3; for now the node is a silent
    // passthrough so the graph stays valid.
    window.api.audio.createNode(id, 'application', 1, '')
  }

  async armApplicationCapture(_id: string, _sourceId: string, _sourceName: string): Promise<void> {}

  isApplicationActive(_id: string): boolean {
    return false
  }

  // ── Output ──────────────────────────────────────────────────────────────

  createOutputNode(id: string, type: 'output' | 'virtual' = 'output'): void {
    window.api.audio.createNode(id, type, 1, '')
  }

  async setOutputDevice(id: string, deviceId: string): Promise<void> {
    window.api.audio.setOutputDevice(id, deviceId)
  }

  async recoverOutputs(): Promise<void> {}

  // ── Node creation (effects are passthrough in the engine for now) ──────────

  createVolumeNode(id: string, channels = 1): void {
    window.api.audio.createNode(id, 'volume', channels, '')
  }

  createEQNode(id: string, channels = 1, _bands?: EQBand[]): void {
    window.api.audio.createNode(id, 'eq', channels, '')
  }

  createCompressorNode(id: string, channels = 1): void {
    window.api.audio.createNode(id, 'compressor', channels, '')
  }

  createGateNode(id: string, channels = 1): void {
    window.api.audio.createNode(id, 'gate', channels, '')
  }

  createMixerNode(id: string, _channels = 4): void {
    // One output meter; the engine treats the mixer as a passthrough for now.
    window.api.audio.createNode(id, 'mixer', 1, '')
  }

  createReverbNode(id: string, channels = 1, _params?: ReverbParams): void {
    window.api.audio.createNode(id, 'reverb', channels, '')
  }

  createDelayNode(id: string, channels = 1, _params?: DelayParams): void {
    window.api.audio.createNode(id, 'delay', channels, '')
  }

  createChorusNode(id: string, channels = 1, _params?: ChorusParams): void {
    window.api.audio.createNode(id, 'chorus', channels, '')
  }

  createDistortionNode(id: string, channels = 1, _params?: DistortionParams): void {
    window.api.audio.createNode(id, 'distortion', channels, '')
  }

  createPanNode(id: string, channels = 1, _params?: PanParams): void {
    window.api.audio.createNode(id, 'pan', channels, '')
  }

  // ── Parameter updates ──────────────────────────────────────────────────

  setGain(id: string, linearGain: number, _channel?: number): void {
    window.api.audio.setGain(id, linearGain)
  }

  muteNode(id: string, muted: boolean): void {
    window.api.audio.setMuted(id, muted)
  }

  // Effect parameters are no-ops until the DSP nodes are ported (Phase 2).
  setEQBand(_id: string, _bandIndex: number, _gain: number): void {}
  setCompressor(
    _id: string,
    _params: Partial<{ threshold: number; knee: number; ratio: number; attack: number; release: number }>
  ): void {}
  setGate(_id: string, _params: Partial<{ threshold: number; attack: number; release: number }>): void {}
  setMixerChannel(_id: string, _channel: number, _gain: number): void {}
  setMixerMaster(id: string, gain: number): void {
    window.api.audio.setGain(id, gain)
  }
  setReverb(_id: string, _params: Partial<ReverbParams>): void {}
  setDelay(_id: string, _params: Partial<DelayParams>): void {}
  setChorus(_id: string, _params: Partial<ChorusParams>): void {}
  setDistortion(_id: string, _params: Partial<DistortionParams>): void {}
  setPan(_id: string, _pan: number): void {}

  // ── Routing + channel reconfiguration ──────────────────────────────────────

  connect(sourceId: string, _sourceChannel: number, targetId: string, _targetChannel: number): boolean {
    window.api.audio.connect(sourceId, targetId)
    return true
  }

  disconnect(sourceId: string, _sourceChannel: number, targetId: string, _targetChannel: number): void {
    window.api.audio.disconnect(sourceId, targetId)
  }

  setChannelCount(id: string, type: AudioNodeType, channels: number): number {
    const n = Math.max(1, Math.min(8, channels))
    // Recreate the node with the new channel count (engine replaces it by id).
    window.api.audio.createNode(id, type, type === 'mixer' ? 1 : n, '')
    return n
  }

  getConnectionsBeyondChannel(
    _id: string,
    _channels: number
  ): Array<{ source: string; target: string; sourceChannel: number; targetChannel: number }> {
    return []
  }

  destroyNode(id: string): void {
    window.api.audio.destroyNode(id)
  }

  async getDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    const { inputs, outputs } = await window.api.audio.getDevices()
    const toInfo = (
      d: { id: string; name: string; isDefault: boolean },
      kind: MediaDeviceKind
    ): MediaDeviceInfo =>
      // The store only reads deviceId/label; the rest satisfies the DOM type.
      ({
        deviceId: d.id,
        label: d.isDefault ? `${d.name} (default)` : d.name,
        kind,
        groupId: '',
        toJSON() {
          return this
        }
      }) as unknown as MediaDeviceInfo

    return {
      inputs: inputs.map((d) => toInfo(d, 'audioinput')),
      outputs: outputs.map((d) => toInfo(d, 'audiooutput'))
    }
  }
}

export const nativeEngine = new NativeEngine()
