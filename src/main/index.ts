import { app, shell, BrowserWindow, ipcMain, desktopCapturer, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

let pendingCaptureSourceId: string | null = null

// ── Native audio engine (Rust) bridge ──────────────────────────────────────
//
// The Rust engine ships as a Node-API addon (`audio-engine-native`). It is
// lazy-loaded and every access is fault-tolerant: if the addon hasn't been
// built (`npm run build:native`) the app keeps running on the Web Audio engine,
// which remains the default during the migration. Phase 0 only bridges
// version/info/device-enumeration; the real graph + meter streaming arrives in
// Phase 1.

interface NativeAudioDevice {
  id: string
  name: string
  isDefault: boolean
}
interface NativeAudioEngineInstance {
  init(): void
  isInitialized(): boolean
  inputDevices(): NativeAudioDevice[]
  outputDevices(): NativeAudioDevice[]
  createNode(id: string, nodeType: string, channels: number, deviceId: string): void
  setInputDevice(id: string, deviceId: string): void
  setOutputDevice(id: string, deviceId: string): void
  connect(source: string, sourceChannel: number, target: string, targetChannel: number): void
  disconnect(source: string, sourceChannel: number, target: string, targetChannel: number): void
  setGain(id: string, gain: number): void
  setMuted(id: string, muted: boolean): void
  setParam(id: string, param: string, index: number, value: number): void
  destroyNode(id: string): void
  meters(): Record<string, number>
}
interface NativeAudioModule {
  version(): string
  engineInfo(): { version: string; backend: string; audioReady: boolean }
  NativeAudioEngine: new () => NativeAudioEngineInstance
}

let nativeMod: NativeAudioModule | null | undefined
let nativeEngineInstance: NativeAudioEngineInstance | null = null

async function loadNativeModule(): Promise<NativeAudioModule | null> {
  if (nativeMod === undefined) {
    try {
      // `string`-typed (non-literal) specifier keeps the typecheck decoupled
      // from the generated bindings and stops the bundler from inlining the .node.
      const specifier: string = 'audio-engine-native'
      nativeMod = (await import(specifier)) as NativeAudioModule
    } catch (e) {
      console.warn('[audio] native engine addon unavailable:', (e as Error).message)
      nativeMod = null
    }
  }
  return nativeMod
}

async function getNativeEngine(): Promise<NativeAudioEngineInstance | null> {
  const mod = await loadNativeModule()
  if (!mod) return null
  if (!nativeEngineInstance) {
    nativeEngineInstance = new mod.NativeAudioEngine()
    nativeEngineInstance.init()
  }
  return nativeEngineInstance
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      // Output nodes play through <audio> elements; allow them to start without
      // a user gesture so audio routing works immediately on launch.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.audionodes')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Window controls (frameless titlebar)
  ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w?.isMaximized()) w.unmaximize()
    else w?.maximize()
  })
  ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  // ── Desktop / application capture ──────────────────────────────────────
  //
  // Enumerate windows so the user can pick one to capture. The id we return
  // (e.g. "window:12345:0") is what getUserMedia needs as chromeMediaSourceId.
  //
  ipcMain.handle('list-window-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 160, height: 100 },
      fetchWindowIcons: true
    })
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumbnail: s.thumbnail?.isEmpty() ? null : s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
    }))
  })

  // Quick lookup by name (for auto-reconnect when an app reopens)
  ipcMain.handle('find-source-by-name', async (_e, name: string) => {
    const sources = await desktopCapturer.getSources({ types: ['window'] })
    const match = sources.find(s => s.name === name)
    return match ? { id: match.id, name: match.name } : null
  })

  // Stash a source id; the displayMedia handler reads it.
  ipcMain.handle('arm-capture-source', async (_e, sourceId: string) => {
    pendingCaptureSourceId = sourceId
  })

  // ── Native audio engine bridge (Rust) ─────────────────────────────────────
  // Returns null/empty when the addon isn't built so the renderer can fall back.
  ipcMain.handle('audio:version', async () => {
    const mod = await loadNativeModule()
    return mod ? mod.version() : null
  })
  ipcMain.handle('audio:info', async () => {
    const mod = await loadNativeModule()
    return mod ? mod.engineInfo() : null
  })
  ipcMain.handle('audio:get-devices', async () => {
    const engine = await getNativeEngine()
    if (!engine) return { inputs: [], outputs: [] }
    return { inputs: engine.inputDevices(), outputs: engine.outputDevices() }
  })
  ipcMain.handle('audio:poll-meters', async () => {
    const engine = await getNativeEngine()
    return engine ? engine.meters() : {}
  })

  // Graph control — one-way; resolve the engine then apply.
  const withEngine = (fn: (e: NativeAudioEngineInstance) => void): void => {
    void getNativeEngine().then((e) => {
      if (e) fn(e)
    })
  }
  ipcMain.on('audio:create-node', (_e, id: string, type: string, channels: number, deviceId: string) =>
    withEngine((e) => e.createNode(id, type, channels, deviceId)))
  ipcMain.on('audio:set-output-device', (_e, id: string, deviceId: string) =>
    withEngine((e) => e.setOutputDevice(id, deviceId)))
  ipcMain.on('audio:connect', (_e, s: string, sc: number, t: string, tc: number) =>
    withEngine((e) => e.connect(s, sc, t, tc)))
  ipcMain.on('audio:disconnect', (_e, s: string, sc: number, t: string, tc: number) =>
    withEngine((e) => e.disconnect(s, sc, t, tc)))
  ipcMain.on('audio:set-gain', (_e, id: string, gain: number) => withEngine((e) => e.setGain(id, gain)))
  ipcMain.on('audio:set-muted', (_e, id: string, muted: boolean) => withEngine((e) => e.setMuted(id, muted)))
  ipcMain.on('audio:set-param', (_e, id: string, param: string, index: number, value: number) =>
    withEngine((e) => e.setParam(id, param, index, value)))
  ipcMain.on('audio:destroy-node', (_e, id: string) => withEngine((e) => e.destroyNode(id)))

  // Set up displayMedia handler. Allows the renderer to call getDisplayMedia
  // with `audio: 'loopback'` even when picking a non-browser window source.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (!pendingCaptureSourceId) {
      callback({})
      return
    }
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] })
    const source = sources.find(s => s.id === pendingCaptureSourceId)
    pendingCaptureSourceId = null
    if (source) {
      callback({ video: source, audio: 'loopback' })
    } else {
      callback({})
    }
  }, { useSystemPicker: false })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
