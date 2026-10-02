// Antigravity CLI (`agy --output-format stream-json`) events -> the app's provider-agnostic chat
// model (shared/chat.ts) and the world's activities. Pure (no clock, no I/O): the driver passes the
// time in, so the tests replay the JSON recorded in docs/spikes-phase-c.md.
//
// The stream names a tool and a subset of its parameters, but carries no file content and no diff.
// Those come from the PreToolUse hook's payload (`toolArgs`), which arrives a moment after the
// step's `ACTIVE` event and before the tool runs.
//
// Rules the renderer can rely on (the same as for Codex, codexChat.ts): an `item` event inserts or
// replaces by id; a `delta` refers to an item an earlier `item` introduced; `turn started` comes
// before the turn's items and the turn's end after every item of it was closed.
import {
  CHAT_MAX_DIFF_CHARS,
  CHAT_MAX_ITEMS,
  CHAT_MAX_OUTPUT_CHARS,
  type ChatEvent,
  type ChatItem,
  type ChatItemStatus
} from '../../shared/chat'
import type { Activity } from '../../shared/events'
import type { PermissionRisk } from '../../shared/permissionText'
import { relativeTo } from '../../shared/paths'
import { BOARD_ACTIVITY, BOARD_ACTIVITY_DETAIL, CAPTURE_TOOL_PATTERN } from '../adapters/claude-code-hooks'
import { describeToolInput } from '../permissions'
import { AGY_READ_TOOLS, AGY_WRITE_TOOLS, agyToolClass, isAgyBoardCall } from './agyPolicy'

export const AGY_PROVIDER = 'antigravity'

type UserOrigin = Extract<ChatItem, { kind: 'user' }>['origin']
type ApprovalOutcome = Extract<ChatItem, { kind: 'approval' }>['outcome']
type FileChange = Extract<ChatItem, { kind: 'file-change' }>['changes'][number]
type TurnEnd = 'completed' | 'interrupted' | 'failed'

const MAX_TEXT_CHARS = 200_000
const MAX_RESULT_CHARS = 8000

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = MAX_TEXT_CHARS): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const tail = (s: string, max: number): string => (s.length > max ? s.slice(s.length - max) : s)
const head = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n…` : s)

// ---- wire -------------------------------------------------------------------------------------------

export type AgyEvent =
  | { type: 'init'; conversationId: string; model: string; cwd: string; permissionMode: string }
  | {
      type: 'step'
      conversationId: string
      index: number
      /** `ACTIVE`, `DONE`, or `ERROR` (a failed tool step; not in the docs). */
      state: string
      /** `user_input`, `agent_response`, `tool`, `checkpoint`, `unknown` (an injected step). */
      stepType: string
      toolName: string
      params: Record<string, unknown>
      output: string | null
      error: string
      textDelta: string
      durationMs: number | null
    }
  | { type: 'result'; conversationId: string; status: string; response: string; denied: string[] }
  | { type: 'other'; event: string }

/** One line of agy's stdout. Null when it is not a JSON object. */
export function parseAgyLine(line: string): AgyEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const event = str(raw.event, 60)
  if (event === 'init') {
    const init = isRecord(raw.init) ? raw.init : {}
    return { type: 'init', conversationId: str(raw.conversation_id, 100), model: str(init.model, 100), cwd: str(init.cwd, 2000), permissionMode: str(init.permission_mode, 60) }
  }
  if (event === 'step_update' && isRecord(raw.step_update)) {
    const s = raw.step_update
    const index = num(s.step_index)
    if (index === null) return { type: 'other', event }
    const info = isRecord(s.tool_info) ? s.tool_info : {}
    const error = isRecord(info.error) ? str(info.error.message, 4000) || str(info.error.type, 100) : str(info.error, 4000)
    const seconds = num(s.duration_seconds)
    return {
      type: 'step',
      conversationId: str(s.conversation_id, 100),
      index,
      state: str(s.state, 20),
      stepType: str(s.step_type, 40),
      toolName: str(s.tool_name, 200) || str(info.name, 200),
      params: isRecord(info.parameters) ? info.parameters : {},
      output: typeof info.output === 'string' ? info.output : null,
      error,
      textDelta: str(s.text_delta),
      durationMs: seconds === null ? null : Math.round(seconds * 1000)
    }
  }
  if (event === 'result' && isRecord(raw.result)) {
    const r = raw.result
    const denied = (Array.isArray(r.denied_actions) ? r.denied_actions : [])
      .map((d) => (isRecord(d) ? str(d.display_name, 100) || str(d.action, 100) : ''))
      .filter((d) => d.length > 0)
    return { type: 'result', conversationId: str(r.conversation_id, 100), status: str(r.status, 40), response: str(r.response), denied }
  }
  return { type: 'other', event }
}

// ---- tools -> world ---------------------------------------------------------------------------------

/** A command that only looks: one plain command, no redirection, no chaining. */
const READ_ONLY_COMMAND =
  /^\s*(ls|dir|cat|type|more|gc|get-content|gci|get-childitem|get-item|test-path|grep|rg|findstr|select-string|sls|head|tail|wc|tree|pwd|get-location|where|where\.exe|which|git\s+(status|diff|log|show|branch|ls-files|rev-parse|blame|remote))(\s|$)/i

export function agyCommandIntent(command: string): 'read' | 'exec' {
  return READ_ONLY_COMMAND.test(command) && !/[>;&|`]|\$\(/.test(command) ? 'read' : 'exec'
}

