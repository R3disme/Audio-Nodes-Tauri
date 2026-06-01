import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, DeviceSelector, MuteButton } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { StereoVUMeter } from '../VUMeter'
import { useAudioStore, type InputNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/AudioEngine'

export function InputNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as InputNodeData
  const devices = useAudioStore(s => s.devices)
  const updateNodeData = useAudioStore(s => s.updateNodeData)

  const setGain = (gain: number): void => {
    updateNodeData(id, { gain })
    audioEngine.setGain(id, gain)
  }

  const toggleMute = (): void => {
    const muted = !d.muted
    updateNodeData(id, { muted })
    audioEngine.muteNode(id, muted)
  }

  const setDevice = async (deviceId: string, deviceName: string): Promise<void> => {
    updateNodeData(id, { deviceId, deviceName })
    try {
      await audioEngine.createInputNode(id, deviceId || undefined)
    } catch (e) {
      console.error('Failed to switch input device:', e)
    }
  }

  return (
    <NodeBase id={id} nodeType="input" label={d.label} width={230} selected={selected}>
      <DeviceSelector
        label="Input Device"
        value={d.deviceId}
        devices={devices.inputs}
        onChange={setDevice}
      />

      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <SliderRow
            label="Gain"
            value={d.gain}
            min={0}
            max={2}
            display={`${(d.gain * 100).toFixed(0)}%`}
            onChange={setGain}
          />
        </div>
        <StereoVUMeter nodeId={id} height={32} className="shrink-0" />
      </div>

      <div className="flex items-center justify-between">
        <MuteButton muted={d.muted} onToggle={toggleMute} />
        <span className="text-zinc-500 text-[9px] truncate max-w-[120px]" title={d.deviceName}>
          {d.deviceName || 'Default device'}
        </span>
      </div>

      <AudioHandle type="source" id="out-0" nodeType="input" />
    </NodeBase>
  )
}
