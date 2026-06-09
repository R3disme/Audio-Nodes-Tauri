// ────────────────────────────────────────────────────────────────────────────
// AudioEngine
//
// One Web Audio AudioContext, with a registry of "managed nodes" that mirror
// the visual graph 1:1. Each managed node exposes:
//   - inputs:  AudioNodes that downstream connections feed INTO
//   - outputs: AudioNodes that this node emits FROM
//   - meters:  AnalyserNodes for visual VU display (one per visible meter)
//
// The Web Audio graph is updated directly when the visual graph changes,
// keeping the two synchronised. Multi-channel nodes have independent audio
// paths — channel 0 audio never leaks into channel 1's chain.
//
// Meter values are pushed to subscribers (DOM refs) at ~60fps, bypassing
// React entirely. Re-rendering 7+ components per frame would be wasteful.
// ────────────────────────────────────────────────────────────────────────────

import type { AudioBackend } from './AudioBackend'
import { resolveDeviceId } from '@renderer/lib/deviceMatch'

export type AudioNodeType =
  | 'input'
  | 'output'
  | 'virtual'
  | 'volume'
  | 'eq'
  | 'compressor'
  | 'gate'
  | 'mixer'
  | 'application'
  | 'reverb'
  | 'delay'
  | 'chorus'
  | 'distortion'
  | 'pan'
  | 'recorder'
  | 'fileplayer'
  | 'filter'
  | 'limiter'
  | 'expander'
  | 'tremolo'
  | 'bitcrusher'

export interface EQBand {
  frequency: number
  gain: number
  type: BiquadFilterType
  Q: number
}

export const DEFAULT_EQ_BANDS: EQBand[] = [
  { frequency: 80,    gain: 0, type: 'lowshelf',  Q: 0.7 },
  { frequency: 240,   gain: 0, type: 'peaking',   Q: 1.0 },
  { frequency: 1000,  gain: 0, type: 'peaking',   Q: 1.0 },
  { frequency: 3500,  gain: 0, type: 'peaking',   Q: 1.0 },
  { frequency: 10000, gain: 0, type: 'highshelf', Q: 0.7 }
]

// ── Default parameters for the creative effects ─────────────────────────────
// Shared by the engine (node creation) and the store (initial node data) so the
// two never drift apart.

export interface ReverbParams { mix: number; decay: number; preDelay: number }
export interface DelayParams { time: number; feedback: number; mix: number }
export interface ChorusParams { rate: number; depth: number; mix: number }
export interface DistortionParams { drive: number; mix: number }
export interface PanParams { pan: number }
// Filter type: 0 = low-pass, 1 = high-pass, 2 = band-pass, 3 = notch.
export interface FilterParams { type: number; cutoff: number; q: number }
export interface LimiterParams { threshold: number; release: number }
export interface ExpanderParams { threshold: number; ratio: number; attack: number; release: number }
// Tremolo mode: 0 = amplitude (tremolo), 1 = stereo position (auto-pan). Shape: 0 = sine, 1 = triangle.
export interface TremoloParams { mode: number; shape: number; rate: number; depth: number }
export interface CrusherParams { bits: number; downsample: number; mix: number }

export const DEFAULT_REVERB: ReverbParams = { mix: 0.3, decay: 2.2, preDelay: 0.02 }
export const DEFAULT_DELAY: DelayParams = { time: 0.3, feedback: 0.35, mix: 0.35 }
export const DEFAULT_CHORUS: ChorusParams = { rate: 1.5, depth: 0.003, mix: 0.4 }
export const DEFAULT_DISTORTION: DistortionParams = { drive: 5, mix: 0.5 }
export const DEFAULT_PAN: PanParams = { pan: 0 }
export const DEFAULT_FILTER: FilterParams = { type: 0, cutoff: 1000, q: 0.707 }
export const DEFAULT_LIMITER: LimiterParams = { threshold: -1, release: 0.1 }
export const DEFAULT_EXPANDER: ExpanderParams = { threshold: -40, ratio: 2, attack: 0.005, release: 0.1 }
export const DEFAULT_TREMOLO: TremoloParams = { mode: 0, shape: 0, rate: 5, depth: 0.7 }
export const DEFAULT_CRUSHER: CrusherParams = { bits: 8, downsample: 1, mix: 1 }

// ── Internal node representation ───────────────────────────────────────────

interface ManagedNode {
  type: AudioNodeType
  /** Audio entry points — one per left-side handle */
  inputs: AudioNode[]
  /** Audio exit points — one per right-side handle */
  outputs: AudioNode[]
  /** AnalyserNodes for VU meters — one per visible meter on this node */
  meters: AnalyserNode[]

  // Type-specific references for parameter updates and lifecycle
  // (parallel to channel count where applicable)
  gainRefs?: GainNode[]
  /** Last user-set linear gain (pre-mute). Mute multiplies this by 0. */
  userGain?: number
  /** Whether this node is muted. Kept separate from gain so the two don't clobber each other. */
  muted?: boolean
  compressorRefs?: DynamicsCompressorNode[]
  eqRefs?: BiquadFilterNode[][]   // [channel][band]
  gateRefs?: GateChannel[]

  // Creative effects — per-channel audio refs plus the live parameter snapshot
  // (the snapshot lets setChannelCount rebuild the node without re-reading the
  // graph, and keeps params stable across channel changes).
  reverbRefs?: ReverbChannel[]
  reverbParams?: ReverbParams
  delayRefs?: DelayChannel[]
  delayParams?: DelayParams
  chorusRefs?: ChorusChannel[]
  chorusParams?: ChorusParams
  distortionRefs?: DistortionChannel[]
  distortionParams?: DistortionParams
  panRefs?: PanChannel[]
  panParams?: PanParams
  filterRefs?: BiquadFilterNode[]
  filterParams?: FilterParams
  limiterRefs?: DynamicsCompressorNode[]
  limiterParams?: LimiterParams
  expanderRefs?: ExpanderChannel[]
  expanderParams?: ExpanderParams
  tremoloRefs?: TremoloChannel[]
  tremoloParams?: TremoloParams
  crusherRefs?: CrusherChannel[]
  crusherParams?: CrusherParams

  mediaStream?: MediaStream

  // For mixer (asymmetric):
  mixerInputGains?: GainNode[]    // one per input channel handle
  mixerMaster?: GainNode

  // For application capture:
  appPassThrough?: GainNode       // stable internal node — survives reconnects
  appSourceName?: string
  appReconnectTimer?: number
  appActive?: boolean

  // For output: each output terminates in its own MediaStream + <audio> element
  // so it can be routed to an independent device via the element's setSinkId.
  outputSink?: HTMLAudioElement
  outputDeviceId?: string
  // Persisted device label — the stable key for reconnecting when the id changes.
  outputDeviceName?: string

  // For recorder: a MediaStreamDestination tapped by a MediaRecorder. The
  // recorder is created lazily on the first record so an idle node is cheap.
  recStreamDest?: MediaStreamAudioDestinationNode
  recRecorder?: MediaRecorder
  recChunks?: Blob[]
  recActive?: boolean
  recMime?: string
  recExt?: string

  // For file player: an <audio> element fed into the graph via a
  // MediaElementAudioSourceNode (created once; the element src is swapped per file).
  fileEl?: HTMLAudioElement
  fileSource?: MediaElementAudioSourceNode

  // For input device auto-recovery:
  inputDeviceId?: string
  // Persisted device label — the stable key for reconnecting when the id changes.
  inputDeviceName?: string
  inputActive?: boolean
  inputReconnectTimer?: number
}

interface GateChannel {
  monitor: AnalyserNode                  // taps the input pre-gate to measure level
  gain: GainNode                         // the actual gate (gain → 0 when below threshold)
  buf: Float32Array<ArrayBuffer>         // reusable RMS buffer
  threshold: number
  attack: number
  release: number
}

// Downward expander — like the gate, but a soft ratio-based attenuation below
// threshold rather than a hard cut. Driven by the same meter rAF loop (tickExpander).
interface ExpanderChannel {
  monitor: AnalyserNode
  gain: GainNode
  buf: Float32Array<ArrayBuffer>
  threshold: number
  ratio: number
  attack: number
  release: number
}

// Tremolo / auto-pan — an OscillatorNode LFO drives either the amplitude GainNode
// (tremolo) or the StereoPanner (auto-pan), so modulation is sample-accurate with
// no main-thread work. `lfo` scales the oscillator to the active depth.
interface TremoloChannel {
  input: GainNode
  amp: GainNode
  panner: StereoPannerNode
  osc: OscillatorNode
  lfo: GainNode
  mode: number
  shape: number
  rate: number
  depth: number
}

