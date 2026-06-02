import { useRef, type ChangeEvent } from 'react'
import { X, Palette, Sliders, Image as ImageIcon, RotateCcw } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { CORE_TOKENS, type Theme, type ThemeMode } from '@renderer/lib/theme'
import { NODE_TYPE_ORDER } from '@renderer/lib/nodeColors'

const ACCENT_PRESETS = ['#f0a020', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#ef4444', '#14b8a6', '#eab308']

function ColorField({ label, value, onChange }: {
  label: string; value: string; onChange: (hex: string) => void
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--c-text-dim)' }}>
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-7 h-7 shrink-0"
      />
      <span className="truncate flex-1">{label}</span>
      <span className="font-mono text-[10px] opacity-70">{value}</span>
    </label>
  )
}

function TabButton({ active, onClick, icon, children }: {
  active: boolean; onClick: () => void; icon: JSX.Element; children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors"
      style={{
        background: active ? 'var(--c-accent)' : 'transparent',
        color: active ? '#0b0b0d' : 'var(--c-text-dim)'
      }}
    >
      {icon}{children}
    </button>
  )
}

export function ThemePanel(): JSX.Element | null {
  const open = useSettingsStore(s => s.themeEditorOpen)
  const theme = useSettingsStore(s => s.theme)
  const setOpen = useSettingsStore(s => s.setThemeEditorOpen)
  const setSimpleAccent = useSettingsStore(s => s.setSimpleAccent)
  const setAdvancedColor = useSettingsStore(s => s.setAdvancedColor)
  const setNodeColor = useSettingsStore(s => s.setNodeColor)
  const applyPicture = useSettingsStore(s => s.applyPicture)
  const setBackgroundEnabled = useSettingsStore(s => s.setBackgroundEnabled)
  const setBackgroundOpacity = useSettingsStore(s => s.setBackgroundOpacity)
  const setMode = useSettingsStore(s => s.setMode)
  const resetTheme = useSettingsStore(s => s.resetTheme)
  const nodeScale = useSettingsStore(s => s.nodeScale)
  const setNodeScale = useSettingsStore(s => s.setNodeScale)
  const engine = useSettingsStore(s => s.engine)
  const setEngine = useSettingsStore(s => s.setEngine)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  const mode: ThemeMode = theme.mode

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') void applyPicture(reader.result) }
    reader.readAsDataURL(f)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[560px] max-h-[86vh] flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <div className="flex items-center gap-2">
            <Palette size={15} style={{ color: 'var(--c-accent)' }} />
            <span className="font-semibold text-sm">Theme</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={resetTheme} title="Reset to default"
              className="p-1.5 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--c-text-dim)' }}>
              <RotateCcw size={13} />
            </button>
            <button onClick={() => setOpen(false)} className="p-1.5 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--c-text-dim)' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <TabButton active={mode === 'simple'} onClick={() => setMode('simple')} icon={<Palette size={12} />}>Simple</TabButton>
          <TabButton active={mode === 'advanced'} onClick={() => setMode('advanced')} icon={<Sliders size={12} />}>Advanced</TabButton>
          <TabButton active={mode === 'picture'} onClick={() => setMode('picture')} icon={<ImageIcon size={12} />}>Picture</TabButton>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {mode === 'simple' && (
            <div className="space-y-3">
              <p className="text-[11px]" style={{ color: 'var(--c-text-dim)' }}>
                Pick one accent color — the background, panels, text and a distinct node palette are calculated to match.
              </p>
              <ColorField label="Accent color" value={theme.accent} onChange={setSimpleAccent} />
              <div className="flex flex-wrap gap-1.5">
                {ACCENT_PRESETS.map(c => (
                  <button key={c} onClick={() => setSimpleAccent(c)} title={c}
                    className="w-6 h-6 rounded-md ring-1 ring-black/40 hover:scale-110 transition-transform"
                    style={{ background: c }} />
                ))}
              </div>
              <NodePalettePreview />
            </div>
          )}

          {mode === 'advanced' && (
            <div className="space-y-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--c-text-dim)' }}>Interface</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {CORE_TOKENS.map(([token, label]) => (
                    <ColorField key={token} label={label} value={theme[token as keyof Theme] as string}
                      onChange={hex => setAdvancedColor(token as keyof Theme, hex)} />
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--c-text-dim)' }}>Node colors</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {NODE_TYPE_ORDER.map(type => (
                    <ColorField key={type} label={type} value={theme.nodes[type] ?? '#888888'}
                      onChange={hex => setNodeColor(type, hex)} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {mode === 'picture' && (
            <div className="space-y-3">
              <p className="text-[11px]" style={{ color: 'var(--c-text-dim)' }}>
                Generate a color theme from an image. Optionally show the image as the canvas background.
              </p>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
              <button onClick={() => fileRef.current?.click()}
                className="w-full py-2 rounded-md text-[12px] font-medium transition-colors"
                style={{ background: 'var(--c-accent)', color: '#0b0b0d' }}>
                Choose image…
              </button>

              {theme.backgroundImage && (
                <>
                  <div className="rounded-md overflow-hidden ring-1 ring-black/40" style={{ maxHeight: 140 }}>
                    <img src={theme.backgroundImage} alt="theme source" className="w-full object-cover" style={{ maxHeight: 140 }} />
                  </div>
                  <NodePalettePreview />
                  <label className="flex items-center justify-between text-[11px]" style={{ color: 'var(--c-text-dim)' }}>
                    <span>Show image as canvas background</span>
                    <input type="checkbox" checked={theme.backgroundImageEnabled}
                      onChange={e => setBackgroundEnabled(e.target.checked)} />
                  </label>
                  {theme.backgroundImageEnabled && (
                    <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--c-text-dim)' }}>
                      <span className="w-16 shrink-0">Opacity</span>
                      <input type="range" min={0.05} max={0.8} step={0.01} value={theme.backgroundImageOpacity}
                        onChange={e => setBackgroundOpacity(parseFloat(e.target.value))} className="flex-1" />
                      <span className="font-mono w-9 text-right">{Math.round(theme.backgroundImageOpacity * 100)}%</span>
                    </label>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer: audio engine + global node scale */}
        <div className="px-4 py-3 flex items-center gap-3" style={{ borderTop: '1px solid var(--c-border)' }}>
          <span className="text-[11px] shrink-0" style={{ color: 'var(--c-text-dim)' }}>Audio engine</span>
          <div className="flex rounded overflow-hidden ring-1 ring-black/40 text-[10px] font-semibold">
            {(['webaudio', 'native'] as const).map(k => (
              <button
                key={k}
                onClick={() => setEngine(k)}
                className="px-2.5 py-1 transition-colors"
                style={{
                  background: engine === k ? 'var(--c-accent)' : 'var(--c-surface-2)',
                  color: engine === k ? '#1a1a1a' : 'var(--c-text-dim)'
                }}
                title={k === 'native' ? 'Rust engine (beta) — reloads to switch' : 'Web Audio engine (stable) — reloads to switch'}
              >
                {k === 'webaudio' ? 'Web Audio' : 'Native (beta)'}
              </button>
            ))}
          </div>
          <span className="text-[9px] leading-tight" style={{ color: 'var(--c-text-dim)' }}>
            switching reloads
          </span>
        </div>
        <div className="px-4 py-3 flex items-center gap-3" style={{ borderTop: '1px solid var(--c-border)' }}>
          <span className="text-[11px] shrink-0" style={{ color: 'var(--c-text-dim)' }}>Node scale</span>
          <input type="range" min={0.7} max={1.5} step={0.05} value={nodeScale}
            onChange={e => setNodeScale(parseFloat(e.target.value))} className="flex-1" />
          <span className="font-mono text-[10px] w-10 text-right" style={{ color: 'var(--c-text)' }}>{Math.round(nodeScale * 100)}%</span>
        </div>
      </div>
    </div>
  )
}

function NodePalettePreview(): JSX.Element {
  const nodes = useSettingsStore(s => s.theme.nodes)
  return (
    <div className="flex flex-wrap gap-1">
      {NODE_TYPE_ORDER.map(type => (
        <div key={type} title={type} className="w-5 h-5 rounded ring-1 ring-black/40" style={{ background: nodes[type] }} />
      ))}
    </div>
  )
}
