// Claude Code hook payloads -> AgentEvents (payload shapes: docs/spikes-phase-a.md).
//
// Two kinds of session post to `/hooks/claude-code`:
// - HOSTED: launched by the app, authenticated by that session's own token. The request goes to the
//   session's driver, which owns a ClaudeHookMapper and may hold a PermissionRequest open.
// - EXTERNAL: a terminal the app didn't start, authenticated by the global token. It shows up in the
//   world under its Claude `session_id`, is never in the sessions list, and cannot be answered: its
//   PermissionRequest gets `{}` at once so the terminal's own dialog decides.
//
// No Electron imports here: the tests load this file under plain Node.
import type { Activity, AgentEvent } from '../../shared/events'
import { subagentId } from '../../shared/sessions'
import type { EventSink, HttpAdapter, RequestContext } from './types'

export const CLAUDE_PROVIDER = 'claude-code'
export const CLAUDE_HOOKS_ROUTE = '/hooks/claude-code'
/** Hook payloads carry file contents and tool output, so this route gets a larger cap than /events. */
export const CLAUDE_HOOKS_MAX_BODY = 4 * 1024 * 1024
/** Key the SessionStart command hook (hook/claude-session-start.cjs) adds around the inbox endpoint. */
export const AO_ENVELOPE_KEY = '_ao'

const DETAIL_MAX = 200

// ---- tool -> activity (edit this table to change where characters go) ---------------------------

export const TOOL_ACTIVITY: Record<string, Activity> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  LSP: 'read',
  NotebookRead: 'read',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'exec',
  PowerShell: 'exec',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'exec',
  Task: 'exec'
}

/** Tools that hand work to a subagent: shown as `exec` with the detail "delegating". */
export const DELEGATING_TOOLS: readonly string[] = ['Agent', 'Task']

/** Tool names that take a picture of something (any provider, any MCP server). */
export const CAPTURE_TOOL_PATTERN = /screen[_-]?shot|screen[_-]?cap|capture[_-]?screen|take[_-]?snapshot/i

/** Everything not listed above, including other `mcp__*` tools. */
export const DEFAULT_TOOL_ACTIVITY: Activity = 'exec'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

export function activityForTool(toolName: string, toolInput?: unknown): Activity {
  if (CAPTURE_TOOL_PATTERN.test(toolName)) return 'capture'
  // Computer-use / browser MCP tools take the action as an argument: { action: "screenshot" }.
  if (toolName.startsWith('mcp__') && isRecord(toolInput)) {
    const action = toolInput.action
    if (typeof action === 'string' && CAPTURE_TOOL_PATTERN.test(action)) return 'capture'
  }
  return Object.hasOwn(TOOL_ACTIVITY, toolName) ? TOOL_ACTIVITY[toolName] : DEFAULT_TOOL_ACTIVITY
}

const oneLine = (s: string, max = DETAIL_MAX): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The file path / command / URL of a tool call, on one line, truncated. */
export function toolDetail(toolName: string, toolInput: unknown): string {
  if (DELEGATING_TOOLS.includes(toolName)) return 'delegating'
  if (!isRecord(toolInput)) return ''
  for (const key of ['file_path', 'notebook_path', 'path', 'command', 'url', 'query', 'pattern']) {
    const v = toolInput[key]
    if (typeof v === 'string' && v.length > 0) return oneLine(v)
  }
  return ''
}

/** UserPromptSubmit also fires for subagent hand-backs and task notifications: not a user prompt. */
export function isSyntheticPrompt(prompt: unknown): boolean {
  return typeof prompt === 'string' && /^\s*<(agent-message[\s>]|task-notification>)/.test(prompt)
}

// ---- mapper ---------------------------------------------------------------------------------------

export type HookKind =
  | 'session-start'
  | 'prompt' //           a real prompt (typed, pasted, or an inbox order)
  | 'synthetic-prompt' // a hand-back or task notification
  | 'pre-tool'
  | 'post-tool'
  | 'permission'
  | 'notification'
  | 'stop'
  | 'subagent-start'
  | 'subagent-stop'
  | 'session-end'
  | 'ignored'

