// End-to-end check of "remember where I left off" against the REAL agents, without the renderer:
// session manager + session store + Claude driver (real `claude` TUI in the pty host) + ingest
// server, and optionally the Codex driver (real `codex app-server`).
//
//   npx electron-vite build            (the pty host is taken from out/main/ptyHost.js)
//   npx electron scripts/e2e-restore.cjs [--codex] [--no-claude]
//
// It runs each "app run" in a CHILD Electron process on the same scratch userData, so the first one
// can be killed hard (taskkill /F /T: no quit, no flush) and the second one is a genuinely new
// process that only has `<userData>/sessions.json` to go by.
//
//   run 1  start a Claude session (`--model haiku`), ask for a command that needs permission,
//          leave the request pending, then: KILLED
//   run 2  the row is back asleep, with the plain question in its "was interrupted" note
//          a record whose conversation does not exist is woken -> what does `claude --resume` do?
//          restore mode 'last' wakes the selected session -> `claude --resume <id>`: which dialogs appear?
//          `continue` + Enter (the renderer's "Tell it to continue") -> a prompt is submitted and the turn runs in the resumed conversation; the note is gone
//          stop -> Recent -> reopen -> stop -> forget
//   run 3 / 4 (with --codex)  the same shape for one Codex thread
//
// Quota: 2 short Claude turns on haiku (the first is cut off at the permission request, the second finishes it), 2 short
// Codex turns at low effort. One session at a time. It uses its own userData and port, accepts the
// folder-trust dialog by keystroke (only this TEST does that), never writes to ~/.claude or
// ~/.codex, and only kills processes it started. The conversations stay in your Claude / Codex history.
'use strict'
const { app } = require('electron')
const { execFileSync, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'agent-office-e2e-restore')
// Always the same folder, so Claude Code's own folder-trust entry is written once.
const WORK = path.join(ROOT, 'work')
const USER_DATA = path.join(ROOT, 'userData')
const STORE_FILE = path.join(USER_DATA, 'sessions.json')
const BUNDLE_DIR = path.join(REPO, 'out', 'e2e') // inside the repo so `ws`, node-pty etc. resolve
const PTY_HOST = path.join(REPO, 'out', 'main', 'ptyHost.js')
const HOOK = path.join(REPO, 'hook', 'claude-session-start.cjs')
const LOG = path.join(ROOT, 'e2e.log')
const MARKER = path.join(ROOT, 'marker.json')
const RESULT = path.join(ROOT, 'result.json')
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) || '').slice(8)
const WITH_CODEX = process.argv.includes('--codex')
const WITH_CLAUDE = !process.argv.includes('--no-claude')
const COMMAND = `node -e "console.log('ao-restore')"`
const CODEX_COMMAND = `node -e "console.log('ao-restore-codex')"`

// Electron's own profile files: the parent keeps out of the scratch userData the runs share.
app.setPath('userData', PHASE ? USER_DATA : path.join(ROOT, 'parent'))
app.on('window-all-closed', () => {})

