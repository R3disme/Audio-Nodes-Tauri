import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface WindowSource {
  id: string
  name: string
  isScreen: boolean
  thumbnail: string | null
  appIcon: string | null
}

export interface NativeAudioDevice {
  id: string
  name: string
  isDefault: boolean
}

export interface NativeEngineInfo {
  version: string
  backend: string
  audioReady: boolean
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
    ipcRenderer.invoke('arm-capture-source', sourceId),

  // Native (Rust) audio engine bridge. Diagnostics + device enumeration resolve
  // to null/empty when the addon isn't built; control calls are fire-and-forget.
  audio: {
    version: (): Promise<string | null> => ipcRenderer.invoke('audio:version'),
    info: (): Promise<NativeEngineInfo | null> => ipcRenderer.invoke('audio:info'),
    getDevices: (): Promise<{ inputs: NativeAudioDevice[]; outputs: NativeAudioDevice[] }> =>
      ipcRenderer.invoke('audio:get-devices'),
    // Graph control (one-way; the engine applies them on its own threads).
    createNode: (id: string, nodeType: string, channels: number, deviceId: string): void =>
      ipcRenderer.send('audio:create-node', id, nodeType, channels, deviceId),
    setOutputDevice: (id: string, deviceId: string): void =>
      ipcRenderer.send('audio:set-output-device', id, deviceId),
    connect: (source: string, target: string): void =>
      ipcRenderer.send('audio:connect', source, target),
    disconnect: (source: string, target: string): void =>
      ipcRenderer.send('audio:disconnect', source, target),
    setGain: (id: string, gain: number): void => ipcRenderer.send('audio:set-gain', id, gain),
    setMuted: (id: string, muted: boolean): void => ipcRenderer.send('audio:set-muted', id, muted),
    destroyNode: (id: string): void => ipcRenderer.send('audio:destroy-node', id),
    pollMeters: (): Promise<Record<string, number>> => ipcRenderer.invoke('audio:poll-meters')
  }
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
