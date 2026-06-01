// ────────────────────────────────────────────────────────────────────────────
// Small color toolkit: hex ⇄ rgb ⇄ hsl conversions, plus palette extraction
// from an image. Used by the theming system.
// ────────────────────────────────────────────────────────────────────────────

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number } // h 0–360, s/l 0–100

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 0, g: 0, b: 0 }
  let h = m[1]
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex({ r, g, b }: RGB): string {
  const to = (v: number): string => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { h, s: s * 100, l: l * 100 }
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  h = ((h % 360) + 360) % 360
  s = clamp(s, 0, 100) / 100
  l = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

export const hexToHsl = (hex: string): HSL => rgbToHsl(hexToRgb(hex))
export const hslToHex = (hsl: HSL): string => rgbToHex(hslToRgb(hsl))

/** Perceived vibrancy: saturated mid-lightness colors score highest. */
export function vibrancy(hex: string): number {
  const { s, l } = hexToHsl(hex)
  return (s / 100) * (1 - Math.abs(l - 55) / 55)
}

/**
 * Extract a small representative palette from an image data URL. Downsamples to
 * a tiny canvas, buckets colors into a coarse 4-bit-per-channel histogram, then
 * returns the most frequent, sufficiently-distinct, non-gray colors.
 */
export async function paletteFromImage(dataUrl: string, count = 14): Promise<string[]> {
  const img = await loadImage(dataUrl)
  const size = 72
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []
  ctx.drawImage(img, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)

  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 200) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const e = buckets.get(key)
    if (e) { e.r += r; e.g += g; e.b += b; e.n++ }
    else buckets.set(key, { r, g, b, n: 1 })
  }

  const colors = [...buckets.values()]
    .map(e => ({ hex: rgbToHex({ r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }), n: e.n }))
    .sort((a, b) => b.n - a.n)

  // Prefer frequent colors but drop near-duplicates and very desaturated grays.
  const picked: string[] = []
  const isDistinct = (hex: string): boolean =>
    picked.every(p => colorDistance(p, hex) > 40)

  for (const { hex } of colors) {
    if (picked.length >= count) break
    const { s } = hexToHsl(hex)
    if (s < 8) continue
    if (isDistinct(hex)) picked.push(hex)
  }
  // Top up with grays if the image was very monochrome.
  for (const { hex } of colors) {
    if (picked.length >= count) break
    if (isDistinct(hex)) picked.push(hex)
  }
  return picked
}

function colorDistance(a: string, b: string): number {
  const x = hexToRgb(a), y = hexToRgb(b)
  return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
