// One shared `codex app-server` child process for every Codex session of the app (JSON-RPC over
// stdio, one JSON object per line; threads are multiplexed by `threadId`). This file owns the
// process, the handshake, request ids, routing by thread, and restart after a crash.
// Protocol notes and the reasons for each choice: docs/spikes-phase-b.md.
//
// No Electron imports: only node:child_process. Tests run it against tests/fixtures/fake-codex-server.cjs.
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { parseWireLine, threadIdOf, type JsonRpcId } from './codexProtocol'

export const CODEX_CLIENT_NAME = 'agent_office'
/** A JSON line longer than this means something is wrong with the stream. */
const MAX_LINE_CHARS = 32 * 1024 * 1024
const STDERR_MAX_CHARS = 64 * 1024
const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 15_000, 30_000]
/** A server that stayed up this long starts again from the first backoff step. */
const STABLE_MS = 60_000
const HANDSHAKE_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

// ---- finding the executable -------------------------------------------------------------------------

export interface CodexExecutable {
  exe: string
  /** `<npm prefix>/node_modules/@openai/codex` when the exe was found through the npm package. */
  packageRoot: string | null
}

/**
 * Where the native `codex` binary is. The npm shim is `codex.cmd` -> `node bin/codex.js` ->
 * `codex.exe`; only the last is spawned (no cmd.exe, no extra node process, no shell). If the
 * layout differs, any `codex.exe` on PATH is used.
 */
export function findCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CodexExecutable | null {
  const triples: Record<string, Record<string, string>> = {
    win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
    darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
    linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' }
  }
  const triple = triples[platform]?.[arch]
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex'
  const fromPackageRoot = (root: string): CodexExecutable | null =>
    triple ? { exe: join(root, 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor', triple, 'bin', exeName), packageRoot: root } : null
  const candidates: (CodexExecutable | null)[] = []
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d.length > 0 && isAbsolute(d))
  if (platform === 'win32') {
    if (env.APPDATA) candidates.push(fromPackageRoot(join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex')))
    for (const dir of dirs) {
      if (existsSync(join(dir, 'codex.cmd'))) candidates.push(fromPackageRoot(join(dir, 'node_modules', '@openai', 'codex')))
      candidates.push({ exe: join(dir, 'codex.exe'), packageRoot: null })
    }
  } else {
    for (const dir of dirs) {
      const link = join(dir, 'codex')
      if (!existsSync(link)) continue
      try {
        // npm's bin symlink points at <root>/bin/codex.js
        const real = realpathSync(link)
        if (real.endsWith('codex.js')) candidates.push(fromPackageRoot(dirname(dirname(real))))
        else candidates.push({ exe: real, packageRoot: null })
      } catch {
        // not usable
      }
    }
  }
  return candidates.find((c): c is CodexExecutable => !!c && existsSync(c.exe)) ?? null
}

/**
 * The environment of the app-server: ours minus what a parent agent session exported. CODEX_HOME
 * is kept when the user set one, because that is where their login lives; otherwise Codex uses its
 * default home (~/.codex), shared with the CLI and the desktop app.
 */
export function codexEnv(base: NodeJS.ProcessEnv, found: CodexExecutable | null): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue
    if (/^(CLAUDE|AI_AGENT)/i.test(k)) continue
    if (/^CODEX_/i.test(k) && k.toUpperCase() !== 'CODEX_HOME') continue
    env[k] = v
  }
  if (found?.packageRoot) {
    // What bin/codex.js sets before it starts the native binary: how Codex was installed.
    env.CODEX_MANAGED_BY_NPM = '1'
    env.CODEX_MANAGED_PACKAGE_ROOT = found.packageRoot
  }
  return env
}

export function codexVersion(exe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, ['--version'], { env: codexEnv(process.env, null), timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err)
      // "codex-cli 0.160.0"
      const words = String(stdout).trim().split(/\s+/)
      resolve(words[words.length - 1] ?? '')
    })
  })
}

// ---- connection -------------------------------------------------------------------------------------

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

export interface ThreadHandlers {
  notification(threadId: string, method: string, params: Record<string, unknown>): void
  /** A question from the server. It must be answered with `respond()` (or `respondError()`), now or later. */
  request(threadId: string, id: JsonRpcId, method: string, params: Record<string, unknown>): void
}

export type CodexServerEvent =
  /** The handshake finished: requests can be sent. Fires after every (re)start. */
  | { type: 'up' }
  /** The process is gone. Every pending request was rejected and every server request is void. */
  | { type: 'down'; expected: boolean }
  /** A notification no thread subscription took: account/*, thread/started of an unknown thread, … */
  | { type: 'notification'; method: string; params: Record<string, unknown> }

