import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  ConnectionMode,
  ConnectionLineType,
  Panel,
  useReactFlow
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { SlidersVertical } from 'lucide-react'
import { useAudioStore } from '@renderer/store/audioStore'
import { InputNode } from './nodes/InputNode'
import { OutputNode } from './nodes/OutputNode'
import { VolumeNode } from './nodes/VolumeNode'
import { EQNode } from './nodes/EQNode'
import { CompressorNode } from './nodes/CompressorNode'
import { GateNode } from './nodes/GateNode'
import { MixerNode } from './nodes/MixerNode'
import { ApplicationNode } from './nodes/ApplicationNode'
import { VirtualOutputNode } from './nodes/VirtualOutputNode'
import { FilePlayerNode } from './nodes/FilePlayerNode'
import { ReverbNode } from './nodes/ReverbNode'
import { DelayNode } from './nodes/DelayNode'
import { ChorusNode } from './nodes/ChorusNode'
import { DistortionNode } from './nodes/DistortionNode'
import { PanNode } from './nodes/PanNode'
import { FilterNode } from './nodes/FilterNode'
import { LimiterNode } from './nodes/LimiterNode'
import { ExpanderNode } from './nodes/ExpanderNode'
import { TremoloNode } from './nodes/TremoloNode'
import { BitcrusherNode } from './nodes/BitcrusherNode'
import { RecorderNode } from './nodes/RecorderNode'
import { GroupNode } from './nodes/GroupNode'
import { DEFAULT_NODE_COLORS } from '@renderer/lib/nodeColors'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { memo, useEffect, useCallback } from 'react'

const nodeTypes: NodeTypes = {
  input:       memo(InputNode),
  fileplayer:  memo(FilePlayerNode),
  application: memo(ApplicationNode),
  output:      memo(OutputNode),
  virtual:     memo(VirtualOutputNode),
  volume:      memo(VolumeNode),
  eq:          memo(EQNode),
  compressor:  memo(CompressorNode),
  gate:        memo(GateNode),
  reverb:      memo(ReverbNode),
  delay:       memo(DelayNode),
  chorus:      memo(ChorusNode),
  distortion:  memo(DistortionNode),
  pan:         memo(PanNode),
  filter:      memo(FilterNode),
  limiter:     memo(LimiterNode),
  expander:    memo(ExpanderNode),
  tremolo:     memo(TremoloNode),
  bitcrusher:  memo(BitcrusherNode),
  mixer:       memo(MixerNode),
  recorder:    memo(RecorderNode),
  subgraph:    memo(GroupNode)
}

const defaultEdgeOptions = {
  style: { stroke: '#f0a020', strokeWidth: 2 },
  type: 'smoothstep' as const,
  animated: false,
  pathOptions: { borderRadius: 16 }
}

