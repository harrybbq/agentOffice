// Progress of every hosted session and of every CEO order (shared/progress.ts). Fed by what the
// session manager and the drivers already know:
// - a real prompt            -> a new run
// - the session's state      -> working / waiting / idle / gone
// - a plan (ProgressSignal)  -> the agent's own to-do list: the only source of a "3 of 7" count
//                               besides the helpers
// - how a turn ended         -> finished (held at 100 % for a moment), or stopped where it was
// - world events             -> helpers the manager spawned during the run, and when each finished
// - sendOrder                -> an order to track across the sessions it was delivered to
//
// It never invents a number: without a plan and without helpers a busy session is 'working'
// (indeterminate). Nothing is saved.
//
// Pure: no Electron, no file system, an injectable clock and scheduler (the tests use fakes).
import type { AgentEvent } from '../shared/events'
import {
  ORDER_RETAIN_MS,
  ORDERS_MAX,
  PROGRESS_HOLD_MS,
  PROGRESS_MAX_STEPS,
  PROGRESS_PUSH_MS,
  PROGRESS_TEXT_CHARS,
  type OrderProgress,
  type OrderSessionProgress,
  type OrderSessionState,
  type ProgressSnapshot,
  type ProgressStep,
  type ProgressStepStatus,
  type SessionProgress
} from '../shared/progress'
import type { SessionState } from '../shared/sessions'

/** How a turn ended. */
export type TurnEnd = 'completed' | 'interrupted' | 'failed'

/** What a driver tells about its session's progress (DriverEvents.onProgress). */
export type ProgressSignal =
  /** The main thread's plan as it is now: the whole list, in order. An empty list clears it. */
  | { kind: 'plan'; steps: readonly ProgressStep[] }
  /** The main thread's turn is over. */
  | { kind: 'turn-end'; how: TurnEnd }

/** Runs `fn` after `ms`; returns a cancel function. */
export type ProgressScheduler = (fn: () => void, ms: number) => () => void

export interface ProgressTrackerOptions {
  now?: () => number
  schedule?: ProgressScheduler
  /** The whole snapshot, whenever it changed: coalesced, at most once per `pushMs`. */
  onChanged?: (snapshot: ProgressSnapshot) => void
  holdMs?: number
  orderRetainMs?: number
  maxOrders?: number
  pushMs?: number
  /** A delivered order that the session never started on fails after this long. */
  queuedTimeoutMs?: number
}

export interface OrderDelivery {
  /** The order as it was sent. */
  text: string
  target: string
  /** `tracker.now()` from just before the delivery began. */
  sentAt: number
  /** Sessions that took the order. */
  delivered: readonly string[]
  /** Hosted sessions it could not be delivered to. */
  failed?: readonly { sessionId: string; reason: string }[]
}

export const ORDER_QUEUED_TIMEOUT_MS = 60_000
const MAX_WORKERS = 200
const TITLE_MAX = 100
const REASON_MAX = 80

