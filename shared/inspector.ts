// Agent inspector: click a character (or a session) and see what it is doing — task, status, runtime,
// tokens, tools used, files changed, recent activity. The main process keeps per-agent stats
// (electron/agentStats.ts) fed by the event bus and the drivers; the renderer asks for one agent and
// gets pushed updates while it is being watched.
//
// Rules:
// - Read-only. The inspector never controls an agent.
// - Works for every agent in the world: hosted sessions, their subagents, and observed/external agents
//   (which simply have fewer fields).
// - No secrets and no full prompt text: previews are one line and capped (INSPECT_PREVIEW_CHARS).

import type { Activity } from './events'
import type { PermissionRisk } from './permissionText'
import type { ProviderId, SessionState } from './sessions'

export interface TokenUsage {
  input: number
  output: number
  /** Cached input tokens, when the provider reports them. */
  cached?: number
  /** Reasoning / thinking tokens, when reported. */
  reasoning?: number
  total: number
  /** Size of the last request's context and the model's window, for a "context used" bar. */
  contextUsed?: number
  contextWindow?: number
}

export interface InspectedEvent {
  ts: number
  activity: Activity
  detail: string
}

export interface AgentDetails {
  agentId: string
  /** Hosted session this agent belongs to; undefined for observed/external agents. */
  sessionId?: string
  /** The manager's agentId for a worker; undefined for a manager. */
  parentId?: string
  role: 'manager' | 'worker'
  displayName: string
  /** ProviderId for hosted sessions, the event's provider string otherwise. */
  provider: ProviderId | string
  model?: string
  /** Hosted managers: the session state. Others: derived from the last activity. */
  state: SessionState | 'working' | 'waiting' | 'done'
  activity: Activity
  /** Current activity detail, e.g. a file path or command (one line). */
  detail: string
  /** What it was asked to do: manager = last prompt preview or its board claim; worker = its description. */
  task?: string
  /** Worker type, e.g. "Explore", "general-purpose". */
  agentType?: string
  cwd?: string
  startedAt: number
  lastActiveAt: number
  /** Time spent working (not idle/asleep), in ms, up to now. */
  activeMs: number
  /** Number of turns (prompts answered), when known. */
  turns?: number
  tokens?: TokenUsage
  /** How many times each activity started. */
  counts: Partial<Record<Activity, number>>
  /** Files this agent changed, newest first, project-relative where possible (max INSPECT_MAX_FILES). */
  files: { path: string; ts: number; kind: 'create' | 'edit' | 'delete' }[]
  /** Newest first, max INSPECT_MAX_EVENTS. */
  recent: InspectedEvent[]
  /** If it is blocked on the user: the plain question and its risk. */
  waitingOn?: { question: string; risk: PermissionRisk; since: number }
  /** A manager's workers (live and recently finished), newest first. */
  workers?: { agentId: string; displayName: string; agentType?: string; activity: Activity; done: boolean; startedAt: number; /** What it was asked to do, when known. */ task?: string }[]
}

export const INSPECT_MAX_EVENTS = 30
export const INSPECT_MAX_FILES = 20
export const INSPECT_PREVIEW_CHARS = 160
/** Pushes for a watched agent are throttled to this interval. */
export const INSPECT_PUSH_MS = 1000