/** What a driver needs from the shared server (tests substitute an in-memory fake). */
export interface CodexConnection {
  /** Starts the process if it isn't running. Rejects with a readable message if it can't. */
  ensureStarted(): Promise<void>
  /** Resolves with `result`; rejects with a CodexRpcError. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
  respond(id: JsonRpcId, result: unknown): void
  respondError(id: JsonRpcId, code: number, message: string): void
  /** Routes this thread's notifications and server requests to `handlers`. Returns the unsubscribe. */
  subscribeThread(threadId: string, handlers: ThreadHandlers): () => void
  onEvent(listener: (e: CodexServerEvent) => void): () => void
}

export interface CodexSpawnSpec {
  file: string
  args: string[]
  env: Record<string, string>
}

export interface CodexServerOptions {
  /** What to run. Default: the real `codex app-server`. Null = not installed. Tests point it at a fake. */
  resolveSpawn?: () => CodexSpawnSpec | null
  clientVersion?: string
  /** Delay before the 1st, 2nd, … restart after a crash. */
  backoffMs?: readonly number[]
  requestTimeoutMs?: number
}

interface PendingRequest {
  resolve(result: unknown): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

function defaultSpawn(): CodexSpawnSpec | null {
  const found = findCodexExecutable()
  // No `--disable plugins/apps`: hosted sessions keep the desktop app's plugins and MCP servers
  // (the user's decision). Nothing is written to config.toml.
  return found ? { file: found.exe, args: ['app-server'], env: codexEnv(process.env, found) } : null
}

export class CodexServer implements CodexConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private starting: Promise<void> | null = null
  private stopped = false
  private nextId = 1
  private pending = new Map<JsonRpcId, PendingRequest>()
  private threads = new Map<string, ThreadHandlers>()
  private listeners = new Set<(e: CodexServerEvent) => void>()
  /** Last stderr output (ANSI stripped), for diagnostics. Never printed in bulk. */
  private stderr = ''
  private failures = 0
  private upSince = 0
  private notBefore = 0
  private restartTimer: NodeJS.Timeout | null = null
  /** Answers of the last `initialize`. */
  info: { userAgent?: string; codexHome?: string } = {}

  constructor(private readonly opts: CodexServerOptions = {}) {}

  get running(): boolean {
    return this.ready
  }

  /** The pid of our own child, if it is running. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  stderrTail(maxChars = 4000): string {
    return this.stderr.slice(-maxChars)
  }

  onEvent(listener: (e: CodexServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  subscribeThread(threadId: string, handlers: ThreadHandlers): () => void {
    this.threads.set(threadId, handlers)
    return () => {
      if (this.threads.get(threadId) === handlers) this.threads.delete(threadId)
    }
  }

  ensureStarted(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('the app is shutting down'))
    if (this.ready) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async start(): Promise<void> {
    // After a crash, wait out the backoff, also when the start is asked for by a new session.
    const wait = this.notBefore - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    if (this.stopped) throw new Error('the app is shutting down')
    const spec = (this.opts.resolveSpawn ?? defaultSpawn)()
    if (!spec) throw new Error('Codex is not installed (no `codex` executable found)')

    let child: ChildProcessWithoutNullStreams
    try {
      // codex.exe is a console program: without windowsHide a GUI parent gets a console window.
      child = spawn(spec.file, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    } catch (err) {
      this.crashed()
      throw new Error(`could not start the Codex app-server: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.child = child
    this.stderr = ''
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) this.onLine(child, line)
      }
      if (buf.length > MAX_LINE_CHARS) {
        buf = ''
        this.note('a message from the app-server was too long; restarting it')
        this.kill(child)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.note(chunk))
    // Writing to a dead process must not throw into the app.
    child.stdin.on('error', () => {})

    const exited = new Promise<never>((_, reject) => {
      child.once('error', (err) => {
        this.note(`spawn error: ${err.message}`)
        this.onExit(child)
        reject(new Error(`could not start the Codex app-server: ${err.message}`))
      })
      child.once('exit', (code, signal) => {
        this.note(`app-server exited (code ${code ?? '-'}${signal ? `, ${signal}` : ''})`)
        this.onExit(child)
        reject(new Error('the Codex app-server exited while starting'))
      })
    })
    exited.catch(() => {}) // only raced below; after the handshake the exit is handled by onExit

    const handshake = this.send(child, 'initialize', {
      clientInfo: { name: CODEX_CLIENT_NAME, title: 'Agent Office', version: this.opts.clientVersion ?? '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    }, HANDSHAKE_TIMEOUT_MS)
    try {
      const result = await Promise.race([handshake, exited])
      const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
      this.info = {
        userAgent: typeof r.userAgent === 'string' ? r.userAgent : undefined,
        codexHome: typeof r.codexHome === 'string' ? r.codexHome : undefined
      }
    } catch (err) {
      handshake.catch(() => {})
      if (this.child === child) this.kill(child)
      throw err instanceof Error ? err : new Error('the Codex app-server did not answer')
    }
    if (this.child !== child) throw new Error('the Codex app-server exited while starting')
    this.write(child, { method: 'initialized' })
    this.ready = true
    this.upSince = Date.now()
    this.emit({ type: 'up' })
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const child = this.child
    if (!this.ready || !child) return Promise.reject(new CodexRpcError('the Codex app-server is not running'))
    return this.send(child, method, params, timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.child && this.ready) this.write(this.child, { id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (this.child && this.ready) this.write(this.child, { id, error: { code, message } })
  }

  /**
   * Stops the server for good (app quit): closes stdin, which makes it exit, and kills our own
   * process tree if it doesn't. Never touches another codex process.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    if (!child) return
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      child.stdin.end()
    } catch {
      // already closed
    }
    const timeout = (ms: number): Promise<'timeout'> => new Promise((r) => setTimeout(() => r('timeout'), ms))
    if ((await Promise.race([gone, timeout(1500)])) === 'timeout') {
      this.kill(child)
      await Promise.race([gone, timeout(3000)])
    }
  }

  /** Last resort for `process.on('exit')`: synchronous, own tree only. */
  killSync(): void {
    this.stopped = true
    const child = this.child
    if (!child || child.pid === undefined || child.exitCode !== null) return
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
      else child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  // ---- internals ----

  private send(child: ChildProcessWithoutNullStreams, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexRpcError(`Codex did not answer "${method}" in time`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.write(child, params === undefined ? { method, id } : { method, id, params })
    })
  }

