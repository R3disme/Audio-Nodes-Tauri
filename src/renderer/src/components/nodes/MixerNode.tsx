import { type NodeProps } from '@xyflow/react'
import { NodeBase, handleY } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { VUMeter } from '../VUMeter'
import { VerticalSlider } from '../VerticalSlider'
import { useAudioStore, type MixerNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/AudioEngine'

function gainToDb(linear: number): string {
  if (linear <= 0) return '−∞'
  const db = 20 * Math.log10(linear)
  return `${db >= 0 ? '+' : ''}${db.toFixed(0)}`
}

export function MixerNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as MixerNodeData
  const updateNodeData = useAudioStore(s => s.updateNodeData)
  const channelCount = d.channelCount ?? 4
  const channelsState = d.channels_state ?? []

  const setChannelGain = (ch: number, gain: number): void => {
    const channels_state = channelsState.map((c, i) => (i === ch ? { ...c, gain } : c))
    updateNodeData(id, { channels_state })
    audioEngine.setMixerChannel(id, ch, gain)
  }

  const toggleMute = (ch: number): void => {
    const channels_state = channelsState.map((c, i) => {
      if (i !== ch) return c
      const muted = !c.muted
      audioEngine.setMixerChannel(id, ch, muted ? 0 : c.gain)
      return { ...c, muted }
    })
    updateNodeData(id, { channels_state })
  }

  const setMaster = (gain: number): void => {
    updateNodeData(id, { masterGain: gain })
    audioEngine.setMixerMaster(id, gain)
  }

  return (
    <NodeBase id={id} nodeType="mixer" label={d.label} width={50 + channelCount * 50 + 60} selected={selected}>
      {/* Input handles distributed vertically */}
      {channelsState.map((_, i) => (
        <AudioHandle key={`in-${i}`} type="target" id={`in-${i}`} nodeType="mixer" top={handleY(i, channelCount)} />
      ))}

      <AudioHandle type="source" id="out-0" nodeType="mixer" />

      <div className="flex gap-2 items-end justify-center">
        {/* Per-channel faders */}
        {channelsState.map((ch, i) => (
          <div key={i} className="flex flex-col items-center gap-1">
            <span className="text-purple-300 font-mono text-[9px] tabular-nums w-9 text-center">
              {gainToDb(ch.muted ? 0 : ch.gain)}
            </span>
            <div className="flex gap-1">
              <VerticalSlider
                value={ch.gain}
                min={0}
                max={1.5}
                step={0.01}
                height={80}
                width={14}
                color={ch.muted ? '#52525b' : '#a78bfa'}
                resetValue={1}
                onChange={v => setChannelGain(i, v)}
              />
            </div>
            <button
              onClick={() => toggleMute(i)}
              className={`text-[8px] w-5 h-4 rounded nodrag font-bold transition-colors ${
                ch.muted ? 'bg-red-700 text-red-100' : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
              }`}
              title={ch.muted ? 'Unmute' : 'Mute'}
            >M</button>
            <span className="text-zinc-500 text-[8px]">{ch.label}</span>
          </div>
        ))}

        {/* Divider */}
        <div className="w-px self-stretch bg-zinc-700 mx-1" />

        {/* Master + output meter */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-amber-300 font-mono text-[9px] tabular-nums w-9 text-center">
            {gainToDb(d.masterGain ?? 1)}
          </span>
          <div className="flex gap-0.5 items-end">
            <VerticalSlider
              value={d.masterGain ?? 1}
              min={0}
              max={1.5}
              step={0.01}
              height={80}
              width={14}
              color="#f59e0b"
              resetValue={1}
              onChange={setMaster}
            />
            <VUMeter nodeId={id} height={80} />
          </div>
          <span className="text-amber-400 text-[8px] font-semibold tracking-wider">MAIN</span>
        </div>
      </div>
    </NodeBase>
  )
}
