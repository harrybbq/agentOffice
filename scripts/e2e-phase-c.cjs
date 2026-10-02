// Phase C end-to-end check of the main-process stack against the REAL Antigravity CLI (`agy`),
// without the renderer: session manager + Antigravity driver + ingest server (the `/hooks/agy`
// route and the office board's MCP route) + the real hook script, on your signed-in agy account.
//
//   npx electron scripts/e2e-phase-c.cjs [--turns N] [--free] [--model <slug>] [--no-windows-check]
//   node scripts/e2e-phase-c.cjs …            (also works; then no console-window check)
//
// QUOTA: the free plan is small (one turn with a few tool calls is 2-3 % of the WEEK). The script
// sends at most `--turns` prompts (default and maximum 5) to the cheapest model
// (gemini-3.8-flash-low) and stops at the first sign of a rate limit. `--free` sends none: it only
// runs the checks that cost nothing (login, usage, the hooks check, a start, a resume).
//
// agy is only ever spawned with `--dangerously-skip-permissions` by the driver, after agy itself
// listed the app's PreToolUse hook for the session's folder. Nothing is written to ~/.gemini by the
// app (agy keeps its own conversation history there) and nothing outside a scratch folder.
//
// What it does, in a fresh scratch folder with permission mode `default`:
//   free  provider probe (login, usage), the hooks check (also: a folder WITHOUT the hook is refused)
//   1     a command (inbox: allow -> it runs), a file creation (inbox: allow -> a diff card with the
//         content), an office-board tool (no card); the briefing reached the model
//   2     a command denied with a message (the model reads the reason); a prompt sent mid-turn is
//         handed into the running turn (PreInvocation `userMessage`): does the model take it in?
//   3     a slow command, interrupted: process tree killed, items closed, gate checked, respawned
//   4     a follow-up turn in the respawned process: the conversation continued
//   then stops the session, starts a second stack ("app restart"), wakes the saved session
//   (`--conversation`), and (turn 5) asks once more; and a resume of an unknown conversation.
'use strict'
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const electronApp = process.versions.electron ? require('electron').app : null
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const REPO = path.resolve(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'agent-office-e2e-c')
const RUN = Date.now().toString(36)
const WORK = path.join(ROOT, `ws-${RUN}`)
const USER_DATA = path.join(ROOT, `userData-${RUN}`)
const BUNDLE_DIR = path.join(REPO, 'out', 'e2e')
const MODEL = arg('--model') || 'gemini-3.8-flash-low'
const FREE = argv.includes('--free')
const MAX_TURNS = FREE ? 0 : Math.min(5, Math.max(0, Number(arg('--turns') ?? 5)))
const WINDOWS_CHECK = !!electronApp && process.platform === 'win32' && !argv.includes('--no-windows-check')

fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
if (electronApp) {
  electronApp.setPath('userData', USER_DATA)
  electronApp.on('window-all-closed', () => {})
}

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
  return !!ok
}
const info = (name, detail) => log(`INFO  ${name}: ${detail}`)
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
    export { SessionStore } from './electron/sessionStore.ts'
    export { agyProvider, probeAgyGate, buildAgySessionFolder, AGY_CONVERSATION_GONE, AGY_HOOKS_NOT_LOADED } from './electron/drivers/agy.ts'
    export { createAgyHooksAdapter } from './electron/drivers/agyHookBridge.ts'
    export { startIngestServer } from './electron/ingest/server.ts'
    export { SessionTokens } from './electron/ingest/auth.ts'
    export { Board } from './electron/board.ts'
    export { boardMcpRoute, BOARD_MCP_ROUTE } from './electron/boardMcp.ts'
  `
  const outfile = path.join(BUNDLE_DIR, 'stack-c.mjs')
  await esbuild.build({ stdin: { contents: entry, resolveDir: REPO, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, external: ['electron', 'ws'], logLevel: 'warning' })
  return import(pathToFileURL(outfile).href)
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

// ---- console-window watcher (Windows, under Electron): as in e2e-phase-b.cjs ------------------------

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
const CONSOLE_PROCESSES = ['agy', 'powershell', 'pwsh', 'conhost', 'openconsole', 'cmd', 'node', 'windowsterminal']
let watcherChild = null

async function startWatcher() {
  if (!WINDOWS_CHECK) return null
  const script = path.join(ROOT, 'watch-windows.ps1')
  const out = path.join(ROOT, `windows-${RUN}.tsv`)
  fs.writeFileSync(script, WATCHER_PS)
  fs.writeFileSync(out, '')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, out], { stdio: 'ignore', windowsHide: true })
  watcherChild = child
  const ready = await until(() => fs.readFileSync(out, 'utf8').includes('READY'), 'the window watcher', 30000)
  log(`window watcher ${ready ? 'ready' : 'NOT ready'} (pid ${child.pid})`)
  await sleep(300)
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

/** Every agy.exe on the machine that was started for one of this run's session folders, with its descendants. */
function agyTrees() {
  if (process.platform !== 'win32') return []
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
    const all = JSON.parse(raw)
    const roots = all.filter((p) => /^agy(\.exe)?$/i.test(p.Name) && String(p.CommandLine || '').includes(USER_DATA))
    const out = []
    const walk = (pid, depth) => {
      const p = all.find((x) => x.ProcessId === pid)
      if (!p || out.some((o) => o.pid === pid)) return
      out.push({ pid, name: p.Name, depth, mb: Math.round((p.WorkingSetSize || 0) / 1048576) })
      for (const c of all) if (c.ParentProcessId === pid) walk(c.ProcessId, depth + 1)
    }
    for (const r of roots) walk(r.ProcessId, 0)
    return out
  } catch {
    return []
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

async function makeStack(stack, label) {
  const s = { world: [], chat: [], states: [], permissions: [], providerLists: [], probes: 0, id: '', label }
  const port = await freePort()
  const agyTokens = new stack.SessionTokens()
  const boardTokens = new stack.SessionTokens()
  const board = new stack.Board({ settings: () => ({ enabled: true, conflictMode: 'block-once' }) })
  const noPty = { spawn: async () => {}, write() {}, resize() {}, kill() {}, dispose() {}, snapshot: async () => null, detach() {}, ack() {} }
  s.agy = stack.agyProvider({
    sessionsDir: path.join(USER_DATA, 'agy-sessions'),
    protectedPaths: [USER_DATA],
    hookScript: path.join(REPO, 'hook', 'agy-hook.cjs'),
    boardScript: path.join(REPO, 'hook', 'agy-board-mcp.cjs'),
    ingest: { baseUrl: () => `http://127.0.0.1:${port}`, tokens: agyTokens },
    // The check under test: a prompt sent mid-turn is handed over at the turn's next model call.
    steer: 'inject',
    // The real gate check, counted.
    probeGate: async (cwd, folder) => {
      s.probes++
      const problem = await stack.probeAgyGate(s.agy.cli, cwd, folder)
      log(`${label} GATE CHECK #${s.probes} for ${path.basename(folder.dir)}: ${problem ?? 'the PreToolUse hook is loaded'}`)
      return problem
    }
  })
  s.store = new stack.SessionStore({ file: path.join(USER_DATA, 'sessions.json') })
  s.manager = new stack.SessionManager({
    pty: noPty,
    sink: { emit: (e) => { s.world.push(e); log(`${label} WORLD ${e.agentId === s.id ? 'manager' : e.agentId} ${e.activity} ${JSON.stringify(e.detail.slice(0, 90))} name=${JSON.stringify(e.displayName)}`) } },
    providers: [s.agy],
    allowOrders: () => false,
    worldTopLevel: () => [],
    onSessionsChanged: (list) => {
      const cur = list.find((x) => x.id === s.id) || list[0]
      if (!cur) return
      const prev = s.states[s.states.length - 1]
      if (!prev || prev.state !== cur.state) { s.states.push({ t: Date.now(), state: cur.state }); log(`${label} STATE ${cur.state} canReceiveOrders=${cur.canReceiveOrders} title=${JSON.stringify(cur.title)}${cur.notice ? ` notice=${JSON.stringify(cur.notice)}` : ''}`) }
    },
    onPermissionsChanged: (list) => { s.permissions = list; log(`${label} PERMISSIONS pending=${list.length} ${list.map((p) => `[${p.id} ${p.toolName} | ${p.summary} | ${p.risk}]`).join(' ')}`) },
    onTerminalData: () => {},
    onChatEvent: (e) => {
      s.chat.push({ t: Date.now(), e })
      if (e.type === 'delta') return
      if (e.type === 'item') {
        const i = e.item
        const what = i.kind === 'user' ? `${i.origin} ${JSON.stringify(i.text.slice(0, 70))}` : i.kind === 'assistant' ? `streaming=${i.streaming} ${JSON.stringify(i.text.slice(0, 160))}` : i.kind === 'command' ? `${i.status} intent=${i.intent} ${JSON.stringify(i.command.slice(0, 70))} out=${JSON.stringify(i.output.slice(0, 60))}` : i.kind === 'file-change' ? `${i.status} ${i.changes.map((c) => `${c.change} ${path.basename(c.path)} diff=${JSON.stringify(c.diff.slice(0, 60))}`).join(' ')}` : i.kind === 'tool' ? `${i.status} ${i.server || ''}.${i.tool} result=${JSON.stringify((i.result || i.error || '').slice(0, 60))}` : i.kind === 'approval' ? `${i.outcome} request=${i.requestId} subject=${i.subjectId} ${JSON.stringify(i.summary.slice(0, 70))}` : i.kind === 'notice' ? `${i.level} ${JSON.stringify(i.text.slice(0, 160))}` : ''
        log(`${label} CHAT item ${i.kind} ${i.id.slice(0, 28)} ${what}`)
      } else if (e.type === 'turn') log(`${label} CHAT turn ${e.status} ${e.turnId}${e.error ? ` error=${e.error}` : ''}`)
      else log(`${label} CHAT reset items=${e.items.length}`)
    },
    onProvidersChanged: (list) => { s.providerLists.push(list); const g = list.find((p) => p.id === 'antigravity'); log(`${label} PROVIDERS antigravity account=${JSON.stringify(g.account)} usage=${JSON.stringify(g.usage)}`) },
    board: { model: board, endpoint: { url: () => `http://127.0.0.1:${port}${stack.BOARD_MCP_ROUTE}`, tokens: boardTokens }, resolveProject: async (cwd) => ({ project: cwd.toLowerCase(), projectLabel: path.basename(cwd), root: cwd }) },
    restore: { store: s.store, settings: () => ({ mode: 'none' }) }
  })
  s.server = await stack.startIngestServer({
    port,
    getToken: () => 'e2e-global-token-not-used-by-anything-0123456789abcdef',
    sink: { emit: () => {} },
    board: { route: stack.boardMcpRoute(board), tokens: boardTokens },
    agy: { adapter: stack.createAgyHooksAdapter(s.manager), tokens: agyTokens }
  })
  s.board = board
  s.agyTokens = agyTokens
  s.row = () => s.manager.list().find((x) => x.id === s.id)
  s.state = () => (s.row() || {}).state
  s.waitState = (want, ms) => until(() => s.state() === want, `state ${want}`, ms)
  s.items = () => s.manager.chatAttach(s.id)
  s.turnEnded = (since) => s.chat.find((c) => c.t >= since && c.e.type === 'turn' && c.e.status !== 'started')
  s.usage = async () => {
    await s.agy.account.refreshUsage(true)
    return s.agy.account.usage
  }
  s.close = async () => {
    await s.manager.shutdown().catch(() => {})
    s.agy.cli.killSync()
    await s.server.close().catch(() => {})
  }
  return s
}

