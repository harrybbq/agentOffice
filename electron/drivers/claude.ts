// Claude Code driver: hosts the official `claude` TUI in a pty and gets structured events through
// hooks injected with `--settings <temp file>` (the user's own settings files are never touched).
// Everything here follows docs/spikes-phase-a.md.
//
// No Electron imports: paths and services come in through ClaudeProviderOptions / DriverContext.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type {
  PermissionDecision,
  PermissionOutcome,
  ProviderInfo,
  SessionState
} from '../../shared/sessions'
import {
  AO_ENVELOPE_KEY,
  CLAUDE_HOOKS_ROUTE,
  ClaudeHookMapper,
  type HostedHookTarget
} from '../adapters/claude-code-hooks'
import type { RequestContext } from '../adapters/types'
import { DEFAULT_DENY_MESSAGE, describeToolInput } from '../permissions'
import { claudeBriefing, taggedOrder } from './claudeBriefing'
import type { SessionInbox } from '../sessionInbox'
import { SessionStateMachine, titleHint, type Scheduler } from './sessionState'
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type AgentDriver,
  type DriverContext,
  type IngestInfo,
  type PromptResult,
  type ProviderDefinition,
  type ValidatedStart
} from './types'

export const CLAUDE_LABEL = 'Claude Code'

/** Seconds. The user may take their time in the CEO office; Claude closes the hook when it's over. */
export const PERMISSION_HOOK_TIMEOUT_S = 3600
/** Seconds. Observation hooks must never stall Claude when the app is gone or slow. */
export const OBSERVE_HOOK_TIMEOUT_S = 5
export const SESSION_START_HOOK_TIMEOUT_S = 10
/** How long an order sent to an idle session may take to show up as a UserPromptSubmit. */
export const PROMPT_CONFIRM_MS = 6000
/** Bracketed paste collapses into a "[Pasted text]" attachment at 4+ lines or somewhere past 400 chars. */
export const PASTE_MAX_CHARS = 400

const HTTP_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd'
] as const
const TOOL_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---- pure helpers (tested) ------------------------------------------------------------------------

/**
 * The environment for a hosted agent: ours minus everything a parent Claude Code session exported
 * (the app may itself have been started from a Claude Code terminal).
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string' || /^(CLAUDE|AI_AGENT)/i.test(k)) continue
    env[k] = v
  }
  return env
}

/**
 * Tools a hosted session may not use: the ones that list and message other Claude Code sessions
 * on the machine. A hosted session must not discover or contact the user's own sessions. Orders
 * from the app still arrive: the inbox socket is inbound and needs neither tool.
 */
export const DENIED_TOOLS: readonly string[] = ['ListAgents', 'SendMessage']

export interface ClaudeSettings {
  permissions: { deny: string[] }
  /** No discovery of sessions on other machines either. */
  isolatePeerMachines: true
  hooks: Record<string, unknown[]>
}

/**
 * The settings passed with `--settings`. Hooks and deny rules from this file are ADDED to the
 * user's own. It holds the app's port and a script path, but no secret: the token is read from the
 * env var `AO_TOKEN`.
 */
export function buildClaudeSettings(opts: { hooksUrl: string; hookScript: string }): ClaudeSettings {
  const hooks: Record<string, unknown[]> = {}
  // SessionStart can't be an http hook, and only a command hook sees the inbox socket + token.
  hooks.SessionStart = [
    {
      hooks: [
        {
          type: 'command',
          command: `node "${opts.hookScript.replace(/\\/g, '/')}"`,
          timeout: SESSION_START_HOOK_TIMEOUT_S
        }
      ]
    }
  ]
  for (const event of HTTP_HOOK_EVENTS) {
    const hook = {
      type: 'http',
      url: opts.hooksUrl,
      timeout: event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_S : OBSERVE_HOOK_TIMEOUT_S,
      headers: { 'X-Agent-Office-Token': '$AO_TOKEN', 'X-Agent-Office-Session': '$AO_SESSION' },
      allowedEnvVars: ['AO_TOKEN', 'AO_SESSION']
    }
    hooks[event] = [TOOL_EVENTS.includes(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }]
  }
  // `crossSessionInbound` is left unset on purpose: "refuse" keeps the inbox socket bound but drops
  // every message, which would also drop the app's own orders.
  return { permissions: { deny: [...DENIED_TOOLS] }, isolatePeerMachines: true, hooks }
}

