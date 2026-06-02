import { type NodeProps } from '@xyflow/react'
import { Cable } from 'lucide-react'
import { NodeBase, SliderRow, DeviceSelector, MuteButton } from './NodeBase'
import { AudioHandle } from './AudioHandle'
import { StereoVUMeter } from '../VUMeter'
import { useAudioStore, type OutputNodeData } from '@renderer/store/audioStore'
import { audioEngine } from '@renderer/audio/backend'

/** Heuristic: surface likely virtual-cable devices so users can spot them. */
function looksVirtual(label: string): boolean {
  return /vb-?audio|cable|virtual|voicemeeter|vac|blackhole|loopback/i.test(label)
}

export function VirtualOutputNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as unknown as OutputNodeData
  const devices = useAudioStore(s => s.devices)
  const updateNodeData = useAudioStore(s => s.updateNodeData)

  const hasVirtual = devices.outputs.some(dev => looksVirtual(dev.label))

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
    if (deviceId) await audioEngine.setOutputDevice(id, deviceId)
  }

  return (
    <NodeBase id={id} nodeType="virtual" label={d.label} width={248} selected={selected}>
      <AudioHandle type="target" id="in-0" nodeType="virtual" />

      <DeviceSelector
        label="Virtual cable device"
        value={d.deviceId}
        devices={devices.outputs}
        onChange={setDevice}
      />

      <div className="flex gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          <SliderRow
            label="Level"
            value={d.volume}
            min={0}
            max={1.5}
            display={`${(d.volume * 100).toFixed(0)}%`}
            onChange={setVolume}
          />
          <div className="flex items-center justify-between mt-1.5">
            <MuteButton muted={d.muted} onToggle={toggleMute} />
            <span className="text-[9px] truncate max-w-[100px]" style={{ color: 'var(--c-text-dim)' }} title={d.deviceName}>
              {d.deviceName || 'Pick a cable…'}
            </span>
          </div>
        </div>
        <StereoVUMeter nodeId={id} height={52} className="shrink-0" />
      </div>

      <div className="flex items-start gap-1.5 px-2 py-1 rounded"
           style={{ background: 'color-mix(in srgb, var(--node-virtual) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--node-virtual) 35%, transparent)' }}>
        <Cable size={11} className="shrink-0 mt-0.5" style={{ color: 'var(--node-virtual)' }} />
        <span className="text-[9px] leading-snug" style={{ color: 'var(--c-text-dim)' }}>
          {hasVirtual
            ? 'Send this mix to a virtual cable, then pick that cable as the mic in Discord/OBS/etc.'
            : 'No virtual cable detected. Install VB-Audio Virtual Cable, then select it here.'}
        </span>
      </div>
    </NodeBase>
  )
}
