// Antigravity driver: one hosted session = one long-lived `agy --input-format stream-json
// --output-format stream-json` process (Google's Antigravity CLI). There is no TUI: the session's
// surface is the chat view, fed by the ChatItem list this driver keeps (agyStream.ts).
// Everything here follows docs/spikes-phase-c.md.
//
// THE APP IS AGY'S PERMISSION SYSTEM. In headless mode agy cannot ask, and a hook's `allow` does
// not lift its own soft-deny, so a hosted session runs with `--dangerously-skip-permissions` and
// the app's PreToolUse hook is the only gate (it fails closed: deny, a crashed hook and an answer
// without a decision all block the tool). Four things keep that honest:
//   1. the process is never spawned with the flag unless agy itself, asked without quota
//      (`-p /hooks`), lists the app's PreToolUse hook for this session's folder; again before
//      every respawn;
//   2. the hook script (hook/agy-hook.cjs) answers deny whenever the app cannot be asked;
//   3. the hook files live in the app's own data folder, the policy (agyPolicy.ts) denies every
//      tool call that touches that folder, and their hash is checked before every turn and every
//      tool call: a change stops the session;
//   4. the hook's token only reaches the one ingest route that asks questions (ingest/auth.ts); it
//      is handed over in the process environment, never written to a file and never logged.
//
// State:  starting ──probe + init──▶ idle ──prompt──▶ busy ──result──▶ idle
//         busy ◀──▶ waiting-permission (while a PreToolUse answer is held for the CEO inbox)
//         busy ──interrupt: kill the tree──▶ starting ──probe + `--conversation`──▶ idle
//         process exit ──▶ exited
//
// No Electron imports: paths and services come in through AgyProviderOptions / DriverContext.
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ChatEvent, ChatItem } from '../../shared/chat'
import type { AgentEvent } from '../../shared/events'
import { permissionAction } from '../../shared/permissionText'
import type { PermissionDecision, PermissionOutcome, ProviderInfo, SessionState } from '../../shared/sessions'
import { ClaudeHookMapper } from '../adapters/claude-code-hooks'
import type { RequestContext } from '../adapters/types'
import { BOARD_SERVER_AGY } from '../boardMcp'
import { AGY_HOOK_ROUTE, type SessionTokens } from '../ingest/auth'
import { DEFAULT_DENY_MESSAGE } from '../permissions'
import type { AgyHookEvent, AgyHookTarget } from './agyHookBridge'
import { AGY_WRITE_TOOLS, agyPolicy, PROTECTED_DENY_REASON } from './agyPolicy'
import { AGY_PROVIDER, AgyChat, agyWorldActivity, parseAgyLine, type AgyEvent, type AgyFileContext } from './agyStream'
import { officeBriefing } from './briefing'
import type { AgentDriver, DriverContext, PromptOrigin, PromptResult, ProviderDefinition } from './types'

export const AGY_LABEL = 'Antigravity'
/** The cheapest model of the free plan (docs/spikes-phase-c.md): the default unless the user picks one. */
export const AGY_DEFAULT_MODEL = 'gemini-3.8-flash-low'
/** The app cannot drive agy's login: this is what the user is told to do. */
export const AGY_LOGIN_INSTRUCTION = 'Open a terminal, run `agy`, choose the personal Google sign-in (not the Google Cloud project option), then come back'
export const AGY_NOT_LOGGED_IN = `Antigravity is not signed in. ${AGY_LOGIN_INSTRUCTION}.`
export const AGY_CONVERSATION_GONE = 'Antigravity no longer has that conversation'
export const AGY_HOOKS_NOT_LOADED =
  "Antigravity did not load Agent Office's approval hook for this session, so it was not started: it would have run commands and changed files without asking."
export const AGY_TAMPERED =
  'The files that connect this session to Agent Office were changed while it was running. The session was stopped, because its approvals could no longer be trusted.'
export const AGY_NO_SERVER = "Agent Office's local server is not running, so Antigravity could not ask for approvals. The session was not started."
export const AGY_QUEUED_NOTE = 'Sent while a turn was running: it is queued and runs as the next turn.'
export const AGY_STEERED_NOTE = 'Sent while a turn was running: it was handed to the agent inside that turn.'

/** Seconds. The user may take their time in the CEO inbox. */
export const AGY_GATE_TIMEOUT_S = 3600
/** Seconds. The briefing and the digest are built from memory. */
export const AGY_OBSERVE_TIMEOUT_S = 10
export const AGY_HOOK_FILE = 'agy-hook.cjs'
export const AGY_BOARD_FILE = 'agy-board-mcp.cjs'
/** The name of the app's hook group in hooks.json (agy reports it in `/hooks`). */
export const AGY_HOOK_NAME = 'agent-office'

const INIT_TIMEOUT_MS = 45_000
const PROBE_TIMEOUT_MS = 30_000
const LOGIN_TTL_MS = 60_000
const USAGE_MIN_INTERVAL_MS = 60_000
/** How long the provider list waits for the login probe before answering without it. */
const PROBE_ACCOUNT_WAIT_MS = 5000
/** How long a PreToolUse question may arrive before the stream showed its tool step. */
const STEP_WAIT_MS = 2500
const STOP_GRACE_MS = 1500
/** A file larger than this is not read for its diff. */
const DIFF_READ_MAX_BYTES = 512 * 1024
const MAX_STDERR_NOTICES_PER_TURN = 5
const MAX_INJECTED_PROMPTS = 3
const WEEK_MINUTES = 7 * 24 * 60

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---- the CLI ----------------------------------------------------------------------------------------

/** Where `agy` is: AGY_PATH, the Windows installer's folder, ~/.local/bin, then PATH. */
export function findAgyExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const name = platform === 'win32' ? 'agy.exe' : 'agy'
  const candidates: string[] = []
  if (env.AGY_PATH) candidates.push(env.AGY_PATH)
  if (platform === 'win32' && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'agy', 'bin', name))
  candidates.push(join(homedir(), '.local', 'bin', name))
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) if (dir && isAbsolute(dir)) candidates.push(join(dir, name))
  return candidates.find((c) => existsSync(c)) ?? null
}

/**
 * The environment of a hosted agy: ours minus what a parent agent session exported and minus
 * everything that would change how agy signs in or where it connects. The background self-updater
 * is switched off. Whatever is left is inherited by the hook script and by the agent's commands.
 */
export function agyEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue
    if (/^(CLAUDE|AI_AGENT|CODEX_|ANTIGRAVITY_|AGY_|GEMINI_|GOOGLE_GEMINI_|AO_)/i.test(k)) continue
    env[k] = v
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
  return { ...env, ...extra }
}

