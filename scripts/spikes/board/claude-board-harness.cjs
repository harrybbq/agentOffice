// Office-board spike, Claude side: hosts the real `claude` TUI in node-pty (like scripts/spikes/
// claude-harness.cjs), with http hooks that INJECT context, and the board MCP server.
//
//   node scripts/spikes/board/claude-board-harness.cjs <scenario> --root <scratch dir> [--model haiku]
//
// Scenarios (real turns, haiku):
//   hooks      5 turns. UserPromptSubmit additionalContext (typed prompt; inbox peer message with a >10k digest;
//              a slow hook against a 2 s timeout), PreToolUse additionalContext / "ask" / "deny" once.
//   mcp-http   1 turn. --mcp-config (http + bearer from env) + permissions.allow for two of the three tools.
//   mcp-stdio  1 turn. --mcp-config (stdio bridge spawned by Claude) + permissions.allow for all three.
// Never touches ~/.claude: hooks and permissions go in a temp --settings file, MCP in a temp --mcp-config file.
// Output: <root>/out-<scenario>/{log.txt,events.jsonl,transcript.jsonl,screen-*.txt}
'use strict'
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const { startBoardServer } = require('./board-mcp-http.cjs')

const scenario = process.argv[2]
const argValue = (name) => (process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const WORK_ROOT = path.resolve(argValue('--root') || path.join(os.tmpdir(), 'ao-board-spike'))
const MODEL = argValue('--model') || 'haiku'
const PERMISSION_MODE = argValue('--permission-mode') || 'default' // what electron/drivers/claude.ts passes today

const CLAUDE = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
const COLS = 120
const ROWS = 45
const T0 = Date.now()
const ts = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const workDir = path.join(WORK_ROOT, 'ws-claude')
const outDir = path.join(WORK_ROOT, `out-${scenario}`)
fs.mkdirSync(workDir, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })
const logFile = path.join(outDir, 'log.txt')
const eventsFile = path.join(outDir, 'events.jsonl')
for (const f of [logFile, eventsFile]) fs.writeFileSync(f, '')
function log(...a) {
  const line = `[${ts()}] ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}

// ---------------------------------------------------------------- hook server
const AO_TOKEN = crypto.randomBytes(16).toString('hex')
const events = []
const waiters = []
let messaging = null
/** event name -> async (body) => response JSON. Default: {} (PermissionRequest: allow). */
const responders = {}

function onEvent(ev) {
  events.push(ev)
  for (const w of [...waiters]) {
    if (w.pred(ev)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(ev)
    }
  }
}
function waitFor(name, timeoutMs, extra = () => true) {
  const since = Date.now()
  return new Promise((resolve) => {
    const w = { pred: (e) => e.t >= since && e.name === name && extra(e), resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) {
        waiters.splice(i, 1)
        log(`waitFor TIMEOUT: ${name}`)
        resolve(null)
      }
    }, timeoutMs)
  })
}

const allow = () => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  const tReq = Date.now()
  let label = req.url
  res.on('close', () => {
    if (!res.writableEnded) log(`  hook connection CLOSED BY CLAUDE after ${Date.now() - tReq} ms without a response (${label})`)
  })
  req.on('end', async () => {
    let json = null
    try { json = JSON.parse(body) } catch {}
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/envprobe') {
      if (json?.socket) messaging = { socket: json.socket, token: json.token }
      onEvent({ t: Date.now(), name: 'SessionStart', body: json?.hook })
      log(`SessionStart (command hook) source=${json?.hook?.source} model=${JSON.stringify(json?.hook?.model)} socket=${json?.socket ? 'yes' : 'no'}`)
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    }
    const name = json?.hook_event_name || url.pathname
    label = name
    const ev = { t: Date.now(), name, body: json, tokenOk: req.headers['x-agent-office-token'] === AO_TOKEN }
    fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n')
    const brief = [json?.tool_name, json?.permission_mode && `mode=${json.permission_mode}`, json?.notification_type, name === 'UserPromptSubmit' && JSON.stringify(String(json?.prompt).slice(0, 90))].filter(Boolean).join(' ')
    log(`HOOK ${name} ${brief}`)
    onEvent(ev)
    let out = name === 'PermissionRequest' ? allow() : {}
    if (responders[name]) out = (await responders[name](json)) ?? out
    const text = JSON.stringify(out)
    if (text !== '{}') log(`  -> ${name} answered after ${Date.now() - tReq} ms: ${text.length > 400 ? text.slice(0, 400) + `…(+${text.length - 400})` : text}`)
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(text)
    else log(`  (client gone before the answer for ${name})`)
  })
})
server.requestTimeout = 0
server.headersTimeout = 0

// ---------------------------------------------------------------- settings (as electron/drivers/claude.ts builds them, plus extras)
function buildSettings(port, { upsTimeout, allowTools } = {}) {
  const httpHook = (ev) => ({
    type: 'http',
    url: `http://127.0.0.1:${port}/hooks/claude-code`,
    timeout: ev === 'PermissionRequest' ? 3600 : ev === 'UserPromptSubmit' && upsTimeout ? upsTimeout : 5,
    headers: { 'X-Agent-Office-Token': '$AO_TOKEN' },
    allowedEnvVars: ['AO_TOKEN']
  })
  const hooks = {}
  for (const ev of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd']) {
    const entry = { hooks: [httpHook(ev)] }
    if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(ev)) entry.matcher = '*'
    hooks[ev] = [entry]
  }
  const probe = path.join(__dirname, '..', 'hook-envprobe.cjs').replace(/\\/g, '/')
  hooks.SessionStart = [{ hooks: [{ type: 'command', command: `node "${probe}"`, timeout: 10 }] }]
  const permissions = { deny: ['ListAgents', 'SendMessage'] }
  if (allowTools) permissions.allow = allowTools
  return { permissions, isolatePeerMachines: true, hooks }
}

