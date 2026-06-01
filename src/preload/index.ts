import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface WindowSource {
  id: string
  name: string
  isScreen: boolean
  thumbnail: string | null
  appIcon: string | null
}

const api = {
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),

  listWindowSources: (): Promise<WindowSource[]> =>
    ipcRenderer.invoke('list-window-sources'),
  findSourceByName: (name: string): Promise<{ id: string; name: string } | null> =>
    ipcRenderer.invoke('find-source-by-name', name),
  armCaptureSource: (sourceId: string): Promise<void> =>
    ipcRenderer.invoke('arm-capture-source', sourceId)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
