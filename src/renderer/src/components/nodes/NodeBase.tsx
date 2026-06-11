import { type ReactNode, useEffect } from 'react'
import { X, Plus, Minus } from 'lucide-react'
import { useUpdateNodeInternals } from '@xyflow/react'
import { useAudioStore } from '@renderer/store/audioStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { DEFAULT_NODE_COLORS, darken } from '@renderer/lib/nodeColors'
import { NodeTypeIcon, nodeBadge } from '@renderer/lib/nodeIcons'

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
  id, nodeType, label, children, width = 240, selected = false, channelControl
}: NodeBaseProps): JSX.Element {
  const removeNode = useAudioStore(s => s.removeNode)
  const setNodeColor = useAudioStore(s => s.setNodeColor)
  const colorOverride = useAudioStore(
    s => (s.nodes.find(n => n.id === id)?.data as { color?: string } | undefined)?.color
  )
  const badge = nodeBadge(nodeType)

  // React Flow caches each node's handle geometry. When the channel count (which
  // adds/moves sockets) or the global UI scale changes, the cache goes stale —
  // edges then point at the wrong spot and freshly-added sockets aren't
  // connectable. Re-measure on those changes. (Covers every NodeBase-based node;
  // MixerNode also calls this directly for its own input-count changes.)
  const updateNodeInternals = useUpdateNodeInternals()
  const nodeScale = useSettingsStore(s => s.nodeScale)
  // Per-node recolor is an advanced affordance — only surface the swatch when the
  // user is in advanced theming, so the default header stays clean.
  const showColorControl = useSettingsStore(s => s.theme.mode === 'advanced')
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, channelControl?.channels, nodeScale, updateNodeInternals])

  // Per-node accent: an override (if set) or the themed type color. Exposed as a
  // scoped CSS var so the header and this node's sockets pick it up.
  const accent = colorOverride || `var(--node-${nodeType}, ${DEFAULT_NODE_COLORS[nodeType] ?? '#52525b'})`
  const accentDark = colorOverride ? darken(colorOverride) : `var(--node-${nodeType}-dark, ${darken(DEFAULT_NODE_COLORS[nodeType] ?? '#52525b')})`
  const swatchValue = colorOverride || DEFAULT_NODE_COLORS[nodeType] || '#888888'

  const min = channelControl?.min ?? 1
  const max = channelControl?.max ?? 4

  return (
    <div
      className={`
        an-node-card rounded-lg overflow-hidden shadow-xl select-none transition-shadow
        ${selected ? 'ring-2 ring-[color:var(--c-accent)]' : 'ring-1 ring-black/60'}
      `}
      style={{
        width,
        minHeight: channelControl ? minHeightForChannels(channelControl.channels) : undefined,
        background: 'linear-gradient(180deg, var(--c-surface-2) 0%, var(--c-surface-3) 100%)',
        // Scoped accent — header + this node's sockets read these.
        ['--node-accent' as string]: accent,
        ['--node-accent-dark' as string]: accentDark
      } as React.CSSProperties}
    >
      {/* Header — accent color with a glossy top sheen */}
      <div
        className="flex items-center justify-between px-2 py-1.5 cursor-move"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(0,0,0,0.22)), var(--node-accent)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.35)'
        }}
      >
        <div className="flex items-center gap-1.5 text-white text-xs font-semibold tracking-wide min-w-0">
          <NodeTypeIcon type={nodeType} className="shrink-0 drop-shadow" />
          {badge && <span className="text-[8px] font-bold tracking-wider opacity-80 shrink-0 drop-shadow-sm">{badge}</span>}
          <span className="truncate drop-shadow-sm">{label}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Per-node color (advanced theming only): click to recolor,
              right-click to reset. Hidden by default to keep the header clean. */}
          {showColorControl && (
            <label
              className="relative w-[18px] h-[18px] rounded-full nodrag cursor-pointer ring-1 ring-black/40 hover:ring-white/60 transition-colors shrink-0"
              title="Recolor node (right-click to reset)"
              style={{ background: swatchValue }}
              onContextMenu={e => { e.preventDefault(); setNodeColor(id, null) }}
            >
              <input
                type="color"
                value={swatchValue}
                onChange={e => setNodeColor(id, e.target.value)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </label>
          )}

          {channelControl && (
            <>
              <span className="w-px h-4 bg-black/30" aria-hidden />
              <div className="flex items-center gap-1 nodrag" title="Number of audio channels">
                <button
                  onClick={() => channelControl.onChange(Math.max(min, channelControl.channels - 1))}
                  disabled={channelControl.channels <= min}
                  className="w-5 h-5 flex items-center justify-center rounded bg-black/30 text-white/70 hover:bg-black/50 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <Minus size={11} />
                </button>
                <span className="text-white/90 font-mono text-[11px] w-3.5 text-center tabular-nums">{channelControl.channels}</span>
                <button
                  onClick={() => channelControl.onChange(Math.min(max, channelControl.channels + 1))}
                  disabled={channelControl.channels >= max}
                  className="w-5 h-5 flex items-center justify-center rounded bg-black/30 text-white/70 hover:bg-black/50 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <Plus size={11} />
                </button>
              </div>
            </>
          )}

          <span className="w-px h-4 bg-black/30" aria-hidden />
          <button
            className="w-5 h-5 flex items-center justify-center text-white/60 hover:text-white hover:bg-black/40 rounded transition-colors nodrag"
            onClick={() => removeNode(id)}
            title="Remove node"
          >
            <X size={13} />
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
        // min-w-0 lets the slider actually shrink: a range input's intrinsic
        // min-width would otherwise push the value readout out of the column and
        // under the adjacent VU meters, clipping the trailing "%".
        className="flex-1 min-w-0 h-1 appearance-none bg-zinc-700 rounded cursor-pointer accent-orange-400 nodrag"
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
  /** When false, the empty option is a non-selectable placeholder instead of "Default"
   *  (used by Virtual Output, which must never fall back to the default device). */
  allowDefault?: boolean
  /** Placeholder text for the empty option when `allowDefault` is false. */
  placeholder?: string
  disabled?: boolean
}

