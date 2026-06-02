import { type NodeProps } from '@xyflow/react'
import { NodeBase, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VerticalSlider } from '../VerticalSlider'
import { useAudioStore, type EQNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

const FREQ_LABELS = ['80', '240', '1k', '3.5k', '10k']

export function EQNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as EQNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const setBand = (index: number, gain: number): void => {
    const bands = d.bands.map((b, i) => (i === index ? { ...b, gain } : b))
    updateNodeData(id, { bands })
    audioEngine.setEQBand(id, index, gain)
  }

  const reset = (): void => {
    const bands = d.bands.map(b => ({ ...b, gain: 0 }))
    updateNodeData(id, { bands })
    bands.forEach((_, i) => audioEngine.setEQBand(id, i, 0))
  }

  return (
    <NodeBase
      id={id}
      nodeType="eq"
      label={d.label}
      width={268}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'eq', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="eq" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="eq" top={handleY(i, channels)} />
      ))}

      {/* EQ band sliders */}
      <div className="flex gap-2 justify-center items-end mb-2">
        {d.bands.map((band, i) => (
          <div key={i} className="flex flex-col items-center gap-1">
            <span className={`font-mono text-[9px] w-8 text-center ${
              Math.abs(band.gain) < 0.1 ? 'text-zinc-500'
              : band.gain > 0 ? 'text-purple-300' : 'text-blue-300'
            }`}>
              {band.gain > 0 ? '+' : ''}{band.gain.toFixed(0)}
            </span>
            <VerticalSlider
              value={band.gain}
              min={-18}
              max={18}
              step={0.5}
              height={90}
              width={16}
              color="#a78bfa"
              resetValue={0}
              onChange={v => setBand(i, v)}
            />
            <span className="text-zinc-500 text-[8px] font-mono">{FREQ_LABELS[i]}</span>
          </div>
        ))}
      </div>

      <div className="flex justify-between items-center">
        <span className="text-zinc-600 text-[9px]">
          {channels > 1 ? `${channels} channels` : 'mono'}
        </span>
        <button
          onClick={reset}
          className="text-[9px] text-zinc-500 hover:text-purple-300 nodrag transition-colors"
        >
          Reset
        </button>
      </div>
    </NodeBase>
  )
}