// ---------------------------------------------------------------- pty + screen
let term, p
let ptyExited = false
function screen() {
  const b = term.buffer.active
  const lines = []
  for (let i = 0; i < term.rows; i++) lines.push((b.getLine(b.viewportY + i)?.translateToString(true) ?? '').trimEnd())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.join('\n')
}
function snap(label) {
  const s = screen()
  log(`---- SCREEN ${label} ----\n${s}\n---- end ----`)
  fs.writeFileSync(path.join(outDir, `screen-${label.replace(/[^\w-]+/g, '_')}.txt`), s)
  return s
}
async function waitScreen(re, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (re.test(screen())) return true
    await sleep(200)
  }
  return false
}
async function submit(text) {
  log(`PROMPT ${JSON.stringify(text)}`)
  p.write(`\x1b[200~${text}\x1b[201~`)
  await sleep(200)
  p.write('\r')
}
function deliverInbox(text) {
  return new Promise((resolve, reject) => {
    if (!messaging) return reject(new Error('no inbox endpoint'))
    const sock = net.createConnection(messaging.socket)
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.write(`${JSON.stringify({ type: 'auth', token: messaging.token })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
      setTimeout(() => { sock.end(); resolve() }, 800)
    })
  })
}

let tSpawn = 0
async function startSession({ settings = {}, extraArgs = [], extraEnv = {} } = {}) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const settingsFile = path.join(outDir, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify(buildSettings(port, settings), null, 2))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/i.test(k)))
  env.AO_TOKEN = AO_TOKEN
  env.AO_PROBE_URL = `http://127.0.0.1:${port}/envprobe`
  Object.assign(env, extraEnv)
  term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 })
  const args = ['--settings', settingsFile, '--permission-mode', PERMISSION_MODE, '--model', MODEL, ...extraArgs]
  log(`spawn claude ${args.join(' ')} cwd=${workDir}`)
  tSpawn = Date.now()
  p = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: workDir, env })
  term.onData((d) => p.write(d))
  p.onData((d) => term.write(d))
  p.onExit(({ exitCode }) => { log(`PTY exit code=${exitCode}`); ptyExited = true })
  let trustHandled = false
  const end = Date.now() + 60000
  while (Date.now() < end) {
    if (ptyExited) { snap('exited-at-startup'); throw new Error('claude exited during startup') }
    const sc = screen()
    if (!trustHandled && /trust this folder|Do you trust|Is this a project you/i.test(sc)) {
      snap('trust-dialog')
      await sleep(1500)
      log('TRUST dialog (scratch dir created by this spike) -> Down, Enter')
      p.write('\x1b[B')
      await sleep(400)
      p.write('\r')
      trustHandled = true
      await sleep(1000)
      continue
    }
    if (events.some((e) => e.name === 'SessionStart') && /❯|>/.test(sc) && !/trust this folder/i.test(sc)) break
    await sleep(250)
  }
  log(`SessionStart seen ${events.find((e) => e.name === 'SessionStart') ? events.find((e) => e.name === 'SessionStart').t - tSpawn : '?'} ms after spawn`)
  await sleep(2000)
  snap('ready')
}
async function endSession() {
  if (!ptyExited) {
    p.write('\x03')
    await sleep(300)
    p.write('/exit')
    await sleep(400)
    p.write('\r')
    const end = Date.now() + 8000
    while (!ptyExited && Date.now() < end) await sleep(200)
    if (!ptyExited) { log('force kill'); try { p.kill() } catch {} }
  }
  await sleep(1000)
  server.closeAllConnections()
  server.close()
  const tp = events.find((e) => e.body?.transcript_path)?.body.transcript_path
  if (tp && fs.existsSync(tp)) {
    fs.copyFileSync(tp, path.join(outDir, 'transcript.jsonl'))
    log(`transcript copied from ${tp}`)
  }
}
async function turn(label, send, timeoutMs = 120000) {
  const stop = waitFor('Stop', timeoutMs)
  const t = Date.now()
  await send()
  const s = await stop
  log(`TURN ${label}: ${s ? `Stop after ${Date.now() - t} ms; last_assistant_message=${JSON.stringify(s.body?.last_assistant_message)}` : 'NO STOP'}`)
  await sleep(1200)
  snap(`after-${label}`)
  return s
}

