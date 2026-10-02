// Electron glue for the preview: the IPC handlers (channels: shared/preview.ts) and the rules for
// frames inside the app's window. Everything the renderer sends is validated by the PreviewManager;
// here only the sender is checked: the app's own window, and its main frame (never the previewed page).
import { ipcMain, shell, webFrameMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { PREVIEW_IPC, type PreviewBlocked } from '../../shared/preview'
import { isExternalWebUrl } from '../webPermissions'
import { ERR_ABORTED, ERR_BLOCKED_BY_CSP, ERR_BLOCKED_BY_RESPONSE, ExternalGate, subFrameNavigation } from './guard'
import type { PreviewManager } from './manager'

export interface PreviewIpcOptions {
  manager: PreviewManager
  /** The current main window (it is replaced when overlay mode toggles). */
  getWindow: () => BrowserWindow | null
}

export function registerPreviewIpc(opts: PreviewIpcOptions): void {
  const { manager, getWindow } = opts
  const handle = <R>(channel: string, fn: (...args: unknown[]) => R): void => {
    ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      const win = getWindow()
      if (!win || win.isDestroyed() || e.sender !== win.webContents) throw new Error('unauthorised sender')
      // The preload is not loaded into sub-frames; this is the second lock on the same door.
      if (e.senderFrame !== win.webContents.mainFrame) throw new Error('unauthorised sender')
      return fn(...args)
    })
  }
  handle(PREVIEW_IPC.get, (id) => manager.get(id))
  handle(PREVIEW_IPC.suggestions, (id) => manager.suggestions(id))
  handle(PREVIEW_IPC.open, (id, url) => manager.open(id, url))
  handle(PREVIEW_IPC.staticEntries, (id) => manager.staticEntries(id))
  handle(PREVIEW_IPC.serveFolder, (id, entry) => manager.serveFolder(id, entry))
  handle(PREVIEW_IPC.scripts, (id) => manager.scripts(id))
  handle(PREVIEW_IPC.run, (id, name) => manager.run(id, name))
  handle(PREVIEW_IPC.log, (id) => manager.log(id))
  handle(PREVIEW_IPC.stop, (id) => manager.stop(id))
}

// ---- pages that want out ---------------------------------------------------------------------------

/** One gate for everything a page in the window sends to the system browser by itself. */
const gate = new ExternalGate()
/** Testing (AGENT_OFFICE_PREVIEW_NO_BROWSER=1): log what would open in the browser instead of opening it. */
const dryRun = (): boolean => process.env.AGENT_OFFICE_PREVIEW_NO_BROWSER === '1'

/**
 * Hands a plain web address to the system browser, at most one every few seconds: a link followed
 * in the preview frame, or a window.open of any page in the window. (A link in a chat answer goes
 * through IPC.openExternal, a click of the user, and is not limited.) Returns whether it was opened.
 */
export function openInBrowser(url: string, why: string): boolean {
  const open = isExternalWebUrl(url) && gate.allow()
  console.log(`[agent-office] ${why}: ${open ? 'opened in the browser' : 'not opened'}${dryRun() ? ' (dry run)' : ''}: ${url.slice(0, 200)}`)
  if (open && !dryRun()) void shell.openExternal(url).catch(() => {})
  return open
}

export interface FrameGuardOptions {
  manager: () => PreviewManager | null
  /** Loopback ports that are the app itself. */
  selfPorts: () => number[]
  /** The preview frame was stopped from leaving: the pane puts it back on its page. */
  onBlocked: (blocked: PreviewBlocked) => void
}

/**
 * The rules for every frame of the window that is not its own page: only loopback pages load.
 * Two locks: the page's content security policy (`frame-src`, src/index.html) stops everything that
 * is not http(s) on localhost / 127.0.0.1 before the request is made; the handlers here stop the
 * loopback addresses that are the app itself, tell the pane when its frame was stopped (a link to a
 * web site is opened in the system browser instead), and report where the frame is and when a
 * page failed to load.
 */
export function guardPreviewFrames(wc: WebContents, opts: FrameGuardOptions): void {
  /** Is that frame the preview frame itself (directly under the window's page), not one a page embeds? */
  const isPreviewFrame = (processId: number, routingId: number): boolean => {
    try {
      const frame = webFrameMain.fromId(processId, routingId)
      return !frame || frame.parent === wc.mainFrame
    } catch {
      return true
    }
  }
  const stopped = (url: string, top: boolean, why: string): void => {
    const verdict = subFrameNavigation(url, opts.selfPorts())
    const opened = top && verdict === 'external' && openInBrowser(url, why)
    if (!opened) console.log(`[agent-office] ${why}: blocked: ${url.slice(0, 200)}`)
    if (top) opts.onBlocked({ url: url.slice(0, 2048), opened })
  }

  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return // main.ts: will-navigate
    if (subFrameNavigation(e.url, opts.selfPorts()) === 'allow') return
    e.preventDefault()
    stopped(e.url, e.frame?.parent === wc.mainFrame, 'preview frame navigation cancelled')
  })
  wc.on('did-frame-navigate', (_e, url, _code, _status, isMainFrame, processId, routingId) => {
    if (!isMainFrame && isPreviewFrame(processId, routingId)) opts.manager()?.frameNavigated(url)
  })
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame, processId, routingId) => {
    if (isMainFrame || code === ERR_ABORTED) return
    // The content security policy stopped the frame from leaving for a page that is not on this computer.
    if (code === ERR_BLOCKED_BY_CSP) return stopped(url, isPreviewFrame(processId, routingId), 'preview frame navigation stopped by the content security policy')
    if (isPreviewFrame(processId, routingId)) opts.manager()?.frameFailed(url, code === ERR_BLOCKED_BY_RESPONSE)
  })
}
