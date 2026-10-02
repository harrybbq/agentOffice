// Codex driver: one hosted session = one thread on the shared `codex app-server` (codexServer.ts).
// There is no TUI: the session's surface is the chat view, fed by the ChatItem list this driver
// keeps (codexChat.ts). Approvals arrive as server requests on the same pipe and go to the CEO
// inbox (permissions.ts); orders and chat input are real user turns (`turn/start`, or `turn/steer`
// into a running turn). Everything here follows docs/spikes-phase-b.md.
//
// State:  starting ──thread/start──▶ idle ──turn/started──▶ busy ──turn/completed──▶ idle
//         busy ◀──▶ waiting-permission (while an approval is pending)
//         server down / logged out ──▶ needs-attention (back to idle once reconnected / logged in)
//
// No Electron imports: the server and `openExternal` come in through CodexProviderOptions.
import { randomBytes } from 'node:crypto'
import type { ChatEvent, ChatItem } from '../../shared/chat'
import type { AgentEvent } from '../../shared/events'
import {
  subagentId,
  type PermissionDecision,
  type PermissionOutcome,
  type ProviderInfo,
  type SessionHistoryEntry,
  type SessionState
} from '../../shared/sessions'
import { permissionAction, plainPermission } from '../../shared/permissionText'
import { ClaudeHookMapper } from '../adapters/claude-code-hooks'
import type { BoardConflict } from '../board'
import { BOARD_SERVER_CODEX } from '../boardMcp'
import type { BoardFile } from '../../shared/board'
import { officeBriefing } from './briefing'
import { approvalResult, describeServerRequest } from './codexApproval'
import { clientMessageId, CodexChat, type ChatContext, type UserOrigin } from './codexChat'
import {
  accountInfo,
  arr,
  isAllowedLoginUrl,
  isAuthError,
  isRecord,
  NOT_LOGGED_IN,
  parentThreadIdOf,
  policyFor,
  sandboxMismatch,
  sandboxTypeOf,
  str,
  textInput,
  threadHistory,
  usageInfo,
  type CodexPolicy,
  type JsonRpcId
} from './codexProtocol'
import {
  CODEX_CLIENT_NAME,
  CodexRpcError,
  CodexServer,
  codexVersion,
  findCodexExecutable,
  type CodexConnection,
  type CodexServerEvent,
  type CodexServerOptions
} from './codexServer'
import { CODEX_PROVIDER, collabInfo, worldActivityForItem } from './codexWorld'
import type { AgentDriver, DriverContext, PromptOrigin, PromptResult, ProviderDefinition } from './types'

export const CODEX_LABEL = 'Codex'
/** Turns of history loaded on resume (newest), in pages of this size. */
const HISTORY_PAGE_TURNS = 50
const HISTORY_MAX_PAGES = 4
const MAX_CHILD_THREADS = 50
/** An abandoned login is cancelled after this long, which frees its local callback port. */
const LOGIN_TIMEOUT_MS = 10 * 60_000
const ACCOUNT_TTL_MS = 15_000
/** How long the provider list waits for the account before answering without it. */
const PROBE_ACCOUNT_WAIT_MS = 5000
/** Threads asked of `thread/list` for one folder; of the ones this app started, the newest HISTORY_SHOWN are offered. */
const HISTORY_LIST_LIMIT = 50
const HISTORY_SHOWN = 12

/** The digest is context for the turn, not a reason to hold it up. */
const DIGEST_INJECT_TIMEOUT_MS = 5000
/** At most this many conflict warnings are put into one message to the model. */
const MAX_WARNINGS_PER_MESSAGE = 3

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The files of a `fileChange` item: absolute paths, and what happens to each. */
export function fileChangesOf(item: unknown): Array<{ path: string; kind: BoardFile['kind'] }> {
  if (!isRecord(item)) return []
  return arr(item.changes)
    .map((c) => {
      if (!isRecord(c)) return null
      const type = isRecord(c.kind) ? c.kind.type : c.kind
      return { path: str(c.path, 2000), kind: (type === 'add' ? 'create' : type === 'delete' ? 'delete' : 'edit') as BoardFile['kind'] }
    })
    .filter((c): c is { path: string; kind: BoardFile['kind'] } => !!c && c.path.length > 0)
}

/**
 * The office board as an MCP server of ONE thread (`config` of thread/start and thread/resume).
 * The key is dotted on purpose: a nested `{mcp_servers: {…}}` object replaced the whole table of
 * another config layer in the spikes; a dotted key merges. The token is a literal here (it travels
 * over the app-server's stdin and is in no process environment); the app-server does not write a
 * thread's `config` to its rollout (checked: scripts/spikes/board/codex-persist-probe.cjs), and the
 * token is replaced on every start, resume and reload and dies with the session.
 */
