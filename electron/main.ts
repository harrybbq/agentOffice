// Main process entry. `./config` must stay the first import: it pins userData before anything uses it.
import { configPath, getConfig, loadConfig, regenerateToken, saveConfig } from './config'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC, type RendererSettings } from '../shared/ipc'
import { EventBus } from './bus'
import { startIngestServer, type IngestServer } from './ingest/server'
import { isValidThemeName, listThemes, loadTheme, registerThemeProtocol, registerThemeScheme } from './themes'

const HERE = dirname(fileURLToPath(import.meta.url)) // out/main
const PRELOAD = join(HERE, '../preload/index.cjs')
const RENDERER_HTML = join(HERE, '../renderer/index.html')
const DEV_URL = process.env.ELECTRON_RENDERER_URL
const OVERLAY_SHORTCUT = 'CommandOrControl+Shift+O'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let server: IngestServer | null = null
let serverStatus = 'starting…'
let quitting = false
const bus = new EventBus()

// ---------- pre-ready ----------

registerThemeScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.on('before-quit', () => {
    quitting = true
  })
  // Keep running in the tray when windows go away (also covers overlay recreation).
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    void server?.close()
  })
  app.whenReady().then(onReady, (err) => {
    console.error('[agent-office] startup failed:', err)
    app.quit()
  })
}

// ---------- ready ----------

