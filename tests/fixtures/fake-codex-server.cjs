// A stand-in for `codex app-server` for the tests: speaks the same protocol over stdio (one JSON
// object per line, no "jsonrpc" member), with message shapes copied from docs/spikes-phase-b.md.
// What a turn does is chosen by words in the prompt:
//   "approve"  a command that needs approval (server request, ids start at 0); accept runs it, decline doesn't
//   "patch"    a file change that needs approval
//   "slow"     a command that runs until the turn is steered (then it finishes) or interrupted. As the
//              real server does when the process had not been spawned yet, an interrupt is followed
//              by a late `item/started` of that command, AFTER `turn/completed`
//   "fail"     a retry notice, then a failed turn (401)
//   "crash"    the process exits with code 1
//   "todo-list" a plan (`turn/plan/updated`, twice), then the one-line answer
// Every turn that ends reports the thread's running token total (`thread/tokenUsage/updated`, the
// shape recorded in docs/spikes-phase-b.md): 1000 input (400 of it cached) and 50 output per turn.
//   otherwise  a streamed one-line answer
// `thread/list` answers with the threads of this process that had a turn (as the real server does),
// one thread of another client in the same folder, and, in the folder FAKE_CODEX_OLD_CWD, "thr-old"
// (the thread with the recorded HISTORY).
// Environment: FAKE_CODEX_LOGGED_OUT=1, FAKE_CODEX_AUTH_URL=<url>, FAKE_CODEX_READONLY=1 (downgrade
// workspace-write, as an unconfigured Windows sandbox does), FAKE_CODEX_MARK=<file> (append a line per start).
// FAKE_CODEX_INJECT_FAILS=1 makes `thread/inject_items` (the office board's digest) fail.
// Extra methods for the tests: fake/log (everything received), fake/login/complete, fake/notify.
'use strict'
const fs = require('node:fs')

let loggedIn = process.env.FAKE_CODEX_LOGGED_OUT !== '1'
if (process.env.FAKE_CODEX_MARK) fs.appendFileSync(process.env.FAKE_CODEX_MARK, `${process.pid}\n`)

const received = []
let nextThread = 1
let nextTurn = 1
let nextItem = 1
let nextRequest = 0
let nextLogin = 1
/** threadId -> { turn: { id, onSteer, steers } | null, cwd, preview, recencyAt } (preview: the first prompt; null until then) */
const threads = new Map()
/** server request id -> { resolve(result), threadId } */
const waiting = new Map()

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() })
const reply = (id, result) => send({ id, result })
const fail = (id, message, code = -32600) => send({ id, error: { code, message } })
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequest++
    waiting.set(id, { resolve, threadId: params.threadId })
    send({ method, id, params })
  })

const HISTORY = [
  {
    id: 'turn-old-1',
    items: [
      { type: 'userMessage', id: 'u-old-1', clientId: null, content: [{ type: 'text', text: 'Create the note', text_elements: [] }] },
      { type: 'fileChange', id: 'exec-old-fc', changes: [{ path: 'C:\\ws\\ao-note.txt', kind: { type: 'add' }, diff: 'agent office\ncodex spike\n' }], status: 'completed' },
      { type: 'agentMessage', id: 'msg-old-1', text: 'Created ao-note.txt.', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }
    ],
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1790945825,
    completedAt: 1790945828,
    durationMs: 3000
  },
  {
    id: 'turn-old-2',
    items: [
      { type: 'userMessage', id: 'u-old-2', clientId: null, content: [{ type: 'text', text: 'Run the slow command', text_elements: [] }] },
      {
        type: 'commandExecution',
        id: 'exec-old-cmd',
        command: '"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "node -e \\"setTimeout(()=>{},25000)\\""',
        cwd: 'C:\\ws',
        processId: '95398',
        source: 'unifiedExecStartup',
        status: 'failed',
        commandActions: [{ type: 'unknown', command: 'node -e "setTimeout(()=>{},25000)"' }],
        aggregatedOutput: '',
        exitCode: -1,
        durationMs: 6818
      }
    ],
    itemsView: 'full',
    status: 'interrupted',
    error: null,
    startedAt: 1790945860,
    completedAt: 1790945866,
    durationMs: 6134
  }
]