const T0 = Number(process.env.AO_E2E_T0 || Date.now())
function log(...a) {
  const line = `[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}]${PHASE ? ` run${PHASE}` : ''} ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(LOG, line + '\n')
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
const readStore = () => JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
const savedRecord = (id) => readStore().sessions.find((r) => r.id === id)

async function bundle() {
  const esbuild = require('esbuild')
  const entry = `
    export { SessionManager, CONVERSATION_GONE } from './electron/sessions.ts'
    export { SessionStore } from './electron/sessionStore.ts'
    export { claudeProvider } from './electron/drivers/claude.ts'
    export { codexProvider } from './electron/drivers/codex.ts'
    export { createClaudeCodeHooksAdapter } from './electron/adapters/claude-code-hooks.ts'
    export { startIngestServer } from './electron/ingest/server.ts'
    export { SessionTokens } from './electron/ingest/auth.ts'
    export { SessionInbox } from './electron/sessionInbox.ts'
    export { PtyHostClient } from './electron/ptyClient.ts'
  `
  const outfile = path.join(BUNDLE_DIR, 'stack-restore.mjs')
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
  return outfile
}

// ---- one "run of the app": store + manager + drivers on the scratch userData ---------------------------

async function appRun(mode) {
  const stack = await import(pathToFileURL(path.join(BUNDLE_DIR, 'stack-restore.mjs')).href)
  const port = await freePort()
  const globalToken = crypto.randomBytes(32).toString('hex')
  const tokens = new stack.SessionTokens()
  const inbox = new stack.SessionInbox()
  const r = { stack, hooks: [], permissions: [], spawns: [], secrets: [globalToken], manager: null, server: null, codex: null }
  const host = new stack.PtyHostClient(PTY_HOST, (tid, data) => r.manager.terminalData(tid, data))
  const pty = new Proxy(host, {
    get(target, prop) {
      if (prop !== 'spawn') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
      return (tid, opts, handlers) => {
        r.spawns.push({ id: tid, args: opts.args })
        r.secrets.push(opts.env.AO_TOKEN)
        log(`SPAWN ${path.basename(opts.file)} ${opts.args.map((a) => (a.includes(USER_DATA) ? `<${path.basename(a).replace(/^s-[0-9a-f]+\./, '')}>` : a)).join(' ')}`)
        return target.spawn(tid, opts, { onExit: (code) => { log(`PTY exit ${tid} code=${code}`); handlers.onExit(code) }, onTitle: handlers.onTitle })
      }
    }
  })
  r.pty = pty
  r.store = new stack.SessionStore({ file: STORE_FILE })
  const providers = [
    stack.claudeProvider({ sessionsDir: path.join(USER_DATA, 'sessions'), hookScript: HOOK, inbox, ingest: { baseUrl: () => (r.server ? `http://127.0.0.1:${port}` : null), tokens } })
  ]
  if (WITH_CODEX) {
    r.codex = stack.codexProvider({ openExternal: async () => {}, server: { clientVersion: '0.1.0-e2e' }, effort: 'low' })
    providers.push(r.codex)
  }
  let last = ''
  r.manager = new stack.SessionManager({
    pty,
    sink: { emit: () => {} },
    providers,
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: (list) => {
      const line = list.map((s) => `${s.id}:${s.state}${s.interruptedNote ? '+note' : ''}${s.notice ? '+notice' : ''}`).join(' ')
      if (line !== last) log(`SESSIONS ${line || '(none)'}`)
      last = line
    },
    onPermissionsChanged: (list) => { r.permissions = list; log(`PERMISSIONS pending=${list.length} ${list.map((p) => `[${p.toolName} | ${p.question}]`).join(' ')}`) },
    onTerminalData: () => {},
    onChatEvent: () => {},
    restore: { store: r.store, settings: () => ({ mode }) }
  })
  const inner = stack.createClaudeCodeHooksAdapter(r.manager)
  r.server = await stack.startIngestServer({
    port,
    getToken: () => globalToken,
    sink: { emit: () => {} },
    sessionTokens: tokens,
    claudeHooks: {
      route: inner.route,
      maxBody: inner.maxBody,
      handle(body, s, ctx) {
        const name = body && body.hook_event_name
        if (body && body._ao && body._ao.token) r.secrets.push(String(body._ao.token))
        r.hooks.push({ t: Date.now(), name, body: { ...body, _ao: undefined } })
        log(`HOOK ${name} ${[body && body.tool_name, body && body.source, body && body.session_id].filter(Boolean).join(' ')}`)
        return inner.handle(body, s, ctx)
      }
    }
  })
  r.row = (id) => r.manager.list().find((s) => s.id === id)
  r.state = (id) => (r.row(id) || {}).state
  r.screen = async (id) => ((await pty.snapshot(id, false)) || { text: '' }).text
  r.hookSince = (name, since) => r.hooks.find((h) => h.t >= since && h.name === name)
  r.typePrompt = async (id, text) => {
    r.manager.write(id, `\x1b[200~${text}\x1b[201~`)
    await sleep(200)
    r.manager.write(id, '\r')
  }
  /** Waits until the session takes input. Logs every dialog it meets; accepts folder trust (TEST ONLY). */
  r.ready = async (id, label) => {
    const seen = { trust: false, other: [] }
    let lastState = ''
    const done = await until(async () => {
      const st = r.state(id)
      if (st === 'idle') return 'idle'
      if (st === 'exited' || st === undefined) return 'exited'
      const sc = await r.screen(id)
      if (st !== lastState) {
        lastState = st
        if (st === 'needs-attention') log(`---- SCREEN (${label}: needs-attention) ----\n${sc.trimEnd()}\n----`)
      }
      if (!seen.trust && /Is this a project you|trust this folder|Do you trust/i.test(sc)) {
        seen.trust = true
        log(`---- SCREEN (${label}: folder-trust dialog) ----\n${sc.trimEnd()}\n----`)
        // The dialog defaults to "No, exit" (docs/spikes-phase-a.md): Down, then Enter.
        log('TEST ONLY: accepting folder trust with Down + Enter')
        await sleep(1200)
        r.manager.write(id, '\x1b[B')
        await sleep(500)
        r.manager.write(id, '\r')
        await sleep(1500)
      }
      return false
    }, `${label}: session ready`, 90000)
    return { done, seen }
  }
  r.shutdown = async () => {
    r.manager.close()
    await Promise.allSettled([host.shutdown(), r.manager.shutdown()])
    await r.server.close().catch(() => {})
  }
  return r
}

