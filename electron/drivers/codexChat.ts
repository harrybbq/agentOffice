// Codex app-server items and notifications -> the app's provider-agnostic chat model
// (shared/chat.ts): a bounded ChatItem list per session and the ChatEvents that keep an attached
// renderer in step with it. Pure (no clock, no I/O): the driver passes the time in, so the tests can
// replay the JSON recorded in docs/spikes-phase-b.md.
//
// Rules the renderer can rely on:
// - An `item` event inserts the item at the end, or replaces the item with the same id in place.
// - A `delta` event always refers to an item that an earlier `item` event introduced.
// - `turn started` comes before the turn's items; `turn completed/interrupted/failed` comes after
//   every item of the turn was closed (nothing of that turn is `running` or `streaming` any more).
// - An item of a turn that has ended never opens again: Codex announces a command's process start
//   (`item/started`, with the output so far) even after the turn it belongs to was interrupted.
import {
  CHAT_MAX_DIFF_CHARS,
  CHAT_MAX_ITEMS,
  CHAT_MAX_OUTPUT_CHARS,
  type ChatEvent,
  type ChatItem,
  type ChatItemStatus
} from '../../shared/chat'
import type { PermissionRisk } from '../../shared/permissionText'
import { subagentId } from '../../shared/sessions'
import { describeToolInput } from '../permissions'
import { arr, commandIntent, describeTurnError, innerCommand, isRecord, num, str } from './codexProtocol'

export type UserOrigin = Extract<ChatItem, { kind: 'user' }>['origin']
export type ApprovalOutcome = Extract<ChatItem, { kind: 'approval' }>['outcome']
type CommandItem = Extract<ChatItem, { kind: 'command' }>
type FileChange = Extract<ChatItem, { kind: 'file-change' }>['changes'][number]

export interface ChatContext {
  /** World agent the event belongs to: the session, or one of its sub-agents. */
  agentId: string
  /** Unix ms, used when the notification carries no time of its own. */
  now: number
}

export interface ChatLimits {
  maxItems: number
  maxOutputChars: number
  maxDiffChars: number
}

const DEFAULT_LIMITS: ChatLimits = { maxItems: CHAT_MAX_ITEMS, maxOutputChars: CHAT_MAX_OUTPUT_CHARS, maxDiffChars: CHAT_MAX_DIFF_CHARS }
const MAX_TEXT_CHARS = 200_000
const MAX_RESULT_CHARS = 8000
const MAX_CHANGES = 200
/** While a command's output is over the cap, the renderer gets the new tail at most this often. */
const TRUNCATED_REFRESH_MS = 1000
const CLIENT_ID = /^ao-(human|order|steer|system)-[0-9a-f]{8,64}$/

/**
 * The `clientUserMessageId` of a prompt the app sends. Codex echoes it as `clientId` on the user
 * item and keeps it in the thread's history, so it carries the origin across a resume and serves
 * as the chat item's id (one id from the moment the prompt is accepted).
 */
export function clientMessageId(origin: UserOrigin, random: string): string {
  return `ao-${origin}-${random}`
}

/** The origin in a `clientId` this app made, or null for anybody else's. */
export function originOfClientId(clientId: unknown): UserOrigin | null {
  const m = typeof clientId === 'string' ? CLIENT_ID.exec(clientId) : null
  return m ? (m[1] as UserOrigin) : null
}

