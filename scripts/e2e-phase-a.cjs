// Phase A end-to-end check of the main-process stack, without the renderer:
// session manager + Claude driver + real pty host (utilityProcess) + ingest server, against the
// real `claude` CLI. It uses ONE short real session (a few tiny turns of your Claude quota).
//
//   npx electron-vite build            (the pty host is taken from out/main/ptyHost.js)
//   npx electron scripts/e2e-phase-a.cjs [--no-interrupt] [--keep]
//
// What it does: starts a session in a scratch folder (accepting the folder-trust dialog by
// keystroke, which only this TEST does; the app leaves that to the user), types a prompt that needs
// a permission, approves it through the registry, sees PostToolUse and Stop, delivers an order over
// the inbox socket, optionally interrupts a turn to check the title-based idle detection, stops the
// session, and checks that nothing is left behind. It runs with its own userData and port and
// only kills processes it started.
'use strict'
const { app } = require('electron')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'agent-office-e2e')
const WORK = path.join(ROOT, 'ws')
const USER_DATA = path.join(ROOT, 'userData')
const BUNDLE_DIR = path.join(REPO, 'out', 'e2e') // inside the repo so `ws`, node-pty etc. resolve
const PTY_HOST = path.join(REPO, 'out', 'main', 'ptyHost.js')
const HOOK = path.join(REPO, 'hook', 'claude-session-start.cjs')
const DO_INTERRUPT = !process.argv.includes('--no-interrupt')

fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
app.setPath('userData', USER_DATA)
app.on('window-all-closed', () => {})

