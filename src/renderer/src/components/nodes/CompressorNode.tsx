import { useEffect, useRef } from 'react'
import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { useAudioStore, type CompressorNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

export function CompressorNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as CompressorNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const setNodeChannels = useAudioStore(s => s.setNodeChannels)
  const channels = d.channels ?? 1
  const grRef = useRef<HTMLSpanElement>(null)

  // Live gain-reduction readout — bypass React for the per-frame value
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const reduction = audioEngine.getCompressorReduction(id)
      if (grRef.current) {
        grRef.current.textContent = `${reduction.toFixed(1)}`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [id])

  const update = (key: keyof CompressorNodeData, value: number): void => {
    updateNodeData(id, { [key]: value } as Partial<CompressorNodeData>)
    audioEngine.setCompressor(id, { [key]: value })
  }

  return (
    <NodeBase
      id={id}
      nodeType="compressor"
      label={d.label}
      width={272}
      selected={selected}
      channelControl={{ channels, onChange: n => setNodeChannels(id, 'compressor', n) }}
    >
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="compressor" top={handleY(i, channels)} />
      ))}
      {Array.from({ length: channels }, (_, i) => (
        <AudioHandle key={`out-${i}`} type="source" id={`out-${i}`} nodeType="compressor" top={handleY(i, channels)} />
      ))}

      <div className="flex gap-3">
        <div className="flex-1 min-w-0">
          <SliderRow label="Threshold" value={d.threshold} min={-60} max={0} step={0.5}
                     display={`${d.threshold.toFixed(0)} dB`} onChange={v => update('threshold', v)} />
          <SliderRow label="Knee" value={d.knee} min={0} max={40} step={0.5}
                     display={`${d.knee.toFixed(0)} dB`} onChange={v => update('knee', v)} />
          <SliderRow label="Ratio" value={d.ratio} min={1} max={20} step={0.5}
                     display={`${d.ratio.toFixed(1)}:1`} onChange={v => update('ratio', v)} />
          <SliderRow label="Attack" value={d.attack * 1000} min={0} max={200} step={1}
                     display={`${(d.attack * 1000).toFixed(0)} ms`} onChange={v => update('attack', v / 1000)} />
          <SliderRow label="Release" value={d.release * 1000} min={10} max={1000} step={10}
                     display={`${(d.release * 1000).toFixed(0)} ms`} onChange={v => update('release', v / 1000)} />
        </div>

        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-[9px] text-zinc-500">GR</span>
          <VUMeter nodeId={id} height={90} />
          <span ref={grRef} className="text-teal-400 font-mono text-[9px] tabular-nums">0.0</span>
          <span className="text-[8px] text-zinc-600">dB</span>
        </div>
      </div>
    </NodeBase>
  )
}
