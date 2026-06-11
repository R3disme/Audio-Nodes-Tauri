import { useEffect, useRef, useState } from 'react'
import { X, RefreshCw, AppWindow, Monitor, Volume2, Speaker } from 'lucide-react'
import { getActiveEngineKind } from '@renderer/audio/backend'
import { useSettingsStore } from '@renderer/store/settingsStore'

interface AppPickerProps {
  open: boolean
  onPick: (sourceId: string, sourceName: string) => void
  onClose: () => void
}

// On the native engine the picker lists *audio sessions* (the volume-mixer view:
// real app names from the executable, minimized apps included) and capture is
// per-process — only the chosen app is heard. On Web Audio it lists windows and
// capture is system loopback (all audio), Chromium's ceiling.
export function AppPicker({ open, onPick, onClose }: AppPickerProps): JSX.Element | null {
  const native = getActiveEngineKind() === 'native'
  const refreshSeconds = useSettingsStore(s => s.appRefreshSeconds)
  const [sources, setSources] = useState<WindowSource[]>([])
  const [apps, setApps] = useState<AudioAppInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  // Keep the latest refresh in a ref so the auto-refresh interval never restarts
  // mid-cycle (and doesn't show the spinner on quiet background polls).
  const refreshRef = useRef<(spin?: boolean) => Promise<void>>(async () => {})

  const refresh = async (spin = true): Promise<void> => {
    if (spin) setLoading(true)
    try {
      if (native) {
        setApps(await window.api.audio.listAudioApps())
      } else {
        setSources(await window.api.listWindowSources())
      }
    } catch (e) {
      console.error('Failed to list capture sources:', e)
    } finally {
      if (spin) setLoading(false)
    }
  }
  refreshRef.current = refresh

  // Refresh on open, then poll on the configured interval so an app that opens or
  // starts playing appears without a manual refresh.
  useEffect(() => {
    if (!open) return
    void refreshRef.current(true)
    if (refreshSeconds <= 0) return
    const t = window.setInterval(() => void refreshRef.current(false), refreshSeconds * 1000)
    return () => window.clearInterval(t)
  }, [open, refreshSeconds])

  if (!open) return null

  const q = filter.toLowerCase()
  const filteredApps = apps.filter(a =>
    a.name.toLowerCase().includes(q) || a.exe.toLowerCase().includes(q))
  const filteredSources = sources.filter(s => s.name.toLowerCase().includes(q))

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
              {native
                ? 'Pick an app — only its audio is captured. Minimized apps are listed too.'
                : 'Pick a window or screen. The node will auto-reconnect if the app closes and reopens.'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refresh()}
              className="text-zinc-400 hover:text-zinc-200 p-1.5 rounded hover:bg-zinc-700 transition-colors"
              title={refreshSeconds > 0 ? `Refresh (auto every ${refreshSeconds}s)` : 'Refresh'}
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

        {native ? (
          /* ── Native: audio-session list (per-process capture) ── */
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            <button
              onClick={() => { onPick('pid:0:', 'System audio'); onClose() }}
              className="flex items-center gap-2.5 px-3 py-2 bg-zinc-800/60 hover:bg-zinc-700/70 ring-1 ring-zinc-700 hover:ring-orange-500/50 rounded-md transition-all text-left"
            >
              <Speaker size={16} className="text-orange-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-zinc-200 text-[11px] font-medium">System audio</div>
                <div className="text-zinc-500 text-[9px]">Everything except Audio Nodes itself</div>
              </div>
            </button>
            {filteredApps.length === 0 && !loading && (
              <div className="text-center text-zinc-500 text-xs py-10">
                No apps with audio sessions found. Start playback in the app once, then refresh.
              </div>
            )}
            {filteredApps.map(a => (
              <button
                key={a.pid}
                onClick={() => { onPick(`pid:${a.pid}:${a.exe}`, a.name); onClose() }}
                className="flex items-center gap-2.5 px-3 py-2 bg-zinc-800/60 hover:bg-zinc-700/70 ring-1 ring-zinc-700 hover:ring-orange-500/50 rounded-md transition-all text-left"
              >
                {a.active
                  ? <Volume2 size={16} className="text-green-400 shrink-0" />
                  : <AppWindow size={16} className="text-zinc-500 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-200 text-[11px] font-medium truncate">{a.name}</div>
                  <div className="text-zinc-500 text-[9px] truncate">{a.exe}</div>
                </div>
                {a.active && (
                  <span className="text-green-400 text-[9px] font-semibold shrink-0">playing</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          /* ── Web Audio: window grid (system-loopback capture) ── */
          <div className="flex-1 overflow-y-auto p-3 grid grid-cols-3 gap-2">
            {filteredSources.length === 0 && !loading && (
              <div className="col-span-3 text-center text-zinc-500 text-xs py-12">
                No matching windows. Try opening the app first, then refresh.
              </div>
            )}
            {filteredSources.map(s => (
              <button
                key={s.id}
                onClick={() => { onPick(s.id, s.name); onClose() }}
                className="group flex flex-col bg-zinc-800/60 hover:bg-zinc-700/70 ring-1 ring-zinc-700 hover:ring-orange-500/50 rounded-md overflow-hidden transition-all text-left"
              >
                <div className="aspect-video bg-black flex items-center justify-center overflow-hidden">
                  {s.thumbnail ? (
                    <img src={s.thumbnail} alt="" className="max-w-full max-h-full object-contain" />
                  ) : (
                    <div className="text-zinc-700">
                      {s.isScreen ? <Monitor size={32} /> : <AppWindow size={32} />}
                    </div>
                  )}
                </div>
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
        )}

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-zinc-800 text-zinc-500 text-[10px]">
          {native ? (
            <>Per-process capture (WASAPI process loopback) — other apps stay silent. An app
            appears in the list once it has opened an audio session; if it restarts, the node
            re-attaches automatically.</>
          ) : (
            <>Audio is captured via system loopback (all apps mixed). For per-application
            isolation, switch to the Native engine in Settings, or route the app through{' '}
            <span className="text-zinc-400">VB-Audio Virtual Cable</span> and pick it as an
            Input device.</>
          )}
        </div>
      </div>
    </div>
  )
}