const tail = (s: string, max: number): string => (s.length > max ? s.slice(s.length - max) : s)
const head = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n…` : s)

const STATUS: Record<string, ChatItemStatus> = {
  inProgress: 'running',
  completed: 'done',
  failed: 'failed',
  declined: 'declined',
  interrupted: 'interrupted'
}
const status = (v: unknown, completed: boolean): ChatItemStatus => {
  const s = STATUS[str(v, 40)]
  // History and `item/completed` never leave an item running.
  return s === undefined || (s === 'running' && completed) ? (completed ? 'done' : 'running') : s
}

type TurnEnd = 'completed' | 'interrupted' | 'failed'
/** How many ended turns are remembered (for notifications that arrive after their turn's end). */
const ENDED_TURNS_KEPT = 50

/** `item` as it is left when its turn ends: nothing keeps spinning. Null = it was not open. */
function closedAs(item: ChatItem, how: TurnEnd): ChatItem | null {
  if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) return { ...item, streaming: false }
  if ('status' in item && item.status === 'running') return { ...item, status: how === 'completed' ? 'done' : how }
  if (item.kind === 'approval' && item.outcome === 'pending') return { ...item, outcome: 'resolved-elsewhere' }
  return null
}

/** The text of a `userMessage` item: its text parts, with a marker for anything else. */
export function userText(content: unknown): string {
  return arr(content)
    .map((c) => (isRecord(c) ? (c.type === 'text' ? str(c.text, MAX_TEXT_CHARS) : `[${str(c.type, 40) || 'attachment'}]`) : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}

/**
 * `changes[].diff` as a unified diff. For an added (or deleted) file Codex sends the file's
 * content, not a diff: it becomes one hunk of `+` (or `-`) lines.
 */
export function unifiedDiff(kind: string, diff: string, maxChars = CHAT_MAX_DIFF_CHARS): string {
  if (diff.length === 0) return ''
  if ((kind !== 'add' && kind !== 'delete') || /^(@@ |diff --git |--- |\*\*\* )/.test(diff)) return head(diff, maxChars)
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const sign = kind === 'add' ? '+' : '-'
  const header = kind === 'add' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`
  return head(`${header}\n${lines.map((l) => sign + l).join('\n')}\n`, maxChars)
}

function fileChanges(changes: unknown, maxDiff: number): FileChange[] {
  return arr(changes)
    .slice(0, MAX_CHANGES)
    .filter(isRecord)
    .map((c) => {
      const kind = isRecord(c.kind) ? str(c.kind.type, 20) : ''
      const change: FileChange = {
        path: str(c.path, 2000),
        change: kind === 'add' || kind === 'delete' ? kind : 'update',
        diff: unifiedDiff(kind, str(c.diff, maxDiff + 1), maxDiff)
      }
      const moved = isRecord(c.kind) ? str(c.kind.move_path, 2000) : ''
      if (moved) change.movedTo = moved
      return change
    })
}

function toolResult(item: Record<string, unknown>): string | undefined {
  const result = item.result
  const content = isRecord(result) ? arr(result.content) : arr(item.contentItems)
  const texts = content.map((c) => (isRecord(c) ? str(c.text, MAX_RESULT_CHARS) : '')).filter((t) => t.length > 0)
  if (texts.length > 0) return head(texts.join('\n'), MAX_RESULT_CHARS)
  if (isRecord(result) && result.structuredContent != null) return head(describeToolInput(result.structuredContent), MAX_RESULT_CHARS)
  return undefined
}

/** The steps of a `turn/plan/updated` notification (`plan: [{ step, status }]`), in order. */
export function planSteps(params: Record<string, unknown>): Array<{ text: string; status: 'pending' | 'in-progress' | 'completed' }> {
  return arr(params.plan)
    .slice(0, 200)
    .filter(isRecord)
    .map((s) => ({
      text: str(s.step, 2000),
      status: s.status === 'completed' ? ('completed' as const) : s.status === 'inProgress' ? ('in-progress' as const) : ('pending' as const)
    }))
}

const SUBAGENT_ACTIONS: Record<string, Extract<ChatItem, { kind: 'subagent' }>['action']> = {
  spawnAgent: 'spawn',
  sendInput: 'message',
  sendMessage: 'message',
  followupTask: 'message',
  resumeAgent: 'message',
  wait: 'wait',
  listAgents: 'wait',
  closeAgent: 'close',
  interruptAgent: 'close'
}

export class CodexChat {
  /** Insertion order = display order. Replacing a value keeps its place. */
  private items = new Map<string, ChatItem>()
  private seq = 0
  /** Prompts the driver sent, by `clientUserMessageId`, until the server echoed them as items. */
  private sent = new Map<string, { origin: UserOrigin; text: string }>()
  /** Codex item id -> chat item id, for a user message shown under the id we sent it with. */
  private alias = new Map<string, string>()
  /** Commands over the output cap: when the renderer last got the tail. */
  private refreshedAt = new Map<string, number>()
  /** How the last turns ended (newest last). */
  private ended = new Map<string, TurnEnd>()
  private readonly limits: ChatLimits

