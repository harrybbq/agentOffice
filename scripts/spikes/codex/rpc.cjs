// Phase B spike helper: a minimal JSON-RPC client for `codex app-server` (stdio, one JSON object per line).
// Shared by harness.cjs and logged-in-check.cjs. Plain Node, no dependencies.
'use strict'
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Where the native `codex.exe` is. The npm shim is codex.cmd -> node bin/codex.js -> codex.exe; the
 * last one is what we spawn (no cmd.exe, no extra node process).
 */
function findCodexExecutable(env = process.env, platform = process.platform, arch = process.arch) {
  const triple =
    platform === 'win32'
      ? { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[arch]
      : platform === 'darwin'
        ? { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' }[arch]
        : { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' }[arch]
  if (!triple) return null
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex'
  const platformPkg = `codex-${platform}-${arch}`
  /** `<npm prefix>/node_modules/@openai/codex` -> its vendored binary. */
  const fromPackageRoot = (root) => ({
    exe: path.join(root, 'node_modules', '@openai', platformPkg, 'vendor', triple, 'bin', exeName),
    packageRoot: root
  })
  const candidates = []
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d))
  if (platform === 'win32') {
    if (env.APPDATA) candidates.push(fromPackageRoot(path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex')))
    for (const dir of dirs) {
      if (fs.existsSync(path.join(dir, 'codex.cmd'))) candidates.push(fromPackageRoot(path.join(dir, 'node_modules', '@openai', 'codex')))
      candidates.push({ exe: path.join(dir, 'codex.exe'), packageRoot: null })
    }
  } else {
    for (const dir of dirs) {
      const link = path.join(dir, 'codex')
      if (!fs.existsSync(link)) continue
      try {
        // npm's bin symlink points at <root>/bin/codex.js
        const real = fs.realpathSync(link)
        if (real.endsWith('codex.js')) candidates.push(fromPackageRoot(path.dirname(path.dirname(real))))
        else candidates.push({ exe: real, packageRoot: null })
      } catch {
        // ignore
      }
    }
  }
  return candidates.find((c) => fs.existsSync(c.exe)) ?? null
}

/** Ours minus what a parent agent session exported (the spike may be run from an agent terminal). */
function scrubbedEnv(base) {
  const env = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string' || /^(CLAUDE|AI_AGENT|CODEX_)/i.test(k)) continue
    env[k] = v
  }
  return env
}

class CodexRpc {
  /**
   * @param {{ logFile: string, codexHome?: string, cwd?: string, args?: string[], mimicShim?: boolean,
   *           onRequest?: (msg: any) => any, onNotification?: (msg: any) => void, echo?: boolean }} opts
   */
  constructor(opts) {
    this.opts = opts
    this.nextId = 1
    this.pending = new Map()
    this.waiters = []
    this.notifications = []
    this.exited = false
    this.t0 = Date.now()
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
    this.log = fs.createWriteStream(opts.logFile, { flags: 'w' })
  }

  record(dir, msg) {
    // The account's e-mail address has no business in a log file.
    const redact = (s) => s.replace(/"email":"[^"]*"/g, '"email":"<redacted>"')
    const line = redact(JSON.stringify({ t: Date.now() - this.t0, dir, msg }))
    this.log.write(line + '\n')
    if (this.opts.echo !== false) {
      const s = redact(typeof msg === 'string' ? msg : JSON.stringify(msg))
      console.log(`${String(Date.now() - this.t0).padStart(6)} ${dir} ${s.length > 600 ? s.slice(0, 600) + ` …(+${s.length - 600})` : s}`)
    }
  }

  start() {
    const found = findCodexExecutable()
    if (!found) throw new Error('codex executable not found')
    const env = scrubbedEnv(process.env)
    if (this.opts.codexHome) env.CODEX_HOME = this.opts.codexHome
    if (this.opts.mimicShim !== false && found.packageRoot) {
      // What bin/codex.js sets before it spawns the native binary.
      env.CODEX_MANAGED_BY_NPM = '1'
      env.CODEX_MANAGED_PACKAGE_ROOT = found.packageRoot
    }
    this.exe = found.exe
    this.record('--', { spawn: found.exe, args: ['app-server', ...(this.opts.args ?? [])], CODEX_HOME: env.CODEX_HOME ?? '(default)' })
    this.child = spawn(found.exe, ['app-server', ...(this.opts.args ?? [])], {
      cwd: this.opts.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })
    let buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) this.onLine(line)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => this.record('!!', String(chunk).trimEnd()))
    this.child.on('error', (err) => this.record('--', { spawnError: String(err) }))
    this.child.on('exit', (code, signal) => {
      this.exited = true
      this.record('--', { exit: code, signal })
      for (const p of this.pending.values()) p.reject(new Error('app-server exited'))
      this.pending.clear()
    })
    return this
  }

  onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return this.record('<?', line)
    }
    this.record('<-', msg)
    const hasId = msg.id !== undefined && msg.id !== null
    if (hasId && msg.method === undefined) {
      // response
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'rpc error'), { rpc: msg.error }))
        else p.resolve(msg.result)
      }
    } else if (hasId) {
      // server -> client request: must be answered
      Promise.resolve(this.opts.onRequest ? this.opts.onRequest(msg) : undefined).then((result) => {
        if (result === undefined) this.send({ id: msg.id, error: { code: -32601, message: 'not handled by the spike harness' } })
        else this.send({ id: msg.id, result })
      })
    } else {
      this.notifications.push(msg)
      this.opts.onNotification?.(msg)
      for (const w of this.waiters.slice()) {
        if (w.match(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          clearTimeout(w.timer)
          w.resolve(msg)
        }
      }
    }
  }

  send(msg) {
    if (this.exited) return
    this.record('->', msg)
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  /** Resolves with `result`; rejects with an Error carrying `.rpc` (the JSON-RPC error object). */
  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send(params === undefined ? { method, id } : { method, id, params })
    })
  }

  /** Like request(), but returns `{ result }` or `{ error }` instead of throwing. */
  async try(method, params, timeoutMs = 30_000) {
    let timer
    const timeout = new Promise((r) => (timer = setTimeout(() => r({ error: { code: 'timeout', message: `no response in ${timeoutMs} ms` } }), timeoutMs)))
    const call = this.request(method, params).then(
      (result) => ({ result }),
      (err) => ({ error: err.rpc ?? { message: String(err.message) } })
    )
    const out = await Promise.race([call, timeout])
    clearTimeout(timer)
    return out
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params })
  }

  /** Next notification matching `match` (a method name or a predicate). Null on timeout. */
  waitFor(match, timeoutMs = 30_000) {
    const fn = typeof match === 'string' ? (m) => m.method === match : match
    return new Promise((resolve) => {
      const w = { match: fn, resolve, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        resolve(null)
      }, timeoutMs) }
      this.waiters.push(w)
    })
  }

  async initialize(extraCapabilities = {}) {
    const result = await this.request('initialize', {
      clientInfo: { name: 'agent_office_spike', title: 'Agent Office (spike)', version: '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false, ...extraCapabilities }
    })
    this.notify('initialized')
    return result
  }

  /** Kills the process tree we started (and nothing else). */
  async stop() {
    if (!this.exited) {
      try {
        this.child.stdin.end()
      } catch {
        // already closed
      }
      await new Promise((r) => setTimeout(r, 800))
    }
    if (!this.exited) {
      this.record('--', { kill: this.child.pid })
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(this.child.pid)], { stdio: 'ignore', windowsHide: true })
        else this.child.kill('SIGKILL')
      } catch {
        // already gone
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => this.log.end(r))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = { CodexRpc, findCodexExecutable, scrubbedEnv, sleep }