function NodeEditorInner(): JSX.Element {
  const nodes = useAudioStore(s => s.nodes)
  const edges = useAudioStore(s => s.edges)
  const onNodesChange = useAudioStore(s => s.onNodesChange)
  const onEdgesChange = useAudioStore(s => s.onEdgesChange)
  const onConnect = useAudioStore(s => s.onConnect)
  const initAudio = useAudioStore(s => s.initAudio)
  const initialized = useAudioStore(s => s.initialized)
  const theme = useSettingsStore(s => s.theme)
  const { screenToFlowPosition } = useReactFlow()

  useEffect(() => {
    initAudio().catch(console.error)
  }, [initAudio])

  // Ctrl/Cmd+G groups the selection; Ctrl/Cmd+Shift+G ungroups selected group(s).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'g') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return // don't hijack text fields
      e.preventDefault()
      const store = useAudioStore.getState()
      if (e.shiftKey) {
        for (const n of store.nodes) {
          if (n.type === 'subgraph' && n.selected) store.ungroup(n.id)
        }
      } else {
        store.groupSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const type = e.dataTransfer.getData('nodeType')
      if (!type) return
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      useAudioStore.getState().addNode(type, position)
    },
    [screenToFlowPosition]
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const showBgImage = theme.backgroundImageEnabled && !!theme.backgroundImage

  // Grouping affordances: show a Group button when ≥2 ungrouped nodes are selected,
  // and an Ungroup button when a group container is selected.
  const groupableCount = nodes.filter(n => n.selected && n.type !== 'subgraph' && !n.parentId).length
  const selectedGroup = nodes.find(n => n.selected && n.type === 'subgraph')

  return (
    <div
      className="w-full h-full relative"
      onDrop={onDrop}
      onDragOver={onDragOver}
      style={{ background: 'var(--c-canvas-bg)' }}
    >
      {/* Optional picture-theme background (behind the transparent canvas). */}
      {showBgImage && (
        <div
          className="absolute inset-0 bg-cover bg-center pointer-events-none"
          style={{ backgroundImage: `url(${theme.backgroundImage})`, opacity: theme.backgroundImageOpacity }}
        />
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionMode={ConnectionMode.Strict}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ stroke: theme.accent, strokeWidth: 2 }}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Shift']}
        fitView={false}
        minZoom={0.25}
        maxZoom={2}
        snapToGrid
        snapGrid={[16, 16]}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
      >
        {/* Two layers: a faint coarse grid for depth, fine dots on top. Hidden
            when a background image is shown so it doesn't clutter the picture. */}
        {!showBgImage && (
          <Background id="grid" variant={BackgroundVariant.Lines} gap={120} lineWidth={1} color={theme.grid2} />
        )}
        <Background
          id="dots"
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.4}
          color={showBgImage ? `${theme.grid}66` : theme.grid}
        />

        <Controls
          className="!shadow-lg !rounded-md overflow-hidden"
          style={{ bottom: 16, left: 16 }}
          showInteractive={false}
        />

        <MiniMap
          pannable
          zoomable
          style={{
            background: 'var(--c-surface)',
            border: '1px solid var(--c-border)',
            borderRadius: 6,
            bottom: 16,
            right: 16
          }}
          nodeColor={node => theme.nodes[node.type ?? ''] ?? DEFAULT_NODE_COLORS[node.type ?? ''] ?? '#444'}
          maskColor="#0008"
        />

        {!initialized && (
          <Panel position="top-center">
            <div className="flex items-center gap-2 rounded-lg px-4 py-2 text-xs shadow-xl backdrop-blur"
                 style={{ background: 'color-mix(in srgb, var(--c-surface) 92%, transparent)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}>
              <span className="w-2 h-2 rounded-full animate-ping" style={{ background: 'var(--c-accent)' }} />
              Initializing audio engine…
            </div>
          </Panel>
        )}

        {(groupableCount >= 2 || selectedGroup) && (
          <Panel position="top-center">
            <button
              onClick={() => {
                const store = useAudioStore.getState()
                if (groupableCount >= 2) store.groupSelection()
                else if (selectedGroup) store.ungroup(selectedGroup.id)
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold shadow-xl backdrop-blur transition-colors"
              style={{ background: 'var(--c-accent)', color: '#1a1a1a', border: '1px solid var(--c-border)' }}
              title={groupableCount >= 2 ? 'Group selected nodes (Ctrl+G)' : 'Ungroup (Ctrl+Shift+G)'}
            >
              {groupableCount >= 2 ? `⊞ Group ${groupableCount} nodes` : '⊟ Ungroup'}
            </button>
          </Panel>
        )}

        {initialized && nodes.length === 0 && (
          <Panel position="top-center" style={{ marginTop: 72 }}>
            <div className="rounded-xl px-5 py-4 text-xs shadow-2xl backdrop-blur text-center max-w-md"
                 style={{ background: 'color-mix(in srgb, var(--c-surface) 85%, transparent)', border: '1px solid var(--c-border)', color: 'var(--c-text-dim)' }}>
              <div className="mb-1.5 flex justify-center"><SlidersVertical size={24} style={{ color: 'var(--c-accent)' }} /></div>
              <div className="font-semibold text-sm mb-1" style={{ color: 'var(--c-text)' }}>Build your audio chain</div>
              <div className="leading-relaxed">
                Click a node in the sidebar — or drag it onto the canvas — then wire
                <span style={{ color: 'var(--c-accent)' }}> outputs → inputs</span> to route sound.
              </div>
            </div>
          </Panel>
        )}
      </ReactFlow>

      {/* Subtle vignette for depth — never intercepts pointer events. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 95% at 50% 0%, transparent 58%, rgba(0,0,0,0.42) 100%)' }}
      />
    </div>
  )
}

export const NodeEditor = memo(NodeEditorInner)
