import { X, LayoutTemplate, ArrowRight } from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'
import { PRESETS } from '@renderer/lib/presets'

interface PresetsPanelProps {
  open: boolean
  onClose: () => void
}

export function PresetsPanel({ open, onClose }: PresetsPanelProps): JSX.Element | null {
  const loadPreset = useAudioStore(s => s.loadPreset)
  const hasNodes = useAudioStore(s => s.nodes.length > 0)
  if (!open) return null

  const apply = async (build: () => ReturnType<typeof PRESETS[number]['build']>): Promise<void> => {
    if (hasNodes && !window.confirm('Load this preset? It replaces your current graph.')) return
    await loadPreset(build())
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[520px] max-h-[86vh] flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <div className="flex items-center gap-2">
            <LayoutTemplate size={15} style={{ color: 'var(--c-accent)' }} />
            <span className="font-semibold text-sm">Presets</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--c-text-dim)' }}>
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {PRESETS.map(p => (
            <button
              key={p.id}
              onClick={() => apply(p.build)}
              className="group w-full text-left rounded-lg px-3 py-2.5 flex items-center gap-3 transition-colors hover:bg-white/5"
              style={{ border: '1px solid var(--c-border)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-semibold" style={{ color: 'var(--c-text)' }}>{p.name}</div>
                <div className="text-[10px] leading-snug" style={{ color: 'var(--c-text-dim)' }}>{p.description}</div>
              </div>
              <ArrowRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--c-accent)' }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
