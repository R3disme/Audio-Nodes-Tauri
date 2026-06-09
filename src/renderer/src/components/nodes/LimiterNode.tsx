import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type LimiterNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

export function LimiterNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as LimiterNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof LimiterNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<LimiterNodeData>)
    audioEngine.setLimiter(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="limiter"
      label={d.label}
      width={240}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'limiter', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="limiter" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="limiter" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Ceiling" value={d.threshold} min={-40} max={0} step={0.5}
                     display={`${d.threshold.toFixed(1)} dB`} onChange={v => update('threshold', v)} />
          <SliderRow label="Release" value={d.release} min={0.01} max={1} step={0.01}
                     display={`${(d.release * 1000).toFixed(0)} ms`} onChange={v => update('release', v)} />
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
        Brickwall peak ceiling
      </div>
    </NodeBase>
  )
}
