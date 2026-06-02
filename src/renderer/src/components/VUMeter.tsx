import { useEffect, useRef } from 'react'
import { audioEngine } from '@renderer/audio/backend'

interface VUMeterProps {
  nodeId: string
  /** Which meter index on this node (0-indexed). Defaults to 0. */
  meterIndex?: number
  height?: number
  width?: number
  className?: string
}

// dB to 0-1 fraction. Anything below -60dB shows as zero.
function dbToFraction(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

/**
 * VU meter that bypasses React for updates. Subscribes to the audio engine
 * directly and mutates DOM styles on each meter tick. With 7+ nodes × 60fps,
 * round-tripping through Zustand and React reconciliation is wasted work.
 */
export function VUMeter({
  nodeId,
  meterIndex = 0,
  height = 40,
  width = 8,
  className = ''
}: VUMeterProps): JSX.Element {
  const fillRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const lastFraction = useRef(0)

  useEffect(() => {
    const key = `${nodeId}:${meterIndex}`
    return audioEngine.subscribeMeter(key, (db) => {
      const fraction = dbToFraction(db)
      // Skip DOM writes for sub-pixel changes
      if (Math.abs(fraction - lastFraction.current) < 0.005) return
      lastFraction.current = fraction
      const fill = fillRef.current
      if (!fill) return
      // Only the height changes; the color scale is fixed to the track so a given
      // dB level always lights the same hue (proper VU behaviour).
      fill.style.height = `${fraction * 100}%`
      if (labelRef.current) {
        labelRef.current.title = `${db.toFixed(1)} dB`
      }
    })
  }, [nodeId, meterIndex])

  return (
    <div
      ref={labelRef}
      className={`relative rounded-sm overflow-hidden ring-1 ring-black/50 ${className}`}
      style={{
        width,
        height,
        background: '#0c0e0c',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.7)'
      }}
    >
      {/* Fill clips a fixed-height gradient bar anchored to the bottom, so the
          revealed colors are absolute (green → amber → red up the track). */}
      <div ref={fillRef} className="absolute bottom-0 left-0 right-0 overflow-hidden" style={{ height: 0 }}>
        <div
          className="absolute bottom-0 left-0 right-0"
          style={{
            height,
            background:
              'linear-gradient(to top, #15803d 0%, #22c55e 50%, #84cc16 70%, #eab308 82%, #f59e0b 90%, #ef4444 100%)'
          }}
        />
      </div>
      {/* Tick marks at -12, -6 dB (80%, 90%) */}
      <div className="absolute left-0 right-0 border-t border-white/10 pointer-events-none" style={{ bottom: '80%', height: 1 }} />
      <div className="absolute left-0 right-0 border-t border-amber-400/25 pointer-events-none" style={{ bottom: '90%', height: 1 }} />
    </div>
  )
}

interface StereoVUMeterProps {
  nodeId: string
  meterIndex?: number
  height?: number
  className?: string
}

export function StereoVUMeter({
  nodeId,
  meterIndex = 0,
  height = 60,
  className = ''
}: StereoVUMeterProps): JSX.Element {
  return (
    <div className={`flex gap-0.5 items-end ${className}`}>
      <VUMeter nodeId={nodeId} meterIndex={meterIndex} height={height} />
      <VUMeter nodeId={nodeId} meterIndex={meterIndex} height={height} />
    </div>
  )
}