// ---- run 1: a Claude session with a pending permission request, then nothing (the parent kills us) ----

async function run1() {
  const r = await appRun('none')
  const info = await r.manager.start({ provider: 'claude-code', cwd: WORK, permissionMode: 'default', model: 'haiku', title: 'Restore e2e' })
  const id = info.id
  log(`started ${id}`)
  const ready = await r.ready(id, 'first start')
  if (ready.done !== 'idle') throw new Error(`the session did not become ready (${ready.done})\n${await r.screen(id)}`)
  log(`first start: folder-trust dialog ${ready.seen.trust ? 'shown (accepted by the test)' : 'not shown (folder already trusted)'}`)
  r.manager.setSelected(id)
  const conversation = r.row(id).providerSessionId
  check('run 1: the conversation id is known', !!conversation, conversation)
  const t = Date.now()
  await r.typePrompt(id, `Run this exact command with the Bash tool: ${COMMAND}`)
  const perm = await until(() => r.permissions[0], 'a permission request', 90000)
  if (!perm) throw new Error(`no permission request (was the command auto-allowed?)\n${await r.screen(id)}`)
  check('run 1: the permission request is pending', r.state(id) === 'waiting-permission', perm.question)
  await sleep(2500) // the store's debounce (500 ms) has long passed: the file is what a crash now leaves behind
  log(`---- SCREEN (permission pending) ----\n${(await r.screen(id)).trimEnd()}\n----`)
  const rec = savedRecord(id)
  log(`sessions.json: ${JSON.stringify(readStore())}`)
  check('run 1: the record on disk is open, interrupted, with the pending question', rec && rec.status === 'open' && rec.interrupted === true && rec.pendingAtClose.length === 1 && rec.pendingAtClose[0].question === perm.question)
  check('run 1: the record has the prompt preview and the conversation id', rec && /ao-restore/.test(rec.lastPrompt || '') && rec.providerSessionId === conversation, rec && rec.lastPrompt)
  const text = fs.readFileSync(STORE_FILE, 'utf8')
  check('run 1: no token in sessions.json (hook token, inbox token, global token)', r.secrets.length >= 3 && r.secrets.every((s) => s && !text.includes(s)), `${r.secrets.length} secrets checked`)
  check('run 1: no socket path in sessions.json', !/pipe|\.sock/i.test(text))
  fs.writeFileSync(MARKER, JSON.stringify({ id, conversation, question: perm.question, promptAt: t, checks }))
  log('run 1 is waiting to be killed')
  await new Promise(() => {}) // never: the parent kills this process tree hard
}

