// Sandboxed preload (built as CJS). Exposes a narrow, typed bridge; no raw ipcRenderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent } from '../shared/events'
import { IPC, type AgentOfficeBridge, type RendererSettings } from '../shared/ipc'
import type { BoardSettings, BoardSnapshot } from '../shared/board'
import type { ChatEvent } from '../shared/chat'
import type { AgentDetails } from '../shared/inspector'
import type { ProgressSnapshot } from '../shared/progress'
import { PREVIEW_IPC, type PreviewBlocked, type PreviewInfo } from '../shared/preview'
import type { PermissionRequestInfo, ProviderInfo, SessionInfo } from '../shared/sessions'
import type { AutoAllowed, HeldRequest } from '../shared/approvals'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_evt: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: AgentOfficeBridge = {
  onEvent: (cb) => subscribe<AgentEvent>(IPC.event, cb),
  onSettings: (cb) => subscribe<RendererSettings>(IPC.settings, cb),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  listThemes: () => ipcRenderer.invoke(IPC.listThemes),
  loadTheme: (name) => ipcRenderer.invoke(IPC.loadTheme, name),
  sendOrder: (req) => ipcRenderer.invoke(IPC.sendOrder, req),
  setAllowOrders: (value) => ipcRenderer.invoke(IPC.setAllowOrders, value),
  setApprovalMode: (mode) => ipcRenderer.invoke(IPC.setApprovalMode, mode),
  quit: () => ipcRenderer.invoke(IPC.quit),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),

  sessions: {
    providers: () => ipcRenderer.invoke(IPC.listProviders),
    onProvidersChanged: (cb) => subscribe<ProviderInfo[]>(IPC.providersChanged, cb),
    login: (provider) => ipcRenderer.invoke(IPC.providerLogin, provider),
    list: () => ipcRenderer.invoke(IPC.listSessions),
    start: (req) => ipcRenderer.invoke(IPC.startSession, req),
    stop: (id) => ipcRenderer.invoke(IPC.stopSession, id),
    interrupt: (id) => ipcRenderer.invoke(IPC.interruptSession, id),
    pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
    history: (provider, cwd) => ipcRenderer.invoke(IPC.sessionHistory, provider, cwd),
    onChanged: (cb) => subscribe<SessionInfo[]>(IPC.sessionsChanged, cb),
    wake: (id) => ipcRenderer.invoke(IPC.wakeSession, id),
    recent: () => ipcRenderer.invoke(IPC.recentSessions),
    reopen: (id) => ipcRenderer.invoke(IPC.reopenRecent, id),
    forget: (id) => ipcRenderer.invoke(IPC.forgetSession, id),
    dismissInterrupted: (id) => ipcRenderer.invoke(IPC.dismissInterrupted, id),
    getRestoreSettings: () => ipcRenderer.invoke(IPC.getRestoreSettings),
    setRestoreSettings: (patch) => ipcRenderer.invoke(IPC.setRestoreSettings, patch),
    setSelected: (id) => ipcRenderer.send(IPC.setSelectedSession, id),
    getSelected: () => ipcRenderer.invoke(IPC.getSelectedSession)
  },

  terminal: {
    attach: (id) => ipcRenderer.invoke(IPC.termAttach, id),
    detach: (id) => ipcRenderer.send(IPC.termDetach, id),
    write: (id, data) => ipcRenderer.send(IPC.termWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.termResize, id, cols, rows),
    ack: (id, chars) => ipcRenderer.send(IPC.termAck, id, chars),
    onData: (cb) => subscribe<{ id: string; data: string }>(IPC.termData, (m) => cb(m.id, m.data))
  },

  chat: {
    attach: (id) => ipcRenderer.invoke(IPC.chatAttach, id),
    detach: (id) => ipcRenderer.send(IPC.chatDetach, id),
    send: (id, text) => ipcRenderer.invoke(IPC.chatSend, id, text),
    onEvent: (cb) => subscribe<ChatEvent>(IPC.chatEvent, cb)
  },

  board: {
    get: () => ipcRenderer.invoke(IPC.boardGet),
    remove: (kind, id) => ipcRenderer.invoke(IPC.boardDelete, kind, id),
    setSettings: (patch) => ipcRenderer.invoke(IPC.boardSetSettings, patch),
    onChanged: (cb) => subscribe<BoardSnapshot>(IPC.boardChanged, cb),
    onSettingsChanged: (cb) => subscribe<BoardSettings>(IPC.boardSettingsChanged, cb)
  },

  inspector: {
    watch: (agentId) => ipcRenderer.invoke(IPC.inspectWatch, agentId),
    unwatch: () => ipcRenderer.send(IPC.inspectUnwatch),
    onChanged: (cb) => subscribe<AgentDetails>(IPC.inspectChanged, cb)
  },

  permissions: {
    list: () => ipcRenderer.invoke(IPC.listPermissions),
    decide: (id, decision) => ipcRenderer.invoke(IPC.decidePermission, id, decision),
    onChanged: (cb) => subscribe<PermissionRequestInfo[]>(IPC.permissionsChanged, cb),
    recentAuto: () => ipcRenderer.invoke(IPC.recentAutoAllowed),
    onAuto: (cb) => subscribe<AutoAllowed>(IPC.autoAllowed, cb),
    held: () => ipcRenderer.invoke(IPC.heldList),
    onHeld: (cb) => subscribe<HeldRequest[]>(IPC.heldChanged, cb),
    approveHeld: (id) => ipcRenderer.invoke(IPC.heldApprove, id),
    dismissHeld: (id) => ipcRenderer.invoke(IPC.heldDismiss, id)
  },

  progress: {
    get: () => ipcRenderer.invoke(IPC.progressGet),
    onChanged: (cb) => subscribe<ProgressSnapshot>(IPC.progressChanged, cb),
    dismissOrder: (id) => ipcRenderer.invoke(IPC.progressDismissOrder, id)
  },
  // The live preview pane (shared/preview.ts). The main process validates every argument.
  preview: {
    get: (id) => ipcRenderer.invoke(PREVIEW_IPC.get, id),
    suggestions: (id) => ipcRenderer.invoke(PREVIEW_IPC.suggestions, id),
    open: (id, url) => ipcRenderer.invoke(PREVIEW_IPC.open, id, url),
    staticEntries: (id) => ipcRenderer.invoke(PREVIEW_IPC.staticEntries, id),
    serveFolder: (id, entry) => ipcRenderer.invoke(PREVIEW_IPC.serveFolder, id, entry),
    scripts: (id) => ipcRenderer.invoke(PREVIEW_IPC.scripts, id),
    run: (id, name) => ipcRenderer.invoke(PREVIEW_IPC.run, id, name),
    log: (id) => ipcRenderer.invoke(PREVIEW_IPC.log, id),
    stop: (id) => ipcRenderer.invoke(PREVIEW_IPC.stop, id),
    onChanged: (cb) => subscribe<PreviewInfo>(PREVIEW_IPC.changed, cb),
    onReload: (cb) => subscribe<string>(PREVIEW_IPC.reload, cb),
    onDetected: (cb) => subscribe<string>(PREVIEW_IPC.detected, cb),
    onBlocked: (cb) => subscribe<PreviewBlocked>(PREVIEW_IPC.blocked, cb)
  }
}

contextBridge.exposeInMainWorld('agentOffice', bridge)