async function onReady(): Promise<void> {
  loadConfig()
  console.log(`[agent-office] config: ${configPath()}`)

  // The renderer never needs camera/mic/notifications/etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  registerThemeProtocol()
  registerIpc()
  createTray()
  createWindow()

  try {
    server = await startIngestServer({ port: getConfig().port, getToken: () => getConfig().token, sink: bus })
    serverStatus = `listening on 127.0.0.1:${server.port}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    serverStatus = `ingest server failed: ${msg}`
    console.error(`[agent-office] ${serverStatus}`)
    updateTrayTooltip()
    rebuildTrayMenu()
    dialog.showErrorBox('Agent Office: ingest server failed', msg)
  }
  updateTrayTooltip()
  rebuildTrayMenu()

  if (!globalShortcut.register(OVERLAY_SHORTCUT, () => void setOverlay(!getConfig().overlay))) {
    console.warn(`[agent-office] could not register ${OVERLAY_SHORTCUT}`)
  }
}

// ---------- IPC ----------

function rendererSettings(): RendererSettings {
  const c = getConfig()
  return { theme: c.theme, overlay: c.overlay }
}

function fromOurWindow(e: IpcMainInvokeEvent): boolean {
  return !!win && !win.isDestroyed() && e.sender === win.webContents
}

function registerIpc(): void {
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (e: IpcMainInvokeEvent, ...args: A): R => {
      if (!fromOurWindow(e)) throw new Error('unauthorised sender')
      return fn(...args)
    }
  ipcMain.handle(IPC.getSettings, guard(() => rendererSettings()))
  ipcMain.handle(IPC.listThemes, guard(() => listThemes()))
  ipcMain.handle(IPC.loadTheme, guard((name: unknown) => loadTheme(name)))
}

function pushSettings(): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC.settings, rendererSettings())
}

// ---------- window ----------

function isAllowedUrl(url: string): boolean {
  try {
    if (DEV_URL) return new URL(url).origin === new URL(DEV_URL).origin
    const target = new URL(url)
    target.hash = ''
    target.search = ''
    return target.href === pathToFileURL(RENDERER_HTML).href
  } catch {
    return false
  }
}

function createWindow(): void {
  const cfg = getConfig()
  const overlay = cfg.overlay
  const prev = win && !win.isDestroyed() ? win.getBounds() : null

  const w = new BrowserWindow({
    width: prev?.width ?? 1000,
    height: prev?.height ?? 700,
    x: prev?.x,
    y: prev?.y,
    title: 'Agent Office',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: overlay ? '#00000000' : '#2b2d42',
    transparent: overlay,
    frame: !overlay,
    hasShadow: !overlay,
    skipTaskbar: overlay,
    alwaysOnTop: overlay || cfg.alwaysOnTop,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  if (overlay) {
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setIgnoreMouseEvents(true, { forward: true })
    w.setVisibleOnAllWorkspaces(true)
  }

  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedUrl(url)) e.preventDefault()
  })
  w.webContents.on('will-redirect', (e, url) => {
    if (!isAllowedUrl(url)) e.preventDefault()
  })
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())

  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      w.hide()
      rebuildTrayMenu()
    }
  })
  w.on('show', rebuildTrayMenu)
  w.on('hide', rebuildTrayMenu)
  w.once('ready-to-show', () => w.show())

  bus.attach(w.webContents)
  const old = win
  win = w
  // destroy() skips the 'close' handler, so the hide-to-tray logic doesn't interfere.
  if (old && !old.isDestroyed()) old.destroy()

  if (DEV_URL) void w.loadURL(DEV_URL)
  else void w.loadFile(RENDERER_HTML)
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function toggleWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  else showWindow()
}

async function setOverlay(on: boolean): Promise<void> {
  saveConfig({ overlay: on })
  createWindow() // transparency can't be toggled on a live window
  rebuildTrayMenu()
}

function setAlwaysOnTop(on: boolean): void {
  saveConfig({ alwaysOnTop: on })
  if (win && !win.isDestroyed() && !getConfig().overlay) win.setAlwaysOnTop(on)
  rebuildTrayMenu()
}

function setTheme(name: string): void {
  if (!isValidThemeName(name) || name === getConfig().theme) return
  saveConfig({ theme: name })
  pushSettings()
  rebuildTrayMenu()
}

// ---------- tray ----------

/** 16x16 icon drawn in code: a little figure at a desk. Written as BGRA (Skia's native order). */
function trayIcon(): Electron.NativeImage {
  const S = 16
  const buf = Buffer.alloc(S * S * 4)
  const px = (x: number, y: number, [r, g, b]: [number, number, number]) => {
    const i = (y * S + x) * 4
    buf[i] = b
    buf[i + 1] = g
    buf[i + 2] = r
    buf[i + 3] = 255
  }
  const head: [number, number, number] = [255, 214, 170]
  const body: [number, number, number] = [74, 144, 226]
  const desk: [number, number, number] = [141, 110, 99]
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = x - 7.5
      const hy = y - 4
      if (hx * hx + hy * hy <= 7) px(x, y, head)
      else if (y >= 7 && y <= 10 && x >= 4 && x <= 11) px(x, y, body)
      else if (y >= 11 && y <= 12 && x >= 1 && x <= 14) px(x, y, desk)
      else if (y >= 13 && (x === 2 || x === 3 || x === 12 || x === 13)) px(x, y, desk)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S })
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.on('click', toggleWindow)
  updateTrayTooltip()
  rebuildTrayMenu()
}

function updateTrayTooltip(): void {
  tray?.setToolTip(`Agent Office: ${serverStatus}`)
}

let menuGen = 0
function rebuildTrayMenu(): void {
  if (!tray) return
  const gen = ++menuGen
  void listThemes()
    .catch(() => [])
    .then((themes) => {
      if (gen !== menuGen || !tray || tray.isDestroyed()) return
      const cfg = getConfig()
      const visible = !!win && !win.isDestroyed() && win.isVisible()
      const themeItems: MenuItemConstructorOptions[] = themes.length
        ? themes.map((t) => ({
            label: t.displayName,
            type: 'radio',
            checked: t.name === cfg.theme,
            click: () => setTheme(t.name)
          }))
        : [{ label: '(no themes found)', enabled: false }]
      const template: MenuItemConstructorOptions[] = [
        { label: visible ? 'Hide' : 'Show', click: toggleWindow },
        { type: 'separator' },
        {
          label: 'Always on top',
          type: 'checkbox',
          checked: cfg.alwaysOnTop,
          click: (item) => setAlwaysOnTop(item.checked)
        },
        {
          label: 'Overlay mode',
          type: 'checkbox',
          checked: cfg.overlay,
          accelerator: OVERLAY_SHORTCUT,
          click: (item) => void setOverlay(item.checked)
        },
        { label: 'Theme', submenu: themeItems },
        { type: 'separator' },
        { label: 'Copy token', click: () => clipboard.writeText(getConfig().token) },
        { label: 'Regenerate token…', click: () => void confirmRegenerate() },
        { label: 'Open config folder', click: () => void shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: serverStatus, enabled: false },
        { label: 'Quit', click: () => app.quit() }
      ]
      tray.setContextMenu(Menu.buildFromTemplate(template))
    })
}

async function confirmRegenerate(): Promise<void> {
  const opts = {
    type: 'warning' as const,
    buttons: ['Regenerate', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Regenerate token',
    message: 'Generate a new ingest token?',
    detail: 'Hooks and scripts using the old token will be rejected until they read the new one from config.json.'
  }
  const visible = win && !win.isDestroyed() && win.isVisible()
  const { response } = visible ? await dialog.showMessageBox(win!, opts) : await dialog.showMessageBox(opts)
  if (response === 0) {
    regenerateToken() // the server reads the token per request, so this applies immediately
    console.log('[agent-office] token regenerated')
  }
}
