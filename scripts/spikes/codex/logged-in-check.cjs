// Phase B: everything the logged-out spikes could not verify. Needs a logged-in Codex (`codex login`,
// or the Codex desktop app) in the DEFAULT home (~/.codex). It runs real model turns, so it spends a
// little of the account's Codex allowance: seven short turns at low reasoning effort (eight with --subagent).
// It stops at the first usage or rate limit error.
//
//   node scripts/spikes/codex/logged-in-check.cjs [--root <scratch dir>] [--model <id>] [--effort low]
//        [--sandbox workspace-write|read-only] [--only a,b,c] [--subagent] [--with-plugins]
//
// Steps (names for --only), one turn each unless noted
//   account    no turn. account/read, account/rateLimits/read, model/list. Stops if logged out.
//   approval   `node -e "console.log('ao-codex')"` with approvalPolicy "on-request". Approvals are accepted.
//   decline    the same kind of command with approvalPolicy "untrusted" (which must ask). The approval is DECLINED.
//   filechange asks for a small new file with approvalPolicy "untrusted". Approvals are accepted.
//   steer      a turn that runs a slow command; turn/steer is sent once the command item has started.
//   interrupt  a turn that runs a slow command; turn/interrupt is sent once the command item has started.
//   websearch  asks for one web search (also shows whether the thread still works after an interrupt).
//   escalate   a command that writes a file, with a read-only sandbox and approvalPolicy "on-request": the
//              sandbox blocks it, so the model has to ask to run it outside. Approvals are accepted.
//   resume     no turn. A second app-server process: thread/list, thread/resume {excludeTurns:true}, thread/turns/list.
//   subagent   (--subagent only) asks for one sub-agent; records which threadIds the notifications carry.
//
// The server is started with `--disable plugins --disable apps -c mcp_servers.node_repl.enabled=false`, so the
// desktop app's MCP servers and plugins stay out of it (nothing is written to config.toml). --with-plugins
// leaves the user's configuration as it is.
//
// All commands the model is asked to run are harmless (node -e console.log, a 25 s node timer, one small text
// file) and run in a scratch directory. Everything is logged to scripts/spikes/codex/logs/logged-in*.log.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CodexRpc, sleep } = require('./rpc.cjs')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const root = path.resolve(flag('--root') ?? path.join(os.tmpdir(), 'ao-codex-spike'))
const workdir = path.join(root, 'ws-logged-in')
const model = flag('--model')
const effort = flag('--effort') ?? 'low'
const sandboxMode = flag('--sandbox') ?? 'workspace-write'
const only = flag('--only')?.split(',')
const want = (step) => !only || only.includes(step)
const logDir = path.join(__dirname, 'logs')
const serverArgs = argv.includes('--with-plugins') ? [] : ['--disable', 'plugins', '--disable', 'apps', '-c', 'mcp_servers.node_repl.enabled=false']
const text = (t) => [{ type: 'text', text: t, text_elements: [] }]
// Slow, and needs neither the network nor write access (the sandbox has both switched off).
const SLOW = `node -e "setTimeout(()=>console.log('slow-done'),25000)"`

