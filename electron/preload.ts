// Sandboxed preload (built as CJS). Exposes a narrow, typed bridge; no raw ipcRenderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent } from '../shared/events'
import { IPC, type AgentOfficeBridge, type RendererSettings } from '../shared/ipc'
import type { PermissionRequestInfo, SessionInfo } from '../shared/sessions'

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

  sessions: {
    providers: () => ipcRenderer.invoke(IPC.listProviders),
    list: () => ipcRenderer.invoke(IPC.listSessions),
    start: (req) => ipcRenderer.invoke(IPC.startSession, req),
    stop: (id) => ipcRenderer.invoke(IPC.stopSession, id),
    interrupt: (id) => ipcRenderer.invoke(IPC.interruptSession, id),
    pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
    onChanged: (cb) => subscribe<SessionInfo[]>(IPC.sessionsChanged, cb)
  },

  terminal: {
    attach: (id) => ipcRenderer.invoke(IPC.termAttach, id),
    detach: (id) => ipcRenderer.send(IPC.termDetach, id),
    write: (id, data) => ipcRenderer.send(IPC.termWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.termResize, id, cols, rows),
    ack: (id, chars) => ipcRenderer.send(IPC.termAck, id, chars),
    onData: (cb) => subscribe<{ id: string; data: string }>(IPC.termData, (m) => cb(m.id, m.data))
  },

  permissions: {
    list: () => ipcRenderer.invoke(IPC.listPermissions),
    decide: (id, decision) => ipcRenderer.invoke(IPC.decidePermission, id, decision),
    onChanged: (cb) => subscribe<PermissionRequestInfo[]>(IPC.permissionsChanged, cb)
  }
}

contextBridge.exposeInMainWorld('agentOffice', bridge)
