// ────────────────────────────────────────────────────────────────────────────
// NativeEngine
//
// Renderer-side proxy for the Rust audio engine. Implements the `AudioBackend`
// contract by forwarding to the native addon over IPC (`window.api.audio.*`,
// bridged in src/main/index.ts). Control calls are one-way; meters are polled
// each frame and dispatched to the same `subscribeMeter` subscribers the Web
// Audio engine uses, so VUMeter.tsx is unchanged.
//
// Phase 2: every effect type runs real DSP in the engine. This class mirrors the
// engine's connection list and last-set parameters so a channel-count change can
// drop/replay connections and restore params (the engine recreates a node from
// defaults when its channel count changes), exactly like the Web Audio engine.
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

interface Conn {
  source: string
  sourceChannel: number
  target: string
  targetChannel: number
}

class NativeEngine implements AudioBackend {
  private initialized = false
  private meterSubs = new Map<string, Set<(db: number) => void>>()
  private rafId: number | null = null

  // Mirror of engine state so channel changes can be replayed losslessly.
  private connections: Conn[] = []
  private gains = new Map<string, number>()
  private mutes = new Map<string, boolean>()
  /** Per node: last value for each effect param, keyed `${param}#${index}`. */
  private params = new Map<string, Map<string, { param: string; index: number; value: number }>>()

  /** Latest per-channel compressor gain reduction, keyed `${id}#gr${ch}`. */
  private grCache = new Map<string, number>()

  /** Cached engine latency (ms); refreshed on a timer since getLatencyMs is sync. */
  private latencyCache = 0
  private latencyTimer: number | null = null

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