const findings = []
const note = (key, value) => {
  findings.push([key, value])
  console.log(`\n### ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}

/** Answers every server -> client request, and remembers them. `mode.decision` is what approvals get. */
function approvalHandler(seen, mode) {
  return (msg) => {
    seen.push(msg)
    switch (msg.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: mode.decision }
      case 'item/permissions/requestApproval':
        // Grant nothing extra, for this turn only.
        return { permissions: {}, scope: 'turn' }
      case 'item/tool/requestUserInput':
        return { answers: {} }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      default:
        return undefined // answered with a JSON-RPC error by rpc.cjs
    }
  }
}

class OutOfQuota extends Error {}

/** Runs one turn to its turn/completed. `during` is called for every notification of the turn. */
async function runTurn(c, threadId, prompt, overrides = {}, during = () => {}) {
  const from = c.notifications.length
  const started = await c.try('turn/start', { threadId, input: text(prompt), effort, ...(model ? { model } : {}), ...overrides })
  if (started.error) return { error: started.error, notifications: [], items: [], count: {} }
  const turnId = started.result.turn.id
  let completed = null
  const deadline = Date.now() + 240_000
  let seen = from
  while (!completed && Date.now() < deadline && !c.exited) {
    for (; seen < c.notifications.length; seen++) {
      const n = c.notifications[seen]
      if (n.params?.turnId !== undefined && n.params.turnId !== turnId) continue
      await during(n, turnId)
      if (n.method === 'turn/completed' && n.params.turn.id === turnId) completed = n.params.turn
    }
    if (!completed) await sleep(50)
  }
  const notifications = c.notifications.slice(from)
  const count = {}
  for (const n of notifications) count[n.method] = (count[n.method] ?? 0) + 1
  const items = notifications.filter((n) => n.method === 'item/completed').map((n) => n.params.item)
  const info = completed?.error?.codexErrorInfo
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'sessionBudgetExceeded') {
    throw new OutOfQuota(`${info}: ${completed.error.message}`)
  }
  return { turnId, turn: completed, notifications, count, items }
}

const itemSummary = (items) =>
  items.map((i) => {
    if (i.type === 'commandExecution') return `commandExecution[${i.status} exit=${i.exitCode} actions=${i.commandActions.map((a) => a.type).join('+')}] ${i.command}`
    if (i.type === 'agentMessage') return `agentMessage[${i.phase}] ${JSON.stringify(i.text.slice(0, 160))}`
    if (i.type === 'userMessage') return `userMessage ${JSON.stringify(i.content.map((c) => c.text ?? c.type).join(' ').slice(0, 120))}`
    if (i.type === 'reasoning') return `reasoning summary=${i.summary.length} content=${i.content.length}`
    if (i.type === 'fileChange') return `fileChange[${i.status}] ${i.changes.map((ch) => `${ch.kind.type} ${ch.path}`).join(', ')}`
    if (i.type === 'webSearch') return `webSearch ${JSON.stringify(i.query)} action=${JSON.stringify(i.action)}`
    if (i.type === 'collabAgentToolCall') return `collabAgentToolCall[${i.tool} ${i.status}] receivers=${i.receiverThreadIds.join(',')}`
    return i.type
  })

const turnNote = (t, requests, before) => ({
  status: t.turn?.status,
  error: t.turn?.error ?? t.error,
  durationMs: t.turn?.durationMs,
  serverRequests: requests.slice(before).map((r) => r.method),
  notifications: t.count
})

async function main() {
  fs.mkdirSync(workdir, { recursive: true })
  const requests = []
  const mode = { decision: 'accept' }
  const c = new CodexRpc({ logFile: path.join(logDir, 'logged-in.log'), cwd: workdir, args: serverArgs, onRequest: approvalHandler(requests, mode) }).start()
  let threadId
  try {
    const init = await c.initialize()
    note('codexHome', init.codexHome)

    // ---- account ----
    const account = await c.try('account/read', { refreshToken: false })
    if (!account.result?.account) {
      note('account', 'NOT LOGGED IN. Run `codex login` (or sign in to the Codex app) and try again.')
      return
    }
    note('account', { type: account.result.account.type, planType: account.result.account.planType })
    const limits = await c.try('account/rateLimits/read')
    note('rateLimits', limits.result ? { ordinaryUsageAllowed: limits.result.ordinaryUsageAllowed, primary: limits.result.rateLimits.primary, secondary: limits.result.rateLimits.secondary, credits: limits.result.rateLimits.credits } : limits.error)
    if (limits.result && limits.result.ordinaryUsageAllowed === false) {
      note('STOP', 'the account has no Codex usage left (ordinaryUsageAllowed=false)')
      return
    }
    const models = await c.try('model/list', { limit: 50 })
    note('models', models.result ? models.result.data.map((m) => `${m.id}${m.isDefault ? ' (default)' : ''}`) : models.error)
    note('windowsSandbox/readiness', (await c.try('windowsSandbox/readiness')).result ?? 'n/a')
    if (only && only.every((s) => s === 'account')) return

    // ---- thread ----
    const started = await c.try('thread/start', {
      cwd: workdir,
      sandbox: sandboxMode,
      approvalPolicy: 'on-request',
      ...(model ? { model } : {}),
      developerInstructions: 'This is an automated protocol check. Do exactly what is asked, with the shell tool where a command is given, and keep answers to one line.'
    })
    if (started.error) return note('thread/start FAILED', started.error)
    threadId = started.result.thread.id
    note('thread', { id: threadId, model: started.result.model, approvalPolicy: started.result.approvalPolicy, sandbox: started.result.sandbox, path: started.result.thread.path })

    // ---- approval (on-request, accept) ----
    if (want('approval')) {
      const before = requests.length
      const t = await runTurn(c, threadId, `Run the command: node -e "console.log('ao-codex')"`, { approvalPolicy: 'on-request' })
      note('approval turn (on-request)', turnNote(t, requests, before))
      note('approval turn items', itemSummary(t.items))
      if (requests.length > before) note('approval turn first request', requests[before])
    }

    // ---- decline (untrusted, decline) ----
    if (want('decline')) {
      const before = requests.length
      mode.decision = 'decline'
      const t = await runTurn(c, threadId, `Run the command: node -e "console.log('ao-declined')"\nIf you are not allowed to run it, say so in one line and stop.`, { approvalPolicy: 'untrusted' })
      mode.decision = 'accept'
      note('decline turn (untrusted)', turnNote(t, requests, before))
      note('decline turn items', itemSummary(t.items))
      if (requests.length > before) note('decline turn first request', requests[before])
    }

    // ---- file change (untrusted, accept) ----
    if (want('filechange')) {
      const before = requests.length
      const t = await runTurn(c, threadId, 'Create a file named ao-note.txt in the current directory containing exactly the two lines "agent office" and "codex spike". Use your file editing tool (apply_patch), not a shell command.', { approvalPolicy: 'untrusted' })
      note('filechange turn (untrusted)', turnNote(t, requests, before))
      note('filechange turn items', itemSummary(t.items))
      for (const r of requests.slice(before)) note(`filechange turn request ${r.method}`, r)
      const fc = t.items.find((i) => i.type === 'fileChange')
      if (fc) note('fileChange item', fc)
      note('file on disk', fs.existsSync(path.join(workdir, 'ao-note.txt')) ? fs.readFileSync(path.join(workdir, 'ao-note.txt'), 'utf8') : '(not created)')
    }

    const lifecycle = () => ({
      serverRequestResolved: c.notifications.filter((n) => n.method === 'serverRequest/resolved').length,
      statusWaitingOnApproval: c.notifications.filter((n) => n.method === 'thread/status/changed' && n.params.status.activeFlags?.includes('waitingOnApproval')).length,
      requests: requests.length
    })
    note('approval lifecycle so far', lifecycle())

    // ---- steer ----
    if (want('steer')) {
      let steer = null
      const t = await runTurn(c, threadId, `Run the command: ${SLOW}\nThen answer with what it printed.`, { approvalPolicy: 'never' }, async (n, turnId) => {
        if (steer || n.method !== 'item/started' || n.params.item.type !== 'commandExecution') return
        steer = { sentAfterItem: n.params.item.id }
        await sleep(1500)
        steer.response = await c.try('turn/steer', { threadId, expectedTurnId: turnId, input: text('Also: end your final answer with the exact word steered-ok.') })
        // A second steer with a wrong turn id: the precondition error.
        steer.wrongTurn = await c.try('turn/steer', { threadId, expectedTurnId: '00000000-0000-7000-8000-000000000000', input: text('ignored') })
      })
      const final = t.items.filter((i) => i.type === 'agentMessage').pop()
      note('steer', {
        status: t.turn?.status,
        error: t.turn?.error ?? t.error,
        steer,
        sameTurn: steer?.response?.result?.turnId === t.turnId,
        userMessageItems: t.items.filter((i) => i.type === 'userMessage').length,
        finalHasMarker: !!final?.text.includes('steered-ok'),
        notifications: t.count
      })
      note('steer items', itemSummary(t.items))
    }

    // ---- interrupt ----
    if (want('interrupt')) {
      let interrupt = null
      const t0 = Date.now()
      const t = await runTurn(c, threadId, `Run the command: ${SLOW}`, { approvalPolicy: 'never' }, async (n, turnId) => {
        if (interrupt || n.method !== 'item/started' || n.params.item.type !== 'commandExecution') return
        interrupt = { commandStartedAtMs: Date.now() - t0 }
        await sleep(1500)
        interrupt.sentAtMs = Date.now() - t0
        interrupt.response = await c.try('turn/interrupt', { threadId, turnId })
      })
      note('interrupt', { status: t.turn?.status, error: t.turn?.error ?? t.error, interrupt, turnEndedAtMs: Date.now() - t0, notifications: t.count })
      note('interrupt items', itemSummary(t.items))
    }

    // ---- web search (and: is the thread usable after an interrupt?) ----
    if (want('websearch')) {
      const before = requests.length
      const t = await runTurn(c, threadId, 'Use your web search tool once to look up "Electron utilityProcess" and reply with the title of the first result. If you have no web search tool, reply exactly: no web search tool.', { approvalPolicy: 'never' })
      note('websearch turn', turnNote(t, requests, before))
      note('websearch items', itemSummary(t.items))
      const ws = t.items.find((i) => i.type === 'webSearch')
      if (ws) note('webSearch item', ws)
    }

    // ---- escalate (read-only sandbox + on-request: the command must ask to leave the sandbox) ----
    // Last, because the sandboxPolicy override stays on the thread for later turns.
    if (want('escalate')) {
      const before = requests.length
      const t = await runTurn(
        c,
        threadId,
        `Run the command: node -e "require('fs').writeFileSync('ao-escalate.txt','ok')"
If the sandbox blocks it, request approval to run it without the sandbox. Then say whether the file was written.`,
        { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
      )
      note('escalate turn (read-only, on-request)', turnNote(t, requests, before))
      note('escalate turn items', itemSummary(t.items))
      for (const r of requests.slice(before)) note(`escalate turn request ${r.method}`, r)
      note('escalate file on disk', fs.existsSync(path.join(workdir, 'ao-escalate.txt')))
    }

    // ---- subagent ----
    if (argv.includes('--subagent') && want('subagent')) {
      const t = await runTurn(c, threadId, 'Spawn exactly one sub-agent and have it list the files in the current directory. Report what it found.', { approvalPolicy: 'never' })
      const threadIds = [...new Set(c.notifications.map((n) => n.params?.threadId ?? n.params?.thread?.id).filter(Boolean))]
      note('subagent', {
        status: t.turn?.status,
        threadIdsSeenOnThisConnection: threadIds,
        threadStarted: c.notifications.filter((n) => n.method === 'thread/started').map((n) => ({ id: n.params.thread.id, parentThreadId: n.params.thread.parentThreadId, agentNickname: n.params.thread.agentNickname, agentRole: n.params.thread.agentRole, source: n.params.thread.source })),
        collabItems: c.notifications.filter((n) => n.method === 'item/completed' && ['collabAgentToolCall', 'subAgentActivity'].includes(n.params.item.type)).map((n) => n.params.item)
      })
    }

    note('all notification methods seen', [...new Set(c.notifications.map((n) => n.method))])
    note('all server requests seen', [...new Set(requests.map((r) => r.method))])
    note('approval lifecycle', lifecycle())
    note('rateLimits after', (await c.try('account/rateLimits/read')).result?.rateLimits.primary ?? null)
  } catch (err) {
    if (!(err instanceof OutOfQuota)) throw err
    note('STOP: out of quota', err.message)
  } finally {
    await c.stop()
  }

  // ---- resume ("app restart") ----
  if (threadId && want('resume')) {
    const c2 = new CodexRpc({ logFile: path.join(logDir, 'logged-in-resume.log'), cwd: workdir, args: serverArgs, onRequest: approvalHandler([], { decision: 'decline' }) }).start()
    try {
      await c2.initialize()
      const list = await c2.try('thread/list', { limit: 10, cwd: workdir })
      note('thread/list (cwd filter)', (list.result?.data ?? []).map((t) => ({ id: t.id, preview: t.preview, status: t.status, source: t.source, originator: t.originator, updatedAt: t.updatedAt })))
      const resumed = await c2.try('thread/resume', { threadId, excludeTurns: true })
      note('thread/resume', resumed.result ? { status: resumed.result.thread.status, approvalPolicy: resumed.result.approvalPolicy, sandbox: resumed.result.sandbox, turnsInResponse: resumed.result.thread.turns.length } : resumed.error)
      const turns = await c2.try('thread/turns/list', { threadId, limit: 20, sortDirection: 'asc', itemsView: 'full' })
      note('thread/turns/list', turns.result ? turns.result.data.map((t) => ({ id: t.id, status: t.status, items: t.items.map((i) => i.type) })) : turns.error)
      await c2.try('thread/unsubscribe', { threadId })
    } finally {
      await c2.stop()
    }
  }

  console.log('\n================ summary ================')
  for (const [k, v] of findings) console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  fs.writeFileSync(path.join(logDir, 'logged-in-summary.log'), findings.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`).join('\n\n') + '\n')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