// ---- run 2: a new process on the same userData ------------------------------------------------------------

async function run2() {
  const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
  const { id, conversation, question } = marker
  // A record whose conversation does not exist (a made-up id), to see what `claude --resume` does with it.
  const missingId = 's-e2e00missing'
  const missingConversation = crypto.randomUUID()
  {
    const file = readStore()
    file.sessions = file.sessions.filter((s) => s.id !== missingId)
    file.sessions.push({ id: missingId, provider: 'claude-code', cwd: WORK, title: 'Missing', titleIsCustom: true, permissionMode: 'default', model: 'haiku', providerSessionId: missingConversation, startedAt: Date.now(), lastActiveAt: 1, interrupted: false, pendingAtClose: [], status: 'open' })
    fs.writeFileSync(STORE_FILE, JSON.stringify(file))
  }
  const r = await appRun('last')
  const row = r.row(id)
  log(`rows after launch: ${JSON.stringify(r.manager.list())}`)
  check('run 2: the row is back, asleep, with the same app id', row && row.state === 'asleep')
  check('run 2: no process was started', r.spawns.length === 0)
  check('run 2: wakeable, same title / folder / permission mode / conversation', row && row.wakeable === true && row.title === 'Restore e2e' && row.cwd === WORK && row.permissionMode === 'default' && row.providerSessionId === conversation)
  check('run 2: the "was interrupted" note lists the plain question', row && row.interruptedNote && row.interruptedNote.pending.length === 1 && row.interruptedNote.pending[0].question === question, question)
  check('run 2: the selection is remembered', r.manager.getSelected() === id)
  const order = await r.manager.sendOrder({ target: id, text: 'hello' })
  check('run 2: an order to the sleeping row is refused', order.delivered.length === 0 && order.failed[0] && order.failed[0].reason === 'asleep — wake it first', order.failed[0] && order.failed[0].reason)

  // ---- a conversation that does not exist ----
  await r.manager.wake(missingId)
  const gone = await until(async () => (r.state(missingId) === 'exited' ? true : (await sleep(400), false)), 'claude --resume <unknown id> to exit', 30000)
  log(`---- SCREEN (claude --resume ${missingConversation}, a conversation that does not exist) ----\n${(await r.screen(missingId)).trimEnd()}\n----`)
  if (!gone) {
    log('it did NOT exit by itself; stopping it')
    await r.manager.stop(missingId)
  }
  await until(() => r.row(missingId) && r.row(missingId).notice, 'the notice', 5000)
  check('run 2: a missing conversation ends the session with a clear notice', gone && r.row(missingId) && r.row(missingId).state === 'exited' && r.row(missingId).notice === r.stack.CONVERSATION_GONE, r.row(missingId) && r.row(missingId).notice)
  r.store.flush()
  check('run 2: ... and its record can never be woken again', savedRecord(missingId) && !savedRecord(missingId).providerSessionId)
  r.manager.forget(missingId)

  // ---- restore mode 'last': the selected session is woken ----
  const tWake = Date.now()
  await r.manager.restoreOnLaunch()
  const spawn = r.spawns.find((s) => s.id === id)
  check('run 2: mode "last" woke the selected session with --resume <saved conversation id>', spawn && spawn.args[spawn.args.indexOf('--resume') + 1] === conversation && r.spawns.filter((s) => s.id === id).length === 1)
  check('run 2: the usual flags are all there', spawn && ['--settings', '--permission-mode', '--append-system-prompt-file', '--model'].every((f) => spawn.args.includes(f)), spawn && spawn.args.filter((a) => a.startsWith('--')).join(' '))
  const ready = await r.ready(id, 'resume')
  log(`resume: ready=${ready.done} after ${Date.now() - tWake} ms; folder-trust dialog ${ready.seen.trust ? 'SHOWN' : 'not shown'}`)
  await sleep(1500)
  log(`---- SCREEN (after --resume, ready) ----\n${(await r.screen(id)).trimEnd()}\n----`)
  check('run 2: the resumed session is idle', ready.done === 'idle')
  const start = r.hooks.find((h) => h.name === 'SessionStart' && h.t >= tWake && h.body.source === 'resume') || r.hooks.filter((h) => h.name === 'SessionStart').pop()
  log(`SessionStart after the resume: source=${start && start.body.source} session_id=${start && start.body.session_id} (${start && start.body.session_id === conversation ? 'the SAME id' : 'a NEW id'})`)
  check('run 2: the note is still there after waking', !!(r.row(id) && r.row(id).interruptedNote))

  check('run 2: the row carries the saved prompt preview ("Your last prompt")', /ao-restore/.test((r.row(id) && r.row(id).lastPrompt) || ''), r.row(id) && r.row(id).lastPrompt)

  // ---- "Tell it to continue" (what the renderer's button does): `continue`, then Enter 150 ms later ----
  const t = Date.now()
  r.manager.write(id, 'continue')
  await sleep(150)
  r.manager.write(id, '\r')
  const submitted = await until(() => r.hookSince('UserPromptSubmit', t), 'UserPromptSubmit', 20000)
  check('run 2: `continue` + Enter after 150 ms submits a prompt (UserPromptSubmit)', submitted && submitted.body.prompt === 'continue', submitted && JSON.stringify(submitted.body.prompt))
  check('run 2: the note is gone on the first prompt after waking', r.row(id) && !r.row(id).interruptedNote)
  // It carries on where it was cut off: the same command, so the same question again. Allowed from the app this time.
  const again1 = await until(() => r.permissions[0] || r.hookSince('Stop', t), 'the session to carry on', 120000)
  const asked = r.permissions[0]
  log(`after "continue": ${asked ? `asked again: ${asked.question}` : `no new request; ${again1 ? 'the turn ended' : 'nothing happened'}`}`)
  if (asked) r.manager.decide(asked.id, { behavior: 'allow' })
  const stop = await until(() => r.hookSince('Stop', t), 'Stop', 120000)
  const ran = r.hooks.find((h) => h.t >= t && h.name === 'PostToolUse' && /ao-restore/.test(JSON.stringify(h.body.tool_response || '')))
  const answer = stop ? String(stop.body.last_assistant_message || '') : ''
  log(`answer: ${JSON.stringify(answer.slice(0, 300))}`)
  // What it does with "continue" is the model's call: Haiku was seen to ask "re-run the same command?" rather
  // than run it again. Either way the turn runs in the resumed conversation and knows the interrupted command.
  check('run 2: the session carried on in the resumed conversation (it knows the interrupted command)', !!stop && ((!!asked && asked.question === question) || /ao-restore/.test(answer)), asked ? 'asked for the command again' : 'answered about the command')
  if (asked) check('run 2: ... and the command ran once it was allowed', !!ran)
  await sleep(1200)
  log(`---- SCREEN (after "continue") ----\n${(await r.screen(id)).trimEnd()}\n----`)
  r.store.flush()
  const rec = savedRecord(id)
  check('run 2: the record is open, not interrupted, nothing pending', rec && rec.status === 'open' && rec.interrupted === false && rec.pendingAtClose.length === 0, rec && rec.providerSessionId)

  // ---- stop -> Recent -> reopen -> stop -> forget ----
  await r.manager.stop(id)
  check('run 2: stopped -> in Recent', r.manager.recent().some((x) => x.id === id) && r.state(id) === 'exited')
  const again = await r.manager.reopen(id)
  const reReady = await r.ready(id, 'reopen')
  check('run 2: reopened from Recent under the same id', again.id === id && reReady.done === 'idle' && !r.manager.recent().some((x) => x.id === id))
  await r.manager.stop(id)
  r.manager.forget(id)
  r.store.flush()
  check('run 2: forgotten: no row, no record', !r.row(id) && !savedRecord(id))
  await r.shutdown()
}

