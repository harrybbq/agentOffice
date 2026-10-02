// Phase C spike: the empirical checklist for hosting `agy` (Google Antigravity CLI) headless.
// Needs a logged-in agy. Real model turns are limited by --max-turns (default 2); everything else is free.
//
//   node scripts/spikes/agy/check.cjs [--root <scratch dir>] [--only <list>] [--model <slug>] [--max-turns N]
//
// Scenarios (--only, comma separated; default: preflight,approvals,second,resume):
//   preflight   free   login, usage, hooks + MCP + rules discovery through --add-dir, the init event
//   approvals   1 turn one process, one turn: PreToolUse hook holds a command 15 s then allows, allows a file
//                      write, denies a second command with a message, allows an MCP tool; PreInvocation
//                      injects a briefing (ephemeralMessage) and a steer (userMessage); AGENTS.md rules
//   second      1 turn second prompt in the SAME process (multi-turn over stdin), an unknown stdin event
//                      mid-turn (is stdin read while a turn runs?), then a hard kill mid-command
//   resume      free   a new process with --conversation <id>: does the killed conversation load?
//   terminate   1 turn (not in the default set) soft interrupt: PostInvocation returns terminationBehavior "terminate"
//   steer       2 turns (not in the default set) a real `user` event written to stdin while a turn runs
//   ask         1 turn (not in the default set) PreToolUse answers "ask": what does headless do?
//
// Layout: the project folder (cwd) stays untouched. Hooks, rules and the MCP config live in a separate
// session folder that is handed to agy with --add-dir. Nothing is written to ~/.gemini by this script.
// Logs: logs/check-<scenario>.log (JSON lines: `->` stdin, `<-` stdout, `!!` stderr, `hk` hook, `--` note).
'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { findAgyExecutable, scrubbedEnv, Logger, runOnce, AgySession, processTree, parseArgs, killTree } = require('./lib.cjs')

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(args.root || path.join(os.tmpdir(), 'ao-agy-spike'))
const only = (typeof args.only === 'string' ? args.only : 'preflight,approvals,second,resume').split(',')
const model = typeof args.model === 'string' ? args.model : 'gemini-3.8-flash-low'
const maxTurns = Number(args['max-turns'] ?? 2)
const HOOK = path.join(__dirname, 'hook.cjs')
const MCP = path.join(__dirname, 'mcp-board.cjs')
const EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const project = path.join(root, 'check-project')
const session = path.join(root, 'check-session')
const stateFile = path.join(root, 'check-state.json')
let turnsSent = 0
let log = null

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}
const saveState = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...loadState(), ...patch }, null, 2))

function setup() {
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(session, '.agents'), { recursive: true })
  const handler = (ev) => ({ type: 'command', command: `node hook.cjs ${ev}`, timeout: 120 })
  const spec = {}
  for (const ev of EVENTS) spec[ev] = ev.endsWith('ToolUse') ? [{ matcher: '*', hooks: [handler(ev)] }] : [handler(ev)]
  // The hook command must not contain double quotes on Windows (see docs/spikes-phase-c.md, spike 3), so the
  // script sits next to hooks.json, which is the hook's working directory, and is named relatively.
  fs.copyFileSync(HOOK, path.join(session, '.agents', 'hook.cjs'))
  fs.writeFileSync(path.join(session, '.agents', 'hooks.json'), JSON.stringify({ 'agent-office': spec }, null, 2))
  fs.writeFileSync(path.join(session, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { office: { command: 'node', args: [MCP], env: { AO_MCP_LOG: path.join(root, 'mcp-board.log') } } } }, null, 2))
  fs.writeFileSync(path.join(session, 'AGENTS.md'), 'You are running inside Agent Office. The office code word A is ao-rules-3.\n')
}

/** The local server hook.cjs posts to. `hooks.decide(event, payload)` returns the hook result (may be async); each scenario sets it. */
function hookServer() {
  const self = { decide: async () => ({}) }
  const token = crypto.randomBytes(16).toString('hex')
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      if (req.headers['x-ao-token'] !== token) {
        res.writeHead(403).end()
        return
      }
      let msg = {}
      try {
        msg = JSON.parse(body)
      } catch {
        // keep {}
      }
      const t0 = Date.now()
      log.line('hk', { in: msg })
      let closed = false
      res.on('close', () => {
        if (!res.writableEnded) {
          closed = true
          log.line('hk', { event: msg.event, note: 'agy closed the hook connection before the answer', afterMs: Date.now() - t0 })
        }
      })
      const out = await self.decide(msg.event, msg.payload ?? {}, msg.diag ?? {})
      log.line('hk', { event: msg.event, out, heldMs: Date.now() - t0, closed })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(Object.assign(self, { server, token, url: `http://127.0.0.1:${server.address().port}/hook` }))))
}