const firstPath = (params: Record<string, unknown>): string =>
  str(params.TargetFile, 2000) || str(params.AbsolutePath, 2000) || str(params.DirectoryPath, 2000) || str(params.SearchDirectory, 2000) || str(params.SearchPath, 2000)

export interface AgyWorldActivity {
  activity: Activity
  detail: string
}

/** What a tool step means for the world, or null when it is not an activity (finish, wait, …). */
export function agyWorldActivity(tool: string, params: Record<string, unknown>, cwd?: string): AgyWorldActivity | null {
  const cls = agyToolClass(tool, params)
  switch (cls) {
    case 'board':
      return { activity: BOARD_ACTIVITY, detail: BOARD_ACTIVITY_DETAIL }
    case 'command': {
      const command = str(params.CommandLine, 2000)
      return { activity: tool === 'run_command' ? agyCommandIntent(command) : 'exec', detail: command || tool }
    }
    case 'write':
      return { activity: 'write', detail: relativeTo(firstPath(params), cwd) || (tool === 'generate_image' ? 'image' : '') }
    case 'read':
      return { activity: 'read', detail: relativeTo(firstPath(params), cwd) || str(params.Pattern, 200) || str(params.Query, 200) }
    case 'web':
      return { activity: 'web', detail: str(params.Url, 2000) || str(params.query, 400) || str(params.Query, 400) }
    case 'browser':
      return { activity: CAPTURE_TOOL_PATTERN.test(tool) || /^capture_/.test(tool) ? 'capture' : 'web', detail: str(params.Url, 2000) || tool }
    case 'mcp': {
      const name = tool === 'call_mcp_tool' ? str(params.ToolName, 200) : tool
      const server = str(params.ServerName, 200)
      return { activity: CAPTURE_TOOL_PATTERN.test(name) ? 'capture' : 'exec', detail: server ? `${server}.${name}` : name }
    }
    case 'delegate':
      return { activity: 'exec', detail: 'delegating' }
    case 'passive':
      return null
    default:
      return { activity: 'exec', detail: tool }
  }
}

// ---- file changes -----------------------------------------------------------------------------------