  private write(child: ChildProcessWithoutNullStreams, msg: unknown): void {
    if (child.stdin.destroyed || !child.stdin.writable) return
    try {
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // the exit handler deals with a dead process
    }
  }

  private onLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child) return
    const msg = parseWireLine(line)
    if (!msg) return this.note(`unparseable line from the app-server (${line.length} chars)`)
    if (msg.kind === 'response') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new CodexRpcError(msg.error.message, msg.error.code))
      else p.resolve(msg.result)
      return
    }
    const threadId = threadIdOf(msg.params)
    const handlers = threadId ? this.threads.get(threadId) : undefined
    if (msg.kind === 'request') {
      // Never leave a server request unanswered: the turn would hang on it.
      if (!handlers || !threadId) return this.respondError(msg.id, -32601, 'not handled by Agent Office')
      try {
        handlers.request(threadId, msg.id, msg.method, msg.params)
      } catch (err) {
        this.note(`request handler failed: ${err instanceof Error ? err.message : String(err)}`)
        this.respondError(msg.id, -32603, 'internal error in Agent Office')
      }
      return
    }
    try {
      if (handlers && threadId) handlers.notification(threadId, msg.method, msg.params)
      else this.emit({ type: 'notification', method: msg.method, params: msg.params })
    } catch (err) {
      this.note(`notification handler failed (${msg.method}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return
    this.child = null
    const wasReady = this.ready
    this.ready = false
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new CodexRpcError('the Codex app-server stopped'))
    }
    this.pending.clear()
    if (this.stopped) {
      this.emit({ type: 'down', expected: true })
      return
    }
    if (wasReady && Date.now() - this.upSince > STABLE_MS) this.failures = 0
    this.crashed()
    if (wasReady) this.emit({ type: 'down', expected: false })
    // Sessions are waiting for it: bring it back. Without sessions the next need starts it.
    if (this.threads.size > 0) this.scheduleRestart()
  }

  private crashed(): void {
    const steps = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS
    this.notBefore = Date.now() + (steps[Math.min(this.failures, steps.length - 1)] ?? 1000)
    this.failures++
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopped) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopped || this.ready || this.threads.size === 0) return
      // A failed start that never got a process doesn't come through onExit: try again from here.
      this.ensureStarted().catch(() => {
        if (!this.child) this.scheduleRestart()
      })
    }, Math.max(0, this.notBefore - Date.now()))
    this.restartTimer.unref?.()
  }

  private kill(child: ChildProcessWithoutNullStreams): void {
    if (child.pid === undefined || child.exitCode !== null) return
    try {
      if (process.platform === 'win32') {
        // The tree: commands Codex started must not outlive it. Only our own pid.
        execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {})
      } else child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  private note(text: string): void {
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    this.stderr = (this.stderr + clean + (clean.endsWith('\n') ? '' : '\n')).slice(-STDERR_MAX_CHARS)
  }

  private emit(e: CodexServerEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e)
      } catch (err) {
        this.note(`listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
