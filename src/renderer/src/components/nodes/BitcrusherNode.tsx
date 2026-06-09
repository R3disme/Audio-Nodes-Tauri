import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type BitcrusherNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

export function BitcrusherNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as BitcrusherNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof BitcrusherNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<BitcrusherNodeData>)
    audioEngine.setBitcrusher(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="bitcrusher"
      label={d.label}
      width={240}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'bitcrusher', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="bitcrusher" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="bitcrusher" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Bits" value={d.bits} min={1} max={16} step={0.5}
                     display={`${d.bits.toFixed(1)}`} onChange={v => update('bits', v)} />
          <SliderRow label="Rate ÷" value={d.downsample} min={1} max={50} step={1}
                     display={`${d.downsample.toFixed(0)}×`} onChange={v => update('downsample', v)} />
          <SliderRow label="Mix" value={d.mix} min={0} max={1} step={0.01}
                     display={`${(d.mix * 100).toFixed(0)}%`} onChange={v => update('mix', v)} />
        </div>
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-[9px] text-zinc-500">OUT</span>
          <div className="flex gap-0.5">
            {Array.from({ length: channels }, (_, i) => (
              <VUMeter key={i} nodeId={id} meterIndex={i} height={48} />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-1.5 text-[9px] text-zinc-500 text-center">
        Lo-fi bit & sample-rate crush
      </div>
    </NodeBase>
  )
}