function lines(text: string): string[] {
  if (text.length === 0) return []
  const out = text.replace(/\r\n/g, '\n').split('\n')
  if (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

function hunk(oldStart: number, removed: string[], newStart: number, added: string[], before: string[] = [], after: string[] = []): string {
  const oldCount = before.length + removed.length + after.length
  const newCount = before.length + added.length + after.length
  const header = `@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`
  return [header, ...before.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), ...after.map((l) => ` ${l}`)].join('\n') + '\n'
}

const CONTEXT_LINES = 3

/** A whole file replaced: one hunk around what differs (common head and tail left out). */
export function replacedFileDiff(before: string, after: string): string {
  const a = lines(before)
  const b = lines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  if (start === endA && start === endB) return ''
  const ctxStart = Math.max(0, start - CONTEXT_LINES)
  return hunk(ctxStart + 1, a.slice(start, endA), ctxStart + 1, b.slice(start, endB), a.slice(ctxStart, start), a.slice(endA, endA + CONTEXT_LINES))
}

export interface AgyFileContext {
  /** The file's content before the call; null = it did not exist; undefined = not known (too large, unreadable). */
  before?: string | null
}

/**
 * The file a writing tool changes, with a unified diff built from the tool's arguments (the hook
 * payload): the new file as one hunk of added lines, an overwritten file as a hunk around what
 * differs, a replacement as "- target / + replacement". Null when the call names no file.
 */
export function agyFileChange(tool: string, args: Record<string, unknown>, file: AgyFileContext = {}, maxChars = CHAT_MAX_DIFF_CHARS): FileChange | null {
  const path = str(args.TargetFile, 2000) || str(args.AbsolutePath, 2000)
  if (!path) return null
  if (tool === 'write_to_file') {
    const content = str(args.CodeContent, maxChars * 2)
    if (typeof file.before === 'string') return { path, change: 'update', diff: head(replacedFileDiff(file.before, content), maxChars) }
    const added = lines(content)
    const change = file.before === null || args.Overwrite !== true ? 'add' : 'update'
    return { path, change, diff: content.length === 0 ? '' : head(hunk(1, [], 1, added), maxChars) }
  }
  const chunks: Array<Record<string, unknown>> =
    tool === 'multi_replace_file_content' ? (Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks.filter(isRecord).slice(0, 200) : []) : tool === 'replace_file_content' ? [args] : []
  let diff = ''
  for (const c of chunks) {
    const target = typeof c.TargetContent === 'string' ? c.TargetContent : null
    const replacement = typeof c.ReplacementContent === 'string' ? c.ReplacementContent : null
    if (target === null && replacement === null) continue
    const start = Math.max(1, num(c.StartLine) ?? 1)
    diff += hunk(start, target ? lines(target) : [], start, replacement ? lines(replacement) : [])
    if (diff.length > maxChars) break
  }
  return { path, change: 'update', diff: head(diff, maxChars) }
}

// ---- chat -------------------------------------------------------------------------------------------

export interface AgyChatContext {
  agentId: string
  now: number
  turnId?: string
  cwd?: string
}

/** `item` as it is left when its turn ends: nothing keeps spinning. Null = it was not open. */
function closedAs(item: ChatItem, how: TurnEnd): ChatItem | null {
  if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) return { ...item, streaming: false }
  if ('status' in item && item.status === 'running') return { ...item, status: how === 'completed' ? 'done' : how }
  if (item.kind === 'approval' && item.outcome === 'pending') return { ...item, outcome: 'resolved-elsewhere' }
  return null
}

const stepId = (index: number): string => `step:${index}`

/** Agy's own words for a call the hook refused. */
export const AGY_HOOK_DENIED = /denied by pre-tool hook/i

export class AgyChat {
  /** Insertion order = display order. Replacing a value keeps its place. */
  private items = new Map<string, ChatItem>()
  private seq = 0
  /** Tool steps the gate refused (by the user or the policy): their `ERROR` is "declined", not "failed". */
  private refused = new Set<number>()
  /** Whitespace an answer began with, kept until it says something. */
  private pendingText = new Map<number, string>()
  /** Did the running turn show any answer text? */
  private answered = false

  constructor(
    readonly sessionId: string,
    private readonly limits = { maxItems: CHAT_MAX_ITEMS, maxOutputChars: CHAT_MAX_OUTPUT_CHARS, maxDiffChars: CHAT_MAX_DIFF_CHARS }
  ) {}

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

