// Contract between main process and renderer. Preload exposes `window.agentOffice`.
import type { AgentEvent } from './events'
import type { ThemeManifest } from './theme'
import type { OrderRequest, OrderResult } from './orders'
import type { BoardSettings, BoardSnapshot } from './board'
import type { ChatEvent, ChatItem } from './chat'
import type {
  PermissionDecision,
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderId,
  ProviderInfo,
  SessionHistoryEntry,
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
  /** renderer -> main (invoke): the "Allow CEO orders" switch (also in the tray). Returns the new settings. */
  setAllowOrders: 'agent-office:set-allow-orders',
  /** renderer -> main (invoke): quit the app (closing the window only hides it to the tray). */
  quit: 'agent-office:quit',
  /** renderer -> main (invoke): open an http(s) link of a chat answer in the system browser. */
  openExternal: 'agent-office:open-external',

  // ---- hosted sessions (shared/sessions.ts) ----
  /** invoke */
  listProviders: 'agent-office:providers',
  listSessions: 'agent-office:sessions:list',
  startSession: 'agent-office:sessions:start',
  stopSession: 'agent-office:sessions:stop',
  interruptSession: 'agent-office:sessions:interrupt',
  pickFolder: 'agent-office:pick-folder',
  /** invoke: earlier conversations of a provider in a folder (for "Resume previous…") */
  sessionHistory: 'agent-office:sessions:history',
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

  // ---- chat (sessions with surface 'chat') ----
  /** invoke: returns the current ChatItem[] and starts streaming chatEvent for that session to the caller */
  chatAttach: 'agent-office:chat:attach',
  /** send (no reply) */
  chatDetach: 'agent-office:chat:detach',
  /** invoke: the user typed a prompt in the chat box (starts a turn, or steers the running one) */
  chatSend: 'agent-office:chat:send',
  /** main -> renderer: one ChatEvent */
  chatEvent: 'agent-office:chat:event',
  /** invoke: start the provider's own login flow (opens the system browser) */
  providerLogin: 'agent-office:providers:login',
  /** main -> renderer: ProviderInfo[] changed (login state, usage) */
  providersChanged: 'agent-office:providers:changed',

  // ---- office board (shared/board.ts) ----
  /** invoke */
  boardGet: 'agent-office:board:get',
  /** invoke: delete one claim or note by id (the user cleaning up) */
  boardDelete: 'agent-office:board:delete',
  /** invoke: BoardSettings patch -> BoardSettings */
  boardSetSettings: 'agent-office:board:settings',
  /** main -> renderer: full BoardSnapshot (coalesced) */
  boardChanged: 'agent-office:board:changed',
  /** main -> renderer: the BoardSettings that now apply (changed from the panel or the tray) */
  boardSettingsChanged: 'agent-office:board:settings-changed',

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
  /** Tray "Allow CEO orders" (on by default; untick to make the app watch-only). */
  allowOrders: boolean
  /** Office-wide mode ends after this long at the latest. */
  officeWideTimeoutMs: number
  /** The Windows build number (e.g. 26200) for xterm's ConPTY handling; 0 on other platforms. */
  windowsBuild: number
}

export interface AgentOfficeBridge {
  onEvent(cb: (e: AgentEvent) => void): () => void
  onSettings(cb: (s: RendererSettings) => void): () => void
  getSettings(): Promise<RendererSettings>
  listThemes(): Promise<ThemeInfo[]>
  loadTheme(name: string): Promise<LoadedTheme>
  sendOrder(req: OrderRequest): Promise<OrderResult>
  /** Turns CEO orders on or off (the tray's "Allow CEO orders"). Resolves with the settings that
   *  now apply; onSettings fires as well. Rejects if `value` is not a boolean. */
  setAllowOrders(value: boolean): Promise<RendererSettings>
  /** Quits Agent Office: hosted sessions are stopped, as with the tray's Quit. */
  quit(): Promise<void>
  /** Opens an absolute http(s) URL in the system browser. Resolves false if the main process
   *  refused it. Absent in the browser stub, where a link opens in a new tab instead. */
  openExternal?(url: string): Promise<boolean>

  sessions: {
    providers(): Promise<ProviderInfo[]>
    /** Login state / usage changed. */
    onProvidersChanged(cb: (providers: ProviderInfo[]) => void): () => void
    /** Starts the provider's login (system browser). Resolves when the flow was started; watch
     *  onProvidersChanged for account.loggedIn. Rejects with a readable message on failure. */
    login(provider: ProviderId): Promise<void>
    list(): Promise<SessionInfo[]>
    /** Rejects with a readable message if the folder is invalid or the provider unavailable. */
    start(req: StartSessionRequest): Promise<SessionInfo>
    /** Ask the CLI to exit; kills the process tree if it doesn't. */
    stop(id: string): Promise<void>
    /** Interrupt the running turn (Esc for Claude Code). */
    interrupt(id: string): Promise<void>
    /** Native folder picker; null if cancelled. */
    pickFolder(): Promise<string | null>
    /** Earlier conversations of `provider` in exactly that folder, newest first, that a new session
     *  can continue (StartSessionRequest.resume). Empty when the provider keeps no history, is not
     *  logged in, or the folder has none. Rejects with a readable message if it could not be read. */
    history(provider: ProviderId, cwd: string): Promise<SessionHistoryEntry[]>
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

  chat: {
    /** Current items; ChatEvents for this session stream to onEvent until detach. */
    attach(id: string): Promise<ChatItem[]>
    detach(id: string): void
    /** A prompt typed by the user in the chat box. If a turn is running it is added to that turn
     *  (steer). Not gated by allowOrders: like typing in a terminal, it is the user's own input.
     *  Rejects with a readable message if the session can't take input (exited, not logged in). */
    send(id: string, text: string): Promise<void>
    onEvent(cb: (e: ChatEvent) => void): () => void
  }

  board: {
    get(): Promise<{ snapshot: BoardSnapshot; settings: BoardSettings }>
    /** Removes a claim or note (kind + id). Resolves false if it was already gone. */
    remove(kind: 'claim' | 'note', id: string): Promise<boolean>
    setSettings(patch: Partial<BoardSettings>): Promise<BoardSettings>
    onChanged(cb: (snapshot: BoardSnapshot) => void): () => void
    /** The settings changed, here or in the tray. Absent in the browser stub. */
    onSettingsChanged?(cb: (settings: BoardSettings) => void): () => void
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
