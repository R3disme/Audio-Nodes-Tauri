import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { X, ChevronLeft, ChevronRight, Power, Plus, Minimize2, ArrowRight } from 'lucide-react'
import { nodeColor, nodeColorDark } from '@renderer/lib/nodeColors'

interface GuidePanelProps {
  open: boolean
  onClose: () => void
}

const NODE_ICON: Record<string, string> = {
  input: '🎙', fileplayer: '🎵', application: '🪟', volume: '🔈', eq: '🎚',
  compressor: '📉', gate: '🚪', pan: '↔', reverb: '🏛', delay: '🔁', chorus: '🌀',
  distortion: '⚡', mixer: '🎛', output: '🔊', virtual: '🎧', recorder: '⏺'
}

// ── Visual primitives ───────────────────────────────────────────────────────

/** A small mock of a node card, tinted with the real node-type accent. */
function MiniNode({ type, label, sockets = 'both', w = 104 }: {
  type: string; label: string; sockets?: 'in' | 'out' | 'both' | 'none'; w?: number
}): JSX.Element {
  const showIn = sockets === 'in' || sockets === 'both'
  const showOut = sockets === 'out' || sockets === 'both'
  const socketStyle = { background: nodeColor(type), border: `2px solid ${nodeColorDark(type)}`, boxShadow: '0 0 0 2px var(--c-surface)' }
  return (
    <div className="relative shrink-0" style={{ width: w }}>
      <div className="rounded-md overflow-hidden ring-1 ring-black/50 shadow-lg" style={{ background: 'linear-gradient(180deg, var(--c-surface-2), var(--c-surface-3))' }}>
        <div className="px-1.5 py-1 flex items-center gap-1 text-[9px] font-semibold text-white"
             style={{ background: `linear-gradient(180deg, rgba(255,255,255,0.16), rgba(0,0,0,0.22)), ${nodeColor(type)}` }}>
          <span className="leading-none drop-shadow">{NODE_ICON[type] ?? '▪'}</span>
          <span className="truncate drop-shadow-sm">{label}</span>
        </div>
        <div className="px-1.5 py-2 flex flex-col gap-1">
          <div className="h-1 rounded" style={{ background: 'color-mix(in srgb, var(--c-text-dim) 25%, transparent)' }} />
          <div className="h-1 w-2/3 rounded" style={{ background: 'color-mix(in srgb, var(--c-text-dim) 18%, transparent)' }} />
        </div>
      </div>
      {showIn && <span className="absolute left-[-5px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full" style={socketStyle} />}
      {showOut && <span className="absolute right-[-5px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full" style={socketStyle} />}
    </div>
  )
}

/** A short wire between two chained nodes, tinted with the source node's color. */
function Wire({ type, active = false }: { type: string; active?: boolean }): JSX.Element {
  return (
    <svg width="34" height="56" className="shrink-0">
      <path d="M2,28 C16,28 18,28 32,28" fill="none" stroke={nodeColor(type)} strokeWidth={active ? 3 : 2}
            strokeLinecap="round" opacity={active ? 1 : 0.85} />
    </svg>
  )
}

/** A left→right signal chain of mini nodes joined by colored wires. */
function ChainDiagram({ nodes, activeWire }: { nodes: { type: string; label: string }[]; activeWire?: number }): JSX.Element {
  return (
    <div className="flex items-center justify-center">
      {nodes.map((n, i) => (
        <Fragment key={i}>
          {i > 0 && <Wire type={nodes[i - 1].type} active={activeWire === i - 1} />}
          <MiniNode type={n.type} label={n.label} sockets={i === 0 ? 'out' : i === nodes.length - 1 ? 'in' : 'both'} />
        </Fragment>
      ))}
    </div>
  )
}

function Box({ children, accent }: { children: ReactNode; accent?: boolean }): JSX.Element {
  return (
    <div className="px-3 py-2 rounded-md text-[11px] font-medium shrink-0 text-center"
         style={{
           background: accent ? 'color-mix(in srgb, var(--c-accent) 14%, transparent)' : 'var(--c-surface-2)',
           border: `1px solid ${accent ? 'color-mix(in srgb, var(--c-accent) 45%, transparent)' : 'var(--c-border)'}`,
           color: 'var(--c-text)'
         }}>
      {children}
    </div>
  )
}

