import { useEffect, useRef, useState } from 'react'
import {
  Minus, Square, X, RefreshCw, Palette, Cpu,
  LayoutTemplate, Download, Upload, HelpCircle, Gauge
} from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { audioEngine } from '@renderer/audio/backend'
import { GuidePanel } from './GuidePanel'
import { PresetsPanel } from './PresetsPanel'

function IconButton({ onClick, title, children }: {
  onClick: () => void; title: string; children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="text-zinc-400 hover:text-zinc-100 transition-colors p-1 rounded hover:bg-white/10"
    >
      {children}
    </button>
  )
}

export function Toolbar(): JSX.Element {
  const refreshDevices = useAudioStore(s => s.refreshDevices)
  const initialized = useAudioStore(s => s.initialized)
  const exportConfig = useAudioStore(s => s.exportConfig)
  const importConfig = useAudioStore(s => s.importConfig)
  const openThemeEditor = useSettingsStore(s => s.setThemeEditorOpen)

  const [latency, setLatency] = useState(0)
  const [guideOpen, setGuideOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Poll the estimated I/O latency while audio is running.
  useEffect(() => {
    if (!initialized) return
    const update = (): void => setLatency(audioEngine.getLatencyMs())
    update()
    const t = window.setInterval(update, 1500)
    return () => window.clearInterval(t)
  }, [initialized])

  const windowMinimize = (): void => window.api?.windowMinimize()
  const windowMaximize = (): void => window.api?.windowMaximize()
  const windowClose = (): void => window.api?.windowClose()

  const doExport = (): void => {
    const cfg = exportConfig()
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'audio-nodes-config.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        importConfig(JSON.parse(reader.result as string)).catch(console.error)
      } catch {
        window.alert('That file is not a valid Audio Nodes config.')
      }
    }
    reader.readAsText(f)
    e.target.value = ''
  }

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

      {/* Status + actions */}
      <div className="flex items-center gap-2.5 mr-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${initialized ? 'bg-green-500' : 'bg-zinc-600'}`} />
          <span className="text-zinc-500 text-[10px]">{initialized ? 'Audio Active' : 'Idle'}</span>
        </div>

        <div className="flex items-center gap-1 text-zinc-500" title="Estimated input → output latency">
          <Gauge size={11} />
          <span className="text-[10px] font-mono tabular-nums">{initialized ? `${latency} ms` : '—'}</span>
        </div>

        <div className="w-px h-4 bg-zinc-700" />

        <IconButton onClick={() => setPresetsOpen(true)} title="Presets"><LayoutTemplate size={13} /></IconButton>
        <IconButton onClick={doExport} title="Export config to file"><Download size={13} /></IconButton>
        <IconButton onClick={() => fileRef.current?.click()} title="Import config from file"><Upload size={13} /></IconButton>
        <IconButton onClick={() => refreshDevices()} title="Refresh audio devices"><RefreshCw size={12} /></IconButton>
        <IconButton onClick={() => openThemeEditor(true)} title="Theme & appearance"><Palette size={13} /></IconButton>
        <IconButton onClick={() => setGuideOpen(true)} title="Guide"><HelpCircle size={13} /></IconButton>
      </div>

      {/* Window controls */}
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button onClick={windowMinimize} className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors">
          <Minus size={12} />
        </button>
        <button onClick={windowMaximize} className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors">
          <Square size={11} />
        </button>
        <button onClick={windowClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-700 text-zinc-400 hover:text-white transition-colors">
          <X size={12} />
        </button>
      </div>

      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onImportFile} />
      <GuidePanel open={guideOpen} onClose={() => setGuideOpen(false)} />
      <PresetsPanel open={presetsOpen} onClose={() => setPresetsOpen(false)} />
    </header>
  )
}