  constructor(
    readonly sessionId: string,
    limits: Partial<ChatLimits> = {}
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  /** A copy of the list, oldest first. */
  list(): ChatItem[] {
    return [...this.items.values()]
  }

  get(id: string): ChatItem | undefined {
    return this.items.get(id)
  }

  resetEvent(): ChatEvent {
    return { type: 'reset', sessionId: this.sessionId, items: this.list() }
  }

  // ---- what the driver did -----------------------------------------------------------------------

  /** A prompt is about to be sent with this `clientUserMessageId`: its echo gets this origin. */
  expectUser(clientId: string, text: string, origin: UserOrigin): void {
    this.sent.set(clientId, { origin, text })
    if (this.sent.size > 100) this.sent.delete(this.sent.keys().next().value as string)
  }

  /** The request failed: no echo will come. */
  forgetUser(clientId: string): void {
    this.sent.delete(clientId)
  }

  /** The server accepted the prompt: show it now (the echo may come much later for a steer). */
  userSent(clientId: string, ctx: ChatContext, turnId?: string): ChatEvent[] {
    const s = this.sent.get(clientId)
    if (!s || this.items.has(clientId)) return []
    const item: ChatItem = { id: clientId, sessionId: this.sessionId, agentId: ctx.agentId, ts: ctx.now, kind: 'user', text: s.text, origin: s.origin }
    if (turnId) item.turnId = turnId
    return [this.put(item)]
  }

  approvalRequested(
    a: { requestId: string; subjectId?: string; summary: string; detail: string; question?: string; risk?: PermissionRisk; riskNote?: string; turnId?: string },
    ctx: ChatContext
  ): ChatEvent[] {
    const item: ChatItem = {
      id: `approval:${a.requestId}`,
      sessionId: this.sessionId,
      agentId: ctx.agentId,
      ts: ctx.now,
      kind: 'approval',
      requestId: a.requestId,
      summary: a.summary,
      detail: a.detail,
      outcome: 'pending'
    }
    if (item.kind === 'approval') {
      if (a.question) item.question = a.question
      if (a.risk) item.risk = a.risk
      if (a.riskNote) item.riskNote = a.riskNote
    }
    if (a.turnId) item.turnId = a.turnId
    if (a.subjectId && this.items.has(a.subjectId)) item.subjectId = a.subjectId
    return [this.put(item)]
  }

  approvalResolved(requestId: string, outcome: ApprovalOutcome): ChatEvent[] {
    const item = this.items.get(`approval:${requestId}`)
    if (!item || item.kind !== 'approval' || item.outcome !== 'pending') return []
    return [this.put({ ...item, outcome })]
  }

  notice(level: 'info' | 'warning' | 'error', text: string, ctx: ChatContext, opts: { id?: string; turnId?: string } = {}): ChatEvent[] {
    const item: ChatItem = {
      id: opts.id ?? `notice:${++this.seq}`,
      sessionId: this.sessionId,
      agentId: ctx.agentId,
      ts: ctx.now,
      kind: 'notice',
      level,
      text: str(text, 2000)
    }
    if (opts.turnId) item.turnId = opts.turnId
    return [this.put(item)]
  }

  /**
   * Closes what a turn left open. Codex sends no `item/completed` for the command that was running
   * when a turn was interrupted, so the driver calls this for every `turn/completed`.
   * Without a turn id (the server died) everything open is closed.
   */
  closeOpen(turnId: string | null, how: TurnEnd): ChatEvent[] {
    const events: ChatEvent[] = []
    for (const item of [...this.items.values()]) {
      if (turnId !== null && item.turnId !== turnId) continue
      const closed = closedAs(item, how)
      if (closed) events.push(this.put(closed))
    }
    return events
  }

  /** `item`, closed if its turn has already ended (a notification that arrived after `turn/completed`). */
  private settled(item: ChatItem): ChatItem {
    const how = item.turnId ? this.ended.get(item.turnId) : undefined
    return (how && closedAs(item, how)) || item
  }

  /** Rebuilds the list from `thread/turns/list` (oldest turn first, `itemsView: "full"`). Returns the reset. */
  loadHistory(turns: readonly unknown[], ctx: ChatContext): ChatEvent {
    this.items.clear()
    this.alias.clear()
    this.refreshedAt.clear()
    for (const turn of turns) {
      if (!isRecord(turn)) continue
      const turnId = str(turn.id, 100)
      const startedAt = num(turn.startedAt)
      const at: ChatContext = { agentId: ctx.agentId, now: startedAt !== null ? startedAt * 1000 : ctx.now }
      const how = turn.status === 'interrupted' || turn.status === 'failed' ? turn.status : 'completed'
      for (const raw of arr(turn.items)) {
        let item = this.convert(raw, true, at, turnId)
        if (!item) continue
        // History records the command an interrupt cut off as failed with exit code -1.
        if (how === 'interrupted' && item.kind === 'command' && item.status === 'failed' && item.exitCode === -1) {
          item = { ...item, status: 'interrupted', exitCode: null }
        }
        this.put(item)
      }
      if (how === 'failed') this.notice('error', describeTurnError(turn.error), at, { id: `error:${turnId}`, turnId })
      else if (how === 'interrupted') this.notice('info', 'Turn interrupted', at, { id: `interrupted:${turnId}`, turnId })
    }
    return this.resetEvent()
  }

  // ---- notifications -----------------------------------------------------------------------------

  /** One server notification of this session's thread (or of a sub-agent's). Unknown methods give nothing. */
  apply(method: string, params: Record<string, unknown>, ctx: ChatContext): ChatEvent[] {
    const turnId = str(params.turnId, 100) || undefined
    const itemId = str(params.itemId, 200)
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const completed = method === 'item/completed'
        const at = num(completed ? params.completedAtMs : params.startedAtMs) ?? ctx.now
        const item = this.convert(params.item, completed, { agentId: ctx.agentId, now: at }, turnId)
        if (!item) return []
        if (completed) this.refreshedAt.delete(item.id)
        return [this.put(this.settled(item))]
      }

      case 'item/agentMessage/delta': {
        const delta = str(params.delta, MAX_TEXT_CHARS)
        if (!itemId || !delta) return []
        const item = this.items.get(itemId)
        if (!item) {
          // The start was missed: open the message with what we have.
          return [this.put(this.settled(this.base(itemId, ctx, turnId, { kind: 'assistant', text: delta, streaming: true })))]
        }
        if (item.kind !== 'assistant') return []
        this.items.set(itemId, { ...item, text: tail(item.text + delta, MAX_TEXT_CHARS) })
        return [{ type: 'delta', sessionId: this.sessionId, itemId, field: 'text', delta }]
      }

      case 'item/commandExecution/outputDelta': {
        const delta = str(params.delta, this.limits.maxOutputChars)
        const item = this.items.get(itemId)
        if (!delta || !item || item.kind !== 'command') return []
        const full = item.output + delta
        if (!item.outputTruncated && full.length <= this.limits.maxOutputChars) {
          this.items.set(itemId, { ...item, output: full })
          return [{ type: 'delta', sessionId: this.sessionId, itemId, field: 'output', delta }]
        }
        // Over the cap: keep the tail. The renderer gets the whole item, not every chunk.
        const next: CommandItem = { ...item, output: tail(full, this.limits.maxOutputChars), outputTruncated: true }
        this.items.set(itemId, next)
        const last = this.refreshedAt.get(itemId)
        if (last !== undefined && ctx.now - last < TRUNCATED_REFRESH_MS) return []
        this.refreshedAt.set(itemId, ctx.now)
        return [{ type: 'item', item: next }]
      }

      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/summaryTextDelta': {
        const index = num(params.summaryIndex) ?? 0
        const delta = method.endsWith('Delta') ? str(params.delta, MAX_TEXT_CHARS) : ''
        if (!itemId || index < 0 || index > 200) return []
        const prev = this.items.get(itemId)
        if (prev && prev.kind !== 'reasoning') return []
        const item = prev ?? this.base(itemId, ctx, turnId, { kind: 'reasoning', summary: [], streaming: true })
        if (item.kind !== 'reasoning') return []
        const known = index < item.summary.length
        const summary = [...item.summary]
        while (summary.length <= index) summary.push('')
        summary[index] = tail(summary[index] + delta, MAX_TEXT_CHARS)
        const next = { ...item, summary }
        // A new part (or a missed start) goes out as the whole item, so a delta never names a part the renderer lacks.
        if (!prev || !known) return [this.put(prev ? next : this.settled(next))]
        this.items.set(itemId, next)
        return delta ? [{ type: 'delta', sessionId: this.sessionId, itemId, field: 'summary', index, delta }] : []
      }

