// Phase B end-to-end check of the main-process stack against the REAL `codex app-server`, without
// the renderer: session manager + Codex driver + the shared app-server, on your logged-in Codex
// account (default CODEX_HOME). It runs FOUR short model turns at low reasoning effort, so it spends
// a little of the account's Codex allowance.
//
//   npx electron scripts/e2e-phase-b.cjs [--no-windows-check]
//
// It runs under Electron on purpose: the app-server is then spawned by a GUI process, as in the app,
// and a watcher records every console window that appears meanwhile (the spikes could not check this).
//
// What it does, in a fresh scratch folder with permission mode `default`:
//   1. a command that needs approval -> card in the registry -> allow -> output -> final answer -> idle
//   2. the same, denied with a message (the message follows as a steer)
//   3. a slow command; a CEO order is sent mid-turn (turn/steer) and must shape the final answer
//   4. a slow command, interrupted: the open command card is closed by the driver
//   then stops the session and the app-server, starts a second stack ("app restart"), resumes the
//   thread in a fresh driver and checks that the chat history is rebuilt.
// It only kills the app-server it started. The thread stays in your Codex history (`codex resume`).
'use strict'
const { app } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'agent-office-e2e-b')
const WORK = path.join(ROOT, `ws-${Date.now().toString(36)}`)
const USER_DATA = path.join(ROOT, 'userData')
const BUNDLE_DIR = path.join(REPO, 'out', 'e2e')
const WINDOWS_CHECK = process.platform === 'win32' && !process.argv.includes('--no-windows-check')

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
function info(name, detail) {
  log(`INFO  ${name}: ${detail}`)
}
async function until(cond, what, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await cond()
    if (v) return v
    await sleep(50)
  }
  log(`TIMEOUT waiting for: ${what}`)
  return null
}

