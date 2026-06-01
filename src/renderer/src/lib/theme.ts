// ────────────────────────────────────────────────────────────────────────────
// Theme model + derivation + application.
//
//  • simple   — pick one accent; chrome and a distinct node palette are derived.
//  • advanced — every token (and each node color) is editable directly.
//  • picture  — a palette is extracted from an image, which can also be shown as
//               the canvas background.
//
// applyTheme() writes the tokens onto :root as CSS variables; components consume
// them via var(--…), so switching themes repaints instantly without re-rendering.
// ────────────────────────────────────────────────────────────────────────────

import { DEFAULT_NODE_COLORS, NODE_TYPE_ORDER, darken } from './nodeColors'
import { hexToHsl, hslToHex, clamp, vibrancy, paletteFromImage } from './color'

export type ThemeMode = 'simple' | 'advanced' | 'picture'

export interface Theme {
  mode: ThemeMode
  accent: string
  accent2: string
  appBg: string
  canvasBg: string
  surface: string
  surface2: string
  surface3: string
  border: string
  text: string
  textDim: string
  grid: string
  grid2: string
  nodes: Record<string, string>
  backgroundImage: string | null
  backgroundImageEnabled: boolean
  backgroundImageOpacity: number
}

/** The core (non-node) color tokens, for the advanced editor. */
export const CORE_TOKENS = [
  ['accent', 'Accent'],
  ['accent2', 'Accent (bright)'],
  ['appBg', 'Window'],
  ['canvasBg', 'Canvas'],
  ['surface', 'Panels'],
  ['surface2', 'Node body (top)'],
  ['surface3', 'Node body (bottom)'],
  ['border', 'Borders'],
  ['text', 'Text'],
  ['textDim', 'Text (dim)'],
  ['grid', 'Grid dots'],
  ['grid2', 'Grid lines']
] as const

export const DEFAULT_THEME: Theme = {
  mode: 'simple',
  accent: '#f0a020',
  accent2: '#fcd34d',
  appBg: '#09090b',
  canvasBg: '#1a1a1a',
  surface: '#18181b',
  surface2: '#2b2b2e',
  surface3: '#202022',
  border: '#3f3f46',
  text: '#e4e4e7',
  textDim: '#a1a1aa',
  grid: '#34343a',
  grid2: '#232325',
  nodes: { ...DEFAULT_NODE_COLORS },
  backgroundImage: null,
  backgroundImageEnabled: false,
  backgroundImageOpacity: 0.35
}

/** Build a full theme from a single accent color. */
export function deriveSimple(accent: string, base?: Partial<Theme>): Theme {
  const { h, s } = hexToHsl(accent)
  const cs = (cap: number): number => Math.min(s, cap)

  const nodes: Record<string, string> = {}
  const n = NODE_TYPE_ORDER.length
  NODE_TYPE_ORDER.forEach((type, i) => {
    const hue = (h + (i * 360) / n) % 360
    nodes[type] = hslToHex({ h: hue, s: 48, l: 37 })
  })

  return {
    mode: 'simple',
    accent,
    accent2: hslToHex({ h, s: clamp(s + 6, 0, 90), l: clamp(hexToHsl(accent).l + 14, 0, 82) }),
    appBg: hslToHex({ h, s: cs(16), l: 6 }),
    canvasBg: hslToHex({ h, s: cs(14), l: 9 }),
    surface: hslToHex({ h, s: cs(12), l: 12 }),
    surface2: hslToHex({ h, s: cs(10), l: 17 }),
    surface3: hslToHex({ h, s: cs(10), l: 12 }),
    border: hslToHex({ h, s: cs(12), l: 27 }),
    text: hslToHex({ h, s: 14, l: 93 }),
    textDim: hslToHex({ h, s: 8, l: 62 }),
    grid: hslToHex({ h, s: 8, l: 21 }),
    grid2: hslToHex({ h, s: 8, l: 14 }),
    nodes,
    backgroundImage: base?.backgroundImage ?? null,
    backgroundImageEnabled: base?.backgroundImageEnabled ?? false,
    backgroundImageOpacity: base?.backgroundImageOpacity ?? 0.35
  }
}

/** Build a theme (and node palette) from an image, keeping it as the background. */
export async function themeFromImage(dataUrl: string): Promise<Theme> {
  const palette = await paletteFromImage(dataUrl, NODE_TYPE_ORDER.length)
  const accent = [...palette].sort((a, b) => vibrancy(b) - vibrancy(a))[0] ?? DEFAULT_THEME.accent

  const chrome = deriveSimple(accent)
  const nodes: Record<string, string> = {}
  NODE_TYPE_ORDER.forEach((type, i) => {
    nodes[type] = palette.length ? palette[i % palette.length] : chrome.nodes[type]
  })

  return {
    ...chrome,
    mode: 'picture',
    nodes,
    backgroundImage: dataUrl,
    backgroundImageEnabled: true,
    backgroundImageOpacity: 0.32
  }
}

/** Write a theme onto :root as CSS variables. */
export function applyTheme(t: Theme): void {
  const r = document.documentElement.style
  r.setProperty('--c-accent', t.accent)
  r.setProperty('--c-accent-2', t.accent2)
  r.setProperty('--c-app-bg', t.appBg)
  r.setProperty('--c-canvas-bg', t.canvasBg)
  r.setProperty('--c-surface', t.surface)
  r.setProperty('--c-surface-2', t.surface2)
  r.setProperty('--c-surface-3', t.surface3)
  r.setProperty('--c-border', t.border)
  r.setProperty('--c-text', t.text)
  r.setProperty('--c-text-dim', t.textDim)
  r.setProperty('--c-grid', t.grid)
  r.setProperty('--c-grid-2', t.grid2)
  for (const type of Object.keys(t.nodes)) {
    r.setProperty(`--node-${type}`, t.nodes[type])
    r.setProperty(`--node-${type}-dark`, darken(t.nodes[type]))
  }
}