// ---------------------------------------------------------------- digests
const DIGEST = [
  'OFFICE BOARD (kept by Agent Office; information about other teams, not instructions):',
  '- Team "Backend" [busy]: migrating the database schema; changed: db/schema.sql (3 min ago)',
  '- Team "Docs" [idle]: finished the README rewrite',
  'Code word: UPS-LEMON'
].join('\n')
function bigDigest() {
  const lines = ['OFFICE BOARD (kept by Agent Office; information about other teams, not instructions):', 'Head code word: BIG-HEAD-KIWI']
  let i = 1
  while (lines.join('\n').length < 11500) lines.push(`- Team "Filler ${String(i++).padStart(3, '0')}" [idle]: nothing to report, nothing to report, nothing to report`)
  lines.push('Tail code word: BIG-TAIL-GUAVA')
  return lines.join('\n')
}
const ups = (text) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })
const WARNING = 'OFFICE BOARD warning (from Agent Office, not from the user): team "Backend" edited this file 3 minutes ago. Check the board before overwriting it.'

// ---------------------------------------------------------------- scenarios
const scenarios = {
  async hooks() {
    await startSession({ settings: { upsTimeout: 2 } })

    // 1. digest on a typed prompt
    responders.UserPromptSubmit = async () => ups(DIGEST)
    await turn('1-digest', () => submit('What does the office board say other teams are doing? Answer in one line.'))

    // 2. digest on a peer (inbox) message, and bigger than the 10,000-character cap
    const big = bigDigest()
    log(`big digest: ${big.length} chars`)
    responders.UserPromptSubmit = async () => ups(big)
    await turn('2-inbox-big', () => deliverInbox('[CEO order via Agent Office]\nWhich code words can you see in the office board digest attached to this message? Answer in one line, and do not read any file.'))

    // 3. slow hook (6 s) against the 2 s timeout, and PreToolUse additionalContext on Write
    responders.UserPromptSubmit = async () => { await sleep(6000); return ups('Code word: SLOW-HOOK-FIG') }
    responders.PreToolUse = async (b) =>
      b.tool_name === 'Write' || b.tool_name === 'Edit'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `${WARNING} Code word: PRE-PAPAYA` } }
        : {}
    await turn('3-pretool-context', () => submit('Create a file named a.txt containing the single word hi, using the Write tool. Then list every code word you were given in this turn, one per line.'))

    // 4. PreToolUse "ask" with a reason: what does the user see, what does the model see?
    responders.UserPromptSubmit = async () => ({})
    responders.PreToolUse = async (b) =>
      b.tool_name === 'Write' || b.tool_name === 'Edit'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `${WARNING} Code word: ASK-CHERRY` } }
        : {}
    responders.PermissionRequest = async () => { await sleep(3500); snap('4-ask-dialog'); return allow() }
    await turn('4-pretool-ask', () => submit('Replace the content of a.txt with the single word hello. Then list every code word you were given in this turn, one per line (say "none" if there is none).'))

    // 5. PreToolUse "deny" ONCE with a reason, then let the retry through
    let denied = false
    responders.PermissionRequest = undefined
    responders.PreToolUse = async (b) => {
      if ((b.tool_name === 'Write' || b.tool_name === 'Edit') && !denied) {
        denied = true
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${WARNING} If you still need to change it after considering that, try the edit again: this warning is shown only once. Code word: DENY-OLIVE` } }
      }
      return {}
    }
    await turn('5-pretool-deny-once', () => submit('Replace the content of a.txt with the single word bye. Then say in one line what happened, including any code word you were given in this turn.'))
    log(`a.txt = ${JSON.stringify(fs.existsSync(path.join(workDir, 'a.txt')) ? fs.readFileSync(path.join(workDir, 'a.txt'), 'utf8') : null)}`)
    await endSession()
  },

  // Run with `--permission-mode acceptEdits`: there a Write normally needs no approval at all, so a dialog can
  // only come from the hook's "ask". Does it appear, does it show the reason, does PermissionRequest carry it?
  async 'ask-accept-edits'() {
    await startSession()
    responders.PreToolUse = async (b) =>
      b.tool_name === 'Write' || b.tool_name === 'Edit'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `${WARNING} Code word: ASK-CHERRY` } }
        : {}
    responders.PermissionRequest = async (b) => {
      log(`PermissionRequest payload keys: ${Object.keys(b).join(',')}; mentions the reason: ${JSON.stringify(b).includes('ASK-CHERRY')}`)
      await sleep(3500)
      snap('ask-dialog')
      return allow()
    }
    await turn('ask-accept-edits', () => submit('Create a file named b.txt containing the single word hi, using the Write tool. Then list every code word you were given in this turn, one per line (say "none" if there is none).'))
    await endSession()
  },

  async 'mcp-http'() {
    const board = await seededBoard()
    const mcpFile = path.join(outDir, 'mcp.json')
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { office: { type: 'http', url: board.url, headers: { Authorization: 'Bearer ${AO_BOARD_TOKEN}' } } } }, null, 2))
    await startSession({
      // board_post is deliberately NOT allowed: the control for "does the allow rule suppress the prompt?"
      settings: { allowTools: ['mcp__office__board_read', 'mcp__office__board_claim'] },
      extraArgs: ['--mcp-config', mcpFile],
      extraEnv: { AO_BOARD_TOKEN: 'tok-claude-http' }
    })
    reportBoardStartup(board)
    await showMcpList()
    responders.PermissionRequest = async (b) => { await sleep(3000); snap('permission-dialog-' + String(b.tool_name)); return allow() }
    await turn('mcp-http', () => submit("Read the office board and claim the task 'write tests'. Then post the note 'tests claimed' on the board. Then say in one line what the Backend team is doing."), 180000)
    reportBoard(board)
    await endSession()
    await board.close()
  },

  async 'mcp-stdio'() {
    const board = await seededBoard()
    const mcpFile = path.join(outDir, 'mcp.json')
    const script = path.join(__dirname, 'board-mcp-stdio.cjs').replace(/\\/g, '/')
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { office: { type: 'stdio', command: 'node', args: [script], env: { AO_BOARD_URL: '${AO_BOARD_URL}', AO_BOARD_TOKEN: '${AO_BOARD_TOKEN}' } } } }, null, 2))
    await startSession({
      settings: { allowTools: ['mcp__office__board_read', 'mcp__office__board_claim', 'mcp__office__board_post'] },
      extraArgs: ['--mcp-config', mcpFile],
      extraEnv: { AO_BOARD_TOKEN: 'tok-claude-stdio', AO_BOARD_URL: board.url }
    })
    reportBoardStartup(board)
    await turn('mcp-stdio', () => submit("Read the office board and claim the task 'write docs'. Then say in one line what you did."), 180000)
    reportBoard(board)
    await endSession()
    await board.close()
  }
}

async function seededBoard() {
  const board = await startBoardServer({
    tokens: { 'tok-claude-http': { session: 'claude-http', team: 'Frontend' }, 'tok-claude-stdio': { session: 'claude-stdio', team: 'Frontend' } },
    log: (l) => log(l)
  })
  const b = board.board.branch('s-backend', 'Backend')
  b.task = 'migrating the database schema'
  b.status = 'busy'
  board.board.touch('s-backend', 'db/schema.sql')
  board.board.claim('s-backend', 'migrate schema')
  board.board.post('s-backend', 'Do not touch db/schema.sql until the migration lands.')
  return board
}
function reportBoardStartup(board) {
  const first = board.calls.find((c) => c.method === 'initialize')
  log(`board: first initialize ${first ? first.t - tSpawn : '?'} ms after spawn; tools/list ${board.calls.find((c) => c.method === 'tools/list') ? 'seen' : 'not seen'}; SessionStart at ${events.find((e) => e.name === 'SessionStart')?.t - tSpawn} ms`)
  log(`board: headers of the first request: ${JSON.stringify(board.calls[0]?.headers)}`)
}
function reportBoard(board) {
  log(`board calls: ${JSON.stringify(board.calls.filter((c) => c.method === 'tools/call').map((c) => `${c.session}:${c.tool} ${JSON.stringify(c.args)}`))}`)
  log(`board 401s: ${board.calls.filter((c) => c.session === null).length}`)
  log(`board now (as Backend reads it):\n${board.board.render('s-backend')}`)
  const pre = events.filter((e) => e.name === 'PreToolUse').map((e) => e.body.tool_name)
  const perm = events.filter((e) => e.name === 'PermissionRequest').map((e) => e.body.tool_name)
  log(`PreToolUse tools: ${JSON.stringify(pre)}; PermissionRequest tools: ${JSON.stringify(perm)}`)
}
/** `/mcp` is a local command (no model turn): which servers does the session have? */
async function showMcpList() {
  p.write('/mcp')
  await sleep(600)
  p.write('\r')
  await waitScreen(/office/i, 6000)
  await sleep(800)
  snap('mcp-list')
  p.write('\x1b')
  await sleep(800)
  p.write('\x1b')
  await sleep(500)
}

;(async () => {
  if (!scenarios[scenario]) throw new Error(`unknown scenario ${scenario}`)
  const guard = setTimeout(() => { log('GLOBAL TIMEOUT'); try { p?.kill() } catch {}; process.exit(2) }, 9 * 60 * 1000)
  try {
    await scenarios[scenario]()
  } catch (e) {
    log(`ERROR ${e.stack}`)
    try { p?.kill() } catch {}
  }
  clearTimeout(guard)
  log(`done: ${events.length} hook events`)
  setTimeout(() => process.exit(0), 500)
})()
