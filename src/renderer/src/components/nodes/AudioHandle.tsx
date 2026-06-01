import { Handle, Position } from '@xyflow/react'
import { nodeColor, nodeColorDark } from '@renderer/lib/nodeColors'

interface AudioHandleProps {
  /** 'source' renders on the right (outputs), 'target' on the left (inputs). */
  type: 'source' | 'target'
  /** Handle id, e.g. "in-0" / "out-0". */
  id: string
  /** Node type whose accent color this socket should take. */
  nodeType: string
  /** Vertical position within the node (CSS top), defaults to centered. */
  top?: string | number
  position?: Position
}

/**
 * A colored connection socket. The dot is tinted with its node's accent color
 * (Blender-style), with a darker outline of the same hue. Size and hover
 * animation come from the shared `.react-flow__handle` rules in index.css.
 */
export function AudioHandle({ type, id, nodeType, top = '50%', position }: AudioHandleProps): JSX.Element {
  const pos = position ?? (type === 'source' ? Position.Right : Position.Left)
  const color = nodeColor(nodeType)
  return (
    <Handle
      type={type}
      position={pos}
      id={id}
      className="audio-handle"
      style={{
        width: 12,
        height: 12,
        // Radial highlight gives the socket a glossy, dimensional look without a
        // box-shadow (so the CSS hover glow stays free to animate).
        background: `radial-gradient(circle at 50% 30%, rgba(255,255,255,0.5), rgba(255,255,255,0) 55%), ${color}`,
        border: `2px solid ${nodeColorDark(nodeType)}`,
        top
      }}
    />
  )
}