  /** A prompt of the user's. Returns the item's id with the event. */
  user(text: string, origin: UserOrigin, ctx: AgyChatContext): { id: string; events: ChatEvent[] } {
    const id = `user:${++this.seq}`
    return { id, events: [this.put(this.base(id, ctx, { kind: 'user', text, origin }))] }
  }

  /** A prompt that was shown while it waited now belongs to the turn that runs it. */
  userStarted(id: string, turnId: string): ChatEvent[] {
    const item = this.items.get(id)
    return item && item.kind === 'user' ? [this.put({ ...item, turnId })] : []
  }

  notice(level: 'info' | 'warning' | 'error', text: string, ctx: AgyChatContext, id?: string): ChatEvent[] {
    return [this.put(this.base(id ?? `notice:${++this.seq}`, ctx, { kind: 'notice', level, text: str(text, 2000) }))]
  }

  turnStarted(turnId: string): ChatEvent[] {
    this.answered = false
    return [{ type: 'turn', sessionId: this.sessionId, turnId, status: 'started' }]
  }

  /** Closes what the turn left open, then says how it ended. */
  turnEnded(turnId: string, how: TurnEnd, ctx: AgyChatContext, error?: string): ChatEvent[] {
    const events = this.closeOpen(turnId, how)
    const event: ChatEvent = { type: 'turn', sessionId: this.sessionId, turnId, status: how }
    if (how === 'failed') {
      const text = error || 'The turn failed'
      event.error = text
      events.push(...this.notice('error', text, { ...ctx, turnId }, `error:${turnId}`))
    } else if (how === 'interrupted') {
      events.push(...this.notice('info', 'Turn interrupted', { ...ctx, turnId }, `interrupted:${turnId}`))
    }
    events.push(event)
    this.pendingText.clear()
    return events
  }

  /** Without a turn id (the process is gone) everything open is closed. */
  closeOpen(turnId: string | null, how: TurnEnd): ChatEvent[] {
    const events: ChatEvent[] = []
    for (const item of [...this.items.values()]) {
      if (turnId !== null && item.turnId !== turnId) continue
      const closed = closedAs(item, how)
      if (closed) events.push(this.put(closed))
    }
    return events
  }

  approvalRequested(
    a: { requestId: string; stepIndex?: number; summary: string; detail: string; question?: string; risk?: PermissionRisk; riskNote?: string },
    ctx: AgyChatContext
  ): ChatEvent[] {
    const item = this.base(`approval:${a.requestId}`, ctx, { kind: 'approval', requestId: a.requestId, summary: a.summary, detail: a.detail, outcome: 'pending' })
    if (item.kind === 'approval') {
      if (a.question) item.question = a.question
      if (a.risk) item.risk = a.risk
      if (a.riskNote) item.riskNote = a.riskNote
      if (a.stepIndex !== undefined && this.items.has(stepId(a.stepIndex))) item.subjectId = stepId(a.stepIndex)
    }
    return [this.put(item)]
  }

  approvalResolved(requestId: string, outcome: ApprovalOutcome): ChatEvent[] {
    const item = this.items.get(`approval:${requestId}`)
    if (!item || item.kind !== 'approval' || item.outcome !== 'pending') return []
    return [this.put({ ...item, outcome })]
  }

  /** The gate refused this tool step: when agy reports it as an error, it is shown as declined. */
  refuse(stepIndex: number): void {
    this.refused.add(stepIndex)
    if (this.refused.size > 200) this.refused.delete(this.refused.values().next().value as number)
  }

  /**
   * The full arguments of a tool step, from the PreToolUse hook: the file card gets its diff, the
   * command card its folder, a tool card its whole input.
   */
  toolArgs(stepIndex: number, tool: string, args: Record<string, unknown>, file: AgyFileContext = {}): ChatEvent[] {
    const item = this.items.get(stepId(stepIndex))
    if (!item) return []
    if (item.kind === 'file-change') {
      const change = agyFileChange(tool, args, file, this.limits.maxDiffChars)
      return change ? [this.put({ ...item, changes: [change] })] : []
    }
    if (item.kind === 'command' && tool === 'run_command') {
      const cwd = str(args.Cwd, 2000)
      return cwd && cwd !== item.cwd ? [this.put({ ...item, cwd })] : []
    }
    if (item.kind === 'tool' && tool === 'call_mcp_tool') return [this.put({ ...item, input: describeToolInput(args.Arguments ?? {}) })]
    return []
  }

