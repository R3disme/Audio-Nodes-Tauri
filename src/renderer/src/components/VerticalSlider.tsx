import { useCallback, useRef } from 'react'

interface VerticalSliderProps {
  value: number
  min: number
  max: number
  step?: number
  height?: number
  width?: number
  color?: string
  onChange: (value: number) => void
  /** Optional: snap to this value with double-click. */
  resetValue?: number
}

/**
 * Custom vertical slider. CSS `appearance: slider-vertical` is deprecated in
 * modern Chromium and renders inconsistently — this implementation uses
 * pointer events to drive the value directly.
 */
export function VerticalSlider({
  value,
  min,
  max,
  step = 0.01,
  height = 80,
  width = 20,
  color = '#f0a020',
  onChange,
  resetValue
}: VerticalSliderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const updateFromEvent = useCallback((clientY: number): void => {
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const y = clientY - rect.top
    const fraction = 1 - Math.max(0, Math.min(1, y / rect.height))
    const raw = min + fraction * (max - min)
    const stepped = Math.round(raw / step) * step
    onChange(Math.max(min, Math.min(max, stepped)))
  }, [min, max, step, onChange])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    trackRef.current?.setPointerCapture(e.pointerId)
    dragging.current = true
    updateFromEvent(e.clientY)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    updateFromEvent(e.clientY)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = false
    trackRef.current?.releasePointerCapture(e.pointerId)
  }

  const onDoubleClick = (): void => {
    if (resetValue !== undefined) onChange(resetValue)
  }

  const fraction = (value - min) / (max - min)
  const fillHeight = `${fraction * 100}%`

  return (
    <div
      ref={trackRef}
      className="relative rounded cursor-pointer nodrag select-none touch-none"
      style={{
        width,
        height,
        background: '#181818',
        boxShadow: 'inset 0 0 0 1px #000, inset 0 1px 2px rgba(0,0,0,0.5)'
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {/* Filled track */}
      <div
        className="absolute bottom-0 left-0 right-0 rounded-b transition-none pointer-events-none"
        style={{ height: fillHeight, background: color, opacity: 0.35 }}
      />
      {/* Center tick (only for ranges that cross zero) */}
      {min < 0 && max > 0 && (
        <div
          className="absolute left-0 right-0 border-t border-zinc-600/60 pointer-events-none"
          style={{ bottom: `${(-min / (max - min)) * 100}%`, height: 1 }}
        />
      )}
      {/* Thumb */}
      <div
        className="absolute pointer-events-none rounded shadow-md"
        style={{
          left: '50%',
          bottom: fillHeight,
          width: width + 6,
          height: 8,
          transform: 'translate(-50%, 50%)',
          background: color,
          boxShadow: `0 0 6px ${color}aa, inset 0 1px 0 rgba(255,255,255,0.3)`
        }}
      />
    </div>
  )
}
