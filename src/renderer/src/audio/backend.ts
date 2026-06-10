// ────────────────────────────────────────────────────────────────────────────
// Backend selector
//
// Single place that decides which `AudioBackend` implementation is live:
//   - 'native' (default): the Rust engine via IPC. Faster; the main mode.
//   - 'webaudio':         the in-renderer Web Audio engine. Fully-featured fallback
//                         (recorder/file-player/app-capture still live here).
//
// Everything else in the renderer imports the stable `audioEngine` facade from
// here instead of reaching into a concrete engine. The facade is a Proxy that
// forwards each call to whichever engine is active, so call sites never need to
// know about the switch.
//
// The active engine is resolved once at module load from the persisted setting.
// Changing it at runtime (settingsStore.setEngine) reloads the window so the
// graph is rebuilt cleanly in the chosen engine rather than half-migrated.
// ────────────────────────────────────────────────────────────────────────────

import type { AudioBackend } from './AudioBackend'
import { audioEngine as webAudioEngine } from './AudioEngine'
import { nativeEngine } from './NativeEngine'

export type EngineKind = 'webaudio' | 'native'

const SETTINGS_KEY = 'audio-nodes.settings.v1'

function readInitialKind(): EngineKind {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { engine?: unknown }
      if (parsed?.engine === 'webaudio') return 'webaudio'
    }
  } catch {
    /* corrupt/absent settings — default to native */
  }
  return 'native'
}

let activeKind: EngineKind = readInitialKind()
let active: AudioBackend = activeKind === 'native' ? nativeEngine : webAudioEngine

export function getActiveEngineKind(): EngineKind {
  return activeKind
}

export function setActiveEngine(kind: EngineKind): void {
  activeKind = kind
  active = kind === 'native' ? nativeEngine : webAudioEngine
}

/**
 * Tell the main process which engine is live and whether any renderer-side PCM
 * bridge (app capture / loaded file player / recording) is active. Main only
 * destroys the hidden tray window when the engine is native AND nothing in the
 * renderer is load-bearing for audio. On Web Audio the renderer IS the engine,
 * so it always reports busy.
 */
export function reportBackgroundState(): void {
  const busy = activeKind === 'native' ? nativeEngine.hasActiveBridges() : true
  try {
    window.api.reportBackgroundState({ engine: activeKind, busy })
  } catch {
    /* preload bridge unavailable (tests) — main keeps its safe default */
  }
}

/**
 * If native is selected but the Rust addon isn't built/available, fall back to
 * Web Audio for this session (without changing the persisted setting) so the app
 * never goes silent on a fresh clone. Call once at startup before init.
 */
export async function ensureBackendAvailable(): Promise<void> {
  if (activeKind === 'native') {
    try {
      const info = await window.api.audio.info()
      if (!info) throw new Error('addon unavailable')
    } catch {
      console.warn('[backend] native engine unavailable — using Web Audio this session. Run "npm run build:native" to enable native.')
      setActiveEngine('webaudio')
    }
  }
  // The session's engine is final now: report the background state and keep it
  // fresh as bridges come and go (NativeEngine notifies on every bridge change).
  nativeEngine.subscribeNodeChanges(reportBackgroundState)
  reportBackgroundState()
}

/**
 * Stable facade. Importers use `import { audioEngine } from '@renderer/audio/backend'`
 * and call methods as before; the Proxy routes to the active engine and binds
 * `this` so methods keep their engine context.
 */
export const audioEngine: AudioBackend = new Proxy({} as AudioBackend, {
  get(_target, prop: string | symbol) {
    const value = (active as unknown as Record<string | symbol, unknown>)[prop]
    // The facade is untyped per-call, so a method present on one engine but missing
    // from the other fails *silently* at the call site (`undefined` is not callable
    // only once actually invoked). Surface the mismatch loudly in the console —
    // but still return undefined, since optional-feature probes legitimately read
    // missing members.
    if (value === undefined && typeof prop === 'string' && prop !== 'then') {
      console.error(`[backend] audioEngine.${prop} is missing on the active '${activeKind}' engine — AudioBackend.ts and both implementations must change in lockstep`)
    }
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(active)
      : value
  }
})