export interface MappedHook {
  kind: HookKind
  /** The world agent the hook is about (the session's manager, or one of its subagents). */
  agentId: string
  displayName: string
  events: AgentEvent[]
}

interface Actor {
  parentId: string | null
  displayName: string
  activity: Activity
  detail: string
  /** What it was doing before it started waiting on a permission. */
  before: { activity: Activity; detail: string } | null
  /** Pending permission requests. */
  waiting: number
}

export interface MapperOptions {
  /** World id of the session's manager: the app session id (hosted) or Claude's session_id (external). */
  rootId: string
  displayName: string
  provider?: string
  /**
   * true (hosted): an agent stays `waiting` until `resume()` says its request was resolved.
   * false (external): nobody tells us, so the next tool event ends the wait.
   */
  holdWaiting?: boolean
  /**
   * true (hosted): the session is over when its process exits, so SessionEnd emits nothing and the
   * owner calls `end()`. false (external): SessionEnd is the only end we will ever hear of.
   */
  endsWithProcess?: boolean
}

const MAX_SUBAGENTS = 200

/** Per-session state: who exists in the world and what each one was last doing. */
export class ClaudeHookMapper {
  readonly rootId: string
  private readonly provider: string
  private readonly holdWaiting: boolean
  private readonly endsWithProcess: boolean
  private rootName: string
  private actors = new Map<string, Actor>()
  /** Subagents that already reported `done`; late events for them are dropped. */
  private ended = new Set<string>()

  constructor(opts: MapperOptions) {
    this.rootId = opts.rootId
    this.rootName = opts.displayName
    this.provider = opts.provider ?? CLAUDE_PROVIDER
    this.holdWaiting = opts.holdWaiting ?? false
    this.endsWithProcess = opts.endsWithProcess ?? false
  }

  /** First event of the session's manager (`idle`), if it isn't in the world yet. */
  spawn(now = Date.now(), detail = ''): AgentEvent[] {
    return this.actors.has(this.rootId) ? [] : [this.put(this.rootId, 'idle', detail, now)]
  }

  /** Live subagent world ids. */
  subagents(): string[] {
    return [...this.actors.keys()].filter((id) => id !== this.rootId)
  }

  has(agentId: string): boolean {
    return this.actors.has(agentId)
  }