/** The command line. Only values the main process validated end up here. */
export function claudeArgs(start: ValidatedStart, settingsFile: string, briefingFile?: string): string[] {
  // Always pass the mode: without the flag a session ran in `auto` on this machine (spikes).
  const args = ['--settings', settingsFile, '--permission-mode', start.permissionMode]
  // Where the session runs (drivers/claudeBriefing.ts), added to Claude's own system prompt.
  if (briefingFile) args.push('--append-system-prompt-file', briefingFile)
  if (start.model) args.push('--model', start.model)
  if (start.resume) args.push('--resume', start.resume)
  return args
}

/** The answer to a held PermissionRequest hook. */
export function permissionDecisionBody(decision: PermissionDecision): unknown {
  const inner =
    decision.behavior === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: decision.message || DEFAULT_DENY_MESSAGE }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: inner } }
}

export interface PtyWrite {
  data: string
  /** Wait this long after writing. */
  delayMs: number
}

/** Text typed into a terminal must not carry escape sequences or other control characters. */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
}

/**
 * Fallback delivery of a prompt by typing it into the TUI (used when the session has no inbox
 * socket). Short single-line text goes in as one bracketed paste. Anything else is typed in
 * chunks, with Ctrl+J for line breaks, because a larger paste becomes a "[Pasted text]"
 * attachment that the model reads as a file rather than an instruction.
 * Returns null when the text can't be typed safely.
 */
export function ptyPromptWrites(text: string): PtyWrite[] | null {
  const clean = sanitizeForTerminal(text).trim()
  if (clean.length === 0) return null
  // At the start of the input box these switch the TUI to a command / shell / memory mode.
  if (/^[/!#]/.test(clean)) return null
  if (!clean.includes('\n') && clean.length < PASTE_MAX_CHARS) {
    return [
      { data: `\x1b[200~${clean}\x1b[201~`, delayMs: 150 },
      { data: '\r', delayMs: 0 }
    ]
  }
  const writes: PtyWrite[] = []
  const lines = clean.split('\n')
  lines.forEach((line, i) => {
    for (let at = 0; at < line.length; at += 64) writes.push({ data: line.slice(at, at + 64), delayMs: 15 })
    if (i < lines.length - 1) writes.push({ data: '\n', delayMs: 15 }) // Ctrl+J: newline without submitting
  })
  writes.push({ data: '', delayMs: 250 })
  writes.push({ data: '\r', delayMs: 0 })
  return writes
}

/** The model id in a hook payload (`model`: a string, or an object with an `id`), or null. */
export function reportedModel(v: unknown): string | null {
  const id = isRecord(v) ? v.id : v
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/.test(id) ? id : null
}

/** Is this a plausible inbox socket for this platform? (It comes from the agent's own hook.) */
export function isInboxSocketPath(v: unknown, platform: NodeJS.Platform = process.platform): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 400 || /[\u0000-\u001f]/.test(v)) return false
  return platform === 'win32' ? /^\\\\[.?]\\pipe\\[^\\/]/.test(v) : v.startsWith('/')
}

/**
 * Where `claude` is. On Windows the npm shim (`claude.cmd`) only adds a cmd.exe layer, so the real
 * `claude.exe` is spawned directly, as the spikes did.
 */
export function findClaudeExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d.length > 0 && isAbsolute(d))
  const candidates: string[] = []
  if (platform === 'win32') {
    const npmExe = (dir: string) => join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (env.APPDATA) candidates.push(npmExe(join(env.APPDATA, 'npm')))
    for (const dir of dirs) {
      candidates.push(join(dir, 'claude.exe'))
      if (existsSync(join(dir, 'claude.cmd'))) candidates.push(npmExe(dir))
    }
    candidates.push(join(homedir(), '.local', 'bin', 'claude.exe'))
  } else {
    for (const dir of dirs) candidates.push(join(dir, 'claude'))
    candidates.push(join(homedir(), '.local', 'bin', 'claude'), join(homedir(), '.claude', 'local', 'claude'))
  }
  return candidates.find((c) => existsSync(c)) ?? null
}

