// Per-agent stats for the inspector (shared/inspector.ts): what each agent in the world is doing,
// for how long, with which tools, on which files, and what it costs. Two feeds:
// - every AgentEvent that goes through the event bus (hosted sessions, their subagents, observed /
//   external sessions, simulated ones): activity, counts, the recent log, the time spent working;
// - facts only a driver knows (AgentFact): the task, turns, tokens, changed files, the worker type.
// What the session manager knows anyway (model, folder, state, the pending questions, the board
// claim) is not copied in here: `details()` asks for it when it builds an answer (StatsSources).
//
// Read-only by construction: nothing in here can reach an agent.
// Pure: no Electron, no file system, an injectable clock and scheduler (the tests use fakes).
import type { Activity, AgentEvent } from '../shared/events'
import { DETAIL_QUESTION } from '../shared/details'
import {
  INSPECT_MAX_EVENTS,
  INSPECT_MAX_FILES,
  INSPECT_PREVIEW_CHARS,
  INSPECT_PUSH_MS,
  type AgentDetails,
  type InspectedEvent,
  type TokenUsage
} from '../shared/inspector'
import type { PermissionRequestInfo, SessionInfo } from '../shared/sessions'

/** A finished agent (and so a manager's finished worker) is kept this long, then dropped. */
export const STATS_DONE_TTL_MS = 10 * 60_000
export const STATS_MAX_AGENTS = 300
/** At most this many workers are listed for a manager (newest first). */
export const STATS_MAX_WORKERS = 30
const NAME_MAX = 100
const MODEL_MAX = 100
const PATH_MAX = 300

export type FileChangeKind = 'create' | 'edit' | 'delete'

/** Something a driver (or the session manager) knows about one agent of the world. */
export type AgentFact =
  /** What a manager was asked to do: a one-line preview of the prompt. */
  | { kind: 'task'; agentId: string; text: string }
  /** A worker's type ("Explore") and what it was asked to do (its description), as far as known. */
  | { kind: 'worker'; agentId: string; agentType?: string; task?: string }
  /** One more real prompt was answered / taken on. */
  | { kind: 'turn'; agentId: string }
  /** The usage so far (already summed up by whoever reports it), and the model if the source names it. */
  | { kind: 'tokens'; agentId: string; usage: TokenUsage; model?: string }
  | { kind: 'file'; agentId: string; path: string; change: FileChangeKind }
  /** Working although the world shows no activity (a turn that is thinking), or no longer. */
  | { kind: 'busy'; agentId: string; busy: boolean }
  | { kind: 'model'; agentId: string; model: string }

/** What the caller of `details()` knows about hosted sessions. Everything is optional. */
export interface StatsSources {
  /** The hosted session whose manager has this world id (also a sleeping one). */
  session?(agentId: string): SessionInfo | undefined
  /** The pending permission requests, oldest first. */
  pending?(): PermissionRequestInfo[]
  /** The newest office-board claim of a hosted session. */
  claim?(sessionId: string): { task: string; ts: number } | undefined
}

export interface AgentStatsOptions {
  now?: () => number
  /** Something about this agent changed (also called for its manager when a worker changes). */
  onChange?: (agentId: string) => void
  doneTtlMs?: number
  maxAgents?: number
}

interface Entry {
  agentId: string
  /** False until the first AgentEvent: a fact may arrive before its agent is in the world. */
  seen: boolean
  parentId: string | null
  displayName: string
  provider: string
  model?: string
  createdAt: number
  startedAt: number
  lastActiveAt: number
  activity: Activity
  detail: string
  /** When the current activity + detail began. */
  since: number
  /** What it was doing when it started to wait on the user (to tell "carries on" from "starts"). */
  beforeWait: { activity: Activity; detail: string } | null
  busy: boolean
  activeMs: number
  /** Set while the clock runs. */
  activeSince: number | null
  doneAt: number | null
  counts: Partial<Record<Activity, number>>
  recent: InspectedEvent[]
  files: AgentDetails['files']
  turns: number
  turnsKnown: boolean
  tokens?: TokenUsage
  task?: { text: string; ts: number }
  agentType?: string
}

