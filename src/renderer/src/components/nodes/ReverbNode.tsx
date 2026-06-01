import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type ReverbNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/AudioEngine'

export function ReverbNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as ReverbNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof ReverbNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<ReverbNodeData>)
    audioEngine.setReverb(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="reverb"
      label={d.label}
      width={250}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'reverb', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="reverb" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="reverb" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Mix" value={d.mix} min={0} max={1} step={0.01}
                     display={`${(d.mix * 100).toFixed(0)}%`} onChange={v => update('mix', v)} />
          <SliderRow label="Decay" value={d.decay} min={0.1} max={8} step={0.1}
                     display={`${d.decay.toFixed(1)} s`} onChange={v => update('decay', v)} />
          <SliderRow label="Pre-delay" value={d.preDelay * 1000} min={0} max={120} step={1}
                     display={`${(d.preDelay * 1000).toFixed(0)} ms`} onChange={v => update('preDelay', v / 1000)} />
        </div>
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-[9px] text-zinc-500">OUT</span>
          <div className="flex gap-0.5">
            {Array.from({ length: channels }, (_, i) => (
              <VUMeter key={i} nodeId={id} meterIndex={i} height={56} />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-1.5 text-[9px] text-zinc-500 text-center">
        Convolution reverb — vocals & space
      </div>
    </NodeBase>
  )
}