export function DeviceSelector({
  label, value, devices, onChange, allowDefault = true, placeholder = 'Select…', disabled = false
}: DeviceSelectorProps): JSX.Element {
  return (
    <div className="mb-2">
      <span className="text-zinc-400 text-[10px] block mb-0.5">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={e => {
          const d = devices.find(d => d.deviceId === e.target.value)
          onChange(e.target.value, d?.label ?? (allowDefault ? 'Default' : ''))
        }}
        className="w-full bg-zinc-800 border border-zinc-700 hover:border-zinc-600 text-zinc-200 text-[10px] rounded px-1.5 py-1 nodrag focus:outline-none focus:border-orange-500/50 disabled:opacity-50"
      >
        <option value="" disabled={!allowDefault}>{allowDefault ? 'Default' : placeholder}</option>
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

// Socket layout: a vertically-centered group with a *fixed pixel pitch*. A single
// socket sits dead-center (so simple chains stay tidy); extra channels fan out
// above/below at a constant spacing. Because the pitch is fixed (not a fraction
// of node height), the same channel on two nodes lines up — wires run parallel
// instead of criss-crossing the way height-fraction positioning did.
export const HANDLE_PITCH = 22 // px between sockets

/** CSS `top` for channel `index` of `total`, centered with fixed pitch. */
export function handleY(index: number, total = 1): string {
  if (total <= 1) return '50%'
  const offset = (index - (total - 1) / 2) * HANDLE_PITCH
  return `calc(50% + ${offset.toFixed(1)}px)`
}

/** Minimum node height needed to fit `channels` centered, evenly-pitched sockets. */
export function minHeightForChannels(channels: number): number {
  return (channels - 1) * HANDLE_PITCH + 84
}