  handle(body: unknown, now = Date.now()): MappedHook {
    const none = (kind: HookKind): MappedHook => ({ kind, agentId: this.rootId, displayName: this.rootName, events: [] })
    if (!isRecord(body)) return none('ignored')
    const name = str(body.hook_event_name, 60)
    const events: AgentEvent[] = []
    const out = (kind: HookKind, agentId = this.rootId): MappedHook => {
      // The manager must exist before anything else of its session shows up.
      if (!this.actors.has(this.rootId) && kind !== 'session-end') events.unshift(this.put(this.rootId, 'idle', '', now))
      return { kind, agentId, displayName: this.actors.get(agentId)?.displayName ?? this.rootName, events }
    }
    const providerAgent = str(body.agent_id, 100)
    const agentType = str(body.agent_type, 60)
    const subId = providerAgent ? subagentId(this.rootId, providerAgent) : ''
    /** The actor of a tool event: a subagent when the payload carries agent_id, else the manager. */
    const actorId = subId || this.rootId
    if (subId && this.ended.has(subId) && name !== 'SubagentStart') return none('ignored')

    switch (name) {
      case 'SessionStart':
        if (!this.actors.has(this.rootId)) events.push(this.put(this.rootId, 'idle', '', now))
        return out('session-start')

      case 'UserPromptSubmit':
        return out(isSyntheticPrompt(body.prompt) ? 'synthetic-prompt' : 'prompt')

      case 'PreToolUse': {
        const tool = str(body.tool_name, 200)
        const activity = activityForTool(tool, body.tool_input)
        const detail = toolDetail(tool, body.tool_input)
        this.ensureSub(subId, agentType)
        const a = this.actors.get(actorId)
        if (a && a.waiting > 0 && this.holdWaiting) a.before = { activity, detail }
        else events.push(this.put(actorId, activity, detail, now))
        return out('pre-tool', actorId)
      }

      case 'PostToolUse':
      case 'PostToolUseFailure': {
        // The tool ran (or failed), so an external session's permission wait is over.
        const a = this.actors.get(actorId)
        if (a && a.waiting > 0 && !this.holdWaiting) {
          a.waiting = 1
          events.push(...this.resume(actorId, now))
        }
        return out('post-tool', actorId)
      }

      case 'PermissionRequest': {
        const tool = str(body.tool_name, 200)
        const detail = toolDetail(tool, body.tool_input)
        this.ensureSub(subId, agentType)
        events.push(...this.waiting(actorId, oneLine(detail ? `${tool}: ${detail}` : tool), now))
        return out('permission', actorId)
      }

      case 'Notification':
        return out('notification')

      case 'Stop': {
        const root = this.actors.get(this.rootId)
        if (root) {
          root.waiting = 0
          root.before = null
        }
        events.push(this.put(this.rootId, 'idle', '', now))
        return out('stop')
      }

      case 'SubagentStart': {
        if (!subId) return out('ignored')
        this.ended.delete(subId)
        if (!this.actors.has(subId)) {
          this.addSub(subId, agentType)
          events.push(this.put(subId, 'idle', agentType, now))
        }
        return out('subagent-start', subId)
      }

      case 'SubagentStop': {
        // An internal agent (agent_type "", never started) stops after most turns: not a subagent.
        if (!subId || agentType === '' || !this.actors.has(subId)) return out('ignored')
        events.push(this.put(subId, 'done', '', now))
        const res = out('subagent-stop', subId)
        this.actors.delete(subId)
        this.remember(subId)
        return res
      }

      case 'SessionEnd':
        // Hosted: `/clear` ends the Claude session, but the same process carries on under a new
        // session_id, so only the process exit ends the manager.
        if (this.endsWithProcess) return out('ignored')
        events.push(...this.end(now))
        return out('session-end')

      default:
        return out('ignored')
    }
  }

  /**
   * The session got another title: its manager goes by the new name. Returns the event that tells
   * the world, unless the manager isn't there yet or waits on the human (a repeated `waiting`
   * would read as a new request); then its next event carries the name.
   */
  rename(name: string, now = Date.now()): AgentEvent[] {
    if (!name || name === this.rootName) return []
    this.rootName = name
    const a = this.actors.get(this.rootId)
    if (!a) return []
    a.displayName = name
    return a.waiting > 0 || a.activity === 'waiting' ? [] : [this.put(this.rootId, a.activity, a.detail, now)]
  }

  /** A permission request is pending for this agent: it waits on the human. */
  waiting(agentId: string, detail: string, now = Date.now()): AgentEvent[] {
    const a = this.actors.get(agentId) ?? (agentId === this.rootId ? this.addRoot() : null)
    if (!a) return []
    if (a.waiting === 0 && a.activity !== 'waiting') a.before = { activity: a.activity, detail: a.detail }
    a.waiting++
    return [this.put(agentId, 'waiting', detail, now)]
  }

  /** One pending request of this agent was resolved: back to what it was doing, or idle. */
  resume(agentId: string, now = Date.now()): AgentEvent[] {
    const a = this.actors.get(agentId)
    if (!a || a.waiting === 0) return []
    a.waiting--
    if (a.waiting > 0) return []
    const before = a.before
    a.before = null
    if (a.activity !== 'waiting') return []
    const back = before && before.activity !== 'waiting' && before.activity !== 'done' ? before : { activity: 'idle' as Activity, detail: '' }
    return [this.put(agentId, back.activity, back.detail, now)]
  }

  /** The session is over: `done` for every live subagent, then for the manager. */
  end(now = Date.now()): AgentEvent[] {
    const events: AgentEvent[] = []
    for (const id of this.subagents()) events.push(this.put(id, 'done', '', now))
    if (this.actors.has(this.rootId)) events.push(this.put(this.rootId, 'done', '', now))
    this.actors.clear()
    this.ended.clear()
    return events
  }

