import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type TremoloNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

export function TremoloNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as TremoloNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const update = (key: keyof TremoloNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<TremoloNodeData>)
    audioEngine.setTremolo(id, { [key]: value })
  }

  const Toggle = ({ label, field, options }: { label: string; field: keyof TremoloNodeData; options: string[] }): JSX.Element => (
    <div className="flex items-center gap-1 mb-1.5">
      <span className="text-[9px] w-10 shrink-0" style={{ color: 'var(--c-text-dim)' }}>{label}</span>
      <div className="flex gap-1 flex-1">
        {options.map((o, i) => (
          <button
            key={o}
            onClick={() => update(field, i)}
            className="flex-1 text-[8px] py-0.5 rounded nodrag transition-colors"
            style={{
              background: d[field] === i ? 'var(--node-tremolo)' : 'var(--c-surface-3)',
              color: d[field] === i ? '#fff' : 'var(--c-text-dim)',
              border: '1px solid var(--c-border)'
            }}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <NodeBase
      id={id}
      nodeType="tremolo"
      label={d.label}
      width={240}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'tremolo', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="tremolo" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="tremolo" top={handleY(i, channels)} />
      ))}

      <Toggle label="Mode" field="mode" options={['Tremolo', 'Auto-pan']} />
      <Toggle label="Shape" field="shape" options={['Sine', 'Triangle']} />

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Rate" value={d.rate} min={0.1} max={20} step={0.1}
                     display={`${d.rate.toFixed(1)} Hz`} onChange={v => update('rate', v)} />
          <SliderRow label="Depth" value={d.depth} min={0} max={1} step={0.01}
                     display={`${(d.depth * 100).toFixed(0)}%`} onChange={v => update('depth', v)} />
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
    </NodeBase>
  )
}
