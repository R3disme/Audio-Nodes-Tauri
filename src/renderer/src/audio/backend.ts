// ────────────────────────────────────────────────────────────────────────────
// Backend selector
//
// Single place that decides which `AudioBackend` implementation is live:
//   - 'webaudio' (default): the in-renderer Web Audio engine. Fully featured.
//   - 'native':   the Rust engine via IPC. Incomplete during the migration.
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
      if (parsed?.engine === 'native') return 'native'
    }
  } catch {
    /* corrupt/absent settings — fall back to Web Audio */
  }
  return 'webaudio'
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
 * Stable facade. Importers use `import { audioEngine } from '@renderer/audio/backend'`
 * and call methods as before; the Proxy routes to the active engine and binds
 * `this` so methods keep their engine context.
 */
export const audioEngine: AudioBackend = new Proxy({} as AudioBackend, {
  get(_target, prop: string | symbol) {
    const value = (active as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(active)
      : value
  }
})