let turnsSent = 0
class Stop extends Error {}

/** Every prompt goes through here: the budget is a hard limit. */
async function sendTurn(s, name, text) {
  if (turnsSent >= MAX_TURNS) throw new Stop(`turn budget (${MAX_TURNS}) used up before "${name}"`)
  turnsSent++
  log(`---- TURN ${turnsSent}/${MAX_TURNS}: ${name}`)
  await s.manager.chatSend(s.id, text)
}

/** The next card of the turn that began at `since`, or null when the turn ended without one. */
async function nextCard(s, since, what, seen = []) {
  const got = await until(() => s.permissions.find((p) => !seen.includes(p.id)) || (s.turnEnded(since) ? 'ended' : null), what, 150000)
  return got && got !== 'ended' ? got : null
}

/**
 * The answer of the turn that began at `since`, and how it ended. A failed turn stops the run (a
 * rate limit?). A card nobody planned for (the model made a tool call of its own) is denied, so the
 * turn still ends and its answer is still read.
 */
async function turnResult(s, since, name, ms = 180000) {
  const end = await until(() => {
    for (const p of s.manager.listPermissions()) {
      log(`${s.label} UNEXPECTED CARD during ${name}: ${p.toolName} | ${p.summary} -> denied`)
      s.manager.decide(p.id, { behavior: 'deny', message: 'Not needed for this check. Finish your answer without it.' })
    }
    return s.turnEnded(since)
  }, `${name} to end`, ms)
  if (!end) throw new Stop(`${name} did not end in time`)
  if (end.e.status === 'failed') throw new Stop(`${name} failed: ${end.e.error} (a rate limit? stopping here)`)
  await s.waitState('idle', 5000)
  await sleep(300)
  // By time, not by turn id: should agy ever answer an injected message as a turn of its own, its text still counts.
  const answers = s.items().filter((i) => i.kind === 'assistant' && i.ts >= since)
  const text = answers.map((a) => a.text).join('\n')
  info(`${name}: answer`, JSON.stringify(text.slice(0, 400)))
  return { status: end.e.status, turnId: end.e.turnId, text }
}