function CablePill(): JSX.Element {
  return (
    <div className="px-2 py-1 rounded-full text-[9px] font-semibold flex items-center gap-1 shrink-0"
         style={{ background: 'color-mix(in srgb, var(--node-virtual) 22%, transparent)', border: '1px solid color-mix(in srgb, var(--node-virtual) 45%, transparent)', color: 'var(--c-text)' }}>
      🔌 Virtual Cable
    </div>
  )
}

const arrow = <ArrowRight size={14} style={{ color: 'var(--c-text-dim)' }} className="shrink-0" />

// ── Steps ───────────────────────────────────────────────────────────────────

interface Step { title: string; body: ReactNode; visual: ReactNode }

const STEPS: Step[] = [
  {
    title: 'Welcome to Audio Nodes',
    body: 'Route audio from any source, through effects, to any output — visually. Build chains by dropping nodes on the canvas and wiring them together.',
    visual: <ChainDiagram nodes={[{ type: 'input', label: 'Input' }, { type: 'eq', label: 'EQ' }, { type: 'output', label: 'Output' }]} activeWire={0} />
  },
  {
    title: 'Add nodes',
    body: 'Pick a node from the left panel — click to drop it on the canvas, or drag it exactly where you want.',
    visual: (
      <div className="flex items-center gap-3">
        <div className="flex flex-col gap-1.5">
          {['input', 'eq', 'reverb'].map(t => (
            <div key={t} className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px]" style={{ background: 'var(--c-surface-2)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}>
              <span className="w-5 h-5 rounded flex items-center justify-center text-[11px]" style={{ background: nodeColor(t) }}>{NODE_ICON[t]}</span>
              <span className="capitalize">{t}</span>
            </div>
          ))}
        </div>
        {arrow}
        <MiniNode type="eq" label="Equalizer" sockets="both" />
      </div>
    )
  },
  {
    title: 'Connect them',
    body: 'Drag from an output socket (right side) to an input socket (left side). Wires are colored by the source node, so the signal is easy to follow.',
    visual: <ChainDiagram nodes={[{ type: 'input', label: 'Input' }, { type: 'volume', label: 'Volume' }]} activeWire={0} />
  },
  {
    title: 'Shape the sound',
    body: 'Insert effects and creative FX anywhere in the chain. Every effect carries 1–8 independent channels (the −/+ in its header).',
    visual: (
      <div className="flex flex-col items-center gap-3">
        <ChainDiagram nodes={[{ type: 'input', label: 'Input' }, { type: 'compressor', label: 'Comp' }, { type: 'reverb', label: 'Reverb' }, { type: 'output', label: 'Output' }]} />
        <div className="flex flex-wrap gap-1.5 justify-center max-w-[420px]">
          {['volume', 'eq', 'gate', 'pan', 'delay', 'chorus', 'distortion'].map(t => (
            <span key={t} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] capitalize"
                  style={{ background: `color-mix(in srgb, ${nodeColor(t)} 20%, transparent)`, border: `1px solid color-mix(in srgb, ${nodeColor(t)} 42%, transparent)`, color: 'var(--c-text)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: nodeColor(t) }} />{t}
            </span>
          ))}
        </div>
      </div>
    )
  },
  {
    title: 'Workspaces',
    body: 'Organize separate graphs as tabs. Each has its own power toggle, so several can run at once — keep one routing audio while you build another.',
    visual: (
      <div className="flex items-center gap-1.5">
        {[{ n: 'Main', on: true, active: true }, { n: 'Stream Mix', on: true }, { n: 'Podcast', on: false }].map(t => (
          <div key={t.n} className="flex items-center gap-1.5 h-7 px-2 rounded-md" style={{
            background: t.active ? 'var(--c-surface-2)' : 'transparent',
            border: `1px solid ${t.active ? 'var(--c-border)' : 'transparent'}`, opacity: t.on ? 1 : 0.5
          }}>
            <Power size={12} style={{ color: t.on ? 'var(--c-accent)' : 'var(--c-text-dim)' }} />
            <span className="text-[11px]" style={{ color: t.active ? 'var(--c-text)' : 'var(--c-text-dim)', fontWeight: t.active ? 600 : 400 }}>{t.n}</span>
          </div>
        ))}
        <div className="w-6 h-6 flex items-center justify-center rounded" style={{ color: 'var(--c-text-dim)' }}><Plus size={14} /></div>
      </div>
    )
  },
  {
    title: 'Route to & from other apps',
    body: 'Build the Audio Nodes Virtual Cable (or use VB-Cable). A Virtual Output sends your mix to other apps; an Input on the cable’s Recording side pulls their audio in.',
    visual: (
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Box>🎮 Game</Box>{arrow}<CablePill />{arrow}<Box accent>Audio Nodes</Box>
        </div>
        <div className="flex items-center gap-2">
          <Box accent>Audio Nodes</Box>{arrow}<CablePill />{arrow}<Box>🎧 Discord</Box>
        </div>
      </div>
    )
  },
  {
    title: 'Record & play files',
    body: 'Drop a File Player to play a track into your graph, or a Recorder to capture your mix to a file — it also passes the signal through so you can monitor it.',
    visual: (
      <div className="flex items-center gap-6">
        <ChainDiagram nodes={[{ type: 'fileplayer', label: 'File Player' }, { type: 'output', label: 'Output' }]} />
        <ChainDiagram nodes={[{ type: 'mixer', label: 'Mix' }, { type: 'recorder', label: 'Recorder' }]} />
      </div>
    )
  },
  {
    title: 'Runs in the tray',
    body: 'Minimize or close and Audio Nodes keeps routing audio from the system tray, using almost no resources. Save/export your setups, recolor everything, and switch between the fast Native engine and Web Audio in the Theme panel.',
    visual: (
      <div className="flex items-center gap-3">
        <div className="rounded-md overflow-hidden ring-1 ring-black/50 shadow-lg" style={{ width: 130 }}>
          <div className="h-5 flex items-center justify-end px-1.5 gap-1" style={{ background: 'var(--c-surface)' }}>
            <Minimize2 size={9} style={{ color: 'var(--c-text-dim)' }} /><X size={9} style={{ color: 'var(--c-text-dim)' }} />
          </div>
          <div className="h-12" style={{ background: 'var(--c-canvas-bg)' }} />
        </div>
        {arrow}
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md" style={{ background: 'var(--c-surface-2)', border: '1px solid var(--c-border)' }}>
          <span className="w-5 h-5 rounded bg-gradient-to-br from-orange-500 to-purple-600 flex items-center justify-center text-white text-[10px]">▣</span>
          <span className="text-[10px]" style={{ color: 'var(--c-text-dim)' }}>tray</span>
        </div>
      </div>
    )
  }
]