export interface AgySpawnSpec {
  file: string
  args: string[]
}

export interface AgyCliOptions {
  findExecutable?: () => string | null
  /** Tests and development: what to run in place of `agy <args>` (e.g. `node fake-agy.cjs <args>`). */
  resolveSpawn?: (exe: string, args: string[]) => AgySpawnSpec
  /** The base environment. Default: the app's own. */
  env?: NodeJS.ProcessEnv
}

export interface AgyRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => {})
    else process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * Runs `agy`: always with an argument array and without a shell (a slash command that passes
 * through a POSIX shell on Windows is rewritten into a path and becomes a real, paid model turn).
 */
export class AgyCli {
  private readonly live = new Set<ChildProcessWithoutNullStreams>()

  constructor(private readonly opts: AgyCliOptions = {}) {}

  exe(): string | null {
    return (this.opts.findExecutable ?? (() => findAgyExecutable(this.opts.env ?? process.env)))()
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return agyEnv(this.opts.env ?? process.env, extra)
  }

  private spec(args: string[]): AgySpawnSpec {
    const exe = this.exe()
    if (!exe) throw new Error('Antigravity (agy) is not installed')
    return this.opts.resolveSpawn ? this.opts.resolveSpawn(exe, args) : { file: exe, args }
  }

  /** The long-lived process of a session. */
  spawn(args: string[], opts: { cwd: string; env: Record<string, string> }): ChildProcessWithoutNullStreams {
    const spec = this.spec(args)
    const child = spawn(spec.file, spec.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    this.live.add(child)
    child.once('close', () => this.live.delete(child))
    child.once('error', () => this.live.delete(child))
    return child
  }

  /** Runs agy once and collects its output (stdin closed at once). Never rejects. */
  run(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<AgyRunResult> {
    return new Promise((done) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawn(args, { cwd: opts.cwd ?? tmpdir(), env: this.env() })
      } catch (err) {
        return done({ code: null, stdout: '', stderr: message(err), timedOut: false })
      }
      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout.length < 4_000_000 ? (stdout += d) : undefined))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr.length < 200_000 ? (stderr += d) : undefined))
      child.stdin.on('error', () => {})
      child.stdin.end()
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, opts.timeoutMs ?? PROBE_TIMEOUT_MS)
      child.once('error', (err) => {
        clearTimeout(timer)
        done({ code: null, stdout, stderr: stderr + message(err), timedOut })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        done({ code, stdout, stderr, timedOut })
      })
    })
  }

  /** The app is going away without a clean quit: no agy (and nothing it runs) may stay behind. */
  killSync(): void {
    for (const child of this.live) {
      if (child.pid === undefined || child.exitCode !== null) continue
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
        else child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    this.live.clear()
  }
}

// ---- account: login probe, models, usage ------------------------------------------------------------

/** `agy models` prints one `slug<TAB>label` line per model. */
export function parseAgyModels(stdout: string): Array<{ id: string; label: string }> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(cols[0].trim()))
    .map((cols) => ({ id: cols[0].trim(), label: cols[1].trim() }))
}

/** The model a session gets when the user chose none: the cheapest one listed. */
export function cheapestAgyModel(models: ReadonlyArray<{ id: string }>): string | undefined {
  const ids = models.map((m) => m.id)
  if (ids.length === 0 || ids.includes(AGY_DEFAULT_MODEL)) return AGY_DEFAULT_MODEL
  return ids.find((id) => /flash.*-low$/.test(id)) ?? ids.find((id) => /-low$/.test(id)) ?? ids[0]
}

/**
 * `agy -p /usage --output-format json` -> the weekly window of the Gemini models (the group a
 * hosted session's default model belongs to). Null when the answer has no such bucket.
 */
export function parseAgyUsage(stdout: string): NonNullable<ProviderInfo['usage']> | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const data = isRecord(raw) && isRecord(raw.command) && isRecord(raw.command.data) ? raw.command.data : null
  const groups = data && Array.isArray(data.groups) ? data.groups.filter(isRecord) : []
  const group = groups.find((g) => /gemini/i.test(str(g.name, 100))) ?? groups[0]
  const buckets = group && Array.isArray(group.buckets) ? group.buckets.filter(isRecord) : []
  const bucket = buckets.find((b) => b.window === 'weekly') ?? buckets[0]
  const remaining = bucket ? bucket.remaining_fraction : undefined
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null
  const usage: NonNullable<ProviderInfo['usage']> = { usedPercent: Math.round(Math.min(1, Math.max(0, 1 - remaining)) * 1000) / 10 }
  const resets = Date.parse(str(bucket?.reset_time, 60))
  if (Number.isFinite(resets)) usage.resetsAt = resets
  if (bucket?.window === 'weekly') usage.windowMinutes = WEEK_MINUTES
  return usage
}

export interface AgyAccountState {
  loggedIn: boolean
  models: Array<{ id: string; label: string }>
}

/** Whether agy is signed in (`agy models`: no quota), which models it offers, and the weekly usage. */
export class AgyAccount {
  private state: AgyAccountState | null = null
  private readAt = 0
  private reading: Promise<AgyAccountState> | null = null
  private usageValue: ProviderInfo['usage']
  private usageAt = 0
  private usageReading: Promise<void> | null = null
  private listeners = new Set<() => void>()

  constructor(
    private readonly cli: AgyCli,
    private readonly now: () => number = Date.now
  ) {}

  get current(): AgyAccountState | null {
    return this.state
  }

  get usage(): ProviderInfo['usage'] {
    return this.state?.loggedIn ? this.usageValue : undefined
  }