function sessionArgs(extra = []) {
  return ['--add-dir', session, '--model', model, '--disable-slash-commands', '--log-file', path.join(root, 'agy-cli.log'), ...extra]
}

function guardTurn(name) {
  if (turnsSent >= maxTurns) throw new Error(`turn budget (${maxTurns}) used up; not sending the prompt for "${name}"`)
  turnsSent++
  log.note({ turn: turnsSent, of: maxTurns, scenario: name })
}

async function usage(exe, env) {
  const r = await runOnce(exe, ['-p', '/usage', '--output-format', 'json'], { cwd: project, env, timeoutMs: 60_000 })
  try {
    const groups = JSON.parse(r.stdout).command.data.groups
    return groups.map((g) => ({ group: g.name, remaining: g.buckets.map((b) => `${b.window}: ${b.remaining_fraction} (resets ${b.reset_time})`) }))
  } catch {
    return { error: r.stderr.slice(0, 300) || r.stdout.slice(0, 300) }
  }
}

// ---- scenarios ----------------------------------------------------------------------------------

async function preflight(exe, env) {
  const m = await runOnce(exe, ['models'], { cwd: project, env, log })
  if (m.code !== 0) throw new Error('not logged in: `agy models` failed. Run `agy` once in a terminal and sign in with the personal Google account.')
  log.note({ usage: await usage(exe, env) })
  await runOnce(exe, ['-p', '/hooks', '--output-format', 'json', '--add-dir', session], { cwd: project, env, log })
  await runOnce(exe, ['--add-dir', session, 'mcp', 'list'], { cwd: project, env, log })
  await runOnce(exe, ['mcp', 'list'], { cwd: session, env, log })
  const s = new AgySession(exe, sessionArgs(), { cwd: project, env, log })
  const init = await s.waitFor((e) => e.event === 'init', 30_000)
  log.note({ init: !!init, permission_mode: init?.init?.permission_mode, model: init?.init?.model, tools: init?.init?.tools?.length, mcpTools: init?.init?.tools?.filter((t) => /office|board|mcp/i.test(t)) })
  s.closeStdin()
  if (!(await Promise.race([s.done, sleep(15_000).then(() => null)]))) s.kill()
}

async function approvals(exe, env, hooks) {
  let commands = 0
  let steer = 'none' // none -> pending -> sent
  hooks.decide = async (event, p) => {
    if (event === 'PreInvocation') {
      if (p.invocationNum === 0) return { injectSteps: [{ ephemeralMessage: 'Agent Office briefing: you are running inside Agent Office. The office code word B is ao-brief-7.' }] }
      if (steer === 'pending') {
        steer = 'sent'
        return { injectSteps: [{ userMessage: 'Also: end your final answer with the exact word steered-ok.' }] }
      }
      return {}
    }
    if (event === 'PreToolUse') {
      const name = p.toolCall?.name
      if (name === 'run_command') {
        commands++
        if (commands === 1) {
          await sleep(15_000) // the CEO takes 15 s to decide
          return { decision: 'allow', reason: 'Approved from the Agent Office CEO desk.' }
        }
        return { decision: 'deny', reason: 'Denied from the Agent Office CEO desk: the second command is not needed.' }
      }
      return { decision: 'allow' }
    }
    if (event === 'PostToolUse') {
      if (steer === 'none' && p.toolCall?.name === 'run_command') steer = 'pending'
      return {}
    }
    if (event === 'Stop') return { decision: 'stop' }
    return {}
  }
  const s = new AgySession(exe, sessionArgs(), { cwd: project, env, log })
  try {
    const init = await s.waitFor((e) => e.event === 'init', 30_000)
    if (!init) throw new Error('no init event')
    saveState({ conversationId: init.conversation_id })
    guardTurn('approvals')
    s.prompt(
      [
        'Do these four steps in order, one tool call each. If a step is refused, do not retry it; go on to the next step.',
        `1. Run the shell command: node -e "console.log('ao-one')"`,
        '2. Create the file ao-note.txt in the current folder containing the single line: hello',
        `3. Run the shell command: node -e "console.log('ao-two')"`,
        '4. Call the MCP tool board_post of the server "office" with the text "hi".',
        'Then answer in one short line: what happened in each step, plus every office code word you were told.'
      ].join('\n')
    )
    const result = await s.waitFor((e) => e.event === 'result', 240_000)
    log.note({ result: result?.result ?? null, noteFile: fs.existsSync(path.join(project, 'ao-note.txt')) ? fs.readFileSync(path.join(project, 'ao-note.txt'), 'utf8') : null, steer })
    return s // kept open for `second`
  } catch (err) {
    s.kill()
    throw err
  }
}

