import { ReactFlowProvider } from '@xyflow/react'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { NodeEditor } from './components/NodeEditor'
import { ThemePanel } from './components/ThemePanel'

export function App(): JSX.Element {
  return (
    <div className="flex flex-col w-screen h-screen overflow-hidden" style={{ background: 'var(--c-app-bg)' }}>
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <ReactFlowProvider>
          <NodeEditor />
        </ReactFlowProvider>
      </div>
      <ThemePanel />
    </div>
  )
}
