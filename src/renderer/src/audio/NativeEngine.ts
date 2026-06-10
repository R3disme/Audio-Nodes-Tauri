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
import { resolveDeviceId } from '@renderer/lib/deviceMatch'
import type {
  AudioNodeType,
  EQBand,
  ReverbParams,
  DelayParams,
  ChorusParams,
  DistortionParams,
  PanParams,
  FilterParams,
  LimiterParams,
  ExpanderParams,
  TremoloParams,
  CrusherParams
} from './AudioEngine'

interface Conn {
  source: string
  sourceChannel: number
  target: string
  targetChannel: number
}

/** A running renderer→engine PCM bridge (see startCaptureBridge). */
interface CaptureBridge {
  stop(): void
}

// AudioWorklet processor for the capture bridge: interleaves L/R into 256-frame
// chunks (~5.3 ms at 48 kHz) and posts each to the main thread with a transferred
// buffer. Small chunks matter: the engine sizes each fed ring's latency cushion to
// its push cadence, so a 2048-frame push forces a ~43 ms cushion while 256 needs ~5.
// Missing input channels (e.g. a paused/ended source) emit silence at the same
// cadence so the engine ring stays primed. Loaded as a Blob module (CSP allows
// worker-src blob:), same pattern as the bitcrusher worklet in AudioEngine.ts.
const CAPTURE_BRIDGE_WORKLET = `
class CaptureBridgeProcessor extends AudioWorkletProcessor {
  constructor () {
    super()
    this.chunk = 256
    this.buf = new Float32Array(this.chunk * 2)
    this.fill = 0
  }
  process (inputs) {
    const inp = inputs[0]
    const L = inp && inp.length > 0 ? inp[0] : null
    const R = inp && inp.length > 1 ? inp[1] : L
    const n = L ? L.length : 128
    for (let i = 0; i < n; i++) {
      this.buf[2 * this.fill] = L ? L[i] : 0
      this.buf[2 * this.fill + 1] = R ? R[i] : 0
      if (++this.fill === this.chunk) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(this.chunk * 2)
        this.fill = 0
      }
    }
    return true
  }
}
registerProcessor('capture-bridge', CaptureBridgeProcessor)
`

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

  /** Saved device selection per I/O node (id + persisted label) for name-fallback
   *  reconnect on `devicechange` when the saved deviceId churns. */
  private inputDevices = new Map<string, { id: string; name: string }>()
  private outputDevices = new Map<string, { id: string; name: string }>()

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
    this.startLatencyPoll()

    // Minimized / hidden in the tray: the renderer has no visible meters and the
    // native gate runs on the Rust audio thread, so suspend the rAF loop and the
    // latency poll entirely (zero renderer wakeups) and resume on show.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.stopMeterLoop()
          this.stopLatencyPoll()
        } else {
          this.startMeterLoop()
          this.startLatencyPoll()
        }
      })
    }
  }

  // Latency is reported by the engine from its live device buffer sizes. Poll it
  // on a slow timer and cache it, since getLatencyMs() is synchronous.
  private startLatencyPoll(): void {
    const pollLatency = (): void => {
      window.api.audio.latency().then(v => { this.latencyCache = v }).catch(() => {})
    }
    pollLatency()
    if (this.latencyTimer !== null) window.clearInterval(this.latencyTimer)
    this.latencyTimer = window.setInterval(pollLatency, 2000)
  }

  private stopLatencyPoll(): void {
    if (this.latencyTimer !== null) {
      window.clearInterval(this.latencyTimer)
      this.latencyTimer = null
    }
  }

  getLatencyMs(): number {
    return Math.round(this.latencyCache)
  }

  setLatencyMode(mode: 'low' | 'balanced' | 'safe'): void {
    window.api.audio.setLatencyMode(mode)
  }

  setDeviceMode(mode: 'shared' | 'lowlatency' | 'exclusive'): void {
    window.api.audio.setDeviceMode(mode)
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

  private stopMeterLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  subscribeMeter(key: string, cb: (db: number) => void): () => void {
    let set = this.meterSubs.get(key)
    if (!set) {
      set = new Set()
      this.meterSubs.set(key, set)
    }
    set.add(cb)
    // Drop the key when the last subscriber leaves so a long session of
    // create/destroy doesn't accumulate empty Sets keyed by stale node ids.
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.meterSubs.delete(key)
    }
  }

  private nodeSubs = new Set<() => void>()
  subscribeNodeChanges(cb: () => void): () => void {
    this.nodeSubs.add(cb)
    return () => { this.nodeSubs.delete(cb) }
  }
  private notifyNodeChanges(): void {
    for (const cb of this.nodeSubs) cb()
  }

  /** True while any renderer-side PCM bridge feeds the native engine (app capture,
   *  loaded file player) or a recording is in progress — i.e. destroying the
   *  renderer window would break audio even though the engine lives in main. */
  hasActiveBridges(): boolean {
    if (this.appCaptures.size > 0 || this.recording.size > 0) return true
    for (const fp of this.filePlayers.values()) {
      if (fp.el.src) return true
    }
    return false
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

  async createInputNode(id: string, deviceId?: string, deviceName?: string): Promise<void> {
    this.inputDevices.set(id, { id: deviceId ?? '', name: deviceName ?? '' })
    window.api.audio.createNode(id, 'input', 1, deviceId ?? '')
  }

  isInputActive(_id: string): boolean {
    return true
  }

  /** On devicechange, reconnect any input whose saved id churned but whose label
   *  still matches a present device — re-open the stream on the resolved id. */
  async recoverInputs(): Promise<void> {
    if (this.inputDevices.size === 0) return
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
    for (const [id, saved] of this.inputDevices) {
      if (!saved.id) continue // default device — engine opens '' itself
      const resolved = resolveDeviceId(devices, saved.id, saved.name, 'audioinput')
      if (resolved !== undefined && resolved !== saved.id) {
        saved.id = resolved
        window.api.audio.createNode(id, 'input', 1, resolved)
        this.replayState(id)
      }
    }
  }

  // ── Capture bridge (application capture + file player) ────────────────────

  /** Pump `source`'s PCM into `id`'s fed engine ring (Kind::Loopback) over IPC
   *  (`pushCapture`, which also carries the bridge context's sample rate so the
   *  engine can resample to its master rate). An AudioWorklet posts 256-frame
   *  chunks; if the worklet can't load it falls back to the old 2048-frame
   *  ScriptProcessor so capture never breaks. The 0-gain sink keeps the graph
   *  rendering without playing the bridged audio out of the speakers (and keeps
   *  the ring primed with silence while the source is paused). */
  private async startCaptureBridge(ctx: AudioContext, source: AudioNode, id: string): Promise<CaptureBridge> {
    const gain = ctx.createGain()
    gain.gain.value = 0
    let proc: AudioWorkletNode | ScriptProcessorNode
    try {
      const url = URL.createObjectURL(new Blob([CAPTURE_BRIDGE_WORKLET], { type: 'application/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const node = new AudioWorkletNode(ctx, 'capture-bridge', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit'
      })
      node.port.onmessage = (e: MessageEvent<Float32Array>): void => {
        window.api.audio.pushCapture(id, e.data, ctx.sampleRate)
      }
      proc = node
    } catch (e) {
      console.warn('[native engine] capture worklet failed; falling back to ScriptProcessor:', e)
      const sp = ctx.createScriptProcessor(2048, 2, 1)
      // Reused across callbacks; Electron copies the IPC arg synchronously on send,
      // so mutating it afterwards is safe — avoids ~4 KB of GC garbage every block.
      let inter = new Float32Array(2048 * 2)
      sp.onaudioprocess = (ev): void => {
        const inp = ev.inputBuffer
        const L = inp.getChannelData(0)
        const R = inp.numberOfChannels > 1 ? inp.getChannelData(1) : L
        const n = inp.length
        if (inter.length !== n * 2) inter = new Float32Array(n * 2)
        for (let i = 0; i < n; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i] }
        window.api.audio.pushCapture(id, inter, ctx.sampleRate)
      }
      proc = sp
    }
    source.connect(proc)
    proc.connect(gain)
    gain.connect(ctx.destination)
    return {
      stop: (): void => {
        try {
          if (proc instanceof AudioWorkletNode) proc.port.onmessage = null
          else proc.onaudioprocess = null
          proc.disconnect()
          source.disconnect()
          gain.disconnect()
        } catch { /* already torn down */ }
      }
    }
  }

  // The renderer captures system audio with getDisplayMedia (proven, same as the
  // Web Audio engine) and bridges the PCM into the native engine's loopback ring.
  private appCaptures = new Map<string, { ctx: AudioContext; stream: MediaStream; bridge: CaptureBridge }>()

  async createApplicationNode(id: string, _sourceId: string, _sourceName: string): Promise<void> {
    window.api.audio.createNode(id, 'application', 1, '')
  }

  async armApplicationCapture(id: string, sourceId: string, _sourceName: string): Promise<void> {
    if (!sourceId) return
    this.stopAppCapture(id)
    try {
      await window.api.armCaptureSource(sourceId)
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      stream.getVideoTracks().forEach(t => t.stop())
      const tracks = stream.getAudioTracks()
      if (tracks.length === 0) return
      const audioOnly = new MediaStream(tracks)
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const src = ctx.createMediaStreamSource(audioOnly)
      const bridge = await this.startCaptureBridge(ctx, src, id)
      tracks[0].onended = () => { this.stopAppCapture(id) }
      this.appCaptures.set(id, { ctx, stream: audioOnly, bridge })
      this.notifyNodeChanges()
    } catch (e) {
      console.warn('[native engine] application capture failed:', e)
    }
  }

  private stopAppCapture(id: string): void {
    const c = this.appCaptures.get(id)
    if (!c) return
    c.bridge.stop()
    c.stream.getTracks().forEach(t => t.stop())
    void c.ctx.close().catch(() => {})
    this.appCaptures.delete(id)
    this.notifyNodeChanges()
  }

  isApplicationActive(id: string): boolean {
    return this.appCaptures.has(id)
  }

  // ── Output ──────────────────────────────────────────────────────────────

  createOutputNode(id: string, type: 'output' | 'virtual' = 'output'): void {
    window.api.audio.createNode(id, type, 1, '')
  }

  async setOutputDevice(id: string, deviceId: string, deviceName?: string): Promise<void> {
    const prev = this.outputDevices.get(id)
    this.outputDevices.set(id, { id: deviceId, name: deviceName ?? prev?.name ?? '' })
    window.api.audio.setOutputDevice(id, deviceId)
  }

  /** On devicechange, re-point any output whose saved id churned but whose label
   *  still matches a present device. */
  async recoverOutputs(): Promise<void> {
    if (this.outputDevices.size === 0) return
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
    for (const [id, saved] of this.outputDevices) {
      if (!saved.id) continue
      const resolved = resolveDeviceId(devices, saved.id, saved.name, 'audiooutput')
      if (resolved !== undefined && resolved !== saved.id) {
        saved.id = resolved
        window.api.audio.setOutputDevice(id, resolved)
      }
    }
  }

  // ── Recorder ──────────────────────────────────────────────────────────────
  // The engine taps the node's signal and writes a 16-bit WAV; on stop the main
  // process reads the file back as bytes, which we wrap as a Blob so the same
  // download/playback path as Web Audio works.

  private recording = new Set<string>()

  createRecorderNode(id: string): void {
    window.api.audio.createNode(id, 'recorder', 1, '')
  }

  startRecording(id: string): boolean {
    window.api.audio.startRecording(id)
    this.recording.add(id)
    this.notifyNodeChanges()
    return true
  }

  async stopRecording(id: string): Promise<{ blob: Blob; mimeType: string; extension: string } | null> {
    this.recording.delete(id)
    this.notifyNodeChanges()
    const res = await window.api.audio.stopRecording(id)
    if (!res) return null
    // `bytes` arrives as a Uint8Array over IPC; cast to satisfy the strict BlobPart type.
    return { blob: new Blob([res.bytes as BlobPart], { type: res.mime }), mimeType: res.mime, extension: res.ext }
  }

  isRecording(id: string): boolean {
    return this.recording.has(id)
  }

  // ── File player ───────────────────────────────────────────────────────────
  // Decoding + transport live in the renderer (an <audio> element, like Web Audio);
  // the element is routed through the capture bridge into the engine's fed ring
  // (Kind::Loopback) over IPC — the same path as application capture. The element
  // plays only into the graph (not the speakers); the bridge's 0-gain sink keeps it
  // pumping (and the ring primed with silence while paused).
  // `bridge` is null until the worklet module finishes loading — the entry goes in
  // synchronously so loadFilePlayer/play right after creation still find it.
  private filePlayers = new Map<string, { ctx: AudioContext; el: HTMLAudioElement; bridge: CaptureBridge | null }>()

  createFilePlayerNode(id: string): void {
    window.api.audio.createNode(id, 'fileplayer', 1, '')
    if (this.filePlayers.has(id)) return
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const el = new Audio()
      el.preload = 'auto'
      const src = ctx.createMediaElementSource(el)
      const entry = { ctx, el, bridge: null as CaptureBridge | null }
      this.filePlayers.set(id, entry)
      void this.startCaptureBridge(ctx, src, id).then((bridge) => {
        if (this.filePlayers.get(id) === entry) entry.bridge = bridge
        else bridge.stop() // torn down while the worklet was still loading
      })
    } catch (e) {
      console.warn('[native engine] file player setup failed:', e)
    }
  }

  private teardownFilePlayer(id: string): void {
    const fp = this.filePlayers.get(id)
    if (!fp) return
    fp.bridge?.stop()
    try { fp.el.pause(); fp.el.removeAttribute('src'); fp.el.load() } catch { /* */ }
    void fp.ctx.close().catch(() => {})
    this.filePlayers.delete(id)
    this.notifyNodeChanges()
  }

  loadFilePlayer(id: string, url: string): void {
    const fp = this.filePlayers.get(id)
    if (!fp) return
    fp.el.src = url
    fp.el.load()
    void fp.ctx.resume()
    this.notifyNodeChanges()
  }

  playFilePlayer(id: string): void {
    const fp = this.filePlayers.get(id)
    if (!fp?.el.src) return
    void fp.ctx.resume()
    void fp.el.play().catch(e => console.warn('File player play() failed:', e))
  }

  pauseFilePlayer(id: string): void {
    this.filePlayers.get(id)?.el.pause()
  }

  setFilePlayerLoop(id: string, loop: boolean): void {
    const fp = this.filePlayers.get(id)
    if (fp) fp.el.loop = loop
  }

  seekFilePlayer(id: string, seconds: number): void {
    const el = this.filePlayers.get(id)?.el
    if (el && isFinite(seconds)) el.currentTime = Math.max(0, seconds)
  }

  getFilePlayerStatus(id: string): { playing: boolean; currentTime: number; duration: number } {
    const el = this.filePlayers.get(id)?.el
    return {
      playing: !!el && !el.paused && !el.ended,
      currentTime: el?.currentTime ?? 0,
      duration: el && isFinite(el.duration) ? el.duration : 0
    }
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

  createFilterNode(id: string, channels = 1, params?: FilterParams): void {
    window.api.audio.createNode(id, 'filter', channels, '')
    if (params) {
      this.setParam(id, 'type', 0, params.type)
      this.setParam(id, 'cutoff', 0, params.cutoff)
      this.setParam(id, 'q', 0, params.q)
    }
  }

  createLimiterNode(id: string, channels = 1, params?: LimiterParams): void {
    window.api.audio.createNode(id, 'limiter', channels, '')
    if (params) {
      this.setParam(id, 'threshold', 0, params.threshold)
      this.setParam(id, 'release', 0, params.release)
    }
  }

  createExpanderNode(id: string, channels = 1, params?: ExpanderParams): void {
    window.api.audio.createNode(id, 'expander', channels, '')
    if (params) {
      this.setParam(id, 'threshold', 0, params.threshold)
      this.setParam(id, 'ratio', 0, params.ratio)
      this.setParam(id, 'attack', 0, params.attack)
      this.setParam(id, 'release', 0, params.release)
    }
  }

  createTremoloNode(id: string, channels = 1, params?: TremoloParams): void {
    window.api.audio.createNode(id, 'tremolo', channels, '')
    if (params) {
      this.setParam(id, 'mode', 0, params.mode)
      this.setParam(id, 'shape', 0, params.shape)
      this.setParam(id, 'rate', 0, params.rate)
      this.setParam(id, 'depth', 0, params.depth)
    }
  }

  createBitcrusherNode(id: string, channels = 1, params?: CrusherParams): void {
    window.api.audio.createNode(id, 'bitcrusher', channels, '')
    if (params) {
      this.setParam(id, 'bits', 0, params.bits)
      this.setParam(id, 'downsample', 0, params.downsample)
      this.setParam(id, 'mix', 0, params.mix)
    }
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

  setFilter(id: string, params: Partial<FilterParams>): void {
    if (params.type !== undefined) this.setParam(id, 'type', 0, params.type)
    if (params.cutoff !== undefined) this.setParam(id, 'cutoff', 0, params.cutoff)
    if (params.q !== undefined) this.setParam(id, 'q', 0, params.q)
  }

  setLimiter(id: string, params: Partial<LimiterParams>): void {
    if (params.threshold !== undefined) this.setParam(id, 'threshold', 0, params.threshold)
    if (params.release !== undefined) this.setParam(id, 'release', 0, params.release)
  }

  setExpander(id: string, params: Partial<ExpanderParams>): void {
    if (params.threshold !== undefined) this.setParam(id, 'threshold', 0, params.threshold)
    if (params.ratio !== undefined) this.setParam(id, 'ratio', 0, params.ratio)
    if (params.attack !== undefined) this.setParam(id, 'attack', 0, params.attack)
    if (params.release !== undefined) this.setParam(id, 'release', 0, params.release)
  }

  setTremolo(id: string, params: Partial<TremoloParams>): void {
    if (params.mode !== undefined) this.setParam(id, 'mode', 0, params.mode)
    if (params.shape !== undefined) this.setParam(id, 'shape', 0, params.shape)
    if (params.rate !== undefined) this.setParam(id, 'rate', 0, params.rate)
    if (params.depth !== undefined) this.setParam(id, 'depth', 0, params.depth)
  }

  setBitcrusher(id: string, params: Partial<CrusherParams>): void {
    if (params.bits !== undefined) this.setParam(id, 'bits', 0, params.bits)
    if (params.downsample !== undefined) this.setParam(id, 'downsample', 0, params.downsample)
    if (params.mix !== undefined) this.setParam(id, 'mix', 0, params.mix)
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
    this.stopAppCapture(id)
    this.teardownFilePlayer(id)
    this.recording.delete(id)
    this.connections = this.connections.filter((c) => c.source !== id && c.target !== id)
    this.gains.delete(id)
    this.mutes.delete(id)
    this.params.delete(id)
    this.inputDevices.delete(id)
    this.outputDevices.delete(id)
    for (const key of this.grCache.keys()) if (key.startsWith(`${id}#gr`)) this.grCache.delete(key)
    // Drop this node's meter-subscription buckets (mirrors AudioEngine.destroyNode).
    for (const key of this.meterSubs.keys()) if (key.startsWith(`${id}:`)) this.meterSubs.delete(key)
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
