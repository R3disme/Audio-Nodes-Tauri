import { app, shell, BrowserWindow, ipcMain, desktopCapturer, session, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { TRAY_ICON_DATA_URL } from './trayIcon'

let pendingCaptureSourceId: string | null = null

// ── Tray / background ───────────────────────────────────────────────────────
// The app is a background audio router: minimize and close both hide it to the
// system tray (it keeps routing audio); it only really quits via the tray menu.
//
// RAM saving: on the native engine the audio graph lives in THIS process, so the
// hidden renderer window is dead weight (~150-250 MB). After a grace period in
// the tray the window is destroyed outright and recreated from persisted state on
// the next tray click — the engine ops are replay-idempotent, so the rebuild
// reattaches to the live graph without an audio gap. Gated off whenever the
// renderer is load-bearing: Web Audio engine (the renderer IS the engine), or a
// renderer PCM bridge is active (file player / app capture / recording).
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let appIcon: Electron.NativeImage | null = null
let isQuitting = false
// e2e harness (scripts/*.mjs) drives close/quit itself — don't trap close to the
// tray or create a tray icon, so Playwright's app.close() exits cleanly.
const E2E = process.env.AUDIO_NODES_E2E === '1'

// Reported by the renderer (preload `reportBackgroundState`). The default is the
// safe one: never destroy until the renderer has said who is in charge of audio.
let bgState: { engine: string; busy: boolean } = { engine: 'unknown', busy: true }
const DESTROY_GRACE_MS = 45_000
let destroyTimer: NodeJS.Timeout | null = null
// Window geometry carried across a destroy/recreate cycle.
let savedBounds: Electron.Rectangle | null = null
let savedMaximized = false

function canShedRenderer(): boolean {
  return bgState.engine === 'native' && !bgState.busy
}

function scheduleDestroy(): void {
  cancelDestroy()
  if (E2E || isQuitting) return
  destroyTimer = setTimeout(maybeDestroyWindow, DESTROY_GRACE_MS)
}

function cancelDestroy(): void {
  if (destroyTimer) {
    clearTimeout(destroyTimer)
    destroyTimer = null
  }
}

function maybeDestroyWindow(): void {
  destroyTimer = null
  const win = mainWindow
  if (E2E || isQuitting || !win || win.isDestroyed() || win.isVisible()) return
  if (!canShedRenderer()) return
  savedBounds = win.getNormalBounds()
  savedMaximized = win.isMaximized()
  mainWindow = null
  // destroy() skips the close-to-tray trap (no `close` event). `window-all-closed`
  // keeps the app alive because isQuitting is false.
  win.destroy()
}

/** Hide to the tray; throttle the renderer first when it isn't load-bearing for
 *  audio. Sequenced strictly before hide() — toggling throttling while already
 *  hidden desyncs Chromium's visibility state (electron#50250). */
function hideToTray(win: BrowserWindow): void {
  if (canShedRenderer()) win.webContents.setBackgroundThrottling(true)
  win.hide()
}

function showMainWindow(): void {
  if (!mainWindow) { createWindow(); return }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  // Restore full timer/rAF resolution (strictly after show — see hideToTray).
  mainWindow.webContents.setBackgroundThrottling(false)
  mainWindow.focus()
}

function createTray(): void {
  if (tray || !appIcon) return
  tray = new Tray(appIcon)
  tray.setToolTip('Audio Nodes')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Audio Nodes', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('click', () => showMainWindow())
}

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
  setLatencyMode(mode: string): void
  setDeviceMode(mode: string): void
  destroyNode(id: string): void
  meters(): Record<string, number>
  latencyMs(): number
  startRecording(id: string): boolean
  stopRecording(id: string): string | null
  pushCapture(id: string, samples: Float32Array, sampleRate: number): void
  listAudioApps(): { pid: number; name: string; exe: string; active: boolean }[]
  setAppProcess(id: string, pid: number, takeover: boolean): void
  takeoverDevice(): string | null
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
  // A recreated window must re-earn destroy eligibility: reset to the safe
  // default until the new renderer reports its background state.
  bgState = { engine: 'unknown', busy: true }
  const win = new BrowserWindow({
    width: savedBounds?.width ?? 1400,
    height: savedBounds?.height ?? 900,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    frame: false,
    icon: appIcon ?? undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      // Output nodes play through <audio> elements; allow them to start without
      // a user gesture so audio routing works immediately on launch.
      autoplayPolicy: 'no-user-gesture-required',
      // Keep audio-thread work (e.g. the noise-gate detection loop) responsive
      // while hidden in the tray. The renderer pauses its own meter work on
      // visibilitychange, so this doesn't cost idle CPU.
      backgroundThrottling: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    if (savedMaximized) win.maximize()
    win.show()
  })

  // Arm the destroy grace timer whenever the window goes to the tray; any show
  // (tray click, app activate) disarms it.
  win.on('hide', scheduleDestroy)
  win.on('show', cancelDestroy)

  // Close + minimize hide to the tray instead of quitting / going to the taskbar,
  // so the app keeps routing audio in the background. Real quit sets isQuitting.
  win.on('close', (e) => {
    if (!isQuitting && !E2E) {
      e.preventDefault()
      hideToTray(win)
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.audionodes')
  appIcon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  app.on('before-quit', () => { isQuitting = true; cancelDestroy() })

  // Renderer background-state reports (see preload `reportBackgroundState`).
  ipcMain.on('renderer:bg-state', (_e, state: { engine: string; busy: boolean }) => {
    bgState = state
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Window controls (frameless titlebar). Minimize hides to the tray.
  ipcMain.on('window-minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) hideToTray(w)
  })
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
  ipcMain.handle('audio:latency', async () => {
    const engine = await getNativeEngine()
    return engine ? engine.latencyMs() : 0
  })
  // Per-process application capture (Windows process loopback): the app list is
  // the volume-mixer view (audio sessions — minimized apps included, named by
  // exe), and capture runs entirely in the Rust engine (no renderer PCM bridge).
  ipcMain.handle('audio:list-apps', async () => {
    const engine = await getNativeEngine()
    return engine ? engine.listAudioApps() : []
  })
  ipcMain.on('audio:set-app-process', (_e, id: string, pid: number, takeover: boolean) =>
    withEngine((e) => e.setAppProcess(id, pid, takeover)))
  ipcMain.handle('audio:takeover-device', async () => {
    const engine = await getNativeEngine()
    return engine ? engine.takeoverDevice() : null
  })
  ipcMain.on('audio:start-recording', (_e, id: string) =>
    withEngine((e) => e.startRecording(id)))
  // High-rate: PCM blocks captured in the renderer (getDisplayMedia) → engine ring.
  ipcMain.on('audio:push-capture', (_e, id: string, samples: Float32Array, sampleRate: number) =>
    withEngine((e) => e.pushCapture(id, samples, sampleRate)))
  // Stop → the engine writes a temp WAV; read it back as bytes for the renderer
  // (so the same download/playback path as Web Audio works), then delete it.
  ipcMain.handle('audio:stop-recording', async (_e, id: string) => {
    const engine = await getNativeEngine()
    const path = engine ? engine.stopRecording(id) : null
    if (!path) return null
    try {
      const bytes = await readFile(path)
      void unlink(path).catch(() => {})
      return { bytes, ext: 'wav', mime: 'audio/wav' }
    } catch {
      return null
    }
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
  ipcMain.on('audio:set-latency-mode', (_e, mode: string) =>
    withEngine((e) => e.setLatencyMode(mode)))
  ipcMain.on('audio:set-device-mode', (_e, mode: string) =>
    withEngine((e) => e.setDeviceMode(mode)))
  ipcMain.on('audio:destroy-node', (_e, id: string) => withEngine((e) => e.destroyNode(id)))

  // ── Virtual-cable driver build/install ─────────────────────────────────────
  // Power-user convenience: build (and optionally install) the Audio Nodes
  // Virtual Cable from native/driver/ without leaving the app. Build needs no
  // admin; install must be elevated, so it launches a UAC'd PowerShell window.
  const driverDir = join(app.getAppPath(), 'native', 'driver')
  const driverScript = (name: string): string => join(driverDir, name)
  let driverBuilding = false

  ipcMain.handle('driver:status', async () => ({
    available: existsSync(driverScript('build.ps1')),
    building: driverBuilding
  }))

  ipcMain.handle('driver:build', async (e) => {
    const script = driverScript('build.ps1')
    if (!existsSync(script)) return { code: -1, error: 'build.ps1 not found (native/driver missing)' }
    if (driverBuilding) return { code: -1, error: 'a build is already running' }
    driverBuilding = true
    const wc = e.sender
    const emit = (line: string): void => { if (!wc.isDestroyed()) wc.send('driver:log', line) }
    emit(`> building driver — ${script}`)
    return await new Promise<{ code: number }>((resolve) => {
      const child = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { cwd: driverDir })
      const pump = (buf: Buffer): void => buf.toString().split(/\r?\n/).forEach(l => l && emit(l))
      child.stdout.on('data', pump)
      child.stderr.on('data', pump)
      child.on('error', (err) => { emit(`! failed to start PowerShell: ${err.message}`); driverBuilding = false; resolve({ code: -1 }) })
      child.on('close', (code) => {
        emit(code === 0 ? '✓ build finished — output in native/driver/out/' : `✗ build exited with code ${code}`)
        driverBuilding = false
        resolve({ code: code ?? -1 })
      })
    })
  })

  ipcMain.handle('driver:install', async (e) => {
    const script = driverScript('install.ps1')
    if (!existsSync(script)) return { ok: false, error: 'install.ps1 not found' }
    // install.ps1 self-checks for elevation; launch it in a UAC-elevated console
    // that stays open so the user can read the result (output can't stream back
    // across the elevation boundary).
    const inner = `-NoExit -NoProfile -ExecutionPolicy Bypass -File "${script}"`
    const cmd = `Start-Process powershell.exe -Verb RunAs -ArgumentList '${inner}'`
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { cwd: driverDir })
    child.on('error', () => {})
    e.sender.send('driver:log', '> launching elevated installer (accept the UAC prompt)…')
    return { ok: true }
  })

  // Set up displayMedia handler. Allows the renderer to call getDisplayMedia
  // with `audio: 'loopback'` even when picking a non-browser window source.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (!pendingCaptureSourceId) {
      callback({})
      return
    }
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] })
    // The chosen window may be minimized or closed (Windows won't enumerate it for
    // capture). Audio here is system loopback regardless of the video source, so
    // fall back to a screen source to keep the audio flowing instead of failing.
    const source = sources.find(s => s.id === pendingCaptureSourceId)
      ?? sources.find(s => s.id.startsWith('screen:'))
      ?? sources[0]
    pendingCaptureSourceId = null
    if (source) {
      callback({ video: source, audio: 'loopback' })
    } else {
      callback({})
    }
  }, { useSystemPicker: false })

  createWindow()
  if (!E2E) createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // Windows are hidden (not closed) when sent to the tray, so this normally only
  // fires on a real quit. Keep the app alive otherwise.
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})
