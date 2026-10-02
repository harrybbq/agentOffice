// End-to-end check of the office board against the REAL agents, without the renderer: session
// manager + Claude driver (real `claude` TUI in the pty host) + Codex driver (real `codex
// app-server`) + ingest server with the board's MCP route, in ONE scratch git repository.
//
//   npx electron-vite build            (the pty host is taken from out/main/ptyHost.js)
//   npx electron scripts/e2e-board.cjs [--no-codex] [--skip-ask]      (--skip-ask leaves out step 2: one Claude turn less)
//
// Quota: 4 short Claude turns on `--model haiku` (two sessions), 1 short Codex turn at low effort.
//
// What it checks:
//   1. Team Alpha (Claude) creates notes.txt                -> the board lists the file
//   2. Team Beta (Claude) is asked what the board says      -> its prompt carried the digest, the answer names the file
//   3. Beta is asked to edit notes.txt                      -> stopped ONCE with the warning, the retry reaches the user's card (with the conflict on it) and passes
//   4. Beta is asked to claim a task and read the board     -> board_claim / board_read run with no permission prompt, as Beta
//   5. Team Gamma (Codex) in the same repository            -> gets the digest before its turn and calls board_read; its board token is in none of Codex's files
// It runs with its own userData and port, accepts the folder-trust dialog by keystroke (only this
// TEST does that), never writes to ~/.claude or ~/.codex, and only kills processes it started. The
// sessions stay in your Claude / Codex history.
'use strict'
const { app } = require('electron')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..')
const ROOT = path.join(os.tmpdir(), 'agent-office-e2e-board')
// Always the same folder (wiped at the start), so Claude Code's own folder-trust entry is written once.
const WORK = path.join(ROOT, 'repo')
const USER_DATA = path.join(ROOT, 'userData')
const BUNDLE_DIR = path.join(REPO, 'out', 'e2e') // inside the repo so `ws`, node-pty etc. resolve
const PTY_HOST = path.join(REPO, 'out', 'main', 'ptyHost.js')
const HOOK = path.join(REPO, 'hook', 'claude-session-start.cjs')
const WITH_CODEX = !process.argv.includes('--no-codex')
const SKIP_ASK = process.argv.includes('--skip-ask')
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

fs.rmSync(WORK, { recursive: true, force: true })
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
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

async function bundle() {
  const esbuild = require('esbuild')
  const entry = `
    export { SessionManager } from './electron/sessions.ts'
    export { claudeProvider } from './electron/drivers/claude.ts'
    export { codexProvider } from './electron/drivers/codex.ts'
    export { isAllowedLoginUrl } from './electron/drivers/codexProtocol.ts'
    export { createClaudeCodeHooksAdapter } from './electron/adapters/claude-code-hooks.ts'
    export { startIngestServer } from './electron/ingest/server.ts'
    export { SessionTokens } from './electron/ingest/auth.ts'
    export { SessionInbox } from './electron/sessionInbox.ts'
    export { PtyHostClient } from './electron/ptyClient.ts'
    export { Board } from './electron/board.ts'
    export { boardMcpRoute, BOARD_MCP_ROUTE } from './electron/boardMcp.ts'
  `
  const outfile = path.join(BUNDLE_DIR, 'stack-board.mjs')
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

/** Files under CODEX_HOME changed since the run started that contain `needle` (names only; auth.json is never read). */
function scanCodexHome(needle) {
  const hits = []
  let scanned = 0
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!['vendor_imports', 'plugins', 'skills', 'cache', 'pets'].includes(e.name)) walk(p, depth + 1)
        continue
      }
      if (e.name === 'auth.json') continue
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (st.mtimeMs < T0 - 5000 || st.size > 300 * 1024 * 1024) continue
      scanned++
      try {
        if (fs.readFileSync(p).indexOf(needle) >= 0) hits.push(path.relative(CODEX_HOME, p))
      } catch {
        // locked: skip
      }
    }
  }
  walk(CODEX_HOME, 0)
  return { scanned, hits }
}

let shutdownAll = async () => {}