      case 'item/reasoning/textDelta': {
        const delta = str(params.delta, MAX_TEXT_CHARS)
        const item = this.items.get(itemId)
        if (!delta || !item || item.kind !== 'reasoning') return []
        if (item.text === undefined) return [this.put({ ...item, text: delta })]
        this.items.set(itemId, { ...item, text: tail(item.text + delta, MAX_TEXT_CHARS) })
        return [{ type: 'delta', sessionId: this.sessionId, itemId, field: 'text', delta }]
      }

      case 'item/fileChange/patchUpdated': {
        const item = this.items.get(itemId)
        if (!item || item.kind !== 'file-change') return []
        return [this.put({ ...item, changes: fileChanges(params.changes, this.limits.maxDiffChars) })]
      }

      case 'item/mcpToolCall/progress': {
        const item = this.items.get(itemId)
        if (!item || item.kind !== 'tool') return []
        return [this.put({ ...item, progress: str(params.message, 500) })]
      }

      case 'item/plan/delta': {
        const item = this.items.get(itemId)
        if (!item || item.kind !== 'plan') return []
        return [this.put({ ...item, explanation: tail((item.explanation ?? '') + str(params.delta, MAX_TEXT_CHARS), MAX_TEXT_CHARS) })]
      }

      case 'turn/plan/updated': {
        if (!turnId) return []
        const steps = planSteps(params)
        const item = this.base(`plan:${turnId}`, ctx, turnId, { kind: 'plan', steps })
        const explanation = str(params.explanation, 4000)
        if (explanation && item.kind === 'plan') item.explanation = explanation
        return [this.put(item)]
      }

