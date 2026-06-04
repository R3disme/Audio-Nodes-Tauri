import { useEffect, useRef, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import { Circle, Square, Play, Pause } from 'lucide-react'
import { NodeBase } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { StereoVUMeter } from '../VUMeter'
import { type RecorderNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

/** mm:ss for an elapsed-seconds value. */
function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function RecorderNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as RecorderNodeData

  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [lastFile, setLastFile] = useState<string | null>(null)
  const [lastUrl, setLastUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const urlRef = useRef<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  // Tidy the timer + the last blob URL on unmount.
  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current)
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  const start = (): void => {
    if (!audioEngine.startRecording(id)) return
    setRecording(true)
    setElapsed(0)
    const t0 = Date.now()
    timer.current = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 250)
  }

  const stop = async (): Promise<void> => {
    if (timer.current) { window.clearInterval(timer.current); timer.current = undefined }
    setRecording(false)
    const res = await audioEngine.stopRecording(id)
    if (!res || res.blob.size === 0) return
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = (d.label || 'recording').replace(/\s+/g, '_')
    const name = `${base}-${ts}.${res.extension}`

    // Keep the blob URL for playback; download a copy too.
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const url = URL.createObjectURL(res.blob)
    urlRef.current = url
    setLastUrl(url)
    setLastFile(name)

    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
  }

  const togglePlay = (): void => {
    const el = audioRef.current
    if (!el || !lastUrl) return
    if (el.paused) { el.currentTime = 0; void el.play().catch(() => {}) }
    else el.pause()
  }

  return (
    <NodeBase id={id} nodeType="recorder" label={d.label} width={248} selected={selected}>
      <AudioHandle type="target" id="in-0" nodeType="recorder" />

      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => (recording ? void stop() : start())}
              title={recording ? 'Stop & save' : 'Start recording'}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded font-semibold text-[11px] nodrag transition-colors ${
                recording
                  ? 'bg-red-700 text-red-50 hover:bg-red-600 shadow-md shadow-red-900/30'
                  : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'
              }`}
            >
              {recording ? <Square size={11} className="fill-current" /> : <Circle size={11} className="fill-red-500 text-red-500" />}
              {recording ? 'Stop & Save' : 'Record'}
            </button>
            {/* Play back the last recording */}
            <button
              onClick={togglePlay}
              disabled={!lastUrl || recording}
              title={playing ? 'Pause' : 'Play last recording'}
              className="w-8 h-[30px] flex items-center justify-center rounded nodrag transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: 'var(--node-recorder)', color: '#fff' }}
            >
              {playing ? <Pause size={12} className="fill-current" /> : <Play size={12} className="fill-current" />}
            </button>
          </div>

          <div className="flex items-center justify-between mt-1.5">
            <span className="flex items-center gap-1 text-[10px] font-mono tabular-nums" style={{ color: recording ? '#fca5a5' : 'var(--c-text-dim)' }}>
              {recording && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
              {fmtTime(elapsed)}
            </span>
            <span className="text-[9px]" style={{ color: 'var(--c-text-dim)' }}>
              {recording ? 'recording…' : playing ? 'playing…' : 'idle'}
            </span>
          </div>
        </div>

        <StereoVUMeter nodeId={id} height={52} className="shrink-0" />
      </div>

      {lastFile && !recording && (
        <div className="mt-1.5 text-[9px] truncate" style={{ color: 'var(--c-text-dim)' }} title={lastFile}>
          Saved {lastFile}
        </div>
      )}

      <audio
        ref={audioRef}
        src={lastUrl ?? undefined}
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      {/* Pass-through output: monitor / route the signal being recorded. */}
      <AudioHandle type="source" id="out-0" nodeType="recorder" />
    </NodeBase>
  )
}
