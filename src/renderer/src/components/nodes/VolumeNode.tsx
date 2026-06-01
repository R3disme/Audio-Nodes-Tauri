import { type NodeProps } from '@xyflow/react'
import { NodeBase, MuteButton, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { VerticalSlider } from '../VerticalSlider'
import { useAudioStore, type VolumeNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/AudioEngine'

function gainToDb(linear: number): string {
  if (linear <= 0) return '−∞ dB'
  const db = 20 * Math.log10(linear)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

export function VolumeNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as VolumeNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const setGain = (gain: number): void => {
    updateNodeData(id, { gain })
    audioEngine.setGain(id, gain)
  }

  const toggleMute = (): void => {
    const muted = !d.muted
    updateNodeData(id, { muted })
    audioEngine.muteNode(id, muted)
  }

  return (
    <NodeBase
      id={id}
      nodeType="volume"
      label={d.label}
      width={170 + (channels - 1) * 30}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'volume', n) }}
    >
      {/* Per-channel handles */}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="volume" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="volume" top={handleY(i, channels)} />
      ))}

      <div className="flex flex-col items-center gap-1.5 py-1">
        <span className="text-orange-300 text-xs font-mono font-bold">
          {gainToDb(d.gain)}
        </span>
        <div className="flex items-end gap-2">
          <VerticalSlider
            value={d.gain}
            min={0}
            max={2}
            step={0.01}
            height={70}
            width={20}
            color="#f0a020"
            resetValue={1}
            onChange={setGain}
          />
          {/* One meter per channel */}
          <div className="flex gap-0.5">
            {Array.from({ length: channels }, (_, i) => (
              <VUMeter key={i} nodeId={id} meterIndex={i} height={70} />
            ))}
          </div>
        </div>
        <MuteButton muted={d.muted} onToggle={toggleMute} size="sm" />
      </div>
    </NodeBase>
  )
}