  private addRoot(): Actor {
    const a: Actor = { parentId: null, displayName: this.rootName, activity: 'idle', detail: '', before: null, waiting: 0 }
    this.actors.set(this.rootId, a)
    return a
  }

  private addSub(id: string, agentType: string): void {
    if (this.actors.size > MAX_SUBAGENTS) return
    this.actors.set(id, {
      parentId: this.rootId,
      displayName: agentType || 'Subagent',
      activity: 'idle',
      detail: '',
      before: null,
      waiting: 0
    })
  }

  /** A tool event can be the first we hear of a subagent (its SubagentStart was missed). */
  private ensureSub(subId: string, agentType: string): void {
    if (subId && !this.actors.has(subId)) this.addSub(subId, agentType)
  }

  private remember(subId: string): void {
    this.ended.add(subId)
    if (this.ended.size > MAX_SUBAGENTS) this.ended.delete(this.ended.values().next().value as string)
  }

  private put(agentId: string, activity: Activity, detail: string, now: number): AgentEvent {
    let a = this.actors.get(agentId)
    if (!a) {
      a = agentId === this.rootId ? this.addRoot() : { parentId: this.rootId, displayName: 'Subagent', activity, detail, before: null, waiting: 0 }
      this.actors.set(agentId, a)
    }
    a.activity = activity
    a.detail = detail
    return { agentId, parentId: a.parentId, provider: this.provider, displayName: a.displayName, activity, detail, ts: now }
  }
}

// ---- HTTP adapter ---------------------------------------------------------------------------------

/** A hosted session's driver, as far as this route cares. */
export interface HostedHookTarget {
  handleHook(body: Record<string, unknown>, ctx: RequestContext): unknown | Promise<unknown>
}

export interface HostedSessions {
  /** The driver of a live hosted session, by app session id. */
  hookTarget(sessionId: string): HostedHookTarget | undefined
  /** Is this Claude `session_id` one of the hosted sessions? (Avoids a duplicate external manager.) */
  ownsProviderSession(providerSessionId: string): boolean
}

const MAX_EXTERNAL = 100

const folderName = (cwd: unknown): string => {
  if (typeof cwd !== 'string') return ''
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return (parts[parts.length - 1] ?? '').slice(0, 60)
}

/**
 * The `/hooks/claude-code` adapter. It never returns a permission decision unless a hosted
 * session's driver does, and a decision only ever comes from the renderer over IPC.
 */
export function createClaudeCodeHooksAdapter(hosted?: HostedSessions): HttpAdapter {
  const external = new Map<string, ClaudeHookMapper>()

  return {
    route: CLAUDE_HOOKS_ROUTE,
    maxBody: CLAUDE_HOOKS_MAX_BODY,
    handle(raw: unknown, sink: EventSink, ctx: RequestContext): unknown | Promise<unknown> {
      if (!isRecord(raw)) return {}
      if (ctx.auth.kind === 'session') {
        return hosted?.hookTarget(ctx.auth.sessionId)?.handleHook(raw, ctx) ?? {}
      }
      // Global token: an external session. An inbox endpoint is only ever accepted from a hosted
      // session's own token, so drop one sent here without looking at it.
      const body = { ...raw }
      delete body[AO_ENVELOPE_KEY]
      const sessionId = str(body.session_id, 200)
      if (!sessionId || hosted?.ownsProviderSession(sessionId)) return {}
      let mapper = external.get(sessionId)
      if (!mapper) {
        if (body.hook_event_name === 'SessionEnd') return {}
        if (external.size >= MAX_EXTERNAL) external.delete(external.keys().next().value as string)
        mapper = new ClaudeHookMapper({ rootId: sessionId, displayName: folderName(body.cwd) || sessionId.slice(0, 8) })
        external.set(sessionId, mapper)
      }
      const mapped = mapper.handle(body)
      for (const e of mapped.events) sink.emit(e)
      if (mapped.kind === 'session-end') external.delete(sessionId)
      return {} // including PermissionRequest: the terminal's own dialog decides
    }
  }
}
