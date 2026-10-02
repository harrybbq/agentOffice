// What the session manager needs from a provider. One AgentDriver instance runs one hosted session.
// A driver is terminal-based (Claude Code: the official TUI in a pty, structured events from hooks)
// or chat-based (Codex: `codex app-server`; Antigravity: `agy` stream-json; no TUI, a ChatItem list
// instead), see `surface`.
// Nothing here is specific to hooks, TUIs or PTYs.
//
// No Electron imports: drivers get everything they need through DriverContext, and tests build one
// with fakes.
import type { ChatEvent, ChatItem } from '../../shared/chat'
import type {
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  ProviderId,
  ProviderInfo,
  SessionHistoryEntry,
  SessionState,
  TerminalSnapshot
} from '../../shared/sessions'
import type { EventSink } from '../adapters/types'
import type { AgentFact } from '../agentStats'
import type { BoardAccess } from '../board'
import type { SessionTokens } from '../ingest/auth'
import type { PermissionRegistry } from '../permissions'
import type { PtySpawnOptions } from '../ptyProtocol'

/** A start request after the main process validated it. Never contains a command, args or env. */
export interface ValidatedStart {
  provider: ProviderId
  /** Existing directory, absolute. */
  cwd: string
  permissionMode: PermissionMode
  model?: string
  resume?: string
  /** The title at launch: the user's own, or the provider label until the model is known. */
  title: string
  /** The title the user typed, if any. It always wins and never changes. */
  userTitle?: string
}

export type PromptResult =
  /** `queued`: handed over mid-turn; the agent takes it in when its running tool call is done. */
  { ok: true; queued: boolean } | { ok: false; reason: string }

/** Who a prompt comes from: a CEO order (order bar), or the user typing in the session's chat box. */
export type PromptOrigin = 'order' | 'human'

export interface PtyHandlers {
  onExit(exitCode: number | null): void
  onTitle?(title: string): void
}

export interface ScreenSnapshot extends TerminalSnapshot {
  /** The visible screen as plain text (diagnostics and tests). */
  text: string
}

/** The pty host as seen from the main process (electron/ptyClient.ts; tests use a fake). */
export interface PtyHost {
  /** Resolves once the process is running; rejects with a readable message if it could not start. */
  spawn(id: string, opts: PtySpawnOptions, handlers: PtyHandlers): Promise<void>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** Kills the process tree. */
  kill(id: string): void
  /** Forgets an exited terminal. */
  dispose(id: string): void
  /** The current screen. With `attach`, output is streamed to `onData` from then on. */
  snapshot(id: string, attach: boolean): Promise<ScreenSnapshot | null>
  detach(id: string): void
  ack(id: string, chars: number): void
}

/** How a driver tells the session manager what happened. */
export interface DriverEvents {
  onState(state: SessionState): void
  /** The provider's own session id became known. */
  onProviderSession(id: string): void
  /** The session reported which model it runs (at start, and again if it changes). */
  onModel(modelId: string): void
  /** `canReceiveOrders` (or anything else in SessionInfo) may have changed. */
  onChanged(): void
  onExit(exitCode: number | null): void
  /** Chat-based drivers: the session's chat list changed. */
  onChat(e: ChatEvent): void
  /** The user sent a prompt (typed, or an order): never a synthetic one. For the saved preview (shared/restore.ts). */
  onPrompt?(text: string): void
  /**
   * Something the inspector shows about one of the session's agents (electron/agentStats.ts): a
   * turn, token usage, a changed file, a worker's task. Read-only bookkeeping; never needed for the
   * session to work.
   */
  onFact?(fact: AgentFact): void
}

export interface DriverContext {
  /** App session id: the terminal id, and the world id of the session's manager. */
  sessionId: string
  start: ValidatedStart
  /** Terminal-based drivers spawn here. Chat-based drivers don't use it. */
  pty: PtyHost
  /** World events (AgentEvent) go here. */
  sink: EventSink
  permissions: PermissionRegistry
  events: DriverEvents
  /**
   * The office board as this session sees it (electron/board.ts): where the driver reports changed
   * files, gets the digest for a prompt and looks up conflicts. Absent = no board (tests, or a
   * manager built without one): the driver then behaves as before the board existed.
   */
  board?: BoardAccess
}

export interface AgentDriver {
  readonly provider: ProviderId
  /** How the user talks to the session: an embedded terminal, or the chat view. */
  readonly surface: 'terminal' | 'chat'
  readonly state: SessionState
  readonly providerSessionId: string | undefined
  /** Can a prompt be delivered right now? */
  readonly canReceiveOrders: boolean
  /** Workers (subagents) running right now, if the driver knows. They die with the session's process. */
  readonly workers?: number
  /** A short plain sentence about why the session ended, when the driver knows (SessionInfo.notice). */
  readonly endNotice?: string
  /** Launches the agent. Rejects with a readable message if it can't. */
  start(): Promise<void>
  /** Delivers a prompt / order into the session. Never throws. `origin` defaults to 'order'. */
  sendPrompt(text: string, origin?: PromptOrigin): Promise<PromptResult>
  /** Chat-based drivers: the current chat list (a copy), oldest first. */
  chatItems?(): ChatItem[]
  /** Answers one of this session's pending permission requests. */
  answerPermission(requestId: string, decision: PermissionDecision): PermissionOutcome
  /** The session's title changed: its manager in the world goes by the new name. */
  setTitle(title: string): void
  /** Interrupts the running turn. */
  interrupt(): void
  /** Asks the agent to exit and kills the process tree if it doesn't. Resolves once it is gone. */
  stop(): Promise<void>
}

/** One row of the fixed provider table. The renderer picks an id; it never names an executable. */
export interface ProviderDefinition {
  id: ProviderId
  label: string
  /** Is the CLI installed, and is there a driver for it? */
  probe(): Promise<ProviderInfo>
  /** Absent while the driver doesn't exist yet. */
  createDriver?(ctx: DriverContext): AgentDriver
  /** Providers with their own account: starts the login flow (system browser). Rejects with a readable message. */
  login?(): Promise<void>
  /** Earlier conversations in exactly that folder, newest first (see SessionHistoryEntry). */
  history?(cwd: string): Promise<SessionHistoryEntry[]>
  /** Calls `cb` whenever probe() would now answer differently (login state, usage). */
  onChanged?(cb: () => void): void
  /** App quit: stops whatever the provider keeps running besides its sessions. */
  shutdown?(): Promise<void>
  /**
   * A session that was started with `resume` failed: does the evidence say the conversation no
   * longer exists? `error` = why start() rejected; `screen` = the terminal's text when the process
   * exited before it was ready.
   */
  conversationGone?(evidence: { error?: string; screen?: string }): boolean
}

/** Shared by the manager and drivers that host a TUI. */
export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 40

/** What a driver needs from the ingest server to inject hooks. */
export interface IngestInfo {
  /** `http://127.0.0.1:<port>`, or null while the server isn't listening. */
  baseUrl(): string | null
  tokens: SessionTokens
}
