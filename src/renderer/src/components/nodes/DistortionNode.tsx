import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type DistortionNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

export function DistortionNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as DistortionNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof DistortionNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<DistortionNodeData>)
    audioEngine.setDistortion(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="distortion"
      label={d.label}
      width={240}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'distortion', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="distortion" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="distortion" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Drive" value={d.drive} min={1} max={50} step={0.5}
                     display={`${d.drive.toFixed(1)}`} onChange={v => update('drive', v)} />
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
        Warm saturation → hard clip
      </div>
    </NodeBase>
  )
}