async function main() {
  if (!fs.existsSync(PTY_HOST)) throw new Error('out/main/ptyHost.js is missing: run `npx electron-vite build` first')
  // One scratch repository for all three teams.
  const git = (...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: WORK, windowsHide: true, stdio: 'pipe' }).toString()
  git('init', '-q')
  fs.writeFileSync(path.join(WORK, 'README.md'), '# office board e2e\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  log(`scratch repository: ${WORK}`)

  const stack = await bundle()
  const port = await freePort()
  const tokens = new stack.SessionTokens()
  const boardTokens = new stack.SessionTokens()
  const inbox = new stack.SessionInbox()
  /** Board tokens as they were issued, to check afterwards that none was stored anywhere. Never printed. */
  const issued = new Map()
  const boardTokenSource = {
    issue: (id) => {
      const token = boardTokens.issue(id)
      issued.set(id, [...(issued.get(id) ?? []), token])
      return token
    },
    revoke: (id) => boardTokens.revoke(id)
  }
  const board = new stack.Board({ settings: () => ({ enabled: true, conflictMode: 'block-once' }) })

  const world = []
  const hooks = [] // { t, sessionId, name, tool, body, res }
  const mcp = [] // { t, sessionId, method, tool, args, isError, text }
  const names = new Map() // session id -> team
  const who = (id) => names.get(id) ?? id
  let permissions = []
  const cards = []
  const chat = []
  let server = null
  let manager = null

  const sink = { emit: (e) => { world.push(e); log(`WORLD ${who(e.agentId)} ${e.activity} ${JSON.stringify(e.detail)}`) } }
  const host = new stack.PtyHostClient(PTY_HOST, (tid, data) => manager.terminalData(tid, data))
  const pty = new Proxy(host, {
    get(target, prop) {
      if (prop !== 'spawn') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
      return (tid, opts, handlers) => {
        log(`SPAWN ${path.basename(opts.file)} ${opts.args.map((a) => (a.includes(USER_DATA) ? `<${path.basename(a).replace(tid, 'ID')}>` : a)).join(' ')}  cwd=${opts.cwd}`)
        log(`      env: AO_TOKEN=<${opts.env.AO_TOKEN.length} chars> AO_BOARD_TOKEN=${opts.env.AO_BOARD_TOKEN ? `<${opts.env.AO_BOARD_TOKEN.length} chars>` : '(none)'} AO_SESSION=${opts.env.AO_SESSION}`)
        return target.spawn(tid, opts, handlers)
      }
    }
  })
  const codex = WITH_CODEX
    ? stack.codexProvider({
        openExternal: async (url) => log(`(login URL not opened by the test: ${stack.isAllowedLoginUrl(url) ? 'valid' : 'INVALID'})`),
        effort: 'low'
      })
    : null
  shutdownAll = async () => {
    await Promise.allSettled([host.shutdown(), manager ? manager.shutdown() : null])
    if (server) await server.close()
  }
  manager = new stack.SessionManager({
    pty,
    sink,
    providers: [
      stack.claudeProvider({ sessionsDir: path.join(USER_DATA, 'sessions'), hookScript: HOOK, inbox, ingest: { baseUrl: () => (server ? `http://127.0.0.1:${port}` : null), tokens } }),
      ...(codex ? [codex] : [])
    ],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: (list) => {
      permissions = list
      for (const p of list) {
        if (cards.some((c) => c.id === p.id)) continue
        cards.push(p)
        log(`CARD ${who(p.sessionId)}: ${p.question}  risk=${p.risk}${p.riskNote ? ` (${p.riskNote})` : ''}  detail starts: ${JSON.stringify(p.detail.slice(0, 90))}`)
      }
    },
    onTerminalData: () => {},
    onChatEvent: (e) => void chat.push(e),
    board: { model: board, endpoint: { url: () => (server ? `http://127.0.0.1:${port}${stack.BOARD_MCP_ROUTE}` : null), tokens: boardTokenSource } }
  })

  // The real hooks adapter, with a tap that logs each hook and what the app answered (never a token).
  const inner = stack.createClaudeCodeHooksAdapter(manager)
  const adapter = {
    route: inner.route,
    maxBody: inner.maxBody,
    handle(body, s, ctx) {
      const entry = { t: Date.now(), sessionId: ctx.auth.sessionId, name: body && body.hook_event_name, tool: body && body.tool_name, body: { ...body, _ao: undefined }, res: undefined }
      hooks.push(entry)
      const out = inner.handle(body, s, ctx)
      void Promise.resolve(out).then((res) => {
        entry.res = res
        const h = res && res.hookSpecificOutput
        const said = h ? (h.permissionDecision ? ` -> ${h.permissionDecision}: ${one(h.permissionDecisionReason).slice(0, 260)}` : h.additionalContext ? ` -> additionalContext (${h.additionalContext.length} chars)` : h.decision ? ` -> ${h.decision.behavior}` : '') : ''
        log(`HOOK ${who(entry.sessionId)} ${entry.name}${entry.tool ? ` ${entry.tool}` : ''}${body && body.agent_id ? ' (subagent)' : ''}${said}`)
        if (h && h.additionalContext) log(`---- additionalContext for ${who(entry.sessionId)} ----\n${h.additionalContext}\n----`)
      })
      return out
    }
  }
  // The real board route, with a tap that logs who called what (identity = the token's session).
  const route = stack.boardMcpRoute(board)
  const tappedRoute = {
    route: route.route,
    maxBody: route.maxBody,
    handle(sessionId, body) {
      const out = route.handle(sessionId, body)
      for (const m of Array.isArray(body) ? body : [body]) {
        const result = out.body && !Array.isArray(out.body) ? out.body.result : undefined
        const text = result && result.content ? one(result.content[0].text).slice(0, 300) : ''
        const entry = { t: Date.now(), sessionId, method: m && m.method, tool: m && m.params && m.params.name, args: m && m.params && m.params.arguments, isError: result ? result.isError : undefined, text, status: out.status, error: out.body && out.body.error }
        mcp.push(entry)
        log(`MCP ${who(sessionId)} ${entry.method}${entry.tool ? ` ${entry.tool} ${JSON.stringify(entry.args ?? {})}` : ''} -> ${out.status}${entry.error ? ` error ${entry.error.code}` : ''}${text ? ` ${JSON.stringify(text)}` : ''}`)
      }
      return out
    }
  }
  server = await stack.startIngestServer({
    port,
    getToken: () => crypto.randomBytes(32).toString('hex'), // nobody has the global token in this run
    sink,
    sessionTokens: tokens,
    claudeHooks: adapter,
    board: { route: tappedRoute, tokens: boardTokens }
  })

  const hookSince = (id, name, since, pred = () => true) => hooks.find((h) => h.sessionId === id && h.t >= since && h.name === name && pred(h))
  const waitHook = (id, name, since, ms, pred) => until(() => hookSince(id, name, since, pred), `hook ${name} of ${who(id)}`, ms)
  const state = (id) => (manager.list().find((s) => s.id === id) || {}).state
  const waitState = (id, want, ms) => until(() => state(id) === want, `${who(id)} state ${want}`, ms)
  const screen = async (id) => ((await pty.snapshot(id, false)) || { text: '' }).text
  const typePrompt = async (id, text) => {
    log(`PROMPT to ${who(id)}: ${text}`)
    manager.write(id, `\x1b[200~${text}\x1b[201~`)
    await sleep(250)
    manager.write(id, '\r')
  }
  const branch = (id) => board.snapshot().branches.find((b) => b.sessionId === id)
  /** A Claude turn is over when its Stop hook arrives. If it doesn't, show why (the account's usage limit ends a turn without one). */
  async function waitStop(id, since, ms) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const stop = hookSince(id, 'Stop', since)
      if (stop) return stop
      const sc = await screen(id)
      if (/hit your (session|usage) limit|Usage limit reached/i.test(sc)) {
        log(`---- SCREEN ${who(id)} ----\n${sc}\n----`)
        throw new Error(`${who(id)}: the Claude account's usage limit was reached; the turn can't run. Try again after the reset shown above.`)
      }
      await sleep(1000)
    }
    log(`TIMEOUT waiting for: Stop of ${who(id)}\n---- SCREEN ${who(id)} ----\n${await screen(id)}\n----`)
    return null
  }

  /** Starts a Claude session on haiku and gets it past the folder-trust dialog. */
  async function startClaude(title, permissionMode) {
    const info = await manager.start({ provider: 'claude-code', cwd: WORK, permissionMode, title, model: 'haiku' })
    names.set(info.id, title)
    log(`started ${title} = ${info.id} (${permissionMode})`)
    let trusted = false
    const ready = await until(async () => {
      if (state(info.id) === 'idle') return true
      if (state(info.id) === 'exited') return 'exited'
      const sc = await screen(info.id)
      if (!trusted && /Is this a project you|trust this folder|Do you trust/i.test(sc)) {
        // The dialog defaults to "No, exit" (docs/spikes-phase-a.md): Down, then Enter.
        log(`TEST ONLY: accepting folder trust for ${title} with Down + Enter`)
        await sleep(1200)
        manager.write(info.id, '\x1b[B')
        await sleep(500)
        manager.write(info.id, '\r')
        trusted = true
        await sleep(1500)
      }
      return false
    }, `${title} ready`, 90000)
    if (ready !== true) throw new Error(`${title} did not become ready (state=${state(info.id)})\n${await screen(info.id)}`)
    return info.id
  }

  // ------------------------------------------------------------------ two Claude sessions, one repository
  const alpha = await startClaude('Alpha', 'acceptEdits')
  const beta = await startClaude('Beta', 'default')
  await sleep(1500)
  const sessionsDir = path.join(USER_DATA, 'sessions')
  const mcpFile = path.join(sessionsDir, `${beta}.mcp.json`)
  const mcpText = fs.existsSync(mcpFile) ? fs.readFileSync(mcpFile, 'utf8') : ''
  check('each Claude session got an MCP config naming the env var, not the token', /"agent-office"/.test(mcpText) && mcpText.includes('${AO_BOARD_TOKEN}') && !issued.get(beta).some((tok) => mcpText.includes(tok)))
  const snap0 = board.snapshot()
  check('both teams are on the board in ONE project (the git common dir)', snap0.branches.length === 2 && snap0.branches[0].project === snap0.branches[1].project && /\.git$/.test(snap0.branches[0].project), `${snap0.branches[0].projectLabel}: ${snap0.branches[0].project}`)
  check('the board server was initialised by both sessions (their own tokens)', await until(() => [alpha, beta].every((id) => mcp.some((m) => m.sessionId === id && m.method === 'initialize')), 'MCP initialize', 20000))

  // ------------------------------------------------------------------ 1. Alpha changes a file
  let t = Date.now()
  await typePrompt(alpha, 'Create a file named notes.txt in the current folder that contains exactly one line: alpha. Use the Write tool, nothing else. Then reply with the single word: done')
  await waitStop(alpha, t, 120000)
  check('1. Alpha: PostToolUse(Write)', hookSince(alpha, 'PostToolUse', t, (h) => h.tool === 'Write'))
  await waitState(alpha, 'idle', 5000)
  const alphaFiles = (branch(alpha) || { files: [] }).files
  check('1. the board lists notes.txt as changed by Alpha (project-relative)', alphaFiles.some((f) => f.path === 'notes.txt'), JSON.stringify(alphaFiles))
  check('1. notes.txt exists on disk', fs.existsSync(path.join(WORK, 'notes.txt')))
  const alphaPrompt = hookSince(alpha, 'UserPromptSubmit', t)
  log(`   (Alpha's own prompt got: ${alphaPrompt && alphaPrompt.res && alphaPrompt.res.hookSpecificOutput ? 'a digest naming Beta' : 'no digest'})`)

  // ------------------------------------------------------------------ 2. Beta's next prompt carries the digest
  const digestOf = async (since) => {
    const ups = await waitHook(beta, 'UserPromptSubmit', since, 20000)
    await until(() => ups && ups.res !== undefined, 'the hook answer', 5000)
    return ups && ups.res && ups.res.hookSpecificOutput ? ups.res.hookSpecificOutput.additionalContext : ''
  }
  const isDigest = (digest) => /^OFFICE BOARD \(kept by Agent Office/.test(digest) && /Team "Alpha"/.test(digest) && /notes\.txt/.test(digest)
  if (!SKIP_ASK) {
    t = Date.now()
    await typePrompt(beta, 'What does the office board say other teams are doing? Answer in one line and name the files it mentions. Do not call any tool.')
    const digest = await digestOf(t)
    check('2. Beta: the UserPromptSubmit answer is the digest, naming Alpha and notes.txt', isDigest(digest), `${digest.length} chars`)
    const stop2 = await waitStop(beta, t, 120000)
    const answer2 = stop2 ? one(stop2.body.last_assistant_message) : ''
    log(`ANSWER Beta: ${answer2}`)
    check('2. Beta read it: the answer names notes.txt', /notes\.txt/i.test(answer2))
    check('2. no tool was needed for it', !hooks.some((h) => h.sessionId === beta && h.t >= t && h.name === 'PreToolUse'))
    await waitState(beta, 'idle', 5000)
  }

  // ------------------------------------------------------------------ 3. Beta edits the same file: warned once
  t = Date.now()
  const cardsBefore = cards.length
  await typePrompt(beta, 'Add a second line that says beta to notes.txt in this folder (read it first, then use the Edit tool). If the edit is refused with a warning, consider it, and if the change is still right make the same edit again.')
  const isEdit = (h) => ['Edit', 'Write', 'MultiEdit'].includes(h.tool)
  if (SKIP_ASK) check('2. Beta: the prompt carried the digest, naming Alpha and notes.txt', isDigest(await digestOf(t)))
  const denied = await until(() => hooks.find((h) => h.sessionId === beta && h.t >= t && h.name === 'PreToolUse' && isEdit(h) && h.res && h.res.hookSpecificOutput && h.res.hookSpecificOutput.permissionDecision === 'deny'), 'the denied edit', 120000)
  check('3. Beta: the first edit of notes.txt was denied once with the fixed warning', denied && /^OFFICE BOARD warning \(from Agent Office, not from the user\): team "Alpha" edited notes\.txt .* ago\./.test(denied.res.hookSpecificOutput.permissionDecisionReason))
  check('3. the warning is on the board for the user', board.snapshot().warnings.some((w) => w.sessionId === beta && w.path === 'notes.txt' && w.otherTeam === 'Alpha'))
  const card = await until(() => cards.slice(cardsBefore).find((c) => c.sessionId === beta && /notes\.txt/.test(c.summary)), 'the card of the retried edit', 120000)
  check('3. the retry reached the user: a card with the conflict on it (caution + a line in the details)', card && card.risk === 'caution' && /Alpha changed this file/.test(card.riskNote || '') && /^Office board: team "Alpha" changed notes\.txt/.test(card.detail), card ? `${card.riskNote}` : '')
  if (card) manager.decide(card.id, { behavior: 'allow' })
  check('3. the retried edit ran (PostToolUse)', await waitHook(beta, 'PostToolUse', t, 120000, isEdit))
  const stop3 = await waitStop(beta, t, 120000)
  log(`ANSWER Beta: ${stop3 ? one(stop3.body.last_assistant_message) : ''}`)
  const betaDenies = hooks.filter((h) => h.sessionId === beta && h.t >= t && h.name === 'PreToolUse' && h.res && h.res.hookSpecificOutput && h.res.hookSpecificOutput.permissionDecision === 'deny')
  check('3. warned exactly once', betaDenies.length === 1, `${betaDenies.length} denials`)
  const content = fs.existsSync(path.join(WORK, 'notes.txt')) ? fs.readFileSync(path.join(WORK, 'notes.txt'), 'utf8') : ''
  check('3. notes.txt now has both lines', /alpha/.test(content) && /beta/.test(content), JSON.stringify(content))
  check('3. the board lists notes.txt for Beta too', (branch(beta) || { files: [] }).files.some((f) => f.path === 'notes.txt'))
  const boardReadAfterWarning = mcp.find((m) => m.sessionId === beta && m.t >= t && m.tool === 'board_read')
  log(`   (Beta ${boardReadAfterWarning ? 'called board_read after the warning' : 'did not call board_read after the warning'})`)
  await waitState(beta, 'idle', 5000)

  // ------------------------------------------------------------------ 4. Beta uses the board tools, unasked
  t = Date.now()
  const cardsBefore4 = cards.length
  await typePrompt(beta, 'Use the office board tools of the agent-office MCP server: call board_claim with the task "write the tests", then call board_read. Reply in one line with the teams listed on the board.')
  const stop4 = await waitStop(beta, t, 150000)
  log(`ANSWER Beta: ${stop4 ? one(stop4.body.last_assistant_message) : ''}`)
  const calls = mcp.filter((m) => m.sessionId === beta && m.t >= t && m.method === 'tools/call')
  check('4. Beta called board_claim and board_read on the app\'s MCP route, as itself', calls.some((c) => c.tool === 'board_claim' && c.isError === false) && calls.some((c) => c.tool === 'board_read' && c.isError === false), calls.map((c) => c.tool).join(', '))
  check('4. the claim is on the board under Beta\'s name', board.snapshot().claims.some((c) => c.sessionId === beta && c.team === 'Beta' && /write the tests/i.test(c.task)))
  const boardHooks = hooks.filter((h) => h.sessionId === beta && h.t >= t && /^mcp__agent-office__/.test(h.tool || ''))
  check('4. no permission prompt for the board tools (PreToolUse seen, no PermissionRequest, no card)', boardHooks.some((h) => h.name === 'PreToolUse') && !boardHooks.some((h) => h.name === 'PermissionRequest') && cards.length === cardsBefore4, boardHooks.map((h) => `${h.name}:${h.tool.replace('mcp__agent-office__', '')}`).join(' '))
  check('4. in the world a board call is "checking the board" (read), not exec', world.some((e) => e.agentId === beta && e.ts >= t && e.activity === 'read' && e.detail === 'checking the board'))
  await waitState(beta, 'idle', 5000)

  // Alpha is no longer needed: one session less in memory. Its row stays on the board as "ended".
  await manager.stop(alpha)
  check('Alpha stopped: ended on the board, its board token is dead, its temp files are gone', (branch(alpha) || {}).status === 'ended' && issued.get(alpha).every((tok) => boardTokens.sessionOf(tok) === null) && !fs.existsSync(path.join(sessionsDir, `${alpha}.mcp.json`)))

  // ------------------------------------------------------------------ 5. a Codex session in the same repository
  if (codex) {
    const providers = await manager.providers()
    const cx = providers.find((p) => p.id === 'codex')
    log(`Codex: available=${cx.available} loggedIn=${cx.account && cx.account.loggedIn} usage=${JSON.stringify(cx.usage)}`)
    if (!cx.available || !(cx.account && cx.account.loggedIn)) check('5. Codex is installed and logged in', false)
    else {
      const info = await manager.start({ provider: 'codex', cwd: WORK, permissionMode: 'default', title: 'Gamma' })
      const gamma = info.id
      names.set(gamma, 'Gamma')
      manager.chatAttach(gamma)
      log(`started Gamma = ${gamma} thread=${info.providerSessionId}`)
      check('5. Gamma is in the same project as the Claude teams', (branch(gamma) || {}).project === (branch(beta) || {}).project)
      await until(() => mcp.some((m) => m.sessionId === gamma && m.method === 'initialize'), 'Codex MCP initialize', 15000)
      check('5. the thread connected to the board with its own token (per-thread config)', mcp.some((m) => m.sessionId === gamma && m.method === 'initialize'))
      const pending = board.digest(gamma)
      check('5. a digest is waiting for Gamma (Beta is live in the project; Alpha, just ended, is still listed)', pending && /Team "Beta"/.test(pending.text) && /notes\.txt/.test(pending.text))
      if (pending) log(`---- digest for Gamma ----\n${pending.text}\n----`)
      t = Date.now()
      const cardsBefore5 = cards.length
      const prompt = 'Two things, briefly. First: without calling a tool, say what the office board digest in your context says other teams changed. Second: call the board_read tool of the agent_office MCP server and say in one line whether it worked and which claims it lists.'
      log(`PROMPT to Gamma: ${prompt}`)
      await manager.chatSend(gamma, prompt)
      await until(() => state(gamma) !== 'idle', 'Gamma busy', 10000)
      await until(() => state(gamma) === 'idle' || state(gamma) === 'exited', 'Gamma idle again', 180000)
      check('5. the digest was injected before the turn (thread/inject_items accepted: nothing left to send)', board.digest(gamma) === null)
      const items = manager.chatAttach(gamma)
      const answer5 = one(items.filter((i) => i.kind === 'assistant').map((i) => i.text).join(' '))
      log(`ANSWER Gamma: ${answer5}`)
      check('5. Gamma saw the digest: its answer names notes.txt', /notes\.txt/i.test(answer5))
      const gcalls = mcp.filter((m) => m.sessionId === gamma && m.t >= t && m.method === 'tools/call')
      check('5. Gamma called board_read on the app\'s MCP route, as itself', gcalls.some((c) => c.tool === 'board_read' && c.isError === false), gcalls.map((c) => c.tool).join(', '))
      check('5. no approval was asked for the board tool', cards.length === cardsBefore5 && !items.some((i) => i.kind === 'approval'))
      const toolItem = items.find((i) => i.kind === 'tool')
      log(`   (chat tool item: ${toolItem ? `${toolItem.server}.${toolItem.tool} ${toolItem.status}` : 'none'})`)
      check('5. in the world a board call is "checking the board"', world.some((e) => e.agentId === gamma && e.activity === 'read' && e.detail === 'checking the board'))
      check('5. the digest is not shown in the chat (only the result of its own board_read is)', !items.some((i) => i.kind !== 'tool' && JSON.stringify(i).includes('OFFICE BOARD (kept by Agent Office')))
      // The open question of the spikes: is the per-thread config (the board token) written to disk by Codex?
      await sleep(1500)
      const stored = issued.get(gamma).map((tok) => scanCodexHome(tok))
      check('5. the board token is in none of the files Codex wrote during the run (rollout, state databases, logs)', stored.every((s) => s.hits.length === 0), `${stored[0].scanned} changed files searched; hits: ${JSON.stringify(stored.flatMap((s) => s.hits))}`)
      const digestStored = scanCodexHome('OFFICE BOARD (kept by Agent Office')
      log(`   (the digest TEXT is in the thread's own history, as any developer message: ${JSON.stringify(digestStored.hits)})`)
      await manager.stop(gamma)
      check('5. Gamma stopped: its board token is dead', issued.get(gamma).every((tok) => boardTokens.sessionOf(tok) === null))
      const usage = (await manager.providers()).find((p) => p.id === 'codex').usage
      log(`Codex usage after the run: ${JSON.stringify(usage)}`)
    }
  }

  // ------------------------------------------------------------------ the end
  await manager.stop(beta)
  check('everything stopped: no hook token and no board token is left', tokens.size === 0 && boardTokens.size === 0)
  check('no temp file is left under userData/sessions', fs.readdirSync(sessionsDir).length === 0, fs.readdirSync(sessionsDir).join(' '))
  const all = fs.readFileSync(logFile, 'utf8')
  check('no token was written to the log', ![...issued.values()].flat().some((tok) => all.includes(tok)))
  const snap = board.snapshot()
  log(`final board: branches ${snap.branches.map((b) => `${b.team}[${b.status}] files=${b.files.map((f) => f.path).join('|')}`).join(', ')}; claims ${snap.claims.length}; notes ${snap.notes.length}; warnings ${snap.warnings.map((w) => `${w.team}:${w.path}<-${w.otherTeam}`).join(', ')}`)
  log(`Claude hook counts: ${['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'].map((n) => `${n}=${hooks.filter((h) => h.name === n).length}`).join(' ')}`)
  log(`Claude turns used: ${hooks.filter((h) => h.name === 'UserPromptSubmit').length}`)
  manager.close()
}

const guard = setTimeout(() => {
  log('GLOBAL TIMEOUT')
  void shutdownAll().finally(() => app.exit(2))
}, 14 * 60_000)

app.whenReady().then(async () => {
  let failed = false
  try {
    await main()
  } catch (err) {
    failed = true
    log(`ERROR ${err && err.stack ? err.stack : err}`)
  }
  clearTimeout(guard)
  await shutdownAll().catch(() => {})
  const bad = checks.filter((c) => !c.ok)
  log(`\n${checks.length - bad.length}/${checks.length} checks passed${bad.length ? `; FAILED: ${bad.map((c) => c.name).join(' | ')}` : ''}`)
  log(`log: ${logFile}`)
  app.exit(failed || bad.length ? 1 : 0)
})