  // ---- the stream --------------------------------------------------------------------------------

  /** One stream event. `init`, `user_input` steps and injected steps give nothing. */
  apply(e: AgyEvent, ctx: AgyChatContext): ChatEvent[] {
    if (e.type === 'step') {
      if (e.stepType === 'agent_response') return this.answer(e, ctx)
      if (e.stepType === 'tool') return this.tool(e, ctx)
      return []
    }
    if (e.type === 'result') {
      const events: ChatEvent[] = []
      // An answer that was not streamed (no deltas seen): show it whole.
      if (!this.answered && e.response.trim().length > 0) {
        events.push(this.put(this.base(`answer:${++this.seq}`, ctx, { kind: 'assistant', text: tail(e.response, MAX_TEXT_CHARS), streaming: false })))
      }
      if (e.denied.length > 0) {
        events.push(...this.notice('warning', `Antigravity itself refused: ${e.denied.join(', ')}. The turn ended there.`, ctx))
      }
      return events
    }
    return []
  }

  private answer(e: Extract<AgyEvent, { type: 'step' }>, ctx: AgyChatContext): ChatEvent[] {
    const id = stepId(e.index)
    const done = e.state !== 'ACTIVE'
    const prev = this.items.get(id)
    if (!prev) {
      // A model call that only makes a tool call sends one DONE without text: no empty bubble.
      const text = (this.pendingText.get(e.index) ?? '') + e.textDelta
      if (text.trim().length === 0) {
        if (done) this.pendingText.delete(e.index)
        else if (text.length > 0) this.pendingText.set(e.index, text)
        return []
      }
      this.pendingText.delete(e.index)
      this.answered = true
      return [this.put(this.base(id, ctx, { kind: 'assistant', text: tail(text, MAX_TEXT_CHARS), streaming: !done }))]
    }
    if (prev.kind !== 'assistant') return []
    const next: ChatItem = { ...prev, text: tail(prev.text + e.textDelta, MAX_TEXT_CHARS), streaming: !done }
    if (done) return [this.put(next)]
    this.items.set(id, next)
    return e.textDelta ? [{ type: 'delta', sessionId: this.sessionId, itemId: id, field: 'text', delta: e.textDelta }] : []
  }

  private tool(e: Extract<AgyEvent, { type: 'step' }>, ctx: AgyChatContext): ChatEvent[] {
    const id = stepId(e.index)
    const prev = this.items.get(id)
    const refused = e.state === 'ERROR' && (this.refused.has(e.index) || AGY_HOOK_DENIED.test(e.error))
    const status: ChatItemStatus = e.state === 'ACTIVE' ? 'running' : e.state === 'ERROR' ? (refused ? 'declined' : 'failed') : 'done'
    if (e.state !== 'ACTIVE') this.refused.delete(e.index)
    const item = this.toolItem(e, status, prev, ctx)
    const events = [this.put(item)]
    // A card without a place for the error: say why it failed. A refusal has its approval card.
    if (status === 'failed' && e.error && (item.kind === 'file-change' || item.kind === 'web')) {
      events.push(...this.notice('warning', `${e.toolName} failed: ${e.error}`, ctx))
    }
    return events
  }

