import { create } from 'zustand'
import {
  type Theme,
  type ThemeMode,
  DEFAULT_THEME,
  deriveSimple,
  themeFromImage,
  applyTheme
} from '@renderer/lib/theme'

// ── Persisted UI settings: theme, sidebar state, node scale ─────────────────

const STORAGE_KEY = 'audio-nodes.settings.v1'

interface PersistedSettings {
  theme: Theme
  sidebarCollapsed: boolean
  nodeScale: number
}

function load(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedSettings>
      return {
        theme: { ...DEFAULT_THEME, ...p.theme, nodes: { ...DEFAULT_THEME.nodes, ...p.theme?.nodes } },
        sidebarCollapsed: p.sidebarCollapsed ?? false,
        nodeScale: p.nodeScale ?? 1
      }
    }
  } catch { /* ignore corrupt settings */ }
  return { theme: DEFAULT_THEME, sidebarCollapsed: false, nodeScale: 1 }
}

const applyNodeScale = (n: number): void =>
  document.documentElement.style.setProperty('--ui-scale', String(n))

interface SettingsState {
  theme: Theme
  sidebarCollapsed: boolean
  nodeScale: number
  themeEditorOpen: boolean

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
  setThemeEditorOpen: (v: boolean) => void
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
    const { theme, sidebarCollapsed, nodeScale } = get()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, sidebarCollapsed, nodeScale }))
    } catch { /* storage full / unavailable — non-fatal */ }
  }
  // Persist after the current synchronous update settles.
  const afterChange = (): void => queueMicrotask(persist)

  return {
    theme: initial.theme,
    sidebarCollapsed: initial.sidebarCollapsed,
    nodeScale: initial.nodeScale,
    themeEditorOpen: false,

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

    setThemeEditorOpen: (v) => set({ themeEditorOpen: v })
  }
})