function sandboxFor(mode) {
  if (mode === 'workspace-write' && process.env.FAKE_CODEX_READONLY !== '1') {
    return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
  return { type: 'readOnly', networkAccess: false }
}

function threadResponse(threadId, params) {
  return {
    thread: { id: threadId, sessionId: threadId, parentThreadId: null, preview: '', status: { type: 'idle' }, cwd: params.cwd ?? null, source: 'vscode', turns: [] },
    model: params.model ?? 'gpt-6-luna',
    modelProvider: 'openai',
    cwd: params.cwd ?? null,
    approvalPolicy: params.approvalPolicy ?? 'on-request',
    approvalsReviewer: 'user',
    sandbox: sandboxFor(params.sandbox),
    reasoningEffort: null,
    multiAgentMode: 'explicitRequestOnly'
  }
}

const command = (id, inner, extra) => ({
  type: 'commandExecution',
  id,
  pluginId: null,
  scriptPath: null,
  command: `"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "${inner.replace(/"/g, '\\"')}"`,
  cwd: 'C:\\ws',
  processId: null,
  source: 'agent',
  status: 'inProgress',
  commandActions: [{ type: 'unknown', command: inner }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...extra
})

function say(threadId, turnId, text, phase) {
  const id = `msg_${nextItem++}`
  const base = { type: 'agentMessage', id, phase, memoryCitation: null, delivery: null, questions: null }
  notify('item/started', { item: { ...base, text: '' }, threadId, turnId, startedAtMs: Date.now() })
  for (const word of text.split(/(?<= )/)) notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta: word })
  notify('item/completed', { item: { ...base, text }, threadId, turnId, completedAtMs: Date.now() })
}

function userEcho(threadId, turnId, input, clientId) {
  const item = { type: 'userMessage', id: `user-${nextItem++}`, clientId: clientId ?? null, content: input }
  notify('item/started', { item, threadId, turnId, startedAtMs: Date.now() })
  notify('item/completed', { item, threadId, turnId, completedAtMs: Date.now() })
}

function endTurn(threadId, turnId, status = 'completed', error = null) {
  const t = threads.get(threadId)
  if (!t || !t.turn || t.turn.id !== turnId) return
  t.turn = null
  t.usageTurns = (t.usageTurns || 0) + 1
  const n = t.usageTurns
  const last = { totalTokens: 1050, inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 }
  const total = { totalTokens: 1050 * n, inputTokens: 1000 * n, cachedInputTokens: 400 * n, cacheWriteInputTokens: 0, outputTokens: 50 * n, reasoningOutputTokens: 10 * n }
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total, last, modelContextWindow: 258400 } })
  notify('thread/status/changed', { threadId, status: { type: status === 'failed' ? 'systemError' : 'idle' } })
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status, error, startedAt: 1790945798, completedAt: 1790945808, durationMs: 10 } })
}

