import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type ChorusNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/AudioEngine'

export function ChorusNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as ChorusNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof ChorusNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<ChorusNodeData>)
    audioEngine.setChorus(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="chorus"
      label={d.label}
      width={250}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'chorus', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="chorus" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="chorus" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Rate" value={d.rate} min={0.1} max={8} step={0.1}
                     display={`${d.rate.toFixed(1)} Hz`} onChange={v => update('rate', v)} />
          <SliderRow label="Depth" value={d.depth * 1000} min={0.5} max={10} step={0.1}
                     display={`${(d.depth * 1000).toFixed(1)} ms`} onChange={v => update('depth', v / 1000)} />
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
        Thickens & doubles vocals
      </div>
    </NodeBase>
  )
}