  onChanged(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  /** The login state, probed again if what we know is older than `maxAgeMs`. */
  read(maxAgeMs = LOGIN_TTL_MS): Promise<AgyAccountState> {
    if (this.state && this.now() - this.readAt < maxAgeMs) return Promise.resolve(this.state)
    if (!this.reading) {
      this.reading = this.probe().finally(() => {
        this.reading = null
      })
    }
    return this.reading
  }

  private async probe(): Promise<AgyAccountState> {
    const before = JSON.stringify(this.state)
    const r = await this.cli.run(['models'])
    // Exit 0 with a model list = signed in. Anything else (exit 1 "Please sign in…") = not.
    const models = r.code === 0 ? parseAgyModels(r.stdout) : []
    this.state = { loggedIn: r.code === 0 && models.length > 0, models }
    this.readAt = this.now()
    if (JSON.stringify(this.state) !== before) this.changed()
    if (this.state.loggedIn && this.usageAt === 0) void this.refreshUsage()
    return this.state
  }

  /** Something failed that a lost login would explain: what we know is no longer trusted. */
  invalidate(): void {
    this.readAt = 0
  }

  /** Reads the usage (no quota), at most once a minute unless forced. */
  refreshUsage(force = false): Promise<void> {
    if (this.usageReading) return this.usageReading
    if (!force && this.usageAt > 0 && this.now() - this.usageAt < USAGE_MIN_INTERVAL_MS) return Promise.resolve()
    this.usageAt = this.now()
    this.usageReading = (async () => {
      const r = await this.cli.run(['-p', '/usage', '--output-format', 'json'])
      const usage = r.code === 0 ? parseAgyUsage(r.stdout) : null
      if (!usage || JSON.stringify(usage) === JSON.stringify(this.usageValue)) return
      this.usageValue = usage
      this.changed()
    })().finally(() => {
      this.usageReading = null
    })
    return this.usageReading
  }

  private changed(): void {
    for (const cb of [...this.listeners]) cb()
  }
}

// ---- the session folder -----------------------------------------------------------------------------

export const agyHookCommand = (event: AgyHookEvent): string => `node ${AGY_HOOK_FILE} ${event}`

/**
 * hooks.json of a session. The command names the script relative to hooks.json (agy runs hooks
 * with that folder as the working directory) and contains no double quote: on Windows agy passes
 * the command to `cmd /c` with inner quotes escaped, and a quoted path arrives broken.
 */
export function agyHooksConfig(): Record<string, unknown> {
  return {
    [AGY_HOOK_NAME]: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: agyHookCommand('PreToolUse'), timeout: AGY_GATE_TIMEOUT_S }] }],
      PreInvocation: [{ type: 'command', command: agyHookCommand('PreInvocation'), timeout: AGY_OBSERVE_TIMEOUT_S }]
    }
  }
}

export interface AgySessionFolder {
  /** The folder handed to agy with `--add-dir`. */
  dir: string
  hooksFile: string
  /** The files that decide how the session is gated (relative to `dir`), and their hash when written. */
  files: string[]
  hash: string
}

/** SHA-256 over the gate files of a session folder. A missing file changes it. */
export function hashAgySessionFiles(dir: string, files: readonly string[]): string {
  const h = createHash('sha256')
  for (const name of files) {
    h.update(`\0${name}\0`)
    try {
      h.update(readFileSync(join(dir, name)))
    } catch {
      h.update('\0missing\0')
    }
  }
  return h.digest('hex')
}

/**
 * Writes a session's folder: `.agents/hooks.json`, a copy of the hook script next to it and, with
 * the office board, `.agents/mcp_config.json` plus the board bridge. No secret is written: the
 * tokens are in the agy process's environment.
 */
export function buildAgySessionFolder(opts: { dir: string; hookScript: string; boardScript?: string | null }): AgySessionFolder {
  const agents = join(opts.dir, '.agents')
  mkdirSync(agents, { recursive: true })
  const files = [join('.agents', 'hooks.json'), join('.agents', AGY_HOOK_FILE)]
  writeFileSync(join(agents, AGY_HOOK_FILE), readFileSync(opts.hookScript))
  writeFileSync(join(agents, 'hooks.json'), JSON.stringify(agyHooksConfig(), null, 2))
  const mcpFile = join(agents, 'mcp_config.json')
  if (opts.boardScript) {
    const bridge = join(agents, AGY_BOARD_FILE)
    writeFileSync(bridge, readFileSync(opts.boardScript))
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { [BOARD_SERVER_AGY]: { command: 'node', args: [bridge] } } }, null, 2))
    files.push(join('.agents', 'mcp_config.json'), join('.agents', AGY_BOARD_FILE))
  } else {
    rmSync(mcpFile, { force: true })
    rmSync(join(agents, AGY_BOARD_FILE), { force: true })
  }
  return { dir: opts.dir, hooksFile: join(agents, 'hooks.json'), files, hash: hashAgySessionFiles(opts.dir, files) }
}

/** Leftover session folders of a crash. The single-instance lock means nobody uses them. */
export function sweepAgySessions(sessionsDir: string): void {
  let names: string[] = []
  try {
    names = readdirSync(sessionsDir)
  } catch {
    return
  }
  for (const name of names) {
    try {
      rmSync(join(sessionsDir, name), { recursive: true, force: true })
    } catch {
      // in use by something else: not ours to worry about
    }
  }
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const n = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? n.toLowerCase() : n
  }
  return norm(a) === norm(b)
}

/**
 * Does agy's own answer to `/hooks` list the app's PreToolUse hook, enabled, for every tool, loaded
 * from THIS session's hooks.json, with exactly the app's command?
 */
export function agyGateLoaded(answer: unknown, hooksFile: string): boolean {
  const data = isRecord(answer) && isRecord(answer.command) && isRecord(answer.command.data) ? answer.command.data : null
  const hooks = data && Array.isArray(data.hooks) ? data.hooks.filter(isRecord) : []
  return hooks.some((h) => {
    if (h.enabled !== true || h.name !== AGY_HOOK_NAME || typeof h.source !== 'string' || !samePath(h.source, hooksFile)) return false
    const actions = Array.isArray(h.actions) ? h.actions.filter(isRecord) : []
    return actions.some(
      (a) => a.event === 'PreToolUse' && a.type === 'command' && a.command === agyHookCommand('PreToolUse') && (a.matcher === '*' || a.matcher === '' || a.matcher === undefined)
    )
  })
}

/**
 * Asks agy (print mode, no quota, no conversation) which hooks it would load for a session in
 * `cwd` with this session folder. Null = the gate is loaded; otherwise why it can't be relied on.
 */
export async function probeAgyGate(cli: AgyCli, cwd: string, folder: AgySessionFolder): Promise<string | null> {
  const r = await cli.run(['-p', '/hooks', '--output-format', 'json', '--add-dir', folder.dir], { cwd, timeoutMs: PROBE_TIMEOUT_MS })
  if (r.timedOut) return 'agy did not answer the hooks check in time'
  if (r.code !== 0) return `agy could not list its hooks (exit code ${r.code ?? 'none'})`
  let answer: unknown
  try {
    answer = JSON.parse(r.stdout)
  } catch {
    return 'agy answered the hooks check with something unreadable'
  }
  return agyGateLoaded(answer, folder.hooksFile) ? null : "the app's PreToolUse hook is not in agy's list of hooks"
}

