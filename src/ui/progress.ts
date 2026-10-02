// Pure selectors for the progress bars (shared/progress.ts): which kind of bar a session gets, its
// fraction, what it says, and the same for an order that several teams work on. No DOM, no React.
// Covered by tests/progressui.test.ts.
//
// The honesty rule lives here too: a fraction only exists when the main process sent a real count
// (`total > 0`). Everything else is an indeterminate "working" bar, or no bar at all.
import { ORDER_BAR_MIN_SESSIONS } from '../../shared/progress'
import type { OrderProgress, OrderSessionProgress, ProgressSnapshot, ProgressStep, SessionProgress } from '../../shared/progress'

export type BarMode = 'determinate' | 'indeterminate'
/** live: at work · waiting: blocked on the user · stopped: cut short, greyed · finished: held at 100 % */
export type BarTone = 'live' | 'waiting' | 'stopped' | 'finished'

export interface BarView {
  mode: BarMode
  /** 0..1; 0 for an indeterminate bar. */
  fraction: number
  tone: BarTone
  /** "3/7" for a determinate bar, '' otherwise. */
  label: string
  /** Where the number comes from: "3 of 7 plan steps", "2 of 3 helpers finished", "Working". */
  tooltip: string
  /** The step in progress, when the plan names one. */
  current?: string
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/** Is there a real count behind this progress? */
export function isDeterminate(p: Pick<SessionProgress, 'kind' | 'total'> | null | undefined): boolean {
  return !!p && (p.kind === 'plan' || p.kind === 'workers') && count(p.total) > 0
}

/** done / total, 0..1. 0 without a real count. */
export function fractionOf(p: Pick<SessionProgress, 'kind' | 'done' | 'total'> | null | undefined): number {
  if (!p || !isDeterminate(p)) return 0
  return clamp01(count(p.done) / count(p.total))
}

/** "3 of 7 plan steps" / "2 of 3 helpers finished" / "Working": the source of the bar, in words. */
export function sourceText(p: SessionProgress): string {
  const done = Math.min(count(p.done), count(p.total))
  const total = count(p.total)
  if (p.kind === 'plan' && total > 0) return `${done} of ${total} plan ${total === 1 ? 'step' : 'steps'}`
  if (p.kind === 'workers' && total > 0) return `${done} of ${total} ${total === 1 ? 'helper' : 'helpers'} finished`
  return p.kind === 'working' ? 'Working' : 'Idle'
}

const STOPPED_TEXT: Record<NonNullable<SessionProgress['stopped']>, string> = {
  interrupted: 'interrupted',
  failed: 'the turn failed',
  paused: 'the turn ended with steps left'
}

/**
 * The bar of one session, or null when it gets none (idle, unknown, asleep). `waiting`: the session
 * is blocked on a permission request right now.
 */
export function barView(p: SessionProgress | null | undefined, waiting = false): BarView | null {
  if (!p || p.kind === 'idle') return null
  const determinate = isDeterminate(p)
  // A plan or helper count of zero items is not a count.
  if (!determinate && p.kind !== 'working') return null
  const finished = p.finishedAt !== undefined
  const tone: BarTone = finished ? 'finished' : p.stopped ? 'stopped' : waiting ? 'waiting' : 'live'
  const source = sourceText(p)
  const parts = [source]
  if (finished) parts.push('done')
  else if (p.stopped) parts.push(STOPPED_TEXT[p.stopped] ?? 'stopped')
  else if (waiting) parts.push('waiting on you')
  const view: BarView = {
    mode: determinate ? 'determinate' : 'indeterminate',
    fraction: fractionOf(p),
    tone,
    label: determinate ? `${Math.min(count(p.done), count(p.total))}/${count(p.total)}` : '',
    tooltip: parts.join(' · ')
  }
  if (p.current && !finished) view.current = p.current
  return view
}

/** The session's progress out of a snapshot's list. */
export function progressById(sessions: readonly SessionProgress[] | undefined): Readonly<Record<string, SessionProgress>> {
  const out: Record<string, SessionProgress> = {}
  for (const s of sessions ?? []) if (s && typeof s.sessionId === 'string') out[s.sessionId] = s
  return out
}

/** A snapshot from the bridge, made safe (an older or broken main process sends something else). */
export function cleanSnapshot(input: unknown): ProgressSnapshot {
  const o = input && typeof input === 'object' ? (input as Partial<ProgressSnapshot>) : {}
  return {
    sessions: Array.isArray(o.sessions) ? o.sessions.filter((s) => !!s && typeof s.sessionId === 'string') : [],
    orders: Array.isArray(o.orders) ? o.orders.filter((x) => !!x && typeof x.id === 'string' && Array.isArray(x.sessions)) : []
  }
}

// ---- the step list (Inspect tab) -----------------------------------------------------------------

export const STEP_GLYPH: Record<ProgressStep['status'], string> = { completed: '✓', 'in-progress': '▸', pending: '○' }
export const STEPS_COLLAPSED = 6

export interface StepWindow {
  /** Index of the first step shown. */
  start: number
  /** One past the last step shown. */
  end: number
  /** Steps hidden above / below. */
  before: number
  after: number
}

/**
 * Which steps a collapsed list shows: at most `max`, around the step in progress (or the first one
 * that is not done), so the list never hides what is being worked on.
 */
export function stepWindow(steps: readonly ProgressStep[], max = STEPS_COLLAPSED): StepWindow {
  const n = steps.length
  if (n <= max) return { start: 0, end: n, before: 0, after: 0 }
  let focus = steps.findIndex((s) => s.status === 'in-progress')
  if (focus < 0) focus = steps.findIndex((s) => s.status !== 'completed')
  if (focus < 0) focus = n - 1
  // One finished step above the current one for context, the rest below.
  const start = Math.max(0, Math.min(focus - 1, n - max))
  return { start, end: start + max, before: start, after: n - start - max }
}

// ---- orders: a major task across several teams ---------------------------------------------------

/** Does this order get the big bar? (An order to one session is that session's own bar.) */
export function showOrderBar(o: Pick<OrderProgress, 'sessions'>): boolean {
  return o.sessions.length >= ORDER_BAR_MIN_SESSIONS
}

/** The orders the world's top strip shows, newest first, at most `max`. */
export function orderBars(orders: readonly OrderProgress[] | undefined, max = 2): OrderProgress[] {
  return (orders ?? []).filter(showOrderBar).slice(-max).reverse()
}

/**
 * How far one team is with the order, 0..1; null for a team that failed (it is left out of the
 * average). A team without a real count is 0 while it works and 1 when it is done.
 */
export function teamFraction(row: OrderSessionProgress): number | null {
  if (row.state === 'failed') return null
  if (row.state === 'done') return 1
  if (row.state === 'queued') return 0
  if (row.progress?.finishedAt !== undefined) return 1
  return isDeterminate(row.progress) ? fractionOf(row.progress) : 0
}

/** The order's overall bar: the average of its teams' fractions (failed teams left out). */
export function orderFraction(o: Pick<OrderProgress, 'sessions'>): number {
  const parts = o.sessions.map(teamFraction).filter((f): f is number => f !== null)
  if (parts.length === 0) return 0
  return clamp01(parts.reduce((a, b) => a + b, 0) / parts.length)
}

export interface OrderView {
  /** "2 of 4 teams done" / "All 4 teams done" / "3 of 4 teams done · 1 failed" */
  label: string
  fraction: number
  finished: boolean
  /** Every team is done (none failed). */
  allDone: boolean
  failed: number
  tooltip: string
}

export function orderView(o: OrderProgress): OrderView {
  const total = o.sessions.length
  const done = o.sessions.filter((s) => s.state === 'done').length
  const failed = o.sessions.filter((s) => s.state === 'failed').length
  const finished = o.finishedAt !== undefined || done + failed === total
  const allDone = finished && failed === 0 && total > 0
  const teams = total === 1 ? 'team' : 'teams'
  const label = allDone ? (total === 1 ? 'Done' : total === 2 ? 'Both teams done' : `All ${total} teams done`) : `${done} of ${total} ${teams} done${failed > 0 ? ` · ${failed} failed` : ''}`
  const fraction = orderFraction(o)
  return {
    label,
    fraction,
    finished,
    allDone,
    failed,
    tooltip: `${label}. The bar is the average of the teams: a team with a plan counts its steps, a team without one counts once it is done.`
  }
}

const ROW_STATE: Record<OrderSessionProgress['state'], string> = { queued: 'Queued', working: 'Working', waiting: 'Waiting on you', done: 'Done', failed: 'Failed' }

/** "Working" / "Done" / "Failed: the session ended" */
export function rowStateText(row: OrderSessionProgress): string {
  const base = ROW_STATE[row.state] ?? String(row.state)
  return row.state === 'failed' && row.reason ? `${base}: ${row.reason}` : base
}

/** One team's bar inside an order: its own progress, or what its state says. */
export function rowBar(row: OrderSessionProgress): BarView | null {
  if (row.state === 'done') return { mode: 'determinate', fraction: 1, tone: 'finished', label: row.progress && isDeterminate(row.progress) ? `${count(row.progress.total)}/${count(row.progress.total)}` : '', tooltip: 'Done' }
  if (row.state === 'failed') return { mode: 'determinate', fraction: 0, tone: 'stopped', label: '', tooltip: rowStateText(row) }
  if (row.state === 'queued') return { mode: 'determinate', fraction: 0, tone: 'live', label: '', tooltip: 'Queued: it has not started on the order yet' }
  return barView(row.progress, row.state === 'waiting') ?? { mode: 'indeterminate', fraction: 0, tone: row.state === 'waiting' ? 'waiting' : 'live', label: '', tooltip: row.state === 'waiting' ? 'Working · waiting on you' : 'Working' }
}

/** What a session's branch sign shows in the world: the bar without the words. */
export interface SignBar {
  mode: BarMode
  fraction: number
  tone: BarTone
  label: string
}

/** The sign bars of every session that has one, by session id (= team id in the world). */
export function signBars(sessions: readonly SessionProgress[], waiting: ReadonlySet<string>): Map<string, SignBar> {
  const out = new Map<string, SignBar>()
  for (const s of sessions) {
    const v = barView(s, waiting.has(s.sessionId))
    if (v) out.set(s.sessionId, { mode: v.mode, fraction: v.fraction, tone: v.tone, label: v.label })
  }
  return out
}
