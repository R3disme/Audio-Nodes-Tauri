import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type FilterNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

const TYPES = ['Low-pass', 'High-pass', 'Band-pass', 'Notch']

export function FilterNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as FilterNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1

  const setType = (t: number): void => {
    updateNodeData(id, { filterType: t })
    audioEngine.setFilter(id, { type: t })
  }
  const setCutoff = (v: number): void => {
    updateNodeData(id, { cutoff: v })
    audioEngine.setFilter(id, { cutoff: v })
  }
  const setQ = (v: number): void => {
    updateNodeData(id, { q: v })
    audioEngine.setFilter(id, { q: v })
  }

  return (
    <NodeBase
      id={id}
      nodeType="filter"
      label={d.label}
      width={240}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'filter', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="filter" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="filter" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-1 mb-2">
        {TYPES.map((t, i) => (
          <button
            key={t}
            onClick={() => setType(i)}
            className="flex-1 text-[8px] py-1 rounded nodrag transition-colors"
            style={{
              background: d.filterType === i ? 'var(--node-filter)' : 'var(--c-surface-3)',
              color: d.filterType === i ? '#fff' : 'var(--c-text-dim)',
              border: '1px solid var(--c-border)'
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <SliderRow label="Cutoff" value={d.cutoff} min={20} max={20000} step={10}
                     display={d.cutoff >= 1000 ? `${(d.cutoff / 1000).toFixed(1)}k` : `${d.cutoff.toFixed(0)}`} onChange={setCutoff} />
          <SliderRow label="Q" value={d.q} min={0.1} max={12} step={0.1}
                     display={`${d.q.toFixed(2)}`} onChange={setQ} />
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
