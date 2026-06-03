import { useEffect, useRef, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import { Play, Pause, FolderOpen, Repeat } from 'lucide-react'
import { NodeBase, SliderRow, MuteButton } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { StereoVUMeter } from '../VUMeter'
import { useAudioStore, type FilePlayerNodeData } from '@renderer/store/audioStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { audioEngine } from '@renderer/audio/backend'

function fmt(s: number): string {
  if (!isFinite(s) || s <= 0) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/**
 * File Player — a source node that plays a local audio file into the graph.
 * The picked file is a transient blob URL (not persisted), so after a restart the
 * name is shown but the file must be re-loaded.
 */
export function FilePlayerNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as FilePlayerNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const native = useSettingsStore(s => s.engine === 'native')

  const [status, setStatus] = useState({ playing: false, currentTime: 0, duration: 0 })
  const fileRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<string | null>(null)

  // Poll transport state for the progress bar / play-pause icon.
  useEffect(() => {
    const t = window.setInterval(() => setStatus(audioEngine.getFilePlayerStatus(id)), 150)
    return () => {
      window.clearInterval(t)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [id])

  const onPick = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const url = URL.createObjectURL(f)
    urlRef.current = url
    audioEngine.loadFilePlayer(id, url)
    if (d.loop) audioEngine.setFilePlayerLoop(id, true)
    updateNodeData(id, { fileName: f.name })
  }

  const togglePlay = (): void => {
    if (status.playing) audioEngine.pauseFilePlayer(id)
    else audioEngine.playFilePlayer(id)
  }

  const toggleLoop = (): void => {
    const loop = !d.loop
    updateNodeData(id, { loop })
    audioEngine.setFilePlayerLoop(id, loop)
  }

  const setGain = (gain: number): void => {
    updateNodeData(id, { gain })
    audioEngine.setGain(id, gain)
  }

  const toggleMute = (): void => {
    const muted = !d.muted
    updateNodeData(id, { muted })
    audioEngine.muteNode(id, muted)
  }

  const hasFile = !!d.fileName

  return (
    <NodeBase id={id} nodeType="fileplayer" label={d.label} width={248} selected={selected}>
      {/* File picker */}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={native}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[10px] nodrag transition-colors mb-2 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: 'var(--c-surface-3)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
        title={native ? 'File player requires the Web Audio engine' : d.fileName || 'Choose an audio file'}
      >
        <FolderOpen size={12} className="shrink-0" style={{ color: 'var(--node-fileplayer)' }} />
        <span className="truncate flex-1 text-left">{d.fileName || 'Load audio file…'}</span>
      </button>
      <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={onPick} />
      {native && (
        <div className="text-[9px] mb-1.5" style={{ color: 'var(--c-text-dim)' }}>
          Web Audio only — switch engine in Theme settings to use this.
        </div>
      )}

      {/* Transport */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <button
          onClick={togglePlay}
          disabled={!hasFile || native}
          className="w-7 h-7 flex items-center justify-center rounded nodrag transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'var(--node-fileplayer)', color: '#fff' }}
          title={status.playing ? 'Pause' : 'Play'}
        >
          {status.playing ? <Pause size={13} className="fill-current" /> : <Play size={13} className="fill-current" />}
        </button>
        <button
          onClick={toggleLoop}
          className="w-7 h-7 flex items-center justify-center rounded nodrag transition-colors"
          style={{
            background: d.loop ? 'color-mix(in srgb, var(--node-fileplayer) 40%, transparent)' : 'var(--c-surface-3)',
            color: d.loop ? '#fff' : 'var(--c-text-dim)',
            border: '1px solid var(--c-border)'
          }}
          title={d.loop ? 'Looping' : 'Loop off'}
        >
          <Repeat size={12} />
        </button>
        <span className="text-[9px] font-mono tabular-nums ml-auto" style={{ color: 'var(--c-text-dim)' }}>
          {fmt(status.currentTime)} / {fmt(status.duration)}
        </span>
      </div>

      {/* Seek */}
      <input
        type="range"
        min={0}
        max={status.duration || 0}
        step={0.1}
        value={Math.min(status.currentTime, status.duration || 0)}
        disabled={!status.duration}
        onChange={e => audioEngine.seekFilePlayer(id, parseFloat(e.target.value))}
        className="w-full min-w-0 h-1 appearance-none bg-zinc-700 rounded cursor-pointer accent-orange-400 nodrag mb-2 disabled:opacity-40"
      />

      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <SliderRow
            label="Gain"
            value={d.gain}
            min={0}
            max={2}
            display={`${(d.gain * 100).toFixed(0)}%`}
            onChange={setGain}
          />
          <div className="mt-1.5">
            <MuteButton muted={d.muted} onToggle={toggleMute} />
          </div>
        </div>
        <StereoVUMeter nodeId={id} height={52} className="shrink-0" />
      </div>

      <AudioHandle type="source" id="out-0" nodeType="fileplayer" />
    </NodeBase>
  )
}
