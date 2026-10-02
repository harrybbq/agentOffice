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
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC, type RendererSettings } from '../shared/ipc'
import type { BoardSettings } from '../shared/board'
import { parseAllowOrders } from '../shared/orders'
import { createClaudeCodeHooksAdapter } from './adapters/claude-code-hooks'
import { ClaudeHookObserver } from './adapters/claudeInspect'
import { AgentStats, type InspectorWatch } from './agentStats'
import { Board } from './board'
import { BOARD_MCP_ROUTE, boardMcpRoute } from './boardMcp'
import { EventBus } from './bus'
import { agyProvider, sweepAgySessions, type AgyProvider } from './drivers/agy'
import { createAgyHooksAdapter } from './drivers/agyHookBridge'
import { claudeProvider, sweepSessionFiles } from './drivers/claude'
import { codexProvider, type CodexProvider } from './drivers/codex'
import { isAllowedLoginUrl } from './drivers/codexProtocol'
import { codexEnv } from './drivers/codexServer'
import { SessionTokens } from './ingest/auth'
import { HOST, startIngestServer, type IngestServer } from './ingest/server'
import { ProgressTracker } from './progress'
import { guardPreviewFrames, openInBrowser, registerPreviewIpc } from './preview/ipc'
import { subFrameNavigation } from './preview/guard'
import { PreviewManager } from './preview/manager'
import { PREVIEW_IPC } from '../shared/preview'
import { PtyHostClient } from './ptyClient'
import { windowsBuildNumber } from './ptyProtocol'
import { SessionInbox } from './sessionInbox'
import { SessionManager } from './sessions'
import { SessionStore } from './sessionStore'
import { clampToDisplays, displayKey, rememberWindow, type SavedWindow } from './windowState'
import { registerSessionIpc } from './sessionsIpc'
import { ClaudeTranscripts } from './transcriptUsage'
import { allowWebPermission, isExternalWebUrl } from './webPermissions'
import { isValidThemeName, listThemes, loadTheme, registerThemeProtocol, registerThemeScheme } from './themes'

const HERE = dirname(fileURLToPath(import.meta.url)) // out/main
const PRELOAD = join(HERE, '../preload/index.cjs')
const RENDERER_HTML = join(HERE, '../renderer/index.html')
const PTY_HOST = join(HERE, 'ptyHost.js')
// Run by `node` from a hosted session's SessionStart hook, so it must be a real file on disk.
const SESSION_START_HOOK = app.isPackaged
  ? join(process.resourcesPath, 'hook', 'claude-session-start.cjs')
  : join(HERE, '../../hook/claude-session-start.cjs')
// Copied next to each hosted Antigravity session's hooks.json (and run by `node` from there).
const HOOK_DIR = app.isPackaged ? join(process.resourcesPath, 'hook') : join(HERE, '../../hook')
const AGY_HOOK = join(HOOK_DIR, 'agy-hook.cjs')
const AGY_BOARD_BRIDGE = join(HOOK_DIR, 'agy-board-mcp.cjs')
const DEV_URL = process.env.ELECTRON_RENDERER_URL
const OVERLAY_SHORTCUT = 'CommandOrControl+Shift+O'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let server: IngestServer | null = null
let serverStatus = 'starting…'
let quitting = false
const bus = new EventBus()
/** Session inbox sockets + tokens (memory only; filled by each hosted session's SessionStart hook). */
const inbox = new SessionInbox()
/** Ingest tokens of hosted sessions (memory only). Each only reaches the hooks route, for its session. */
const sessionTokens = new SessionTokens()
/**
 * Board tokens of hosted sessions (memory only): a separate scope that reaches the board's MCP
 * route and nothing else. One per session, replaced on every start/resume, gone when it ends.
 */
const boardTokens = new SessionTokens()
/**
 * Hook tokens of hosted Antigravity sessions (memory only): a third scope that reaches the
 * `/hooks/agy` route and nothing else. That route only takes questions; it never approves.
 */
const agyTokens = new SessionTokens()
/** The office board (electron/board.ts): in memory, fed by the sessions, shown in the board panel. */
const board = new Board({
  settings: () => getConfig().board,
  onChanged: (snapshot) => {
    toRenderer(IPC.boardChanged, snapshot)
    preview?.boardChanged(snapshot) // a session that touched a file: its preview gets a reload hint
  }
})
/** The inspector's watches (one per window); set once the IPC is registered. */
let inspectorWatch: InspectorWatch<number> | null = null
/**
 * Per-agent stats for the inspector panel (electron/agentStats.ts): fed by every world event and by
 * what the drivers know. Read-only: it only ever answers "what is this agent doing?".
 */
