import { invoke } from '@tauri-apps/api/tauri'
import { listen } from '@tauri-apps/api/event'
import { appWindow } from '@tauri-apps/api/window'

const api = {
  windowMinimize: async (): Promise<void> => { await appWindow.hide() },
  windowMaximize: async (): Promise<void> => {
    if (await appWindow.isMaximized()) await appWindow.unmaximize()
    else await appWindow.maximize()
  },
  windowClose: async (): Promise<void> => { await appWindow.close() },

  reportBackgroundState: (state: { engine: string; busy: boolean }): void => {
    void invoke('renderer_bg_state', { state }).catch(() => {})
  },

  driver: {
    status: (): Promise<{ available: boolean; building: boolean }> => invoke('driver_status'),
    build: (): Promise<{ code: number; error?: string }> => invoke('driver_build'),
    install: (): Promise<{ ok: boolean; error?: string }> => invoke('driver_install'),
    onLog: (cb: (line: string) => void): (() => void) => {
      const unlisten = listen<string>('driver:log', (event) => cb(event.payload))
      return () => { void unlisten.then((off) => off()).catch(() => {}) }
    }
  },

  listWindowSources: (): Promise<Array<{ id: string; name: string; isScreen: boolean; thumbnail: string | null; appIcon: string | null }>> =>
    invoke('list_window_sources'),
  findSourceByName: (name: string): Promise<{ id: string; name: string } | null> =>
    invoke('find_source_by_name', { name }),
  armCaptureSource: (sourceId: string): Promise<void> =>
    invoke('arm_capture_source', { sourceId }),

  audio: {
    version: (): Promise<string | null> => invoke('audio_version'),
    info: (): Promise<{ version: string; backend: string; audioReady: boolean } | null> => invoke('audio_info'),
    getDevices: (): Promise<{ inputs: Array<{ id: string; name: string; isDefault: boolean }>; outputs: Array<{ id: string; name: string; isDefault: boolean }> }> =>
      invoke('audio_get_devices'),
    createNode: (id: string, nodeType: string, channels: number, deviceId: string): void =>
      void invoke('audio_create_node', { id, nodeType, channels, deviceId }),
    setOutputDevice: (id: string, deviceId: string): void =>
      void invoke('audio_set_output_device', { id, deviceId }),
    connect: (source: string, sourceChannel: number, target: string, targetChannel: number): void =>
      void invoke('audio_connect', { source, sourceChannel, target, targetChannel }),
    disconnect: (source: string, sourceChannel: number, target: string, targetChannel: number): void =>
      void invoke('audio_disconnect', { source, sourceChannel, target, targetChannel }),
    setGain: (id: string, gain: number): void => void invoke('audio_set_gain', { id, gain }),
    setMuted: (id: string, muted: boolean): void => void invoke('audio_set_muted', { id, muted }),
    setParam: (id: string, param: string, index: number, value: number): void =>
      void invoke('audio_set_param', { id, param, index, value }),
    setLatencyMode: (mode: string): void => void invoke('audio_set_latency_mode', { mode }),
    setDeviceMode: (mode: string): void => void invoke('audio_set_device_mode', { mode }),
    destroyNode: (id: string): void => void invoke('audio_destroy_node', { id }),
    pollMeters: (): Promise<Record<string, number>> => invoke('audio_poll_meters'),
    latency: (): Promise<number> => invoke('audio_latency'),
    startRecording: (id: string): void => void invoke('audio_start_recording', { id }),
    stopRecording: (id: string): Promise<{ bytes: Uint8Array; ext: string; mime: string } | null> =>
      invoke('audio_stop_recording', { id }),
    pushCapture: (id: string, samples: Float32Array, sampleRate: number): void =>
      void invoke('audio_push_capture', { id, samples: Array.from(samples), sampleRate }),
    listAudioApps: (): Promise<Array<{ pid: number; name: string; exe: string; active: boolean }>> => invoke('audio_list_apps'),
    setAppProcess: (id: string, pid: number, takeover: boolean): void =>
      void invoke('audio_set_app_process', { id, pid, takeover }),
    takeoverDevice: (): Promise<string | null> => invoke('audio_takeover_device')
  }
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { api: typeof api }).api = api
}

export {}