const oneLine = (text: string, max = INSPECT_PREVIEW_CHARS): string => {
  const flat = text
    .slice(0, 4000)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/** A usage object from anywhere, made safe: whole non-negative numbers, optional parts only when present. */
export function cleanUsage(u: TokenUsage): TokenUsage {
  const out: TokenUsage = { input: count(u.input), output: count(u.output), total: count(u.total) }
  if (u.cached !== undefined) out.cached = count(u.cached)
  if (u.reasoning !== undefined) out.reasoning = count(u.reasoning)
  if (u.contextUsed !== undefined) out.contextUsed = count(u.contextUsed)
  if (u.contextWindow !== undefined && count(u.contextWindow) > 0) out.contextWindow = count(u.contextWindow)
  if (out.total === 0) out.total = out.input + out.output + (out.cached ?? 0)
  return out
}

/** The clock runs while an agent is in the world and not idle (waiting on the user counts as working time). */
const runs = (e: Entry): boolean => e.doneAt === null && e.seen && (e.busy || (e.activity !== 'idle' && e.activity !== 'done'))

export class AgentStats {
  private entries = new Map<string, Entry>()
  private readonly now: () => number
  private readonly onChange: (agentId: string) => void
  private readonly doneTtlMs: number
  private readonly maxAgents: number

  constructor(opts: AgentStatsOptions = {}) {
    this.now = opts.now ?? Date.now
    this.onChange = opts.onChange ?? (() => {})
    this.doneTtlMs = opts.doneTtlMs ?? STATS_DONE_TTL_MS
    this.maxAgents = opts.maxAgents ?? STATS_MAX_AGENTS
  }

  get size(): number {
    return this.entries.size
  }

  has(agentId: string): boolean {
    return this.entries.get(agentId)?.seen === true
  }

  // ---- feed 1: the event bus ----

  event(ev: AgentEvent): void {
    if (!ev || typeof ev.agentId !== 'string' || ev.agentId.length === 0) return
    const now = this.now()
    this.sweep(now)
    const e = this.entry(ev.agentId, now)
    const detail = oneLine(typeof ev.detail === 'string' ? ev.detail : '')
    const first = !e.seen
    if (first) {
      e.seen = true
      e.startedAt = now
    }
    e.parentId = typeof ev.parentId === 'string' && ev.parentId.length > 0 && ev.parentId !== ev.agentId ? ev.parentId : null
    if (typeof ev.displayName === 'string' && ev.displayName) e.displayName = oneLine(ev.displayName, NAME_MAX)
    if (typeof ev.provider === 'string' && ev.provider) e.provider = ev.provider.slice(0, NAME_MAX)
    // The same id again after `done` (an external session that was resumed): it is back.
    if (e.doneAt !== null && ev.activity !== 'done') e.doneAt = null
    // A START: another activity, or the same one on something else. A repeat (a rename, a replay) is not.
    if (first || ev.activity !== e.activity || detail !== e.detail) {
      // Back to exactly what it did before it had to wait for the user: it carries on, it does not start again.
      const carriesOn = e.activity === 'waiting' && e.beforeWait?.activity === ev.activity && e.beforeWait.detail === detail
      if (ev.activity === 'waiting' && e.activity !== 'waiting') e.beforeWait = first ? null : { activity: e.activity, detail: e.detail }
      else if (ev.activity !== 'waiting') e.beforeWait = null
      if (!carriesOn) e.counts[ev.activity] = (e.counts[ev.activity] ?? 0) + 1
      const head = e.recent[0]
      if (!head || head.activity !== ev.activity || head.detail !== detail) {
        e.recent.unshift({ ts: now, activity: ev.activity, detail })
        if (e.recent.length > INSPECT_MAX_EVENTS) e.recent.length = INSPECT_MAX_EVENTS
      }
      e.since = now
    }
    e.activity = ev.activity
    e.detail = detail
    e.lastActiveAt = now
    if (ev.activity === 'done') {
      e.doneAt = now
      e.busy = false
    }
    this.clock(e, now)
    this.changed(e)
  }

  // ---- feed 2: what the drivers know ----

  fact(f: AgentFact): void {
    if (!f || typeof f.agentId !== 'string' || f.agentId.length === 0) return
    const now = this.now()
    const e = this.entry(f.agentId, now)
    switch (f.kind) {
      case 'task': {
        const text = oneLine(f.text)
        if (!text) return
        e.task = { text, ts: now }
        break
      }
      case 'worker': {
        const type = f.agentType ? oneLine(f.agentType, NAME_MAX) : ''
        const task = f.task ? oneLine(f.task) : ''
        if (!type && !task) return
        if (type) e.agentType = type
        if (task) e.task = { text: task, ts: now }
        break
      }
      case 'turn':
        e.turns++
        e.turnsKnown = true
        break
      case 'tokens': {
        e.tokens = cleanUsage(f.usage)
        if (f.model && !e.model) e.model = f.model.slice(0, MODEL_MAX)
        break
      }
      case 'file': {
        const path = oneLine(f.path, PATH_MAX)
        if (!path) return
        const earlier = e.files.find((x) => x.path === path)
        e.files = e.files.filter((x) => x !== earlier)
        // A file created and then edited is still a new file.
        e.files.unshift({ path, ts: now, kind: f.change === 'edit' && earlier?.kind === 'create' ? 'create' : f.change })
        if (e.files.length > INSPECT_MAX_FILES) e.files.length = INSPECT_MAX_FILES
        break
      }
      case 'busy':
        if (e.busy === f.busy) return
        e.busy = f.busy && e.doneAt === null
        this.clock(e, now)
        break
      case 'model':
        if (!f.model || e.model === f.model) return
        e.model = f.model.slice(0, MODEL_MAX)
        break
      default:
        return
    }
    this.changed(e)
  }

  // ---- the answer ----

  /** Everything known about one agent, or null when it is not (or no longer) known. */
  details(agentId: string, sources: StatsSources = {}): AgentDetails | null {
    const now = this.now()
    this.sweep(now)
    const found = this.entries.get(agentId)
    const e = found?.seen ? found : undefined
    const session = sources.session?.(agentId)
    if (!e && !session) return null

    const parentId = e?.parentId ?? null
    const rootId = e ? this.rootOf(e) : agentId
    const hosted = session ?? (rootId !== agentId ? sources.session?.(rootId) : undefined)
    const activity: Activity = e?.activity ?? (session?.state === 'exited' ? 'done' : 'idle')
    const d: AgentDetails = {
      agentId,
      role: parentId ? 'worker' : 'manager',
      displayName: e?.displayName || session?.title || agentId.slice(0, 12),
      provider: session?.provider ?? e?.provider ?? 'unknown',
      state: session ? session.state : activity === 'done' ? 'done' : activity === 'waiting' ? 'waiting' : activity === 'idle' && !e?.busy ? 'idle' : 'working',
      activity,
      detail: e?.detail ?? '',
      startedAt: session?.startedAt ?? e?.startedAt ?? now,
      lastActiveAt: Math.max(e?.lastActiveAt ?? 0, session?.lastActiveAt ?? 0) || (session?.startedAt ?? now),
      activeMs: e ? e.activeMs + (e.activeSince === null ? 0 : Math.max(0, now - e.activeSince)) : 0,
      counts: { ...(e?.counts ?? {}) },
      files: (e?.files ?? []).map((f) => ({ ...f })),
      recent: (e?.recent ?? []).map((r) => ({ ...r }))
    }
    // A hosted manager is spawned with the detail "starting"; once its session is ready that says nothing.
    if (session && d.activity === 'idle' && d.detail === 'starting' && session.state !== 'starting' && session.state !== 'needs-attention') d.detail = ''
    if (hosted) d.sessionId = hosted.id
    if (parentId) d.parentId = parentId
    const model = session?.model ?? e?.model
    if (model) d.model = model
    if (hosted?.cwd) d.cwd = hosted.cwd
    if (e?.agentType) d.agentType = e.agentType
    if (e?.tokens) d.tokens = { ...e.tokens }
    // Hosted managers always know their turns (0 until the first prompt); others only once one was reported.
    if (e ? e.turnsKnown || !!session : !!session) d.turns = e?.turns ?? 0

    // What it was asked to do: the newer of the last prompt and the board claim; a saved preview otherwise.
    let task = e?.task
    const claim = session ? sources.claim?.(session.id) : undefined
    if (claim?.task && (!task || claim.ts >= task.ts)) task = { text: oneLine(claim.task), ts: claim.ts }
    const text = task?.text || (session?.lastPrompt ? oneLine(session.lastPrompt) : '')
    if (text) d.task = text

    // Blocked on the user: the oldest pending request of this agent, or the question it asked.
    const pending = sources.pending?.().find((p) => p.agentId === agentId)
    if (pending) d.waitingOn = { question: oneLine(pending.question, 240), risk: pending.risk, since: pending.createdAt }
    else if (e && e.activity === 'waiting' && e.detail.startsWith(DETAIL_QUESTION)) {
      d.waitingOn = { question: e.detail.slice(DETAIL_QUESTION.length), risk: 'normal', since: e.since }
    }

    if (!parentId) {
      d.workers = [...this.entries.values()]
        .filter((w) => w.seen && w.parentId === agentId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, STATS_MAX_WORKERS)
        .map((w) => {
          const row: NonNullable<AgentDetails['workers']>[number] = {
            agentId: w.agentId,
            displayName: w.displayName,
            activity: w.activity,
            done: w.doneAt !== null,
            startedAt: w.startedAt
          }
          if (w.agentType) row.agentType = w.agentType
          if (w.task) row.task = w.task.text
          return row
        })
    }
    return d
  }

  // ---- internals ----

  private entry(agentId: string, now: number): Entry {
    let e = this.entries.get(agentId)
    if (e) return e
    e = {
      agentId,
      seen: false,
      parentId: null,
      displayName: '',
      provider: 'unknown',
      createdAt: now,
      startedAt: now,
      lastActiveAt: now,
      activity: 'idle',
      detail: '',
      since: now,
      beforeWait: null,
      busy: false,
      activeMs: 0,
      activeSince: null,
      doneAt: null,
      counts: {},
      recent: [],
      files: [],
      turns: 0,
      turnsKnown: false
    }
    this.entries.set(agentId, e)
    if (this.entries.size > this.maxAgents) this.evict(agentId)
    return e
  }

  /** Starts or stops the agent's working clock after a change. */
  private clock(e: Entry, now: number): void {
    const on = runs(e)
    if (on && e.activeSince === null) e.activeSince = now
    else if (!on && e.activeSince !== null) {
      e.activeMs += Math.max(0, now - e.activeSince)
      e.activeSince = null
    }
  }

  private rootOf(e: Entry): string {
    let at = e
    for (let depth = 0; depth < 16 && at.parentId; depth++) {
      const parent = this.entries.get(at.parentId)
      if (!parent) return at.parentId
      at = parent
    }
    return at.agentId
  }

  private changed(e: Entry): void {
    this.onChange(e.agentId)
    if (e.parentId) this.onChange(e.parentId)
  }

  /** Finished agents, and facts whose agent never showed up, go after the retention time. */
  private sweep(now: number): void {
    for (const [id, e] of this.entries) {
      if (e.doneAt !== null ? now - e.doneAt > this.doneTtlMs : !e.seen && now - e.createdAt > this.doneTtlMs) this.entries.delete(id)
    }
  }

  /** Over the cap: finished agents go first (longest gone first), then whoever was active longest ago. */
  private evict(keep: string): void {
    while (this.entries.size > this.maxAgents) {
      let victim: Entry | null = null
      const rank = (e: Entry): [number, number] => (e.doneAt !== null ? [0, e.doneAt] : !e.seen ? [1, e.createdAt] : [2, e.lastActiveAt])
      for (const e of this.entries.values()) {
        if (e.agentId === keep) continue
        if (!victim) {
          victim = e
          continue
        }
        const [a, at] = rank(e)
        const [b, bt] = rank(victim)
        if (a < b || (a === b && at < bt)) victim = e
      }
      if (!victim) return
      this.entries.delete(victim.agentId)
    }
  }
}

// ---- watching one agent (the renderer's inspector panel) ---------------------------------------------

/** Runs `fn` after `ms`; returns a cancel function. */
export type WatchScheduler = (fn: () => void, ms: number) => () => void

export interface InspectorWatchOptions<K> {
  /** The current details of an agent (null = unknown). */
  details(agentId: string): AgentDetails | null
  /** Delivers a push to the watcher `key`. */
  send(key: K, details: AgentDetails): void
  now?: () => number
  schedule?: WatchScheduler
  /** Default: INSPECT_PUSH_MS. */
  intervalMs?: number
}

interface Watch {
  agentId: string
  /** What was last given to the watcher, serialised. */
  sent: string
  sentAt: number
  cancel: (() => void) | null
}

const defaultSchedule: WatchScheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/**
 * One watch per key (a window). While a watch is on, its agent is looked at once per interval (and
 * sooner after `poke()`, if the interval allows) and pushed when its details differ from what the
 * watcher already has. So: at most one push per interval, and none while nothing changes. A working
 * agent's `activeMs` moves, so it is pushed about once per interval; an idle one is not.
 */
export class InspectorWatch<K> {
  private watches = new Map<K, Watch>()
  private readonly now: () => number
  private readonly schedule: WatchScheduler
  private readonly interval: number

  constructor(private readonly opts: InspectorWatchOptions<K>) {
    this.now = opts.now ?? Date.now
    this.schedule = opts.schedule ?? defaultSchedule
    this.interval = opts.intervalMs ?? INSPECT_PUSH_MS
  }

  get size(): number {
    return this.watches.size
  }

  /** Which agent this key watches, if any. */
  watching(key: K): string | undefined {
    return this.watches.get(key)?.agentId
  }

  /** Starts (or replaces) the watch of `key` and returns the agent's current details. */
  watch(key: K, agentId: string): AgentDetails | null {
    this.unwatch(key)
    const details = this.opts.details(agentId)
    const w: Watch = { agentId, sent: details ? JSON.stringify(details) : '', sentAt: this.now(), cancel: null }
    this.watches.set(key, w)
    this.arm(key, w, this.interval)
    return details
  }

  unwatch(key: K): void {
    const w = this.watches.get(key)
    if (!w) return
    w.cancel?.()
    w.cancel = null
    this.watches.delete(key)
  }

  clear(): void {
    for (const key of [...this.watches.keys()]) this.unwatch(key)
  }

  /** Something changed somewhere: look again as soon as the interval allows (never synchronously). */
  poke(): void {
    const now = this.now()
    for (const [key, w] of this.watches) {
      w.cancel?.()
      this.arm(key, w, Math.max(0, w.sentAt + this.interval - now))
    }
  }

  private arm(key: K, w: Watch, ms: number): void {
    w.cancel = this.schedule(() => {
      if (this.watches.get(key) !== w) return
      w.cancel = null
      this.check(key, w)
      if (this.watches.get(key) === w && !w.cancel) this.arm(key, w, this.interval)
    }, ms)
  }

  private check(key: K, w: Watch): void {
    const now = this.now()
    if (now - w.sentAt < this.interval) return
    let details: AgentDetails | null = null
    try {
      details = this.opts.details(w.agentId)
    } catch {
      return
    }
    // Gone (a finished agent that was dropped): nothing to say; the watch stays in case it comes back.
    if (!details) return
    const text = JSON.stringify(details)
    if (text === w.sent) return
    w.sent = text
    w.sentAt = now
    try {
      this.opts.send(key, details)
    } catch {
      // a window that is going away
    }
  }
}
