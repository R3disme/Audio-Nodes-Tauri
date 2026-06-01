import { useEffect, useState } from 'react'
import { X, RefreshCw, AppWindow, Monitor } from 'lucide-react'

interface AppPickerProps {
  open: boolean
  onPick: (sourceId: string, sourceName: string) => void
  onClose: () => void
}

export function AppPicker({ open, onPick, onClose }: AppPickerProps): JSX.Element | null {
  const [sources, setSources] = useState<WindowSource[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const s = await window.api.listWindowSources()
      setSources(s)
    } catch (e) {
      console.error('Failed to list window sources:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) refresh()
  }, [open])

  if (!open) return null

  const filtered = sources.filter(s =>
    s.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 bg-zinc-800/50">
          <div>
            <h2 className="text-zinc-100 font-semibold text-sm">Capture Application Audio</h2>
            <p className="text-zinc-500 text-[10px] mt-0.5">
              Pick a window or screen. The node will auto-reconnect if the app closes and reopens.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={refresh}
              className="text-zinc-400 hover:text-zinc-200 p-1.5 rounded hover:bg-zinc-700 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-200 p-1.5 rounded hover:bg-zinc-700 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Filter */}
        <div className="px-4 py-2 border-b border-zinc-800">
          <input
            type="text"
            placeholder="Filter applications…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 hover:border-zinc-600 focus:border-orange-500/50 text-zinc-200 text-xs rounded px-2.5 py-1.5 outline-none transition-colors"
            autoFocus
          />
        </div>

        {/* Source grid */}
        <div className="flex-1 overflow-y-auto p-3 grid grid-cols-3 gap-2">
          {filtered.length === 0 && !loading && (
            <div className="col-span-3 text-center text-zinc-500 text-xs py-12">
              No matching windows. Try opening the app first, then refresh.
            </div>
          )}
          {filtered.map(s => (
            <button
              key={s.id}
              onClick={() => { onPick(s.id, s.name); onClose() }}
              className="group flex flex-col bg-zinc-800/60 hover:bg-zinc-700/70 ring-1 ring-zinc-700 hover:ring-orange-500/50 rounded-md overflow-hidden transition-all text-left"
            >
              {/* Thumbnail */}
              <div className="aspect-video bg-black flex items-center justify-center overflow-hidden">
                {s.thumbnail ? (
                  <img src={s.thumbnail} alt="" className="max-w-full max-h-full object-contain" />
                ) : (
                  <div className="text-zinc-700">
                    {s.isScreen ? <Monitor size={32} /> : <AppWindow size={32} />}
                  </div>
                )}
              </div>
              {/* Label */}
              <div className="p-2 flex items-center gap-1.5">
                {s.appIcon && (
                  <img src={s.appIcon} alt="" className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className="text-zinc-300 text-[10px] truncate flex-1" title={s.name}>
                  {s.name}
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-zinc-800 text-zinc-500 text-[10px]">
          Audio is captured via system loopback. For per-application isolation, route the app through{' '}
          <span className="text-zinc-400">VB-Audio Virtual Cable</span> and pick it as an Input device instead.
        </div>
      </div>
    </div>
  )
}
