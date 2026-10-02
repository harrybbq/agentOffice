// Runs ONE package.json script of a session's folder (`npm run <name>`) as a background process the
// app owns: started for the preview, killed with its whole process tree when the preview stops, the
// session ends or the app quits. No Electron imports; tests pass a fake `spawn`.
//
// The renderer only ever names a script. The name must be in the folder's package.json AND consist
// of plain characters, so nothing in it can be read as a second command.
import { execFile, execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { stripAnsi } from './detect'

/** Kept for the "Preview log" disclosure: the tail of what the script printed. */
export const RUNNER_LOG_CHARS = 32_000
export const MAX_SCRIPTS = 12

/** Letters, digits and the separators npm script names usually have. Nothing a shell could act on. */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/
/** A script name (or one part of it: "docs:dev", "start-web") that suggests a web server. */
const DEV_WORDS: readonly string[] = ['dev', 'start', 'serve', 'preview', 'storybook', 'develop', 'server', 'watch']

export function isSafeScriptName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_SCRIPT_NAME.test(name)
}

/**
 * The scripts of a package.json that look like dev servers, best guess first ("dev", "start",
 * "serve", "preview", "storybook", then names with such a part: "docs:dev"). Names with characters
 * outside SAFE_SCRIPT_NAME are left out: they could not be run anyway.
 */
export function devScripts(packageJson: string): string[] {
  let scripts: unknown
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: unknown } | null)?.scripts
  } catch {
    return []
  }
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return []
  const rank = (name: string): number => {
    const whole = DEV_WORDS.indexOf(name.toLowerCase())
    if (whole !== -1) return whole
    const parts = name.toLowerCase().split(/[:_.-]/)
    const part = Math.min(...parts.map((p) => DEV_WORDS.indexOf(p)).filter((i) => i !== -1))
    return Number.isFinite(part) ? DEV_WORDS.length + part : -1
  }
  return Object.entries(scripts as Record<string, unknown>)
    .filter(([name, cmd]) => isSafeScriptName(name) && typeof cmd === 'string' && cmd.trim().length > 0)
    .map(([name]) => ({ name, rank: rank(name) }))
    .filter((s) => s.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, MAX_SCRIPTS)
    .map((s) => s.name)
}

export interface RunnerCommand {
  file: string
  args: string[]
  /** Windows: the arguments are already one command line for cmd.exe. */
  verbatim: boolean
}

/**
 * The fixed command for a script name. On Windows npm is a .cmd file, which only cmd.exe can run:
 * `cmd.exe /d /s /c npm.cmd run <name>`. The name went through isSafeScriptName, so it has no
 * spaces, quotes or shell operators.
 */
export function runnerCommand(script: string, platform: NodeJS.Platform = process.platform, comspec = process.env.ComSpec): RunnerCommand {
  if (!isSafeScriptName(script)) throw new Error('that script name cannot be run')
  if (platform === 'win32') return { file: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd run ${script}`], verbatim: true }
  return { file: 'npm', args: ['run', script], verbatim: false }
}

/** The script's environment: ours without the app's own switches, and no browser popping open. */
export function runnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(ELECTRON_|AGENT_OFFICE_)/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue
    out[k] = v
  }
  out.BROWSER = 'none' // create-react-app and friends open a browser tab otherwise
  out.FORCE_COLOR = '0'
  out.NO_COLOR = '1'
  return out
}

/** What the runner needs from a child process (node's ChildProcess; tests use a fake). */
export interface RunnerChild {
  pid?: number
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type RunnerSpawn = (cmd: RunnerCommand, opts: { cwd: string; env: NodeJS.ProcessEnv }) => RunnerChild

const defaultSpawn: RunnerSpawn = (cmd, opts) =>
  nodeSpawn(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: cmd.verbatim,
    // Its own process group elsewhere, so the whole tree can be signalled.
    detached: process.platform !== 'win32'
  })

export interface RunnerOptions {
  cwd: string
  script: string
  /** Every chunk the script prints (stdout and stderr), as it arrives. */
  onOutput(text: string): void
  /** The script is gone (by itself, or because it was stopped). */
  onExit(code: number | null): void
  spawn?: RunnerSpawn
  env?: NodeJS.ProcessEnv
}

export class Runner {
  readonly script: string
  private child: RunnerChild | null = null
  private exited = false
  private buffer = ''
  private waiters: Array<() => void> = []

  constructor(private readonly opts: RunnerOptions) {
    this.script = opts.script
  }

  get running(): boolean {
    return !!this.child && !this.exited
  }

  /** Throws a readable message if the script cannot be started. */
  start(): void {
    if (this.child) throw new Error('the script is already running')
    const cmd = runnerCommand(this.opts.script)
    let child: RunnerChild
    try {
      child = (this.opts.spawn ?? defaultSpawn)(cmd, { cwd: this.opts.cwd, env: runnerEnv(this.opts.env ?? process.env) })
    } catch (err) {
      throw new Error(`could not start npm: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.child = child
    this.append(`> npm run ${this.opts.script}\n`)
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.append(text)
      this.opts.onOutput(text)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      this.append(`\n${err.message}\n`)
      this.finish(null)
    })
    child.on('exit', (code) => this.finish(code))
  }

  private append(text: string): void {
    this.buffer += stripAnsi(text).replace(/\r\n?/g, '\n')
    if (this.buffer.length > RUNNER_LOG_CHARS) this.buffer = this.buffer.slice(-RUNNER_LOG_CHARS)
  }

  private finish(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.append(`\n[the script ended${code === null ? '' : ` with code ${code}`}]\n`)
    for (const w of this.waiters.splice(0)) w()
    this.opts.onExit(code)
  }

  /** The tail of what the script printed, without colour codes. */
  log(): string {
    return this.buffer
  }

  /** Kills the script and everything it started. Resolves when it is gone (or after a short wait). */
  stop(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4000)
      timer.unref?.()
      this.waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
      killTree(child, false)
    })
  }

  /** Last resort for `process.on('exit')`: synchronous. */
  killSync(): void {
    if (this.child && !this.exited) killTree(this.child, true)
  }
}

function killTree(child: RunnerChild, sync: boolean): void {
  const pid = child.pid
  try {
    if (pid === undefined) {
      child.kill()
    } else if (process.platform === 'win32') {
      const args = ['/T', '/F', '/PID', String(pid)]
      if (sync) execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 5000 })
      else execFile('taskkill', args, { windowsHide: true, timeout: 5000 }, () => undefined)
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
  } catch {
    // already gone
  }
}