async function runTurn(threadId, turnId, params) {
  const text = params.input.map((i) => i.text ?? '').join(' ')
  const t = threads.get(threadId)
  notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
  notify('turn/started', { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1790945798, completedAt: null, durationMs: null } })
  userEcho(threadId, turnId, params.input, params.clientUserMessageId)

  if (/crash/.test(text)) return process.exit(1)

  if (/fail/.test(text)) {
    notify('error', { error: { message: 'Reconnecting... 2/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: null }, willRetry: true, threadId, turnId })
    const error = { message: 'unexpected status 401 Unauthorized: Missing bearer', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null }
    notify('error', { error, willRetry: false, threadId, turnId })
    return endTurn(threadId, turnId, 'failed', error)
  }

  if (/approve/.test(text)) {
    say(threadId, turnId, 'I’ll run the requested command.', 'commentary')
    const inner = `node -e "console.log('ao-fake')"`
    const id = `exec-${nextItem++}`
    notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } })
    notify('item/started', { item: command(id, inner), threadId, turnId, startedAtMs: Date.now() })
    const answer = await ask('item/commandExecution/requestApproval', {
      kind: 'command',
      threadId,
      turnId,
      itemId: id,
      startedAtMs: Date.now(),
      environmentId: 'local',
      command: command(id, inner).command,
      cwd: 'C:\\ws',
      commandActions: [{ type: 'unknown', command: inner }],
      availableDecisions: ['accept', 'cancel']
    })
    if (!t.turn || t.turn.id !== turnId) return // interrupted while waiting
    if (answer && answer.decision === 'accept') {
      notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
      notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: id, delta: 'ao-fake\n' })
      notify('item/completed', { item: command(id, inner, { processId: '1', source: 'unifiedExecStartup', status: 'completed', aggregatedOutput: 'ao-fake\n', exitCode: 0, durationMs: 116 }), threadId, turnId, completedAtMs: Date.now() })
      say(threadId, turnId, 'ao-fake', 'final_answer')
    } else {
      notify('item/completed', { item: command(id, inner, { status: 'declined' }), threadId, turnId, completedAtMs: Date.now() })
      // Give a deny message (sent as a steer right after the decision) the chance to arrive.
      await new Promise((r) => setTimeout(r, 150))
      const steer = t.turn && t.turn.steers.shift()
      if (steer) userEcho(threadId, turnId, steer.input, steer.clientUserMessageId)
      say(threadId, turnId, steer ? `Understood: ${steer.input[0].text}` : 'I’m not allowed to run the command.', 'final_answer')
    }
    return endTurn(threadId, turnId)
  }

  if (/patch/.test(text)) {
    const id = `exec-${nextItem++}`
    const item = { type: 'fileChange', id, changes: [{ path: 'C:\\ws\\ao-note.txt', kind: { type: 'add' }, diff: 'agent office\ncodex spike\n' }], status: 'inProgress' }
    notify('item/started', { item, threadId, turnId, startedAtMs: Date.now() })
    const answer = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: id, startedAtMs: Date.now(), reason: null, grantRoot: null })
    if (!t.turn || t.turn.id !== turnId) return
    const accepted = answer && answer.decision === 'accept'
    notify('item/completed', { item: { ...item, status: accepted ? 'completed' : 'declined' }, threadId, turnId, completedAtMs: Date.now() })
    if (!accepted) {
      // Give the reason (a steer right after the decline) the chance to arrive, as "approve" does.
      await new Promise((r) => setTimeout(r, 150))
      const steer = t.turn && t.turn.steers.shift()
      if (steer) userEcho(threadId, turnId, steer.input, steer.clientUserMessageId)
    }
    say(threadId, turnId, 'Done.', 'final_answer')
    return endTurn(threadId, turnId)
  }

  if (/slow/.test(text)) {
    const inner = `node -e "setTimeout(()=>console.log('slow-done'),25000)"`
    const id = `exec-${nextItem++}`
    notify('item/started', { item: command(id, inner, { processId: '2', source: 'unifiedExecStartup' }), threadId, turnId, startedAtMs: Date.now() })
    // Seen with codex-cli 0.160.0: the command's process start is announced after the interrupted turn ended.
    t.turn.afterInterrupt = () => notify('item/started', { item: command(id, inner, { processId: '2', source: 'unifiedExecStartup', aggregatedOutput: 'late output\n' }), threadId, turnId, startedAtMs: Date.now() })
    t.turn.onSteer = (steer) => {
      notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: id, delta: 'slow-done\n' })
      notify('item/completed', { item: command(id, inner, { processId: '2', source: 'unifiedExecStartup', status: 'completed', aggregatedOutput: 'slow-done\n', exitCode: 0, durationMs: 25116 }), threadId, turnId, completedAtMs: Date.now() })
      userEcho(threadId, turnId, steer.input, steer.clientUserMessageId)
      say(threadId, turnId, `slow-done (${steer.input[0].text})`, 'final_answer')
      endTurn(threadId, turnId)
    }
    return
  }

  if (/todo-list/.test(text)) {
    const plan = (first, second) => [{ step: 'Read the notes', status: first }, { step: 'Write the summary', status: second }]
    notify('turn/plan/updated', { threadId, turnId, explanation: 'Two steps', plan: plan('inProgress', 'pending') })
    await new Promise((r) => setTimeout(r, 60))
    notify('turn/plan/updated', { threadId, turnId, explanation: 'Two steps', plan: plan('completed', 'inProgress') })
    await new Promise((r) => setTimeout(r, 60))
  }

  say(threadId, turnId, 'ok', 'final_answer')
  notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 2, windowDurationMins: 43200, resetsAt: 1793537731 }, secondary: null, planType: 'free' } })
  endTurn(threadId, turnId)
}

