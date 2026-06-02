import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type PanNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.02) return 'C'
  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`
}

export function PanNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as PanNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const setPan = (pan: number): void => {
    updateNodeData(id, { pan })
    audioEngine.setPan(id, pan)
  }

  return (
    <NodeBase
      id={id}
      nodeType="pan"
      label={d.label}
      width={220}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'pan', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="pan" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="pan" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3 items-center">
        <div className="flex-1">
          <SliderRow label="Pan" value={d.pan} min={-1} max={1} step={0.01}
                     display={panLabel(d.pan)} onChange={setPan} />
          <div className="flex justify-between text-[8px] text-zinc-600 px-14 mt-0.5">
            <span>L</span><span>C</span><span>R</span>
          </div>
        </div>
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-[9px] text-zinc-500">OUT</span>
          <div className="flex gap-0.5">
            {Array.from({ length: channels }, (_, i) => (
              <VUMeter key={i} nodeId={id} meterIndex={i} height={40} />
            ))}
          </div>
        </div>
      </div>
    </NodeBase>
  )
}
