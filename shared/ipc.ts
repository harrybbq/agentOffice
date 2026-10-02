// Contract between main process and renderer. Preload exposes `window.agentOffice`.
import type { AgentEvent } from './events'
import type { ThemeManifest } from './theme'
import type { OrderRequest, OrderResult } from './orders'
import type {
  PermissionDecision,
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderInfo,
  SessionInfo,
  StartSessionRequest,
  TerminalSnapshot
} from './sessions'

export const IPC = {
  /** main -> renderer: one AgentEvent per message */
  event: 'agent-office:event',
  /** main -> renderer: settings changed (theme swap, overlay toggled) */
  settings: 'agent-office:settings',
  /** renderer -> main (invoke) */
  loadTheme: 'agent-office:load-theme',
  listThemes: 'agent-office:list-themes',
  getSettings: 'agent-office:get-settings',
  /** renderer -> main (invoke): CEO order from the speech bar -> session inbox socket(s). */
  sendOrder: 'agent-office:send-order',

  // ---- hosted sessions (shared/sessions.ts) ----
  /** invoke */
  listProviders: 'agent-office:providers',
  listSessions: 'agent-office:sessions:list',
  startSession: 'agent-office:sessions:start',
  stopSession: 'agent-office:sessions:stop',
  interruptSession: 'agent-office:sessions:interrupt',
  pickFolder: 'agent-office:pick-folder',
  /** main -> renderer: full SessionInfo[] whenever anything changes */
  sessionsChanged: 'agent-office:sessions:changed',

  // ---- terminal ----
  /** invoke: returns TerminalSnapshot and starts streaming termData for that session to the caller */
  termAttach: 'agent-office:term:attach',
  /** send (no reply) */
  termDetach: 'agent-office:term:detach',
  termWrite: 'agent-office:term:write',
  termResize: 'agent-office:term:resize',
  termAck: 'agent-office:term:ack',
  /** main -> renderer: { id, data } */
  termData: 'agent-office:term:data',

  // ---- permissions ----
  /** invoke */
  listPermissions: 'agent-office:permissions:list',
  decidePermission: 'agent-office:permissions:decide',
  /** main -> renderer: full PermissionRequestInfo[] of pending requests */
  permissionsChanged: 'agent-office:permissions:changed'
} as const

export interface LoadedTheme {
  manifest: ThemeManifest
  /** Parsed Tiled JSON maps. */
  hq: unknown
  branch: unknown
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
  /** Tray "Allow CEO orders" (off by default: the app starts read-only). */
  allowOrders: boolean
  /** Office-wide mode ends after this long at the latest. */
  officeWideTimeoutMs: number
}

export interface AgentOfficeBridge {
  onEvent(cb: (e: AgentEvent) => void): () => void
  onSettings(cb: (s: RendererSettings) => void): () => void
  getSettings(): Promise<RendererSettings>
  listThemes(): Promise<ThemeInfo[]>
  loadTheme(name: string): Promise<LoadedTheme>
  sendOrder(req: OrderRequest): Promise<OrderResult>

  sessions: {
    providers(): Promise<ProviderInfo[]>
    list(): Promise<SessionInfo[]>
    /** Rejects with a readable message if the folder is invalid or the provider unavailable. */
    start(req: StartSessionRequest): Promise<SessionInfo>
    /** Ask the CLI to exit; kills the process tree if it doesn't. */
    stop(id: string): Promise<void>
    /** Interrupt the running turn (Esc for Claude Code). */
    interrupt(id: string): Promise<void>
    /** Native folder picker; null if cancelled. */
    pickFolder(): Promise<string | null>
    onChanged(cb: (sessions: SessionInfo[]) => void): () => void
  }

  terminal: {
    attach(id: string): Promise<TerminalSnapshot>
    detach(id: string): void
    /** Keystrokes typed in the pane. */
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    /** Flow control: call after rendering every TERM_ACK_CHARS chars. */
    ack(id: string, chars: number): void
    onData(cb: (id: string, data: string) => void): () => void
  }

  permissions: {
    list(): Promise<PermissionRequestInfo[]>
    decide(id: string, decision: PermissionDecision): Promise<PermissionOutcome>
    onChanged(cb: (pending: PermissionRequestInfo[]) => void): () => void
  }
}

declare global {
  interface Window {
    agentOffice: AgentOfficeBridge
  }
}