const stats = new AgentStats({ onChange: () => inspectorWatch?.poke() })
/** The progress bars (electron/progress.ts): fed by the session manager and by the helpers seen in the world. */
const progress = new ProgressTracker({ onChanged: (snapshot) => toRenderer(IPC.progressChanged, snapshot) })
// The one bus observer: the inspector's stats, then the helpers a manager spawned.
bus.observe((e) => {
  stats.event(e)
  progress.event(e)
})
/** Token usage of Claude sessions, read from their transcripts under ~/.claude/projects when a hook says there is news. */
const transcripts = new ClaudeTranscripts({ onUsage: (agentId, usage, model) => stats.fact({ kind: 'tokens', agentId, usage, model }) })
/** Claims, notes and "ended" rows expire on their own: look every so often, so the panel follows. */
const BOARD_SWEEP_MS = 30_000
let ptyHost: PtyHostClient | null = null
let sessions: SessionManager | null = null
/** The saved session records (`<userData>/sessions.json`): what comes back after a restart. */
let sessionStore: SessionStore | null = null
/** The normal (non-overlay) window's latest position, as it is saved in config.json. */
let lastWindow: SavedWindow | null = null
const WINDOW_MIN = { width: 1000, height: 650 }
const WINDOW_SAVE_DEBOUNCE_MS = 400
/** Owns the shared `codex app-server` child (started on the first Codex need). */
let codex: CodexProvider | null = null
/** Owns the `agy` processes of hosted Antigravity sessions. */
let agy: AgyProvider | null = null
let shutdownDone = false
/** The live preview pane (electron/preview/): per session, the address shown and what the app runs for it. */
let preview: PreviewManager | null = null
/** Loopback ports that are the app itself: never shown in the preview frame. */
function selfPorts(): number[] {
  const ports = server ? [server.port] : [getConfig().port]
  const dev = DEV_URL ? Number(new URL(DEV_URL).port) : 0
  return dev ? [...ports, dev] : ports
}

// ---------- pre-ready ----------

