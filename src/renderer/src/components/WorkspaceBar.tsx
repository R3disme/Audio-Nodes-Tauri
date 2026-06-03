import { useEffect, useRef, useState } from 'react'
import { Plus, X, Power, ToggleLeft, ToggleRight } from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'

// ────────────────────────────────────────────────────────────────────────────
// WorkspaceBar — the row of "tables" above the canvas.
//
// Each workspace is an independent node graph. The active one is shown on the
// canvas (click a tab to switch). Its power toggle enables/disables that
// workspace's audio independently of which one is being viewed, so several can
// run at once. Double-click a tab name to rename it.
// ────────────────────────────────────────────────────────────────────────────

export function WorkspaceBar(): JSX.Element | null {
  const workspaces = useAudioStore(s => s.workspaces)
  const activeId = useAudioStore(s => s.activeWorkspaceId)
  const initialized = useAudioStore(s => s.initialized)
  const setActive = useAudioStore(s => s.setActiveWorkspace)
  const addWorkspace = useAudioStore(s => s.addWorkspace)
  const removeWorkspace = useAudioStore(s => s.removeWorkspace)
  const renameWorkspace = useAudioStore(s => s.renameWorkspace)
  const setEnabled = useAudioStore(s => s.setWorkspaceEnabled)
  const setAllEnabled = useAudioStore(s => s.setAllWorkspacesEnabled)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  if (!initialized || workspaces.length === 0) return null

  const beginRename = (id: string, name: string): void => {
    setEditingId(id)
    setEditValue(name)
  }
  const commitRename = (): void => {
    if (editingId) {
      const name = editValue.trim()
      if (name) renameWorkspace(editingId, name)
    }
    setEditingId(null)
  }

  const enabledCount = workspaces.filter(w => w.enabled).length
  const allEnabled = enabledCount === workspaces.length
  const noneEnabled = enabledCount === 0

  return (
    <div
      className="h-9 flex items-center gap-1 px-2 shrink-0 overflow-x-auto"
      style={{ background: 'var(--c-surface)', borderBottom: '1px solid var(--c-border)' }}
    >
      {workspaces.map(w => {
        const isActive = w.id === activeId
        const editing = editingId === w.id
        return (
          <div
            key={w.id}
            onClick={() => setActive(w.id)}
            className="group flex items-center gap-1.5 h-7 pl-1 pr-1 rounded-md cursor-pointer shrink-0 transition-colors"
            style={{
              background: isActive ? 'var(--c-surface-2)' : 'transparent',
              border: isActive ? '1px solid var(--c-border)' : '1px solid transparent',
              opacity: w.enabled ? 1 : 0.55
            }}
            title={w.enabled ? 'Enabled — audio is running' : 'Disabled — silent'}
          >
            {/* Power toggle: enable/disable this workspace's audio independently. */}
            <button
              onClick={e => { e.stopPropagation(); void setEnabled(w.id, !w.enabled) }}
              title={w.enabled ? 'Disable workspace (stop its audio)' : 'Enable workspace (start its audio)'}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors shrink-0"
              style={{ color: w.enabled ? 'var(--c-accent)' : 'var(--c-text-dim)' }}
            >
              <Power size={12} />
            </button>

            {editing ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onBlur={commitRename}
                onClick={e => e.stopPropagation()}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') setEditingId(null)
                }}
                className="w-24 bg-zinc-900 border border-zinc-600 rounded px-1 py-0.5 text-[11px] outline-none"
                style={{ color: 'var(--c-text)' }}
              />
            ) : (
              <span
                onDoubleClick={e => { e.stopPropagation(); beginRename(w.id, w.name) }}
                className="text-[11px] whitespace-nowrap max-w-[140px] truncate select-none"
                style={{ color: isActive ? 'var(--c-text)' : 'var(--c-text-dim)', fontWeight: isActive ? 600 : 400 }}
              >
                {w.name}
              </span>
            )}

            {workspaces.length > 1 && (
              <button
                onClick={e => { e.stopPropagation(); removeWorkspace(w.id) }}
                title="Delete workspace"
                className="w-4 h-4 flex items-center justify-center rounded text-transparent group-hover:text-zinc-400 hover:!text-red-400 hover:bg-white/10 transition-colors shrink-0"
              >
                <X size={11} />
              </button>
            )}
          </div>
        )
      })}

      <button
        onClick={() => addWorkspace()}
        title="New workspace"
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors shrink-0"
        style={{ color: 'var(--c-text-dim)' }}
      >
        <Plus size={14} />
      </button>

      {/* Bulk enable/disable */}
      <div className="ml-auto flex items-center gap-0.5 shrink-0 pl-2">
        <button
          onClick={() => void setAllEnabled(true)}
          disabled={allEnabled}
          title="Enable all workspaces"
          className="flex items-center gap-1 h-6 px-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-[10px]"
          style={{ color: 'var(--c-text-dim)' }}
        >
          <ToggleRight size={13} /> All on
        </button>
        <button
          onClick={() => void setAllEnabled(false)}
          disabled={noneEnabled}
          title="Disable all workspaces"
          className="flex items-center gap-1 h-6 px-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-[10px]"
          style={{ color: 'var(--c-text-dim)' }}
        >
          <ToggleLeft size={13} /> All off
        </button>
      </div>
    </div>
  )
}