/** `open` is the session left by `approvals` (same process), or null: then a new process resumes the conversation. */
async function second(exe, env, hooks, open) {
  hooks.decide = async (event) => (event === 'PreToolUse' ? { decision: 'allow' } : event === 'Stop' ? { decision: 'stop' } : {})
  if (open) open.log = log // the session outlives the log file of the scenario that opened it
  const s = open ?? new AgySession(exe, sessionArgs(loadState().conversationId ? ['--conversation', loadState().conversationId] : []), { cwd: project, env, log })
  try {
    const from = s.events.length
    if (!open) await s.waitFor((e) => e.event === 'init', 30_000)
    guardTurn('second')
    s.prompt(`Run this shell command and wait until it has finished (do not run it in the background): node -e "setTimeout(()=>console.log('slow-done'),20000)"\nThen reply with its output.`)
    const tool = await s.waitFor((e) => e.event === 'step_update' && e.step_update.step_type === 'tool' && e.step_update.state === 'ACTIVE', 120_000, from)
    log.note({ toolActive: !!tool })
    await sleep(3000)
    const sentAt = Date.now()
    s.send({ event: 'future_thing', note: 'is stdin read while a turn is running?' })
    await sleep(4000)
    const warned = s.stderrLines.find((l) => /future_thing/.test(l.line))
    log.note({ unknownEventWarningDuringTurn: !!warned, warnedAfterMs: warned ? warned.t - (sentAt - s.t0) : null })
    const tree = processTree(s.child.pid)
    log.note({ processTreeMidCommand: tree })
    const turnDone = s.events.slice(from).some((e) => e.event === 'result')
    log.note({ turnAlreadyDone: turnDone })
    s.kill()
    const exit = await Promise.race([s.done, sleep(10_000).then(() => null)])
    log.note({ exitAfterKill: exit })
    await sleep(1500)
    const all = tree.filter((t) => t.pid !== s.child.pid).map((t) => {
      try {
        process.kill(t.pid, 0)
        return { ...t, alive: true }
      } catch {
        return { ...t, alive: false }
      }
    })
    log.note({ childrenAfterKill: all })
    for (const p of all) if (p.alive) killTree(p.pid)
  } finally {
    if (!s.exited) s.kill()
  }
}

async function resume(exe, env) {
  const id = loadState().conversationId
  if (!id) throw new Error('no conversation id recorded; run `approvals` first')
  const s = new AgySession(exe, sessionArgs(['--conversation', id]), { cwd: project, env, log })
  const init = await s.waitFor((e) => e.event === 'init', 30_000)
  log.note({ asked: id, got: init?.conversation_id ?? null, sameConversation: init?.conversation_id === id, notFoundWarning: s.stderrLines.some((l) => /not found/.test(l.line)) })
  s.closeStdin()
  if (!(await Promise.race([s.done, sleep(15_000).then(() => null)]))) s.kill()
  const transcript = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  if (fs.existsSync(transcript)) {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean)
    log.note({ transcriptSteps: lines.length })
    for (const l of lines) log.line('--', { transcript: l.length > 1500 ? l.slice(0, 1500) + '…' : l })
  } else log.note({ transcript: 'missing' })
}

async function terminate(exe, env, hooks) {
  let stop = false
  hooks.decide = async (event) => {
    if (event === 'PreToolUse') return stop ? { decision: 'deny', reason: 'The user stopped this turn from Agent Office.' } : { decision: 'allow' }
    if (event === 'PostInvocation') return stop ? { terminationBehavior: 'terminate' } : {}
    if (event === 'Stop') return { decision: 'stop' }
    return {}
  }
  const s = new AgySession(exe, sessionArgs(), { cwd: project, env, log })
  try {
    await s.waitFor((e) => e.event === 'init', 30_000)
    guardTurn('terminate')
    s.prompt(`Run these three shell commands one after the other, each as its own tool call: node -e "console.log(1)" then node -e "console.log(2)" then node -e "console.log(3)". Then say done.`)
    await s.waitFor((e) => e.event === 'step_update' && e.step_update.step_type === 'tool' && e.step_update.state === 'DONE', 120_000)
    stop = true
    log.note('stop flag set: the next PreToolUse is denied and the next PostInvocation asks to terminate')
    const result = await s.waitFor((e) => e.event === 'result', 120_000)
    log.note({ result: result?.result ?? null, processStillAlive: !s.exited })
  } finally {
    s.closeStdin()
    if (!(await Promise.race([s.done, sleep(15_000).then(() => null)]))) s.kill()
  }
}

