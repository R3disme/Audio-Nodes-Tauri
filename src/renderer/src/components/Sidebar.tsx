import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { nodeColor } from '@renderer/lib/nodeColors'

type Category = 'source' | 'effect' | 'creative' | 'sink' | 'mix'

interface NodeEntry {
  type: string
  label: string
  icon: string
  description: string
  category: Category
}

const NODE_PALETTE: NodeEntry[] = [
  { type: 'input',       label: 'Input',        icon: '🎙', description: 'Microphone, line-in',     category: 'source' },
  { type: 'application', label: 'Application',  icon: '🪟', description: 'Capture window audio',     category: 'source' },
  { type: 'volume',      label: 'Volume',       icon: '🔈', description: 'Gain & mute',              category: 'effect' },
  { type: 'eq',          label: 'Equalizer',    icon: '🎚', description: '5-band parametric EQ',     category: 'effect' },
  { type: 'compressor',  label: 'Compressor',   icon: '📉', description: 'Dynamics control',         category: 'effect' },
  { type: 'gate',        label: 'Gate',         icon: '🚪', description: 'Silence below threshold',  category: 'effect' },
  { type: 'pan',         label: 'Pan',          icon: '↔', description: 'Stereo placement',         category: 'effect' },
  { type: 'reverb',      label: 'Reverb',       icon: '🏛', description: 'Vocal space & ambience',   category: 'creative' },
  { type: 'delay',       label: 'Delay / Echo', icon: '🔁', description: 'Echo with feedback',       category: 'creative' },
  { type: 'chorus',      label: 'Chorus',       icon: '🌀', description: 'Thicken & double vocals',  category: 'creative' },
  { type: 'distortion',  label: 'Distortion',   icon: '⚡', description: 'Saturation & drive',       category: 'creative' },
  { type: 'mixer',       label: 'Mixer',        icon: '🎛', description: '4-channel sum',            category: 'mix' },
  { type: 'output',      label: 'Output',       icon: '🔊', description: 'Speakers / headphones',    category: 'sink' },
  { type: 'virtual',     label: 'Virtual Out',  icon: '🎧', description: 'Route to other apps',      category: 'sink' }
]

const CATEGORY_LABELS: Record<Category, string> = {
  source:   'Sources',
  effect:   'Effects',
  creative: 'Creative / FX',
  mix:      'Mixing',
  sink:     'Outputs'
}

const ORDER = ['source', 'effect', 'creative', 'mix', 'sink'] as const

export function Sidebar(): JSX.Element {
  const addNode = useAudioStore(s => s.addNode)
  const collapsed = useSettingsStore(s => s.sidebarCollapsed)
  const toggle = useSettingsStore(s => s.toggleSidebar)

  const onDragStart = (e: React.DragEvent, type: string): void => {
    e.dataTransfer.setData('nodeType', type)
    e.dataTransfer.effectAllowed = 'move'
  }

  const grouped = ORDER.map(cat => ({ cat, items: NODE_PALETTE.filter(n => n.category === cat) }))

  // ── Collapsed rail: just the colored icons ───────────────────────────────
  if (collapsed) {
    return (
      <aside
        className="w-12 flex flex-col items-center py-2 gap-1 overflow-y-auto shrink-0"
        style={{ background: 'var(--c-surface)', borderRight: '1px solid var(--c-border)' }}
      >
        <button
          onClick={toggle}
          title="Expand panel"
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors mb-1"
          style={{ color: 'var(--c-text-dim)' }}
        >
          <PanelLeftOpen size={15} />
        </button>
        {NODE_PALETTE.map(entry => (
          <button
            key={entry.type}
            draggable
            onDragStart={e => onDragStart(e, entry.type)}
            onClick={() => addNode(entry.type)}
            title={`${entry.label} — ${entry.description}`}
            className="w-8 h-8 rounded flex items-center justify-center text-sm shrink-0 ring-1 ring-black/30 hover:ring-white/20 hover:scale-105 transition-all"
            style={{ background: nodeColor(entry.type) }}
          >
            {entry.icon}
          </button>
        ))}
      </aside>
    )
  }

  // ── Expanded panel ───────────────────────────────────────────────────────
  return (
    <aside
      className="w-52 flex flex-col overflow-y-auto shrink-0"
      style={{ background: 'var(--c-surface)', borderRight: '1px solid var(--c-border)' }}
    >
      <div className="px-3 py-2.5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--c-text-dim)' }}>
            Add Node
          </h2>
          <p className="text-[9px] mt-0.5 leading-snug" style={{ color: 'var(--c-text-dim)', opacity: 0.7 }}>
            Click or drag onto canvas
          </p>
        </div>
        <button
          onClick={toggle}
          title="Collapse panel"
          className="p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: 'var(--c-text-dim)' }}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      {grouped.map(({ cat, items }) => (
        <div key={cat} className="py-1.5">
          <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--c-text-dim)', opacity: 0.7 }}>
            {CATEGORY_LABELS[cat]}
          </div>
          <div className="px-1.5 flex flex-col gap-0.5">
            {items.map(entry => (
              <div
                key={entry.type}
                draggable
                onDragStart={e => onDragStart(e, entry.type)}
                onClick={() => addNode(entry.type)}
                className="flex items-center gap-2 px-1.5 py-1.5 rounded cursor-pointer hover:bg-white/5 active:bg-white/10 transition-colors select-none group"
              >
                <div
                  className="w-7 h-7 rounded flex items-center justify-center text-sm shrink-0 ring-1 ring-black/30 group-hover:ring-white/10 transition-all"
                  style={{ background: nodeColor(entry.type) }}
                >
                  {entry.icon}
                </div>
                <div className="overflow-hidden min-w-0">
                  <div className="text-[11px] font-medium leading-tight" style={{ color: 'var(--c-text)' }}>{entry.label}</div>
                  <div className="text-[9px] leading-tight truncate" style={{ color: 'var(--c-text-dim)' }}>{entry.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="mt-auto p-3" style={{ borderTop: '1px solid var(--c-border)' }}>
        <p className="text-[9px] leading-relaxed" style={{ color: 'var(--c-text-dim)', opacity: 0.8 }}>
          For per-app isolation, route the app through a virtual audio cable (e.g. VB-Cable) and pick it as an Input device.
        </p>
      </div>
    </aside>
  )
}
