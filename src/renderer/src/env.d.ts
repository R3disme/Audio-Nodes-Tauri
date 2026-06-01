/// <reference types="vite/client" />

interface WindowSource {
  id: string
  name: string
  isScreen: boolean
  thumbnail: string | null
  appIcon: string | null
}

interface Window {
  electron: {
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => void
      on: (channel: string, listener: (...args: unknown[]) => void) => void
      removeAllListeners: (channel: string) => void
    }
  }
  api: {
    windowMinimize: () => void
    windowMaximize: () => void
    windowClose: () => void
    listWindowSources: () => Promise<WindowSource[]>
    findSourceByName: (name: string) => Promise<{ id: string; name: string } | null>
    armCaptureSource: (sourceId: string) => Promise<void>
  }
}
