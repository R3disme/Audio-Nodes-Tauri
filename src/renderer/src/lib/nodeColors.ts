// ────────────────────────────────────────────────────────────────────────────
// Node accent colors.
//
// Colors are themeable: at runtime the theme store writes `--node-<type>` (and a
// darker `--node-<type>-dark`) onto :root. `nodeColor()` returns a `var(...)`
// reference with the default baked in as a fallback, so headers, sockets and
// edges recolor instantly on a theme change with no React re-render. The raw
// `DEFAULT_NODE_COLORS` hexes are used where a concrete value is required (the
// canvas-rendered minimap, and theme derivation math).
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_NODE_COLORS: Record<string, string> = {
  // Sources
  input:       '#1a5276',
  fileplayer:  '#2f6d7d',
  application: '#1e4f8b',
  // Dynamics / tone
  volume:      '#784212',
  eq:          '#512e8e',
  compressor:  '#117864',
  gate:        '#6e2020',
  pan:         '#4f6d7a',
  filter:      '#3b6ea5',
  limiter:     '#1a7a6b',
  expander:    '#5a5230',
  // Creative effects
  reverb:      '#1b6f8c',
  delay:       '#2f5fa0',
  chorus:      '#8e3b8e',
  distortion:  '#a35a1e',
  tremolo:     '#7d5a2f',
  bitcrusher:  '#8a5a2a',
  // Mixing / sinks
  mixer:       '#76448a',
  output:      '#1d6a3a',
  virtual:     '#2f7d54',
  recorder:    '#b23a48'
}

/** Stable ordering used by the theme editor and simple-theme hue generation. */
export const NODE_TYPE_ORDER = [
  'input', 'fileplayer', 'application', 'volume', 'eq', 'compressor', 'gate', 'expander', 'pan',
  'filter', 'reverb', 'delay', 'chorus', 'distortion', 'tremolo', 'bitcrusher', 'limiter',
  'mixer', 'output', 'virtual', 'recorder'
] as const

const FALLBACK = '#52525b'

/** Themeable accent color for a node type (CSS variable with a hex fallback). */
export function nodeColor(type?: string | null): string {
  if (type && DEFAULT_NODE_COLORS[type]) return `var(--node-${type}, ${DEFAULT_NODE_COLORS[type]})`
  return FALLBACK
}

/** Themeable darker outline color for a node type's sockets. */
export function nodeColorDark(type?: string | null): string {
  if (type && DEFAULT_NODE_COLORS[type]) return `var(--node-${type}-dark, ${darken(DEFAULT_NODE_COLORS[type])})`
  return 'rgba(0,0,0,0.55)'
}

/** Darken a #rrggbb color toward black — used for socket outlines and theme math. */
export function darken(hex: string, factor = 0.5): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 'rgba(0,0,0,0.55)'
  const n = parseInt(m[1], 16)
  const r = Math.round(((n >> 16) & 255) * factor)
  const g = Math.round(((n >> 8) & 255) * factor)
  const b = Math.round((n & 255) * factor)
  return `rgb(${r}, ${g}, ${b})`
}
