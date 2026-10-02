// Phase C spike helper: finds and spawns Google's Antigravity CLI (`agy`) without a shell, logs every
// line both ways, and kills its own process tree. Shared by probe.cjs and check.cjs. Plain Node.
//
// IMPORTANT: never run `agy -p "/usage"` (or any slash command) through Git Bash: MSYS rewrites the
// argument to `C:/Program Files/Git/usage`, the CLI no longer sees a slash command, and a real model
// turn runs. Always go through spawn() with an argv array, as this file does.
'use strict'
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Where `agy` is: AGY_PATH, the Windows installer's folder, ~/.local/bin, then PATH. */
function findAgyExecutable(env = process.env, platform = process.platform) {
  const name = platform === 'win32' ? 'agy.exe' : 'agy'
  const candidates = []
  if (env.AGY_PATH) candidates.push(env.AGY_PATH)
  if (platform === 'win32' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'agy', 'bin', name))
  candidates.push(path.join(os.homedir(), '.local', 'bin', name))
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir)) candidates.push(path.join(dir, name))
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

/**
 * Ours minus what a parent agent session exported, and minus everything that would change how agy
 * authenticates or where it connects. The background self-updater is switched off.
 */
function scrubbedEnv(base = process.env, extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue
    if (/^(CLAUDE|AI_AGENT|CODEX_|ANTIGRAVITY_|AGY_|GEMINI_|GOOGLE_GEMINI_)/i.test(k)) continue
    env[k] = v
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
  return { ...env, ...extra }
}

/** E-mail addresses have no business in a log file or in the docs. */
const redact = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')

class Logger {
  constructor(file, echo = true) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.file = file
    this.stream = fs.createWriteStream(file, { flags: 'w' })
    this.t0 = Date.now()
    this.echo = echo
  }
  /** dir: `->` to agy stdin, `<-` agy stdout, `!!` agy stderr, `hk` hook call, `--` harness note. */
  line(dir, msg) {
    const rec = { t: Date.now() - this.t0, dir, msg }
    const text = redact(JSON.stringify(rec))
    if (!this.stream.writableEnded) this.stream.write(text + '\n')
    if (this.echo) console.log(text.length > 600 ? text.slice(0, 600) + '…' : text)
  }
  note(text) {
    this.line('--', text)
  }
  close() {
    return new Promise((resolve) => this.stream.end(resolve))
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/** Runs agy once and collects its output. stdin is closed at once unless `input` is given. */
function runOnce(exe, args, opts = {}) {
  const { cwd, env = scrubbedEnv(), input, timeoutMs = 60_000, log } = opts
  return new Promise((resolve) => {
    const t0 = Date.now()
    log?.line('--', { spawn: [path.basename(exe), ...args], cwd })
    const child = spawn(exe, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr: stderr + String(err), ms: Date.now() - t0, timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const res = { code, signal, stdout, stderr, ms: Date.now() - t0, timedOut }
      log?.line('--', { exit: code, signal, ms: res.ms, timedOut, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) })
      resolve(res)
    })
  })
}

/**
 * A long-lived `agy --input-format stream-json --output-format stream-json` process.
 * Events are parsed per line; `waitFor(pred, ms)` resolves with the first event (past or future) that matches.
 */
class AgySession {
  constructor(exe, args, opts = {}) {
    this.log = opts.log
    this.events = []
    this.stderrLines = []
    this.waiters = []
    this.exited = null
    this.t0 = Date.now()
    const full = ['--input-format', 'stream-json', '--output-format', 'stream-json', ...args]
    this.log?.line('--', { spawn: [path.basename(exe), ...full], cwd: opts.cwd })
    this.child = spawn(exe, full, { cwd: opts.cwd, env: opts.env ?? scrubbedEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    this.child.stdin.on('error', () => {})
    this.#lines(this.child.stdout, (line) => {
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        ev = { event: '(not json)', raw: line }
      }
      ev._t = Date.now() - this.t0
      this.log?.line('<-', ev)
      this.events.push(ev)
      opts.onEvent?.(ev)
      this.#wake()
    })
    this.#lines(this.child.stderr, (line) => {
      this.stderrLines.push({ t: Date.now() - this.t0, line })
      this.log?.line('!!', line)
      opts.onStderr?.(line)
    })
    this.done = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.exited = { code, signal, t: Date.now() - this.t0 }
        this.log?.line('--', { exit: code, signal })
        this.#wake()
        resolve(this.exited)
      })
    })
  }

  #lines(stream, cb) {
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.trim()) cb(line)
      }
    })
    stream.on('end', () => {
      if (buf.trim()) cb(buf)
    })
  }

  #wake() {
    for (const w of [...this.waiters]) w()
  }

  /** Writes one NDJSON line to stdin. */
  send(obj) {
    this.log?.line('->', obj)
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  prompt(text) {
    this.send({ event: 'user', message: { content: text } })
  }

  /** First event at index >= `from` matching `pred`; null on timeout or exit. */
  waitFor(pred, ms, from = 0) {
    return new Promise((resolve) => {
      let timer
      const check = () => {
        for (let i = from; i < this.events.length; i++) {
          if (pred(this.events[i])) return finish(this.events[i])
        }
        if (this.exited) finish(null)
      }
      const finish = (v) => {
        clearTimeout(timer)
        this.waiters = this.waiters.filter((w) => w !== check)
        resolve(v)
      }
      timer = setTimeout(() => finish(null), ms)
      this.waiters.push(check)
      check()
    })
  }

  closeStdin() {
    this.log?.line('--', 'closing stdin')
    this.child.stdin.end()
  }

  kill() {
    this.log?.line('--', 'killing the process tree')
    killTree(this.child.pid)
  }
}

/** PE subsystem of a Windows executable: 2 = GUI, 3 = console. */
function peSubsystem(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(0x40)
    fs.readSync(fd, head, 0, head.length, 0)
    const peOff = head.readUInt32LE(0x3c)
    const opt = Buffer.alloc(0x60)
    fs.readSync(fd, opt, 0, opt.length, peOff + 24)
    return opt.readUInt16LE(68)
  } finally {
    fs.closeSync(fd)
  }
}

/** The process and all its descendants: [{pid, ppid, name, rssMb}] (Windows only; [] elsewhere). */
function processTree(rootPid) {
  if (process.platform !== 'win32') return []
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
    const all = JSON.parse(out)
    const tree = []
    const walk = (pid) => {
      for (const p of all) {
        if (p.ProcessId === pid && !tree.some((t) => t.pid === pid)) {
          tree.push({ pid, ppid: p.ParentProcessId, name: p.Name, rssMb: Math.round(p.WorkingSetSize / 1048576), cmd: redact(p.CommandLine ?? '').slice(0, 300) })
        }
      }
      for (const p of all) if (p.ParentProcessId === pid && !tree.some((t) => t.pid === p.ProcessId)) walk(p.ProcessId)
    }
    walk(rootPid)
    return tree
  } catch (err) {
    return [{ error: String(err).slice(0, 200) }]
  }
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true
      else out[a.slice(2)] = argv[++i]
    } else out._.push(a)
  }
  return out
}

module.exports = { findAgyExecutable, scrubbedEnv, redact, Logger, killTree, runOnce, AgySession, peSubsystem, processTree, parseArgs }
