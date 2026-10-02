// Phase-A spike harness: hosts the real `claude` TUI in node-pty, injects http hooks via --settings,
// logs every hook payload, answers PermissionRequest, renders the screen with @xterm/headless.
//
//   node scripts/spikes/claude-harness.cjs <scenario> [--xterm <path to @xterm/headless>]
//
// Scenarios: events | permissions | inject | inbox | interrupt (see bottom of file).
// Never touches ~/.claude/settings.json: hooks go in a temp file passed to --settings.
// Run from a plain Node 24 (spike 1 separately proves node-pty under Electron's utilityProcess).
'use strict'
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const pty = require('node-pty')

const scenario = process.argv[2]
const xtermPath = argValue('--xterm') || '@xterm/headless'
const WORK_ROOT = argValue('--root') || path.join(os.tmpdir(), 'agent-office-spikes')
const { Terminal } = require(xtermPath)

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const CLAUDE = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
const COLS = 120
const ROWS = 40
const T0 = Date.now()
const ts = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const redact = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 4)}…(${s.length} chars)` : s)

const workDir = path.join(WORK_ROOT, 'ws') // shared across scenarios so trust is asked once
const outDir = path.join(WORK_ROOT, `out-${scenario}`)
fs.mkdirSync(workDir, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })
const logFile = path.join(outDir, 'log.txt')
const eventsFile = path.join(outDir, 'events.jsonl')
const rawFile = path.join(outDir, 'pty-raw.txt')
for (const f of [logFile, eventsFile, rawFile]) fs.writeFileSync(f, '')
function log(...a) {
  const line = `[${ts()}] ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}

// ---------------------------------------------------------------- hook server
const AO_TOKEN = crypto.randomBytes(16).toString('hex')
const events = [] // { t, name, body, headers }
const waiters = []
let permissionResponder = async () => ({})
let messaging = null // { socket, token } learned from hooks

function onEvent(ev) {
  events.push(ev)
  for (const w of [...waiters]) {
    if (w.pred(ev)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(ev)
    }
  }
}
function waitFor(pred, timeoutMs, label) {
  const hit = events.find((e) => e.t >= (pred.since ?? 0) && pred(e))
  if (hit && !pred.fresh) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const w = { pred, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) {
        waiters.splice(i, 1)
        log(`waitFor TIMEOUT: ${label}`)
        resolve(null)
      }
    }, timeoutMs)
  })
}
const isEv = (name, extra = () => true) => {
  const since = Date.now()
  const p = (e) => e.t >= since && e.name === name && extra(e)
  p.fresh = true
  return p
}

function sanitizeHeaders(h) {
  const out = {}
  for (const [k, v] of Object.entries(h)) {
    if (/token/i.test(k)) out[k] = v ? (v === AO_TOKEN ? '<AO_TOKEN ok>' : redact(v)) : v
    else out[k] = v
  }
  return out
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    const t = Date.now()
    let json = null
    try { json = JSON.parse(body) } catch {}
    const tokenOk = req.headers['x-agent-office-token'] === AO_TOKEN
    if (url.pathname === '/envprobe') {
      // from the command-hook fallback script
      if (json?.socket) messaging = messaging || { socket: json.socket, token: json.token, via: 'command' }
      const ev = { t, name: 'EnvProbe(command hook)', body: { ...json, token: redact(json?.token) }, headers: sanitizeHeaders(req.headers), tokenOk }
      fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n')
      log(`EnvProbe label=${json?.label} hookKeys=[${Object.keys(json?.hook||{}).join(',')}] source=${json?.hook?.source} socket=${json?.socket} token=${redact(json?.token)} tokenOk=${tokenOk}`)
      onEvent(ev)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    const name = json?.hook_event_name || url.pathname
    const hs = req.headers['x-msg-socket']
    const ht = req.headers['x-msg-token']
    if (hs && ht && !hs.startsWith('$')) messaging = messaging || { socket: hs, token: ht, via: 'header' }
    const ev = { t, name, body: json, headers: sanitizeHeaders(req.headers), tokenOk }
    fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n')
    const brief = [json?.tool_name, json?.agent_id && `agent_id=${json.agent_id}`, json?.agent_type && `agent_type=${json.agent_type}`, json?.notification_type, json?.source]
      .filter(Boolean).join(' ')
    log(`HOOK ${name} ${brief} keys=[${Object.keys(json || {}).join(',')}] tokenOk=${tokenOk}`)
    onEvent(ev)
    let out = {}
    if (name === 'PermissionRequest') {
      out = await permissionResponder(json)
      log(`  -> PermissionRequest answered after ${Date.now() - t} ms: ${JSON.stringify(out)}`)
    }
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    else log(`  (client gone before answer for ${name})`)
  })
  // When Claude Code abandons a pending hook (dialog answered in the TUI, hook timeout, interrupt) it
  // closes the socket: that is the app's signal to dismiss its own approval card.
  const tReq = Date.now()
  res.on('close', () => { if (!res.writableEnded) log(`  hook connection CLOSED BY CLAUDE after ${Date.now() - tReq} ms without a response`) })
})
server.requestTimeout = 0
server.headersTimeout = 0

