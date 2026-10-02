// What the session manager needs from a provider. One AgentDriver instance runs one hosted session.
// The Claude Code driver is the first; Codex (`codex app-server`) and Antigravity come later and
// must fit the same interface, so nothing here is specific to hooks, TUIs or PTYs.
//
// No Electron imports: drivers get everything they need through DriverContext, and tests build one
// with fakes.
import type {
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  ProviderId,
  ProviderInfo,
  SessionState,
  TerminalSnapshot
} from '../../shared/sessions'
import type { EventSink } from '../adapters/types'
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
  /** `queued`: handed over mid-turn, where delivery can't be confirmed. */
  { ok: true; queued: boolean } | { ok: false; reason: string }

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
}

export interface DriverContext {
  /** App session id: the terminal id, and the world id of the session's manager. */
  sessionId: string
  start: ValidatedStart
  pty: PtyHost
  /** World events (AgentEvent) go here. */
  sink: EventSink
  permissions: PermissionRegistry
  events: DriverEvents
}

export interface AgentDriver {
  readonly provider: ProviderId
  readonly state: SessionState
  readonly providerSessionId: string | undefined
  /** Can a prompt be delivered right now? */
  readonly canReceiveOrders: boolean
  /** Launches the agent. Rejects with a readable message if it can't. */
  start(): Promise<void>
  /** Delivers a prompt / order into the session. Never throws. */
  sendPrompt(text: string): Promise<PromptResult>
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