registerThemeScheme()
// Own taskbar identity (icon + grouping) instead of the generic Electron one.
if (process.platform === 'win32') app.setAppUserModelId('com.agent-office.app')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.on('before-quit', (e) => {
    quitting = true
    // Hosted agents must not outlive the app: kill their process trees before we go.
    if (shutdownDone || !ptyHost) return
    e.preventDefault()
    // Freezes and writes the session records first: the sessions killed below stay "open" in the
    // file and come back asleep on the next launch.
    sessions?.close()
    // The pty host takes the terminal sessions down; the manager stops the Codex app-server.
    void Promise.allSettled([ptyHost.shutdown(), sessions?.shutdown(), preview?.shutdown()]).finally(() => {
      shutdownDone = true
      app.quit()
    })
  })
  // If the app dies without a clean quit, the app-server (and the commands it runs) must not stay behind.
  process.on('exit', () => {
    sessionStore?.flush()
    preview?.killSync()
    codex?.server.killSync()
    agy?.cli.killSync()
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

  // The renderer never needs camera/mic/notifications/etc. Only our own window gets the clipboard.
  const ourPage = (wc: Electron.WebContents | null): boolean => !!wc && !!win && !win.isDestroyed() && wc === win.webContents
  // "Our own window" means its own page: a frame inside it (the preview pane) gets nothing.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowWebPermission(perm, ourPage(wc), details.isMainFrame)))
  session.defaultSession.setPermissionCheckHandler((wc, perm, _origin, details) => allowWebPermission(perm, ourPage(wc), details.isMainFrame))

  registerThemeProtocol()
  createSessions()
  registerIpc()
  createTray()
  createWindow()

  try {
    server = await startIngestServer({
      port: getConfig().port,
      getToken: () => getConfig().token,
      sink: bus,
      sessionTokens,
      // Sessions the app did not start are observed too (turns, workers' tasks, files, token usage).
      claudeHooks: createClaudeCodeHooksAdapter(
        sessions ?? undefined,
        (rootId) => new ClaudeHookObserver({ rootId, emit: (fact) => stats.fact(fact), transcripts, managerTask: true })
      ),
      board: { route: boardMcpRoute(board), tokens: boardTokens },
      agy: { adapter: createAgyHooksAdapter(() => sessions), tokens: agyTokens }
    })
    setInterval(() => board.sweep(), BOARD_SWEEP_MS).unref()
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

  // Sessions can report back now: wake what the restore mode says (the others stay asleep).
  void sessions?.restoreOnLaunch()

  if (!globalShortcut.register(OVERLAY_SHORTCUT, () => void setOverlay(!getConfig().overlay))) {
    console.warn(`[agent-office] could not register ${OVERLAY_SHORTCUT}`)
  }
}

// ---------- IPC ----------

function rendererSettings(): RendererSettings {
  const c = getConfig()
  return {
    theme: c.theme,
    overlay: c.overlay,
    allowOrders: c.allowOrders,
    officeWideTimeoutMs: c.officeWideMinutes * 60_000,
    windowsBuild: windowsBuildNumber(process.platform, release())
  }
}

/** Sends to the current window, if it can listen. `win` is replaced when overlay mode toggles. */
function toRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

/** Hosted sessions: the pty host, the provider table and the manager that the IPC handlers call. */
function createSessions(): void {
  const sessionsDir = join(app.getPath('userData'), 'sessions')
  sweepSessionFiles(sessionsDir) // leftovers of a crash; the single-instance lock means nobody uses them
  const host = new PtyHostClient(
    PTY_HOST,
    (id, data) => sessions?.terminalData(id, data),
    (id, urls) => preview?.observeAddresses(id, urls, 'terminal')
  )
  ptyHost = host
  // Development only: AGENT_OFFICE_CODEX_SPAWN=<script> runs that script with `node` in place of
  // `codex app-server` (tests/fixtures/fake-codex-server.cjs), to drive the real UI without a model.
  const fakeCodex = app.isPackaged ? undefined : process.env.AGENT_OFFICE_CODEX_SPAWN
  codex = codexProvider({
    server: {
      clientVersion: app.getVersion(),
      ...(fakeCodex ? { resolveSpawn: () => ({ file: 'node', args: [fakeCodex], env: codexEnv(process.env, null) }) } : {})
    },
    ...(fakeCodex ? { findExecutable: () => 'node', version: async () => 'fake' } : {}),
    // The driver only passes a login URL it validated; check again at the door.
    openExternal: async (url) => {
      if (!isAllowedLoginUrl(url)) throw new Error('refusing to open that address')
      await shell.openExternal(url)
    }
  })
  // Antigravity: one folder per live session under userData (hooks.json + the hook script), never
  // in the user's project and never in ~/.gemini.
  const agySessionsDir = join(app.getPath('userData'), 'agy-sessions')
  sweepAgySessions(agySessionsDir)
  // Development only: AGENT_OFFICE_AGY_SPAWN=<script> runs that script with `node` in place of
  // `agy` (tests/fixtures/fake-agy.cjs), to drive the real UI without a model or any quota.
  const fakeAgy = app.isPackaged ? undefined : process.env.AGENT_OFFICE_AGY_SPAWN
  agy = agyProvider({
    sessionsDir: agySessionsDir,
    // No session may read or change the app's own data (config.json holds the ingest token).
    protectedPaths: [app.getPath('userData')],
    hookScript: AGY_HOOK,
    boardScript: AGY_BOARD_BRIDGE,
    ingest: { baseUrl: () => (server ? `http://${HOST}:${server.port}` : null), tokens: agyTokens },
    // A prompt sent while a turn runs waits for the next turn. AGENT_OFFICE_AGY_STEER=inject hands
    // it into the running turn instead (seen working once with the real agy; see the README).
    ...(process.env.AGENT_OFFICE_AGY_STEER === 'inject' ? { steer: 'inject' as const } : {}),
    ...(fakeAgy ? { cli: { findExecutable: () => 'node', resolveSpawn: (_exe: string, args: string[]) => ({ file: 'node', args: [fakeAgy, ...args] }) } } : {})
  })
  sessionStore = new SessionStore({ file: join(app.getPath('userData'), 'sessions.json') })
  sessions = new SessionManager({
    restore: {
      store: sessionStore,
      settings: () => getConfig().restore,
      saveSettings: (patch) => saveConfig({ restore: { ...getConfig().restore, ...patch } }).restore
    },
    pty: host,
    sink: bus,
    providers: [
      claudeProvider({
        sessionsDir,
        hookScript: SESSION_START_HOOK,
        inbox,
        transcripts,
        ingest: { baseUrl: () => (server ? `http://${HOST}:${server.port}` : null), tokens: sessionTokens }
      }),
      codex,
      agy
    ],
    allowOrders: () => getConfig().allowOrders,
    worldTopLevel: () => bus.topLevel(),
    onSessionsChanged: (list) => {
      toRenderer(IPC.sessionsChanged, list)
      // A preview ends with its session.
      preview?.sessionsChanged(new Set(list.filter((s) => s.state !== 'asleep' && s.state !== 'exited').map((s) => s.id)))
    },
    onChatTap: (e) => preview?.observeChat(e),
    onPermissionsChanged: (pending) => toRenderer(IPC.permissionsChanged, pending),
    onTerminalData: (id, data) => toRenderer(IPC.termData, { id, data }),
    onChatEvent: (e) => toRenderer(IPC.chatEvent, e),
    onProvidersChanged: (list) => toRenderer(IPC.providersChanged, list),
    stats,
    progress,
    board: {
      model: board,
      endpoint: { url: () => (server ? `http://${HOST}:${server.port}${BOARD_MCP_ROUTE}` : null), tokens: boardTokens },
      saveSettings: (patch) => setBoardSettings(patch)
    }
  })
  const manager = sessions
  preview = new PreviewManager({
    session: (id) => {
      const s = manager.list().find((x) => x.id === id)
      return s && s.state !== 'asleep' && s.state !== 'exited' ? { id: s.id, cwd: s.cwd } : undefined
    },
    onChanged: (info) => toRenderer(PREVIEW_IPC.changed, info),
    onReload: (id) => toRenderer(PREVIEW_IPC.reload, id),
    onDetected: (id) => toRenderer(PREVIEW_IPC.detected, id),
    selfPorts
  })
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
  ipcMain.handle(IPC.sendOrder, guard((req: unknown) => sessions!.sendOrder(req)))
  // The in-app switch for the tray's "Allow CEO orders": same setter, so the tray stays in step.
  ipcMain.handle(
    IPC.setAllowOrders,
    guard((value: unknown) => {
      const on = parseAllowOrders(value)
      if (on === null) throw new Error('invalid value: expected true or false')
      setAllowOrders(on)
      return rendererSettings()
    })
  )
  // The in-app Quit: the same path as the tray's (before-quit stops the hosted sessions first).
  ipcMain.handle(
    IPC.quit,
    guard(() => {
      setImmediate(() => app.quit())
    })
  )
  // A link in a chat answer. Only plain web addresses leave the app; the renderer learns whether it did.
  ipcMain.handle(
    IPC.openExternal,
    guard((url: unknown) => {
      if (!isExternalWebUrl(url)) return false
      void shell.openExternal(url).catch(() => {})
      return true
    })
  )
  inspectorWatch = registerSessionIpc({ manager: sessions!, getWindow: () => win }).inspector
  registerPreviewIpc({ manager: preview!, getWindow: () => win })
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

/** The window as it was saved for the displays that are connected now, moved onto one of them if need be. */
function savedWindow(): SavedWindow | null {
  const displays = screen.getAllDisplays()
  const saved = getConfig().window[displayKey(displays)]
  if (!saved) return null
  const bounds = clampToDisplays(saved.bounds, displays.map((d) => d.workArea), WINDOW_MIN)
  return bounds ? { bounds, maximized: saved.maximized } : null
}

/** Remembers where the normal window is (never the overlay: it is a different kind of window). */
function saveWindowState(w: BrowserWindow): void {
  if (w !== win || w.isDestroyed() || getConfig().overlay || w.isMinimized() || w.isFullScreen()) return
  const next: SavedWindow = { bounds: w.getNormalBounds(), maximized: w.isMaximized() }
  if (JSON.stringify(next) === JSON.stringify(lastWindow)) return
  lastWindow = next
  try {
    saveConfig({ window: rememberWindow(getConfig().window, displayKey(screen.getAllDisplays()), next) })
  } catch (err) {
    console.warn('[agent-office] could not save the window position:', err instanceof Error ? err.message : err)
  }
}

function trackWindowState(w: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      saveWindowState(w)
    }, WINDOW_SAVE_DEBOUNCE_MS)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) w.on(event as 'resize', later)
  w.on('close', () => {
    if (timer) clearTimeout(timer)
    timer = null
    saveWindowState(w)
  })
}