// ---------------------------------------------------------------- settings
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd']
function buildSettings(port, { permissionTimeout } = {}) {
  const httpHook = (ev) => {
    const h = {
      type: 'http',
      url: `http://127.0.0.1:${port}/hooks/claude-code`,
      headers: {
        'X-Agent-Office-Token': '$AO_TOKEN',
        'X-Msg-Socket': '$CLAUDE_CODE_MESSAGING_SOCKET',
        'X-Msg-Token': '$CLAUDE_CODE_MESSAGING_TOKEN'
      },
      allowedEnvVars: ['AO_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']
    }
    if (ev === 'PermissionRequest' && permissionTimeout) h.timeout = permissionTimeout
    return h
  }
  const hooks = {}
  for (const ev of HOOK_EVENTS) {
    const entry = { hooks: [httpHook(ev)] }
    if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(ev)) entry.matcher = '*'
    hooks[ev] = [entry]
  }
  // Fallback for the inbox endpoint: a command hook reads the env vars and POSTs them.
  const probe = path.join(__dirname, 'hook-envprobe.cjs').replace(/\\/g, '/')
  hooks.SessionStart[0].hooks.push({ type: 'command', command: `node "${probe}"`, timeout: 10 })
  return { hooks }
}

// ---------------------------------------------------------------- pty + screen
let term, p, raw = ''
let bracketedOn = false
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
async function waitScreen(re, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (re.test(screen())) return true
    await sleep(200)
  }
  log(`waitScreen TIMEOUT: ${label}`)
  return false
}
function paste(text) {
  p.write(`\x1b[200~${text}\x1b[201~`)
}
async function pasteAndSubmit(text, label) {
  log(`PASTE (${text.length} chars) ${label || JSON.stringify(text.slice(0, 60))}`)
  paste(text)
  await sleep(150)
  p.write('\r')
}
function deliverInbox(text, format = 'json') {
  // Wire protocol (from Claude Code's own `[uds-messaging] Inject messages` debug recipe): an auth line,
  // then ONE JSON line shaped like an SDK user message. A plain-text line (what electron/sessionInbox.ts
  // sends today, format 'plain') is silently dropped - see the first `inject` run.
  return new Promise((resolve, reject) => {
    if (!messaging) return reject(new Error('no messaging endpoint known'))
    const sock = net.createConnection(messaging.socket)
    let reply = ''
    sock.on('data', (d) => (reply += d))
    sock.once('error', (e) => reject(e))
    sock.once('connect', () => {
      const line = format === 'json' ? JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) : text.replace(/\r?\n/g, ' ')
      sock.write(`${JSON.stringify({ type: 'auth', token: messaging.token })}\n${line}\n`)
      setTimeout(() => { sock.end(); resolve(reply) }, 800)
    })
  })
}