function handle(msg) {
  const { id, method, params = {} } = msg
  if (method === undefined) {
    // A response to one of our requests.
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    // The real server confirms every resolved request, also the ones the client answered.
    notify('serverRequest/resolved', { threadId: w.threadId, requestId: id })
    return w.resolve(msg.result)
  }
  received.push(msg)
  switch (method) {
    case 'initialize':
      if (process.env.FAKE_CODEX_SILENT === '1') return
      return reply(id, { userAgent: 'agent_office/0.160.0 (fake)', codexHome: 'C:\\fake\\.codex', platformFamily: 'windows', platformOs: 'windows' })
    case 'initialized':
      return notify('remoteControl/status/changed', { status: 'disabled' })
    case 'account/read':
      return reply(id, { account: loggedIn ? { type: 'chatgpt', email: 'someone@example.com', planType: 'free' } : null, requiresOpenaiAuth: true })
    case 'account/rateLimits/read':
      if (!loggedIn) return fail(id, 'codex account authentication required to read rate limits')
      return reply(id, { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 43200, resetsAt: 1793536961 }, secondary: null, planType: 'free' } })
    case 'account/login/start':
      return reply(id, { type: 'chatgpt', loginId: `login-${nextLogin++}`, authUrl: process.env.FAKE_CODEX_AUTH_URL ?? 'https://auth.openai.com/oauth/authorize?response_type=code&originator=agent_office' })
    case 'account/login/cancel':
      reply(id, { status: 'canceled' })
      return notify('account/login/completed', { loginId: params.loginId, success: false, error: 'Login was not completed' })
    case 'fake/login/complete':
      loggedIn = true
      reply(id, {})
      notify('account/login/completed', { loginId: `login-${nextLogin - 1}`, success: true, error: null })
      return notify('account/updated', { authMode: 'chatgpt', planType: 'free' })
    case 'fake/logout':
      loggedIn = false
      reply(id, {})
      return notify('account/updated', { authMode: null, planType: null })
    case 'fake/log':
      return reply(id, { received })
    case 'fake/notify':
      reply(id, {})
      return notify(params.method, params.params)
    case 'thread/start': {
      const threadId = `thr-${process.pid}-${nextThread++}`
      threads.set(threadId, { turn: null, cwd: params.cwd ?? null, preview: null, recencyAt: 0 })
      reply(id, threadResponse(threadId, params))
      return notify('thread/started', { thread: { id: threadId, parentThreadId: null } })
    }
    case 'thread/resume': {
      if (params.threadId === 'thr-missing') return fail(id, `no rollout found for thread id ${params.threadId}`)
      if (!threads.has(params.threadId)) threads.set(params.threadId, { turn: null, cwd: params.cwd ?? null, preview: params.threadId === 'thr-old' ? 'Create the note' : null, recencyAt: 1790945866 })
      notify('thread/status/changed', { threadId: params.threadId, status: { type: 'idle' } })
      return reply(id, threadResponse(params.threadId, params))
    }
    case 'thread/list': {
      if (!loggedIn) return fail(id, 'codex account authentication required')
      const entry = (threadId, t, originator) => ({
        id: threadId, sessionId: threadId, parentThreadId: null, preview: t.preview, ephemeral: false, model: 'gpt-6-luna',
        createdAt: t.recencyAt - 60, updatedAt: t.recencyAt - 60, recencyAt: t.recencyAt, status: { type: 'notLoaded' },
        path: String.raw`C:\fake\.codex\sessions\rollout-${threadId}.jsonl`, cwd: t.cwd, cliVersion: '0.160.0', originator, source: 'vscode', turns: []
      })
      const data = [...threads].filter(([tid, t]) => t.preview !== null && tid !== 'thr-old').map(([tid, t]) => entry(tid, t, 'agent_office'))
      // Somebody else's thread in the same folder (the CLI, the desktop app): not ours to offer.
      data.push(entry('thr-desktop', { preview: 'A desktop app thread', recencyAt: 1790945000, cwd: params.cwd ?? null }, 'Codex Desktop'))
      if (process.env.FAKE_CODEX_OLD_CWD) data.push(entry('thr-old', { preview: 'Create the note', recencyAt: 1790945866, cwd: process.env.FAKE_CODEX_OLD_CWD }, 'agent_office'))
      const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
      return reply(id, { data: data.filter((d) => params.cwd === undefined || same(d.cwd, params.cwd)).slice(0, params.limit ?? 50), nextCursor: null, backwardsCursor: null })
    }
    case 'thread/turns/list': {
      const data = params.threadId === 'thr-old' ? HISTORY : []
      return reply(id, { data: params.sortDirection === 'desc' ? [...data].reverse() : data, nextCursor: null, backwardsCursor: null })
    }
    case 'thread/inject_items':
      if (!threads.has(params.threadId)) return fail(id, `thread not found: ${params.threadId}`)
      if (process.env.FAKE_CODEX_INJECT_FAILS === '1') return fail(id, 'inject failed')
      return reply(id, {})
    case 'thread/unsubscribe':
      return reply(id, { status: threads.has(params.threadId) ? 'unsubscribed' : 'notLoaded' })
    case 'turn/start': {
      const t = threads.get(params.threadId)
      if (!t) return fail(id, `thread not found: ${params.threadId}`)
      if (!loggedIn) return fail(id, 'not logged in')
      const turnId = `turn-${nextTurn++}`
      t.turn = { id: turnId, onSteer: null, steers: [] }
      if (t.preview === null) t.preview = params.input.map((i) => i.text ?? '').join(' ')
      t.recencyAt = Math.floor(Date.now() / 1000)
      reply(id, { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } })
      return void runTurn(params.threadId, turnId, params)
    }
    case 'turn/steer': {
      const t = threads.get(params.threadId)
      if (!t || !t.turn) return fail(id, 'no active turn to steer')
      if (t.turn.id !== params.expectedTurnId) return fail(id, `expected active turn id \`${params.expectedTurnId}\` but found \`${t.turn.id}\``)
      reply(id, { turnId: t.turn.id })
      if (t.turn.onSteer) {
        const fn = t.turn.onSteer
        t.turn.onSteer = null
        return fn(params)
      }
      return void t.turn.steers.push(params)
    }
    case 'turn/interrupt': {
      const t = threads.get(params.threadId)
      if (!t || !t.turn) return fail(id, 'no active turn to interrupt')
      reply(id, {})
      // As observed: no item/completed for the command that was running.
      for (const [rid, w] of [...waiting]) {
        if (w.threadId !== params.threadId) continue
        waiting.delete(rid)
        notify('serverRequest/resolved', { threadId: params.threadId, requestId: rid })
        w.resolve(null)
      }
      const late = t.turn.afterInterrupt
      endTurn(params.threadId, t.turn.id, 'interrupted')
      if (late) late()
      return
    }
    default:
      if (id !== undefined) fail(id, `unknown method ${method}`, -32601)
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
// Like the real server: closing stdin makes it exit with code 0.
process.stdin.on('end', () => process.exit(0))
process.stderr.write('\u001b[2mfake codex app-server started\u001b[0m\n')