// ---- runs 3 and 4: the same shape for one Codex thread ----------------------------------------------------

async function run3() {
  const r = await appRun('none')
  const info = await r.manager.start({ provider: 'codex', cwd: WORK, permissionMode: 'default', title: 'Restore e2e (Codex)' })
  const id = info.id
  log(`started ${id} thread=${info.providerSessionId} state=${info.state}`)
  r.manager.setSelected(id)
  await r.manager.chatSend(id, `Run this exact command: ${CODEX_COMMAND}`)
  const perm = await until(() => r.permissions[0], 'an approval request', 120000)
  if (!perm) throw new Error('no approval request')
  await sleep(2500)
  const rec = savedRecord(id)
  log(`sessions.json: ${JSON.stringify(readStore())}`)
  check('run 3: the Codex record on disk is open, interrupted, with the pending question', rec && rec.status === 'open' && rec.interrupted === true && rec.pendingAtClose.length === 1 && rec.pendingAtClose[0].question === perm.question, perm.question)
  fs.writeFileSync(MARKER, JSON.stringify({ id, conversation: info.providerSessionId, question: perm.question, checks }))
  log('run 3 is waiting to be killed')
  await new Promise(() => {})
}

async function run4() {
  const { id, conversation, question } = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
  const r = await appRun('last')
  const row = r.row(id)
  check('run 4: the Codex row is back asleep, wakeable, with the question in its note', row && row.state === 'asleep' && row.wakeable === true && row.surface === 'chat' && row.interruptedNote && row.interruptedNote.pending[0].question === question, question)
  await r.manager.restoreOnLaunch()
  check('run 4: woken (thread/resume), same thread', r.state(id) === 'idle' && r.row(id).providerSessionId === conversation, r.state(id))
  const items = r.manager.chatAttach(id)
  log(`chat after the resume: ${items.length} items: ${items.map((i) => i.kind).join(' ')}`)
  check('run 4: the earlier prompt is in the rebuilt chat', items.some((i) => i.kind === 'user' && /ao-restore-codex/.test(i.text)))
  await r.manager.chatSend(id, 'What was the last command you tried to run? Reply in one short line and do not run anything.')
  check('run 4: the note is gone on the first prompt', !r.row(id).interruptedNote)
  await until(() => r.state(id) === 'busy', 'busy', 10000)
  await until(() => r.state(id) === 'idle', 'the turn to end', 120000)
  const texts = r.manager.chatAttach(id).filter((i) => i.kind === 'assistant').map((i) => i.text)
  log(`answer: ${JSON.stringify((texts[texts.length - 1] || '').slice(0, 300))}`)
  check('run 4: the thread was resumed (it knows the command)', /ao-restore-codex/.test(texts[texts.length - 1] || ''))
  await r.manager.stop(id)
  r.manager.forget(id)
  await r.shutdown()
}