      case 'turn/started': {
        const id = isRecord(params.turn) ? str(params.turn.id, 100) : ''
        return id ? [{ type: 'turn', sessionId: this.sessionId, turnId: id, status: 'started' }] : []
      }

      case 'turn/completed': {
        const turn = isRecord(params.turn) ? params.turn : {}
        const id = str(turn.id, 100)
        if (!id) return []
        const how = turn.status === 'interrupted' || turn.status === 'failed' ? turn.status : 'completed'
        const events = this.closeOpen(id, how)
        this.ended.delete(id)
        this.ended.set(id, how)
        if (this.ended.size > ENDED_TURNS_KEPT) this.ended.delete(this.ended.keys().next().value as string)
        const event: ChatEvent = { type: 'turn', sessionId: this.sessionId, turnId: id, status: how }
        // A retry notice of this turn has done its job.
        const retry = this.items.get(`retry:${id}`)
        if (retry && retry.kind === 'notice' && how === 'completed') events.push(this.put({ ...retry, text: 'Reconnected' }))
        if (how === 'failed') {
          const text = describeTurnError(turn.error)
          event.error = text
          events.push(...this.notice('error', text, ctx, { id: `error:${id}`, turnId: id }))
        } else if (how === 'interrupted') {
          events.push(...this.notice('info', 'Turn interrupted', ctx, { id: `interrupted:${id}`, turnId: id }))
        }
        events.push(event)
        return events
      }

      case 'error': {
        const error = isRecord(params.error) ? params.error : {}
        // With `willRetry` it is progress ("Reconnecting... 2/5"): one notice per turn, updated in place.
        if (params.willRetry === true) {
          return this.notice('info', str(error.message, 300) || 'Reconnecting…', ctx, { id: `retry:${turnId ?? 'thread'}`, turnId })
        }
        return this.notice('error', describeTurnError(error), ctx, { id: `error:${turnId ?? `thread:${++this.seq}`}`, turnId })
      }

