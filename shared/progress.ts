// Progress bars: one per hosted session (a "branch"), and one per CEO order that several branches
// work on at once (a "major task"). The main process keeps both (electron/progress.ts) and pushes the
// whole snapshot; the renderer only draws it (src/ui/progress.ts).
//
// The honesty rule: a bar is DETERMINATE only when there is a real count behind it.
//   'plan'     the agent's own to-do list: steps completed / steps (Claude TodoWrite and task tools,
//              Codex `turn/plan/updated`)
//   'workers'  no plan, but the manager spawned helpers during this run: helpers finished / spawned
//   'working'  busy, and nothing to count: an indeterminate bar. Never a made-up percentage.
//   'idle'     nothing to show
// Nothing here is saved: a session that is asleep (or was restored) has no progress.

export type ProgressKind = 'plan' | 'workers' | 'working' | 'idle'
export type ProgressStepStatus = 'pending' | 'in-progress' | 'completed'

export interface ProgressStep {
  /** One line, at most PROGRESS_TEXT_CHARS. */
  text: string
  status: ProgressStepStatus
}

export interface SessionProgress {
  sessionId: string
  kind: ProgressKind
  /** Steps completed / helpers finished. 0 for 'working' and 'idle'. */
  done: number
  /** Steps / helpers spawned. 0 for 'working' and 'idle' (so: total > 0 means determinate). */
  total: number
  /** The step in progress, on one line (at most PROGRESS_TEXT_CHARS). */
  current?: string
  /** The plan's steps in order (at most PROGRESS_MAX_STEPS; `total` still counts them all). */
  steps?: ProgressStep[]
  /** When this run began: the user's last real prompt (not a synthetic one, not a steer). */
  startedAt: number
  updatedAt: number
  /** Set while a finished run is still shown at 100 % (PROGRESS_HOLD_MS), then it goes idle. */
  finishedAt?: number
  /**
   * The turn ended before the count was complete, and nothing is running any more: it was
   * interrupted, it failed, or it simply ended with steps left. The bar stays where it was (the
   * renderer greys it) until the next prompt.
   */
  stopped?: 'interrupted' | 'failed' | 'paused'
}

export type OrderSessionState =
  | 'queued' //   delivered, the session has not started on it yet
  | 'working'
  | 'waiting' //  blocked on a permission request
  | 'done' //     its manager went idle after the order
  | 'failed' //   could not be delivered, the turn failed or was interrupted, or the session ended

export interface OrderSessionProgress {
  sessionId: string
  title: string
  state: OrderSessionState
  /** Why it failed, in a few words ("the session ended"). */
  reason?: string
  /** That session's own progress, while it has something to show. */
  progress?: SessionProgress
}

export interface OrderProgress {
  id: string
  /** One-line preview of the order (at most PROGRESS_TEXT_CHARS). */
  text: string
  /** 'all' | 'provider:<id>' | a session id (shared/orders.ts OrderTarget). */
  target: string
  sentAt: number
  sessions: OrderSessionProgress[]
  /** Sessions that are done / sessions the order went to. */
  done: number
  total: number
  /** Set once no session is queued, working or waiting. The order is then kept ORDER_RETAIN_MS. */
  finishedAt?: number
}

export interface ProgressSnapshot {
  /** Every live hosted session, also the idle ones. */
  sessions: SessionProgress[]
  /** Oldest first, at most ORDERS_MAX. */
  orders: OrderProgress[]
}

export const PROGRESS_TEXT_CHARS = 120
export const PROGRESS_MAX_STEPS = 30
/** A finished run stays at 100 % this long. */
export const PROGRESS_HOLD_MS = 8000
/** A finished order stays this long (or until dismissed). */
export const ORDER_RETAIN_MS = 30_000
export const ORDERS_MAX = 5
/** Snapshots are pushed at most this often. */
export const PROGRESS_PUSH_MS = 250
/** The renderer shows the big bar only for an order that went to at least this many sessions. */
export const ORDER_BAR_MIN_SESSIONS = 2