/** Removes temp settings and briefing files a crashed run left behind. Only call when no session is running. */
export function sweepSessionFiles(sessionsDir: string): void {
  let names: string[] = []
  try {
    names = readdirSync(sessionsDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.settings.json') && !name.endsWith('.briefing.md')) continue
    try {
      rmSync(join(sessionsDir, name), { force: true })
    } catch {
      // not ours to worry about
    }
  }
}

function claudeVersion(exe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, ['--version'], { env: scrubbedEnv(process.env), timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout).trim().split(/\s+/)[0] ?? '')
    })
  })
}

// ---- driver ---------------------------------------------------------------------------------------

export interface ClaudeProviderOptions {
  /** `<userData>/sessions`: the temp settings files live here. */
  sessionsDir: string
  /** Absolute path of hook/claude-session-start.cjs. */
  hookScript: string
  ingest: IngestInfo
  /** Inbox sockets + tokens, memory only. */
  inbox: SessionInbox
  /** Overrides for tests. */
  findExecutable?: () => string | null
  schedule?: Scheduler
}

export class ClaudeDriver implements AgentDriver, HostedHookTarget {
  readonly provider = 'claude-code' as const
  readonly surface = 'terminal' as const
  private readonly id: string
  private readonly mapper: ClaudeHookMapper
  private machine: SessionStateMachine | null = null
  /** Temp files of this session: its settings and its briefing. */
  private tempFiles: string[] = []
  private providerSession: string | undefined
  private model: string | undefined
  private exited = false
  private exitWaiters: Array<() => void> = []
  /** Resolved by the next real UserPromptSubmit. */
  private promptWaiters: Array<(seen: boolean) => void> = []

  constructor(
    private readonly ctx: DriverContext,
    private readonly opts: ClaudeProviderOptions
  ) {
    this.id = ctx.sessionId
    this.mapper = new ClaudeHookMapper({ rootId: this.id, displayName: ctx.start.title, holdWaiting: true, endsWithProcess: true })
  }

  get state(): SessionState {
    if (this.exited) return 'exited'
    return this.machine?.state ?? 'starting'
  }

  get providerSessionId(): string | undefined {
    return this.providerSession
  }

  get canReceiveOrders(): boolean {
    const s = this.state
    if (s === 'idle') return true // inbox socket, or typed into the TUI
    return (s === 'busy' || s === 'waiting-permission') && this.opts.inbox.has(this.id)
  }