let closers = []
const SLOW = (seconds, word) => `node -e "setTimeout(()=>console.log('${word}'),${seconds * 1000})"`

async function main() {
  log(`scratch folder ${WORK}; app data ${USER_DATA}; model ${MODEL}; turn budget ${MAX_TURNS}; ${electronApp ? `Electron ${process.versions.electron}` : `Node ${process.version}`}`)
  const stack = await bundle()
  const watcher = await startWatcher()
  const a = await makeStack(stack, 'A')
  closers.push(a.close)

  // ---------------------------------------------------------------- free: provider, login, usage
  const providers = await a.manager.providers()
  const agy = providers.find((p) => p.id === 'antigravity')
  log(`PROVIDERS ${JSON.stringify(providers)}`)
  if (!check('provider: Antigravity available, with a version', agy.available && !!agy.version, agy.version || agy.reason)) throw new Stop('agy is not installed')
  check('login probe (`agy models`, no quota): signed in', agy.account && agy.account.loggedIn === true, JSON.stringify(agy.account))
  if (!agy.account || !agy.account.loggedIn) throw new Stop('agy is not signed in: run `agy` in a terminal and sign in with the personal Google account')
  check('no plan name is invented', agy.account.plan === undefined)
  const models = a.agy.account.current.models.map((m) => m.id)
  check(`model list has ${MODEL}`, models.includes(MODEL), models.join(' '))
  const usageBefore = await a.usage()
  check('usage (`/usage`, no quota): weekly window with a reset time', usageBefore && typeof usageBefore.usedPercent === 'number' && usageBefore.windowMinutes === 10080 && usageBefore.resetsAt > Date.now(), JSON.stringify(usageBefore))
  info('USAGE BEFORE', `${usageBefore ? usageBefore.usedPercent : '?'} % of the week used`)
  await a.manager.login('antigravity')
  check('login("antigravity") while signed in: resolves ("Check again" finds it signed in)', true)

  // The gate check against the real binary, for a folder that has NO hook: refused.
  const bare = path.join(USER_DATA, 'bare-folder')
  fs.mkdirSync(path.join(bare, '.agents'), { recursive: true })
  const none = await stack.probeAgyGate(a.agy.cli, WORK, { dir: bare, hooksFile: path.join(bare, '.agents', 'hooks.json'), files: [], hash: '' })
  check('gate check: a session folder without the hook is NOT accepted by the real agy answer', typeof none === 'string' && none.length > 0, String(none))

  // ---------------------------------------------------------------- start
  let t = Date.now()
  const started = await a.manager.start({ provider: 'antigravity', cwd: WORK, permissionMode: 'default', model: MODEL })
  a.id = started.id
  a.manager.chatAttach(a.id)
  a.manager.setSelected(a.id)
  log(`started session ${a.id} in ${Date.now() - t} ms: ${JSON.stringify(started)}`)
  check('session started: idle, surface chat, provider antigravity', started.state === 'idle' && started.surface === 'chat' && started.provider === 'antigravity')
  check('gate check ran once before the spawn', a.probes === 1, `${a.probes}`)
  check('title = the friendly model name', started.title === 'Gemini 3.8 Flash' || MODEL !== 'gemini-3.8-flash-low', started.title)
  const conversation = started.providerSessionId
  check('providerSessionId = agy conversation id (UUID)', /^[0-9a-f-]{36}$/.test(conversation || ''), conversation)
  check('world: manager spawned (idle, provider antigravity)', a.world[0] && a.world[0].agentId === a.id && a.world[0].provider === 'antigravity' && a.world[0].activity === 'idle')
  const sessionDir = path.join(USER_DATA, 'agy-sessions', a.id)
  check('session folder is under the app data folder, not in the project', fs.existsSync(path.join(sessionDir, '.agents', 'hooks.json')) && fs.readdirSync(WORK).length === 0, fs.readdirSync(path.join(sessionDir, '.agents')).join(' '))
  const secrets = fs.readdirSync(path.join(sessionDir, '.agents')).filter((f) => /[0-9a-f]{64}/.test(fs.readFileSync(path.join(sessionDir, '.agents', f), 'utf8')))
  check('no token in any file of the session folder', secrets.length === 0, secrets.join(' '))
  // What agy itself says about the hooks of this session (free): how long it lets the gate hold a call.
  const hooksAnswer = await a.agy.cli.run(['-p', '/hooks', '--output-format', 'json', '--add-dir', sessionDir], { cwd: WORK })
  let gateAction = null
  try {
    gateAction = JSON.parse(hooksAnswer.stdout).command.data.hooks.flatMap((h) => h.actions.map((x) => ({ ...x, hook: h.name, source: h.source }))).find((x) => x.event === 'PreToolUse')
  } catch {
    // logged below
  }
  info('agy /hooks answer for the session', gateAction ? JSON.stringify(gateAction) : hooksAnswer.stdout.slice(0, 600))
  check('agy reports the gate hook with the timeout the app asked for (3600 s)', gateAction && gateAction.timeout_seconds === 3600, gateAction ? `${gateAction.timeout_seconds} s` : '')
  const tree0 = agyTrees()
  info('process tree (idle)', tree0.map((p) => `${'  '.repeat(p.depth)}${p.name}(${p.pid}) ${p.mb} MB`).join(' | '))

  if (MAX_TURNS === 0) {
    info('turns', 'none (--free)')
  } else {
    // -------------------------------------------------------------- turn 1: allow a command, allow a file, the board
    t = Date.now()
    const CMD1 = `node -e "console.log('ao-one')"`
    await sendTurn(a, 'command + file + board, all allowed', [
      'Do these three steps in order, one tool call each.',
      `1. Run the shell command: ${CMD1}`,
      '2. Create the file ao-note.txt in the current folder containing exactly the two lines: hello and world',
      '3. Call the MCP tool board_read of the MCP server "agent_office".',
      'Then answer in one short line: the output of step 1, and the name of the desktop app you are running in.'
    ].join('\n'))
    const p1 = await nextCard(a, t, 'the command card')
    if (!check('turn 1: the command asks in the CEO inbox', !!p1, p1 ? `${p1.toolName} | ${p1.summary} | ${p1.question}` : '')) throw new Stop('no approval request for the command')
    check('card: Command, the exact command, plain question, risk normal', p1.toolName === 'Command' && p1.summary === `Command: ${CMD1}` && /wants to run/.test(p1.question) && p1.provider === 'antigravity', JSON.stringify({ q: p1.question, risk: p1.risk }))
    check('state waiting-permission; world: waiting', a.state() === 'waiting-permission' && a.world[a.world.length - 1].activity === 'waiting')
    check('nothing ran while the card is open (no output yet)', !a.items().some((i) => i.kind === 'command' && /ao-one/.test(i.output)))
    const held = Date.now()
    await sleep(3000) // the CEO takes a moment
    check('decide(allow) -> allowed', a.manager.decide(p1.id, { behavior: 'allow' }) === 'allowed')
    const p2 = await nextCard(a, t, 'the file card', [p1.id])
    if (!check('turn 1: the file creation asks in the CEO inbox', !!p2, p2 ? `${p2.toolName} | ${p2.summary} | ${p2.question}` : '')) throw new Stop('no approval request for the file')
    info('hook held', `${Date.now() - held} ms between the first card and the second`)
    const cmdItem = a.items().find((i) => i.kind === 'command' && i.command.includes('ao-one'))
    check('the allowed command ran: output in its card', cmdItem && cmdItem.status === 'done' && /ao-one/.test(cmdItem.output), cmdItem ? JSON.stringify({ status: cmdItem.status, output: cmdItem.output, cwd: cmdItem.cwd }) : '')
    check('card: Create/Write ao-note.txt with the content in the detail', /^(Create|Write)$/.test(p2.toolName) && /ao-note\.txt/.test(p2.summary) && /hello/.test(p2.detail) && /world/.test(p2.detail), JSON.stringify(p2.detail.slice(0, 200)))
    check('the file does not exist while its card is open', !fs.existsSync(path.join(WORK, 'ao-note.txt')))
    check('decide(allow) -> allowed', a.manager.decide(p2.id, { behavior: 'allow' }) === 'allowed')
    const r1 = await turnResult(a, t, 'turn 1')
    check('turn 1 completed', r1.status === 'completed')
    const note = fs.existsSync(path.join(WORK, 'ao-note.txt')) ? fs.readFileSync(path.join(WORK, 'ao-note.txt'), 'utf8') : null
    check('the file was written', note !== null && /hello/.test(note) && /world/.test(note), JSON.stringify(note))
    let items = a.items()
    const fileItem = items.find((i) => i.kind === 'file-change')
    check('chat: a file card with the content as a diff', fileItem && fileItem.status === 'done' && /\+hello/.test(fileItem.changes[0].diff) && /\+world/.test(fileItem.changes[0].diff), fileItem ? JSON.stringify(fileItem.changes[0]) : '')
    const boardItem = items.find((i) => i.kind === 'tool' && i.tool === 'board_read')
    check('the office board tool ran without a card (agy starts the MCP bridge of the session folder; the hook sees call_mcp_tool)', boardItem && boardItem.status === 'done' && boardItem.server === 'Office board', boardItem ? JSON.stringify({ status: boardItem.status, server: boardItem.server, result: (boardItem.result || boardItem.error || '').slice(0, 120) }) : 'no board_read tool step')
    check('exactly two cards were asked (the board tool needed none)', items.filter((i) => i.kind === 'approval').length === 2 && items.filter((i) => i.kind === 'approval').every((i) => i.outcome === 'allowed'))
    // Seen once with the real model: it took the app's session folder (a second workspace for agy) for "the current folder".
    const wrongFolder = items.filter((i) => i.kind === 'notice' && /belongs to Agent Office itself/.test(i.text)).length
    check('the model worked in the project folder (the briefing names it), not in the app’s session folder', wrongFolder === 0, `${wrongFolder} call(s) into the session folder were refused`)
    check('answer: the command output', /ao-one/.test(r1.text))
    // Not checks: both depend on how the model happens to answer. (Seen: "the desktop app is Agent Office" in one
    // run and "Antigravity" in another; a one-line answer may arrive as a single piece, without deltas.)
    info('answer names the app the briefing told it about', /agent office/i.test(r1.text) ? 'yes (Agent Office)' : 'no')
    info('assistant text deltas', String(a.chat.filter((c) => c.e.type === 'delta' && c.e.field === 'text').length))
    check('board: the created file is recorded for this team', a.board.snapshot().branches[0].files.some((f) => /ao-note\.txt$/.test(f.path)), JSON.stringify(a.board.snapshot().branches[0].files))
    const acts = a.world.map((e) => e.activity)
    check('world: exec, waiting, write, read (board), idle at the end', ['exec', 'waiting', 'write', 'idle'].every((x) => acts.includes(x)) && acts[acts.length - 1] === 'idle', acts.join('>'))
    info('USAGE after turn 1', JSON.stringify(await a.usage()))

    // -------------------------------------------------------------- turn 2: deny with a message (+ a prompt mid-turn)
    if (turnsSent < MAX_TURNS) {
      t = Date.now()
      await sendTurn(a, 'a command denied with a message', `Run the shell command: node -e "console.log('ao-two')"\nIf it is refused, do not try anything else: answer in one short line why it was refused.`)
      const p3 = await nextCard(a, t, 'the second command card')
      if (!check('turn 2: the command asks', !!p3, p3 ? p3.summary : '')) throw new Stop('no approval request')
      // A prompt typed while the turn waits: handed over at the turn's next model call.
      await a.manager.chatSend(a.id, 'Also: end your answer with the exact word steered-ok.')
      check('decide(deny, message) -> denied', a.manager.decide(p3.id, { behavior: 'deny', message: 'Not this one. Mention the word pineapple in your answer.' }) === 'denied')
      const r2 = await turnResult(a, t, 'turn 2')
      items = a.items()
      const denied = items.find((i) => i.kind === 'command' && i.command.includes('ao-two'))
      check('the denied command did not run: declined, with agy saying the hook denied it', denied && denied.status === 'declined' && /denied by pre-tool hook/.test(denied.output) && !/^ao-two/m.test(denied.output), denied ? JSON.stringify({ status: denied.status, output: denied.output }) : '')
      check('approval card outcome denied', items.filter((i) => i.kind === 'approval').pop().outcome === 'denied')
      check('the model read the deny message (its answer has the word)', /pineapple/i.test(r2.text), JSON.stringify(r2.text.slice(0, 200)))
      const steered = /steered-ok/i.test(r2.text)
      const turnsOfA = a.chat.filter((c) => c.t >= t && c.e.type === 'turn' && c.e.status === 'started').length
      info('STEER (PreInvocation userMessage)', steered ? 'the model took the mid-turn prompt into the running turn' : 'NOT seen in the answer: the mid-turn prompt did not shape the turn')
      check('the mid-turn prompt did not start a turn of its own', turnsOfA === 1, `${turnsOfA} turn(s) started`)
      a.steered = steered
      info('USAGE after turn 2', JSON.stringify(await a.usage()))
    }

    // -------------------------------------------------------------- turn 3: interrupt + respawn
    if (turnsSent < MAX_TURNS) {
      t = Date.now()
      const probesBefore = a.probes
      await sendTurn(a, 'a slow command, interrupted', `Run this shell command and wait until it has finished (do not run it in the background): ${SLOW(40, 'slow-done')}\nThen reply with its output.`)
      const p4 = await nextCard(a, t, 'the slow command card')
      if (!check('turn 3: the slow command asks', !!p4, p4 ? p4.summary : '')) throw new Stop('no approval request')
      a.manager.decide(p4.id, { behavior: 'allow' })
      await until(() => a.state() === 'busy', 'busy', 10000)
      await sleep(4000)
      const tree = agyTrees()
      info('process tree mid-command', tree.map((p) => `${'  '.repeat(p.depth)}${p.name}(${p.pid}) ${p.mb} MB`).join(' | '))
      const tInt = Date.now()
      a.manager.interrupt(a.id)
      const backIdle = await until(() => a.state() === 'idle' && a.chat.some((c) => c.t >= tInt && c.e.type === 'turn' && c.e.status === 'interrupted'), 'idle after the respawn', 90000)
      check('interrupt: turn interrupted, session idle again (respawned)', !!backIdle, `${Date.now() - tInt} ms`)
      if (!backIdle) throw new Stop(`the session did not come back after the interrupt (state ${a.state()}, notice ${JSON.stringify((a.row() || {}).notice)})`)
      items = a.items()
      const slow = items.find((i) => i.kind === 'command' && i.command.includes('slow-done'))
      check('the running command card is closed as interrupted', slow && slow.status === 'interrupted', slow ? slow.status : '')
      check('the gate was checked again before the respawn', a.probes === probesBefore + 1, `${a.probes - probesBefore}`)
      check('same conversation after the respawn', a.row().providerSessionId === conversation, a.row().providerSessionId)
      await sleep(1500)
      const left = tree.filter((p) => pidAlive(p.pid))
      check('the old process tree is gone (agy, its console host, the command and its children)', left.length === 0, left.map((p) => `${p.name}(${p.pid})`).join(' ') || `${tree.length} processes ended`)
      for (const p of left) {
        try {
          process.kill(p.pid)
        } catch {
          // gone
        }
      }
      check('no card left pending', a.manager.listPermissions().length === 0)
      await sleep(41000 - Math.min(41000, Date.now() - tInt))
      check('the interrupted command never printed its output (it was killed, not left running)', !a.items().some((i) => i.kind === 'command' && /slow-done/.test(i.output)))
    }

    // -------------------------------------------------------------- turn 4: the conversation continued
    if (turnsSent < MAX_TURNS) {
      t = Date.now()
      await sendTurn(a, 'follow-up after the respawn', 'Without running anything: what was the exact output of the very first shell command you ran in this conversation? Answer with just that output.')
      const r4 = await turnResult(a, t, 'turn 4')
      check('turn 4 completed in the respawned process', r4.status === 'completed')
      check('the conversation continued: the model remembers the first command’s output', /ao-one/.test(r4.text), JSON.stringify(r4.text.slice(0, 200)))
      check('no tool was needed (and none ran unasked)', a.manager.listPermissions().length === 0)
    }
  }

  // ---------------------------------------------------------------- stop
  const treeBeforeStop = agyTrees()
  await a.manager.stop(a.id)
  check('stop: session exited', a.state() === 'exited' || a.state() === undefined, String(a.state()))
  check('stop: world done', a.world[a.world.length - 1].activity === 'done')
  await sleep(1500)
  const alive = treeBeforeStop.filter((p) => pidAlive(p.pid))
  check('stop: no agy process left', alive.length === 0, alive.map((p) => `${p.name}(${p.pid})`).join(' '))
  check('stop: the session folder is removed and the hook token revoked', !fs.existsSync(sessionDir) && a.agyTokens.size === 0)
  const rec = a.store.get(a.id)
  check('the record is kept for a reopen, with the conversation id', rec && rec.providerSessionId === conversation && rec.status === 'recent', rec ? JSON.stringify({ status: rec.status, id: rec.providerSessionId }) : 'no record')
  a.store.flush()
  await a.close()

  // ---------------------------------------------------------------- a fresh stack: resume
  const b = await makeStack(stack, 'B')
  closers.push(b.close)
  b.id = a.id
  t = Date.now()
  const reopened = await b.manager.reopen(a.id)
  b.manager.chatAttach(b.id)
  check('fresh stack: the saved session is resumed with `--conversation` (same id, idle)', reopened.state === 'idle' && reopened.providerSessionId === conversation, `${Date.now() - t} ms, ${reopened.providerSessionId}`)
  check('fresh stack: the gate was checked before that spawn too', b.probes === 1, `${b.probes}`)
  check('fresh stack: the chat says it is a resumed conversation', b.items().some((i) => i.kind === 'notice' && /Resumed the earlier conversation/.test(i.text)))
  if (turnsSent < MAX_TURNS && turnsSent >= 1) {
    t = Date.now()
    await sendTurn(b, 'a turn after the resume in a fresh stack', 'Without running anything: which file did you create earlier in this conversation? Answer with just the file name.')
    const r5 = await turnResult(b, t, 'turn 5')
    check('after the resume the model still knows the conversation', /ao-note\.txt/.test(r5.text), JSON.stringify(r5.text.slice(0, 200)))
  }
  await b.manager.stop(b.id)

  // A conversation agy does not have: it would start a NEW one; the driver notices and refuses.
  t = Date.now()
  let gone = null
  try {
    await b.manager.start({ provider: 'antigravity', cwd: WORK, model: MODEL, resume: '00000000-0000-4000-8000-000000000000' })
  } catch (err) {
    gone = String(err && err.message)
  }
  check('resume of an unknown conversation: refused as "conversation gone" (and its process killed)', gone !== null && gone.includes(stack.AGY_CONVERSATION_GONE), `${gone} (${Date.now() - t} ms)`)
  check('…which the provider reports as gone (the restore contract)', b.agy.conversationGone({ error: gone || '' }) === true)
  await sleep(1500)
  const stray = agyTrees()
  check('no agy process left behind', stray.length === 0, stray.map((p) => `${p.name}(${p.pid})`).join(' '))

  const usageAfter = await b.usage()
  info('USAGE AFTER', `${usageAfter ? usageAfter.usedPercent : '?'} % of the week used (before: ${usageBefore ? usageBefore.usedPercent : '?'} %); real turns sent: ${turnsSent}`)
  await b.close()

  // ---------------------------------------------------------------- console windows
  if (watcher) {
    const wins = watcher.stop()
    const suspicious = wins.filter((w) => CONSOLE_CLASSES.includes(w.cls) || CONSOLE_PROCESSES.includes(String(w.name).toLowerCase()))
    for (const w of wins) log(`WINDOW ${w.visible ? 'VISIBLE' : 'hidden '} pid=${w.pid} ${w.name} class=${w.cls} title=${JSON.stringify(w.title)}`)
    const visible = suspicious.filter((w) => w.visible)
    check('no console window became visible while agy, its hooks and its commands ran', visible.length === 0, `${wins.length} new top-level windows in total, ${suspicious.length} console-related (${suspicious.filter((w) => !w.visible).length} hidden), ${visible.length} visible`)
  } else info('console windows', 'not checked (run under Electron on Windows for that)')

  log(`state sequence A: ${a.states.map((s) => s.state).join(' > ')}`)
  log(`world sequence A: ${a.world.map((e) => e.activity).join(' > ')}`)
  log(`conversation left in your agy history: ${conversation} (plus one empty one from the unknown-id check; remove them in the agy TUI: /resume, Ctrl+Delete)`)
  log(`scratch folder: ${WORK}`)
}

const guard = setTimeout(() => {
  log('GLOBAL TIMEOUT')
  void finish(2)
}, 14 * 60 * 1000)

async function finish(code) {
  for (const close of closers.splice(0)) await close().catch(() => {})
  try {
    if (watcherChild) watcherChild.kill()
  } catch {
    // gone
  }
  // Whatever of ours is still there (a failed run): no agy of this run may stay behind.
  for (const p of agyTrees()) {
    try {
      process.kill(p.pid)
    } catch {
      // gone
    }
  }
  clearTimeout(guard)
  const failed = checks.filter((c) => !c.ok)
  log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(' | ')}` : ''}; real turns sent: ${turnsSent}`)
  log(`log: ${logFile}`)
  const exit = code || (failed.length ? 1 : 0)
  setTimeout(() => (electronApp ? electronApp.exit(exit) : process.exit(exit)), 500)
}

async function run() {
  let code = 0
  try {
    await main()
  } catch (err) {
    if (err instanceof Stop) log(`STOPPED: ${err.message}`)
    else log(`ERROR ${err && err.stack ? err.stack : err}`)
    code = 1
  }
  await finish(code)
}

if (electronApp) electronApp.whenReady().then(run)
else void run()