export function codexBoardConfig(mcp: { url: string; token: string }): Record<string, unknown> {
  return { [`mcp_servers.${BOARD_SERVER_CODEX}`]: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` } } }
}

/** Is this server request Codex asking before it runs one of the office board's own tools? */
export function isBoardToolApproval(params: Record<string, unknown>): boolean {
  if (params.serverName !== BOARD_SERVER_CODEX || params.mode === 'url') return false
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : {}
  if (isRecord(schema.properties) && Object.keys(schema.properties).length > 0) return false
  return isRecord(params._meta) && params._meta.codex_approval_kind === 'mcp_tool_call'
}

// ---- account ----------------------------------------------------------------------------------------

/** The Codex account as the provider list shows it, kept current by the server's notifications. */
export class CodexAccount {
  private account: ProviderInfo['account']
  private usage: ProviderInfo['usage']
  private readAt = 0
  private reading: Promise<NonNullable<ProviderInfo['account']>> | null = null
  private listeners = new Set<() => void>()
  private login: { id: string; timer: NodeJS.Timeout } | null = null

  constructor(
    private readonly conn: CodexConnection,
    private readonly openExternal: (url: string) => Promise<void>
  ) {
    conn.onEvent((e) => this.onServerEvent(e))
  }

  get current(): { account: ProviderInfo['account']; usage: ProviderInfo['usage'] } {
    return { account: this.account, usage: this.usage }
  }

  onChanged(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  /** The account, read from the server if what we know is older than `maxAgeMs`. */
  async read(maxAgeMs = ACCOUNT_TTL_MS): Promise<NonNullable<ProviderInfo['account']>> {
    if (this.account && Date.now() - this.readAt < maxAgeMs) return this.account
    if (!this.reading) {
      this.reading = this.refresh().finally(() => {
        this.reading = null
      })
    }
    return this.reading
  }

  private async refresh(): Promise<NonNullable<ProviderInfo['account']>> {
    await this.conn.ensureStarted()
    const before = JSON.stringify(this.current)
    const account = accountInfo(await this.conn.request('account/read', { refreshToken: false }, 20_000))
    this.account = account
    this.readAt = Date.now()
    if (!account.loggedIn) this.usage = undefined
    else {
      try {
        this.usage = usageInfo(await this.conn.request('account/rateLimits/read', undefined, 20_000)) ?? this.usage
      } catch {
        // An API-key account has no rate-limit window to report.
      }
    }
    if (JSON.stringify(this.current) !== before) this.changed()
    return account
  }

  /** Opens the ChatGPT login in the system browser. Resolves once the flow was started. */
  async startLogin(): Promise<void> {
    const account = await this.read(0)
    if (account.loggedIn) return
    await this.cancelLogin()
    const result = await this.conn.request('account/login/start', { type: 'chatgpt' }, 30_000)
    const loginId = isRecord(result) ? str(result.loginId, 200) : ''
    const authUrl = isRecord(result) ? result.authUrl : null
    if (!isAllowedLoginUrl(authUrl)) {
      if (loginId) void this.conn.request('account/login/cancel', { loginId }).catch(() => {})
      throw new Error('Codex returned a login address that is not an OpenAI login page; nothing was opened')
    }
    if (loginId) {
      const timer = setTimeout(() => void this.cancelLogin(), LOGIN_TIMEOUT_MS)
      timer.unref?.()
      this.login = { id: loginId, timer }
    }
    await this.openExternal(authUrl)
  }

  async cancelLogin(): Promise<void> {
    const login = this.login
    if (!login) return
    this.login = null
    clearTimeout(login.timer)
    await this.conn.request('account/login/cancel', { loginId: login.id }, 10_000).catch(() => {})
  }

  private onServerEvent(e: CodexServerEvent): void {
    if (e.type === 'down') {
      if (this.login) clearTimeout(this.login.timer)
      this.login = null
      return
    }
    if (e.type !== 'notification') return
    switch (e.method) {
      case 'account/login/completed':
        if (this.login && (!e.params.loginId || e.params.loginId === this.login.id)) {
          clearTimeout(this.login.timer)
          this.login = null
        }
        void this.read(0).catch(() => {})
        break
      case 'account/updated': {
        // `authMode: null` = logged out. The plan may be missing from a sparse update.
        const loggedIn = e.params.authMode != null
        const plan = str(e.params.planType, 40) || (loggedIn ? this.account?.plan : undefined)
        const before = JSON.stringify(this.current)
        this.account = plan ? { loggedIn, plan } : { loggedIn }
        this.readAt = Date.now()
        if (!loggedIn) this.usage = undefined
        if (JSON.stringify(this.current) !== before) this.changed()
        // The usage window belongs to the account: read it for the new one.
        if (loggedIn && !this.usage) void this.read(0).catch(() => {})
        break
      }
      case 'account/rateLimits/updated': {
        // A sparse update: keep what it doesn't carry.
        const usage = usageInfo(e.params)
        if (!usage) break
        const next = { ...this.usage, ...usage }
        if (JSON.stringify(next) === JSON.stringify(this.usage)) break
        this.usage = next
        this.changed()
        break
      }
      default:
        break
    }
  }

  private changed(): void {
    for (const cb of [...this.listeners]) cb()
  }
}

// ---- driver -----------------------------------------------------------------------------------------

export interface CodexDriverDeps {
  conn: CodexConnection
  account: Pick<CodexAccount, 'read' | 'onChanged' | 'current'>
  /** Reasoning effort for every turn (the end-to-end check uses "low"). Default: the model's own. */
  effort?: string
  now?: () => number
}

interface PendingApproval {
  rpcId: JsonRpcId
  method: string
  params: Record<string, unknown>
  agentId: string
  /** The server no longer waits for an answer (it said so, or it is gone): nothing is sent. */
  void: boolean
  /** The request's turn ended without the server withdrawing it: it gets `cancel`, to be safe. */
  ended: boolean
  permissionId: string | null
}

export class CodexDriver implements AgentDriver {
  readonly provider = 'codex' as const
  readonly surface = 'chat' as const
  private readonly id: string
  private readonly chat: CodexChat
  private readonly world: ClaudeHookMapper
  private readonly policy: CodexPolicy
  private readonly now: () => number
  private threadId: string | undefined
  /** Sub-agent thread id -> world id. */
  private children = new Map<string, string>()
  private activeTurnId: string | null = null
  private approvals = new Map<JsonRpcId, PendingApproval>()
  private disconnected = false
  private loggedOut = false
  private exited = false
  private unsubscribes: Array<() => void> = []
  private lastState: SessionState = 'starting'
  private title: string
  /** Turns whose end we saw (a few, newest last): a late `turn/start` answer must not revive one. */
  private endedTurns = new Set<string>()
  /** Prompts are sent one at a time, so the second of two sees the turn the first one started. */
  private sendQueue: Promise<unknown> = Promise.resolve()
  private turnWaiters: Array<() => void> = []
  /** The thread was given the office board's MCP server. */
  private boardTools = false

  constructor(
    private readonly ctx: DriverContext,
    private readonly deps: CodexDriverDeps
  ) {
    this.id = ctx.sessionId
    this.title = ctx.start.title
    this.now = deps.now ?? Date.now
    this.chat = new CodexChat(this.id)
    this.policy = policyFor(ctx.start.permissionMode)
    this.world = new ClaudeHookMapper({ rootId: this.id, displayName: ctx.start.title, provider: CODEX_PROVIDER, holdWaiting: true, endsWithProcess: true })
  }

  get state(): SessionState {
    if (this.exited) return 'exited'
    if (!this.threadId) return 'starting'
    if (this.disconnected || this.loggedOut) return 'needs-attention'
    if (this.ctx.permissions.count(this.id) > 0) return 'waiting-permission'
    return this.activeTurnId ? 'busy' : 'idle'
  }

  get providerSessionId(): string | undefined {
    return this.threadId
  }

  get canReceiveOrders(): boolean {
    // idle: turn/start. busy / waiting-permission: turn/steer (the model reads it after the running tool call).
    const s = this.state
    return s === 'idle' || s === 'busy' || s === 'waiting-permission'
  }

  chatItems(): ChatItem[] {
    return this.chat.list()
  }

  // -- start --

  async start(): Promise<void> {
    const { conn } = this.deps
    await conn.ensureStarted()
    // A turn on a logged-out server fails only after 15 s of retries: refuse now instead.
    const account = await this.deps.account.read(0)
    if (!account.loggedIn) throw new Error(NOT_LOGGED_IN)

    const start = this.ctx.start
    // The office board's tools for this thread only, with a fresh token; null when the board is off.
    const board = this.ctx.board?.mcp() ?? null
    this.boardTools = !!board
    const params: Record<string, unknown> = {
      cwd: start.cwd,
      approvalPolicy: this.policy.approvalPolicy,
      sandbox: this.policy.sandbox,
      // What the session is told about Agent Office (drivers/briefing.ts). No secret in it.
      developerInstructions: officeBriefing('codex', { title: start.title, board: !!board })
    }
    if (board) params.config = codexBoardConfig(board)
    if (start.model) params.model = start.model
    let response: unknown
    if (start.resume) {
      // Subscribe first: the server may send notifications for a known thread before it answers.
      this.subscribe(start.resume)
      try {
        // Resume restores neither the sandbox nor (reliably) the approval policy: send both again.
        response = await conn.request('thread/resume', { ...params, threadId: start.resume, excludeTurns: true })
      } catch (err) {
        this.unsubscribeAll()
        throw new Error(`Codex could not resume that thread: ${message(err)}`)
      }
    } else {
      try {
        response = await conn.request('thread/start', params)
      } catch (err) {
        throw new Error(`Codex could not start a thread: ${message(err)}`)
      }
    }
    const thread = isRecord(response) && isRecord(response.thread) ? response.thread : {}
    const threadId = str(thread.id, 100)
    if (!threadId) {
      this.unsubscribeAll()
      throw new Error('Codex did not return a thread id')
    }
    if (threadId !== start.resume) {
      this.unsubscribeAll()
      this.subscribe(threadId)
    }
    this.unsubscribes.push(conn.onEvent((e) => this.onServerEvent(e)))
    this.unsubscribes.push(this.deps.account.onChanged(() => this.onAccountChanged()))
    this.threadId = threadId
    this.ctx.events.onProviderSession(threadId)
    const model = isRecord(response) ? str(response.model, 100) : ''
    if (model) this.ctx.events.onModel(model)

    this.emitWorld(this.world.spawn(this.now()))
    if (start.resume) this.emitChat([await this.history(threadId)])
    this.checkSandbox(response)
    this.refresh()
  }

  private subscribe(threadId: string): void {
    this.unsubscribes.push(
      this.deps.conn.subscribeThread(threadId, {
        notification: (t, method, params) => this.onNotification(t, method, params),
        request: (t, id, method, params) => this.onRequest(t, id, method, params)
      })
    )
  }

  private unsubscribeAll(): void {
    for (const u of this.unsubscribes.splice(0)) u()
  }

  /** The newest turns of the thread, oldest first, as a `reset`. */
  private async history(threadId: string): Promise<ChatEvent> {
    const turns: unknown[] = []
    let cursor: string | null = null
    let failed: string | null = null
    try {
      for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
        const params: Record<string, unknown> = { threadId, limit: HISTORY_PAGE_TURNS, sortDirection: 'desc', itemsView: 'full' }
        if (cursor) params.cursor = cursor
        const res = await this.deps.conn.request('thread/turns/list', params)
        if (!isRecord(res)) break
        turns.push(...arr(res.data))
        cursor = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null
        if (!cursor) break
      }
    } catch (err) {
      failed = message(err)
    }
    // Pages came newest first.
    const reset = this.chat.loadHistory(turns.reverse(), this.at(this.id))
    if (failed === null) return reset
    this.chat.notice('warning', `The earlier conversation could not be loaded completely: ${failed}`, this.at(this.id))
    return this.chat.resetEvent()
  }

  private checkSandbox(response: unknown): void {
    const problem = sandboxMismatch(this.policy, response)
    if (problem) this.emitChat(this.chat.notice('warning', problem, this.at(this.id)))
    // What the server gave us is the template for every turn (it knows the writable roots).
    const sandbox = isRecord(response) ? response.sandbox : null
    if (isRecord(sandbox) && sandboxTypeOf(response) === this.policy.sandboxType) this.policy.sandboxPolicy = { ...sandbox }
  }

  // -- notifications --

  private at(agentId: string): ChatContext {
    return { agentId, now: this.now() }
  }

  private agentFor(threadId: string): string {
    return threadId === this.threadId ? this.id : (this.children.get(threadId) ?? this.id)
  }

  private onNotification(threadId: string, method: string, params: Record<string, unknown>): void {
    if (this.exited) return
    const agentId = this.agentFor(threadId)
    const main = agentId === this.id
    const now = this.now()

    switch (method) {
      case 'turn/started': {
        const turnId = isRecord(params.turn) ? str(params.turn.id, 100) : ''
        if (main && turnId) this.activeTurnId = turnId
        break
      }
      case 'item/started':
      case 'item/completed': {
        const item = params.item
        const collab = collabInfo(item)
        if (collab) this.onCollab(collab, method === 'item/completed', now)
        if (isRecord(item) && item.type === 'subAgentActivity') this.onSubAgentActivity(item, now)
        // Not for a turn that is over: Codex announces a command's process start even after the
        // turn was interrupted, and the character must not go back to work on it.
        if (method === 'item/started' && !this.endedTurns.has(str(params.turnId, 100))) {
          const activity = worldActivityForItem(item, this.ctx.start.cwd)
          if (activity) this.emitWorld(this.world.activity(agentId, activity.activity, activity.detail, now))
        }
        if (isRecord(item) && item.type === 'fileChange') this.onFileChange(item, method === 'item/completed')
        break
      }
      case 'serverRequest/resolved': {
        // Also sent after our own answer; then the request is no longer in the map.
        const rpcId = params.requestId
        const pending = typeof rpcId === 'number' || typeof rpcId === 'string' ? this.approvals.get(rpcId) : undefined
        if (pending) {
          pending.void = true
          if (pending.permissionId) this.ctx.permissions.resolveElsewhere(pending.permissionId)
          else this.approvals.delete(pending.rpcId)
        }
        break
      }
      case 'turn/completed': {
        const turn = isRecord(params.turn) ? params.turn : {}
        // Whatever this agent still had pending died with the turn. The server normally says so
        // first (serverRequest/resolved); if it didn't, the request is answered with `cancel`:
        // an answer to a dead request is harmless, an unanswered live one would hang.
        for (const a of this.approvals.values()) if (a.agentId === agentId) a.ended = true
        this.ctx.permissions.clearSession(this.id, agentId)
        if (main) {
          this.activeTurnId = null
          // The account knows whether the login is really gone; onAccountChanged takes it from there.
          if (turn.status === 'failed' && isAuthError(turn.error)) void this.deps.account.read(0).catch(() => {})
        }
        this.emitWorld(this.world.settle(agentId, now))
        break
      }
      case 'thread/closed':
        if (!main) this.endChild(threadId, now)
        break
      case 'model/rerouted': {
        const to = str(params.toModel, 100)
        if (main && to) this.ctx.events.onModel(to)
        break
      }
      default:
        break
    }

    this.emitChat(this.chat.apply(method, params, { agentId, now }))
    if (method === 'turn/completed' && main) for (const w of this.turnWaiters.splice(0)) w()
    this.refresh()
  }

  // -- sub-agents (untested in the spikes: tolerant of anything) --

  private addChild(threadId: string, name: string, detail: string, now: number): string | null {
    if (!threadId || threadId === this.threadId) return null
    const known = this.children.get(threadId)
    if (known) return known
    if (this.children.size >= MAX_CHILD_THREADS) return null
    const worldId = subagentId(this.id, threadId)
    this.children.set(threadId, worldId)
    // The worker's own items arrive under its thread id, if the server sends them to us at all.
    this.subscribe(threadId)
    this.emitWorld(this.world.activity(worldId, 'idle', detail, now, name || 'Sub-agent'))
    return worldId
  }

  private endChild(threadId: string, now: number): void {
    const worldId = this.children.get(threadId)
    if (!worldId) return
    this.ctx.permissions.clearSession(this.id, worldId)
    this.emitWorld(this.world.finish(worldId, now))
  }

  private onCollab(collab: NonNullable<ReturnType<typeof collabInfo>>, completed: boolean, now: number): void {
    if (collab.tool === 'spawnAgent') for (const t of collab.receivers) this.addChild(t, '', collab.prompt, now)
    if (!completed) return
    if (collab.tool === 'closeAgent') for (const t of collab.receivers) this.endChild(t, now)
    for (const t of collab.ended) this.endChild(t, now)
  }

  private onSubAgentActivity(item: Record<string, unknown>, now: number): void {
    const threadId = str(item.agentThreadId, 100)
    if (!threadId) return
    if (item.kind === 'completed' || item.kind === 'interrupted') this.endChild(threadId, now)
    else this.addChild(threadId, str(item.agentPath, 60).split('/').pop() ?? '', '', now)
  }

  private onServerEvent(e: CodexServerEvent): void {
    if (this.exited) return
    if (e.type === 'notification') {
      // A thread nobody subscribed to yet: a sub-agent of ours announces itself with its parent.
      if (e.method !== 'thread/started' || !isRecord(e.params.thread)) return
      const thread = e.params.thread
      const parent = parentThreadIdOf(thread)
      if (parent && (parent === this.threadId || this.children.has(parent))) {
        this.addChild(str(thread.id, 100), str(thread.agentNickname, 60) || str(thread.agentRole, 60), '', this.now())
      }
      return
    }
    if (e.type === 'down') {
      if (e.expected) return
      this.disconnected = true
      const turnId = this.activeTurnId
      this.activeTurnId = null
      for (const a of this.approvals.values()) a.void = true
      this.ctx.permissions.clearSession(this.id)
      const at = this.at(this.id)
      this.emitChat(this.chat.closeOpen(null, 'failed'))
      this.emitChat(this.chat.notice('error', 'The Codex app-server stopped unexpectedly. Reconnecting…', at, { id: 'connection' }))
      if (turnId) this.emitChat([{ type: 'turn', sessionId: this.id, turnId, status: 'failed', error: 'the Codex app-server stopped' }])
      for (const w of this.turnWaiters.splice(0)) w()
      this.emitWorld(this.world.settle(this.id, at.now))
      this.refresh()
      return
    }
    if (e.type === 'up' && this.disconnected) void this.reconnect()
  }

  /**
   * Loads the thread into the server again, with the session's policy and sandbox (resume restores
   * neither) and, if it had them, the office board's tools under a NEW token.
   */
  private async reload(threadId: string): Promise<void> {
    const params: Record<string, unknown> = {
      threadId,
      excludeTurns: true,
      cwd: this.ctx.start.cwd,
      approvalPolicy: this.policy.approvalPolicy,
      sandbox: this.policy.sandbox
    }
    const board = this.boardTools ? (this.ctx.board?.mcp(true) ?? null) : null
    if (board) params.config = codexBoardConfig(board)
    const response = await this.deps.conn.request('thread/resume', params)
    this.checkSandbox(response)
  }

  // -- office board (electron/board.ts). A failure here must never get in the way of a turn. --

  /**
   * Before a new turn: the board's digest as a developer message in the thread's history (not the
   * user's words, and no chat item). Skipped when there is no news; a failure is ignored.
   */
  private async injectDigest(threadId: string): Promise<void> {
    let digest: ReturnType<NonNullable<DriverContext['board']>['digest']> = null
    try {
      digest = this.ctx.board?.digest() ?? null
    } catch {
      return
    }
    if (!digest) return
    try {
      await this.deps.conn.request(
        'thread/inject_items',
        { threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: digest.text }] }] },
        DIGEST_INJECT_TIMEOUT_MS
      )
      this.ctx.board?.digestSent(digest.hash)
    } catch {
      // The turn starts without the digest; the next one tries again.
    }
  }

  /** The conflicts of these files this session was not warned about yet. */
  private freshConflicts(paths: string[]): BoardConflict[] {
    const board = this.ctx.board
    if (!board) return []
    const out: BoardConflict[] = []
    for (const path of paths) {
      const c = board.conflict(path)
      if (c && !c.warned && !out.some((o) => o.path === c.path)) out.push(c)
    }
    return out
  }

  /** Records the warnings and returns what the model is told (one message). */
  private warnAbout(conflicts: BoardConflict[], mode: 'block-once' | 'note'): string {
    const texts = conflicts.map((c) => this.ctx.board!.warn(c, mode))
    return texts.slice(0, MAX_WARNINGS_PER_MESSAGE).join('\n')
  }

  /**
   * A file change of the thread. Started: where no approval will be asked (acceptEdits), or the
   * setting says `note`, the model is told about a conflict after the fact, as a message into the
   * running turn. Completed: the files are on the board as changed by this team.
   */
  private onFileChange(item: Record<string, unknown>, completed: boolean): void {
    const board = this.ctx.board
    if (!board) return
    try {
      const changes = fileChangesOf(item)
      const mode = board.conflictMode
      // In `default` mode with block-once the approval request is where the change is stopped. A
      // change that went through without one is noted when it completes.
      const stoppedAtApproval = mode === 'block-once' && this.policy.approvalPolicy === 'untrusted'
      if (mode !== 'off' && (completed ? item.status === 'completed' : !stoppedAtApproval)) {
        const fresh = this.freshConflicts(changes.map((c) => c.path))
        if (fresh.length > 0) void this.enqueue(this.warnAbout(fresh, 'note'), 'steer')
      }
      if (completed && item.status === 'completed') for (const c of changes) board.fileChanged(c.path, c.kind)
    } catch {
      // the board is a convenience
    }
  }

  /**
   * `block-once` for a file change that asks for approval: decline it once and tell the model why
   * (the same path as a denial with a message). True when the request was answered here.
   */
  private stopForConflict(rpcId: JsonRpcId, method: string, params: Record<string, unknown>, agentId: string): boolean {
    const board = this.ctx.board
    if (!board || method !== 'item/fileChange/requestApproval') return false
    try {
      if (board.conflictMode !== 'block-once') return false
      const subject = this.chat.get(str(params.itemId, 200))
      const fresh = this.freshConflicts(subject?.kind === 'file-change' ? subject.changes.map((c) => c.path) : [])
      if (fresh.length === 0) return false
      const text = this.warnAbout(fresh, 'block-once')
      this.deps.conn.respond(rpcId, approvalResult(method, params, { behavior: 'deny' }))
      const first = fresh[0]
      this.emitChat(
        this.chat.notice(
          'warning',
          `Office board: this change was stopped once, because team "${first.otherTeam}" changed ${first.path} a moment ago. The agent was told and may make the change again.`,
          this.at(agentId),
          { turnId: str(params.turnId, 100) || undefined }
        )
      )
      void this.enqueue(text, 'steer')
      return true
    } catch {
      return false
    }
  }

  /** The server is back after a crash: load the thread again. A thread that can't be loaded ends the session. */
  private async reconnect(): Promise<void> {
    const threadId = this.threadId
    if (!threadId || this.exited) return
    try {
      await this.reload(threadId)
      if (this.exited) return
      this.disconnected = false
      this.emitChat(this.chat.notice('info', 'Reconnected to Codex. The turn that was running was lost.', this.at(this.id), { id: 'connection' }))
    } catch (err) {
      if (this.exited || !this.disconnected) return
      // The server went down again meanwhile: its next start brings us back here.
      if (!(err instanceof CodexRpcError) || err.code === undefined) return
      this.emitChat(this.chat.notice('error', `Codex came back but the thread could not be loaded: ${message(err)}`, this.at(this.id), { id: 'connection' }))
      this.finish(1)
      return
    }
    this.refresh()
  }

  private onAccountChanged(): void {
    if (this.exited || !this.threadId) return
    const loggedIn = this.deps.account.current.account?.loggedIn
    if (loggedIn === undefined || loggedIn === !this.loggedOut) return
    this.loggedOut = !loggedIn
    this.emitChat(
      this.chat.notice(loggedIn ? 'info' : 'error', loggedIn ? 'Logged in to Codex again.' : NOT_LOGGED_IN, this.at(this.id), { id: 'account' })
    )
    this.refresh()
  }

  // -- approvals --

  private onRequest(threadId: string, rpcId: JsonRpcId, method: string, params: Record<string, unknown>): void {
    const { conn } = this.deps
    if (this.exited) return conn.respond(rpcId, approvalResult(method, params, null))
    const agentId = this.agentFor(threadId)
    const itemId = str(params.itemId, 200)
    // The office board's own tools never need a card (they only read and write the board). Their
    // annotations already make Codex run them unasked; this is the safety net if it asks anyway.
    if (method === 'mcpServer/elicitation/request' && this.boardTools && isBoardToolApproval(params)) {
      return conn.respond(rpcId, approvalResult(method, params, { behavior: 'allow' }))
    }
    // A file another team just changed: stopped once, with the reason, before any card.
    if (this.stopForConflict(rpcId, method, params, agentId)) return
    const subject = itemId ? this.chat.get(itemId) : undefined
    const handling = describeServerRequest(method, params, subject, this.ctx.start.cwd)
    if (handling.kind === 'unknown') return conn.respondError(rpcId, -32601, 'not handled by Agent Office')
    if (handling.kind === 'auto') {
      conn.respond(rpcId, handling.result)
      this.emitChat(this.chat.notice('warning', handling.notice, this.at(agentId), { turnId: str(params.turnId, 100) || undefined }))
      return
    }
    const { card } = handling
    const pending: PendingApproval = { rpcId, method, params, agentId, void: false, ended: false, permissionId: null }
    this.approvals.set(rpcId, pending)
    const displayName = agentId === this.id ? this.title : 'Sub-agent'
    // One plain sentence for the card. A sub-agent is named with the team it works for.
    const who = agentId === this.id ? this.title : `Sub-agent (${this.title}'s team)`
    let plain = plainPermission({ who, tool: card.plain.tool, input: card.plain.input, cwd: this.ctx.start.cwd })
    let detail = card.detail
    // The agent was warned and asks again (or the setting only notes): the user sees the conflict on the card.
    const conflict = method === 'item/fileChange/requestApproval' && subject?.kind === 'file-change' ? this.liveConflict(subject.changes.map((c) => c.path)) : null
    if (conflict) {
      if (plain.risk !== 'danger') plain = { ...plain, risk: 'caution', riskNote: conflict.riskNote }
      detail = `${conflict.line}\n\n${detail}`
    }
    const permissionId = this.ctx.permissions.add(
      { sessionId: this.id, agentId, displayName, provider: 'codex', toolName: card.toolName, summary: card.summary, detail, ...plain },
      { onResolved: (outcome, decision) => this.onApprovalResolved(pending, outcome, decision) }
    )
    if (!permissionId) return // too many pending: onResolved already declined it
    pending.permissionId = permissionId
    // As the registry holds it (cleaned and capped): the chat card shows the same words as the inbox.
    const held = this.ctx.permissions.get(permissionId)
    const at = this.at(agentId)
    this.emitWorld(this.world.waiting(agentId, permissionAction(held?.question ?? plain.question), at.now))
    this.emitChat(
      this.chat.approvalRequested(
        {
          requestId: permissionId,
          subjectId: card.itemId || undefined,
          summary: card.summary,
          detail,
          question: held?.question ?? plain.question,
          risk: held?.risk ?? plain.risk,
          riskNote: held?.riskNote,
          turnId: str(params.turnId, 100) || undefined
        },
        at
      )
    )
    this.refresh()
  }

  /** The first of these files another team changed recently, as the user's card says it. */
  private liveConflict(paths: string[]): { riskNote: string; line: string } | null {
    try {
      const board = this.ctx.board
      if (!board) return null
      for (const path of paths) {
        const c = board.conflict(path)
        if (c) return board.cardText(c)
      }
    } catch {
      // the board is a convenience
    }
    return null
  }

  private onApprovalResolved(pending: PendingApproval, outcome: PermissionOutcome, decision: PermissionDecision | null): void {
    this.approvals.delete(pending.rpcId)
    const answer = outcome === 'allowed' || outcome === 'denied' ? decision : null
    if (answer) this.deps.conn.respond(pending.rpcId, approvalResult(pending.method, pending.params, answer))
    else if (!pending.void) {
      // Nobody will decide and the server may still wait: cancel when the turn or the session is
      // over, decline when the inbox is full.
      this.deps.conn.respond(pending.rpcId, approvalResult(pending.method, pending.params, this.exited || pending.ended ? null : { behavior: 'deny' }))
    }
    if (!pending.permissionId) return
    const now = this.now()
    this.emitChat(this.chat.approvalResolved(pending.permissionId, answer ? (answer.behavior === 'allow' ? 'allowed' : 'denied') : 'resolved-elsewhere'))
    this.emitWorld(this.world.resume(pending.agentId, now))
    // Codex's decision has no message field: the user's reason follows as a message into the turn.
    if (answer?.behavior === 'deny' && answer.message) void this.enqueue(answer.message, 'steer')
    this.refresh()
  }

  answerPermission(requestId: string, decision: PermissionDecision): PermissionOutcome {
    return this.ctx.permissions.decide(requestId, decision)
  }

  // -- control --

  setTitle(title: string): void {
    if (this.exited) return
    this.title = title
    this.emitWorld(this.world.rename(title, this.now()))
  }

  interrupt(): void {
    const turnId = this.activeTurnId
    if (this.exited || !turnId || !this.threadId) return
    // `turn/completed` with status "interrupted" follows; the chat closes the open items then.
    this.deps.conn.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {})
  }

  sendPrompt(text: string, origin: PromptOrigin = 'order'): Promise<PromptResult> {
    return this.enqueue(text, origin)
  }

  private enqueue(text: string, origin: UserOrigin): Promise<PromptResult> {
    const run = this.sendQueue.then(() => this.deliver(text, origin).catch((err): PromptResult => ({ ok: false, reason: message(err) })))
    this.sendQueue = run
    return run
  }

  private async deliver(text: string, origin: UserOrigin): Promise<PromptResult> {
    if (this.exited) return { ok: false, reason: 'the session has ended' }
    const threadId = this.threadId
    if (!threadId) return { ok: false, reason: 'the session is not ready yet' }
    if (this.loggedOut) return { ok: false, reason: NOT_LOGGED_IN }
    if (this.disconnected) return { ok: false, reason: 'Codex is restarting; try again in a moment' }
    const { conn } = this.deps
    const at = this.at(this.id)
    const input = textInput(text)

    const steerTurn = this.activeTurnId
    if (steerTurn) {
      // Typed in the chat box while a turn runs = a steer. An order stays an order.
      const steerOrigin = origin === 'human' ? 'steer' : origin
      const clientId = clientMessageId(steerOrigin, randomBytes(8).toString('hex'))
      this.chat.expectUser(clientId, text, steerOrigin)
      try {
        await conn.request('turn/steer', { threadId, expectedTurnId: steerTurn, input, clientUserMessageId: clientId })
        this.emitChat(this.chat.userSent(clientId, at, steerTurn))
        return { ok: true, queued: true }
      } catch (err) {
        this.chat.forgetUser(clientId)
        // The turn ended between our check and the request: start a new one instead.
        if (!/no active turn/i.test(message(err))) return { ok: false, reason: message(err) }
        if (this.activeTurnId === steerTurn) this.activeTurnId = null
      }
    }
    if (origin === 'steer') return { ok: false, reason: 'the turn has already ended' }

    // A new turn (never a steer): what the other teams did since this session's last digest.
    await this.injectDigest(threadId)
    if (this.exited) return { ok: false, reason: 'the session has ended' }

    const clientId = clientMessageId(origin, randomBytes(8).toString('hex'))
    this.chat.expectUser(clientId, text, origin)
    const params: Record<string, unknown> = {
      threadId,
      input,
      clientUserMessageId: clientId,
      // Every turn: the spikes showed a resumed thread forgetting both.
      approvalPolicy: this.policy.approvalPolicy,
      sandboxPolicy: this.policy.sandboxPolicy
    }
    if (this.deps.effort) params.effort = this.deps.effort
    try {
      const res = await conn.request('turn/start', params).catch(async (err) => {
        // The server unloaded the thread (it does that to idle ones): load it and try once more.
        if (!/thread not found|not loaded|unknown thread|no such thread/i.test(message(err))) throw err
        await this.reload(threadId)
        return conn.request('turn/start', params)
      })
      const turnId = isRecord(res) && isRecord(res.turn) ? str(res.turn.id, 100) : ''
      // `turn/started` normally comes right after; a turn that already ended must not be revived.
      if (turnId && this.activeTurnId === null && !this.endedTurns.has(turnId)) this.activeTurnId = turnId
      this.emitChat(this.chat.userSent(clientId, at, turnId || undefined))
      // A prompt of the user's (typed, or an order): the preview that is saved with the session.
      if (origin === 'human' || origin === 'order') this.ctx.events.onPrompt?.(text)
      this.refresh()
      return { ok: true, queued: false }
    } catch (err) {
      this.chat.forgetUser(clientId)
      return { ok: false, reason: message(err) }
    }
  }

  /** Drops the session. The thread stays in the user's Codex history; nothing is archived. */
  async stop(): Promise<void> {
    if (this.exited) return
    const threadId = this.threadId
    const { conn } = this.deps
    if (threadId && this.activeTurnId && !this.disconnected) {
      const ended = new Promise<void>((resolve) => this.turnWaiters.push(resolve))
      this.interrupt()
      await Promise.race([ended, new Promise((r) => setTimeout(r, 2000))])
    }
    if (threadId && !this.disconnected) {
      // Our subscription is what keeps the thread loaded in the server.
      for (const child of this.children.keys()) void conn.request('thread/unsubscribe', { threadId: child }, 5000).catch(() => {})
      await conn.request('thread/unsubscribe', { threadId }, 5000).catch(() => {})
    }
    this.finish(0)
  }

  // -- internals --

  private finish(exitCode: number | null): void {
    if (this.exited) return
    this.exited = true
    this.activeTurnId = null
    // Requests still pending are answered with `cancel` (onApprovalResolved sees `exited`).
    this.ctx.permissions.clearSession(this.id)
    this.ctx.board?.revoke()
    this.unsubscribeAll()
    this.emitChat(this.chat.closeOpen(null, 'interrupted'))
    this.emitWorld(this.world.end(this.now()))
    for (const w of this.turnWaiters.splice(0)) w()
    this.lastState = 'exited'
    this.ctx.events.onState('exited')
    this.ctx.events.onExit(exitCode)
  }

  private refresh(): void {
    const state = this.state
    if (state === this.lastState) return
    this.lastState = state
    this.ctx.events.onState(state)
  }

  private emitChat(events: readonly ChatEvent[]): void {
    for (const e of events) {
      if (e.type === 'turn' && e.status !== 'started') {
        this.endedTurns.add(e.turnId)
        if (this.endedTurns.size > 20) this.endedTurns.delete(this.endedTurns.values().next().value as string)
      }
      this.ctx.events.onChat(e)
    }
  }

  private emitWorld(events: readonly AgentEvent[]): void {
    for (const e of events) this.ctx.sink.emit(e)
  }
}