function createWindow(): void {
  const cfg = getConfig()
  const overlay = cfg.overlay
  // First window of this run: where it was last time. A replaced window (overlay toggled): where it is.
  if (!win && !lastWindow) lastWindow = savedWindow()
  const current = win && !win.isDestroyed() ? win.getBounds() : null
  const maximize = !overlay && !!lastWindow?.maximized
  // A window that will be maximised starts from its normal bounds, so "restore" has somewhere to go back to.
  const prev = (maximize ? lastWindow?.bounds : null) ?? current ?? lastWindow?.bounds ?? null

  const w = new BrowserWindow({
    width: prev?.width ?? 1440,
    height: prev?.height ?? 900,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    x: prev?.x,
    y: prev?.y,
    title: 'Agent Office',
    icon: assetIcon('icon.png') ?? undefined,
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

  // Never open app windows. Links in chat answers go through IPC.openExternal; a stray
  // window.open of a plain web address still ends up in the system browser, never in a window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    // (At most one every few seconds: the page in the preview frame can call window.open as well.)
    if (isExternalWebUrl(url)) openInBrowser(url, 'window.open')
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedUrl(url)) e.preventDefault()
  })
  w.webContents.on('will-redirect', (e, url) => {
    // The window's own page stays where it is; a frame inside it (the preview) only goes to loopback pages.
    if (e.isMainFrame ? !isAllowedUrl(url) : subFrameNavigation(url, selfPorts()) !== 'allow') e.preventDefault()
  })
  guardPreviewFrames(w.webContents, { manager: () => preview, selfPorts, onBlocked: (b) => toRenderer(PREVIEW_IPC.blocked, b) })
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())

  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      w.hide()
      rebuildTrayMenu()
    }
  })
  // Windows is shutting down or the user is logging off: the system is about to kill the agents.
  // Freeze and write the session records first, so they come back asleep instead of counting as ended.
  w.on('session-end', () => sessions?.close())
  w.on('show', rebuildTrayMenu)
  w.on('hide', rebuildTrayMenu)
  // AGENT_OFFICE_SHOW_INACTIVE=1 (testing): appear without taking focus.
  w.once('ready-to-show', () => {
    // maximize() also shows the window, without giving it focus.
    if (maximize) w.maximize()
    if (process.env.AGENT_OFFICE_SHOW_INACTIVE === '1') w.showInactive()
    else w.show()
  })
  if (!overlay) trackWindowState(w)

  bus.attach(w.webContents)
  // A (re)loading or replaced renderer has lost its terminals, chats and inspector: stop streaming until it attaches again.
  sessions?.detachAll()
  inspectorWatch?.clear()
  // (Only the window's own page: the preview frame loading a page is not a reload of the renderer.)
  w.webContents.on('did-start-navigation', (e) => {
    if (win === w && e.isMainFrame && !e.isSameDocument) {
      sessions?.detachAll()
      inspectorWatch?.clear()
    }
  })
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
    // AGENT_OFFICE_SHOW_INACTIVE=1 (testing): come back without taking focus.
    if (process.env.AGENT_OFFICE_SHOW_INACTIVE === '1') win.showInactive()
    else {
      win.show()
      win.focus()
    }
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