  private toolItem(e: Extract<AgyEvent, { type: 'step' }>, status: ChatItemStatus, prev: ChatItem | undefined, ctx: AgyChatContext): ChatItem {
    const id = stepId(e.index)
    const p = e.params
    const tool = e.toolName
    const closed = status !== 'running'
    const cls = agyToolClass(tool, p)

    if (tool === 'run_command' || AGY_READ_TOOLS.includes(tool)) {
      const before = prev?.kind === 'command' ? prev : null
      const path = relativeTo(firstPath(p), ctx.cwd)
      const command =
        tool === 'run_command'
          ? str(p.CommandLine, 20_000)
          : tool === 'view_file'
            ? `read ${path}`
            : tool === 'list_dir'
              ? `list ${path}`
              : tool === 'find_by_name'
                ? `find ${str(p.Pattern, 400)}${path ? ` in ${path}` : ''}`
                : tool === 'grep_search'
                  ? `search ${JSON.stringify(str(p.Query, 400))}${path ? ` in ${path}` : ''}`
                  : `${tool} ${path}`.trim()
      const intent = tool === 'run_command' ? agyCommandIntent(command) : tool === 'list_dir' ? 'list' : tool === 'find_by_name' || tool === 'grep_search' ? 'search' : 'read'
      // A refusal or a failure has no output; what agy says about it stands in for it.
      const raw = e.output ?? (closed && e.error ? e.error : (before?.output ?? ''))
      const item = this.base(id, ctx, {
        kind: 'command',
        command: command || before?.command || tool,
        intent,
        output: tail(raw, this.limits.maxOutputChars),
        outputTruncated: raw.length > this.limits.maxOutputChars,
        exitCode: null,
        status
      })
      if (item.kind === 'command') {
        if (before?.cwd) item.cwd = before.cwd
        if (closed && e.durationMs !== null) item.durationMs = e.durationMs
      }
      return item
    }
    if (AGY_WRITE_TOOLS.includes(tool) && firstPath(p)) {
      const before = prev?.kind === 'file-change' ? prev : null
      const path = firstPath(p)
      const changes = before && before.changes.length > 0 ? before.changes : [{ path, change: (tool === 'write_to_file' ? 'add' : 'update') as FileChange['change'], diff: '' }]
      return this.base(id, ctx, { kind: 'file-change', changes, status })
    }
    if (cls === 'web' || tool === 'open_browser_url' || tool === 'read_browser_page') {
      const item = this.base(id, ctx, { kind: 'web', action: tool === 'search_web' ? 'search' : 'open', status })
      if (item.kind === 'web') {
        const query = str(p.query, 1000) || str(p.Query, 1000)
        if (query) item.query = query
        const url = str(p.Url, 2000) || str(p.url, 2000)
        if (url) item.url = url
      }
      return item
    }
    const before = prev?.kind === 'tool' ? prev : null
    const mcp = tool === 'call_mcp_tool'
    const item = this.base(id, ctx, {
      kind: 'tool',
      tool: mcp ? str(p.ToolName, 200) || tool : tool,
      input: before?.input ?? describeToolInput(mcp ? (p.Arguments ?? {}) : p),
      status
    })
    if (item.kind === 'tool') {
      const server = mcp ? str(p.ServerName, 200) : cls === 'browser' ? 'browser' : ''
      if (server) item.server = isAgyBoardCall(tool, p) ? 'Office board' : server
      if (e.output) item.result = head(e.output, MAX_RESULT_CHARS)
      if (status === 'failed' || status === 'declined') item.error = str(e.error, 2000) || undefined
      if (item.error === undefined) delete item.error
    }
    return item
  }

  // ---- internals ---------------------------------------------------------------------------------

  private base<T extends object>(id: string, ctx: AgyChatContext, rest: T): ChatItem {
    const item = { id, sessionId: this.sessionId, agentId: ctx.agentId, ts: ctx.now, ...rest } as unknown as ChatItem
    if (ctx.turnId) item.turnId = ctx.turnId
    return item
  }

  /** Inserts or replaces (keeping the first timestamp, the turn and the place in the list). */
  private put(item: ChatItem): ChatEvent {
    const prev = this.items.get(item.id)
    const next = prev ? ({ ...item, ts: prev.ts, ...(prev.turnId && !item.turnId ? { turnId: prev.turnId } : {}) } as ChatItem) : item
    this.items.set(next.id, next)
    while (this.items.size > this.limits.maxItems) this.items.delete(this.items.keys().next().value as string)
    return { type: 'item', item: next }
  }
}
