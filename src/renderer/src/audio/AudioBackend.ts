// ────────────────────────────────────────────────────────────────────────────
// AudioBackend
//
// The contract the rest of the renderer talks to. Both the current Web Audio
// engine (`AudioEngine`, the default/fallback) and the forthcoming Rust engine
// (`NativeEngine`, an IPC proxy to the native addon) implement this interface,
// so the store + node UIs are decoupled from which engine is active. Selection
// happens in `backend.ts`.
//
// The surface mirrors `AudioEngine`'s public API 1:1 (minus the internal
// `getNode`, which exposes a Web Audio-specific structure). Keep this in lockstep
// with the engine when adding node types.
// ────────────────────────────────────────────────────────────────────────────

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

export interface AudioBackend {
  // ── Lifecycle ─────────────────────────────────────────────────────────────
  init(): Promise<void>
  getLatencyMs(): number
  /** Set the latency/cushion mode (native only; Web Audio no-ops). */
  setLatencyMode(mode: 'low' | 'balanced' | 'safe'): void
  /** Set the output device backend (native only; Web Audio no-ops). */
  setDeviceMode(mode: 'shared' | 'lowlatency' | 'exclusive'): void

  // ── Meter + state subscriptions (bypass React) ─────────────────────────────
  subscribeMeter(key: string, cb: (db: number) => void): () => void
  subscribeNodeChanges(cb: () => void): () => void
  getCompressorReduction(id: string, channel?: number): number

  // ── Input device ────────────────────────────────────────────────────────
  // `deviceName` is the persisted label, kept so a reconnect can fall back to it
  // when the saved `deviceId` no longer resolves (ids churn across hot-plugs).
  createInputNode(id: string, deviceId?: string, deviceName?: string): Promise<void>
  isInputActive(id: string): boolean
  recoverInputs(): Promise<void>

  // ── Application capture ───────────────────────────────────────────────────
  createApplicationNode(id: string, sourceId: string, sourceName: string): Promise<void>
  /** `takeover` (native, `pid:` sources only): park the app's own output on a
   *  virtual sink while captured so it isn't heard twice. Default true. */
  armApplicationCapture(id: string, sourceId: string, sourceName: string, takeover?: boolean): Promise<void>
  isApplicationActive(id: string): boolean

  // ── Output device ─────────────────────────────────────────────────────────
  createOutputNode(id: string, type?: 'output' | 'virtual'): void
  setOutputDevice(id: string, deviceId: string, deviceName?: string): Promise<void>
  recoverOutputs(): Promise<void>

  // ── Recorder (sink that captures to a file) ────────────────────────────────
  createRecorderNode(id: string): void
  startRecording(id: string): boolean
  stopRecording(id: string): Promise<{ blob: Blob; mimeType: string; extension: string } | null>
  isRecording(id: string): boolean

  // ── File player (source that plays an audio file) ──────────────────────────
  createFilePlayerNode(id: string): void
  loadFilePlayer(id: string, url: string): void
  playFilePlayer(id: string): void
  pauseFilePlayer(id: string): void
  setFilePlayerLoop(id: string, loop: boolean): void
  seekFilePlayer(id: string, seconds: number): void
  getFilePlayerStatus(id: string): { playing: boolean; currentTime: number; duration: number }

  // ── Node creation ─────────────────────────────────────────────────────────
  createVolumeNode(id: string, channels?: number): void
  createEQNode(id: string, channels?: number, bands?: EQBand[]): void
  createCompressorNode(id: string, channels?: number): void
  createGateNode(id: string, channels?: number): void
  createMixerNode(id: string, channels?: number): void
  createReverbNode(id: string, channels?: number, params?: ReverbParams): void
  createDelayNode(id: string, channels?: number, params?: DelayParams): void
  createChorusNode(id: string, channels?: number, params?: ChorusParams): void
  createDistortionNode(id: string, channels?: number, params?: DistortionParams): void
  createPanNode(id: string, channels?: number, params?: PanParams): void
  createFilterNode(id: string, channels?: number, params?: FilterParams): void
  createLimiterNode(id: string, channels?: number, params?: LimiterParams): void
  createExpanderNode(id: string, channels?: number, params?: ExpanderParams): void
  createTremoloNode(id: string, channels?: number, params?: TremoloParams): void
  createBitcrusherNode(id: string, channels?: number, params?: CrusherParams): void

  // ── Per-node parameter updates ──────────────────────────────────────────
  setGain(id: string, linearGain: number, channel?: number): void
  muteNode(id: string, muted: boolean): void
  setEQBand(id: string, bandIndex: number, gain: number): void
  setCompressor(
    id: string,
    params: Partial<{ threshold: number; knee: number; ratio: number; attack: number; release: number }>
  ): void
  setGate(id: string, params: Partial<{ threshold: number; attack: number; release: number }>): void
  setMixerChannel(id: string, channel: number, gain: number): void
  setMixerMaster(id: string, gain: number): void
  setReverb(id: string, params: Partial<ReverbParams>): void
  setDelay(id: string, params: Partial<DelayParams>): void
  setChorus(id: string, params: Partial<ChorusParams>): void
  setDistortion(id: string, params: Partial<DistortionParams>): void
  setPan(id: string, pan: number): void
  setFilter(id: string, params: Partial<FilterParams>): void
  setLimiter(id: string, params: Partial<LimiterParams>): void
  setExpander(id: string, params: Partial<ExpanderParams>): void
  setTremolo(id: string, params: Partial<TremoloParams>): void
  setBitcrusher(id: string, params: Partial<CrusherParams>): void

  // ── Routing + channel reconfiguration ──────────────────────────────────────
  connect(sourceId: string, sourceChannel: number, targetId: string, targetChannel: number): boolean
  disconnect(sourceId: string, sourceChannel: number, targetId: string, targetChannel: number): void
  setChannelCount(id: string, type: AudioNodeType, channels: number): number
  getConnectionsBeyondChannel(
    id: string,
    channels: number
  ): Array<{ source: string; target: string; sourceChannel: number; targetChannel: number }>

  // ── Lifecycle / devices ─────────────────────────────────────────────────
  destroyNode(id: string): void
  getDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>
}