  async start(): Promise<void> {
    const exe = (this.opts.findExecutable ?? findClaudeExecutable)()
    if (!exe) throw new Error('Claude Code is not installed (no `claude` executable found)')
    const base = this.opts.ingest.baseUrl()
    if (!base) throw new Error('the ingest server is not running, so the session could not report back')
    const hooksUrl = `${base}${CLAUDE_HOOKS_ROUTE}`

    mkdirSync(this.opts.sessionsDir, { recursive: true, mode: 0o700 })
    const settingsFile = join(this.opts.sessionsDir, `${this.id}.settings.json`)
    // mode is honoured on POSIX; on Windows the file sits in the per-user profile.
    writeFileSync(settingsFile, JSON.stringify(buildClaudeSettings({ hooksUrl, hookScript: this.opts.hookScript }), null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    // What the session is told about Agent Office. No secret in it either.
    const briefingFile = join(this.opts.sessionsDir, `${this.id}.briefing.md`)
    writeFileSync(briefingFile, claudeBriefing({ title: this.ctx.start.title }), { encoding: 'utf8', mode: 0o600 })
    this.tempFiles = [settingsFile, briefingFile]

    const env = scrubbedEnv(process.env)
    // A token of this session only: it reaches the hooks route and nothing else (ingest/auth.ts).
    env.AO_TOKEN = this.opts.ingest.tokens.issue(this.id)
    env.AO_URL = hooksUrl
    env.AO_SESSION = this.id

    const machine = new SessionStateMachine((state) => this.ctx.events.onState(state), this.opts.schedule)
    this.machine = machine
    try {
      await this.ctx.pty.spawn(
        this.id,
        { file: exe, args: claudeArgs(this.ctx.start, settingsFile, briefingFile), cwd: this.ctx.start.cwd, env, cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        { onExit: (code) => this.onExit(code), onTitle: (title) => this.machine?.title(titleHint(title)) }
      )
    } catch (err) {
      machine.dispose()
      this.machine = null
      this.cleanup()
      throw err
    }
    if (this.exited) return
    for (const e of this.mapper.spawn(Date.now(), 'starting')) this.ctx.sink.emit(e)
  }

  // -- hooks (reached only with this session's own token) --

  handleHook(body: Record<string, unknown>, req: RequestContext): unknown | Promise<unknown> {
    if (this.exited || !this.machine) return {}
    const machine = this.machine
    // The inbox endpoint is a secret: take it out before anything else sees the payload.
    const envelope = body[AO_ENVELOPE_KEY]
    delete body[AO_ENVELOPE_KEY]
    if (isRecord(envelope) && isInboxSocketPath(envelope.socket) && typeof envelope.token === 'string') {
      if (envelope.token.length > 0 && envelope.token.length <= 512) {
        this.opts.inbox.register(this.id, { socketPath: envelope.socket, token: envelope.token })
        this.ctx.events.onChanged()
      }
    }
    if (typeof body.session_id === 'string' && body.session_id.length > 0 && body.session_id !== this.providerSession) {
      this.providerSession = body.session_id.slice(0, 200)
      this.ctx.events.onProviderSession(this.providerSession)
    }

    // SessionStart names the model; a later hook may name another one after `/model`.
    const model = reportedModel(body.model)
    if (model && model !== this.model) {
      this.model = model
      this.ctx.events.onModel(model)
    }

    const mapped = this.mapper.handle(body)
    for (const e of mapped.events) this.ctx.sink.emit(e)
    const mainThread = mapped.agentId === this.id

    switch (mapped.kind) {
      case 'session-start':
        machine.ready()
        break
      case 'prompt':
        machine.activity()
        for (const w of this.promptWaiters.splice(0)) w(true)
        break
      case 'synthetic-prompt':
        machine.activity()
        break
      case 'pre-tool':
      case 'post-tool':
        // A background subagent's tools don't make the session's own turn busy.
        if (mainThread) machine.activity()
        break
      case 'permission':
        return this.holdPermission(body, mapped.agentId, mapped.displayName, req)
      case 'stop':
        // Leftover cards of the main thread; a background subagent may still be waiting.
        this.ctx.permissions.clearSession(this.id, this.id)
        machine.turnEnded()
        break
      default:
        break
    }
    return {}
  }

  /** Keeps the PermissionRequest hook open until the CEO office decides or Claude hangs up. */
  private holdPermission(body: Record<string, unknown>, agentId: string, displayName: string, req: RequestContext): Promise<unknown> {
    const toolName = typeof body.tool_name === 'string' ? body.tool_name : 'tool'
    // The `waiting` world event was emitted by the mapper already.
    return new Promise<unknown>((resolve) => {
      const id = this.ctx.permissions.add(
        {
          sessionId: this.id,
          agentId,
          displayName,
          provider: 'claude-code',
          toolName,
          summary: summarise(toolName, body.tool_input),
          detail: describeToolInput(body.tool_input)
        },
        {
          signal: req.signal,
          onResolved: (outcome, decision) => {
            for (const e of this.mapper.resume(agentId)) this.ctx.sink.emit(e)
            this.machine?.permissions(this.ctx.permissions.count(this.id))
            // `{}` = no decision: Claude's own dialog (already on screen) stays in charge.
            resolve(decision && outcome !== 'resolved-elsewhere' ? permissionDecisionBody(decision) : {})
          }
        }
      )
      if (id) this.machine?.permissions(this.ctx.permissions.count(this.id))
    })
  }

  // -- control --

  answerPermission(requestId: string, decision: PermissionDecision): PermissionOutcome {
    return this.ctx.permissions.decide(requestId, decision)
  }

  setTitle(title: string): void {
    if (this.exited) return
    for (const e of this.mapper.rename(title)) this.ctx.sink.emit(e)
  }

  interrupt(): void {
    if (!this.exited) this.ctx.pty.write(this.id, '\x1b')
  }

  async sendPrompt(text: string): Promise<PromptResult> {
    const state = this.state
    if (state === 'exited') return { ok: false, reason: 'the session has ended' }
    if (state === 'starting' || state === 'needs-attention') {
      return { ok: false, reason: 'the session is not ready yet (check its terminal)' }
    }
    const wasIdle = state === 'idle'
    // The inbox socket never answers, so an idle session confirms through its UserPromptSubmit hook.
    const confirmation = wasIdle ? this.nextPrompt(PROMPT_CONFIRM_MS) : null

    if (this.opts.inbox.has(this.id)) {
      // Tagged, so the session can tell it from any other cross-session message (see the briefing).
      const r = await this.opts.inbox.deliver(this.id, taggedOrder(text))
      if (!r.ok) return r
      // Mid-turn the message is queued and absorbed between tool calls; that can't be observed.
      if (!confirmation) return { ok: true, queued: true }
    } else {
      // No inbox socket (the SessionStart hook didn't report one): type it. Never into a busy
      // session or a permission dialog, where keystrokes would mean something else.
      if (!wasIdle) return { ok: false, reason: 'the session is busy and has no inbox socket; try again when it is idle' }
      const writes = ptyPromptWrites(text)
      if (!writes) return { ok: false, reason: 'this order cannot be typed into the terminal (it starts with / ! or #)' }
      for (const w of writes) {
        if (this.exited) return { ok: false, reason: 'the session has ended' }
        if (w.data) this.ctx.pty.write(this.id, w.data)
        if (w.delayMs > 0) await sleep(w.delayMs)
      }
    }
    const seen = await confirmation
    return seen ? { ok: true, queued: false } : { ok: false, reason: 'sent, but the session did not confirm it in time' }
  }

  async stop(): Promise<void> {
    if (this.exited) return
    const gone = (ms: number) => Promise.race([new Promise<void>((r) => this.exitWaiters.push(r)), sleep(ms)])
    if (this.state === 'idle') {
      // Polite exit, so SessionEnd hooks run. Ctrl+C first clears anything left in the input box.
      this.ctx.pty.write(this.id, '\x03')
      await sleep(200)
      if (!this.exited) this.ctx.pty.write(this.id, '/exit')
      await sleep(400)
      if (!this.exited) this.ctx.pty.write(this.id, '\r')
      await gone(4000)
    }
    if (this.exited) return
    this.ctx.pty.kill(this.id)
    await gone(5000)
  }

  // -- internals --

  private nextPrompt(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (seen: boolean) => {
        clearTimeout(timer)
        const i = this.promptWaiters.indexOf(done)
        if (i >= 0) this.promptWaiters.splice(i, 1)
        resolve(seen)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      this.promptWaiters.push(done)
    })
  }

  private onExit(exitCode: number | null): void {
    if (this.exited) return
    this.exited = true
    this.machine?.exited()
    for (const e of this.mapper.end()) this.ctx.sink.emit(e)
    this.cleanup()
    for (const w of this.promptWaiters.splice(0)) w(false)
    for (const w of this.exitWaiters.splice(0)) w()
    this.ctx.events.onExit(exitCode)
  }

  /** Token, inbox endpoint, pending cards and the temp files all die with the session. */
  private cleanup(): void {
    this.opts.ingest.tokens.revoke(this.id)
    this.opts.inbox.unregister(this.id)
    this.ctx.permissions.clearSession(this.id)
    for (const file of this.tempFiles.splice(0)) {
      try {
        rmSync(file, { force: true })
      } catch {
        // swept on the next start
      }
    }
  }
}

function summarise(toolName: string, toolInput: unknown): string {
  let what = ''
  if (isRecord(toolInput)) {
    for (const key of ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path', 'description']) {
      const v = toolInput[key]
      if (typeof v === 'string' && v.length > 0) {
        what = v
        break
      }
    }
  }
  return what ? `${toolName}: ${what}` : toolName
}

// ---- provider table row -----------------------------------------------------------------------------

const PROBE_TTL_MS = 30_000

export function claudeProvider(opts: ClaudeProviderOptions): ProviderDefinition {
  let cached: { at: number; info: ProviderInfo } | null = null
  return {
    id: 'claude-code',
    label: CLAUDE_LABEL,
    async probe(): Promise<ProviderInfo> {
      if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.info
      const base = { id: 'claude-code' as const, label: CLAUDE_LABEL }
      const exe = (opts.findExecutable ?? findClaudeExecutable)()
      let info: ProviderInfo
      if (!exe) info = { ...base, available: false, reason: 'not installed' }
      else {
        try {
          info = { ...base, available: true, version: await claudeVersion(exe) }
        } catch {
          info = { ...base, available: false, reason: '`claude --version` failed' }
        }
      }
      cached = { at: Date.now(), info }
      return info
    },
    createDriver: (ctx) => new ClaudeDriver(ctx, opts)
  }
}
