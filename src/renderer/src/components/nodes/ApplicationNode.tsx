import { useState, useSyncExternalStore } from 'react'
import { type NodeProps } from '@xyflow/react'
import { NodeBase } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { StereoVUMeter } from '../VUMeter'
import { AppPicker } from '../AppPicker'
import { useAudioStore, type ApplicationNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/AudioEngine'
import { AppWindow, RefreshCw, AlertCircle } from 'lucide-react'

function useAppActive(id: string): boolean {
  return useSyncExternalStore(
    cb => audioEngine.subscribeNodeChanges(cb),
    () => audioEngine.isApplicationActive(id),
    () => false
  )
}

export function ApplicationNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as ApplicationNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const [pickerOpen, setPickerOpen] = useState(false)
  const active = useAppActive(id)

  const handlePick = async (sourceId: string, sourceName: string): Promise<void> => {
    updateNodeData(id, { sourceId, sourceName })
    await audioEngine.armApplicationCapture(id, sourceId, sourceName)
  }

  const reconnect = async (): Promise<void> => {
    if (!d.sourceName) return setPickerOpen(true)
    const match = await window.api.findSourceByName(d.sourceName)
    if (match) {
      await audioEngine.armApplicationCapture(id, match.id, d.sourceName)
    }
  }

  return (
    <>
      <NodeBase id={id} nodeType="application" label={d.label} width={240} selected={selected}>
        <div className="flex flex-col gap-2">
          {/* Selected app / picker */}
          <button
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-2 w-full px-2 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 rounded transition-colors nodrag"
          >
            <AppWindow size={14} className="text-blue-400 shrink-0" />
            <span className="text-zinc-200 text-[11px] truncate flex-1 text-left" title={d.sourceName}>
              {d.sourceName || 'Click to pick application…'}
            </span>
          </button>

          {/* Status + meters */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                active ? 'bg-green-500 shadow-sm shadow-green-500/50' :
                d.sourceName ? 'bg-amber-500 animate-pulse' : 'bg-zinc-600'
              }`} />
              <span className="text-[9px] truncate">
                {active ? (
                  <span className="text-green-400">Capturing</span>
                ) : d.sourceName ? (
                  <span className="text-amber-500">Waiting for app…</span>
                ) : (
                  <span className="text-zinc-500">No source</span>
                )}
              </span>
            </div>
            <StereoVUMeter nodeId={id} height={28} />
          </div>

          {d.sourceName && !active && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-900/20 border border-amber-700/30 rounded">
              <AlertCircle size={10} className="text-amber-400 shrink-0" />
              <span className="text-amber-300 text-[9px] flex-1">
                App not running. Connections stay wired; will reconnect automatically.
              </span>
              <button
                onClick={reconnect}
                className="text-amber-400 hover:text-amber-200 p-0.5 rounded nodrag"
                title="Try reconnect now"
              >
                <RefreshCw size={10} />
              </button>
            </div>
          )}
        </div>

        <AudioHandle type="source" id="out-0" nodeType="application" />
      </NodeBase>

      <AppPicker
        open={pickerOpen}
        onPick={handlePick}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}
