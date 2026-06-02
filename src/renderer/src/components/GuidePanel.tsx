import { X, HelpCircle } from 'lucide-react'

interface GuidePanelProps {
  open: boolean
  onClose: () => void
}

const SECTIONS: Array<{ title: string; items: string[] }> = [
  {
    title: 'Building a graph',
    items: [
      'Click a node in the left panel to drop it on the canvas, or drag it where you want.',
      'Drag from an output socket (right side) to an input socket (left side) to connect.',
      'Sockets and wires are colored by node type so you can trace the signal flow.',
      'Select a node or wire and press Delete to remove it.'
    ]
  },
  {
    title: 'Nodes',
    items: [
      'Sources: Input (mic/line-in) and Application (capture a window).',
      'Effects: Volume, EQ, Compressor, Gate, Pan — use +/- in the header for multiple channels.',
      'Creative: Reverb, Delay/Echo, Chorus, Distortion — great for vocals & karaoke.',
      'Outputs: Output (a physical device) and Virtual Output (a virtual cable for other apps).',
      'Click the color dot in a node header to recolor just that node.'
    ]
  },
  {
    title: 'Routing to other apps',
    items: [
      'Real OS-level virtual devices need a driver — install VB-Audio Virtual Cable (free).',
      'Then a Virtual Output node sends your mix to that cable; pick the cable as the mic in Discord/OBS/etc.',
      'For per-app input isolation, route the app through the cable and add it as an Input.'
    ]
  },
  {
    title: 'Saving & sharing',
    items: [
      'Your graph, positions and theme save automatically and reload next launch.',
      'Use Export to save everything to a .json file, and Import to load it back (or share it).',
      'Presets give you ready-made starting points (mic chain, podcast, karaoke, streaming).',
      'Theme: pick one color (Simple), tweak everything (Advanced), or generate from an image (Picture).'
    ]
  }
]

export function GuidePanel({ open, onClose }: GuidePanelProps): JSX.Element | null {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[600px] max-h-[86vh] flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <div className="flex items-center gap-2">
            <HelpCircle size={15} style={{ color: 'var(--c-accent)' }} />
            <span className="font-semibold text-sm">Guide</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--c-text-dim)' }}>
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {SECTIONS.map(s => (
            <div key={s.title}>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--c-accent)' }}>
                {s.title}
              </div>
              <ul className="space-y-1">
                {s.items.map((it, i) => (
                  <li key={i} className="flex gap-2 text-[12px] leading-snug" style={{ color: 'var(--c-text-dim)' }}>
                    <span style={{ color: 'var(--c-accent)' }}>•</span>
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