const defaultSchedule: ProgressScheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/** One line, trimmed, capped. */
export function progressText(text: unknown, max = PROGRESS_TEXT_CHARS): string {
  if (typeof text !== 'string') return ''
  const flat = text
    .slice(0, 4000)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A step status in any provider's spelling (`in_progress`, `inProgress`, `in-progress`, `done`…). */
export function stepStatus(v: unknown): ProgressStepStatus {
  const s = typeof v === 'string' ? v.toLowerCase().replace(/[\s_-]/g, '') : ''
  if (s === 'completed' || s === 'complete' || s === 'done') return 'completed'
  if (s === 'inprogress' || s === 'active' || s === 'running') return 'in-progress'
  return 'pending'
}

interface Run {
  sessionId: string
  title: string
  state: SessionState | null
  startedAt: number
  updatedAt: number
  /** The whole plan (not capped). */
  steps: ProgressStep[]
  /** Helpers spawned during this run (world ids) -> finished? */
  workers: Map<string, boolean>
  /** Helpers from before this run that are still around: they belong to no count. */
  earlier: Set<string>
  /** How the last turn ended; null while one runs, and before the first. */
  ended: TurnEnd | null
  stopped: SessionProgress['stopped']
  finishedAt: number | null
  cancelHold: (() => void) | null
  /** When it was last seen working or waiting. */
  lastLiveAt: number
}

interface OrderRow {
  sessionId: string
  title: string
  state: OrderSessionState
  reason?: string
  cancelQueued: (() => void) | null
}

interface Order {
  id: string
  text: string
  target: string
  sentAt: number
  rows: OrderRow[]
  finishedAt: number | null
  cancelRetain: (() => void) | null
}

const isLive = (state: SessionState | null): boolean => state === 'busy' || state === 'waiting-permission'
const terminal = (s: OrderSessionState): boolean => s === 'done' || s === 'failed'

export class ProgressTracker {
  private runs = new Map<string, Run>()
  private orders: Order[] = []
  private orderSeq = 0
  private readonly clock: () => number
  private readonly schedule: ProgressScheduler
  private readonly holdMs: number
  private readonly orderRetainMs: number
  private readonly maxOrders: number
  private readonly pushMs: number
  private readonly queuedTimeoutMs: number
  private pushTimer: (() => void) | null = null
  private lastPushAt = Number.NEGATIVE_INFINITY
  private lastPushed = ''

  constructor(private readonly opts: ProgressTrackerOptions = {}) {
    this.clock = opts.now ?? Date.now
    this.schedule = opts.schedule ?? defaultSchedule
    this.holdMs = opts.holdMs ?? PROGRESS_HOLD_MS
    this.orderRetainMs = opts.orderRetainMs ?? ORDER_RETAIN_MS
    this.maxOrders = opts.maxOrders ?? ORDERS_MAX
    this.pushMs = opts.pushMs ?? PROGRESS_PUSH_MS
    this.queuedTimeoutMs = opts.queuedTimeoutMs ?? ORDER_QUEUED_TIMEOUT_MS
  }

  /** The tracker's clock (the session manager stamps an order with it before delivering). */
  now(): number {
    return this.clock()
  }

  // ---- feeds ---------------------------------------------------------------------------------

  /** A hosted session exists (it was started or woken), or goes by another title. */
  session(sessionId: string, title: string): void {
    const r = this.run(sessionId)
    const next = progressText(title, TITLE_MAX)
    if (!next || r.title === next) return
    r.title = next
    // Its rows in running orders go by the new name too.
    let shown = false
    for (const o of this.orders) {
      for (const row of o.rows) {
        if (row.sessionId !== sessionId) continue
        row.title = next
        shown = true
      }
    }
    if (shown) this.changed()
  }

  /** The session is gone from the list. An order it was part of keeps its row. */
  forget(sessionId: string): void {
    const r = this.runs.get(sessionId)
    if (!r) return
    r.cancelHold?.()
    this.runs.delete(sessionId)
    this.failRows(sessionId, 'the session ended')
    this.changed()
  }

  /** A real prompt of the user's (typed, or an order) that starts a turn: a new run. */
  prompt(sessionId: string): void {
    const r = this.run(sessionId)
    const now = this.clock()
    // What was finished is over; what was left unfinished stays until the new run's own plan arrives.
    if (r.finishedAt !== null || allCompleted(r.steps)) r.steps = []
    this.endHold(r)
    // Helpers of the last run that are still out are not this run's.
    for (const [id, done] of r.workers) if (!done) this.remember(r, id)
    r.workers.clear()
    r.startedAt = now
    r.updatedAt = now
    r.ended = null
    r.stopped = undefined
    this.changed()
  }

  /** The session's state changed (SessionManager.onState). */
  state(sessionId: string, state: SessionState): void {
    const r = this.run(sessionId)
    const prev = r.state
    if (prev === state) return
    r.state = state
    const now = this.clock()
    if (state === 'exited' || state === 'asleep') {
      this.endHold(r)
      this.failRows(sessionId, 'the session ended')
      return this.changed()
    }
    if (isLive(state)) {
      r.lastLiveAt = now
      if (!isLive(prev)) {
        // Working again without a new prompt (a hand-back, a task notification, "continue" typed
        // mid-turn): the same run carries on.
        if (r.finishedAt !== null) {
          r.finishedAt = null
          r.cancelHold?.()
          r.cancelHold = null
        }
        if (r.startedAt === 0) r.startedAt = now
        r.ended = null
        r.stopped = undefined
        r.updatedAt = now
      }
    } else if (state === 'idle' && isLive(prev)) {
      // Idle without the turn having said how it ended (Claude after Esc: no Stop hook): interrupted.
      if (r.ended === null) {
        r.ended = 'interrupted'
        this.settle(r)
      }
    }
    this.syncRows(r)
    this.changed()
  }

  /** What the session's driver knows: its plan, or how its turn ended. */
  signal(sessionId: string, signal: ProgressSignal): void {
    if (!signal || typeof signal !== 'object') return
    const r = this.run(sessionId)
    const now = this.clock()
    if (signal.kind === 'plan') {
      if (!Array.isArray(signal.steps)) return
      const steps: ProgressStep[] = []
      for (const s of signal.steps) {
        if (!s || typeof s !== 'object') continue
        steps.push({ text: progressText(s.text) || 'Step', status: stepStatus(s.status) })
      }
      if (sameSteps(r.steps, steps)) return
      // A list written while the finished one is still on show: the next piece of work has begun.
      this.endHold(r)
      r.steps = steps
      if (isLive(r.state)) r.stopped = undefined
      r.updatedAt = now
      if (r.startedAt === 0) r.startedAt = now
    } else if (signal.kind === 'turn-end') {
      if (signal.how !== 'completed' && signal.how !== 'interrupted' && signal.how !== 'failed') return
      r.ended = signal.how
      this.settle(r)
      this.syncRows(r)
    } else return
    this.changed()
  }

  /** Every world event: a manager's helpers are counted from them. */
  event(e: AgentEvent): void {
    if (!e || typeof e.agentId !== 'string' || typeof e.parentId !== 'string' || e.parentId === e.agentId) return
    const r = this.runs.get(e.parentId)
    if (!r) return
    const known = r.workers.get(e.agentId)
    if (e.activity === 'done') {
      r.earlier.delete(e.agentId)
      if (known !== false) return
      r.workers.set(e.agentId, true)
      r.updatedAt = this.clock()
      // The turn was over already and this was the last helper still at it.
      if (!isLive(r.state) && r.ended !== null) this.settle(r)
      this.syncRows(r)
      return this.changed()
    }
    if (known !== undefined || r.earlier.has(e.agentId)) return
    // A helper counts for the run it was spawned in: while the manager works, or other helpers of
    // this run still do. One that shows up outside a run never counts.
    if (!isLive(r.state) && activeWorkers(r) === 0) return this.remember(r, e.agentId)
    if (r.workers.size >= MAX_WORKERS) return
    r.workers.set(e.agentId, false)
    r.updatedAt = this.clock()
    this.changed()
  }

  /**
   * An order was sent (SessionManager.sendOrder). Tracked when it reached at least one session:
   * each stays 'working' until its manager goes idle after the order. Returns the order's id, or
   * null when nothing is tracked.
   */
  order(d: OrderDelivery): string | null {
    const delivered = [...new Set(d.delivered)].filter((id) => this.runs.has(id))
    if (delivered.length === 0) return null
    const now = this.clock()
    const order: Order = {
      id: `o-${++this.orderSeq}`,
      text: progressText(d.text),
      target: typeof d.target === 'string' ? d.target.slice(0, 200) : '',
      sentAt: Number.isFinite(d.sentAt) ? d.sentAt : now,
      rows: [],
      finishedAt: null,
      cancelRetain: null
    }
    for (const id of delivered) {
      const r = this.runs.get(id)!
      const row: OrderRow = { sessionId: id, title: r.title || id.slice(0, 12), state: 'queued', cancelQueued: null }
      if (r.state === 'exited' || r.state === 'asleep') this.fail(row, 'the session ended')
      else if (isLive(r.state) || activeWorkers(r) > 0) row.state = r.state === 'waiting-permission' ? 'waiting' : 'working'
      // It started and finished while the delivery to the others was still under way.
      else if (r.lastLiveAt >= order.sentAt) this.rowEnded(row, r)
      else {
        row.cancelQueued = this.schedule(() => {
          row.cancelQueued = null
          if (row.state !== 'queued') return
          this.fail(row, 'did not start')
          this.checkFinished(order)
          this.changed()
        }, this.queuedTimeoutMs)
      }
      order.rows.push(row)
    }
    for (const f of d.failed ?? []) {
      if (!f || delivered.includes(f.sessionId) || order.rows.some((x) => x.sessionId === f.sessionId)) continue
      const r = this.runs.get(f.sessionId)
      if (!r) continue
      order.rows.push({ sessionId: f.sessionId, title: r.title || f.sessionId.slice(0, 12), state: 'failed', reason: progressText(f.reason, REASON_MAX) || 'not delivered', cancelQueued: null })
    }
    this.orders.push(order)
    this.checkFinished(order)
    this.trimOrders()
    this.changed()
    return order.id
  }

  /** The user closed an order's bar. */
  dismissOrder(id: unknown): boolean {
    const order = typeof id === 'string' ? this.orders.find((o) => o.id === id) : undefined
    if (!order) return false
    this.dropOrder(order)
    this.changed()
    return true
  }

  // ---- the answer ----------------------------------------------------------------------------

  /** Fresh copies: the caller may keep or send them. */
  snapshot(): ProgressSnapshot {
    const sessions: SessionProgress[] = []
    for (const r of this.runs.values()) {
      const p = this.progressOf(r)
      if (p) sessions.push(p)
    }
    return { sessions, orders: this.orders.map((o) => this.orderOf(o)) }
  }

  /** One session's progress; null for a session that is unknown, asleep or gone. */
  get(sessionId: string): SessionProgress | null {
    const r = this.runs.get(sessionId)
    return r ? this.progressOf(r) : null
  }

  /** Stops every timer (app quit, tests). */
  dispose(): void {
    this.pushTimer?.()
    this.pushTimer = null
    for (const r of this.runs.values()) r.cancelHold?.()
    for (const o of this.orders) {
      o.cancelRetain?.()
      for (const row of o.rows) row.cancelQueued?.()
    }
    this.runs.clear()
    this.orders = []
  }

  // ---- internals -----------------------------------------------------------------------------

  private run(sessionId: string): Run {
    let r = this.runs.get(sessionId)
    if (!r) {
      r = {
        sessionId,
        title: '',
        state: null,
        startedAt: 0,
        updatedAt: this.clock(),
        steps: [],
        workers: new Map(),
        earlier: new Set(),
        ended: null,
        stopped: undefined,
        finishedAt: null,
        cancelHold: null,
        lastLiveAt: Number.NEGATIVE_INFINITY
      }
      this.runs.set(sessionId, r)
    }
    return r
  }

  private remember(r: Run, workerId: string): void {
    if (r.earlier.size >= MAX_WORKERS) r.earlier.delete(r.earlier.values().next().value as string)
    r.earlier.add(workerId)
  }

  private progressOf(r: Run): SessionProgress | null {
    if (r.state === null || r.state === 'exited' || r.state === 'asleep') return null
    const base = { sessionId: r.sessionId, startedAt: r.startedAt || r.updatedAt, updatedAt: r.updatedAt }
    const live = isLive(r.state)
    const mark = (p: SessionProgress): SessionProgress => {
      if (r.finishedAt !== null) p.finishedAt = r.finishedAt
      else if (r.stopped && !live) p.stopped = r.stopped
      return p
    }
    if (r.steps.length > 0) {
      const done = r.steps.filter((s) => s.status === 'completed').length
      const p: SessionProgress = { ...base, kind: 'plan', done, total: r.steps.length, steps: r.steps.slice(0, PROGRESS_MAX_STEPS).map((s) => ({ ...s })) }
      const current = r.steps.find((s) => s.status === 'in-progress')
      if (current && r.finishedAt === null) p.current = current.text
      return mark(p)
    }
    if (r.workers.size > 0) {
      const done = [...r.workers.values()].filter(Boolean).length
      return mark({ ...base, kind: 'workers', done, total: r.workers.size })
    }
    return { ...base, kind: live ? 'working' : 'idle', done: 0, total: 0 }
  }

  /** The turn is over (`r.ended`), or a helper finished after it: finished, stopped, or still going. */
  private settle(r: Run): void {
    const how = r.ended
    if (how === null) return
    const now = this.clock()
    r.updatedAt = now
    const counted = r.steps.length > 0 || r.workers.size > 0
    if (!counted) return
    if (how !== 'completed') {
      r.stopped = how
      return
    }
    const complete = r.steps.length > 0 ? allCompleted(r.steps) : activeWorkers(r) === 0
    if (complete) {
      r.stopped = undefined
      r.finishedAt = now
      r.cancelHold?.()
      r.cancelHold = this.schedule(() => {
        r.cancelHold = null
        if (r.finishedAt === null) return
        r.finishedAt = null
        r.steps = []
        r.workers.clear()
        r.updatedAt = this.clock()
        this.changed()
      }, this.holdMs)
      return
    }
    // Steps are left. Helpers in the background may still be at them; otherwise it stopped here.
    r.stopped = activeWorkers(r) > 0 ? undefined : 'paused'
  }

  /** Ends the "100 %" hold without waiting for it (a new run, a new plan, the session ending). */
  private endHold(r: Run): void {
    if (r.finishedAt === null) return
    r.cancelHold?.()
    r.cancelHold = null
    r.finishedAt = null
    r.steps = []
    r.workers.clear()
  }

  // ---- orders ----

  private fail(row: OrderRow, reason: string): void {
    row.cancelQueued?.()
    row.cancelQueued = null
    row.state = 'failed'
    row.reason = reason
  }

  /** The session went idle after the order: done, unless its turn was cut short. */
  private rowEnded(row: OrderRow, r: Run): void {
    row.cancelQueued?.()
    row.cancelQueued = null
    if (r.ended === 'interrupted') this.fail(row, 'interrupted')
    else if (r.ended === 'failed') this.fail(row, 'the turn failed')
    else {
      row.state = 'done'
      delete row.reason
    }
  }

  /** A session's state, turn or helpers changed: its rows in running orders follow. */
  private syncRows(r: Run): void {
    for (const o of this.orders) {
      if (o.finishedAt !== null) continue
      let touched = false
      for (const row of o.rows) {
        if (row.sessionId !== r.sessionId || terminal(row.state)) continue
        touched = true
        if (isLive(r.state)) {
          row.cancelQueued?.()
          row.cancelQueued = null
          row.state = r.state === 'waiting-permission' ? 'waiting' : 'working'
        } else if (row.state !== 'queued' && activeWorkers(r) === 0) this.rowEnded(row, r)
      }
      if (touched) this.checkFinished(o)
    }
  }

  private failRows(sessionId: string, reason: string): void {
    for (const o of this.orders) {
      let touched = false
      for (const row of o.rows) {
        if (row.sessionId !== sessionId || terminal(row.state)) continue
        this.fail(row, reason)
        touched = true
      }
      if (touched) this.checkFinished(o)
    }
  }

  private checkFinished(o: Order): void {
    if (o.finishedAt !== null || o.rows.some((row) => !terminal(row.state))) return
    o.finishedAt = this.clock()
    o.cancelRetain = this.schedule(() => {
      o.cancelRetain = null
      if (!this.orders.includes(o)) return
      this.dropOrder(o)
      this.changed()
    }, this.orderRetainMs)
  }

  private dropOrder(o: Order): void {
    o.cancelRetain?.()
    o.cancelRetain = null
    for (const row of o.rows) {
      row.cancelQueued?.()
      row.cancelQueued = null
    }
    this.orders = this.orders.filter((x) => x !== o)
  }

  /** Over the cap: the oldest finished order goes first, then the oldest. */
  private trimOrders(): void {
    while (this.orders.length > this.maxOrders) this.dropOrder(this.orders.find((o) => o.finishedAt !== null) ?? this.orders[0])
  }

  private orderOf(o: Order): OrderProgress {
    const sessions = o.rows.map((row): OrderSessionProgress => {
      const out: OrderSessionProgress = { sessionId: row.sessionId, title: row.title, state: row.state }
      if (row.reason) out.reason = row.reason
      const r = this.runs.get(row.sessionId)
      const p = r && row.state !== 'failed' ? this.progressOf(r) : null
      if (p && p.kind !== 'idle') out.progress = p
      return out
    })
    const out: OrderProgress = {
      id: o.id,
      text: o.text,
      target: o.target,
      sentAt: o.sentAt,
      sessions,
      done: o.rows.filter((row) => row.state === 'done').length,
      total: o.rows.length
    }
    if (o.finishedAt !== null) out.finishedAt = o.finishedAt
    return out
  }

  // ---- pushing ----

  /** Coalesces a burst into one push, and never pushes more often than `pushMs`. */
  private changed(): void {
    if (!this.opts.onChanged || this.pushTimer) return
    const wait = Math.max(0, this.lastPushAt + this.pushMs - this.clock())
    this.pushTimer = this.schedule(() => {
      this.pushTimer = null
      const snapshot = this.snapshot()
      const text = JSON.stringify(snapshot)
      if (text === this.lastPushed) return
      this.lastPushed = text
      this.lastPushAt = this.clock()
      try {
        this.opts.onChanged?.(snapshot)
      } catch {
        // a window that is going away
      }
    }, wait)
  }
}

function allCompleted(steps: readonly ProgressStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.status === 'completed')
}

function activeWorkers(r: { workers: Map<string, boolean> }): number {
  let n = 0
  for (const done of r.workers.values()) if (!done) n++
  return n
}

function sameSteps(a: readonly ProgressStep[], b: readonly ProgressStep[]): boolean {
  return a.length === b.length && a.every((s, i) => s.text === b[i].text && s.status === b[i].status)
}
