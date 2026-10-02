// End-to-end check of the agent inspector (shared/inspector.ts) against the real `claude` CLI:
// session manager + Claude driver + real pty host + ingest server + the stats registry + the
// transcript reader + the real IPC (a hidden window with the app's preload calls
// `window.agentOffice.inspector.watch`). ONE short session on the cheapest model, at most 3 turns.
//
//   npx electron-vite build            (the pty host and the preload are taken from out/)
//   npx electron scripts/e2e-inspector.cjs
//
// What it does: starts a session in a scratch folder (accepting the folder-trust dialog by
// keystroke and allowing whatever the session asks for in that scratch folder, which only this TEST
// does), asks for one subagent and one new file, and checks what the inspector says about the
// manager and the worker: task, tokens read from the real transcripts, counts, the worker with its
// description, the changed file, and the push timing. It runs with its own userData and port, reads
// transcripts under ~/.claude/projects (never writes there), and only kills processes it started.
'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'agent-office-e2e-inspector')
const WORK = path.join(ROOT, 'ws')
const USER_DATA = path.join(ROOT, 'userData')
const BUNDLE_DIR = path.join(REPO, 'out', 'e2e') // inside the repo so `ws`, node-pty etc. resolve
const PTY_HOST = path.join(REPO, 'out', 'main', 'ptyHost.js')
const PRELOAD = path.join(REPO, 'out', 'preload', 'index.cjs')
const HOOK = path.join(REPO, 'hook', 'claude-session-start.cjs')
const MAX_TURNS = 3

fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
for (const name of ['alpha.txt', 'beta.txt']) fs.writeFileSync(path.join(WORK, name), `${name}\n`)
fs.rmSync(path.join(WORK, 'hello.txt'), { force: true })
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
    export { ClaudeHookObserver } from './electron/adapters/claudeInspect.ts'
    export { startIngestServer } from './electron/ingest/server.ts'
    export { SessionTokens } from './electron/ingest/auth.ts'
    export { SessionInbox } from './electron/sessionInbox.ts'
    export { PtyHostClient } from './electron/ptyClient.ts'
    export { AgentStats } from './electron/agentStats.ts'
    export { ClaudeTranscripts } from './electron/transcriptUsage.ts'
    export { registerSessionIpc } from './electron/sessionsIpc.ts'
  `
  const outfile = path.join(BUNDLE_DIR, 'inspector-stack.mjs')
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

/** What the panel needs of an AgentDetails, on one line. */
const brief = (d) =>
  d
    ? JSON.stringify({
        role: d.role, state: d.state, activity: d.activity, detail: d.detail, task: d.task, agentType: d.agentType, model: d.model, turns: d.turns,
        activeMs: d.activeMs, tokens: d.tokens, counts: d.counts, files: d.files.map((f) => `${f.path}:${f.kind}`),
        workers: (d.workers || []).map((w) => `${w.agentType}|${w.task}|${w.activity}|done=${w.done}`), recent: d.recent.length, waitingOn: d.waitingOn && d.waitingOn.question
      })
    : 'null'

async function main() {
  if (!fs.existsSync(PTY_HOST) || !fs.existsSync(PRELOAD)) throw new Error('out/main/ptyHost.js or out/preload/index.cjs is missing: run `npx electron-vite build` first')
  const stack = await bundle()
  const port = await freePort()
  const globalToken = crypto.randomBytes(32).toString('hex')
  const tokens = new stack.SessionTokens()
  const inbox = new stack.SessionInbox()

  const hooks = [] // { t, name, tool, body }
  let permissions = []
  let server = null
  let inspectorWatch = null
  let id = ''
  let manager = null

  // As in main.ts: the stats see every world event and what the drivers know; the transcripts are
  // read (debounced) when a hook says there is news.
  const stats = new stack.AgentStats({ onChange: () => inspectorWatch && inspectorWatch.poke() })
  const transcripts = new stack.ClaudeTranscripts({ onUsage: (agentId, usage, model) => { log(`USAGE ${agentId === id ? 'manager' : agentId} ${JSON.stringify(usage)} ${model || ''}`); stats.fact({ kind: 'tokens', agentId, usage, model }) } })
  const sink = { emit: (e) => { stats.event(e); log(`WORLD ${e.agentId === id ? 'manager' : e.agentId} ${e.activity} ${JSON.stringify(e.detail)}`) } }

  const host = new stack.PtyHostClient(PTY_HOST, (tid, data) => manager.terminalData(tid, data))
  shutdownAll = async () => {
    transcripts.close()
    await host.shutdown()
    if (server) await server.close()
  }
  manager = new stack.SessionManager({
    pty: host,
    sink,
    providers: [
      stack.claudeProvider({
        sessionsDir: path.join(USER_DATA, 'sessions'),
        hookScript: HOOK,
        inbox,
        transcripts,
        ingest: { baseUrl: () => (server ? `http://127.0.0.1:${port}` : null), tokens }
      })
    ],
    allowOrders: () => false,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: (list) => { permissions = list },
    onTerminalData: () => {},
    stats
  })

  const inner = stack.createClaudeCodeHooksAdapter(manager, (rootId) => new stack.ClaudeHookObserver({ rootId, emit: (f) => stats.fact(f), transcripts, managerTask: true }))
  const adapter = {
    route: inner.route,
    maxBody: inner.maxBody,
    handle(body, s, ctx) {
      const name = body && body.hook_event_name
      hooks.push({ t: Date.now(), name, tool: body && body.tool_name, body: { ...body, _ao: undefined } })
      log(`HOOK ${name} ${[body && body.tool_name, body && body.agent_id && `agent=${body.agent_id} type=${body.agent_type}`].filter(Boolean).join(' ')}`)
      return inner.handle(body, s, ctx)
    }
  }
  server = await stack.startIngestServer({ port, getToken: () => globalToken, sink, sessionTokens: tokens, claudeHooks: adapter })

  // The renderer's side of the IPC: a hidden window with the app's own preload and an empty page.
  const page = path.join(ROOT, 'blank.html')
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>inspector e2e</title>')
  const win = new BrowserWindow({ show: false, width: 300, height: 200, webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  inspectorWatch = stack.registerSessionIpc({ manager, getWindow: () => win }).inspector
  await win.loadFile(page)
  const js = (code) => win.webContents.executeJavaScript(code, true)
  check('preload exposes inspector.watch / unwatch / onChanged', await js(`['watch','unwatch','onChanged'].every((k) => typeof window.agentOffice.inspector[k] === 'function')`))
  await js(`window.__pushes = []; window.agentOffice.inspector.onChanged((d) => window.__pushes.push({ at: Date.now(), d })); true`)
  const watch = (agentId) => js(`window.agentOffice.inspector.watch(${JSON.stringify(agentId)})`)
  const pushes = () => js('window.__pushes')

  const hookSince = (name, since, pred = () => true) => hooks.find((h) => h.t >= since && h.name === name && pred(h))
  const state = () => (manager.list().find((s) => s.id === id) || {}).state
  const screen = async () => ((await host.snapshot(id, false)) || { text: '' }).text
  const typePrompt = async (text) => {
    manager.write(id, `\x1b[200~${text}\x1b[201~`)
    await sleep(200)
    manager.write(id, '\r')
  }
  // TEST ONLY: the two things the prompt asks for (the helper agent, hello.txt in the scratch folder)
  // are answered as the user would in the inbox. Anything else stays pending and fails the run.
  const seen = new Set()
  const allower = setInterval(() => {
    for (const p of permissions.slice()) {
      const expected = p.toolName === 'Agent' || p.toolName === 'Task' || (p.toolName === 'Write' && /hello\.txt/.test(p.summary))
      if (!seen.has(p.id)) log(`PERMISSION ${p.toolName}: "${p.question}" -> ${expected ? 'allowed by the test (expected)' : 'NOT expected: left pending'}`)
      seen.add(p.id)
      if (!expected) continue
      try { manager.decide(p.id, { behavior: 'allow' }) } catch { /* already resolved */ }
    }
  }, 300)

  // ---------------------------------------------------------------- start
  const info = await manager.start({ provider: 'claude-code', cwd: WORK, permissionMode: 'acceptEdits', model: 'haiku' })
  id = info.id
  log(`started session ${id} (model haiku, acceptEdits) in ${WORK}`)
  let trusted = false
  const ready = await until(async () => {
    if (state() === 'idle') return true
    if (state() === 'exited') return 'exited'
    const sc = await screen()
    if (!trusted && /Is this a project you|trust this folder|Do you trust/i.test(sc)) {
      log('TEST ONLY: accepting folder trust with Down + Enter')
      await sleep(1500)
      manager.write(id, '\x1b[B')
      await sleep(500)
      manager.write(id, '\r')
      trusted = true
      await sleep(1000)
    }
    return false
  }, 'session ready', 60000)
  if (ready !== true) throw new Error(`session did not become ready (state=${state()})\n${await screen()}`)

  // ---------------------------------------------------------------- watch the manager over real IPC
  const first = await watch(id)
  log(`watch(manager) -> ${brief(first)}`)
  check('inspector.watch(manager) answers before any prompt', first && first.role === 'manager' && first.sessionId === id && first.state === 'idle' && first.turns === 0 && first.cwd === WORK)
  check('unknown agent -> null; a bad id is refused', (await watch('no-such-agent')) === null && (await js(`window.agentOffice.inspector.watch(42).then(() => 'ok', (e) => String(e))`)).includes('invalid agent id'))
  await watch(id) // the last watch counts: back to the manager

  // ---------------------------------------------------------------- turn 1: one subagent, one new file
  const PROMPT = 'Do two things. First use the Agent tool exactly once, with subagent_type "Explore" and description "List the files", to list the file names in this folder. Then create a file named hello.txt whose content is the single line: hi. When both are done reply with one word: done.'
  let turns = 1
  let t = Date.now()
  await typePrompt(PROMPT)
  check('UserPromptSubmit', await until(() => hookSince('UserPromptSubmit', t), 'prompt', 20000))
  const subStart = await until(() => hookSince('SubagentStart', t), 'SubagentStart', 120000)
  check('a subagent started', !!subStart, subStart ? `agent_type=${subStart.body.agent_type}` : '')
  const helloFile = path.join(WORK, 'hello.txt')
  const settled = () => state() === 'idle' && manager.inspect(id) && manager.inspect(id).workers.length > 0 && manager.inspect(id).workers.every((w) => w.done)
  await until(() => settled() && fs.existsSync(helloFile), 'the subagent done, hello.txt written, the session idle', 180000)
  if (!fs.existsSync(helloFile) && turns < MAX_TURNS) {
    await until(() => state() === 'idle', 'idle', 60000)
    turns++
    t = Date.now()
    await typePrompt('Create a file named hello.txt whose content is the single line: hi. Then reply with one word: done.')
    await until(() => fs.existsSync(helloFile) && state() === 'idle', 'hello.txt', 120000)
  }
  check('hello.txt exists', fs.existsSync(helloFile))
  await until(() => state() === 'idle', 'idle', 60000)
  // The transcript reads are debounced by 2 s after the last hooks.
  await until(() => { const d = manager.inspect(id); return d && d.tokens && d.tokens.total > 0 }, 'manager tokens', 10000)
  await sleep(2500)

  // ---------------------------------------------------------------- what the inspector says
  const m = await watch(id)
  log(`watch(manager) -> ${brief(m)}`)
  check('manager: task is a one-line preview of the prompt', m && typeof m.task === 'string' && m.task.startsWith('Do two things. First use the Agent tool') && m.task.length <= 160, m && m.task)
  check('manager: tokens > 0, read from the real transcript', m && m.tokens && m.tokens.total > 0 && m.tokens.output > 0 && m.tokens.contextUsed > 0, m && JSON.stringify(m.tokens))
  check('manager: counts and a recent log', m && Object.keys(m.counts).length >= 2 && (m.counts.exec || 0) >= 1 && m.recent.length >= 3, m && JSON.stringify(m.counts))
  check('manager: the worker is listed with its type and description', m && m.workers.length >= 1 && m.workers.some((w) => w.agentType === 'Explore' && w.task === 'List the files' && w.done), m && JSON.stringify(m.workers))
  check('manager: hello.txt is among the changed files (relative to the folder)', m && m.files.some((f) => f.path === 'hello.txt'), m && JSON.stringify(m.files))
  check('manager: turns, model, working time, state', m && m.turns === turns && /haiku/.test(m.model || '') && m.activeMs > 1000 && m.state === 'idle', m && `${m.turns} ${m.model} ${m.activeMs} ms ${m.state}`)

  const workerId = m && m.workers[0] && m.workers[0].agentId
  const w = workerId ? await watch(workerId) : null
  log(`watch(worker) -> ${brief(w)}`)
  check('worker: role, parent, type, task', w && w.role === 'worker' && w.parentId === id && w.sessionId === id && w.agentType === 'Explore' && w.task === 'List the files')
  check('worker: tokens > 0, read from its own transcript under <session>/subagents/', w && w.tokens && w.tokens.total > 0, w && JSON.stringify(w.tokens))
  check('worker: counts, done', w && Object.keys(w.counts).length >= 2 && w.state === 'done' && w.activeMs > 0, w && `${JSON.stringify(w.counts)} ${w.activeMs} ms`)

  // ---------------------------------------------------------------- pushes while it worked
  const got = await pushes()
  const gaps = got.slice(1).map((p, i) => p.at - got[i].at)
  log(`pushes: ${got.length}; smallest gap ${gaps.length ? Math.min(...gaps) : '-'} ms; activities seen: ${[...new Set(got.map((p) => p.d.activity))].join(', ')}`)
  check('pushes arrived for the watched manager while it worked', got.length >= 3 && got.every((p) => p.d.agentId === id))
  check('pushes are throttled to about one per second', gaps.length > 0 && Math.min(...gaps) >= 900, gaps.length ? `min ${Math.min(...gaps)} ms` : '')
  await js('window.agentOffice.inspector.unwatch(); window.__pushes.length = 0; true')
  await sleep(2500)
  check('nothing is pushed after unwatch (and an idle agent pushes nothing anyway)', (await pushes()).length === 0)

  // ---------------------------------------------------------------- stop
  clearInterval(allower)
  await manager.stop(id)
  check('state exited', state() === 'exited')
  const end = manager.inspect(id)
  check('after the session ended the inspector still answers (done)', end && end.activity === 'done' && end.state === 'exited' && end.tokens && end.tokens.total > 0)
  log(`hook sequence: ${hooks.map((h) => (h.tool ? `${h.name}(${h.tool})` : h.name)).join(' > ')}`)
  log(`turns used: ${turns}`)
  win.destroy()
  manager.close()
}

const guard = setTimeout(() => {
  log('GLOBAL TIMEOUT')
  void shutdownAll().finally(() => app.exit(2))
}, 8 * 60 * 1000)

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