// Bitcrusher — bit-depth quantize + sample-rate decimation. Web Audio has no native
// crusher, so an AudioWorklet (loaded once from a Blob URL) does the per-sample
// hold/quantize off the main thread. `proc` is null only if the worklet failed to load
// (then the channel is a passthrough).
interface CrusherChannel {
  input: GainNode
  proc: AudioWorkletNode | null
}

// The crusher's AudioWorklet processor, loaded as a Blob module in init(). bits/downsample/
// mix are k-rate AudioParams; the per-frame decimation counter + sample-hold live here.
const BITCRUSHER_WORKLET = `
class BitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'downsample', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }
  constructor() { super(); this.hold = []; this.counter = 0 }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0]
    if (!input || input.length === 0) return true
    const bits = Math.max(1, Math.min(16, params.bits[0]))
    const ds = Math.max(1, params.downsample[0])
    const mix = params.mix[0], dry = 1 - mix
    const half = Math.max(1, Math.pow(2, bits) / 2)
    const frames = input[0].length
    for (let i = 0; i < frames; i++) {
      this.counter += 1
      const sample = this.counter >= ds
      if (sample) this.counter -= ds
      for (let c = 0; c < input.length; c++) {
        if (this.hold[c] === undefined) this.hold[c] = 0
        if (sample) this.hold[c] = Math.round(input[c][i] * half) / half
        output[c][i] = input[c][i] * dry + this.hold[c] * mix
      }
    }
    return true
  }
}
registerProcessor('bitcrusher-processor', BitcrusherProcessor)
`

// ── Creative-effect channel structures ──────────────────────────────────────
// Each effect mixes a dry and a wet path into the channel's output meter:
//   input ─┬─► dry ─────────────────► meter (out)
//          └─► [effect] ─► wet ──────► meter

interface ReverbChannel {
  input: GainNode
  convolver: ConvolverNode
  dry: GainNode
  wet: GainNode
}

interface DelayChannel {
  input: GainNode
  delay: DelayNode
  feedback: GainNode
  dry: GainNode
  wet: GainNode
}

interface ChorusChannel {
  input: GainNode
  delay: DelayNode
  lfo: OscillatorNode
  depth: GainNode      // scales the LFO into seconds of delay-time modulation
  dry: GainNode
  wet: GainNode
}

interface DistortionChannel {
  input: GainNode
  shaper: WaveShaperNode
  makeup: GainNode     // tames the level boost from hard saturation
  dry: GainNode
  wet: GainNode
}

interface PanChannel {
  input: GainNode
  panner: StereoPannerNode
}

interface ConnectionRecord {
  source: string
  sourceChannel: number
  target: string
  targetChannel: number
  srcNode: AudioNode
  tgtNode: AudioNode
}

// ── Engine ──────────────────────────────────────────────────────────────────

class AudioEngine implements AudioBackend {
  private ctx: AudioContext | null = null
  private nodes = new Map<string, ManagedNode>()
  private connections: ConnectionRecord[] = []