async function startSession(settingsOpts = {}, extraArgs = []) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  log(`hook server on 127.0.0.1:${port}`)
  const settingsFile = path.join(outDir, 'settings.json')
  const settings = buildSettings(port, settingsOpts)
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  // Scrub the parent Claude Code session's env so nothing leaks into the child (gotcha when the
  // app is launched from a Claude Code terminal).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/i.test(k)))
  env.AO_TOKEN = AO_TOKEN
  env.AO_PROBE_URL = `http://127.0.0.1:${port}/envprobe`
  env.FORCE_COLOR = '1'
  term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 })
  const args = ['--settings', settingsFile, '--permission-mode', 'default', ...extraArgs]
  log(`spawn ${CLAUDE} ${args.join(' ')} cwd=${workDir}`)
  p = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: workDir, env })
  // Let xterm answer terminal queries (DA, DSR, ...) back to the app, like the real embedded xterm.
  term.onData((d) => p.write(d))
  p.onData((d) => {
    raw += d
    fs.appendFileSync(rawFile, d)
    term.write(d)
    if (!bracketedOn && d.includes('\x1b[?2004h')) { bracketedOn = true; log('PTY: saw ESC[?2004h (bracketed paste enabled)') }
  })
  p.onExit(({ exitCode }) => { log(`PTY exit code=${exitCode}`); ptyExited = true })
  // Folder trust dialog: appears in a never-trusted cwd before the session starts.
  let trustHandled = false
  const end = Date.now() + 60000
  while (Date.now() < end) {
    if (ptyExited) throw new Error("claude exited during startup")
    const sc = screen()
    if (!trustHandled && /trust this folder|Do you trust|Is this a project you/i.test(sc)) {
      snap('trust-dialog')
      // Default selection is 'No, exit'. Input sent in the first ~1.5 s is dropped, so wait, then Down + Enter.
      await sleep(1500)
      log('TRUST dialog shown -> sending Down arrow then CR (select "Yes, I trust this folder")')
      p.write(String.fromCharCode(27) + '[B')
      await sleep(400)
      snap('trust-dialog-after-down')
      p.write(String.fromCharCode(13))
      trustHandled = true
      await sleep(1000)
      continue
    }
    if (events.some((e) => e.name === 'SessionStart' || e.name.startsWith('EnvProbe')) && /❯|>/.test(sc) && !/trust this folder/i.test(sc)) break
    await sleep(250)
  }
  await waitScreen(/❯|>/, 15000, 'prompt box')
  await sleep(1500)
  log(`ready: bracketedPaste=${bracketedOn} messaging=${messaging ? messaging.via + ' ' + messaging.socket : 'none'}`)
  snap('ready')
}
let ptyExited = false
async function endSession() {
  if (!ptyExited) {
    log('sending /exit')
    p.write('/exit')
    await sleep(400)
    p.write('\r')
    const end = Date.now() + 8000
    while (!ptyExited && Date.now() < end) await sleep(200)
    if (!ptyExited) { log('force kill'); try { p.kill() } catch {} }
  }
  await sleep(1500)
  server.closeAllConnections()
  server.close()
  summarizeTranscript()
}
function transcriptPath() {
  return events.find((e) => e.body?.transcript_path)?.body.transcript_path
}
function summarizeTranscript() {
  const tp = transcriptPath()
  if (!tp || !fs.existsSync(tp)) return log('no transcript found')
  fs.copyFileSync(tp, path.join(outDir, 'transcript.jsonl'))
  const subDir = path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents')
  if (fs.existsSync(subDir)) for (const f of fs.readdirSync(subDir)) fs.copyFileSync(path.join(subDir, f), path.join(outDir, `sub-${f}`))
  log(`transcript copied from ${tp}`)
}

// ---------------------------------------------------------------- permission decisions
const allow = () => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
const deny = (message) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', ...(message ? { message } : {}) } } })

