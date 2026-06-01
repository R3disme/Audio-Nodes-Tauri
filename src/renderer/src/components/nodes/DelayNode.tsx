import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type DelayNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/AudioEngine'

export function DelayNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as DelayNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof DelayNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<DelayNodeData>)
    audioEngine.setDelay(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="delay"
      label={d.label}
      width={250}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'delay', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="delay" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="delay" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Time" value={d.time * 1000} min={20} max={1000} step={5}
                     display={`${(d.time * 1000).toFixed(0)} ms`} onChange={v => update('time', v / 1000)} />
          <SliderRow label="Feedback" value={d.feedback} min={0} max={0.95} step={0.01}
                     display={`${(d.feedback * 100).toFixed(0)}%`} onChange={v => update('feedback', v)} />
          <SliderRow label="Mix" value={d.mix} min={0} max={1} step={0.01}
                     display={`${(d.mix * 100).toFixed(0)}%`} onChange={v => update('mix', v)} />
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
        Echo with regenerating repeats
      </div>
    </NodeBase>
  )
}
