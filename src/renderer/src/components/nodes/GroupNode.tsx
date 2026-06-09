import { type NodeProps } from '@xyflow/react'
import { ChevronDown, ChevronRight, Ungroup } from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'

interface GroupData {
  label?: string
  collapsed?: boolean
}

/**
 * Sub-graph container. A movable, collapsible box that *organizes* nodes — its members
 * carry `parentId`, so dragging the group moves them and they clip to its bounds. The
 * audio engine never sees this node (buildEngine skips `subgraph`), so connections are
 * unaffected. Collapsing hides the members and the edges touching them.
 */
export function GroupNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as GroupData
  const collapsed = !!d.collapsed
  const toggleCollapsed = useAudioStore(s => s.toggleGroupCollapsed)
  const ungroup = useAudioStore(s => s.ungroup)
  const updateNodeData = useAudioStore(s => s.updateNodeData)

  return (
    <div
      className="w-full h-full rounded-lg flex flex-col overflow-hidden"
      style={{
        background: collapsed
          ? 'var(--c-surface-2)'
          : 'color-mix(in srgb, var(--c-accent) 7%, transparent)',
        border: `1px solid ${selected ? 'var(--c-accent)' : 'var(--c-border)'}`,
        minWidth: 160
      }}
    >
      {/* Header (draggable to move the whole group; controls are nodrag) */}
      <div
        className="flex items-center gap-1 px-1.5 py-1.5"
        style={{
          background: 'var(--c-surface-2)',
          borderBottom: collapsed ? 'none' : '1px solid var(--c-border)'
        }}
      >
        <button
          onClick={() => toggleCollapsed(id)}
          className="nodrag w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors shrink-0"
          style={{ color: 'var(--c-text-dim)' }}
          title={collapsed ? 'Expand group' : 'Collapse group'}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <input
          value={d.label ?? 'Group'}
          onChange={e => updateNodeData(id, { label: e.target.value })}
          className="nodrag bg-transparent text-[11px] font-semibold outline-none flex-1 min-w-0"
          style={{ color: 'var(--c-text)' }}
          spellCheck={false}
        />
        <button
          onClick={() => ungroup(id)}
          className="nodrag w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors shrink-0"
          style={{ color: 'var(--c-text-dim)' }}
          title="Ungroup"
        >
          <Ungroup size={12} />
        </button>
      </div>

      {collapsed && (
        <div className="px-2 py-1 text-[9px]" style={{ color: 'var(--c-text-dim)' }}>
          collapsed — expand to edit
        </div>
      )}
    </div>
  )
}
