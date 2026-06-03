import { ReactFlowProvider } from '@xyflow/react'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { NodeEditor } from './components/NodeEditor'
import { WorkspaceBar } from './components/WorkspaceBar'
import { ThemePanel } from './components/ThemePanel'

export function App(): JSX.Element {
  return (
    <div className="flex flex-col w-screen h-screen overflow-hidden" style={{ background: 'var(--c-app-bg)' }}>
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        {/* Right column: workspace tabs above the canvas. */}
        <div className="flex flex-col flex-1 min-w-0">
          <WorkspaceBar />
          <div className="flex-1 min-h-0 relative">
            <ReactFlowProvider>
              <NodeEditor />
            </ReactFlowProvider>
          </div>
        </div>
      </div>
      <ThemePanel />
    </div>
  )
}