async function steer(exe, env, hooks) {
  hooks.decide = async (event) => (event === 'PreToolUse' ? { decision: 'allow' } : event === 'Stop' ? { decision: 'stop' } : {})
  const s = new AgySession(exe, sessionArgs(), { cwd: project, env, log })
  try {
    await s.waitFor((e) => e.event === 'init', 30_000)
    guardTurn('steer')
    s.prompt(`Run this shell command and wait until it has finished: node -e "setTimeout(()=>console.log('slow-done'),15000)"\nThen reply with its output.`)
    await s.waitFor((e) => e.event === 'step_update' && e.step_update.step_type === 'tool' && e.step_update.state === 'ACTIVE', 120_000)
    await sleep(2000)
    guardTurn('steer (the message sent mid-turn)')
    s.prompt('Also: end your final answer with the exact word steered-ok.')
    const first = await s.waitFor((e) => e.event === 'result', 180_000)
    const idx = s.events.indexOf(first)
    const secondResult = await s.waitFor((e) => e.event === 'result', 90_000, idx + 1)
    log.note({ first: first?.result ?? null, second: secondResult?.result ?? null, verdict: secondResult ? 'queued: it ran as its own turn afterwards' : 'absorbed into the running turn (or dropped): see the first response' })
  } finally {
    s.closeStdin()
    if (!(await Promise.race([s.done, sleep(15_000).then(() => null)]))) s.kill()
  }
}

async function ask(exe, env, hooks) {
  hooks.decide = async (event) => (event === 'PreToolUse' ? { decision: 'ask', reason: 'Agent Office wants a person to look at this.' } : event === 'Stop' ? { decision: 'stop' } : {})
  const s = new AgySession(exe, sessionArgs(), { cwd: project, env, log })
  try {
    await s.waitFor((e) => e.event === 'init', 30_000)
    guardTurn('ask')
    s.prompt(`Run the shell command: node -e "console.log('ao-ask')" and reply with its output. If it is refused, say so in one line.`)
    const result = await s.waitFor((e) => e.event === 'result', 120_000)
    log.note({ result: result?.result ?? null })
  } finally {
    s.closeStdin()
    if (!(await Promise.race([s.done, sleep(15_000).then(() => null)]))) s.kill()
  }
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  const exe = findAgyExecutable()
  if (!exe) throw new Error('agy not found (AGY_PATH, %LOCALAPPDATA%\\agy\\bin, ~/.local/bin, PATH)')
  setup()
  const hooks = await hookServer()
  // The hook command inherits agy's environment: that is how hook.cjs learns where to post.
  const env = scrubbedEnv(process.env, { AO_AGY_HOOK_URL: hooks.url, AO_AGY_HOOK_TOKEN: hooks.token })
  let open = null
  const step = async (name, fn) => {
    if (!only.includes(name)) return undefined
    log = new Logger(path.join(__dirname, 'logs', `check-${name}.log`))
    log.note({ scenario: name, model, root, turnsSent, maxTurns })
    try {
      return await fn()
    } catch (err) {
      log.note({ failed: String(err && err.message ? err.message : err) })
      return undefined
    } finally {
      if (name !== 'preflight' && name !== 'resume') log.note({ usageAfter: await usage(exe, env) })
      await log.close()
    }
  }
  await step('preflight', () => preflight(exe, env))
  open = (await step('approvals', () => approvals(exe, env, hooks))) ?? null
  if (only.includes('second')) await step('second', () => second(exe, env, hooks, open && !open.exited ? open : null))
  else if (open) {
    open.closeStdin()
    if (!(await Promise.race([open.done, sleep(15_000).then(() => null)]))) open.kill()
  }
  await step('resume', () => resume(exe, env))
  await step('terminate', () => terminate(exe, env, hooks))
  await step('steer', () => steer(exe, env, hooks))
  await step('ask', () => ask(exe, env, hooks))
  hooks.server.close()
  hooks.server.closeAllConnections?.()
  console.log(`\nreal turns sent: ${turnsSent} (limit ${maxTurns})`)
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err))
  process.exitCode = 1
})