// ── Panel ───────────────────────────────────────────────────────────────────

export function GuidePanel({ open, onClose }: GuidePanelProps): JSX.Element | null {
  const [step, setStep] = useState(0)

  // Reset to the first step each time the guide opens.
  useEffect(() => { if (open) setStep(0) }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') setStep(s => Math.min(STEPS.length - 1, s + 1))
      else if (e.key === 'ArrowLeft') setStep(s => Math.max(0, s - 1))
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const last = step === STEPS.length - 1
  const s = STEPS[step]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[660px] rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <span className="font-semibold text-sm">Guide</span>
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--c-text-dim)' }}>{step + 1} / {STEPS.length}</span>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--c-text-dim)' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Step body */}
        <div className="px-6 pt-6 pb-5 flex flex-col">
          {/* Illustration */}
          <div className="rounded-lg flex items-center justify-center mb-5"
               style={{ height: 188, background: 'color-mix(in srgb, var(--c-canvas-bg) 60%, transparent)', border: '1px solid var(--c-border)' }}>
            {s.visual}
          </div>
          {/* Text (fixed height so the footer doesn't jump) */}
          <div style={{ minHeight: 92 }}>
            <h2 className="text-base font-semibold mb-1.5">{s.title}</h2>
            <p className="text-[13px] leading-relaxed" style={{ color: 'var(--c-text-dim)' }}>{s.body}</p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderTop: '1px solid var(--c-border)' }}>
          <button
            onClick={() => setStep(s => Math.max(0, s - 1))}
            disabled={step === 0}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white/10"
            style={{ color: 'var(--c-text-dim)' }}
          >
            <ChevronLeft size={14} /> Back
          </button>

          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <button key={i} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`}
                      className="w-2 h-2 rounded-full transition-colors"
                      style={{ background: i === step ? 'var(--c-accent)' : 'var(--c-border)' }} />
            ))}
          </div>

          <button
            onClick={() => (last ? onClose() : setStep(s => Math.min(STEPS.length - 1, s + 1)))}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-[12px] font-semibold transition-colors"
            style={{ background: 'var(--c-accent)', color: '#1a1a1a' }}
          >
            {last ? 'Done' : <>Next <ChevronRight size={14} /></>}
          </button>
        </div>
      </div>
    </div>
  )
}