      case 'warning':
        return str(params.message) ? this.notice('warning', str(params.message, 1000), ctx) : []

      case 'thread/compacted':
        return this.notice('info', 'Context compacted', ctx)

      case 'model/rerouted': {
        const to = str(params.toModel, 100) || str(params.model, 100)
        return this.notice('info', to ? `Codex switched this turn to ${to}` : 'Codex switched the model for this turn', ctx, { turnId })
      }

      default:
        return []
    }
  }

  // ---- internals ---------------------------------------------------------------------------------

  private base<T extends object>(id: string, ctx: ChatContext, turnId: string | undefined, rest: T): ChatItem {
    const item = { id, sessionId: this.sessionId, agentId: ctx.agentId, ts: ctx.now, ...rest } as unknown as ChatItem
    if (turnId) item.turnId = turnId
    return item
  }

  /** Inserts or replaces (keeping the first timestamp and the place in the list). */
  private put(item: ChatItem): ChatEvent {
    const prev = this.items.get(item.id)
    const next = prev ? ({ ...item, ts: prev.ts } as ChatItem) : item
    this.items.set(next.id, next)
    while (this.items.size > this.limits.maxItems) {
      const oldest = this.items.keys().next().value as string
      this.items.delete(oldest)
      this.refreshedAt.delete(oldest)
    }
    return { type: 'item', item: next }
  }

  /** The chat id of a user message: the id we sent it with, when it is the echo of one of ours. */
  private userItemId(item: Record<string, unknown>, text: string): { id: string; origin: UserOrigin } {
    const codexId = str(item.id, 200)
    const known = this.alias.get(codexId)
    if (known) {
      const prev = this.items.get(known)
      return { id: known, origin: prev?.kind === 'user' ? prev.origin : (this.sent.get(known)?.origin ?? 'human') }
    }
    const clientId = str(item.clientId, 200)
    let match = clientId && this.sent.has(clientId) ? clientId : ''
    if (!match) {
      // No client id on the echo: the oldest prompt we sent with this text.
      for (const [id, s] of this.sent) {
        if (s.text.trim() === text.trim()) {
          match = id
          break
        }
      }
    }
    if (!match) {
      // Sent by this app before (history after a resume): same id and origin as when it was live.
      const origin = originOfClientId(clientId)
      return origin ? { id: clientId, origin } : { id: codexId, origin: 'human' }
    }
    const origin = this.sent.get(match)?.origin ?? 'human'
    this.sent.delete(match)
    this.alias.set(codexId, match)
    if (this.alias.size > 200) this.alias.delete(this.alias.keys().next().value as string)
    return { id: match, origin }
  }

  /** One Codex ThreadItem as a ChatItem, merged with what the deltas built so far. Null = not shown. */
  private convert(raw: unknown, completed: boolean, ctx: ChatContext, turnId: string | undefined): ChatItem | null {
    if (!isRecord(raw)) return null
    const id = str(raw.id, 200)
    if (!id) return null
    const prev = this.items.get(id)
    switch (raw.type) {
      case 'userMessage': {
        const text = userText(raw.content)
        const user = this.userItemId(raw, text)
        return this.base(user.id, ctx, turnId, { kind: 'user', text, origin: user.origin })
      }
      case 'agentMessage': {
        const streamed = prev?.kind === 'assistant' ? prev.text : ''
        const item = this.base(id, ctx, turnId, { kind: 'assistant', text: str(raw.text, MAX_TEXT_CHARS) || streamed, streaming: !completed })
        if (item.kind === 'assistant') {
          if (raw.phase === 'commentary') item.phase = 'commentary'
          else if (raw.phase === 'final_answer') item.phase = 'final'
        }
        return item
      }
      case 'reasoning': {
        const before = prev?.kind === 'reasoning' ? prev : null
        const summary = arr(raw.summary).map((s) => str(s, MAX_TEXT_CHARS))
        const content = arr(raw.content)
          .map((s) => str(s, MAX_TEXT_CHARS))
          .join('\n')
        const item = this.base(id, ctx, turnId, { kind: 'reasoning', summary: summary.length > 0 ? summary : (before?.summary ?? []), streaming: !completed })
        const text = content || before?.text
        if (text && item.kind === 'reasoning') item.text = tail(text, MAX_TEXT_CHARS)
        return item
      }
      case 'commandExecution': {
        const before = prev?.kind === 'command' ? prev : null
        const aggregated = typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : null
        const output = aggregated ?? before?.output ?? ''
        const item = this.base(id, ctx, turnId, {
          kind: 'command',
          command: innerCommand(raw.command, raw.commandActions),
          intent: commandIntent(raw.commandActions),
          output: tail(output, this.limits.maxOutputChars),
          outputTruncated: output.length > this.limits.maxOutputChars || (aggregated === null && before?.outputTruncated === true),
          exitCode: num(raw.exitCode),
          status: status(raw.status, completed)
        })
        if (item.kind === 'command') {
          const cwd = str(raw.cwd, 2000)
          if (cwd) item.cwd = cwd
          const durationMs = num(raw.durationMs)
          if (durationMs !== null) item.durationMs = durationMs
        }
        return item
      }
      case 'fileChange':
        return this.base(id, ctx, turnId, { kind: 'file-change', changes: fileChanges(raw.changes, this.limits.maxDiffChars), status: status(raw.status, completed) })
      case 'webSearch': {
        const action = isRecord(raw.action) ? raw.action : {}
        const kind = action.type === 'openPage' ? 'open' : action.type === 'findInPage' ? 'find' : 'search'
        const item = this.base(id, ctx, turnId, { kind: 'web', action: kind, status: completed ? 'done' : 'running' })
        if (item.kind === 'web') {
          const query = str(raw.query, 1000) || str(action.query, 1000) || str(action.pattern, 1000)
          if (query) item.query = query
          const url = str(action.url, 2000)
          if (url) item.url = url
        }
        return item
      }
      case 'mcpToolCall':
      case 'dynamicToolCall': {
        const before = prev?.kind === 'tool' ? prev : null
        const failed = raw.success === false || isRecord(raw.error)
        const item = this.base(id, ctx, turnId, {
          kind: 'tool',
          tool: str(raw.tool, 200) || 'tool',
          input: describeToolInput(raw.arguments ?? {}),
          status: failed && completed ? 'failed' : status(raw.status, completed)
        })
        if (item.kind === 'tool') {
          const server = str(raw.server, 200) || str(raw.namespace, 200)
          if (server) item.server = server
          const result = toolResult(raw)
          if (result) item.result = result
          if (isRecord(raw.error)) item.error = str(raw.error.message, 2000)
          if (!completed && before?.progress) item.progress = before.progress
        }
        return item
      }
      case 'collabAgentToolCall': {
        const child = arr(raw.receiverThreadIds).find((t): t is string => typeof t === 'string' && t.length > 0) ?? ''
        const item = this.base(id, ctx, turnId, {
          kind: 'subagent',
          childAgentId: subagentId(this.sessionId, child.slice(0, 100)),
          action: SUBAGENT_ACTIONS[str(raw.tool, 40)] ?? 'message',
          status: status(raw.status, completed)
        })
        const prompt = str(raw.prompt, 4000)
        if (prompt && item.kind === 'subagent') item.prompt = prompt
        return item
      }
      case 'plan':
        return this.base(id, ctx, turnId, { kind: 'plan', explanation: str(raw.text, MAX_TEXT_CHARS), steps: [] })
      case 'imageView':
        return this.base(id, ctx, turnId, { kind: 'tool', tool: 'view image', input: str(raw.path, 2000), status: completed ? 'done' : 'running' })
      case 'imageGeneration':
        return this.base(id, ctx, turnId, { kind: 'tool', tool: 'image generation', input: '', status: completed ? 'done' : 'running' })
      case 'contextCompaction':
        return completed ? this.base(id, ctx, turnId, { kind: 'notice', level: 'info', text: 'Context compacted' }) : null
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        return this.base(id, ctx, turnId, { kind: 'notice', level: 'info', text: raw.type === 'enteredReviewMode' ? 'Review started' : 'Review finished' })
      default:
        // hookPrompt, functionCallOutput, subAgentActivity, sleep, and whatever comes next.
        return null
    }
  }
}