// ---------------------------------------------------------------- scenarios
const scenarios = {
  // Spike 2 + 5: payloads for every event, subagent agent_id, env interpolation, idle_prompt timing.
  async events() {
    permissionResponder = async () => allow()
    // Merge test: a PROJECT settings file inside the throwaway workdir (never the user's files)
    // with its own SessionStart command hook. If both it and the --settings hooks fire, they merge.
    const probe = path.join(__dirname, 'hook-envprobe.cjs').replace(/\\/g, '/')
    fs.mkdirSync(path.join(workDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(workDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${probe}" project-settings`, timeout: 10 }] }] }
    }, null, 2))
    fs.writeFileSync(path.join(workDir, 'hello.txt'), 'hello\n')
    fs.writeFileSync(path.join(workDir, 'notes.md'), '# notes\n')
    await startSession()
    const t = Date.now()
    await pasteAndSubmit('Use the Agent tool to have a subagent list files in this folder, then stop.')
    await waitFor(isEv('Stop'), 180000, 'Stop')
    log(`turn took ${Date.now() - t} ms`)
    snap('after-turn')
    log('idling 100 s to observe Notification idle_prompt')
    await waitFor(isEv('Notification', (e) => e.body?.notification_type === 'idle_prompt'), 100000, 'idle_prompt')
    snap('after-idle')
    await endSession()
  },

  // Spike 3: allow, deny, 20 s hold, hold beyond hook timeout.
  // NOTE: read-only commands such as \x\ are auto-allowed in default mode and never raise a
  // PermissionRequest, so the prompts use \, which does need approval.
  async permissions() {
    await startSession({ permissionTimeout: 30 })
    const cmd = (tag) => 'Run this exact shell command once and report its output: node -e "console.log(\'agent-office-' + tag + '\')"'
    const DIALOG = /Do you want to proceed|Do you want to allow|Yes, and don|1\. Yes/i

    permissionResponder = async () => { await sleep(1500); snap('allow-while-pending-1.5s'); return allow() }
    await pasteAndSubmit(cmd('allow'))
    await waitFor(isEv('Stop'), 120000, 'Stop allow')
    await sleep(500); snap('after-allow')

    permissionResponder = async () => deny('Denied from the Agent Office CEO desk (spike).')
    await pasteAndSubmit(cmd('deny'))
    await waitFor(isEv('Stop'), 120000, 'Stop deny')
    await sleep(500); snap('after-deny')

    permissionResponder = async () => {
      await sleep(3000); snap('slow-hold-3s')
      await sleep(10000); snap('slow-hold-13s')
      await sleep(7000)
      return allow()
    }
    await pasteAndSubmit(cmd('slow'))
    await waitFor(isEv('Stop'), 120000, 'Stop slow')
    await sleep(500); snap('after-slow')

    // Hook timeout is 30 s; hold 45 s.
    permissionResponder = async () => {
      await sleep(25000); snap('timeout-25s')
      await sleep(8000); const s = snap('timeout-33s')
      if (DIALOG.test(s)) { log('native dialog visible after hook timeout -> pressing Esc (reject)'); await sleep(1000); p.write(String.fromCharCode(27)) }
      await sleep(12000)
      return allow()
    }
    await pasteAndSubmit(cmd('timeout'))
    await waitFor(isEv('Stop'), 120000, 'Stop timeout')
    await sleep(2000); snap('after-timeout')
    await endSession()
  },

  // Spike 4: inbox socket idle + mid-turn, bracketed paste short + 1500 chars.
  async inject() {
    permissionResponder = async () => allow()
    await startSession()
    log(`inbox endpoint via=${messaging?.via} socket=${messaging?.socket}`)
    // (a) idle
    const r1 = await deliverInbox('Reply with exactly the words: inbox-idle-ok').catch((e) => `ERR ${e.message}`)
    log(`inbox idle reply=${JSON.stringify(r1)}`)
    const ups = await waitFor(isEv('UserPromptSubmit'), 20000, 'UPS from inbox idle')
    await waitFor(isEv('Stop'), 90000, 'Stop inbox idle')
    snap('after-inbox-idle')
    // (a) mid-turn: two sequential tool calls, inject after first PreToolUse
    await pasteAndSubmit('Run the shell command "ping -n 6 127.0.0.1", and after it finishes run the shell command "echo second-step". Run them one at a time, not in parallel.')
    await waitFor(isEv('PreToolUse'), 60000, 'PreToolUse 1')
    await sleep(1000)
    const r2 = await deliverInbox('Also, at the very end, say the word: inbox-midturn-ok').catch((e) => `ERR ${e.message}`)
    log(`inbox midturn reply=${JSON.stringify(r2)}`)
    await sleep(1500)
    snap('inbox-midturn-just-after')
    await waitFor(isEv('Stop'), 120000, 'Stop midturn')
    snap('after-inbox-midturn')
    // (b) bracketed paste short
    await pasteAndSubmit('Reply with exactly: paste-short-ok')
    await waitFor(isEv('Stop'), 90000, 'Stop paste short')
    snap('after-paste-short')
    // (b) bracketed paste 1500 chars multi-line
    const lines = ['BEGIN-LONG-PASTE: count the lines that start with "item" below and reply with only that number.']
    let i = 1
    while (lines.join('\n').length < 1450) lines.push(`item ${String(i++).padStart(2, '0')}: the quick brown fox jumps over the lazy dog, again and again.`)
    lines.push('END-LONG-PASTE')
    const long = lines.join('\n')
    fs.writeFileSync(path.join(outDir, 'long-paste.txt'), long)
    log(`long paste: ${long.length} chars, ${lines.length} lines, ${i - 1} items`)
    paste(long)
    await sleep(600)
    snap('long-paste-before-enter')
    p.write('\r')
    const ups2 = await waitFor(isEv('UserPromptSubmit'), 20000, 'UPS long')
    if (ups2) {
      const got = ups2.body?.prompt ?? ''
      log(`long paste UPS prompt length=${got.length} identical=${got === long} identicalCRLF=${got === long.replace(/\n/g, '\r\n')} head=${JSON.stringify(got.slice(0, 80))}`)
    }
    await waitFor(isEv('Stop'), 90000, 'Stop long')
    snap('after-long-paste')
    await endSession()
  },

  // Spike 4a (rerun with the correct JSON line format): inbox socket while idle and mid-turn.
  async inbox() {
    permissionResponder = async () => allow()
    await startSession()
    const r1 = await deliverInbox('Reply with exactly the words: inbox-idle-ok\n(second line of the order)').catch((e) => 'ERR ' + e.message)
    log('inbox idle (json line) reply=' + JSON.stringify(r1))
    const ups = await waitFor(isEv('UserPromptSubmit'), 15000, 'UPS from inbox idle')
    log('UPS from inbox idle: ' + (ups ? JSON.stringify(ups.body.prompt).slice(0, 600) : 'none'))
    await sleep(1200); snap('inbox-idle-during')
    await waitFor(isEv('Stop'), 60000, 'Stop inbox idle')
    await sleep(500); snap('after-inbox-idle')

    await pasteAndSubmit('Run the shell command "ping -n 6 127.0.0.1", and after it finishes run the shell command "echo second-step". Run them one at a time, not in parallel.')
    await waitFor(isEv('PreToolUse'), 60000, 'PreToolUse 1')
    await sleep(1500)
    const nUps = events.filter((e) => e.name === 'UserPromptSubmit').length
    const r2 = await deliverInbox('Also, at the very end, say the word: inbox-midturn-ok').catch((e) => 'ERR ' + e.message)
    log('inbox midturn reply=' + JSON.stringify(r2))
    await sleep(1500); snap('inbox-midturn-just-after')
    await waitFor(isEv('Stop'), 120000, 'Stop midturn')
    await sleep(3000); snap('after-inbox-midturn')
    // a queued message may start a follow-up turn; give it a moment
    if (events.filter((e) => e.name === 'UserPromptSubmit').length > nUps) await waitFor(isEv('Stop'), 30000, 'Stop follow-up')
    await sleep(1000); snap('inbox-final')
    await endSession()
  },

  // Spike 6: Esc and Ctrl+C interrupts.
  async interrupt() {
    // First: hook timeout (10 s) shorter than the hold (25 s), then approve from the TUI dialog by keystroke.
    await startSession({ permissionTimeout: 10 })
    // Free probe (nothing is submitted): which paste sizes collapse into a "[Pasted text]" placeholder?
    const probes = { 'oneline-400': 'x'.repeat(400), 'oneline-900': 'y'.repeat(900), 'oneline-1100': 'w'.repeat(1100), '2lines-60': 'aaa bbb ccc ddd eee fff ggg\nhhh iii jjj kkk lll mmm nnn', '3lines-90': 'l1 aaaaaaaaaaaaaaaaaaaaaaaaaaa\nl2 bbbbbbbbbbbbbbbbbbbbbbbbbbb\nl3 ccccccccccccccccccccccccccc', '4lines-40': 'a1\nb2\nc3\nd4 dddddddddddddddddddddddddddddd' }
    for (const [label, text] of Object.entries(probes)) {
      paste(text)
      await sleep(700)
      const sc = screen()
      log(`paste probe ${label} (${text.length} chars, ${text.split('\n').length} lines): placeholder=${/\[Pasted text/.test(sc)} ${(sc.match(/\[Pasted text[^\]]*\]/) || [''])[0]}`)
      p.write('\x03') // Ctrl+C with a non-empty input box clears it
      await sleep(700)
      if (/\[Pasted text|xxxx|yyyy|wwww|aaa bbb|l1 aaa|d4 ddd/.test(screen())) { log('input not cleared by Ctrl+C; sending Ctrl+U / Esc Esc'); p.write('\x15'); await sleep(300) }
    }
    snap('after-paste-probes')
    permissionResponder = async () => {
      await sleep(7000); snap('hooktimeout-7s')
      await sleep(8000); snap('hooktimeout-15s')
      log('pressing Enter in the PTY (dialog option "1. Yes")')
      p.write(String.fromCharCode(13))
      await sleep(10000)
      return allow()
    }
    await pasteAndSubmit(`Run this exact shell command once and report its output: node -e "console.log('agent-office-hooktimeout')"`)
    await waitFor(isEv('Stop'), 60000, 'Stop hooktimeout')
    await sleep(500); snap('after-hooktimeout')
    permissionResponder = async () => allow()
    await pasteAndSubmit('Run the shell command "ping -n 30 127.0.0.1" and report the result.')
    await waitFor(isEv('PreToolUse'), 60000, 'PreToolUse esc')
    await sleep(3000)
    log('WRITE \\x1b (Esc)')
    p.write('\x1b')
    const s1 = await waitFor(isEv('Stop'), 8000, 'Stop after Esc')
    log(`Stop after Esc: ${s1 ? 'yes' : 'no'}`)
    await sleep(1500)
    snap('after-esc')
    const pf = events.filter((e) => e.name === 'PostToolUse' || e.name === 'PostToolUseFailure').slice(-1)[0]
    log(`last tool result event: ${pf?.name} ${JSON.stringify(pf?.body?.error ?? pf?.body?.tool_response)?.slice(0, 300)}`)

    await pasteAndSubmit('Run the shell command "ping -n 30 127.0.0.1" and report the result.')
    await waitFor(isEv('PreToolUse'), 60000, 'PreToolUse ctrlc')
    await sleep(3000)
    log('WRITE \\x03 (Ctrl+C)')
    p.write('\x03')
    const s2 = await waitFor(isEv('Stop'), 8000, 'Stop after Ctrl+C')
    log(`Stop after Ctrl+C: ${s2 ? 'yes' : 'no'} ptyExited=${ptyExited}`)
    await sleep(1500)
    snap('after-ctrlc')
    if (!ptyExited) {
      log('WRITE \\x03 once more while idle')
      p.write('\x03')
      await sleep(1500)
      snap('after-ctrlc-idle-1')
      p.write('\x03')
      await sleep(3000)
      log(`after 2nd idle Ctrl+C ptyExited=${ptyExited}`)
      snap('after-ctrlc-idle-2')
    }
    await endSession()
  }
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
