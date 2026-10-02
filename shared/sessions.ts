// Sessions hosted BY the app (the app launches the agent CLI itself), their terminals, and
// permission requests answered from the CEO office. Contract between main process and renderer.
//
// Security rules (do not relax):
// - Approvals and orders travel over renderer IPC only. There is never an HTTP route that approves
//   a permission or sends a prompt: spawned agents know their ingest token and can reach HTTP.
// - The renderer never supplies a command line, args or env. It picks a provider id + folder; the
//   main process resolves the executable from a fixed table.

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

export type SessionState =
  | 'starting' //            process spawned, not ready for input yet
  | 'needs-attention' //     the CLI is showing something only the terminal can answer (folder trust, login)
  | 'idle' //                waiting for a prompt
  | 'busy' //                working on a turn
  | 'waiting-permission' //  blocked on a permission request (see PermissionRequestInfo)
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
  /** Can orders be delivered right now? */
  canReceiveOrders: boolean
  exitCode?: number | null
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