function setAllowOrders(on: boolean): void {
  saveConfig({ allowOrders: on })
  pushSettings()
  rebuildTrayMenu()
}

/**
 * The office board's switches (the panel and the tray both end up here). Stored in config.json;
 * live sessions follow at once because the board reads the settings on every use.
 */
function setBoardSettings(patch: Partial<BoardSettings>): BoardSettings {
  const next = saveConfig({ board: { ...getConfig().board, ...patch } }).board
  toRenderer(IPC.boardSettingsChanged, next)
  toRenderer(IPC.boardChanged, board.snapshot())
  rebuildTrayMenu()
  return next
}

function setTheme(name: string): void {
  if (!isValidThemeName(name) || name === getConfig().theme) return
  saveConfig({ theme: name })
  pushSettings()
  rebuildTrayMenu()
}

// ---------- tray ----------

/** Loads an icon from assets/ (generated by scripts/gen-logo.cjs + render-icons.cjs); null if missing. */
function assetIcon(name: string): Electron.NativeImage | null {
  const img = nativeImage.createFromPath(join(app.getAppPath(), 'assets', name))
  return img.isEmpty() ? null : img
}

/** Tray icon: the logo, or a 16x16 fallback drawn in code (BGRA, Skia's native order). */
function trayIcon(): Electron.NativeImage {
  const logo = assetIcon('icon-16.png')
  if (logo) {
    // Sharper on scaled displays: the simplified 24 px drawing at 1.5x.
    const hi = assetIcon('icon-24.png')
    if (hi) logo.addRepresentation({ scaleFactor: 1.5, width: 24, height: 24, buffer: hi.toPNG() })
    return logo
  }
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
        {
          label: 'Allow CEO orders',
          type: 'checkbox',
          checked: cfg.allowOrders,
          click: (item) => setAllowOrders(item.checked)
        },
        {
          label: 'Office board (teams see each other)',
          type: 'checkbox',
          checked: cfg.board.enabled,
          click: (item) => void setBoardSettings({ enabled: item.checked })
        },
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
