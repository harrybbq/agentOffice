// Sandboxed preload (built as CJS). Exposes a narrow, typed bridge; no raw ipcRenderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent } from '../shared/events'
import { IPC, type AgentOfficeBridge, type RendererSettings } from '../shared/ipc'

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
  loadTheme: (name) => ipcRenderer.invoke(IPC.loadTheme, name)
}

contextBridge.exposeInMainWorld('agentOffice', bridge)
