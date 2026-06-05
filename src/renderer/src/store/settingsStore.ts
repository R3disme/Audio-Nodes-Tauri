import { create } from 'zustand'
import {
  type Theme,
  type ThemeMode,
  DEFAULT_THEME,
  deriveSimple,
  themeFromImage,
  applyTheme
} from '@renderer/lib/theme'
import { audioEngine, type EngineKind } from '@renderer/audio/backend'

export type LatencyMode = 'low' | 'balanced' | 'safe'

// ── Persisted UI settings: theme, sidebar state, node scale, audio engine ───

const STORAGE_KEY = 'audio-nodes.settings.v1'

interface PersistedSettings {
  theme: Theme
  sidebarCollapsed: boolean
  nodeScale: number
  /** Which audio backend to use. Defaults to 'native' (faster); Web Audio is the fallback. */
  engine: EngineKind
  /** Adaptive-cushion latency mode (native engine). Defaults to 'balanced'. */
  latencyMode: LatencyMode
}

function load(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedSettings>
      return {
        theme: { ...DEFAULT_THEME, ...p.theme, nodes: { ...DEFAULT_THEME.nodes, ...p.theme?.nodes } },
        sidebarCollapsed: p.sidebarCollapsed ?? false,
        nodeScale: p.nodeScale ?? 1,
        engine: p.engine === 'webaudio' ? 'webaudio' : 'native',
        latencyMode: p.latencyMode === 'low' || p.latencyMode === 'safe' ? p.latencyMode : 'balanced'
      }
    }
  } catch { /* ignore corrupt settings */ }
  return { theme: DEFAULT_THEME, sidebarCollapsed: false, nodeScale: 1, engine: 'native', latencyMode: 'balanced' }
}

const applyNodeScale = (n: number): void =>
  document.documentElement.style.setProperty('--ui-scale', String(n))

interface SettingsState {
  theme: Theme
  sidebarCollapsed: boolean
  nodeScale: number
  engine: EngineKind
  latencyMode: LatencyMode
  settingsOpen: boolean

  setSimpleAccent: (hex: string) => void
  setAdvancedColor: (token: keyof Theme, hex: string) => void
  setNodeColor: (type: string, hex: string) => void
  applyPicture: (dataUrl: string) => Promise<void>
  setBackgroundEnabled: (on: boolean) => void
  setBackgroundOpacity: (v: number) => void
  setMode: (mode: ThemeMode) => void
  resetTheme: () => void
  importSettings: (s: { theme?: unknown; sidebarCollapsed?: boolean; nodeScale?: number }) => void

  setSidebarCollapsed: (v: boolean) => void
  toggleSidebar: () => void
  setNodeScale: (v: number) => void
  setSettingsOpen: (v: boolean) => void
  /** Switch audio backend. Persists then reloads so the graph rebuilds cleanly. */
  setEngine: (kind: EngineKind) => void
  /** Set the adaptive-cushion latency mode. Applied live to the engine + persisted. */
  setLatencyMode: (mode: LatencyMode) => void
}

const initial = load()
applyTheme(initial.theme)
applyNodeScale(initial.nodeScale)

export const useSettingsStore = create<SettingsState>((set, get) => {
  // Persist on every change and (re)apply the theme.
  const commit = (theme: Theme): void => {
    applyTheme(theme)
    set({ theme })
  }
  const persist = (): void => {
    const { theme, sidebarCollapsed, nodeScale, engine, latencyMode } = get()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, sidebarCollapsed, nodeScale, engine, latencyMode }))
    } catch { /* storage full / unavailable — non-fatal */ }
  }
  // Persist after the current synchronous update settles.
  const afterChange = (): void => queueMicrotask(persist)

  return {
    theme: initial.theme,
    sidebarCollapsed: initial.sidebarCollapsed,
    nodeScale: initial.nodeScale,
    engine: initial.engine,
    latencyMode: initial.latencyMode,
    settingsOpen: false,

    setSimpleAccent: (hex) => {
      commit(deriveSimple(hex, get().theme))
      afterChange()
    },

    setAdvancedColor: (token, hex) => {
      commit({ ...get().theme, mode: 'advanced', [token]: hex } as Theme)
      afterChange()
    },

    setNodeColor: (type, hex) => {
      const t = get().theme
      commit({ ...t, mode: t.mode === 'simple' ? 'advanced' : t.mode, nodes: { ...t.nodes, [type]: hex } })
      afterChange()
    },

    applyPicture: async (dataUrl) => {
      const t = await themeFromImage(dataUrl)
      commit(t)
      afterChange()
    },

    setBackgroundEnabled: (on) => {
      commit({ ...get().theme, backgroundImageEnabled: on })
      afterChange()
    },

    setBackgroundOpacity: (v) => {
      commit({ ...get().theme, backgroundImageOpacity: v })
      afterChange()
    },

    setMode: (mode) => {
      commit({ ...get().theme, mode })
      afterChange()
    },

    resetTheme: () => {
      commit(DEFAULT_THEME)
      afterChange()
    },

    importSettings: (incoming) => {
      const t = incoming.theme as Partial<Theme> | undefined
      const theme: Theme = t
        ? { ...DEFAULT_THEME, ...t, nodes: { ...DEFAULT_THEME.nodes, ...t.nodes } }
        : get().theme
      applyTheme(theme)
      if (typeof incoming.nodeScale === 'number') applyNodeScale(incoming.nodeScale)
      set({
        theme,
        sidebarCollapsed: typeof incoming.sidebarCollapsed === 'boolean' ? incoming.sidebarCollapsed : get().sidebarCollapsed,
        nodeScale: typeof incoming.nodeScale === 'number' ? incoming.nodeScale : get().nodeScale
      })
      afterChange()
    },

    setSidebarCollapsed: (v) => { set({ sidebarCollapsed: v }); afterChange() },
    toggleSidebar: () => { set({ sidebarCollapsed: !get().sidebarCollapsed }); afterChange() },

    setNodeScale: (v) => {
      applyNodeScale(v)
      set({ nodeScale: v })
      afterChange()
    },

    setSettingsOpen: (v) => set({ settingsOpen: v }),

    setEngine: (kind) => {
      if (get().engine === kind) return
      set({ engine: kind })
      persist()
      // The live graph was built in the previous engine; reload so the chosen
      // engine rebuilds it from persisted state instead of running half-migrated.
      window.location.reload()
    },

    setLatencyMode: (mode) => {
      if (get().latencyMode === mode) return
      set({ latencyMode: mode })
      audioEngine.setLatencyMode(mode) // live — no reload needed
      afterChange()
    }
  }
})
