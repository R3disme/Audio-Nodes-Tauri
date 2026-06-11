/// <reference types="vite/client" />

interface WindowSource {
  id: string
  name: string
  isScreen: boolean
  thumbnail: string | null
  appIcon: string | null
}

interface NativeAudioDevice {
  id: string
  name: string
  isDefault: boolean
}

interface NativeEngineInfo {
  version: string
  backend: string
  audioReady: boolean
}

interface AudioAppInfo {
  pid: number
  name: string
  exe: string
  active: boolean
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
    reportBackgroundState: (state: { engine: string; busy: boolean }) => void
    driver: {
      status: () => Promise<{ available: boolean; building: boolean }>
      build: () => Promise<{ code: number; error?: string }>
      install: () => Promise<{ ok: boolean; error?: string }>
      onLog: (cb: (line: string) => void) => () => void
    }
    listWindowSources: () => Promise<WindowSource[]>
    findSourceByName: (name: string) => Promise<{ id: string; name: string } | null>
    armCaptureSource: (sourceId: string) => Promise<void>
    audio: {
      version: () => Promise<string | null>
      info: () => Promise<NativeEngineInfo | null>
      getDevices: () => Promise<{ inputs: NativeAudioDevice[]; outputs: NativeAudioDevice[] }>
      createNode: (id: string, nodeType: string, channels: number, deviceId: string) => void
      setOutputDevice: (id: string, deviceId: string) => void
      connect: (source: string, sourceChannel: number, target: string, targetChannel: number) => void
      disconnect: (source: string, sourceChannel: number, target: string, targetChannel: number) => void
      setGain: (id: string, gain: number) => void
      setMuted: (id: string, muted: boolean) => void
      setParam: (id: string, param: string, index: number, value: number) => void
      setLatencyMode: (mode: string) => void
      setDeviceMode: (mode: string) => void
      destroyNode: (id: string) => void
      pollMeters: () => Promise<Record<string, number>>
      latency: () => Promise<number>
      startRecording: (id: string) => void
      stopRecording: (id: string) => Promise<{ bytes: Uint8Array; ext: string; mime: string } | null>
      pushCapture: (id: string, samples: Float32Array, sampleRate: number) => void
      listAudioApps: () => Promise<AudioAppInfo[]>
      setAppProcess: (id: string, pid: number, takeover: boolean) => void
      takeoverDevice: () => Promise<string | null>
    }
  }
}