    // Latency is reported by the engine from its live device buffer sizes. Poll it
    // on a slow timer and cache it, since getLatencyMs() is synchronous.
    const pollLatency = (): void => {
      window.api.audio.latency().then(v => { this.latencyCache = v }).catch(() => {})
    }
    pollLatency()
    this.latencyTimer = window.setInterval(pollLatency, 2000)
  }

  getLatencyMs(): number {
    return Math.round(this.latencyCache)
  }

  // ── Meters: poll the addon each frame, dispatch to DOM subscribers ─────────

  private startMeterLoop(): void {
    if (this.rafId !== null) return
    let busy = false
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick)
      // Minimized / hidden in the tray: stop polling the engine for meters (saves
      // a per-frame IPC round-trip). The native gate runs on the audio thread, so
      // it's unaffected. Resumes automatically when the window is shown again.
      if (busy || this.meterSubs.size === 0 || (typeof document !== 'undefined' && document.hidden)) return
      busy = true
      window.api.audio
        .pollMeters()
        .then((frame) => {
          busy = false
          // Split out compressor gain-reduction keys; dispatch the rest to meters.
          for (const key in frame) {
            if (key.includes('#gr')) {
              this.grCache.set(key, frame[key])
            }
          }
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

  getCompressorReduction(id: string, channel = 0): number {
    return this.grCache.get(`${id}#gr${channel}`) ?? 0
  }

  // ── Param bookkeeping (so channel changes can replay) ──────────────────────

  private recordParam(id: string, param: string, index: number, value: number): void {
    let m = this.params.get(id)
    if (!m) {
      m = new Map()
      this.params.set(id, m)
    }
    m.set(`${param}#${index}`, { param, index, value })
  }

  private setParam(id: string, param: string, index: number, value: number): void {
    this.recordParam(id, param, index, value)
    window.api.audio.setParam(id, param, index, value)
  }

  /** Re-send gain/mute/effect params after the engine recreated a node. */
  private replayState(id: string): void {
    const g = this.gains.get(id)
    if (g !== undefined) window.api.audio.setGain(id, g)
    if (this.mutes.get(id)) window.api.audio.setMuted(id, true)
    const m = this.params.get(id)
    if (m) for (const { param, index, value } of m.values()) window.api.audio.setParam(id, param, index, value)
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

  // ── Recorder ──────────────────────────────────────────────────────────────
  // Capture-to-file is renderer-side (MediaRecorder) on the Web Audio engine.
  // The native engine has no MediaStream to tap yet, so the node exists as a
  // passthrough sink and recording is reported as unsupported.

  private warnedNoRec = false

  createRecorderNode(id: string): void {
    window.api.audio.createNode(id, 'recorder', 1, '')
  }

  startRecording(_id: string): boolean {
    if (!this.warnedNoRec) {
      console.warn('[native engine] recording is not yet supported — switch to the Web Audio engine to record.')
      this.warnedNoRec = true
    }
    return false
  }

  async stopRecording(_id: string): Promise<{ blob: Blob; mimeType: string; extension: string } | null> {
    return null
  }

  isRecording(_id: string): boolean {
    return false
  }

  // ── File player ───────────────────────────────────────────────────────────
  // Decoding a file lives in the renderer (HTMLAudioElement); the native engine
  // has no element to tap yet, so the node is a passthrough and transport is a
  // no-op. (Native file playback = a future Rust decode path.)
  private warnedNoFile = false
  private warnFile(): void {
    if (!this.warnedNoFile) {
      console.warn('[native engine] file player is not yet supported — switch to the Web Audio engine.')
      this.warnedNoFile = true
    }
  }

  createFilePlayerNode(id: string): void {
    window.api.audio.createNode(id, 'fileplayer', 1, '')
  }

  loadFilePlayer(_id: string, _url: string): void { this.warnFile() }
  playFilePlayer(_id: string): void { this.warnFile() }
  pauseFilePlayer(_id: string): void {}
  setFilePlayerLoop(_id: string, _loop: boolean): void {}
  seekFilePlayer(_id: string, _seconds: number): void {}
  getFilePlayerStatus(_id: string): { playing: boolean; currentTime: number; duration: number } {
    return { playing: false, currentTime: 0, duration: 0 }
  }

  // ── Node creation ─────────────────────────────────────────────────────────

  createVolumeNode(id: string, channels = 1): void {
    window.api.audio.createNode(id, 'volume', channels, '')
  }

  createEQNode(id: string, channels = 1, bands?: EQBand[]): void {
    window.api.audio.createNode(id, 'eq', channels, '')
    // Push any non-default band gains.
    bands?.forEach((b, i) => {
      if (b.gain !== 0) this.setParam(id, 'eqband', i, b.gain)
    })
  }

  createCompressorNode(id: string, channels = 1): void {
    window.api.audio.createNode(id, 'compressor', channels, '')
  }

  createGateNode(id: string, channels = 1): void {
    window.api.audio.createNode(id, 'gate', channels, '')
  }

  createMixerNode(id: string, channels = 4): void {
    // Engine sizes the per-input gain bank to `channels`; output meter is single.
    window.api.audio.createNode(id, 'mixer', channels, '')
  }

  createReverbNode(id: string, channels = 1, params?: ReverbParams): void {
    window.api.audio.createNode(id, 'reverb', channels, '')
    if (params) {
      this.setParam(id, 'mix', 0, params.mix)
      this.setParam(id, 'decay', 0, params.decay)
      this.setParam(id, 'predelay', 0, params.preDelay)
    }
  }

  createDelayNode(id: string, channels = 1, params?: DelayParams): void {
    window.api.audio.createNode(id, 'delay', channels, '')
    if (params) {
      this.setParam(id, 'time', 0, params.time)
      this.setParam(id, 'feedback', 0, params.feedback)
      this.setParam(id, 'mix', 0, params.mix)
    }
  }

  createChorusNode(id: string, channels = 1, params?: ChorusParams): void {
    window.api.audio.createNode(id, 'chorus', channels, '')
    if (params) {
      this.setParam(id, 'rate', 0, params.rate)
      this.setParam(id, 'depth', 0, params.depth)
      this.setParam(id, 'mix', 0, params.mix)
    }
  }

  createDistortionNode(id: string, channels = 1, params?: DistortionParams): void {
    window.api.audio.createNode(id, 'distortion', channels, '')
    if (params) {
      this.setParam(id, 'drive', 0, params.drive)
      this.setParam(id, 'mix', 0, params.mix)
    }
  }

  createPanNode(id: string, channels = 1, params?: PanParams): void {
    window.api.audio.createNode(id, 'pan', channels, '')
    if (params) this.setParam(id, 'pan', 0, params.pan)
  }

  // ── Parameter updates ──────────────────────────────────────────────────

  setGain(id: string, linearGain: number, _channel?: number): void {
    this.gains.set(id, linearGain)
    window.api.audio.setGain(id, linearGain)
  }

  muteNode(id: string, muted: boolean): void {
    this.mutes.set(id, muted)
    window.api.audio.setMuted(id, muted)
  }

  setEQBand(id: string, bandIndex: number, gain: number): void {
    this.setParam(id, 'eqband', bandIndex, gain)
  }

  setCompressor(
    id: string,
    params: Partial<{ threshold: number; knee: number; ratio: number; attack: number; release: number }>
  ): void {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) this.setParam(id, k, 0, v)
    }
  }

  setGate(id: string, params: Partial<{ threshold: number; attack: number; release: number }>): void {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) this.setParam(id, k, 0, v)
    }
  }

  setMixerChannel(id: string, channel: number, gain: number): void {
    this.setParam(id, 'channel', channel, gain)
  }

  setMixerMaster(id: string, gain: number): void {
    this.setParam(id, 'master', 0, gain)
  }

  setReverb(id: string, params: Partial<ReverbParams>): void {
    if (params.mix !== undefined) this.setParam(id, 'mix', 0, params.mix)
    if (params.decay !== undefined) this.setParam(id, 'decay', 0, params.decay)
    if (params.preDelay !== undefined) this.setParam(id, 'predelay', 0, params.preDelay)
  }

  setDelay(id: string, params: Partial<DelayParams>): void {
    if (params.time !== undefined) this.setParam(id, 'time', 0, params.time)
    if (params.feedback !== undefined) this.setParam(id, 'feedback', 0, params.feedback)
    if (params.mix !== undefined) this.setParam(id, 'mix', 0, params.mix)
  }

  setChorus(id: string, params: Partial<ChorusParams>): void {
    if (params.rate !== undefined) this.setParam(id, 'rate', 0, params.rate)
    if (params.depth !== undefined) this.setParam(id, 'depth', 0, params.depth)
    if (params.mix !== undefined) this.setParam(id, 'mix', 0, params.mix)
  }

  setDistortion(id: string, params: Partial<DistortionParams>): void {
    if (params.drive !== undefined) this.setParam(id, 'drive', 0, params.drive)
    if (params.mix !== undefined) this.setParam(id, 'mix', 0, params.mix)
  }

  setPan(id: string, pan: number): void {
    this.setParam(id, 'pan', 0, pan)
  }

  // ── Routing + channel reconfiguration ──────────────────────────────────────

  connect(sourceId: string, sourceChannel: number, targetId: string, targetChannel: number): boolean {
    if (
      this.connections.some(
        (c) =>
          c.source === sourceId &&
          c.target === targetId &&
          c.sourceChannel === sourceChannel &&
          c.targetChannel === targetChannel
      )
    ) {
      return false
    }
    this.connections.push({ source: sourceId, sourceChannel, target: targetId, targetChannel })
    window.api.audio.connect(sourceId, sourceChannel, targetId, targetChannel)
    return true
  }

  disconnect(sourceId: string, sourceChannel: number, targetId: string, targetChannel: number): void {
    this.connections = this.connections.filter(
      (c) =>
        !(
          c.source === sourceId &&
          c.target === targetId &&
          c.sourceChannel === sourceChannel &&
          c.targetChannel === targetChannel
        )
    )
    window.api.audio.disconnect(sourceId, sourceChannel, targetId, targetChannel)
  }

  setChannelCount(id: string, type: AudioNodeType, channels: number): number {
    const n = Math.max(1, Math.min(8, channels))

    // Connections that still fit the new channel range survive; the rest are dropped.
    const survivingFrom = this.connections.filter((c) => c.source === id && c.sourceChannel < n)
    const survivingTo = this.connections.filter((c) => c.target === id && c.targetChannel < n)
    const survivingFiltered = [...survivingFrom, ...survivingTo]

    // Tear down every connection touching this node (engine + mirror).
    for (const c of this.connections.filter((c) => c.source === id || c.target === id)) {
      window.api.audio.disconnect(c.source, c.sourceChannel, c.target, c.targetChannel)
    }
    this.connections = this.connections.filter((c) => c.source !== id && c.target !== id)

    // Recreate the node with the new channel count (engine replaces it by id),
    // then restore its gain/mute/params.
    window.api.audio.createNode(id, type, n, '')
    this.replayState(id)

    // Replay the connections that still fit.
    for (const c of survivingFiltered) {
      this.connect(c.source, c.sourceChannel, c.target, c.targetChannel)
    }
    return n
  }

  getConnectionsBeyondChannel(
    id: string,
    channels: number
  ): Array<{ source: string; target: string; sourceChannel: number; targetChannel: number }> {
    return this.connections
      .filter(
        (c) =>
          (c.source === id && c.sourceChannel >= channels) ||
          (c.target === id && c.targetChannel >= channels)
      )
      .map((c) => ({
        source: c.source,
        target: c.target,
        sourceChannel: c.sourceChannel,
        targetChannel: c.targetChannel
      }))
  }

  destroyNode(id: string): void {
    this.connections = this.connections.filter((c) => c.source !== id && c.target !== id)
    this.gains.delete(id)
    this.mutes.delete(id)
    this.params.delete(id)
    for (const key of this.grCache.keys()) if (key.startsWith(`${id}#gr`)) this.grCache.delete(key)
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
