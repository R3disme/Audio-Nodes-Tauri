import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type GateNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

export function GateNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as GateNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof GateNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<GateNodeData>)
    audioEngine.setGate(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="gate"
      label={d.label}
      width={240}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'gate', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="gate" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="gate" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-2">
        <div className="flex-1">
          <SliderRow label="Threshold" value={d.threshold} min={-80} max={0} step={1}
                     display={`${d.threshold.toFixed(0)} dB`} onChange={v => update('threshold', v)} />
          <SliderRow label="Attack" value={d.attack * 1000} min={0.1} max={200} step={0.1}
                     display={`${(d.attack * 1000).toFixed(1)} ms`} onChange={v => update('attack', v / 1000)} />
          <SliderRow label="Release" value={d.release * 1000} min={1} max={2000} step={1}
                     display={`${(d.release * 1000).toFixed(0)} ms`} onChange={v => update('release', v / 1000)} />
        </div>
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-[9px] text-zinc-500">OUT</span>
          <VUMeter nodeId={id} height={56} />
        </div>
      </div>

      <div className="mt-1.5 text-[9px] text-zinc-500 text-center">
        Silences signal below threshold
      </div>
    </NodeBase>
  )
}