/** A path with its links resolved as far as it exists (a junction inside the project may point anywhere). */
export function realPathOf(path: string): string {
  let cur = path
  const rest: string[] = []
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync.native(cur)
      return rest.length > 0 ? join(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return path
      rest.push(basename(cur))
      cur = parent
    }
  }
  return path
}

// ---- driver -----------------------------------------------------------------------------------------

export interface AgyDriverDeps {
  cli: AgyCli
  account: AgyAccount
  /** `<userData>/agy-sessions`. */
  sessionsDir: string
  /** Folders of the app no session may touch (its userData). The session's own folder is added. */
  protectedPaths: readonly string[]
  /** hook/agy-hook.cjs and hook/agy-board-mcp.cjs as shipped with the app. */
  hookScript: string
  boardScript?: string
  ingest: { baseUrl(): string | null; tokens: SessionTokens }
  /**
   * A prompt sent while a turn runs: `queue` holds it and runs it as the next turn; `inject` hands
   * it to the agent inside the running turn (the next `PreInvocation` hook answers with it as a
   * `userMessage`), and falls back to the queue when the turn makes no further model call.
   */
  steer?: 'queue' | 'inject'
  /** The gate check before a spawn. Default: ask the real CLI (probeAgyGate). */
  probeGate?: (cwd: string, folder: AgySessionFolder) => Promise<string | null>
  /** Tests: how long the hook script waits for the app (AO_AGY_TIMEOUT_MS). */
  hookTimeoutMs?: number
  initTimeoutMs?: number
  now?: () => number
}

interface StepRecord {
  name: string
  params: Record<string, unknown>
  /** A PreToolUse question for this step was taken: a second one is refused. */
  asked: boolean
}

interface QueuedPrompt {
  text: string
  origin: PromptOrigin
  itemId: string
  noticeId: string
}

interface LiveProcess {
  child: ChildProcessWithoutNullStreams
  /** Resolves with the exit code once the process is gone. */
  closed: Promise<number | null>
}

export class AgyDriver implements AgentDriver, AgyHookTarget {
  readonly provider = 'antigravity' as const
  readonly surface = 'chat' as const
  private readonly id: string
  private readonly chat: AgyChat
  private readonly world: ClaudeHookMapper
  private readonly now: () => number
  private readonly dir: string
  private title: string
  private model: string | undefined
  private folder: AgySessionFolder | null = null
  private proc: LiveProcess | null = null
  private conversationId: string | undefined
  private ready = false
  private exited = false
  private stopping = false
  private interrupting = false
  private lastState: SessionState = 'starting'
  private turn: { id: string; digestDone: boolean; stderrNotices: number } | null = null
  private turnSeq = 0
  private queue: QueuedPrompt[] = []
  private steps = new Map<number, StepRecord>()
  /** The process was told where it runs (the briefing is not kept across a respawn). */
  private briefed = false
  /** Things the model is told at its next call (a conflict note). */
  private notes: string[] = []
  private boardTools = false
  private stderrTail: string[] = []
  /** Why the session ended, when the app knows (shown on its row). */
  endNotice: string | undefined

  constructor(
    private readonly ctx: DriverContext,
    private readonly deps: AgyDriverDeps
  ) {
    this.id = ctx.sessionId
    this.title = ctx.start.title
    this.now = deps.now ?? Date.now
    this.dir = join(deps.sessionsDir, this.id)
    this.chat = new AgyChat(this.id)
    this.world = new ClaudeHookMapper({ rootId: this.id, displayName: ctx.start.title, provider: AGY_PROVIDER, holdWaiting: true, endsWithProcess: true })
  }

  get state(): SessionState {
    if (this.exited) return 'exited'
    if (!this.ready) return 'starting'
    if (this.ctx.permissions.count(this.id) > 0) return 'waiting-permission'
    return this.turn ? 'busy' : 'idle'
  }

  get providerSessionId(): string | undefined {
    return this.conversationId
  }

  get canReceiveOrders(): boolean {
    // idle: a new turn. busy / waiting-permission: queued (or handed into the running turn).
    const s = this.state
    return s === 'idle' || s === 'busy' || s === 'waiting-permission'
  }

  chatItems(): ChatItem[] {
    return this.chat.list()
  }

  // -- start --

  async start(): Promise<void> {
    const start = this.ctx.start
    if (!this.deps.cli.exe()) throw new Error('Antigravity (agy) is not installed')
    // A logged-out agy would only fail once it is spawned: refuse now, with the instruction.
    const account = await this.deps.account.read()
    if (!account.loggedIn) throw new Error(AGY_NOT_LOGGED_IN)
    this.model = start.model ?? cheapestAgyModel(account.models)
    try {
      await this.launch(start.resume, true)
    } catch (err) {
      this.cleanup()
      throw err
    }
    this.emitWorld(this.world.spawn(this.now()))
    if (start.resume) {
      this.emitChat(this.chat.notice('info', 'Resumed the earlier conversation. The agent remembers it; its messages from before are not shown here.', this.at()))
    }
    this.refresh()
  }

  /**
   * Builds the session folder, checks the gate, spawns agy and waits for its `init`. Used for the
   * first start, for a resume and for the respawn after an interrupt. Throws a readable message;
   * the flagged process is never spawned when the gate check fails.
   */
  private async launch(conversation: string | undefined, first: boolean): Promise<void> {
    const { cli, ingest } = this.deps
    const start = this.ctx.start
    const base = ingest.baseUrl()
    if (!base) throw new Error(AGY_NO_SERVER)

    // The office board's tools for this session, under a fresh token; null when the board is off.
    const board = this.deps.boardScript ? (first ? (this.ctx.board?.mcp() ?? null) : this.boardTools ? (this.ctx.board?.mcp(true) ?? null) : null) : null
    this.boardTools = !!board
    const folder = buildAgySessionFolder({ dir: this.dir, hookScript: this.deps.hookScript, boardScript: board ? this.deps.boardScript : null })
    this.folder = folder

    // Requirement 1: no process with the flag unless agy itself lists the app's gate for this folder.
    const problem = await (this.deps.probeGate ?? ((cwd, f) => probeAgyGate(cli, cwd, f)))(start.cwd, folder)
    if (problem) throw new Error(`${AGY_HOOKS_NOT_LOADED} (${problem})`)
    if (this.stopping || this.exited) throw new Error('the session was stopped')
    // Between the check and the spawn nothing of the gate may have changed.
    if (hashAgySessionFiles(folder.dir, folder.files) !== folder.hash) throw new Error(AGY_TAMPERED)

    const token = ingest.tokens.issue(this.id)
    const env: Record<string, string> = { AO_AGY_URL: `${base}${AGY_HOOK_ROUTE}`, AO_AGY_TOKEN: token, AO_AGY_SESSION: this.id }
    if (board) {
      env.AO_BOARD_URL = board.url
      env.AO_BOARD_TOKEN = board.token
    }
    if (this.deps.hookTimeoutMs) env.AO_AGY_TIMEOUT_MS = String(this.deps.hookTimeoutMs)
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--add-dir',
      folder.dir,
      // A prompt that starts with "/" must stay a prompt (a CLI slash command would end the stream).
      '--disable-slash-commands',
      '--log-file',
      join(folder.dir, 'agy.log'),
      ...(this.model ? ['--model', this.model] : []),
      ...(conversation ? ['--conversation', conversation] : []),
      // agy's own checks are lifted; the PreToolUse hook checked above is the gate.
      '--dangerously-skip-permissions'
    ]
    const child = cli.spawn(args, { cwd: start.cwd, env: cli.env(env) })
    const closed = new Promise<number | null>((done) => {
      child.once('close', (code) => done(code))
      child.once('error', () => done(null))
    })
    const proc: LiveProcess = { child, closed }
    this.stderrTail = []
    child.stdin.on('error', () => {})

