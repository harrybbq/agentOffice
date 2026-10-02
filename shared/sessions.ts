// Sessions hosted BY the app (the app launches the agent CLI itself), their terminals, and
// permission requests answered from the CEO office. Contract between main process and renderer.
//
// Security rules (do not relax):
// - Approvals and orders travel over renderer IPC only. There is never an HTTP route that approves
//   a permission or sends a prompt: spawned agents know their ingest token and can reach HTTP.
// - The renderer never supplies a command line, args or env. It picks a provider id + folder; the
//   main process resolves the executable from a fixed table.

import type { PermissionRisk } from './permissionText'

export type { PermissionRisk } from './permissionText'
import type { SavedPendingRequest } from './restore'

export type ProviderId = 'claude-code' | 'codex' | 'antigravity'

export interface ProviderInfo {
  id: ProviderId
  /** "Claude Code", "Codex", "Antigravity" */
  label: string
  /** Is the CLI installed and a driver available? */
  available: boolean
  /** Why not, when unavailable (e.g. "not installed", "driver coming in phase B"). */
  reason?: string
  version?: string
  /** Account state for providers that have their own login (Codex, Antigravity). Undefined = not applicable/unknown. */
  account?: { loggedIn: boolean; plan?: string }
  /**
   * Set by a provider whose sign-in the app cannot start itself (Antigravity): what the user has
   * to do, as one plain sentence. The renderer shows it with "Check again" instead of "Log in".
   */
  loginHelp?: string
  /** Usage of the provider's rate-limit window, when the provider reports it. */
  usage?: { usedPercent: number; resetsAt?: number; windowMinutes?: number }
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

export interface StartSessionRequest {
  provider: ProviderId
  /** Working directory; must be an existing folder (main validates). */
  cwd: string
  permissionMode?: PermissionMode
  model?: string
  /** Provider session id to resume, if any. */
  resume?: string
  /** Shown as the team/manager name. Defaults to the folder name. */
  title?: string
}

/** An earlier conversation of a provider in a folder, which a new session can continue (`resume`). */
export interface SessionHistoryEntry {
  /** The provider's own session id: what StartSessionRequest.resume takes. */
  id: string
  /** How the conversation began (its first prompt), on one line, truncated. May be empty. */
  preview: string
  /** Unix ms of the last activity. */
  updatedAt: number
  model?: string
}

export type SessionState =
  | 'starting' //            process spawned, not ready for input yet
  | 'needs-attention' //     the CLI is showing something only the terminal can answer (folder trust, login)
  | 'idle' //                waiting for a prompt
  | 'busy' //                working on a turn
  | 'waiting-permission' //  blocked on a permission request (see PermissionRequestInfo)
  | 'asleep' //             saved from an earlier run; no process. Wake it to resume the conversation
  | 'exited'

export interface SessionInfo {
  /** App-generated id. Also the AgentEvent.agentId of this session's manager in the world. */
  id: string
  provider: ProviderId
  cwd: string
  title: string
  state: SessionState
  startedAt: number
  permissionMode: PermissionMode
  model?: string
  /** The provider's own session id once known (Claude: hook `session_id`). */
  providerSessionId?: string
  /** How the user talks to this session: an embedded terminal (Claude Code TUI) or the chat view
   *  (providers with no TUI, e.g. Codex app-server). Terminal sessions may still expose a read-only chat log later. */
  surface: 'terminal' | 'chat'
  /** Can orders be delivered right now? */
  canReceiveOrders: boolean
  exitCode?: number | null
  /** Asleep rows only: can the provider conversation be resumed? (false = record without a conversation id) */
  wakeable?: boolean
  /** Set on a session that was working or waiting when the app last closed, until the user dismisses it. */
  interruptedNote?: { closedAt: number; pending: SavedPendingRequest[] }
  lastActiveAt?: number
  /** One-line preview of the user's last prompt in this session (<= 120 chars), when one is saved. */
  lastPrompt?: string
  /** True while the session is being woken (sessions.wake, or the automatic wake at launch). */
  waking?: boolean
  /** A short plain sentence about why the session ended, when the app knows (e.g. its saved
   *  conversation no longer exists, so it could not be resumed). */
  notice?: string
}

/** Subagents appear in the world as `${sessionId}:${providerAgentId}`. */
export const subagentId = (sessionId: string, providerAgentId: string): string => `${sessionId}:${providerAgentId}`

// ---- Permissions --------------------------------------------------------------------------------

export interface PermissionRequestInfo {
  /** App-generated id. */
  id: string
  sessionId: string
  /** World agent that is blocked (the session itself or one of its subagents). */
  agentId: string
  displayName: string
  provider: ProviderId
  toolName: string
  /** One line, e.g. "Bash: npm test" or "Edit: src/app.ts". */
  summary: string
  /** Pretty-printed tool input, truncated (for the expandable card). */
  detail: string
  /** The request as ONE plain sentence: "Sonnet 5.5 wants to run the tests (`npm test`)." The
   *  card's headline; `toolName` / `summary` / `detail` are the raw request under "Details".
   *  Built from fixed templates (shared/permissionText.ts), never by a model. */
  question: string
  /** How careful to be: `caution` and `danger` get a badge, `danger` also a slower Allow. */
  risk: PermissionRisk
  /** Why, in two or three words: "Deletes files", "Outside the project folder". */
  riskNote?: string
  createdAt: number
}

export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message?: string }

export type PermissionOutcome =
  | 'allowed' //    answered from the app
  | 'denied'
  | 'resolved-elsewhere' // answered in the terminal, timed out, or the turn was interrupted
  | 'unknown-request'

// ---- Terminal -----------------------------------------------------------------------------------

export interface TerminalSnapshot {
  /** Serialized screen (xterm serialize addon output) to write into a fresh xterm on attach. */
  data: string
  cols: number
  rows: number
}

/** Renderer acks every this many chars it has rendered; the pty host pauses above the high mark. */
export const TERM_ACK_CHARS = 5000
export const TERM_HIGH_WATERMARK_CHARS = 100_000
export const TERM_LOW_WATERMARK_CHARS = 5000
