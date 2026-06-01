import { type ReactNode } from 'react'
import { X, Plus, Minus } from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'
import { nodeColor } from '@renderer/lib/nodeColors'

const headerIcons: Record<string, string> = {
  input:       '🎙',
  application: '🪟',
  output:      '🔊',
  volume:      '🔈',
  eq:          '🎚',
  compressor:  '📉',
  gate:        '🚪',
  reverb:      '🏛',
  delay:       '🔁',
  chorus:      '🌀',
  distortion:  '⚡',
  pan:         '↔',
  mixer:       '🎛'
}

interface NodeBaseProps {
  id: string
  nodeType: string
  label: string
  children: ReactNode
  width?: number
  selected?: boolean
  /** Show channel count adjuster in the header. Pass current count + setter. */
  channelControl?: {
    channels: number
    min?: number
    max?: number
    onChange: (n: number) => void
  }
}

export function NodeBase({
  id, nodeType, label, children, width = 220, selected = false, channelControl
}: NodeBaseProps): JSX.Element {
  const removeNode = useAudioStore(s => s.removeNode)
  const headerColor = nodeColor(nodeType)
  const icon = headerIcons[nodeType] ?? '▪'

  const min = channelControl?.min ?? 1
  const max = channelControl?.max ?? 4

  return (
    <div
      className={`
        an-node-card rounded-lg overflow-hidden shadow-xl select-none transition-shadow
        ${selected ? 'ring-2 ring-[color:var(--c-accent)]' : 'ring-1 ring-black/60'}
      `}
      style={{ width, background: 'linear-gradient(180deg, var(--c-surface-2) 0%, var(--c-surface-3) 100%)' }}
    >
      {/* Header — accent color with a glossy top sheen */}
      <div
        className="flex items-center justify-between px-2 py-1.5 cursor-move"
        style={{
          background: `linear-gradient(180deg, rgba(255,255,255,0.18), rgba(0,0,0,0.22)), ${headerColor}`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.35)'
        }}
      >
        <div className="flex items-center gap-1.5 text-white text-xs font-semibold tracking-wide min-w-0">
          <span className="text-[12px] leading-none shrink-0 drop-shadow">{icon}</span>
          <span className="truncate drop-shadow-sm">{label}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {channelControl && (
            <div className="flex items-center gap-0.5 nodrag" title="Number of audio channels">
              <button
                onClick={() => channelControl.onChange(Math.max(min, channelControl.channels - 1))}
                disabled={channelControl.channels <= min}
                className="w-4 h-4 flex items-center justify-center rounded bg-black/30 text-white/70 hover:bg-black/50 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Minus size={9} />
              </button>
              <span className="text-white/90 font-mono text-[10px] w-3 text-center">{channelControl.channels}</span>
              <button
                onClick={() => channelControl.onChange(Math.min(max, channelControl.channels + 1))}
                disabled={channelControl.channels >= max}
                className="w-4 h-4 flex items-center justify-center rounded bg-black/30 text-white/70 hover:bg-black/50 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Plus size={9} />
              </button>
            </div>
          )}

          <button
            className="text-white/60 hover:text-white hover:bg-black/30 rounded p-0.5 transition-colors nodrag"
            onClick={() => removeNode(id)}
            title="Remove node"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-2 nodrag">
        {children}
      </div>
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────

interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display?: string
  onChange: (v: number) => void
}

export function SliderRow({ label, value, min, max, step = 0.01, display, onChange }: SliderRowProps): JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="text-zinc-400 text-[10px] w-14 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 appearance-none bg-zinc-700 rounded cursor-pointer accent-orange-400 nodrag"
      />
      <span className="text-zinc-300 text-[10px] w-12 text-right font-mono shrink-0">
        {display ?? value.toFixed(2)}
      </span>
    </div>
  )
}

interface DeviceSelectorProps {
  label: string
  value: string
  devices: MediaDeviceInfo[]
  onChange: (deviceId: string, deviceName: string) => void
}

export function DeviceSelector({ label, value, devices, onChange }: DeviceSelectorProps): JSX.Element {
  return (
    <div className="mb-2">
      <span className="text-zinc-400 text-[10px] block mb-0.5">{label}</span>
      <select
        value={value}
        onChange={e => {
          const d = devices.find(d => d.deviceId === e.target.value)
          onChange(e.target.value, d?.label ?? 'Default')
        }}
        className="w-full bg-zinc-800 border border-zinc-700 hover:border-zinc-600 text-zinc-200 text-[10px] rounded px-1.5 py-1 nodrag focus:outline-none focus:border-orange-500/50"
      >
        <option value="">Default</option>
        {devices.map(d => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || d.deviceId.slice(0, 24)}
          </option>
        ))}
      </select>
    </div>
  )
}

interface MuteButtonProps {
  muted: boolean
  onToggle: () => void
  size?: 'sm' | 'md'
}

export function MuteButton({ muted, onToggle, size = 'md' }: MuteButtonProps): JSX.Element {
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
  return (
    <button
      onClick={onToggle}
      className={`${padding} rounded font-semibold nodrag transition-colors ${
        muted
          ? 'bg-red-700 text-red-50 hover:bg-red-600 shadow-md shadow-red-900/30'
          : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
      }`}
    >
      {muted ? 'MUTED' : 'MUTE'}
    </button>
  )
}

/** Helper: stack handle Y position evenly within a node. */
export function handleY(index: number, total: number): string {
  return `${((index + 0.5) / total) * 100}%`
}