  /** Subscribers receive a dB level whenever their meter is updated. */
  private meterSubs = new Map<string, Set<(db: number) => void>>()
  /** Channels-count subscribers (for components that need to react to engine state). */
  private nodeSubs = new Set<() => void>()
  private rafId: number | null = null
  // Explicit ArrayBuffer backing — getFloatTimeDomainData requires Float32Array<ArrayBuffer>
  private rmsBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(256 * 4))
  /** Set once the bitcrusher AudioWorklet module has loaded. */
  private bitcrusherReady = false

  async init(): Promise<void> {
    if (this.ctx) return
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    // Load the bitcrusher worklet from a Blob URL (no asset-path dependency, works
    // under file:// in the packaged app). Best-effort — the node falls back to
    // passthrough if it can't load.
    try {
      const url = URL.createObjectURL(new Blob([BITCRUSHER_WORKLET], { type: 'application/javascript' }))
      await this.ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      this.bitcrusherReady = true
    } catch (e) {
      console.warn('Bitcrusher worklet failed to load; bitcrusher will pass through:', e)
    }
    this.startMeterLoop()
  }

  private get context(): AudioContext {
    if (!this.ctx) throw new Error('AudioEngine not initialized')
    return this.ctx
  }

  // ── Meter subscriptions (bypass React) ──────────────────────────────────

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

  private startMeterLoop(): void {
    const tick = (): void => {
      // Minimized / hidden in the tray: skip all VU-meter work (analyser reads,
      // RMS, DOM writes) — nobody can see it. Keep ticking gates, since audio
      // still flows and a noise gate must keep gating in the background. This is
      // the bulk of the idle-CPU saving when backgrounded.
      if (typeof document !== 'undefined' && document.hidden) {
        this.nodes.forEach((node) => {
          if (node.type === 'gate' && node.gateRefs) {
            for (const g of node.gateRefs) this.tickGate(g)
          } else if (node.type === 'expander' && node.expanderRefs) {
            for (const e of node.expanderRefs) this.tickExpander(e)
          }
        })
        this.rafId = requestAnimationFrame(tick)
        return
      }

      this.nodes.forEach((node, id) => {
        node.meters.forEach((analyser, idx) => {
          // Skip the RMS work entirely when nothing is displaying this meter.
          const subs = this.meterSubs.get(`${id}:${idx}`)
          if (!subs || subs.size === 0) return
          if (this.rmsBuf.length !== analyser.fftSize) {
            this.rmsBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
          }
          analyser.getFloatTimeDomainData(this.rmsBuf)
          let sum = 0
          for (let i = 0; i < this.rmsBuf.length; i++) sum += this.rmsBuf[i] * this.rmsBuf[i]
          const rms = Math.sqrt(sum / this.rmsBuf.length)
          const db = rms > 1e-7 ? Math.max(-72, 20 * Math.log10(rms)) : -72
          for (const cb of subs) cb(db)
        })

        // Tick gate / expander state machines from the audio-rate input level
        if (node.type === 'gate' && node.gateRefs) {
          for (const g of node.gateRefs) this.tickGate(g)
        } else if (node.type === 'expander' && node.expanderRefs) {
          for (const e of node.expanderRefs) this.tickExpander(e)
        }
      })
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private tickGate(g: GateChannel): void {
    g.monitor.getFloatTimeDomainData(g.buf)
    let sum = 0
    for (let i = 0; i < g.buf.length; i++) sum += g.buf[i] * g.buf[i]
    const rms = Math.sqrt(sum / g.buf.length)
    const db = rms > 1e-7 ? 20 * Math.log10(rms) : -120
    const target = db >= g.threshold ? 1 : 0
    const tau = target > 0 ? g.attack : g.release
    g.gain.gain.setTargetAtTime(target, this.context.currentTime, Math.max(0.001, tau))
  }

  private tickExpander(e: ExpanderChannel): void {
    e.monitor.getFloatTimeDomainData(e.buf)
    let sum = 0
    for (let i = 0; i < e.buf.length; i++) sum += e.buf[i] * e.buf[i]
    const rms = Math.sqrt(sum / e.buf.length)
    const db = rms > 1e-7 ? 20 * Math.log10(rms) : -120
    // Below threshold: attenuate by (ratio-1)·(db-threshold) dB; above: unity.
    const reductionDb = db < e.threshold ? (Math.max(1, e.ratio) - 1) * (db - e.threshold) : 0
    const target = Math.pow(10, reductionDb / 20)
    // More attenuation = the "attack" direction (closing), recovery = "release".
    const tau = target < 1 ? e.attack : e.release
    e.gain.gain.setTargetAtTime(target, this.context.currentTime, Math.max(0.001, tau))
  }

  private makeAnalyser(): AnalyserNode {
    const a = this.context.createAnalyser()
    a.fftSize = 256
    a.smoothingTimeConstant = 0.5
    return a
  }

  getCompressorReduction(id: string, channel = 0): number {
    return this.nodes.get(id)?.compressorRefs?.[channel]?.reduction ?? 0
  }

  getNode(id: string): ManagedNode | undefined {
    return this.nodes.get(id)
  }

  // ── Input device ────────────────────────────────────────────────────────

  async createInputNode(id: string, deviceId?: string, deviceName?: string): Promise<void> {
    await this.init()
    const existing = this.nodes.get(id)
    existing?.mediaStream?.getTracks().forEach(t => t.stop())

    const constraints: MediaStreamConstraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2
      } as MediaTrackConstraints,
      video: false
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    const source = this.context.createMediaStreamSource(stream)
    const gain = this.context.createGain()
    const analyser = this.makeAnalyser()
    source.connect(gain)
    gain.connect(analyser)

    // When the device drops (unplugged / default switched), the track ends —
    // schedule an auto-recovery attempt.
    const track = stream.getAudioTracks()[0]
    if (track) track.onended = () => this.scheduleInputReconnect(id)

    // If we're swapping device on an existing node, preserve downstream wiring
    if (existing) {
      if (existing.inputReconnectTimer) { window.clearTimeout(existing.inputReconnectTimer); existing.inputReconnectTimer = undefined }
      // Carry the prior gain/mute onto the new gain node so a device swap
      // doesn't reset the level or un-mute.
      gain.gain.value = existing.muted ? 0 : (existing.userGain ?? 1)
      const oldOut = existing.outputs[0]
      // rewire: existing downstream consumers were connected to oldOut → they
      // stay connected because we replace the outputs array with the new
      // analyser, but the old analyser is still the AudioNode they point to.
      // So actually: connect new analyser to the same downstream targets.
      this.relinkDownstream(id, oldOut, analyser)
      existing.mediaStream = stream
      existing.outputs = [analyser]
      existing.meters = [analyser]
      existing.gainRefs = [gain]
      existing.inputDeviceId = deviceId
      if (deviceName !== undefined) existing.inputDeviceName = deviceName
      existing.inputActive = true
      this.notifyNodeSubs()
      return
    }

    this.nodes.set(id, {
      type: 'input',
      inputs: [],
      outputs: [analyser],
      meters: [analyser],
      gainRefs: [gain],
      mediaStream: stream,
      inputDeviceId: deviceId,
      inputDeviceName: deviceName,
      inputActive: true
    })
    this.notifyNodeSubs()
  }

  /** Periodically retry an input whose device dropped, until it returns. */
  private scheduleInputReconnect(id: string): void {
    const node = this.nodes.get(id)
    if (!node || node.type !== 'input') return
    node.inputActive = false
    this.notifyNodeSubs()
    if (node.inputReconnectTimer) window.clearTimeout(node.inputReconnectTimer)
    node.inputReconnectTimer = window.setTimeout(async () => {
      const current = this.nodes.get(id)
      if (!current || current.type !== 'input') return
      try {
        // If a specific device was chosen, only retry once it (or a same-named
        // endpoint with a churned id) is present again, then reconnect to it.
        if (current.inputDeviceId) {
          const devices = await navigator.mediaDevices.enumerateDevices()
          const resolved = resolveDeviceId(devices, current.inputDeviceId, current.inputDeviceName, 'audioinput')
          if (resolved === undefined) { this.scheduleInputReconnect(id); return }
          await this.createInputNode(id, resolved, current.inputDeviceName)
          return
        }
        await this.createInputNode(id, current.inputDeviceId, current.inputDeviceName)
      } catch {
        this.scheduleInputReconnect(id)
      }
    }, 3000)
  }

  /** Re-arm any inputs that are currently inactive (called on devicechange). */
  async recoverInputs(): Promise<void> {
    for (const [id, node] of this.nodes) {
      if (node.type === 'input' && node.inputActive === false) this.scheduleInputReconnect(id)
    }
  }

  isInputActive(id: string): boolean {
    return this.nodes.get(id)?.inputActive ?? true
  }

  /** Rewire any active connections that pointed FROM oldOut to point FROM newOut. */
  private relinkDownstream(nodeId: string, oldOut: AudioNode, newOut: AudioNode): void {
    for (const c of this.connections) {
      if (c.source === nodeId && c.srcNode === oldOut) {
        try { oldOut.disconnect(c.tgtNode) } catch {}
        try { newOut.connect(c.tgtNode) } catch {}
        c.srcNode = newOut
      }
    }
  }

  // ── Application capture ─────────────────────────────────────────────────

  async createApplicationNode(id: string, sourceId: string, sourceName: string): Promise<void> {
    await this.init()
    const passThrough = this.context.createGain()
    const analyser = this.makeAnalyser()
    passThrough.connect(analyser)

    this.nodes.set(id, {
      type: 'application',
      inputs: [],
      outputs: [analyser],
      meters: [analyser],
      appPassThrough: passThrough,
      appSourceName: sourceName,
      appActive: false
    })
    this.notifyNodeSubs()
    if (sourceId) await this.armApplicationCapture(id, sourceId, sourceName)
  }

  /** Attempt to start (or restart) audio capture for an application node. */
  async armApplicationCapture(id: string, sourceId: string, sourceName: string): Promise<void> {
    const node = this.nodes.get(id)
    if (!node || node.type !== 'application' || !node.appPassThrough) return
    if (!sourceId) return  // No source picked yet

    // Cancel any pending auto-reconnect; this fresh arm supersedes it. Otherwise
    // a stale timer could re-arm to a previously-captured source.
    if (node.appReconnectTimer) {
      window.clearTimeout(node.appReconnectTimer)
      node.appReconnectTimer = undefined
    }

    // Stop any existing stream first
    node.mediaStream?.getTracks().forEach(t => t.stop())
    node.mediaStream = undefined

    try {
      await window.api.armCaptureSource(sourceId)
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      })

      // Discard the video tracks — we only want audio
      stream.getVideoTracks().forEach(t => t.stop())

      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) {
        console.warn('Application capture: no audio tracks returned')
        node.appActive = false
        this.notifyNodeSubs()
        this.scheduleAppReconnect(id, sourceName)
        return
      }

      const audioOnly = new MediaStream(audioTracks)
      const source = this.context.createMediaStreamSource(audioOnly)
      source.connect(node.appPassThrough)
      node.mediaStream = audioOnly
      node.appActive = true
      node.appSourceName = sourceName

      // When the app closes, the track ends. Schedule reconnect.
      audioTracks[0].onended = () => {
        const stillThere = this.nodes.get(id)
        if (!stillThere || stillThere.type !== 'application') return
        // Ignore if the user has since switched this node to a different
        // stream — only the currently-active capture should drive reconnects.
        if (stillThere.mediaStream !== audioOnly) return
        stillThere.appActive = false
        this.notifyNodeSubs()
        this.scheduleAppReconnect(id, sourceName)
      }

      this.notifyNodeSubs()
    } catch (e) {
      console.warn('Application capture failed:', e)
      node.appActive = false
      this.notifyNodeSubs()
    }
  }

  private scheduleAppReconnect(id: string, sourceName: string): void {
    const node = this.nodes.get(id)
    if (!node) return
    if (node.appReconnectTimer) window.clearTimeout(node.appReconnectTimer)

    node.appReconnectTimer = window.setTimeout(async () => {
      const current = this.nodes.get(id)
      if (!current || current.type !== 'application') return
      const match = await window.api.findSourceByName(sourceName)
      if (match) {
        await this.armApplicationCapture(id, match.id, sourceName)
      } else {
        // Still not back — try again later
        this.scheduleAppReconnect(id, sourceName)
      }
    }, 4000)
  }

  isApplicationActive(id: string): boolean {
    return this.nodes.get(id)?.appActive ?? false
  }

  // ── Output device ───────────────────────────────────────────────────────

  /**
   * Create an output sink. `type: 'output'` is a physical monitor device;
   * `type: 'virtual'` is intended for a virtual audio cable so other apps can
   * capture the mix. Both route through their own MediaStream → <audio> element
   * (rather than the shared ctx.destination) so each output can target a
   * different device via setSinkId.
   */
  createOutputNode(id: string, type: 'output' | 'virtual' = 'output'): void {
    const ctx = this.context
    const gain = ctx.createGain()
    const analyser = this.makeAnalyser()
    const streamDest = ctx.createMediaStreamDestination()
    gain.connect(analyser)
    analyser.connect(streamDest)

    const audioEl = new Audio()
    audioEl.srcObject = streamDest.stream
    audioEl.autoplay = true
    // A Virtual Output must not play to the default device until a real cable is chosen
    // (otherwise it doubles up with the Output node). Start muted; setOutputDevice unmutes
    // once a non-empty device id is set.
    if (type === 'virtual') audioEl.muted = true
    // A play() interrupted by an immediate pause()/teardown (e.g. toggling a
    // workspace off right after adding an output) rejects with AbortError —
    // that's benign, so only surface genuine playback failures.
    void audioEl.play().catch((e: DOMException) => {
      if (e?.name !== 'AbortError') console.warn('Output element play() failed:', e)
    })

    this.nodes.set(id, {
      type,
      inputs: [gain],
      outputs: [],
      meters: [analyser],
      gainRefs: [gain],
      outputSink: audioEl
    })
    this.notifyNodeSubs()
  }

  async setOutputDevice(id: string, deviceId: string, deviceName?: string): Promise<void> {
    const node = this.nodes.get(id)
    if (!node?.outputSink) return
    node.outputDeviceId = deviceId
    if (deviceName !== undefined) node.outputDeviceName = deviceName
    // Virtual Output stays silent until a real cable is selected (see createOutputNode).
    if (node.type === 'virtual') node.outputSink.muted = !deviceId
    try {
      // Empty string selects the system default device.
      await node.outputSink.setSinkId(deviceId || '')
    } catch (e) {
      console.warn('setSinkId failed:', e)
    }
  }

  /** Re-apply each output's chosen device + resume playback after a devicechange. */
  async recoverOutputs(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
    for (const node of this.nodes.values()) {
      const el = node.outputSink
      if (!el) continue
      try {
        if (node.outputDeviceId) {
          // Re-resolve in case the id churned; fall back to the saved label.
          const resolved = resolveDeviceId(devices, node.outputDeviceId, node.outputDeviceName, 'audiooutput')
          if (resolved !== undefined) {
            node.outputDeviceId = resolved
            await el.setSinkId(resolved)
          }
          // else: not present yet — keep the current sink, retry on next devicechange.
        }
        if (el.paused) await el.play()
      } catch { /* device not ready yet — will retry on next devicechange */ }
    }
  }

  // ── Recorder (sink → MediaRecorder → file) ──────────────────────────────

  /** First MediaRecorder mime type the platform supports, with a file extension. */
  private pickRecorderMime(): { mime: string; ext: string } {
    const candidates: Array<{ mime: string; ext: string }> = [
      { mime: 'audio/webm;codecs=opus', ext: 'webm' },
      { mime: 'audio/webm', ext: 'webm' },
      { mime: 'audio/ogg;codecs=opus', ext: 'ogg' }
    ]
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) return c
    }
    return { mime: '', ext: 'webm' } // let the browser choose its default container
  }

  /** A sink that captures whatever reaches it into a downloadable recording. */
  createRecorderNode(id: string): void {
    const ctx = this.context
    const gain = ctx.createGain()
    const analyser = this.makeAnalyser()
    const streamDest = ctx.createMediaStreamDestination()
    gain.connect(analyser)
    analyser.connect(streamDest)

    this.nodes.set(id, {
      type: 'recorder',
      inputs: [gain],
      // Pass the signal through (post input-gain) so it can be monitored / routed
      // onward while recording — e.g. play it straight to an Output.
      outputs: [analyser],
      meters: [analyser],
      gainRefs: [gain],
      recStreamDest: streamDest,
      recActive: false
    })
    this.notifyNodeSubs()
  }

  startRecording(id: string): boolean {
    const node = this.nodes.get(id)
    if (!node?.recStreamDest) return false
    if (node.recActive) return true
    const { mime, ext } = this.pickRecorderMime()
    try {
      const rec = mime ? new MediaRecorder(node.recStreamDest.stream, { mimeType: mime })
                       : new MediaRecorder(node.recStreamDest.stream)
      node.recChunks = []
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) node.recChunks!.push(e.data) }
      rec.start()
      node.recRecorder = rec
      node.recActive = true
      node.recMime = rec.mimeType || mime
      node.recExt = ext
      this.notifyNodeSubs()
      return true
    } catch (e) {
      console.warn('startRecording failed:', e)
      return false
    }
  }

  stopRecording(id: string): Promise<{ blob: Blob; mimeType: string; extension: string } | null> {
    const node = this.nodes.get(id)
    const rec = node?.recRecorder
    if (!node || !rec || !node.recActive) return Promise.resolve(null)
    return new Promise((resolve) => {
      rec.onstop = () => {
        const mimeType = node.recMime || 'audio/webm'
        const blob = new Blob(node.recChunks ?? [], { type: mimeType })
        node.recChunks = []
        node.recActive = false
        node.recRecorder = undefined
        this.notifyNodeSubs()
        resolve({ blob, mimeType, extension: node.recExt || 'webm' })
      }
      try { rec.stop() } catch { resolve(null) }
    })
  }

  isRecording(id: string): boolean {
    return this.nodes.get(id)?.recActive ?? false
  }

  // ── File player (source: an audio file → the graph) ─────────────────────

  /** A source node that plays a local audio file into the graph. */
  createFilePlayerNode(id: string): void {
    const ctx = this.context
    const el = new Audio()
    el.preload = 'auto'
    // Routing the element through a MediaElementSource sends its audio into the
    // graph instead of straight to the speakers, so it behaves like any source.
    const source = ctx.createMediaElementSource(el)
    const gain = ctx.createGain()
    const analyser = this.makeAnalyser()
    source.connect(gain)
    gain.connect(analyser)

    this.nodes.set(id, {
      type: 'fileplayer',
      inputs: [],
      outputs: [analyser],
      meters: [analyser],
      gainRefs: [gain],
      fileEl: el,
      fileSource: source
    })
    this.notifyNodeSubs()
  }

  /** Point the player at a (blob/object) URL. */
  loadFilePlayer(id: string, url: string): void {
    const el = this.nodes.get(id)?.fileEl
    if (!el) return
    el.src = url
    el.load()
  }

  playFilePlayer(id: string): void {
    const el = this.nodes.get(id)?.fileEl
    if (el?.src) void el.play().catch(e => console.warn('File player play() failed:', e))
  }

  pauseFilePlayer(id: string): void {
    this.nodes.get(id)?.fileEl?.pause()
  }

  setFilePlayerLoop(id: string, loop: boolean): void {
    const el = this.nodes.get(id)?.fileEl
    if (el) el.loop = loop
  }

  seekFilePlayer(id: string, seconds: number): void {
    const el = this.nodes.get(id)?.fileEl
    if (el && isFinite(seconds)) el.currentTime = Math.max(0, seconds)
  }

  getFilePlayerStatus(id: string): { playing: boolean; currentTime: number; duration: number } {
    const el = this.nodes.get(id)?.fileEl
    return {
      playing: !!el && !el.paused && !el.ended,
      currentTime: el?.currentTime ?? 0,
      duration: el && isFinite(el.duration) ? el.duration : 0
    }
  }

  /** Estimated input→output latency in ms (Web Audio context latencies). */
  getLatencyMs(): number {
    const ctx = this.ctx
    if (!ctx) return 0
    const base = ctx.baseLatency ?? 0
    const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0
    return Math.round((base + out) * 1000)
  }

  /** Web Audio latency isn't tunable this way — no-op (satisfies the backend interface). */
  setLatencyMode(_mode: 'low' | 'balanced' | 'safe'): void {}
  setDeviceMode(_mode: 'shared' | 'lowlatency' | 'exclusive'): void {}

  // ── Effect: Volume (multi-channel) ──────────────────────────────────────

  createVolumeNode(id: string, channels = 1): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const gainRefs: GainNode[] = []

    for (let i = 0; i < channels; i++) {
      const gain = ctx.createGain()
      const meter = this.makeAnalyser()
      gain.connect(meter)
      inputs.push(gain)
      outputs.push(meter)
      meters.push(meter)
      gainRefs.push(gain)
    }

    this.nodes.set(id, { type: 'volume', inputs, outputs, meters, gainRefs })
    this.notifyNodeSubs()
  }

  // ── Effect: EQ (multi-channel) ──────────────────────────────────────────

  createEQNode(id: string, channels = 1, bands: EQBand[] = DEFAULT_EQ_BANDS): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const eqRefs: BiquadFilterNode[][] = []

    for (let c = 0; c < channels; c++) {
      const filters = bands.map(b => {
        const f = ctx.createBiquadFilter()
        f.type = b.type
        f.frequency.value = b.frequency
        f.gain.value = b.gain
        f.Q.value = b.Q
        return f
      })
      for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1])
      const meter = this.makeAnalyser()
      filters[filters.length - 1].connect(meter)

      eqRefs.push(filters)
      inputs.push(filters[0])
      outputs.push(meter)
      meters.push(meter)
    }

    this.nodes.set(id, { type: 'eq', inputs, outputs, meters, eqRefs })
    this.notifyNodeSubs()
  }

  setEQBand(id: string, bandIndex: number, gain: number): void {
    const refs = this.nodes.get(id)?.eqRefs
    if (!refs) return
    const t = this.context.currentTime
    for (const chFilters of refs) {
      chFilters[bandIndex]?.gain.setTargetAtTime(gain, t, 0.005)
    }
  }

  // ── Effect: Compressor (multi-channel) ──────────────────────────────────

  createCompressorNode(id: string, channels = 1): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const compressorRefs: DynamicsCompressorNode[] = []

    for (let i = 0; i < channels; i++) {
      const c = ctx.createDynamicsCompressor()
      c.threshold.value = -24
      c.knee.value = 6
      c.ratio.value = 4
      c.attack.value = 0.003
      c.release.value = 0.25
      const meter = this.makeAnalyser()
      c.connect(meter)
      compressorRefs.push(c)
      inputs.push(c)
      outputs.push(meter)
      meters.push(meter)
    }

    this.nodes.set(id, { type: 'compressor', inputs, outputs, meters, compressorRefs })
    this.notifyNodeSubs()
  }

  setCompressor(
    id: string,
    params: Partial<{ threshold: number; knee: number; ratio: number; attack: number; release: number }>
  ): void {
    const refs = this.nodes.get(id)?.compressorRefs
    if (!refs) return
    const t = this.context.currentTime
    for (const c of refs) {
      if (params.threshold !== undefined) c.threshold.setTargetAtTime(params.threshold, t, 0.01)
      if (params.knee !== undefined)      c.knee.setTargetAtTime(params.knee, t, 0.01)
      if (params.ratio !== undefined)     c.ratio.setTargetAtTime(params.ratio, t, 0.01)
      if (params.attack !== undefined)    c.attack.setTargetAtTime(params.attack, t, 0.01)
      if (params.release !== undefined)   c.release.setTargetAtTime(params.release, t, 0.01)
    }
  }

  // ── Effect: Gate (multi-channel, actually gates!) ──────────────────────

  createGateNode(id: string, channels = 1): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const gateRefs: GateChannel[] = []

    for (let i = 0; i < channels; i++) {
      const entry = ctx.createGain()           // pass-through input (split point)
      const monitor = ctx.createAnalyser()     // taps the input for level reading
      monitor.fftSize = 256
      const gateGain = ctx.createGain()        // the actual gate
      gateGain.gain.value = 1
      const meter = this.makeAnalyser()        // output meter

      entry.connect(monitor)                   // monitor reads pre-gate level
      entry.connect(gateGain)                  // signal passes through gate
      gateGain.connect(meter)                  // out

      gateRefs.push({
        monitor,
        gain: gateGain,
        buf: new Float32Array(new ArrayBuffer(monitor.fftSize * 4)),
        threshold: -50, attack: 0.005, release: 0.1
      })
      inputs.push(entry)
      outputs.push(meter)
      meters.push(meter)
    }

    this.nodes.set(id, { type: 'gate', inputs, outputs, meters, gateRefs })
    this.notifyNodeSubs()
  }

  setGate(
    id: string,
    params: Partial<{ threshold: number; attack: number; release: number }>
  ): void {
    const refs = this.nodes.get(id)?.gateRefs
    if (!refs) return
    for (const g of refs) {
      if (params.threshold !== undefined) g.threshold = params.threshold
      if (params.attack !== undefined)    g.attack = params.attack
      if (params.release !== undefined)   g.release = params.release
    }
  }

  // ── Mixer (N inputs → 1 output) ────────────────────────────────────────

  createMixerNode(id: string, channels = 4): void {
    const ctx = this.context
    const inputGains: GainNode[] = []
    const master = ctx.createGain()
    const meter = this.makeAnalyser()
    master.connect(meter)

    for (let i = 0; i < channels; i++) {
      const g = ctx.createGain()
      g.connect(master)
      inputGains.push(g)
    }

    this.nodes.set(id, {
      type: 'mixer',
      inputs: inputGains,
      outputs: [meter],
      meters: [meter],
      mixerInputGains: inputGains,
      mixerMaster: master
    })
    this.notifyNodeSubs()
  }

  setMixerChannel(id: string, channel: number, gain: number): void {
    const g = this.nodes.get(id)?.mixerInputGains?.[channel]
    if (g) g.gain.setTargetAtTime(gain, this.context.currentTime, 0.01)
  }

  setMixerMaster(id: string, gain: number): void {
    const g = this.nodes.get(id)?.mixerMaster
    if (g) g.gain.setTargetAtTime(gain, this.context.currentTime, 0.01)
  }

  // ── Effect: Reverb (convolution, multi-channel) ─────────────────────────

  /** Build a synthetic impulse response: shaped noise with an exponential tail. */
  private buildImpulseResponse(decay: number, preDelay: number): AudioBuffer {
    const ctx = this.context
    const rate = ctx.sampleRate
    const pre = Math.max(0, Math.floor(preDelay * rate))
    const tail = Math.max(1, Math.floor(decay * rate))
    const length = pre + tail
    const ir = ctx.createBuffer(2, length, rate)
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch)
      for (let i = pre; i < length; i++) {
        const t = (i - pre) / tail            // 0 → 1 across the tail
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5)
      }
    }
    return ir
  }

  createReverbNode(id: string, channels = 1, params: ReverbParams = DEFAULT_REVERB): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: ReverbChannel[] = []
    const ir = this.buildImpulseResponse(params.decay, params.preDelay)

    for (let i = 0; i < channels; i++) {
      const input = ctx.createGain()
      const convolver = ctx.createConvolver()
      convolver.buffer = ir
      const dry = ctx.createGain()
      const wet = ctx.createGain()
      const meter = this.makeAnalyser()

      dry.gain.value = 1 - params.mix
      wet.gain.value = params.mix
      input.connect(dry); dry.connect(meter)
      input.connect(convolver); convolver.connect(wet); wet.connect(meter)

      refs.push({ input, convolver, dry, wet })
      inputs.push(input); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, {
      type: 'reverb', inputs, outputs, meters,
      reverbRefs: refs, reverbParams: { ...params }
    })
    this.notifyNodeSubs()
  }

  setReverb(id: string, params: Partial<ReverbParams>): void {
    const node = this.nodes.get(id)
    if (!node?.reverbRefs || !node.reverbParams) return
    const p = node.reverbParams
    const rebuild = params.decay !== undefined || params.preDelay !== undefined
    if (params.mix !== undefined) p.mix = params.mix
    if (params.decay !== undefined) p.decay = params.decay
    if (params.preDelay !== undefined) p.preDelay = params.preDelay

    const t = this.context.currentTime
    for (const ch of node.reverbRefs) {
      ch.dry.gain.setTargetAtTime(1 - p.mix, t, 0.02)
      ch.wet.gain.setTargetAtTime(p.mix, t, 0.02)
    }
    if (rebuild) {
      const ir = this.buildImpulseResponse(p.decay, p.preDelay)
      for (const ch of node.reverbRefs) ch.convolver.buffer = ir
    }
  }

  // ── Effect: Delay / Echo (multi-channel) ────────────────────────────────

  createDelayNode(id: string, channels = 1, params: DelayParams = DEFAULT_DELAY): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: DelayChannel[] = []

    for (let i = 0; i < channels; i++) {
      const input = ctx.createGain()
      const delay = ctx.createDelay(5.0)
      const feedback = ctx.createGain()
      const dry = ctx.createGain()
      const wet = ctx.createGain()
      const meter = this.makeAnalyser()

      delay.delayTime.value = params.time
      feedback.gain.value = params.feedback
      dry.gain.value = 1 - params.mix
      wet.gain.value = params.mix

      input.connect(dry); dry.connect(meter)
      input.connect(delay)
      delay.connect(feedback); feedback.connect(delay)   // regenerating echoes
      delay.connect(wet); wet.connect(meter)

      refs.push({ input, delay, feedback, dry, wet })
      inputs.push(input); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, {
      type: 'delay', inputs, outputs, meters,
      delayRefs: refs, delayParams: { ...params }
    })
    this.notifyNodeSubs()
  }

  setDelay(id: string, params: Partial<DelayParams>): void {
    const node = this.nodes.get(id)
    if (!node?.delayRefs || !node.delayParams) return
    const p = node.delayParams
    if (params.time !== undefined) p.time = params.time
    if (params.feedback !== undefined) p.feedback = params.feedback
    if (params.mix !== undefined) p.mix = params.mix

    const t = this.context.currentTime
    for (const ch of node.delayRefs) {
      if (params.time !== undefined) ch.delay.delayTime.setTargetAtTime(p.time, t, 0.02)
      if (params.feedback !== undefined) ch.feedback.gain.setTargetAtTime(p.feedback, t, 0.02)
      if (params.mix !== undefined) {
        ch.dry.gain.setTargetAtTime(1 - p.mix, t, 0.02)
        ch.wet.gain.setTargetAtTime(p.mix, t, 0.02)
      }
    }
  }

  // ── Effect: Chorus (LFO-modulated delay, multi-channel) ─────────────────

  createChorusNode(id: string, channels = 1, params: ChorusParams = DEFAULT_CHORUS): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: ChorusChannel[] = []
    const BASE_DELAY = 0.025   // 25 ms centre delay

    for (let i = 0; i < channels; i++) {
      const input = ctx.createGain()
      const delay = ctx.createDelay(1.0)
      const lfo = ctx.createOscillator()
      const depth = ctx.createGain()
      const dry = ctx.createGain()
      const wet = ctx.createGain()
      const meter = this.makeAnalyser()

      delay.delayTime.value = BASE_DELAY
      lfo.type = 'sine'
      lfo.frequency.value = params.rate
      depth.gain.value = params.depth
      lfo.connect(depth); depth.connect(delay.delayTime)

      dry.gain.value = 1 - params.mix
      wet.gain.value = params.mix
      input.connect(dry); dry.connect(meter)
      input.connect(delay); delay.connect(wet); wet.connect(meter)
      lfo.start()

      refs.push({ input, delay, lfo, depth, dry, wet })
      inputs.push(input); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, {
      type: 'chorus', inputs, outputs, meters,
      chorusRefs: refs, chorusParams: { ...params }
    })
    this.notifyNodeSubs()
  }

  setChorus(id: string, params: Partial<ChorusParams>): void {
    const node = this.nodes.get(id)
    if (!node?.chorusRefs || !node.chorusParams) return
    const p = node.chorusParams
    if (params.rate !== undefined) p.rate = params.rate
    if (params.depth !== undefined) p.depth = params.depth
    if (params.mix !== undefined) p.mix = params.mix

    const t = this.context.currentTime
    for (const ch of node.chorusRefs) {
      if (params.rate !== undefined) ch.lfo.frequency.setTargetAtTime(p.rate, t, 0.02)
      if (params.depth !== undefined) ch.depth.gain.setTargetAtTime(p.depth, t, 0.02)
      if (params.mix !== undefined) {
        ch.dry.gain.setTargetAtTime(1 - p.mix, t, 0.02)
        ch.wet.gain.setTargetAtTime(p.mix, t, 0.02)
      }
    }
  }

  // ── Effect: Distortion / Saturation (multi-channel) ─────────────────────

  /** tanh soft-clip curve; higher drive → harder saturation. */
  private buildDistortionCurve(drive: number): Float32Array<ArrayBuffer> {
    const n = 1024
    // Explicit ArrayBuffer backing — WaveShaperNode.curve requires Float32Array<ArrayBuffer>.
    const curve = new Float32Array(new ArrayBuffer(n * 4))
    const k = Math.max(0.001, drive)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(k * x)
    }
    return curve
  }

  /** Output trim that keeps loudness roughly constant as drive increases. */
  private distortionMakeup(drive: number): number {
    return 1 / Math.max(1, Math.sqrt(drive))
  }

  createDistortionNode(id: string, channels = 1, params: DistortionParams = DEFAULT_DISTORTION): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: DistortionChannel[] = []

    for (let i = 0; i < channels; i++) {
      const input = ctx.createGain()
      const shaper = ctx.createWaveShaper()
      shaper.curve = this.buildDistortionCurve(params.drive)
      shaper.oversample = '4x'
      const makeup = ctx.createGain()
      makeup.gain.value = this.distortionMakeup(params.drive)
      const dry = ctx.createGain()
      const wet = ctx.createGain()
      const meter = this.makeAnalyser()

      dry.gain.value = 1 - params.mix
      wet.gain.value = params.mix
      input.connect(dry); dry.connect(meter)
      input.connect(shaper); shaper.connect(makeup); makeup.connect(wet); wet.connect(meter)

      refs.push({ input, shaper, makeup, dry, wet })
      inputs.push(input); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, {
      type: 'distortion', inputs, outputs, meters,
      distortionRefs: refs, distortionParams: { ...params }
    })
    this.notifyNodeSubs()
  }

  setDistortion(id: string, params: Partial<DistortionParams>): void {
    const node = this.nodes.get(id)
    if (!node?.distortionRefs || !node.distortionParams) return
    const p = node.distortionParams
    if (params.drive !== undefined) p.drive = params.drive
    if (params.mix !== undefined) p.mix = params.mix

    const t = this.context.currentTime
    for (const ch of node.distortionRefs) {
      if (params.drive !== undefined) {
        ch.shaper.curve = this.buildDistortionCurve(p.drive)
        ch.makeup.gain.setTargetAtTime(this.distortionMakeup(p.drive), t, 0.02)
      }
      if (params.mix !== undefined) {
        ch.dry.gain.setTargetAtTime(1 - p.mix, t, 0.02)
        ch.wet.gain.setTargetAtTime(p.mix, t, 0.02)
      }
    }
  }

  // ── Effect: Pan (stereo positioning, multi-channel) ─────────────────────

  createPanNode(id: string, channels = 1, params: PanParams = DEFAULT_PAN): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: PanChannel[] = []

    for (let i = 0; i < channels; i++) {
      const input = ctx.createGain()
      const panner = ctx.createStereoPanner()
      panner.pan.value = params.pan
      const meter = this.makeAnalyser()
      input.connect(panner); panner.connect(meter)

      refs.push({ input, panner })
      inputs.push(input); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, {
      type: 'pan', inputs, outputs, meters,
      panRefs: refs, panParams: { ...params }
    })
    this.notifyNodeSubs()
  }

  setPan(id: string, pan: number): void {
    const node = this.nodes.get(id)
    if (!node?.panRefs || !node.panParams) return
    node.panParams.pan = pan
    const t = this.context.currentTime
    for (const ch of node.panRefs) ch.panner.pan.setTargetAtTime(pan, t, 0.02)
  }

  // ── Effect: Filter (standalone biquad, multi-channel) ───────────────────

  private filterTypeName(t: number): BiquadFilterType {
    return (['lowpass', 'highpass', 'bandpass', 'notch'] as const)[Math.max(0, Math.min(3, Math.round(t)))]
  }

  createFilterNode(id: string, channels = 1, params: FilterParams = DEFAULT_FILTER): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: BiquadFilterNode[] = []

    for (let i = 0; i < channels; i++) {
      const filter = ctx.createBiquadFilter()
      filter.type = this.filterTypeName(params.type)
      filter.frequency.value = params.cutoff
      filter.Q.value = params.q
      const meter = this.makeAnalyser()
      filter.connect(meter)
      refs.push(filter)
      inputs.push(filter); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, { type: 'filter', inputs, outputs, meters, filterRefs: refs, filterParams: { ...params } })
    this.notifyNodeSubs()
  }

  setFilter(id: string, params: Partial<FilterParams>): void {
    const node = this.nodes.get(id)
    if (!node?.filterRefs || !node.filterParams) return
    const p = node.filterParams
    if (params.type !== undefined) p.type = params.type
    if (params.cutoff !== undefined) p.cutoff = params.cutoff
    if (params.q !== undefined) p.q = params.q
    const t = this.context.currentTime
    for (const f of node.filterRefs) {
      if (params.type !== undefined) f.type = this.filterTypeName(p.type)
      if (params.cutoff !== undefined) f.frequency.setTargetAtTime(p.cutoff, t, 0.02)
      if (params.q !== undefined) f.Q.setTargetAtTime(p.q, t, 0.02)
    }
  }

  // ── Effect: Limiter (brickwall, via a high-ratio DynamicsCompressor) ────

  createLimiterNode(id: string, channels = 1, params: LimiterParams = DEFAULT_LIMITER): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: DynamicsCompressorNode[] = []

    for (let i = 0; i < channels; i++) {
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = params.threshold
      comp.knee.value = 0          // hard knee → brickwall-ish
      comp.ratio.value = 20        // max ratio
      comp.attack.value = 0.001    // fast, to catch peaks
      comp.release.value = params.release
      const meter = this.makeAnalyser()
      comp.connect(meter)
      refs.push(comp)
      inputs.push(comp); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, { type: 'limiter', inputs, outputs, meters, limiterRefs: refs, limiterParams: { ...params } })
    this.notifyNodeSubs()
  }

  setLimiter(id: string, params: Partial<LimiterParams>): void {
    const node = this.nodes.get(id)
    if (!node?.limiterRefs || !node.limiterParams) return
    const p = node.limiterParams
    if (params.threshold !== undefined) p.threshold = params.threshold
    if (params.release !== undefined) p.release = params.release
    const t = this.context.currentTime
    for (const c of node.limiterRefs) {
      if (params.threshold !== undefined) c.threshold.setTargetAtTime(p.threshold, t, 0.01)
      if (params.release !== undefined) c.release.setTargetAtTime(p.release, t, 0.01)
    }
  }

  // ── Effect: Expander (downward, meter-driven gain — see tickExpander) ───

  createExpanderNode(id: string, channels = 1, params: ExpanderParams = DEFAULT_EXPANDER): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: ExpanderChannel[] = []

    for (let i = 0; i < channels; i++) {
      const entry = ctx.createGain()
      const monitor = ctx.createAnalyser()
      monitor.fftSize = 256
      const expGain = ctx.createGain()
      expGain.gain.value = 1
      const meter = this.makeAnalyser()
      entry.connect(monitor)
      entry.connect(expGain)
      expGain.connect(meter)
      refs.push({
        monitor, gain: expGain,
        buf: new Float32Array(new ArrayBuffer(monitor.fftSize * 4)),
        threshold: params.threshold, ratio: params.ratio, attack: params.attack, release: params.release
      })
      inputs.push(entry); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, { type: 'expander', inputs, outputs, meters, expanderRefs: refs, expanderParams: { ...params } })
    this.notifyNodeSubs()
  }

  setExpander(id: string, params: Partial<ExpanderParams>): void {
    const node = this.nodes.get(id)
    if (!node?.expanderRefs || !node.expanderParams) return
    const p = node.expanderParams
    if (params.threshold !== undefined) p.threshold = params.threshold
    if (params.ratio !== undefined) p.ratio = params.ratio
    if (params.attack !== undefined) p.attack = params.attack
    if (params.release !== undefined) p.release = params.release
    for (const e of node.expanderRefs) {
      if (params.threshold !== undefined) e.threshold = p.threshold
      if (params.ratio !== undefined) e.ratio = p.ratio
      if (params.attack !== undefined) e.attack = p.attack
      if (params.release !== undefined) e.release = p.release
    }
  }

  // ── Effect: Tremolo / Auto-pan (OscillatorNode LFO) ─────────────────────

  private wireTremolo(ch: TremoloChannel): void {
    // Re-point the LFO to the active target and neutralize the idle one.
    try { ch.lfo.disconnect() } catch { /* not connected yet */ }
    ch.osc.type = ch.shape === 1 ? 'triangle' : 'sine'
    ch.osc.frequency.value = ch.rate
    const d = Math.max(0, Math.min(1, ch.depth))
    if (ch.mode === 1) {
      // Auto-pan: amplitude flat, LFO drives pan over [-depth, depth].
      ch.amp.gain.value = 1
      ch.panner.pan.value = 0
      ch.lfo.gain.value = d
      ch.lfo.connect(ch.panner.pan)
    } else {
      // Tremolo: pan centred, amplitude oscillates in [1-depth, 1].
      ch.panner.pan.value = 0
      ch.amp.gain.value = 1 - d / 2
      ch.lfo.gain.value = d / 2
      ch.lfo.connect(ch.amp.gain)
    }
  }

  createTremoloNode(id: string, channels = 1, params: TremoloParams = DEFAULT_TREMOLO): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: TremoloChannel[] = []

    for (let i = 0; i < channels; i++) {
      const input = ctx.createGain()
      const amp = ctx.createGain()
      const panner = ctx.createStereoPanner()
      const osc = ctx.createOscillator()
      const lfo = ctx.createGain()
      const meter = this.makeAnalyser()
      input.connect(amp); amp.connect(panner); panner.connect(meter)
      osc.connect(lfo)
      const ch: TremoloChannel = { input, amp, panner, osc, lfo, ...params }
      this.wireTremolo(ch)
      osc.start()
      refs.push(ch)
      inputs.push(input); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, { type: 'tremolo', inputs, outputs, meters, tremoloRefs: refs, tremoloParams: { ...params } })
    this.notifyNodeSubs()
  }

  setTremolo(id: string, params: Partial<TremoloParams>): void {
    const node = this.nodes.get(id)
    if (!node?.tremoloRefs || !node.tremoloParams) return
    const p = node.tremoloParams
    if (params.mode !== undefined) p.mode = params.mode
    if (params.shape !== undefined) p.shape = params.shape
    if (params.rate !== undefined) p.rate = params.rate
    if (params.depth !== undefined) p.depth = params.depth
    for (const ch of node.tremoloRefs) {
      ch.mode = p.mode; ch.shape = p.shape; ch.rate = p.rate; ch.depth = p.depth
      this.wireTremolo(ch)
    }
  }

  // ── Effect: Bitcrusher (ScriptProcessor: quantize + decimate) ───────────

  createBitcrusherNode(id: string, channels = 1, params: CrusherParams = DEFAULT_CRUSHER): void {
    const ctx = this.context
    const inputs: AudioNode[] = []
    const outputs: AudioNode[] = []
    const meters: AnalyserNode[] = []
    const refs: CrusherChannel[] = []

    for (let i = 0; i < channels; i++) {
      const input = ctx.createGain()
      const meter = this.makeAnalyser()
      let proc: AudioWorkletNode | null = null
      if (this.bitcrusherReady) {
        proc = new AudioWorkletNode(ctx, 'bitcrusher-processor', {
          parameterData: { bits: params.bits, downsample: params.downsample, mix: params.mix }
        })
        input.connect(proc); proc.connect(meter)
      } else {
        input.connect(meter) // worklet unavailable → passthrough
      }
      refs.push({ input, proc })
      inputs.push(input); outputs.push(meter); meters.push(meter)
    }

    this.nodes.set(id, { type: 'bitcrusher', inputs, outputs, meters, crusherRefs: refs, crusherParams: { ...params } })
    this.notifyNodeSubs()
  }

  setBitcrusher(id: string, params: Partial<CrusherParams>): void {
    const node = this.nodes.get(id)
    if (!node?.crusherRefs || !node.crusherParams) return
    const p = node.crusherParams
    if (params.bits !== undefined) p.bits = params.bits
    if (params.downsample !== undefined) p.downsample = params.downsample
    if (params.mix !== undefined) p.mix = params.mix
    const t = this.context.currentTime
    for (const ch of node.crusherRefs) {
      if (!ch.proc) continue
      if (params.bits !== undefined) ch.proc.parameters.get('bits')?.setValueAtTime(p.bits, t)
      if (params.downsample !== undefined) ch.proc.parameters.get('downsample')?.setValueAtTime(p.downsample, t)
      if (params.mix !== undefined) ch.proc.parameters.get('mix')?.setValueAtTime(p.mix, t)
    }
  }

  // ── Channel reconfiguration (add/remove channels) ─────────────────────

  /**
   * Change the number of channels on a multi-channel node.
   * Removed channels have their downstream connections severed.
   * Returns the new channel count.
   */
  setChannelCount(id: string, type: AudioNodeType, channels: number): number {
    const node = this.nodes.get(id)
    if (!node) return 0
    channels = Math.max(1, Math.min(8, channels))
    const current = node.inputs.length

    if (channels === current) return channels

    // Easiest correct path: drop connections to this node, recreate, then
    // recreate connections that still fit (channel < new count).
    // Connections within the new channel range survive and are replayed below;
    // those beyond it are dropped (the store removes the matching React Flow
    // edges via getConnectionsBeyondChannel).
    const survivingFrom = this.connections.filter(c => c.source === id && c.sourceChannel < channels)
    const survivingTo = this.connections.filter(c => c.target === id && c.targetChannel < channels)

    // Tear down this node's audio nodes
    for (const c of this.connections.filter(c => c.source === id || c.target === id)) {
      try { c.srcNode.disconnect(c.tgtNode) } catch {}
    }
    this.connections = this.connections.filter(c => c.source !== id && c.target !== id)

    // Stop any always-running sources (chorus LFOs) on the old node before it is
    // replaced, so they don't keep ticking detached. Params are read from the
    // node's stored snapshot, which survives this.
    this.stopInternals(node)

    // Recreate the node with new channel count, preserving its current settings
    switch (type) {
      case 'volume':     this.createVolumeNode(id, channels); break
      case 'eq': {
        // preserve bands by reading from any existing eq ref
        const bands = node.eqRefs?.[0]?.map(f => ({
          frequency: f.frequency.value,
          gain: f.gain.value,
          type: f.type,
          Q: f.Q.value
        })) ?? DEFAULT_EQ_BANDS
        this.createEQNode(id, channels, bands)
        break
      }
      case 'compressor':
        this.createCompressorNode(id, channels)
        if (node.compressorRefs?.[0]) {
          const c = node.compressorRefs[0]
          this.setCompressor(id, {
            threshold: c.threshold.value,
            knee: c.knee.value,
            ratio: c.ratio.value,
            attack: c.attack.value,
            release: c.release.value
          })
        }
        break
      case 'gate': {
        this.createGateNode(id, channels)
        const g = node.gateRefs?.[0]
        if (g) this.setGate(id, { threshold: g.threshold, attack: g.attack, release: g.release })
        break
      }
      // Creative effects rebuild straight from their stored parameter snapshot.
      case 'reverb':     this.createReverbNode(id, channels, node.reverbParams ?? DEFAULT_REVERB); break
      case 'delay':      this.createDelayNode(id, channels, node.delayParams ?? DEFAULT_DELAY); break
      case 'chorus':     this.createChorusNode(id, channels, node.chorusParams ?? DEFAULT_CHORUS); break
      case 'distortion': this.createDistortionNode(id, channels, node.distortionParams ?? DEFAULT_DISTORTION); break
      case 'pan':        this.createPanNode(id, channels, node.panParams ?? DEFAULT_PAN); break
      case 'filter':     this.createFilterNode(id, channels, node.filterParams ?? DEFAULT_FILTER); break
      case 'limiter':    this.createLimiterNode(id, channels, node.limiterParams ?? DEFAULT_LIMITER); break
      case 'expander':   this.createExpanderNode(id, channels, node.expanderParams ?? DEFAULT_EXPANDER); break
      case 'tremolo':    this.createTremoloNode(id, channels, node.tremoloParams ?? DEFAULT_TREMOLO); break
      case 'bitcrusher': this.createBitcrusherNode(id, channels, node.crusherParams ?? DEFAULT_CRUSHER); break
      default:
        return current
    }

    // Replay surviving connections
    for (const c of [...survivingFrom, ...survivingTo]) {
      this.connect(c.source, c.sourceChannel, c.target, c.targetChannel)
    }

    this.notifyNodeSubs()
    return channels
  }

  /** Returns the connections that would be lost if this node's channel count were reduced. */
  getConnectionsBeyondChannel(id: string, channels: number): Array<{ source: string; target: string; sourceChannel: number; targetChannel: number }> {
    return this.connections
      .filter(c =>
        (c.source === id && c.sourceChannel >= channels) ||
        (c.target === id && c.targetChannel >= channels))
      .map(c => ({ source: c.source, target: c.target, sourceChannel: c.sourceChannel, targetChannel: c.targetChannel }))
  }

  // ── Routing ────────────────────────────────────────────────────────────

  connect(sourceId: string, sourceChannel: number, targetId: string, targetChannel: number): boolean {
    const src = this.nodes.get(sourceId)
    const tgt = this.nodes.get(targetId)
    if (!src || !tgt) return false

    const srcNode = src.outputs[sourceChannel]
    const tgtNode = tgt.inputs[targetChannel]
    if (!srcNode || !tgtNode) return false

    // Avoid duplicate connections
    if (this.connections.some(c =>
      c.source === sourceId && c.target === targetId &&
      c.sourceChannel === sourceChannel && c.targetChannel === targetChannel)) {
      return false
    }

    try {
      srcNode.connect(tgtNode)
      this.connections.push({
        source: sourceId, sourceChannel,
        target: targetId, targetChannel,
        srcNode, tgtNode
      })
      return true
    } catch (e) {
      console.warn('Connect failed:', e)
      return false
    }
  }

  disconnect(sourceId: string, sourceChannel: number, targetId: string, targetChannel: number): void {
    const idx = this.connections.findIndex(c =>
      c.source === sourceId && c.target === targetId &&
      c.sourceChannel === sourceChannel && c.targetChannel === targetChannel)
    if (idx < 0) return
    const rec = this.connections[idx]
    try { rec.srcNode.disconnect(rec.tgtNode) }
    catch (e) { console.warn('Disconnect failed:', e) }
    this.connections.splice(idx, 1)
  }

  // ── Per-node parameter updates ─────────────────────────────────────────

  setGain(id: string, linearGain: number, channel?: number): void {
    const node = this.nodes.get(id)
    const refs = node?.gainRefs
    if (!node || !refs) return
    const t = this.context.currentTime
    if (channel === undefined) {
      // Remember the user's gain and apply it through the mute state, so that
      // adjusting the slider while muted doesn't audibly un-mute the node.
      node.userGain = linearGain
      const effective = node.muted ? 0 : linearGain
      for (const g of refs) g.gain.setTargetAtTime(effective, t, 0.01)
    } else if (refs[channel]) {
      refs[channel].gain.setTargetAtTime(linearGain, t, 0.01)
    }
  }

  muteNode(id: string, muted: boolean): void {
    const node = this.nodes.get(id)
    const refs = node?.gainRefs
    if (!node || !refs) return
    // Mute/unmute against the remembered gain so unmuting restores the slider
    // value instead of snapping back to unity.
    node.muted = muted
    const effective = muted ? 0 : (node.userGain ?? 1)
    const t = this.context.currentTime
    for (const g of refs) g.gain.setTargetAtTime(effective, t, 0.01)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Stop always-running internal sources (e.g. chorus LFOs) so they don't keep running detached. */
  private stopInternals(node: ManagedNode): void {
    if (node.chorusRefs) {
      for (const ch of node.chorusRefs) {
        try { ch.lfo.stop() } catch {}
        try { ch.lfo.disconnect() } catch {}
      }
    }
    // Stop tremolo/auto-pan LFO oscillators so they don't keep running detached.
    if (node.tremoloRefs) {
      for (const ch of node.tremoloRefs) {
        try { ch.osc.stop() } catch {}
        try { ch.osc.disconnect(); ch.lfo.disconnect() } catch {}
      }
    }
    // Detach bitcrusher worklet nodes so they stop pulling audio once replaced.
    if (node.crusherRefs) {
      for (const ch of node.crusherRefs) {
        try { ch.proc?.disconnect() } catch { /* */ }
      }
    }
  }

  destroyNode(id: string): void {
    const node = this.nodes.get(id)
    if (!node) return

    this.stopInternals(node)

    // Disconnect all connections involving this node
    const toRemove = this.connections.filter(c => c.source === id || c.target === id)
    for (const c of toRemove) {
      try { c.srcNode.disconnect(c.tgtNode) } catch {}
    }
    this.connections = this.connections.filter(c => c.source !== id && c.target !== id)

    // Stop any media streams
    node.mediaStream?.getTracks().forEach(t => t.stop())
    if (node.appReconnectTimer) window.clearTimeout(node.appReconnectTimer)
    if (node.inputReconnectTimer) window.clearTimeout(node.inputReconnectTimer)

    // Stop an in-progress recording (the captured chunks are discarded).
    if (node.recRecorder && node.recActive) {
      try { node.recRecorder.stop() } catch { /* already stopped */ }
    }
    node.recStreamDest?.stream.getTracks().forEach(t => t.stop())

    // Stop + release a file player's media element.
    if (node.fileEl) {
      node.fileEl.pause()
      node.fileEl.removeAttribute('src')
      node.fileEl.load()
    }

    // Stop and detach an output node's playback element so it doesn't keep
    // pulling from the (now-disconnected) audio graph.
    if (node.outputSink) {
      node.outputSink.pause()
      node.outputSink.srcObject = null
    }

    // Clean up engine-side analyser meter subscriptions
    node.meters.forEach((_, idx) => {
      this.meterSubs.delete(`${id}:${idx}`)
    })

    this.nodes.delete(id)
    this.notifyNodeSubs()
  }

  async getDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    // Need an active stream first for labels to populate (browser permission gate)
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
      tmp.getTracks().forEach(t => t.stop())
    } catch {}
    const devices = await navigator.mediaDevices.enumerateDevices()
    return {
      inputs: devices.filter(d => d.kind === 'audioinput'),
      outputs: devices.filter(d => d.kind === 'audiooutput')
    }
  }

  // ── Subscribe to engine state changes (channel count, app active, …) ──

  subscribeNodeChanges(cb: () => void): () => void {
    this.nodeSubs.add(cb)
    return () => this.nodeSubs.delete(cb)
  }

  private notifyNodeSubs(): void {
    for (const cb of this.nodeSubs) cb()
  }
}

export const audioEngine = new AudioEngine()
