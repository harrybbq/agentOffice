// IPC for hosted sessions, terminals, chats, provider logins, the office board and permissions (channels: shared/ipc.ts).
// Every handler checks that the sender is the app's own window, and the session manager validates
// every argument. This is the ONLY way a permission is approved or an order is sent.
import { dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC } from '../shared/ipc'
import type { SessionManager } from './sessions'

export interface SessionIpcOptions {
  manager: SessionManager
  /** The current main window (it is replaced when overlay mode toggles). */
  getWindow: () => BrowserWindow | null
}

export function registerSessionIpc(opts: SessionIpcOptions): void {
  const { manager, getWindow } = opts
  const ours = (sender: WebContents): boolean => {
    const win = getWindow()
    return !!win && !win.isDestroyed() && sender === win.webContents
  }
  const handle = <R>(channel: string, fn: (...args: unknown[]) => R): void => {
    ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!ours(e.sender)) throw new Error('unauthorised sender')
      return fn(...args)
    })
  }
  const on = (channel: string, fn: (...args: unknown[]) => void): void => {
    ipcMain.on(channel, (e: IpcMainEvent, ...args: unknown[]) => {
      if (ours(e.sender)) fn(...args)
    })
  }

  handle(IPC.listProviders, () => manager.providers())
  handle(IPC.providerLogin, (provider) => manager.login(provider))
  handle(IPC.listSessions, () => manager.list())
  handle(IPC.startSession, (req) => manager.start(req))
  handle(IPC.stopSession, (id) => manager.stop(id))
  handle(IPC.interruptSession, (id) => manager.interrupt(id))
  handle(IPC.sessionHistory, (provider, cwd) => manager.history(provider, cwd))
  // Restore (shared/restore.ts): sleeping rows, the recent list, what to wake on launch.
  handle(IPC.wakeSession, (id) => manager.wake(id))
  handle(IPC.recentSessions, () => manager.recent())
  handle(IPC.reopenRecent, (id) => manager.reopen(id))
  handle(IPC.forgetSession, (id) => manager.forget(id))
  handle(IPC.dismissInterrupted, (id) => manager.dismissInterrupted(id))
  handle(IPC.getRestoreSettings, () => manager.getRestoreSettings())
  handle(IPC.setRestoreSettings, (patch) => manager.setRestoreSettings(patch))
  handle(IPC.getSelectedSession, () => manager.getSelected())
  on(IPC.setSelectedSession, (id) => manager.setSelected(id))
  handle(IPC.pickFolder, async () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the folder to work in',
      properties: ['openDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  handle(IPC.termAttach, (id) => manager.attach(id))
  on(IPC.termDetach, (id) => manager.detach(id))
  on(IPC.termWrite, (id, data) => manager.write(id, data))
  on(IPC.termResize, (id, cols, rows) => manager.resize(id, cols, rows))
  on(IPC.termAck, (id, chars) => manager.ack(id, chars))

  handle(IPC.chatAttach, (id) => manager.chatAttach(id))
  on(IPC.chatDetach, (id) => manager.chatDetach(id))
  handle(IPC.chatSend, (id, text) => manager.chatSend(id, text))

  // The office board panel: read, delete a claim or note, change the switches. Agents write the
  // board through its own HTTP route (boardMcp.ts), never through these.
  handle(IPC.boardGet, () => manager.board())
  handle(IPC.boardDelete, (kind, id) => manager.boardRemove(kind, id))
  handle(IPC.boardSetSettings, (patch) => manager.boardSetSettings(patch))

  handle(IPC.listPermissions, () => manager.listPermissions())
  handle(IPC.decidePermission, (id, decision) => manager.decide(id, decision))
}
