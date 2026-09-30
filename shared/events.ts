// The one event format every adapter converts into. The scene never sees raw tool names.

export const ACTIVITIES = ['read', 'write', 'exec', 'web', 'capture', 'waiting', 'idle', 'done'] as const
export type Activity = (typeof ACTIVITIES)[number]

export interface AgentEvent {
  /** Stable id for this agent (session id for a main session, agent id for a subagent). */
  agentId: string
  /** Id of the agent that spawned this one, or null for a top-level session (a "manager"). */
  parentId: string | null
  /** Who produced it: "claude-code", "simulate", "codex", ... Drives the character's skin. */
  provider: string
  /** Short human label shown above the character. */
  displayName: string
  activity: Activity
  /** Free text for tooltips / speech bubbles, e.g. a file path or URL. */
  detail: string
  /** Unix epoch milliseconds. */
  ts: number
}

// Lifecycle conventions (no extra fields needed):
// - The first event seen for an agentId spawns its character. If it has a parentId, the
//   parent walks to a free desk and hands over a folder first.
// - `done` on a subagent: it carries a report to its manager, then leaves.
// - `done` on a top-level session: the session ended; the team's manager leaves.
// - `waiting`: blocked on the human (permission / question) -> memo to the boss's inbox.
// - `idle`: nothing happening (e.g. main session finished its turn and awaits a prompt).

const MAX_STR = 500

export function isActivity(v: unknown): v is Activity {
  return typeof v === 'string' && (ACTIVITIES as readonly string[]).includes(v)
}

/** Validates and normalises untrusted input. Returns null if it can't be made valid. */
export function parseAgentEvent(input: unknown): AgentEvent | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.agentId !== 'string' || o.agentId.length === 0) return null
  if (!isActivity(o.activity)) return null
  const str = (v: unknown, fallback: string) =>
    (typeof v === 'string' && v.length > 0 ? v : fallback).slice(0, MAX_STR)
  return {
    agentId: o.agentId.slice(0, 200),
    parentId: typeof o.parentId === 'string' && o.parentId.length > 0 ? o.parentId.slice(0, 200) : null,
    provider: str(o.provider, 'unknown'),
    displayName: str(o.displayName, o.agentId.slice(0, 12)),
    activity: o.activity,
    detail: typeof o.detail === 'string' ? o.detail.slice(0, MAX_STR) : '',
    ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : Date.now()
  }
}