    let onInit: ((e: Extract<AgyEvent, { type: 'init' }>) => void) | null = null
    const init = new Promise<Extract<AgyEvent, { type: 'init' }>>((got) => (onInit = got))
    lineReader(child.stdout, (line) => {
      const e = parseAgyLine(line)
      if (!e) return
      if (e.type === 'init') return onInit?.(e)
      if (this.proc === proc) this.onStreamEvent(e)
    })
    lineReader(child.stderr, (line) => this.onStderr(proc, line))

    const outcome = await Promise.race([
      init,
      closed.then((code) => ({ type: 'exit' as const, code })),
      sleep(this.deps.initTimeoutMs ?? INIT_TIMEOUT_MS).then(() => ({ type: 'timeout' as const }))
    ])
    if (outcome.type !== 'init') {
      killTree(child.pid)
      const said = this.stderrTail.join(' ').slice(0, 400)
      if (/authentication required|not logged in|please sign in|sign in to/i.test(said)) {
        this.deps.account.invalidate()
        throw new Error(AGY_NOT_LOGGED_IN)
      }
      this.deps.account.invalidate()
      throw new Error(outcome.type === 'timeout' ? 'Antigravity did not start in time' : `Antigravity exited while starting (exit code ${outcome.code ?? 'none'})${said ? `: ${said}` : ''}`)
    }
    // An unknown conversation id is not an error for agy: it warns and starts a NEW conversation.
    if (conversation && outcome.conversationId !== conversation) {
      killTree(child.pid)
      await Promise.race([closed, sleep(3000)])
      throw new Error(AGY_CONVERSATION_GONE)
    }
    if (this.stopping || this.exited) {
      killTree(child.pid)
      throw new Error('the session was stopped')
    }
    this.proc = proc
    this.steps.clear()
    this.briefed = false
    this.conversationId = outcome.conversationId || conversation
    if (this.conversationId) this.ctx.events.onProviderSession(this.conversationId)
    const model = outcome.model || this.model
    if (model) this.ctx.events.onModel(model)
    this.ready = true
    void closed.then((code) => this.onProcessExit(proc, code))
  }

  // -- the stream --

  private at(): { agentId: string; now: number; turnId?: string; cwd: string } {
    return { agentId: this.id, now: this.now(), turnId: this.turn?.id, cwd: this.ctx.start.cwd }
  }

  private onStreamEvent(e: AgyEvent): void {
    if (this.exited || this.interrupting) return
    const at = this.at()
    if (e.type === 'step' && e.stepType === 'tool') {
      if (e.state === 'ACTIVE') {
        this.steps.set(e.index, { name: e.toolName, params: e.params, asked: false })
        const activity = agyWorldActivity(e.toolName, e.params, this.ctx.start.cwd)
        if (activity) this.emitWorld(this.world.activity(this.id, activity.activity, activity.detail, at.now))
      } else {
        this.steps.delete(e.index)
      }
    }
    this.emitChat(this.chat.apply(e, at))
    if (e.type === 'step' && e.stepType === 'tool' && e.state === 'DONE') this.reportFileChange(e.index, e.toolName, e.params)
    if (e.type === 'result') this.onResult(e)
    this.refresh()
  }

  private onResult(e: Extract<AgyEvent, { type: 'result' }>): void {
    const turn = this.turn
    this.turn = null
    // Whatever was still waiting for the user died with the turn.
    this.ctx.permissions.clearSession(this.id)
    const now = this.now()
    if (turn) {
      const how = e.status === 'SUCCESS' ? 'completed' : e.status === 'CANCELED' || e.status === 'INTERRUPTED' ? 'interrupted' : 'failed'
      const error = how === 'failed' ? `Antigravity ended the turn with an error (${e.status || 'unknown'})${e.response ? `: ${e.response.slice(0, 500)}` : ''}` : undefined
      this.emitChat(this.chat.turnEnded(turn.id, how, { agentId: this.id, now, turnId: turn.id }, error))
      // A failed turn may mean the sign-in is gone or the weekly limit is reached: look again.
      if (how === 'failed') this.deps.account.invalidate()
    }
    this.emitWorld(this.world.settle(this.id, now))
    // After each turn, and never more than once a minute (AgyAccount).
    void this.deps.account.refreshUsage().catch(() => {})
    this.next()
  }

  /** Runs the oldest queued prompt, if the session is idle. */
  private next(): void {
    if (this.exited || !this.ready || this.turn || this.stopping) return
    const queued = this.queue.shift()
    if (queued) void this.startTurn(queued.text, queued.origin, queued)
  }

  private onStderr(proc: LiveProcess, line: string): void {
    const text = line.trim()
    if (!text) return
    this.stderrTail.push(text.slice(0, 500))
    if (this.stderrTail.length > 10) this.stderrTail.shift()
    if (this.proc !== proc || this.exited || this.interrupting) return
    // The "not found" warning of a resume is handled by comparing the conversation ids.
    if (/^warning: conversation .* not found/i.test(text)) return
    const turn = this.turn
    if (turn && turn.stderrNotices >= MAX_STDERR_NOTICES_PER_TURN) return
    if (turn) turn.stderrNotices++
    const error = /^AGY_ERROR:/i.test(text)
    this.emitChat(this.chat.notice(error ? 'error' : 'warning', text.replace(/^(warning|jetski|AGY_ERROR):\s*/i, '').slice(0, 1000), this.at()))
  }

  private onProcessExit(proc: LiveProcess, code: number | null): void {
    if (this.proc !== proc) return
    this.proc = null
    this.ready = false
    if (this.exited || this.stopping) return
    if (this.interrupting) return void this.afterInterrupt()
    const said = this.stderrTail.slice(-2).join(' ').slice(0, 300)
    this.finish(code, `Antigravity stopped unexpectedly (exit code ${code ?? 'none'})${said ? `: ${said}` : ''}.`)
  }

  // -- hooks (the /hooks/agy route) --

  handleAgyHook(event: AgyHookEvent, payload: Record<string, unknown>, req: RequestContext): unknown | Promise<unknown> {
    const deny = (reason: string): Record<string, unknown> => (event === 'PreToolUse' ? { decision: 'deny', reason } : {})
    if (this.exited || !this.proc || this.interrupting || this.stopping) return deny('This Agent Office session is not running.')
    // Only this session's own conversation is answered (a sub-agent's would have another id).
    if (!this.conversationId || payload.conversationId !== this.conversationId) return deny('Agent Office does not know this conversation, so the action was not approved.')
    if (event === 'PreInvocation') return this.onPreInvocation()
    return this.gate(payload, req)
  }

  /** Before each model call: the briefing (once per process), the board's digest (once per turn), notes, steers. */
  private onPreInvocation(): Record<string, unknown> {
    const steps: Array<Record<string, string>> = []
    try {
      if (!this.briefed) {
        this.briefed = true
        steps.push({ ephemeralMessage: officeBriefing('antigravity', { title: this.title, board: this.boardTools, mode: this.ctx.start.permissionMode, cwd: this.ctx.start.cwd }) })
      }
      const turn = this.turn
      if (turn && !turn.digestDone) {
        turn.digestDone = true
        const digest = this.ctx.board?.digest() ?? null
        if (digest) {
          steps.push({ ephemeralMessage: digest.text })
          this.ctx.board?.digestSent(digest.hash)
        }
      }
      for (const note of this.notes.splice(0)) steps.push({ ephemeralMessage: note })
      if (this.deps.steer === 'inject' && turn) {
        for (const queued of this.queue.splice(0, MAX_INJECTED_PROMPTS)) {
          steps.push({ userMessage: queued.text })
          this.emitChat(this.chat.userStarted(queued.itemId, turn.id))
          this.emitChat(this.chat.notice('info', AGY_STEERED_NOTE, this.at(), queued.noticeId))
        }
      }
    } catch {
      // The briefing and the board are conveniences: a model call never waits on them.
    }
    return steps.length > 0 ? { injectSteps: steps } : {}
  }

  /** Have the files that gate this session stayed as the app wrote them? */
  private filesIntact(): boolean {
    const folder = this.folder
    return !!folder && hashAgySessionFiles(folder.dir, folder.files) === folder.hash
  }

  /** Requirement 3: a changed hook file ends the session. */
  private tampered(): void {
    this.emitChat(this.chat.notice('error', AGY_TAMPERED, this.at(), 'tampered'))
    this.finish(1, AGY_TAMPERED)
  }

  /** The tool step the stream announced with this index and name, waiting a moment for it. */
  private async activeStep(index: number, name: string): Promise<StepRecord | null> {
    const end = Date.now() + STEP_WAIT_MS
    for (;;) {
      const step = this.steps.get(index)
      if (step) return step.name === name ? step : null
      if (Date.now() >= end || this.exited || !this.proc) return null
      await sleep(25)
    }
  }

  /** The PreToolUse question: the policy answers at once, or the answer is held for the CEO inbox. */
  private async gate(payload: Record<string, unknown>, req: RequestContext): Promise<Record<string, unknown>> {
    const deny = (reason: string): Record<string, unknown> => ({ decision: 'deny', reason })
    const call = isRecord(payload.toolCall) ? payload.toolCall : {}
    const tool = str(call.name, 200)
    const args = isRecord(call.args) ? call.args : {}
    const stepIdx = typeof payload.stepIdx === 'number' && Number.isInteger(payload.stepIdx) ? payload.stepIdx : -1
    if (!tool || stepIdx < 0) return deny('Agent Office could not read this request, so the action was not approved.')
    if (!this.filesIntact()) {
      this.tampered()
      return deny(AGY_TAMPERED)
    }
    // A question must belong to a tool step agy itself announced, and each step is asked once: a
    // command of the agent that posts here with the session's token gets no card.
    const step = await this.activeStep(stepIdx, tool)
    if (!step || step.asked) return deny('Agent Office did not see this tool call start, so it was not approved.')
    step.asked = true
    if (this.exited || !this.turn) return deny('This Agent Office session is not running a turn.')

    const start = this.ctx.start
    const verdict = agyPolicy({
      tool,
      args,
      mode: start.permissionMode,
      cwd: start.cwd,
      protectedPaths: [...this.deps.protectedPaths, this.dir],
      who: this.title,
      realPath: realPathOf,
      env: process.env
    })
    const at = this.at()
    // The stream has no file content: the card of the step gets it from here. A file of the app's
    // own folders is never read for that (config.json holds the ingest token): the refused call
    // shows what it wanted to write, not what is there.
    const untouchable = verdict.action === 'deny' && verdict.reason === PROTECTED_DENY_REASON
    if (verdict.action !== 'deny' || verdict.cls === 'write' || verdict.cls === 'command') {
      this.emitChat(this.chat.toolArgs(stepIdx, tool, args, untouchable ? {} : this.fileContext(tool, args)))
    }

    if (verdict.action === 'deny') {
      this.chat.refuse(stepIdx)
      this.emitChat(this.chat.notice('warning', `Not allowed: ${verdict.reason}`, at))
      // agy lists the session folder as a workspace, and a model may take it for the project: say where to work.
      return deny(verdict.reason === PROTECTED_DENY_REASON ? `${verdict.reason} Work in the project folder instead: ${start.cwd}` : verdict.reason)
    }

    const path = verdict.cls === 'write' ? str(args.TargetFile, 2000) : ''
    const conflict = path ? this.conflictStop(path) : null
    if (conflict) {
      this.chat.refuse(stepIdx)
      return deny(conflict)
    }
    if (verdict.action === 'allow') return { decision: 'allow' }

    // ask: one card in the CEO inbox, the hook's response held until it is decided.
    let { plain, detail } = { plain: verdict.card.plain, detail: verdict.card.detail }
    const live = path ? this.liveConflict(path) : null
    if (live) {
      if (plain.risk !== 'danger') plain = { ...plain, risk: 'caution', riskNote: live.riskNote }
      detail = `${live.line}\n\n${detail}`
    }
    return new Promise((answer) => {
      let permissionId: string | null = null
      permissionId = this.ctx.permissions.add(
        { sessionId: this.id, agentId: this.id, displayName: this.title, provider: 'antigravity', toolName: verdict.card.toolName, summary: verdict.card.summary, detail, ...plain },
        {
          // The hook script hung up (agy gave up on it, or the process tree was killed).
          signal: req.signal,
          onResolved: (outcome, decision) => {
            const allowed = outcome === 'allowed' && decision?.behavior === 'allow'
            const denied = outcome === 'denied' && decision?.behavior === 'deny'
            if (!allowed) this.chat.refuse(stepIdx)
            // The user's own words are the reason the model reads.
            const said = decision?.behavior === 'deny' ? decision.message : undefined
            answer(allowed ? { decision: 'allow' } : deny(denied ? (said ?? DEFAULT_DENY_MESSAGE) : 'Not approved: nobody answered this request before it was withdrawn.'))
            if (!permissionId) return
            this.emitChat(this.chat.approvalResolved(permissionId, allowed ? 'allowed' : denied ? 'denied' : 'resolved-elsewhere'))
            this.emitWorld(this.world.resume(this.id, this.now()))
            this.refresh()
          }
        }
      )
      if (!permissionId) return // could not be held: onResolved already answered deny
      const held = this.ctx.permissions.get(permissionId)
      this.emitWorld(this.world.waiting(this.id, permissionAction(held?.question ?? plain.question), at.now))
      this.emitChat(
        this.chat.approvalRequested(
          { requestId: permissionId, stepIndex: stepIdx, summary: verdict.card.summary, detail, question: held?.question ?? plain.question, risk: held?.risk ?? plain.risk, riskNote: held?.riskNote },
          at
        )
      )
      this.refresh()
    })
  }

  /** What the file is now, so the card can show a diff. Never throws. */
  private fileContext(tool: string, args: Record<string, unknown>): AgyFileContext {
    if (tool !== 'write_to_file') return {}
    const target = str(args.TargetFile, 2000)
    if (!target) return {}
    try {
      const file = resolve(this.ctx.start.cwd, target)
      const stat = statSync(file)
      if (!stat.isFile() || stat.size > DIFF_READ_MAX_BYTES) return {}
      return { before: readFileSync(file, 'utf8') }
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { before: null } : {}
    }
  }

  // -- office board (electron/board.ts). A failure here must never get in the way of a turn. --

  /** A finished writing tool: the file is on the board as changed by this team. */
  private reportFileChange(stepIndex: number, tool: string, params: Record<string, unknown>): void {
    if (!AGY_WRITE_TOOLS.includes(tool)) return
    const path = str(params.TargetFile, 2000)
    if (!path) return
    try {
      const item = this.chat.get(`step:${stepIndex}`)
      this.ctx.board?.fileChanged(path, item?.kind === 'file-change' && item.changes[0]?.change === 'add' ? 'create' : 'edit')
    } catch {
      // the board is a convenience
    }
  }

  /**
   * `block-once`: a file another team changed a moment ago is refused once, with the fixed warning
   * as the reason (the model reads it and may make the change again). `note`: the change goes on
   * and the model is told at its next call. Returns the deny reason, or null.
   */
  private conflictStop(path: string): string | null {
    try {
      const board = this.ctx.board
      if (!board || board.conflictMode === 'off') return null
      const c = board.conflict(path)
      if (!c || c.warned) return null
      if (board.conflictMode === 'note') {
        this.notes.push(board.warn(c, 'note'))
        return null
      }
      const text = board.warn(c, 'block-once')
      this.emitChat(
        this.chat.notice('warning', `Office board: this change was stopped once, because team "${c.otherTeam}" changed ${c.path} a moment ago. The agent was told and may make the change again.`, this.at())
      )
      return text
    } catch {
      return null
    }
  }

  private liveConflict(path: string): { riskNote: string; line: string } | null {
    try {
      const c = this.ctx.board?.conflict(path)
      return c ? this.ctx.board!.cardText(c) : null
    } catch {
      return null
    }
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

  async sendPrompt(text: string, origin: PromptOrigin = 'order'): Promise<PromptResult> {
    if (this.exited) return { ok: false, reason: 'the session has ended' }
    if (!this.ready || !this.proc) return { ok: false, reason: 'the session is not ready yet' }
    if (!this.turn) return this.startTurn(text, origin)
    // A turn is running. agy reads its input one prompt per turn, and has no way to take one in
    // the middle: the prompt is shown now and said to be waiting. (With steering on it is handed
    // over at the turn's next model call, and shown as added mid-turn.)
    const at = { agentId: this.id, now: this.now() }
    const shown = this.chat.user(text, origin === 'human' && this.deps.steer === 'inject' ? 'steer' : origin, at)
    this.emitChat(shown.events)
    const noticeId = `queued:${shown.id}`
    this.emitChat(this.chat.notice('info', AGY_QUEUED_NOTE, at, noticeId))
    this.queue.push({ text, origin, itemId: shown.id, noticeId })
    this.ctx.events.onPrompt?.(text)
    return { ok: true, queued: true }
  }

  private async startTurn(text: string, origin: PromptOrigin, queued?: QueuedPrompt): Promise<PromptResult> {
    const proc = this.proc
    if (!proc || this.exited) return { ok: false, reason: 'the session has ended' }
    // Requirement 3: before every turn the gate files must be what the app wrote.
    if (!this.filesIntact()) {
      this.tampered()
      return { ok: false, reason: AGY_TAMPERED }
    }
    const turnId = `turn-${++this.turnSeq}`
    this.turn = { id: turnId, digestDone: false, stderrNotices: 0 }
    const at = { agentId: this.id, now: this.now(), turnId }
    this.emitChat(this.chat.turnStarted(turnId))
    if (queued) {
      this.emitChat(this.chat.userStarted(queued.itemId, turnId))
      this.emitChat(this.chat.notice('info', 'Sent while a turn was running: started when that turn ended.', { agentId: this.id, now: at.now }, queued.noticeId))
    } else {
      this.emitChat(this.chat.user(text, origin, at).events)
      this.ctx.events.onPrompt?.(text)
    }
    try {
      proc.child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: text } })}\n`)
    } catch (err) {
      this.turn = null
      this.emitChat(this.chat.turnEnded(turnId, 'failed', at, `The prompt could not be delivered: ${message(err)}`))
      return { ok: false, reason: 'the prompt could not be delivered' }
    }
    this.refresh()
    return { ok: true, queued: false }
  }

  /**
   * agy has no interrupt on its pipe: the process tree is killed, what was open is marked
   * interrupted, and the same conversation is loaded into a new process (after the gate check).
   */
  interrupt(): void {
    const proc = this.proc
    if (this.exited || !proc || !this.turn || this.interrupting || this.stopping) return
    this.interrupting = true
    this.ready = false
    killTree(proc.child.pid)
    this.refresh()
  }

  private async afterInterrupt(): Promise<void> {
    const turn = this.turn
    this.turn = null
    this.ctx.permissions.clearSession(this.id)
    const now = this.now()
    if (turn) this.emitChat(this.chat.turnEnded(turn.id, 'interrupted', { agentId: this.id, now, turnId: turn.id }))
    this.emitWorld(this.world.settle(this.id, now))
    this.refresh()
    try {
      // The files the old process ran with must still be the app's own before they are trusted again.
      if (!this.filesIntact()) throw new Error(AGY_TAMPERED)
      await this.launch(this.conversationId, false)
    } catch (err) {
      this.interrupting = false
      if (!this.exited) this.finish(1, `The turn was interrupted, but Antigravity could not be started again: ${message(err)}`)
      return
    }
    this.interrupting = false
    this.refresh()
    this.next()
  }

  /** Closes agy's input (it exits by itself when idle) and kills the process tree if it doesn't. */
  async stop(): Promise<void> {
    if (this.exited) return
    this.stopping = true
    const proc = this.proc
    if (proc) {
      try {
        proc.child.stdin.end()
      } catch {
        // already closed
      }
      const gone = await Promise.race([proc.closed.then(() => true), sleep(this.turn ? 200 : STOP_GRACE_MS).then(() => false)])
      if (!gone) {
        killTree(proc.child.pid)
        await Promise.race([proc.closed, sleep(5000)])
      }
    }
    this.finish(0)
  }

  // -- internals --

  /** The tokens die (at once) and the session folder goes. */
  private cleanup(): void {
    this.revokeTokens()
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      // swept at the next launch
    }
  }

  private revokeTokens(): void {
    this.deps.ingest.tokens.revoke(this.id)
    this.ctx.board?.revoke()
  }

  private finish(exitCode: number | null, notice?: string): void {
    if (this.exited) return
    this.exited = true
    this.ready = false
    const proc = this.proc
    this.proc = null
    if (proc && proc.child.exitCode === null) killTree(proc.child.pid)
    const turn = this.turn
    this.turn = null
    this.queue = []
    // Requests still pending are answered with deny (their hook is gone or about to be).
    this.ctx.permissions.clearSession(this.id)
    const now = this.now()
    if (turn) this.emitChat(this.chat.turnEnded(turn.id, 'interrupted', { agentId: this.id, now, turnId: turn.id }))
    this.emitChat(this.chat.closeOpen(null, 'interrupted'))
    if (notice) {
      this.endNotice = notice
      if (notice !== AGY_TAMPERED) this.emitChat(this.chat.notice('error', notice, { agentId: this.id, now }))
    }
    this.emitWorld(this.world.end(now))
    this.revokeTokens()
    // The folder is removed once the process let go of it.
    if (proc) void Promise.race([proc.closed, sleep(5000)]).then(() => this.cleanup())
    else this.cleanup()
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
    for (const e of events) this.ctx.events.onChat(e)
  }

  private emitWorld(events: readonly AgentEvent[]): void {
    for (const e of events) this.ctx.sink.emit(e)
  }
}

function lineReader(stream: NodeJS.ReadableStream, cb: (line: string) => void): void {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line.trim()) cb(line)
    }
    // A line that never ends is not a message.
    if (buf.length > 8 * 1024 * 1024) buf = ''
  })
  stream.on('end', () => {
    if (buf.trim()) cb(buf)
    buf = ''
  })
}

// ---- provider table row -----------------------------------------------------------------------------

export interface AgyProviderOptions extends Omit<AgyDriverDeps, 'cli' | 'account'> {
  cli?: AgyCliOptions
  /** `agy --version`, for tests. */
  version?: (cli: AgyCli) => Promise<string>
}

export interface AgyProvider extends ProviderDefinition {
  readonly cli: AgyCli
  readonly account: AgyAccount
  login(): Promise<void>
  onChanged(cb: () => void): void
  shutdown(): Promise<void>
}

async function agyVersion(cli: AgyCli): Promise<string> {
  const r = await cli.run(['--version'], { timeoutMs: 15_000 })
  if (r.code !== 0) throw new Error('`agy --version` failed')
  const words = r.stdout.trim().split(/\s+/)
  return words[words.length - 1] ?? ''
}

export function agyProvider(opts: AgyProviderOptions): AgyProvider {
  const cli = new AgyCli(opts.cli)
  const account = new AgyAccount(cli, opts.now)
  const base = { id: 'antigravity' as const, label: AGY_LABEL }
  let version: { exe: string; value: string } | null = null

  return {
    ...base,
    cli,
    account,
    async probe(): Promise<ProviderInfo> {
      // Available = the executable exists. The version is nice to have.
      const exe = cli.exe()
      if (!exe) return { ...base, available: false, reason: 'not installed' }
      if (version?.exe !== exe) {
        try {
          version = { exe, value: await (opts.version ?? agyVersion)(cli) }
        } catch {
          version = { exe, value: '' }
        }
      }
      const info: ProviderInfo = { ...base, available: true, loginHelp: `${AGY_LOGIN_INSTRUCTION}.` }
      if (version.value) info.version = version.value
      // A slow probe must not hold up the provider list: the answer then arrives through onChanged.
      const read = account.read()
      const known = await Promise.race([read, sleep(PROBE_ACCOUNT_WAIT_MS).then(() => null)])
      if (known) info.account = { loggedIn: known.loggedIn }
      const usage = account.usage
      if (usage && info.account?.loggedIn) info.usage = usage
      return info
    },
    createDriver: (ctx) => new AgyDriver(ctx, { ...opts, cli, account }),
    /**
     * agy has no login the app could drive (no subcommand, no address on a pipe): this looks again
     * ("Check again"), and when agy is still signed out it says what to do.
     */
    async login(): Promise<void> {
      if (!cli.exe()) throw new Error('Antigravity (agy) is not installed')
      const state = await account.read(0)
      if (!state.loggedIn) throw new Error(AGY_LOGIN_INSTRUCTION)
      void account.refreshUsage(true)
    },
    onChanged: (cb) => void account.onChanged(cb),
    conversationGone: ({ error }) => !!error && error.includes(AGY_CONVERSATION_GONE),
    async shutdown(): Promise<void> {
      cli.killSync()
    }
  }
}