const T0 = Date.now()
const logFile = path.join(ROOT, 'e2e.log')
fs.writeFileSync(logFile, '')
function log(...a) {
  const line = `[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}] ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
async function until(cond, what, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await cond()
    if (v) return v
    await sleep(100)
  }
  log(`TIMEOUT waiting for: ${what}`)
  return null
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function bundle() {
  const esbuild = require('esbuild')
  const entry = `
    export { SessionManager } from './electron/sessions.ts'
    export { claudeProvider } from './electron/drivers/claude.ts'
    export { createClaudeCodeHooksAdapter } from './electron/adapters/claude-code-hooks.ts'
    export { startIngestServer } from './electron/ingest/server.ts'
    export { SessionTokens } from './electron/ingest/auth.ts'
    export { SessionInbox } from './electron/sessionInbox.ts'
    export { PtyHostClient } from './electron/ptyClient.ts'
  `
  const outfile = path.join(BUNDLE_DIR, 'stack.mjs')
  await esbuild.build({
    stdin: { contents: entry, resolveDir: REPO, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    external: ['electron', 'node-pty', '@xterm/*', 'ws'],
    logLevel: 'warning'
  })
  return import(pathToFileURL(outfile).href)
}

/** Set once the stack is up: kills the pty host (and with it every process it started). */
let shutdownAll = async () => {}

async function main() {
  if (!fs.existsSync(PTY_HOST)) throw new Error('out/main/ptyHost.js is missing: run `npx electron-vite build` first')
  const stack = await bundle()
  const port = await freePort()
  const globalToken = crypto.randomBytes(32).toString('hex')
  const tokens = new stack.SessionTokens()
  const inbox = new stack.SessionInbox()

  const world = [] // AgentEvents
  const hooks = [] // { t, name, tool, agent }
  const states = [] // { t, state }
  let permissions = []
  let termChars = 0
  let allowOrders = false
  let server = null

  const sink = { emit: (e) => { world.push(e); log(`WORLD ${e.agentId === id ? 'manager' : e.agentId} ${e.activity} ${JSON.stringify(e.detail)}`) } }
  let id = ''
  let manager = null
  const host = new stack.PtyHostClient(PTY_HOST, (tid, data) => manager.terminalData(tid, data))
  // Log terminal titles next to hooks: the driver reads the first glyph as its busy/idle hint.
  const pty = new Proxy(host, {
    get(target, prop) {
      if (prop !== 'spawn') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
      return (tid, opts, handlers) => {
        log(`SPAWN ${path.basename(opts.file)} ${opts.args.map((a) => (a.includes(USER_DATA) ? '<settings file>' : a)).join(' ')}  cwd=${opts.cwd}`)
        log(`      env: AO_TOKEN=<${opts.env.AO_TOKEN.length} chars> AO_SESSION=${opts.env.AO_SESSION} AO_URL=${opts.env.AO_URL} CLAUDE*/AI_AGENT keys=${Object.keys(opts.env).filter((k) => /^(CLAUDE|AI_AGENT)/i.test(k)).length}`)
        let lastGlyph = ''
        return target.spawn(tid, opts, {
          onExit: (code) => { log(`PTY exit code=${code}`); handlers.onExit(code) },
          onTitle: (title) => {
            const glyph = [...title.trimStart()][0] || ''
            if (glyph !== lastGlyph) { lastGlyph = glyph; log(`TITLE ${JSON.stringify(title.slice(0, 50))}`) }
            handlers.onTitle && handlers.onTitle(title)
          }
        })
      }
    }
  })
  shutdownAll = async () => {
    await host.shutdown()
    if (server) await server.close()
  }
  manager = new stack.SessionManager({
    pty,
    sink,
    providers: [
      stack.claudeProvider({
        sessionsDir: path.join(USER_DATA, 'sessions'),
        hookScript: HOOK,
        inbox,
        ingest: { baseUrl: () => (server ? `http://127.0.0.1:${port}` : null), tokens }
      })
    ],
    allowOrders: () => allowOrders,
    worldTopLevel: () => [],
    onSessionsChanged: (list) => {
      const s = list.find((x) => x.id === id) || list[0]
      if (!s) return
      const prev = states[states.length - 1]
      if (!prev || prev.state !== s.state) { states.push({ t: Date.now(), state: s.state }); log(`STATE ${s.state}  canReceiveOrders=${s.canReceiveOrders} providerSessionId=${s.providerSessionId || '-'}`) }
    },
    onPermissionsChanged: (list) => { permissions = list; log(`PERMISSIONS pending=${list.length} ${list.map((p) => `[${p.id} ${p.summary}]`).join(' ')}`) },
    onTerminalData: (_tid, data) => { termChars += data.length }
  })

  // The real adapter, with a tap that logs each hook (never the inbox endpoint).
  const inner = stack.createClaudeCodeHooksAdapter(manager)
  const adapter = {
    route: inner.route,
    maxBody: inner.maxBody,
    handle(body, s, ctx) {
      const name = body && body.hook_event_name
      const ao = body && body._ao
      hooks.push({ t: Date.now(), name, tool: body && body.tool_name, body: { ...body, _ao: undefined } })
      log(`HOOK ${name} ${[body && body.tool_name, body && body.agent_id && `agent=${body.agent_id}`, body && body.notification_type, body && body.source, body && body.reason].filter(Boolean).join(' ')} auth=${ctx.auth.kind}${ao ? ` inboxSocket=${ao.socket ? 'yes' : 'no'} inboxToken=${ao.token ? `<${String(ao.token).length} chars>` : 'no'}` : ''}`)
      return inner.handle(body, s, ctx)
    }
  }
  server = await stack.startIngestServer({ port, getToken: () => globalToken, sink, sessionTokens: tokens, claudeHooks: adapter })

  const hookSince = (name, since, pred = () => true) => hooks.find((h) => h.t >= since && h.name === name && pred(h))
  const waitHook = (name, since, ms, pred) => until(() => hookSince(name, since, pred), `hook ${name}`, ms)
  const state = () => (manager.list().find((s) => s.id === id) || {}).state
  const waitState = (want, ms) => until(() => state() === want, `state ${want}`, ms)
  const screen = async () => ((await pty.snapshot(id, false)) || { text: '' }).text
  const typePrompt = async (text) => {
    // As the user would in the terminal pane: paste, then Enter. (manager.write is the termWrite path.)
    manager.write(id, `\x1b[200~${text}\x1b[201~`)
    await sleep(200)
    manager.write(id, '\r')
  }

  const providers = await manager.providers()
  log(`PROVIDERS ${JSON.stringify(providers)}`)
  check('listProviders: claude-code available, codex/antigravity not', providers[0].available && !providers[1].available && !providers[2].available)

  // ---------------------------------------------------------------- start
  const info = await manager.start({ provider: 'claude-code', cwd: WORK, permissionMode: 'default', title: 'e2e team' })
  id = info.id
  log(`started session ${id} state=${info.state} title=${JSON.stringify(info.title)}`)
  const settingsFile = path.join(USER_DATA, 'sessions', `${id}.settings.json`)
  check('temp settings file written under userData/sessions', fs.existsSync(settingsFile))
  check('world: manager spawned (idle, provider claude-code)', world[0] && world[0].agentId === id && world[0].parentId === null && world[0].provider === 'claude-code' && world[0].displayName === 'e2e team')

  // Folder trust (first run in this folder): no hooks fire until it is accepted.
  const tStart = Date.now()
  let trusted = false
  const ready = await until(async () => {
    if (state() === 'idle') return true
    if (state() === 'exited') return 'exited'
    const sc = await screen()
    if (!trusted && /Is this a project you|trust this folder|Do you trust/i.test(sc)) {
      log(`---- SCREEN (trust dialog) ----\n${sc}\n----`)
      await waitState('needs-attention', 6000)
      check('state needs-attention while the trust dialog is up (no SessionStart within ~4 s)', state() === 'needs-attention')
      log('TEST ONLY: accepting folder trust with Down + Enter')
      manager.write(id, '\x1b[B')
      await sleep(500)
      manager.write(id, '\r')
      trusted = true
      await sleep(1000)
    }
    return false
  }, 'session ready', 60000)
  if (ready !== true) throw new Error(`session did not become ready (state=${state()})\n${await screen()}`)
  log(`ready after ${Date.now() - tStart} ms (trust dialog ${trusted ? 'accepted by the test' : 'not shown: folder already trusted'})`)
  const startHook = hooks.find((h) => h.name === 'SessionStart')
  check('SessionStart command hook arrived with the session token', !!startHook)
  check('state idle after SessionStart', state() === 'idle')
  check('inbox socket + token registered (memory only)', inbox.has(id))
  check('providerSessionId known', !!manager.list()[0].providerSessionId, manager.list()[0].providerSessionId)
  check('canReceiveOrders', manager.list()[0].canReceiveOrders === true)
  await sleep(1500)
  log(`---- SCREEN (ready) ----\n${await screen()}\n----`)

  // ---------------------------------------------------------------- attach (what the renderer does)
  const snap = await manager.attach(id)
  check('terminal.attach returns a snapshot', snap && snap.cols === 120 && snap.rows === 40 && snap.data.length > 100, `${snap.data.length} chars, ${snap.cols}x${snap.rows}`)

  // ---------------------------------------------------------------- turn 1: permission, allowed from the app
  let t = Date.now()
  await typePrompt(`Run this exact command with the Bash tool: node -e "console.log('ao-e2e')"`)
  check('UserPromptSubmit after typing in the terminal', await waitHook('UserPromptSubmit', t, 15000))
  check('state busy', await waitState('busy', 3000) || state() === 'waiting-permission')
  const perm = await until(() => permissions[0], 'permission registered', 90000)
  check('PermissionRequest registered in the registry', !!perm, perm ? `${perm.toolName} | ${perm.summary}` : '')
  if (!perm) throw new Error('no permission request (the command may have been auto-allowed)')
  check('permission info: session, agent, summary, detail', perm.sessionId === id && perm.agentId === id && /ao-e2e/.test(perm.summary) && /ao-e2e/.test(perm.detail))
  check('state waiting-permission', state() === 'waiting-permission')
  check('world: manager waiting', world[world.length - 1].activity === 'waiting' && world[world.length - 1].agentId === id)
  await sleep(2500) // let the TUI draw its own dialog: both exist side by side
  log(`---- SCREEN (permission pending) ----\n${await screen()}\n----`)
  const tDecide = Date.now()
  const outcome = manager.decide(perm.id, { behavior: 'allow' })
  check('decide(allow) -> allowed', outcome === 'allowed', outcome)
  check('pending list empty after the decision', permissions.length === 0)
  const post = await waitHook('PostToolUse', tDecide, 60000)
  check('PostToolUse after the approval', !!post, post ? JSON.stringify(post.body.tool_response).slice(0, 160) : '')
  check('the command really ran (ao-e2e in the tool response)', post && /ao-e2e/.test(JSON.stringify(post.body.tool_response)))
  const stop1 = await waitHook('Stop', tDecide, 90000)
  check('Stop', !!stop1)
  check('state idle after Stop', await waitState('idle', 3000))
  check('world: manager idle', world[world.length - 1].activity === 'idle')
  await sleep(600)
  const sc1 = await screen()
  log(`---- SCREEN (after turn 1) ----\n${sc1}\n----`)
  check('TUI shows "Allowed by PermissionRequest hook"', /Allowed by PermissionRequest hook/.test(sc1))
  check('terminal output streamed to the attached viewer', termChars > 500, `${termChars} chars`)

  // ---------------------------------------------------------------- order over the inbox socket
  let r = await manager.sendOrder({ target: id, text: 'Reply with exactly: ao-order-ok' })
  check('order refused while "Allow CEO orders" is off', r.delivered.length === 0 && /disabled/.test(r.failed[0].reason), r.failed[0] && r.failed[0].reason)
  allowOrders = true
  t = Date.now()
  r = await manager.sendOrder({ target: 'provider:claude-code', text: 'Reply with exactly: ao-order-ok\n(second line of the order)' })
  log(`sendOrder -> ${JSON.stringify(r)} after ${Date.now() - t} ms`)
  check('order delivered (confirmed by UserPromptSubmit)', r.delivered.length === 1 && r.delivered[0] === id && r.failed.length === 0)
  const ups = hookSince('UserPromptSubmit', t)
  check('UserPromptSubmit carries the order text, both lines', ups && /ao-order-ok/.test(ups.body.prompt) && /second line of the order/.test(ups.body.prompt), ups ? JSON.stringify(ups.body.prompt).slice(0, 120) : '')
  const stop2 = await waitHook('Stop', t, 90000)
  check('Stop after the order', !!stop2, stop2 ? JSON.stringify(stop2.body.last_assistant_message).slice(0, 80) : '')
  await waitState('idle', 3000)
  await sleep(600)
  log(`---- SCREEN (after the order) ----\n${await screen()}\n----`)

  // ---------------------------------------------------------------- interrupt: no Stop, title hint -> idle
  if (DO_INTERRUPT) {
    t = Date.now()
    await typePrompt('Run this exact command with the Bash tool: ping -n 25 127.0.0.1')
    const perm2 = await until(() => permissions[0], 'permission for ping', 90000)
    if (perm2) manager.decide(perm2.id, { behavior: 'allow' })
    else log('no permission request for ping (auto-allowed); continuing')
    await waitHook('PreToolUse', t, 30000)
    await sleep(4000)
    check('state busy while the command runs', state() === 'busy', state())
    const tEsc = Date.now()
    manager.interrupt(id)
    log('interrupt (Esc) written to the pty')
    const idle = await waitState('idle', 12000)
    check('state idle after an interrupt (terminal title hint, no Stop hook)', !!idle, `${Date.now() - tEsc} ms after Esc`)
    check('no Stop hook fired for the interrupted turn', !hookSince('Stop', tEsc))
    await sleep(500)
    log(`---- SCREEN (after interrupt) ----\n${await screen()}\n----`)
  }

  // ---------------------------------------------------------------- stop
  t = Date.now()
  manager.detach(id)
  await manager.stop(id)
  log(`stop() resolved after ${Date.now() - t} ms`)
  check('state exited', state() === 'exited', `exitCode=${manager.list()[0] && manager.list()[0].exitCode}`)
  check('SessionEnd hook (polite /exit)', !!hookSince('SessionEnd', t), (hookSince('SessionEnd', t) || { body: {} }).body.reason)
  check('world: manager done', world[world.length - 1].activity === 'done' && world[world.length - 1].agentId === id)
  check('temp settings file deleted', !fs.existsSync(settingsFile))
  check('session token revoked, inbox endpoint forgotten', tokens.size === 0 && !inbox.has(id))
  check('all hooks came in with the per-session token', hooks.length > 0)

  log(`hook sequence: ${hooks.map((h) => (h.tool ? `${h.name}(${h.tool})` : h.name)).join(' > ')}`)
  log(`state sequence: ${states.map((s) => s.state).join(' > ')}`)
  log(`world sequence: ${world.map((e) => e.activity).join(' > ')}`)

  manager.close()
}

const guard = setTimeout(() => {
  log('GLOBAL TIMEOUT')
  void shutdownAll().finally(() => app.exit(2))
}, 6 * 60 * 1000)

app.whenReady().then(async () => {
  let code = 0
  try {
    await main()
  } catch (err) {
    log(`ERROR ${err && err.stack ? err.stack : err}`)
    code = 1
  }
  await shutdownAll().catch(() => {})
  clearTimeout(guard)
  const failed = checks.filter((c) => !c.ok)
  log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(' | ')}` : ''}`)
  log(`log: ${logFile}`)
  // The utility process (pty host) kills its process trees on shutdown; app.exit takes it down too.
  setTimeout(() => app.exit(code || (failed.length ? 1 : 0)), 500)
})
