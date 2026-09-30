// Contract between main process and renderer. Preload exposes `window.agentOffice`.
import type { AgentEvent } from './events'
import type { ThemeManifest } from './theme'

export const IPC = {
  /** main -> renderer: one AgentEvent per message */
  event: 'agent-office:event',
  /** main -> renderer: settings changed (theme swap, overlay toggled) */
  settings: 'agent-office:settings',
  /** renderer -> main (invoke) */
  loadTheme: 'agent-office:load-theme',
  listThemes: 'agent-office:list-themes',
  getSettings: 'agent-office:get-settings'
} as const

export interface LoadedTheme {
  manifest: ThemeManifest
  /** Parsed Tiled JSON map. */
  map: unknown
  /** URL prefix for theme assets, served via the `theme://` protocol, e.g. "theme://office/". */
  baseUrl: string
}

export interface ThemeInfo {
  name: string
  displayName: string
}

export interface RendererSettings {
  theme: string
  overlay: boolean
}

export interface AgentOfficeBridge {
  onEvent(cb: (e: AgentEvent) => void): () => void
  onSettings(cb: (s: RendererSettings) => void): () => void
  getSettings(): Promise<RendererSettings>
  listThemes(): Promise<ThemeInfo[]>
  loadTheme(name: string): Promise<LoadedTheme>
}

declare global {
  interface Window {
    agentOffice: AgentOfficeBridge
  }
}
