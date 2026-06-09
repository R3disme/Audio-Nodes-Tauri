import { type NodeProps } from '@xyflow/react'
import { NodeBase, SliderRow, DeviceSelector, MuteButton } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { StereoVUMeter } from '../VUMeter'
import { useAudioStore, type OutputNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

export function OutputNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as OutputNodeData
  const devices = useAudioStore(s => s.devices)
  const updateNodeData = useAudioStore(s => s.updateNodeData)

  const setVolume = (volume: number): void => {
    updateNodeData(id, { volume })
    audioEngine.setGain(id, volume)
  }

  const toggleMute = (): void => {
    const muted = !d.muted
    updateNodeData(id, { muted })
    audioEngine.muteNode(id, muted)
  }

  const setDevice = async (deviceId: string, deviceName: string): Promise<void> => {
    updateNodeData(id, { deviceId, deviceName })
    if (deviceId) await audioEngine.setOutputDevice(id, deviceId, deviceName)
  }

  return (
    <NodeBase id={id} nodeType="output" label={d.label} width={248} selected={selected}>
      <AudioHandle type="target" id="in-0" nodeType="output" />

      <DeviceSelector
        label="Output Device"
        value={d.deviceId}
        devices={devices.outputs}
        onChange={setDevice}
      />

      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <SliderRow
            label="Volume"
            value={d.volume}
            min={0}
            max={1.5}
            display={`${(d.volume * 100).toFixed(0)}%`}
            onChange={setVolume}
          />
          <div className="flex items-center justify-between mt-1.5">
            <MuteButton muted={d.muted} onToggle={toggleMute} />
            <span className="text-[9px] truncate max-w-[110px]" style={{ color: 'var(--c-text-dim)' }} title={d.deviceName}>
              {d.deviceName || 'Default device'}
            </span>
          </div>
        </div>
        <StereoVUMeter nodeId={id} height={52} className="shrink-0" />
      </div>
    </NodeBase>
  )
}