// ---- provider table row -----------------------------------------------------------------------------

export interface CodexProviderOptions {
  /** Opens a URL in the system browser (Electron's shell.openExternal). Only ever given a validated login URL. */
  openExternal(url: string): Promise<void>
  /** Overrides for tests and the end-to-end check. */
  server?: CodexServerOptions
  findExecutable?: () => string | null
  version?: (exe: string) => Promise<string>
  effort?: string
}

export interface CodexProvider extends ProviderDefinition {
  readonly server: CodexServer
  readonly account: CodexAccount
  login(): Promise<void>
  onChanged(cb: () => void): void
  shutdown(): Promise<void>
}

/** What the app-server answers when a thread to resume does not exist (any more). */
export const CODEX_NO_THREAD = /no rollout found|thread not found|unknown thread|no such thread/i

export function codexProvider(opts: CodexProviderOptions): CodexProvider {
  // One app-server for all Codex sessions, started on the first need (provider list, session start).
  const server = new CodexServer(opts.server)
  const account = new CodexAccount(server, opts.openExternal)
  const findExe = opts.findExecutable ?? (() => findCodexExecutable()?.exe ?? null)
  let version: { exe: string; value: string } | null = null
  const base = { id: 'codex' as const, label: CODEX_LABEL }

  return {
    ...base,
    server,
    account,
    async probe(): Promise<ProviderInfo> {
      const exe = findExe()
      if (!exe) return { ...base, available: false, reason: 'not installed' }
      if (version?.exe !== exe) {
        try {
          version = { exe, value: await (opts.version ?? codexVersion)(exe) }
        } catch {
          return { ...base, available: false, reason: '`codex --version` failed' }
        }
      }
      const info: ProviderInfo = { ...base, available: true, version: version.value }
      try {
        // Being logged out doesn't make the provider unavailable: the app offers "Log in".
        // A slow app-server must not hold up the provider list: the answer then arrives through onChanged.
        const read = account.read()
        read.catch(() => {})
        const known = await Promise.race([read, new Promise<null>((r) => setTimeout(() => r(null), PROBE_ACCOUNT_WAIT_MS))])
        if (known) info.account = known
      } catch {
        // The app-server could not be asked: account unknown.
      }
      const { usage } = account.current
      if (usage && info.account?.loggedIn) info.usage = usage
      return info
    },
    createDriver: (ctx) => new CodexDriver(ctx, { conn: server, account, effort: opts.effort }),
    async history(cwd: string): Promise<SessionHistoryEntry[]> {
      if (!findExe()) return []
      try {
        await server.ensureStarted()
        // The list is the logged-in user's own history: nothing to offer without a login.
        if (!(await account.read()).loggedIn) return []
        // `cwd` matches the exact folder only. A thread is listed once it had its first turn.
        const result = await server.request('thread/list', { cwd, limit: HISTORY_LIST_LIMIT }, 20_000)
        return threadHistory(result, { originator: CODEX_CLIENT_NAME, limit: HISTORY_SHOWN })
      } catch (err) {
        throw new Error(`Codex could not list the earlier conversations: ${message(err)}`)
      }
    },
    async login(): Promise<void> {
      if (!findExe()) throw new Error('Codex is not installed')
      try {
        await account.startLogin()
      } catch (err) {
        throw new Error(`Could not start the Codex login: ${message(err)}`)
      }
    },
    onChanged: (cb) => void account.onChanged(cb),
    // `thread/resume` of a thread whose rollout file is gone: "no rollout found for thread id …".
    conversationGone: ({ error }) => !!error && CODEX_NO_THREAD.test(error),
    async shutdown(): Promise<void> {
      await account.cancelLogin().catch(() => {})
      await server.stop()
    }
  }
}