// ---- the parent: runs the phases, kills the first of each pair hard ----------------------------------------

function tree(rootPid) {
  // Every process below rootPid, as [{pid, name}]. PowerShell is the one tool that is always there.
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'], { encoding: 'utf8', windowsHide: true })
    const all = out.split(/\r?\n/).map((l) => l.split(',')).filter((p) => p.length >= 3).map(([pid, ppid, name]) => ({ pid: Number(pid), ppid: Number(ppid), name }))
    const found = []
    const walk = (pid) => {
      for (const p of all) if (p.ppid === pid && !found.some((f) => f.pid === p.pid)) { found.push(p); walk(p.pid) }
    }
    walk(rootPid)
    return found
  } catch (err) {
    log(`could not list the process tree: ${err.message}`)
    return []
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function child(phase) {
  const env = { ...process.env, AO_E2E_T0: String(T0) }
  const c = spawn(process.execPath, [__filename, `--phase=${phase}`, ...(WITH_CODEX ? ['--codex'] : [])], { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  return c
}

/** A run that ends by being killed: waits for its marker file, then kills the whole process tree. */
async function killedRun(phase) {
  fs.rmSync(MARKER, { force: true })
  const c = child(phase)
  let exited = null
  c.on('exit', (code) => (exited = code))
  const marker = await until(() => exited !== null || fs.existsSync(MARKER), `run ${phase} to reach its pending request`, 240000)
  if (!marker || exited !== null) {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore' }) } catch { /* already gone */ }
    throw new Error(`run ${phase} ended before it had a pending request (exit ${exited})`)
  }
  await sleep(300)
  const procs = tree(c.pid)
  log(`run ${phase}: process tree before the kill: ${procs.map((p) => `${p.name}(${p.pid})`).join(' ')}`)
  log(`KILLING run ${phase} hard: taskkill /F /T /PID ${c.pid} (no quit, no flush)`)
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore' }) } catch (err) { log(`taskkill: ${err.message}`) }
  await sleep(2500)
  const left = procs.filter((p) => alive(p.pid))
  check(`run ${phase}: nothing of the killed app is left running`, left.length === 0 && !alive(c.pid), left.map((p) => `${p.name}(${p.pid})`).join(' '))
  for (const p of left) try { process.kill(p.pid) } catch { /* gone */ }
  for (const k of JSON.parse(fs.readFileSync(MARKER, 'utf8')).checks) checks.push(k)
}

async function cleanRun(phase) {
  fs.rmSync(RESULT, { force: true })
  const c = child(phase)
  const code = await new Promise((resolve) => c.on('exit', resolve))
  if (fs.existsSync(RESULT)) for (const k of JSON.parse(fs.readFileSync(RESULT, 'utf8'))) checks.push(k)
  check(`run ${phase} finished`, code === 0, `exit ${code}`)
}

async function parent() {
  if (!fs.existsSync(PTY_HOST)) throw new Error('out/main/ptyHost.js is missing: run `npx electron-vite build` first')
  fs.mkdirSync(WORK, { recursive: true })
  fs.mkdirSync(USER_DATA, { recursive: true })
  // A fresh start: no saved sessions. (The folder itself may hold Electron's own files of an earlier run.)
  for (const name of ['sessions.json', 'sessions.json.bad', 'sessions']) fs.rmSync(path.join(USER_DATA, name), { recursive: true, force: true })
  fs.writeFileSync(LOG, '')
  log(`userData ${USER_DATA}`)
  log(`work     ${WORK}`)
  await bundle()
  if (WITH_CLAUDE) {
    await killedRun(1)
    await cleanRun(2)
  }
  if (WITH_CODEX) {
    await killedRun(3)
    await cleanRun(4)
  }
}

const RUNS = { 1: run1, 2: run2, 3: run3, 4: run4 }
const guard = setTimeout(() => {
  log('GLOBAL TIMEOUT')
  app.exit(2)
}, (PHASE ? 6 : 14) * 60 * 1000)

app.whenReady().then(async () => {
  let code = 0
  try {
    if (PHASE) await RUNS[PHASE]()
    else await parent()
  } catch (err) {
    log(`ERROR ${err && err.stack ? err.stack : err}`)
    code = 1
  }
  clearTimeout(guard)
  if (PHASE) fs.writeFileSync(RESULT, JSON.stringify(checks))
  const failed = checks.filter((c) => !c.ok)
  if (!PHASE) {
    log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(' | ')}` : ''}`)
    log(`log: ${LOG}`)
  }
  setTimeout(() => app.exit(code || (failed.length ? 1 : 0)), 500)
})
