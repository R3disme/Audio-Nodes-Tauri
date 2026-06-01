import { app, shell, BrowserWindow, ipcMain, desktopCapturer, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

let pendingCaptureSourceId: string | null = null

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