async function bundle() {
  const esbuild = require('esbuild')
  const entry = `
    export { SessionManager } from './electron/sessions.ts'
    export { codexProvider } from './electron/drivers/codex.ts'
    export { isAllowedLoginUrl } from './electron/drivers/codexProtocol.ts'
  `
  const outfile = path.join(BUNDLE_DIR, 'stack-b.mjs')
  await esbuild.build({
    stdin: { contents: entry, resolveDir: REPO, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    external: ['electron'],
    logLevel: 'warning'
  })
  return import(pathToFileURL(outfile).href)
}

// ---- console-window watcher (Windows) ---------------------------------------------------------------

const WATCHER_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AoWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> List() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      r.Add(h.ToInt64() + "\t" + (IsWindowVisible(h) ? "1" : "0") + "\t" + pid + "\t" + c + "\t" + t);
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
$out = $args[0]
$seen = @{}
foreach ($w in [AoWin]::List()) { $p = $w.Split([char]9); $seen[$p[0] + ':' + $p[1]] = 1 }
$tab = [string][char]9
Add-Content -LiteralPath $out -Value ("READY" + $tab + $seen.Count)
while ($true) {
  foreach ($w in [AoWin]::List()) {
    $p = $w.Split([char]9)
    $key = $p[0] + ':' + $p[1]
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = 1
    $name = (Get-Process -Id $p[2]).ProcessName
    Add-Content -LiteralPath $out -Value (@("WIN", [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $p[1], $p[2], $name, $p[3], $p[4]) -join $tab)
  }
  Start-Sleep -Milliseconds 40
}
`
const CONSOLE_CLASSES = ['ConsoleWindowClass', 'PseudoConsoleWindow', 'CASCADIA_HOSTING_WINDOW_CLASS']
const CONSOLE_PROCESSES = ['codex', 'powershell', 'pwsh', 'conhost', 'openconsole', 'cmd', 'node', 'windowsterminal', 'codex-command-runner', 'codex-code-mode-host']

let watcherChild = null

async function startWatcher() {
  if (!WINDOWS_CHECK) return null
  const script = path.join(ROOT, 'watch-windows.ps1')
  const out = path.join(ROOT, 'windows.tsv')
  fs.writeFileSync(script, WATCHER_PS)
  fs.writeFileSync(out, '')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, out], { stdio: 'ignore', windowsHide: true })
  watcherChild = child
  const ready = await until(() => fs.readFileSync(out, 'utf8').includes('READY'), 'the window watcher', 30000)
  log(`window watcher ${ready ? 'ready' : 'NOT ready'} (pid ${child.pid})`)
  await sleep(300)
  // Windows the watcher's own start produced don't count.
  const skip = fs.readFileSync(out, 'utf8').split(/\r?\n/).length
  return {
    stop() {
      try {
        child.kill()
      } catch {
        // gone
      }
      return fs
        .readFileSync(out, 'utf8')
        .split(/\r?\n/)
        .slice(skip - 1)
        .filter((l) => l.startsWith('WIN\t'))
        .map((l) => {
          const [, at, visible, pid, name, cls, title] = l.split('\t')
          return { at: Number(at), visible: visible === '1', pid: Number(pid), name, cls, title }
        })
    }
  }
}

/** Our app-server's process tree (pid -> name), sampled while it runs. */
function processTree(rootPid) {
  if (process.platform !== 'win32' || !rootPid) return new Map()
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'], { windowsHide: true, encoding: 'utf8', timeout: 20000 })
    const rows = raw.split(/\r?\n/).map((l) => l.split(',')).filter((r) => r.length >= 3)
    const tree = new Map()
    const add = (pid) => {
      for (const [p, parent, name] of rows) {
        if (Number(parent) === pid && !tree.has(Number(p))) {
          tree.set(Number(p), name)
          add(Number(p))
        }
      }
    }
    const self = rows.find((r) => Number(r[0]) === rootPid)
    if (self) tree.set(rootPid, self[2])
    add(rootPid)
    return tree
  } catch {
    return new Map()
  }
}
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- the stack --------------------------------------------------------------------------------------

function makeStack(stack, label) {
  const s = { world: [], chat: [], states: [], permissions: [], providerLists: [], opened: [], allowOrders: false, id: '' }
  const noPty = { spawn: async () => {}, write() {}, resize() {}, kill() {}, dispose() {}, snapshot: async () => null, detach() {}, ack() {} }
  s.codex = stack.codexProvider({
    openExternal: async (url) => void s.opened.push(url),
    server: { clientVersion: '0.1.0-e2e' },
    effort: 'low'
  })
  s.manager = new stack.SessionManager({
    pty: noPty,
    sink: { emit: (e) => { s.world.push(e); log(`${label} WORLD ${e.agentId === s.id ? 'manager' : e.agentId} ${e.activity} ${JSON.stringify(e.detail.slice(0, 90))} name=${JSON.stringify(e.displayName)}`) } },
    providers: [s.codex],
    allowOrders: () => s.allowOrders,
    worldTopLevel: () => [],
    onSessionsChanged: (list) => {
      const cur = list.find((x) => x.id === s.id) || list[0]
      if (!cur) return
      const prev = s.states[s.states.length - 1]
      if (!prev || prev.state !== cur.state) { s.states.push({ t: Date.now(), state: cur.state }); log(`${label} STATE ${cur.state} canReceiveOrders=${cur.canReceiveOrders} title=${JSON.stringify(cur.title)}`) }
    },
    onPermissionsChanged: (list) => { s.permissions = list; log(`${label} PERMISSIONS pending=${list.length} ${list.map((p) => `[${p.id} ${p.toolName} | ${p.summary}]`).join(' ')}`) },
    onTerminalData: () => {},
    onChatEvent: (e) => {
      s.chat.push({ t: Date.now(), e })
      if (e.type === 'delta') return // counted, not logged one by one
      if (e.type === 'item') {
        const i = e.item
        const what = i.kind === 'user' ? `${i.origin} ${JSON.stringify(i.text.slice(0, 70))}` : i.kind === 'assistant' ? `${i.phase || ''} streaming=${i.streaming} ${JSON.stringify(i.text.slice(0, 70))}` : i.kind === 'command' ? `${i.status} exit=${i.exitCode} intent=${i.intent} ${JSON.stringify(i.command.slice(0, 70))} out=${JSON.stringify(i.output.slice(0, 40))}` : i.kind === 'approval' ? `${i.outcome} request=${i.requestId} subject=${i.subjectId} ${JSON.stringify(i.summary.slice(0, 70))}` : i.kind === 'notice' ? `${i.level} ${JSON.stringify(i.text.slice(0, 120))}` : ''
        log(`${label} CHAT item ${i.kind} ${i.id.slice(0, 28)} ${what}`)
      } else if (e.type === 'turn') log(`${label} CHAT turn ${e.status} ${e.turnId}${e.error ? ` error=${e.error}` : ''}`)
      else log(`${label} CHAT reset items=${e.items.length}`)
    },
    onProvidersChanged: (list) => { s.providerLists.push(list); const c = list.find((p) => p.id === 'codex'); log(`${label} PROVIDERS codex account=${JSON.stringify(c.account)} usage=${JSON.stringify(c.usage)}`) }
  })
  s.state = () => (s.manager.list().find((x) => x.id === s.id) || {}).state
  s.waitState = (want, ms) => until(() => s.state() === want, `state ${want}`, ms)
  s.items = () => s.manager.chatAttach(s.id)
  s.turnEnded = (since, status) => s.chat.find((c) => c.t >= since && c.e.type === 'turn' && (status ? c.e.status === status : c.e.status !== 'started'))
  return s
}

let shutdownAll = async () => {}
const SLOW = (seconds, word) => `node -e "setTimeout(()=>console.log('${word}'),${seconds * 1000})"`

async function main() {
  const stack = await bundle()
  const watcher = await startWatcher()
  const a = makeStack(stack, 'A')
  shutdownAll = () => a.manager.shutdown()

  // ---------------------------------------------------------------- providers
  let providers = await a.manager.providers()
  const codex = providers.find((p) => p.id === 'codex')
  log(`PROVIDERS ${JSON.stringify(providers)}`)
  check('listProviders: codex available, with version', codex.available && !!codex.version, codex.version)
  check('account read from the app-server: logged in', codex.account && codex.account.loggedIn === true, JSON.stringify(codex.account))
  check('usage window reported', codex.usage && typeof codex.usage.usedPercent === 'number', JSON.stringify(codex.usage))
  check('antigravity stays unavailable', providers.find((p) => p.id === 'antigravity').available === false, providers.find((p) => p.id === 'antigravity').reason)
  if (!codex.account || !codex.account.loggedIn) throw new Error('not logged in to Codex: run `codex login` first')
  const usageBefore = codex.usage
  const serverPid = a.codex.server.pid
  info('app-server', `pid ${serverPid}, codexHome ${a.codex.server.info.codexHome}`)

  // ---------------------------------------------------------------- start
  let t = Date.now()
  const started = await a.manager.start({ provider: 'codex', cwd: WORK, permissionMode: 'default' })
  a.id = started.id
  log(`started session ${a.id} in ${Date.now() - t} ms: ${JSON.stringify(started)}`)
  check('session started: idle, surface chat, provider codex', started.state === 'idle' && started.surface === 'chat' && started.provider === 'codex')
  check('title = the model the thread reported', !!started.model && started.title === started.model, `${started.title}`)
  check('providerSessionId = Codex thread id (UUID)', /^[0-9a-f-]{36}$/.test(started.providerSessionId || ''), started.providerSessionId)
  check('world: manager spawned (idle, provider codex, named after the model)', a.world[0] && a.world[0].agentId === a.id && a.world[0].parentId === null && a.world[0].provider === 'codex' && a.world[0].activity === 'idle' && a.world[a.world.length - 1].displayName === started.title)
  const first = a.manager.chatAttach(a.id)
  const sandboxNotice = first.find((i) => i.kind === 'notice' && /read-only/i.test(i.text))
  check('thread/start honoured workspace-write (no sandbox downgrade notice)', !sandboxNotice, sandboxNotice ? sandboxNotice.text : 'chat list empty')
  await assertRejects(() => a.manager.attach(a.id), /no terminal/, 'terminal.attach on a chat session rejects cleanly')

  // ---------------------------------------------------------------- turn 1: approval, allowed
  t = Date.now()
  const CMD1 = `node -e "console.log('ao-codex-e2e')"`
  await a.manager.chatSend(a.id, `Run this exact command: ${CMD1}`)
  check('chat.send resolved (turn/start acknowledged) with "Allow CEO orders" off', true, `${Date.now() - t} ms`)
  const perm = await until(() => a.permissions[0], 'approval registered', 120000)
  check('approval registered in the CEO inbox', !!perm, perm ? `${perm.toolName} | ${perm.summary}` : '')
  if (!perm) throw new Error('no approval request (the command ran without asking, or the turn failed)')
  check('summary is the inner command, not the PowerShell wrapper', perm.summary === `Command: ${CMD1}`, perm.summary)
  check('detail has the command and the cwd', perm.detail.includes(CMD1) && perm.detail.includes(`cwd: ${WORK}`), JSON.stringify(perm.detail))
  check('permission info: session, agent, provider, tool', perm.sessionId === a.id && perm.agentId === a.id && perm.provider === 'codex' && perm.toolName === 'Command')
  check('state waiting-permission', a.state() === 'waiting-permission', a.state())
  check('world: manager waiting', a.world[a.world.length - 1].activity === 'waiting' && a.world[a.world.length - 1].detail === perm.summary)
  let items = a.items()
  let card = items.find((i) => i.kind === 'approval')
  let subject = items.find((i) => i.kind === 'command')
  check('chat: approval card linked to the permission id and to the command item', card && card.requestId === perm.id && card.outcome === 'pending' && subject && card.subjectId === subject.id && subject.status === 'running')
  const tree1 = processTree(serverPid)
  info('app-server process tree while waiting', [...tree1].map(([p, n]) => `${n}(${p})`).join(' '))
  const tDecide = Date.now()
  check('decide(allow) -> allowed', a.manager.decide(perm.id, { behavior: 'allow' }) === 'allowed')
  check('turn 1 completed', await until(() => a.turnEnded(t, 'completed'), 'turn 1 completed', 120000), `${Date.now() - tDecide} ms after the decision`)
  check('state idle after the turn', await a.waitState('idle', 3000))
  items = a.items()
  subject = items.find((i) => i.kind === 'command')
  card = items.find((i) => i.kind === 'approval')
  check('command item completed with its output', subject && subject.status === 'done' && subject.exitCode === 0 && /ao-codex-e2e/.test(subject.output), subject ? JSON.stringify({ status: subject.status, exit: subject.exitCode, output: subject.output, ms: subject.durationMs }) : '')
  check('approval card outcome allowed', card && card.outcome === 'allowed')
  const finals = items.filter((i) => i.kind === 'assistant')
  const final1 = finals[finals.length - 1]
  check('assistant final answer, streaming finished', final1 && final1.phase === 'final' && !final1.streaming && final1.text.length > 0, final1 ? JSON.stringify(final1.text.slice(0, 80)) : '')
  const users = items.filter((i) => i.kind === 'user')
  check('exactly one user item, under the id the app sent (clientUserMessageId round trip)', users.length === 1 && users[0].id.startsWith('ao-human-') && users[0].origin === 'human', users.map((u) => u.id).join(','))
  const deltas = a.chat.filter((c) => c.e.type === 'delta')
  check('assistant text streamed as deltas', deltas.some((c) => c.e.field === 'text'), `${deltas.filter((c) => c.e.field === 'text').length} text deltas, ${deltas.filter((c) => c.e.field === 'output').length} output deltas`)
  check('world: exec -> waiting -> exec -> idle', a.world.map((e) => e.activity).join('>').endsWith('waiting>exec>idle'), a.world.map((e) => e.activity).join('>'))
  check('usage update reached the provider list', a.providerLists.length > 0, `${a.providerLists.length} broadcasts`)

  // ---------------------------------------------------------------- turn 2: denied with a message
  t = Date.now()
  await a.manager.chatSend(a.id, `Run this exact command: node -e "console.log('ao-denied')"\nIf you are not allowed to run it, do not try anything else.`)
  const perm2 = await until(() => a.permissions[0], 'second approval', 120000)
  check('second approval registered', !!perm2, perm2 ? perm2.summary : '')
  if (perm2) {
    check('decide(deny, message) -> denied', a.manager.decide(perm2.id, { behavior: 'deny', message: 'Not this one. Reply with exactly: deny-understood' }) === 'denied')
    check('turn 2 completed', await until(() => a.turnEnded(t, 'completed'), 'turn 2 completed', 120000))
    await a.waitState('idle', 3000)
    items = a.items()
    const turnId = items[items.length - 1].turnId
    const mine = items.filter((i) => i.turnId === turnId)
    const cmd = mine.find((i) => i.kind === 'command')
    check('declined command item: status declined, never ran', cmd && cmd.status === 'declined' && cmd.exitCode === null && cmd.output === '', cmd ? cmd.status : 'no command item')
    const c2 = mine.find((i) => i.kind === 'approval')
    check('approval card outcome denied', c2 && c2.outcome === 'denied')
    const steer = mine.find((i) => i.kind === 'user' && i.origin === 'steer')
    check('the deny message followed as a steer (user item in the same turn)', !!steer, steer ? JSON.stringify(steer.text) : mine.map((i) => i.kind).join(','))
    const last = mine.filter((i) => i.kind === 'assistant').pop()
    info('answer after the denial', last ? JSON.stringify(last.text.slice(0, 160)) : '(none)')
    check('the model saw the deny message', last && /deny-understood/i.test(last.text))
    check('ao-denied was never printed', !items.some((i) => i.kind === 'command' && /ao-denied/.test(i.output)))
  }

  // ---------------------------------------------------------------- turn 3: an order mid-turn (steer)
  t = Date.now()
  await a.manager.chatSend(a.id, `Run this exact command: ${SLOW(12, 'slow-done')}\nThen answer with what it printed.`)
  const perm3 = await until(() => a.permissions[0], 'third approval', 120000)
  if (perm3) a.manager.decide(perm3.id, { behavior: 'allow' })
  check('slow command approved and running', perm3 && (await until(() => a.state() === 'busy' && a.items().some((i) => i.kind === 'command' && i.status === 'running' && /slow-done/.test(i.command)), 'slow command running', 30000)))
  await sleep(1500)
  const tree3 = processTree(serverPid)
  info('app-server process tree while a command runs', [...tree3].map(([p, n]) => `${n}(${p})`).join(' '))
  let r = await a.manager.sendOrder({ target: 'provider:codex', text: 'Also: end your final answer with the exact word steered-ok.' })
  check('order refused while "Allow CEO orders" is off', r.delivered.length === 0 && /disabled/.test(r.failed[0].reason), r.failed[0] && r.failed[0].reason)
  a.allowOrders = true
  const tOrder = Date.now()
  r = await a.manager.sendOrder({ target: 'provider:codex', text: 'Also: end your final answer with the exact word steered-ok.' })
  check('order to provider:codex delivered mid-turn (turn/steer acknowledged)', r.delivered.length === 1 && r.delivered[0] === a.id && r.failed.length === 0, `${JSON.stringify(r)} in ${Date.now() - tOrder} ms`)
  check('still the same turn (busy), no new turn started', a.state() === 'busy' && !a.chat.some((c) => c.t >= tOrder && c.e.type === 'turn' && c.e.status === 'started'))
  check('turn 3 completed', await until(() => a.turnEnded(t, 'completed'), 'turn 3 completed', 120000))
  await a.waitState('idle', 3000)
  items = a.items()
  {
    const turnId = items[items.length - 1].turnId
    const mine = items.filter((i) => i.turnId === turnId)
    const order = mine.filter((i) => i.kind === 'user' && i.origin === 'order')
    check('the order is one user item (origin order) in the running turn, not prefixed', order.length === 1 && order[0].text === 'Also: end your final answer with the exact word steered-ok.', mine.map((i) => `${i.kind}${i.kind === 'user' ? `:${i.origin}` : ''}`).join(','))
    const cmd = mine.find((i) => i.kind === 'command')
    check('the running command was not disturbed', cmd && cmd.status === 'done' && /slow-done/.test(cmd.output), cmd ? `${cmd.status} ${JSON.stringify(cmd.output)} ${cmd.durationMs} ms` : '')
    const last = mine.filter((i) => i.kind === 'assistant').pop()
    check('the final answer obeyed the order', last && /steered-ok/.test(last.text), last ? JSON.stringify(last.text.slice(0, 120)) : '')
  }

  // ---------------------------------------------------------------- turn 4: interrupt
  t = Date.now()
  await a.manager.chatSend(a.id, `Run this exact command: ${SLOW(25, 'never-printed')}`)
  const perm4 = await until(() => a.permissions[0], 'fourth approval', 120000)
  if (perm4) a.manager.decide(perm4.id, { behavior: 'allow' })
  check('slow command running', perm4 && (await until(() => a.state() === 'busy' && a.items().some((i) => i.kind === 'command' && i.status === 'running' && /never-printed/.test(i.command)), 'second slow command running', 30000)))
  await sleep(1500)
  const tInt = Date.now()
  a.manager.interrupt(a.id)
  const ended = await until(() => a.turnEnded(tInt), 'turn end after the interrupt', 15000)
  check('turn/interrupt -> turn interrupted', ended && ended.e.status === 'interrupted', ended ? `${ended.t - tInt} ms after the request` : '')
  check('state idle after the interrupt', await a.waitState('idle', 3000))
  items = a.items()
  {
    const cmd = items.filter((i) => i.kind === 'command').pop()
    check('the open command item was closed by the driver: interrupted', cmd && cmd.status === 'interrupted' && /never-printed/.test(cmd.command), cmd ? cmd.status : '')
    check('nothing left running or streaming', !items.some((i) => i.status === 'running' || i.streaming === true))
    check('world: manager idle', a.world[a.world.length - 1].activity === 'idle')
  }
  const liveItems = a.items()
  const threadId = a.manager.list()[0].providerSessionId

  // ---------------------------------------------------------------- stop + app-server shutdown
  a.manager.chatDetach(a.id)
  t = Date.now()
  await a.manager.stop(a.id)
  check('stop(): state exited, world done', a.state() === 'exited' && a.world[a.world.length - 1].activity === 'done', `${Date.now() - t} ms`)
  providers = await a.manager.providers()
  const usageAfter = providers.find((p) => p.id === 'codex').usage
  info('usage', `before ${JSON.stringify(usageBefore)} -> after ${JSON.stringify(usageAfter)}`)
  const treeBefore = processTree(serverPid)
  t = Date.now()
  await a.manager.shutdown()
  await sleep(500)
  const left = [...treeBefore.keys()].filter(pidAlive)
  check('shutdown(): our app-server and everything it started are gone', left.length === 0, `${Date.now() - t} ms; tree was ${[...treeBefore].map(([p, n]) => `${n}(${p})`).join(' ')}${left.length ? `; STILL ALIVE: ${left.join(',')}` : ''}`)

  // ---------------------------------------------------------------- "app restart": resume in a fresh driver
  const b = makeStack(stack, 'B')
  shutdownAll = () => b.manager.shutdown()
  t = Date.now()
  const resumed = await b.manager.start({ provider: 'codex', cwd: WORK, permissionMode: 'default', resume: threadId })
  b.id = resumed.id
  log(`resumed as session ${b.id} in ${Date.now() - t} ms (new app-server pid ${b.codex.server.pid})`)
  check('resume: new app-server process, same thread, idle', b.codex.server.pid !== serverPid && resumed.providerSessionId === threadId && resumed.state === 'idle')
  const history = b.manager.chatAttach(b.id)
  log(`history: ${history.map((i) => `${i.kind}${i.kind === 'command' ? `[${i.status}]` : i.kind === 'user' ? `[${i.origin}]` : ''}`).join(' ')}`)
  log(`live   : ${liveItems.map((i) => `${i.kind}${i.kind === 'command' ? `[${i.status}]` : i.kind === 'user' ? `[${i.origin}]` : ''}`).join(' ')}`)
  const h = (kind) => history.filter((i) => i.kind === kind)
  const liveUsers = liveItems.filter((i) => i.kind === 'user')
  check('history: every user message is back (prompts, the deny message, the order)', h('user').length === liveUsers.length && liveUsers.every((u) => h('user').some((x) => x.text === u.text)), `${h('user').length} of ${liveUsers.length}`)
  check('history: the command with its output is back', h('command').some((i) => i.status === 'done' && /ao-codex-e2e/.test(i.output)))
  const cut = h('command').find((i) => /never-printed/.test(i.command))
  info('history: the command that was interrupted', cut ? `present, status ${cut.status}` : 'absent from the thread history (the live list had it as interrupted)')
  check('history: the interrupted turn is marked', history.some((i) => i.kind === 'notice' && i.text === 'Turn interrupted') && (!cut || cut.status === 'interrupted'))
  check('history: origins survive the resume (clientUserMessageId is kept by Codex)', h('user').map((i) => i.origin).join(',') === liveUsers.map((i) => i.origin).join(','), h('user').map((i) => i.origin).join(','))
  check('history: assistant answers are back, none streaming', h('assistant').length >= 3 && !history.some((i) => i.streaming === true), `${h('assistant').length}`)
  check('history: grouped by the same turn ids as live', new Set(history.map((i) => i.turnId).filter(Boolean)).size === new Set(liveItems.map((i) => i.turnId).filter(Boolean)).size, `${new Set(history.map((i) => i.turnId).filter(Boolean)).size} turns`)
  check('resume: sandbox as requested (no downgrade notice)', !history.some((i) => i.kind === 'notice' && /read-only/i.test(i.text)))
  info('history vs live', `declined commands in history: ${h('command').filter((i) => i.status === 'declined').length} (live had 1); approval cards are not part of the thread`)
  const pidB = b.codex.server.pid
  await b.manager.stop(b.id)
  await b.manager.shutdown()
  await sleep(500)
  check('second app-server gone after shutdown', !pidAlive(pidB))

  // ---------------------------------------------------------------- console windows
  if (watcher) {
    const wins = watcher.stop()
    const ours = new Set([...tree1.keys(), ...tree3.keys(), ...treeBefore.keys(), serverPid, pidB])
    const suspicious = wins.filter((w) => CONSOLE_CLASSES.includes(w.cls) || CONSOLE_PROCESSES.includes(String(w.name).toLowerCase()) || ours.has(w.pid))
    for (const w of wins) log(`WINDOW ${w.visible ? 'VISIBLE' : 'hidden '} pid=${w.pid} ${w.name} class=${w.cls} title=${JSON.stringify(w.title)}${ours.has(w.pid) ? '  <- our app-server tree' : ''}`)
    const visible = suspicious.filter((w) => w.visible)
    check('no console window became visible while the app-server and its commands ran', visible.length === 0, `${wins.length} new top-level windows in total, ${suspicious.length} console-related (${suspicious.filter((w) => !w.visible).length} hidden), ${visible.length} visible`)
  } else info('console windows', 'not checked')

  log(`state sequence A: ${a.states.map((s) => s.state).join(' > ')}`)
  log(`world sequence A: ${a.world.map((e) => e.activity).join(' > ')}`)
  log(`thread left in your Codex history: ${threadId} (remove with \`codex archive ${threadId}\` if unwanted)`)
  log(`scratch folder: ${WORK}`)
}

async function assertRejects(fn, re, name) {
  try {
    await fn()
    check(name, false, 'did not reject')
  } catch (err) {
    check(name, re.test(String(err && err.message)), String(err && err.message))
  }
}

const guard = setTimeout(() => {
  log('GLOBAL TIMEOUT')
  void shutdownAll().finally(() => app.exit(2))
}, 12 * 60 * 1000)

app.whenReady().then(async () => {
  let code = 0
  try {
    await main()
  } catch (err) {
    log(`ERROR ${err && err.stack ? err.stack : err}`)
    code = 1
  }
  await shutdownAll().catch(() => {})
  try {
    if (watcherChild) watcherChild.kill()
  } catch {
    // gone
  }
  clearTimeout(guard)
  const failed = checks.filter((c) => !c.ok)
  log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(' | ')}` : ''}`)
  log(`log: ${logFile}`)
  setTimeout(() => app.exit(code || (failed.length ? 1 : 0)), 500)
})
