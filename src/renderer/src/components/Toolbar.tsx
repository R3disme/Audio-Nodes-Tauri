import { Minus, Square, X, RefreshCw, Palette, Cpu } from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'
import { useSettingsStore } from '@renderer/store/settingsStore'

export function Toolbar(): JSX.Element {
  const { refreshDevices, initialized } = useAudioStore()
  const openThemeEditor = useSettingsStore(s => s.setThemeEditorOpen)

  const windowMinimize = (): void => window.api?.windowMinimize()
  const windowMaximize = (): void => window.api?.windowMaximize()
  const windowClose = (): void => window.api?.windowClose()

  return (
    <header
      className="h-10 border-b border-black/60 flex items-center px-3 select-none shrink-0"
      style={{
        WebkitAppRegion: 'drag',
        background: 'linear-gradient(180deg, #232327 0%, #19191b 100%)',
        boxShadow: 'inset 0 -1px 0 rgba(240,160,32,0.18), 0 1px 4px rgba(0,0,0,0.4)'
      } as React.CSSProperties}
    >
      {/* Window drag area + app name */}
      <div className="flex items-center gap-2 flex-1">
        <div className="w-5 h-5 rounded bg-gradient-to-br from-orange-500 to-purple-600 flex items-center justify-center shadow-md shadow-orange-900/40">
          <Cpu size={11} className="text-white" />
        </div>
        <span className="text-zinc-200 text-xs font-semibold tracking-wide">Audio Nodes</span>
      </div>

      {/* Status indicators */}
      <div className="flex items-center gap-3 mr-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${initialized ? 'bg-green-500' : 'bg-zinc-600'}`} />
          <span className="text-zinc-500 text-[10px]">{initialized ? 'Audio Active' : 'Idle'}</span>
        </div>

        <button
          onClick={() => refreshDevices()}
          className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded hover:bg-zinc-800"
          title="Refresh audio devices"
        >
          <RefreshCw size={12} />
        </button>

        <button
          onClick={() => openThemeEditor(true)}
          className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded hover:bg-zinc-800"
          title="Theme & appearance"
        >
          <Palette size={13} />
        </button>
      </div>

      {/* Window controls */}
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={windowMinimize}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <Minus size={12} />
        </button>
        <button
          onClick={windowMaximize}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <Square size={11} />
        </button>
        <button
          onClick={windowClose}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-700 text-zinc-400 hover:text-white transition-colors"
        >
          <X size={12} />
        </button>
      </div>
    </header>
  )
}
