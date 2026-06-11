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

export interface AudioAppInfo {
  pid: number
  name: string
  exe: string
  active: boolean
}

const api = {
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),

  // Tells main which engine is live and whether any renderer-side PCM bridge
  // (file player / app capture / recording) is active — main uses this to decide
  // if the hidden window can be destroyed in the tray (RAM saving) or only hidden.
  reportBackgroundState: (state: { engine: string; busy: boolean }): void =>
    ipcRenderer.send('renderer:bg-state', state),

  // Virtual-cable driver build/install (native/driver). `onLog` streams build
  // output; the returned function unsubscribes.
  driver: {
    status: (): Promise<{ available: boolean; building: boolean }> => ipcRenderer.invoke('driver:status'),
    build: (): Promise<{ code: number; error?: string }> => ipcRenderer.invoke('driver:build'),
    install: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('driver:install'),
    onLog: (cb: (line: string) => void): (() => void) => {
      const handler = (_e: unknown, line: string): void => cb(line)
      ipcRenderer.on('driver:log', handler)
      return () => ipcRenderer.removeListener('driver:log', handler)
    }
  },

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
    connect: (source: string, sourceChannel: number, target: string, targetChannel: number): void =>
      ipcRenderer.send('audio:connect', source, sourceChannel, target, targetChannel),
    disconnect: (source: string, sourceChannel: number, target: string, targetChannel: number): void =>
      ipcRenderer.send('audio:disconnect', source, sourceChannel, target, targetChannel),
    setGain: (id: string, gain: number): void => ipcRenderer.send('audio:set-gain', id, gain),
    setMuted: (id: string, muted: boolean): void => ipcRenderer.send('audio:set-muted', id, muted),
    setParam: (id: string, param: string, index: number, value: number): void =>
      ipcRenderer.send('audio:set-param', id, param, index, value),
    setLatencyMode: (mode: string): void => ipcRenderer.send('audio:set-latency-mode', mode),
    setDeviceMode: (mode: string): void => ipcRenderer.send('audio:set-device-mode', mode),
    destroyNode: (id: string): void => ipcRenderer.send('audio:destroy-node', id),
    pollMeters: (): Promise<Record<string, number>> => ipcRenderer.invoke('audio:poll-meters'),
    latency: (): Promise<number> => ipcRenderer.invoke('audio:latency'),
    startRecording: (id: string): void => ipcRenderer.send('audio:start-recording', id),
    stopRecording: (id: string): Promise<{ bytes: Uint8Array; ext: string; mime: string } | null> =>
      ipcRenderer.invoke('audio:stop-recording', id),
    pushCapture: (id: string, samples: Float32Array, sampleRate: number): void =>
      ipcRenderer.send('audio:push-capture', id, samples, sampleRate),
    // Per-process application capture (native engine). `takeover` parks the
    // app's own output on a virtual sink while captured (no duplicate audio).
    listAudioApps: (): Promise<AudioAppInfo[]> => ipcRenderer.invoke('audio:list-apps'),
    setAppProcess: (id: string, pid: number, takeover: boolean): void =>
      ipcRenderer.send('audio:set-app-process', id, pid, takeover),
    takeoverDevice: (): Promise<string | null> => ipcRenderer.invoke('audio:takeover-device')
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
