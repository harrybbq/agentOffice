// Phase B (main process): the Codex driver on `codex app-server`.
// Pure mappings are tested with the JSON recorded in docs/spikes-phase-b.md; the JSON-RPC client, the
// driver and the session manager run against tests/fixtures/fake-codex-server.cjs (same protocol over
// stdio). No real Codex and no model turn is used here: see scripts/e2e-phase-b.cjs for that.
// Run: npm test   (chained from hosted.test.ts)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAT_MAX_PROMPT_CHARS, type ChatEvent, type ChatItem } from '../shared/chat.ts'
import type { AgentEvent } from '../shared/events.ts'
import { REASON_DISABLED } from '../shared/orders.ts'
import { subagentId, type PermissionRequestInfo, type ProviderInfo, type SessionInfo } from '../shared/sessions.ts'
import { ClaudeHookMapper } from '../electron/adapters/claude-code-hooks.ts'
import { officeBriefing } from '../electron/drivers/briefing.ts'
import { codexProvider } from '../electron/drivers/codex.ts'
import { approvalResult, describeServerRequest } from '../electron/drivers/codexApproval.ts'
import { clientMessageId, CodexChat, originOfClientId, unifiedDiff } from '../electron/drivers/codexChat.ts'
import {
  accountInfo,
  commandIntent,
  describeTurnError,
  innerCommand,
  isAllowedLoginUrl,
  NOT_LOGGED_IN,
  parseWireLine,
  policyFor,
  sandboxMismatch,
  threadIdOf,
  usageInfo
} from '../electron/drivers/codexProtocol.ts'
import { codexEnv, CodexRpcError, CodexServer, type CodexServerEvent, type CodexSpawnSpec } from '../electron/drivers/codexServer.ts'
import { collabInfo, worldActivityForItem } from '../electron/drivers/codexWorld.ts'
import type { PtyHost } from '../electron/drivers/types.ts'
import { SessionManager } from '../electron/sessions.ts'

let pass = 0
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn()
  pass++
  console.log('ok -', name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(cond: () => T, what: string, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = cond()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}

// ---- samples (docs/spikes-phase-b.md; <T> = thread, <W> = working directory) ------------------------

const T = '01a0fcb0-27ea-77c1-9acb-874a42b30573'
const W = 'C:\\scratch\\ws-logged-in'
const PS = '"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command '
const cmdItem = (id: string, inner: string, extra: Record<string, unknown> = {}) => ({
  type: 'commandExecution',
  id,
  pluginId: null,
  scriptPath: null,
  command: `${PS}"${inner.replace(/"/g, '\\"')}"`,
  cwd: W,
  processId: '93390',
  source: 'unifiedExecStartup',
  status: 'inProgress',
  commandActions: [{ type: 'unknown', command: inner }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...extra
})
const userItem = (id: string, text: string, clientId: string | null = null) => ({ type: 'userMessage', id, clientId, content: [{ type: 'text', text, text_elements: [] }] })
const msgItem = (id: string, text: string, phase: string) => ({ type: 'agentMessage', id, text, phase, memoryCitation: null, delivery: null, questions: null })
const started = (item: unknown, turnId: string, at = 1790945799843) => ['item/started', { item, threadId: T, turnId, startedAtMs: at }] as const
const completed = (item: unknown, turnId: string, at = 1790945800000) => ['item/completed', { item, threadId: T, turnId, completedAtMs: at }] as const
const turnStarted = (id: string) => ['turn/started', { threadId: T, turn: { id, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1790945798, completedAt: null, durationMs: null } }] as const
const turnCompleted = (id: string, status = 'completed', error: unknown = null) =>
  ['turn/completed', { threadId: T, turn: { id, items: [], itemsView: 'notLoaded', status, error, startedAt: 1790945798, completedAt: 1790945808, durationMs: 10499 } }] as const

/** A chat model plus what a renderer would hold after applying every event it was sent. */
function chatHarness(limits = {}) {
  const chat = new CodexChat('S', limits)
  const view: ChatItem[] = []
  const events: ChatEvent[] = []
  let now = 1_000
  const take = (list: readonly ChatEvent[]) => {
    for (const e of list) {
      events.push(e)
      if (e.type === 'reset') view.splice(0, view.length, ...e.items)
      else if (e.type === 'item') {
        const i = view.findIndex((x) => x.id === e.item.id)
        if (i >= 0) view[i] = e.item
        else view.push(e.item)
      } else if (e.type === 'delta') {
        const item = view.find((x) => x.id === e.itemId) as Record<string, unknown> | undefined
        assert.ok(item, `delta for an item the renderer never got: ${e.itemId}`)
        if (e.field === 'summary') (item.summary as string[])[e.index ?? 0] += e.delta
        else item[e.field] = (item[e.field] as string) + e.delta
      }
    }
    return list
  }
  const ctx = (agentId = 'S') => ({ agentId, now: ++now })
  const feed = (...ns: (readonly [string, Record<string, unknown>])[]) => ns.flatMap(([m, p]) => [...take(chat.apply(m, p, ctx()))])
  return { chat, view, events, take, feed, ctx, tick: (ms: number) => (now += ms) }
}
const kinds = (items: readonly ChatItem[]) => items.map((i) => i.kind)

// ---- protocol ---------------------------------------------------------------------------------------

await t('wire: responses, notifications and server requests (id 0 is a valid id)', () => {
  assert.deepEqual(parseWireLine('{"id":1,"result":{"userAgent":"x"}}'), { kind: 'response', id: 1, result: { userAgent: 'x' } })
  assert.deepEqual(parseWireLine('{"error":{"code":-32600,"message":"no active turn to steer"},"id":11}'), {
    kind: 'response',
    id: 11,
    error: { code: -32600, message: 'no active turn to steer' }
  })
  const req = parseWireLine(`{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"${T}","itemId":"exec-1"}}`)
  assert.equal(req?.kind, 'request')
  assert.equal(req?.kind === 'request' && req.id, 0)
  const note = parseWireLine(`{"method":"thread/status/changed","params":{"threadId":"${T}","status":{"type":"idle"}},"emittedAtMs":1790944960149}`)
  assert.deepEqual(note, { kind: 'notification', method: 'thread/status/changed', params: { threadId: T, status: { type: 'idle' } } })
  assert.deepEqual(parseWireLine('{"method":"initialized"}'), { kind: 'notification', method: 'initialized', params: {} })
  for (const bad of ['', 'not json', '[]', '{"result":1}', '{"id":null,"result":1}', '42']) assert.equal(parseWireLine(bad), null, bad)
  // Routing: most carry threadId; thread/started carries the thread; account/* carry neither.
  assert.equal(threadIdOf({ threadId: T }), T)
  assert.equal(threadIdOf({ thread: { id: T } }), T)
  assert.equal(threadIdOf({ authMode: 'chatgpt' }), null)
})

await t('permission mode -> approval policy + sandbox (the user decision)', () => {
  assert.deepEqual(
    (['default', 'acceptEdits', 'plan'] as const).map((m) => [policyFor(m).approvalPolicy, policyFor(m).sandbox, policyFor(m).sandboxPolicy.type]),
    [
      ['untrusted', 'workspace-write', 'workspaceWrite'],
      ['on-request', 'workspace-write', 'workspaceWrite'],
      ['on-request', 'read-only', 'readOnly']
    ]
  )
  // turn/start takes the object form; every field the server's type requires is there.
  assert.deepEqual(policyFor('default').sandboxPolicy, { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
  assert.deepEqual(policyFor('plan').sandboxPolicy, { type: 'readOnly', networkAccess: false })
  // Neither `never` nor full access is ever produced.
  for (const m of ['default', 'acceptEdits', 'plan'] as const) assert.ok(!/never|danger/i.test(JSON.stringify(policyFor(m))))

  // A silent downgrade (Windows sandbox not configured) is noticed.
  const ok = { sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } }
  const downgraded = { sandbox: { type: 'readOnly', networkAccess: false } }
  assert.equal(sandboxMismatch(policyFor('default'), ok), null)
  assert.match(sandboxMismatch(policyFor('default'), downgraded) ?? '', /read-only.*Windows sandbox/)
  assert.match(sandboxMismatch(policyFor('acceptEdits'), downgraded) ?? '', /read-only/)
  assert.equal(sandboxMismatch(policyFor('plan'), downgraded), null)
  assert.equal(sandboxMismatch(policyFor('default'), {}), null) // nothing to compare
})

await t('login URL: only https on OpenAI login hosts is opened', () => {
  const real =
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&originator=agent_office'
  assert.ok(isAllowedLoginUrl(real))
  assert.ok(isAllowedLoginUrl('https://chatgpt.com/auth/login'))
  assert.ok(isAllowedLoginUrl('https://AUTH.OPENAI.COM/x'))
  for (const bad of [
    'http://auth.openai.com/oauth/authorize',
    'https://auth.openai.com.evil.example/oauth',
    'https://evil.example/?u=https://auth.openai.com/',
    'https://auth.openai.com@evil.example/',
    'https://user:pw@auth.openai.com/',
    'https://auth.openai.com:8443/',
    'https://sub.chatgpt.com/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ms-settings:',
    '',
    'auth.openai.com',
    null,
    42,
    `https://auth.openai.com/${'a'.repeat(5000)}`
  ]) {
    assert.ok(!isAllowedLoginUrl(bad), String(bad).slice(0, 60))
  }
})

await t('account + usage from account/read and account/rateLimits/*', () => {
  assert.deepEqual(accountInfo({ account: { type: 'chatgpt', email: 'x@example.com', planType: 'free' }, requiresOpenaiAuth: true }), { loggedIn: true, plan: 'free' })
  assert.deepEqual(accountInfo({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }), { loggedIn: false })
  assert.deepEqual(accountInfo({ account: { type: 'apiKey' } }), { loggedIn: true, plan: 'API key' })
  assert.deepEqual(accountInfo(undefined), { loggedIn: false })
  // The e-mail address never leaves the main process.
  assert.ok(!JSON.stringify(accountInfo({ account: { type: 'chatgpt', email: 'x@example.com', planType: 'free' } })).includes('example.com'))
  const read = { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 43200, resetsAt: 1793536961 }, secondary: null, planType: 'free' } }
  assert.deepEqual(usageInfo(read), { usedPercent: 1, resetsAt: 1793536961000, windowMinutes: 43200 })
  assert.deepEqual(usageInfo({ rateLimits: { primary: { usedPercent: 250, windowDurationMins: null, resetsAt: null } } }), { usedPercent: 100 })
  assert.equal(usageInfo({ rateLimits: { primary: null } }), undefined)
  assert.equal(usageInfo({}), undefined)

  assert.equal(describeTurnError({ message: 'unexpected status 401 Unauthorized', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }), NOT_LOGGED_IN)
  assert.equal(describeTurnError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }), 'Codex usage limit reached')
  assert.equal(describeTurnError({ message: ' boom\n now ', codexErrorInfo: 'other' }), 'boom now')
})

await t('commands: the inner command is shown, intent comes from commandActions', () => {
  const item = cmdItem('exec-1', `node -e "console.log('ao-codex')"`)
  assert.equal(innerCommand(item.command, item.commandActions), `node -e "console.log('ao-codex')"`)
  assert.equal(innerCommand('git status', []), 'git status')
  assert.equal(innerCommand('x', [{ type: 'search', command: 'rg foo' }, { type: 'read', command: 'head -5' }]), 'rg foo | head -5')
  assert.equal(commandIntent([{ type: 'unknown', command: 'node x' }]), 'exec')
  assert.equal(commandIntent([]), 'exec')
  assert.equal(commandIntent([{ type: 'read', command: 'cat a', name: 'a', path: 'a' }]), 'read')
  assert.equal(commandIntent([{ type: 'listFiles', command: 'ls', path: null }]), 'list')
  assert.equal(commandIntent([{ type: 'search', command: 'rg x', query: 'x', path: null }]), 'search')
  assert.equal(commandIntent([{ type: 'search' }, { type: 'read' }]), 'read')
  assert.equal(commandIntent([{ type: 'read' }, { type: 'unknown' }]), 'exec')
})

await t('environment of the app-server: agent variables scrubbed, CODEX_HOME kept, shim variables set', () => {
  const env = codexEnv(
    { PATH: 'C:\\bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', AI_AGENT: 'x', CODEX_THREAD_ID: 't', CODEX_SANDBOX: 's', CODEX_HOME: 'D:\\codex-home', OPENAI_API_KEY: 'k' },
    { exe: 'C:\\x\\codex.exe', packageRoot: 'C:\\npm\\node_modules\\@openai\\codex' }
  )
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_PACKAGE_ROOT', 'OPENAI_API_KEY', 'PATH'])
  assert.equal(env.CODEX_HOME, 'D:\\codex-home')
  assert.deepEqual(Object.keys(codexEnv({ PATH: 'x' }, { exe: 'codex', packageRoot: null })), ['PATH'])
})

// ---- chat mapping -----------------------------------------------------------------------------------

await t('chat: a turn with assistant deltas and a command with output deltas', () => {
  const h = chatHarness()
  const TURN = '01a0fcb0-283c-7000-8000-000000000001'
  const inner = `node -e "console.log('ao-codex')"`
  h.feed(
    turnStarted(TURN),
    started(userItem('01a0fcb0-2e9a', `Run the command: ${inner}`), TURN),
    completed(userItem('01a0fcb0-2e9a', `Run the command: ${inner}`), TURN),
    started(msgItem('msg_1', '', 'commentary'), TURN),
    ['item/agentMessage/delta', { threadId: T, turnId: TURN, itemId: 'msg_1', delta: 'I' }],
    ['item/agentMessage/delta', { threadId: T, turnId: TURN, itemId: 'msg_1', delta: '’ll run' }],
    ['item/agentMessage/delta', { threadId: T, turnId: TURN, itemId: 'msg_1', delta: ' the requested command.' }]
  )
  // Mid-stream: what the renderer built from deltas is what the main process holds.
  assert.deepEqual(h.view, h.chat.list())
  const streaming = h.view[1]
  assert.ok(streaming.kind === 'assistant' && streaming.streaming && streaming.text === 'I’ll run the requested command.' && streaming.phase === 'commentary')

  h.feed(
    completed(msgItem('msg_1', 'I’ll run the requested command.', 'commentary'), TURN),
    started(cmdItem('exec-3f0bbc6f', inner), TURN),
    ['item/commandExecution/outputDelta', { threadId: T, turnId: TURN, itemId: 'exec-3f0bbc6f', delta: 'ao-' }],
    ['item/commandExecution/outputDelta', { threadId: T, turnId: TURN, itemId: 'exec-3f0bbc6f', delta: 'codex\n' }]
  )
  const running = h.view[2]
  assert.ok(running.kind === 'command' && running.status === 'running' && running.output === 'ao-codex\n' && running.exitCode === null)
  assert.ok(running.kind === 'command' && running.command === inner && running.cwd === W && running.intent === 'exec')

  h.feed(
    completed(cmdItem('exec-3f0bbc6f', inner, { status: 'completed', aggregatedOutput: 'ao-codex\n', exitCode: 0, durationMs: 116 }), TURN),
    ['thread/tokenUsage/updated', { threadId: T, turnId: TURN, tokenUsage: { total: { totalTokens: 13265 } } }],
    started(msgItem('msg_2', '', 'final_answer'), TURN),
    ['item/agentMessage/delta', { threadId: T, turnId: TURN, itemId: 'msg_2', delta: 'ao-codex' }],
    completed(msgItem('msg_2', 'ao-codex', 'final_answer'), TURN),
    ['thread/status/changed', { threadId: T, status: { type: 'idle' } }],
    turnCompleted(TURN)
  )
  assert.deepEqual(h.view, h.chat.list())
  assert.deepEqual(kinds(h.view), ['user', 'assistant', 'command', 'assistant'])
  const [user, , cmd, final] = h.view
  assert.ok(user.kind === 'user' && user.origin === 'human' && user.text === `Run the command: ${inner}` && user.turnId === TURN && user.agentId === 'S' && user.sessionId === 'S')
  assert.equal(user.ts, 1790945799843) // the first event's time; a replacement keeps it
  assert.ok(cmd.kind === 'command' && cmd.status === 'done' && cmd.exitCode === 0 && cmd.durationMs === 116 && cmd.output === 'ao-codex\n' && !cmd.outputTruncated)
  assert.ok(final.kind === 'assistant' && !final.streaming && final.phase === 'final' && final.text === 'ao-codex')
  // Event order: turn started first, turn completed last, each delta after its item.
  assert.deepEqual(h.events[0], { type: 'turn', sessionId: 'S', turnId: TURN, status: 'started' })
  assert.deepEqual(h.events[h.events.length - 1], { type: 'turn', sessionId: 'S', turnId: TURN, status: 'completed' })
  assert.deepEqual(h.events.filter((e) => e.type === 'delta').map((e) => e.type === 'delta' && `${e.itemId}.${e.field}`), [
    'msg_1.text', 'msg_1.text', 'msg_1.text', 'exec-3f0bbc6f.output', 'exec-3f0bbc6f.output', 'msg_2.text'
  ])
  // The escalation sample: `aggregatedOutput: null` on completion keeps what the deltas delivered.
  h.feed(
    started(cmdItem('exec-x', 'node w.js'), TURN),
    ['item/commandExecution/outputDelta', { threadId: T, turnId: TURN, itemId: 'exec-x', delta: 'partial' }],
    completed(cmdItem('exec-x', 'node w.js', { status: 'failed', aggregatedOutput: null, exitCode: 1 }), TURN)
  )
  const failed = h.chat.get('exec-x')
  assert.ok(failed?.kind === 'command' && failed.status === 'failed' && failed.output === 'partial' && failed.exitCode === 1)
})

await t('chat: approval accepted and declined (the card is linked to the permission id and its command)', () => {
  const h = chatHarness()
  const TURN = '01a0fcb0-7ae5'
  const inner = `node -e "console.log('ao-declined')"`
  const waiting = cmdItem('exec-5a352668', inner, { processId: null, source: 'agent' })
  h.feed(turnStarted(TURN), started(waiting, TURN))
  h.take(h.chat.approvalRequested({ requestId: 'perm-1', subjectId: 'exec-5a352668', summary: `Command: ${inner}`, detail: inner, turnId: TURN }, h.ctx()))
  const card = h.view[1]
  assert.ok(card.kind === 'approval' && card.id === 'approval:perm-1' && card.requestId === 'perm-1' && card.subjectId === 'exec-5a352668' && card.outcome === 'pending' && card.turnId === TURN)

  // Declined: Codex marks the command, the turn goes on and the model reports it.
  h.take(h.chat.approvalResolved('perm-1', 'denied'))
  h.feed(
    ['serverRequest/resolved', { threadId: T, requestId: 0 }],
    completed({ ...waiting, status: 'declined' }, TURN),
    completed(msgItem('msg_3', 'I’m not allowed to run the command.', 'final_answer'), TURN),
    turnCompleted(TURN)
  )
  assert.deepEqual(h.view, h.chat.list())
  const [cmd, denied, answer] = h.view
  assert.ok(cmd.kind === 'command' && cmd.status === 'declined' && cmd.exitCode === null)
  assert.ok(denied.kind === 'approval' && denied.outcome === 'denied')
  assert.ok(answer.kind === 'assistant' && !answer.streaming) // completed without a start: still shown
  assert.deepEqual(h.take(h.chat.approvalResolved('perm-1', 'allowed')), []) // settled: a second answer changes nothing

  // Accepted.
  const TURN2 = '01a0fcb2-2d78'
  const esc = cmdItem('exec-c9c88d68', `node -e "require('fs').writeFileSync('ao-escalate.txt','ok')"`, { processId: null, source: 'agent' })
  h.feed(turnStarted(TURN2), started(esc, TURN2))
  h.take(h.chat.approvalRequested({ requestId: 'perm-2', subjectId: 'exec-c9c88d68', summary: 'Command: node …', detail: 'x', turnId: TURN2 }, h.ctx()))
  h.take(h.chat.approvalResolved('perm-2', 'allowed'))
  h.feed(completed({ ...esc, processId: '45828', source: 'unifiedExecStartup', status: 'completed', exitCode: 0, durationMs: 87 }, TURN2), turnCompleted(TURN2))
  const allowed = h.chat.get('approval:perm-2')
  assert.ok(allowed?.kind === 'approval' && allowed.outcome === 'allowed')
  const ran = h.chat.get('exec-c9c88d68')
  assert.ok(ran?.kind === 'command' && ran.status === 'done' && ran.exitCode === 0)

  // A request still pending when its turn ends is closed as resolved-elsewhere.
  const TURN3 = 'turn-3'
  h.feed(turnStarted(TURN3), started(cmdItem('exec-p', 'x', { source: 'agent' }), TURN3))
  h.take(h.chat.approvalRequested({ requestId: 'perm-3', subjectId: 'missing-item', summary: 's', detail: 'd', turnId: TURN3 }, h.ctx()))
  const loose = h.chat.get('approval:perm-3')
  assert.ok(loose?.kind === 'approval' && loose.subjectId === undefined) // the subject isn't in the list: no dangling link
  h.feed(turnCompleted(TURN3, 'interrupted'))
  const gone = h.chat.get('approval:perm-3')
  assert.ok(gone?.kind === 'approval' && gone.outcome === 'resolved-elsewhere')
  assert.deepEqual(h.view, h.chat.list())
})

await t('chat: file change with a diff, web search, plan, reasoning', () => {
  const h = chatHarness()
  const TURN = '01a0fcb0-8bc2'
  const fc = { type: 'fileChange', id: 'exec-dfff31bd', changes: [{ path: `${W}\\ao-note.txt`, kind: { type: 'add' }, diff: 'agent office\ncodex spike\n' }], status: 'inProgress' }
  h.feed(turnStarted(TURN), started(fc, TURN))
  const pendingChange = h.view[0]
  assert.ok(pendingChange.kind === 'file-change' && pendingChange.status === 'running')
  // For an added file Codex sends the content; the chat model wants a unified diff.
  assert.deepEqual(pendingChange.kind === 'file-change' && pendingChange.changes, [
    { path: `${W}\\ao-note.txt`, change: 'add', diff: '@@ -0,0 +1,2 @@\n+agent office\n+codex spike\n' }
  ])
  h.feed(
    completed({ ...fc, status: 'completed' }, TURN),
    ['turn/diff/updated', { threadId: T, turnId: TURN, diff: 'diff --git a/ao-note.txt b/ao-note.txt\n' }]
  )
  const applied = h.view[0]
  assert.ok(applied.kind === 'file-change' && applied.status === 'done')
  assert.equal(unifiedDiff('update', '@@ -1 +1 @@\n-a\n+b\n'), '@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(unifiedDiff('delete', 'gone\n'), '@@ -1,1 +0,0 @@\n-gone\n')
  assert.equal(unifiedDiff('add', ''), '')
  assert.ok(unifiedDiff('add', 'x\n'.repeat(50), 40).length < 60) // capped
  // A patch update replaces the change list; a rename carries the new path.
  h.feed(started({ type: 'fileChange', id: 'fc2', changes: [], status: 'inProgress' }, TURN))
  h.feed(['item/fileChange/patchUpdated', { threadId: T, turnId: TURN, itemId: 'fc2', changes: [{ path: 'a.ts', kind: { type: 'update', move_path: 'b.ts' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] }])
  const moved = h.chat.get('fc2')
  assert.deepEqual(moved?.kind === 'file-change' && moved.changes, [{ path: 'a.ts', change: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n', movedTo: 'b.ts' }])

  // Web search: empty at start, query and action when it completes.
  h.feed(started({ type: 'webSearch', id: 'exec-a94fe6ff', query: '', action: null, results: null }, TURN))
  const searching = h.chat.get('exec-a94fe6ff')
  assert.ok(searching?.kind === 'web' && searching.status === 'running' && searching.action === 'search' && searching.query === undefined)
  h.feed(
    completed(
      {
        type: 'webSearch',
        id: 'exec-a94fe6ff',
        query: 'Electron utilityProcess',
        action: { type: 'search', query: 'Electron utilityProcess', queries: null },
        results: [{ type: 'text_result', domain: 'www.electronjs.org', title: 'utilityProcess | Electron', url: 'https://www.electronjs.org/docs/latest/api/utility-process' }]
      },
      TURN
    ),
    completed({ type: 'webSearch', id: 'open-1', query: '', action: { type: 'openPage', url: 'https://example.com/a' }, results: null }, TURN)
  )
  const searched = h.chat.get('exec-a94fe6ff')
  assert.ok(searched?.kind === 'web' && searched.status === 'done' && searched.query === 'Electron utilityProcess')
  const opened = h.chat.get('open-1')
  assert.ok(opened?.kind === 'web' && opened.action === 'open' && opened.url === 'https://example.com/a')

  // Plan: the whole list each time, one item per turn.
  h.feed(['turn/plan/updated', { threadId: T, turnId: TURN, explanation: 'Two steps', plan: [{ step: 'Read', status: 'inProgress' }, { step: 'Write', status: 'pending' }] }])
  h.feed(['turn/plan/updated', { threadId: T, turnId: TURN, explanation: null, plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }] }])
  const plan = h.chat.get(`plan:${TURN}`)
  assert.deepEqual(plan?.kind === 'plan' && plan.steps, [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in-progress' }])
  assert.equal(h.view.filter((i) => i.kind === 'plan').length, 1)

  // Reasoning (from the types; it did not occur in the spikes): parts are announced, then filled by deltas.
  h.feed(
    started({ type: 'reasoning', id: 'rs_1', summary: [], content: [] }, TURN),
    ['item/reasoning/summaryPartAdded', { threadId: T, turnId: TURN, itemId: 'rs_1', summaryIndex: 0 }],
    ['item/reasoning/summaryTextDelta', { threadId: T, turnId: TURN, itemId: 'rs_1', summaryIndex: 0, delta: 'Looking' }],
    ['item/reasoning/summaryTextDelta', { threadId: T, turnId: TURN, itemId: 'rs_1', summaryIndex: 0, delta: ' at it' }],
    ['item/reasoning/summaryTextDelta', { threadId: T, turnId: TURN, itemId: 'rs_1', summaryIndex: 1, delta: 'Second' }], // part never announced
    ['item/reasoning/textDelta', { threadId: T, turnId: TURN, itemId: 'rs_1', contentIndex: 0, delta: 'raw' }],
    ['item/reasoning/textDelta', { threadId: T, turnId: TURN, itemId: 'rs_1', contentIndex: 0, delta: ' text' }]
  )
  assert.deepEqual(h.view, h.chat.list())
  const thinking = h.chat.get('rs_1')
  assert.ok(thinking?.kind === 'reasoning' && thinking.streaming && thinking.text === 'raw text')
  assert.deepEqual(thinking?.kind === 'reasoning' && thinking.summary, ['Looking at it', 'Second'])
  h.feed(completed({ type: 'reasoning', id: 'rs_1', summary: ['Looking at it', 'Second'], content: ['raw text'] }, TURN))
  const thought = h.chat.get('rs_1')
  assert.ok(thought?.kind === 'reasoning' && !thought.streaming)

  // MCP tool call with progress, result and error.
  h.feed(
    started({ type: 'mcpToolCall', id: 'mcp-1', server: 'node_repl', tool: 'js', status: 'inProgress', arguments: { code: '1+1' }, result: null, error: null, durationMs: null }, TURN),
    ['item/mcpToolCall/progress', { threadId: T, turnId: TURN, itemId: 'mcp-1', message: 'running' }]
  )
  const calling = h.chat.get('mcp-1')
  assert.ok(calling?.kind === 'tool' && calling.server === 'node_repl' && calling.tool === 'js' && calling.progress === 'running' && /"code": "1\+1"/.test(calling.input))
  h.feed(completed({ type: 'mcpToolCall', id: 'mcp-1', server: 'node_repl', tool: 'js', status: 'completed', arguments: { code: '1+1' }, result: { content: [{ type: 'text', text: '2' }], structuredContent: null }, error: null }, TURN))
  const called = h.chat.get('mcp-1')
  assert.ok(called?.kind === 'tool' && called.status === 'done' && called.result === '2' && called.progress === undefined)
  h.feed(completed({ type: 'mcpToolCall', id: 'mcp-2', server: 's', tool: 't', status: 'failed', arguments: {}, result: null, error: { message: 'nope' } }, TURN))
  const broke = h.chat.get('mcp-2')
  assert.ok(broke?.kind === 'tool' && broke.status === 'failed' && broke.error === 'nope')
  // Items the chat doesn't show.
  assert.deepEqual(h.feed(started({ type: 'hookPrompt', id: 'h1', fragments: [] }, TURN), completed({ type: 'sleep', id: 's1' }, TURN), started({ type: 'somethingNew', id: 'n1' }, TURN)), [])
  assert.deepEqual(h.feed(['some/new/notification', { threadId: T }], started(null, TURN), started({ type: 'agentMessage' }, TURN)), [])
})

await t('chat: an interrupted turn closes its open items (no item/completed arrives)', () => {
  const h = chatHarness()
  const TURN = '01a0fcb1-1c66'
  h.feed(
    turnStarted(TURN),
    started(userItem('u1', 'Run the slow command'), TURN),
    completed(userItem('u1', 'Run the slow command'), TURN),
    started(msgItem('msg_c', '', 'commentary'), TURN),
    ['item/agentMessage/delta', { threadId: T, turnId: TURN, itemId: 'msg_c', delta: 'Running' }],
    started(cmdItem('exec-3fb4c1ac', `node -e "setTimeout(()=>console.log('slow-done'),25000)"`, { processId: '95398' }), TURN),
    ['item/commandExecution/outputDelta', { threadId: T, turnId: TURN, itemId: 'exec-3fb4c1ac', delta: 'tick\n' }],
    started({ type: 'webSearch', id: 'ws-open', query: '', action: null, results: null }, TURN)
  )
  // An older turn's item must not be touched.
  h.take(h.chat.notice('info', 'unrelated', h.ctx()))
  const before = h.events.length
  h.feed(['thread/status/changed', { threadId: T, status: { type: 'idle' } }], turnCompleted(TURN, 'interrupted'))
  const [, msg, cmd, web] = h.view
  assert.ok(msg.kind === 'assistant' && !msg.streaming && msg.text === 'Running')
  assert.ok(cmd.kind === 'command' && cmd.status === 'interrupted' && cmd.output === 'tick\n' && cmd.exitCode === null)
  assert.ok(web.kind === 'web' && web.status === 'interrupted')
  const last = h.view[h.view.length - 1]
  assert.ok(last.kind === 'notice' && last.level === 'info' && last.text === 'Turn interrupted' && last.turnId === TURN)
  // The closing item events come first, the turn event last.
  const tailEvents = h.events.slice(before)
  assert.deepEqual(tailEvents.map((e) => (e.type === 'item' ? e.item.id : e.type)), ['msg_c', 'exec-3fb4c1ac', 'ws-open', `interrupted:${TURN}`, 'turn'])
  assert.deepEqual(tailEvents[tailEvents.length - 1], { type: 'turn', sessionId: 'S', turnId: TURN, status: 'interrupted' })
  assert.deepEqual(h.view, h.chat.list())

  // A failed turn: retry notices are progress (one notice, updated in place), the failure is an error notice.
  const TURN2 = 'turn-failed'
  const err401 = { message: 'unexpected status 401 Unauthorized: Missing bearer', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null }
  h.feed(
    turnStarted(TURN2),
    started(cmdItem('exec-f', 'x'), TURN2),
    ['error', { error: { message: 'Reconnecting... 2/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }, willRetry: true, threadId: T, turnId: TURN2 }],
    ['error', { error: { message: 'Reconnecting... 3/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }, willRetry: true, threadId: T, turnId: TURN2 }],
    ['warning', { threadId: T, message: 'Falling back from WebSockets to HTTPS transport.' }],
    ['error', { error: err401, willRetry: false, threadId: T, turnId: TURN2 }],
    turnCompleted(TURN2, 'failed', err401)
  )
  const notices = h.view.filter((i) => i.kind === 'notice' && i.turnId === TURN2)
  assert.deepEqual(notices.map((n) => n.kind === 'notice' && [n.level, n.text]), [['info', 'Reconnecting... 3/5'], ['error', NOT_LOGGED_IN]])
  const failedCmd = h.chat.get('exec-f')
  assert.ok(failedCmd?.kind === 'command' && failedCmd.status === 'failed')
  assert.deepEqual(h.events[h.events.length - 1], { type: 'turn', sessionId: 'S', turnId: TURN2, status: 'failed', error: NOT_LOGGED_IN })
  assert.deepEqual(h.view, h.chat.list())
})

await t('chat: prompts the app sent keep their origin and id; a steer adds a user item to the running turn', () => {
  const h = chatHarness()
  const TURN = '01a0fcb0-a1d6'
  // Typed in the chat box while idle.
  h.chat.expectUser('ao-1', 'Run the slow command', 'human')
  h.take(h.chat.userSent('ao-1', h.ctx(), TURN))
  h.feed(turnStarted(TURN), started(userItem('01a0-user-1', 'Run the slow command', 'ao-1'), TURN), completed(userItem('01a0-user-1', 'Run the slow command', 'ao-1'), TURN))
  h.feed(started(cmdItem('exec-e1a7b85c', 'node slow.js'), TURN))
  // A CEO order while the command runs: accepted at once (same turn), echoed after the command finished.
  h.chat.expectUser('ao-2', 'Also: end your final answer with the exact word steered-ok.', 'order')
  h.take(h.chat.userSent('ao-2', h.ctx(), TURN))
  assert.deepEqual(h.view.map((i) => i.id), ['ao-1', 'exec-e1a7b85c', 'ao-2'])
  h.feed(
    completed(cmdItem('exec-e1a7b85c', 'node slow.js', { status: 'completed', aggregatedOutput: 'slow-done\n', exitCode: 0, durationMs: 25116 }), TURN),
    started(userItem('01a0fcb1-1687', 'Also: end your final answer with the exact word steered-ok.', 'ao-2'), TURN),
    completed(userItem('01a0fcb1-1687', 'Also: end your final answer with the exact word steered-ok.', 'ao-2'), TURN),
    completed(msgItem('msg_f', 'slow-done steered-ok', 'final_answer'), TURN),
    turnCompleted(TURN)
  )
  // No duplicates: the echo replaced the item shown when the prompt was accepted.
  assert.deepEqual(h.view.map((i) => [i.id, i.kind, i.kind === 'user' ? i.origin : '']), [
    ['ao-1', 'user', 'human'],
    ['exec-e1a7b85c', 'command', ''],
    ['ao-2', 'user', 'order'],
    ['msg_f', 'assistant', '']
  ])
  assert.ok(h.view.every((i) => i.turnId === TURN))
  assert.deepEqual(h.view, h.chat.list())

  // An echo without clientId (older server): matched by text, still one item.
  h.chat.expectUser('ao-3', 'typed while busy', 'steer')
  h.take(h.chat.userSent('ao-3', h.ctx(), 'turn-9'))
  h.feed(started(userItem('codex-u-3', 'typed while busy'), 'turn-9'), completed(userItem('codex-u-3', 'typed while busy'), 'turn-9'))
  const steer = h.view.filter((i) => i.kind === 'user' && i.text === 'typed while busy')
  assert.deepEqual(steer.map((i) => [i.id, i.kind === 'user' && i.origin]), [['ao-3', 'steer']])
  // The echo before the acknowledgement: still one item, and the origin is kept.
  h.chat.expectUser('ao-4', 'fast', 'order')
  h.feed(started(userItem('codex-u-4', 'fast', 'ao-4'), 'turn-9'))
  assert.deepEqual(h.take(h.chat.userSent('ao-4', h.ctx(), 'turn-9')), [])
  h.feed(completed(userItem('codex-u-4', 'fast', 'ao-4'), 'turn-9'))
  assert.deepEqual(h.view.filter((i) => i.kind === 'user' && i.text === 'fast').map((i) => [i.id, i.kind === 'user' && i.origin]), [['ao-4', 'order']])
  // A prompt the server refused leaves nothing behind.
  h.chat.expectUser('ao-5', 'refused', 'human')
  h.chat.forgetUser('ao-5')
  assert.deepEqual(h.take(h.chat.userSent('ao-5', h.ctx())), [])
  // Somebody else's message (another client on the same thread): its own id, origin human.
  h.feed(completed(userItem('codex-u-6', 'from elsewhere'), 'turn-9'))
  const other = h.chat.get('codex-u-6')
  assert.ok(other?.kind === 'user' && other.origin === 'human')
  assert.deepEqual(h.view, h.chat.list())
})

await t('chat: history rebuilt from thread/turns/list', () => {
  const h = chatHarness()
  h.take(h.chat.notice('info', 'stale', h.ctx()))
  const inner = `node -e "setTimeout(()=>{},25000)"`
  const reset = h.chat.loadHistory(
    [
      { id: 't1', items: [userItem('u1', 'Run it'), msgItem('m1', 'I’m not allowed to run the command.', 'final_answer')], itemsView: 'full', status: 'completed', error: null, startedAt: 1790945819 },
      {
        id: 't2',
        items: [userItem('u2', 'make the note'), { type: 'fileChange', id: 'f2', changes: [{ path: 'ao-note.txt', kind: { type: 'add' }, diff: 'agent office\n' }], status: 'completed' }, msgItem('m2', 'Done', 'final_answer')],
        status: 'completed',
        error: null,
        startedAt: 1790945825
      },
      // The command an interrupt cut off is recorded as failed with exit code -1.
      { id: 't3', items: [userItem('u3', 'slow'), msgItem('m3', 'Running', 'commentary'), cmdItem('c3', inner, { status: 'failed', aggregatedOutput: '', exitCode: -1, durationMs: 6818 })], status: 'interrupted', error: null, startedAt: 1790945860 },
      // Codex keeps the clientUserMessageId: a prompt this app sent comes back under its id, with its origin.
      { id: 't4', items: [userItem('u4', 'hello', 'ao-order-24f98506ba949ebb')], status: 'failed', error: { message: 'boom', codexErrorInfo: 'other' }, startedAt: null },
      null,
      { id: 't5', items: 'not a list', status: 'completed' }
    ],
    h.ctx()
  )
  h.take([reset])
  assert.equal(reset.type, 'reset')
  assert.deepEqual(h.view, h.chat.list())
  assert.deepEqual(kinds(h.view), ['user', 'assistant', 'user', 'file-change', 'assistant', 'user', 'assistant', 'command', 'notice', 'user', 'notice'])
  assert.ok(!h.view.some((i) => i.kind === 'notice' && i.text === 'stale'))
  const cmd = h.chat.get('c3')
  assert.ok(cmd?.kind === 'command' && cmd.status === 'interrupted' && cmd.exitCode === null && cmd.durationMs === 6818)
  assert.ok(h.view.every((i) => !('streaming' in i) || !i.streaming))
  assert.equal(h.chat.get('u1')?.ts, 1790945819000) // turn times are Unix seconds
  assert.equal(h.chat.get('u2')?.turnId, 't2')
  const order = h.chat.get('ao-order-24f98506ba949ebb')
  assert.ok(order?.kind === 'user' && order.origin === 'order' && order.text === 'hello')
  assert.equal(h.chat.get('u4'), undefined)
  assert.equal(clientMessageId('order', '24f98506ba949ebb'), 'ao-order-24f98506ba949ebb')
  assert.deepEqual(['ao-steer-0123456789abcdef', 'ao-human-0123456789abcdef', 'ao-root-0123456789abcdef', 'ao-order-xyz', 'someone-else', null].map(originOfClientId), ['steer', 'human', null, null, null, null])
  const failure = h.chat.get('error:t4')
  assert.ok(failure?.kind === 'notice' && failure.level === 'error' && failure.text === 'boom')
})

await t('chat: bounds (output tail, item count) and the reset an attach gets', () => {
  const h = chatHarness({ maxOutputChars: 20, maxItems: 5 })
  const TURN = 't'
  h.feed(turnStarted(TURN), started(cmdItem('c1', 'yes'), TURN))
  const out = (delta: string) => h.feed(['item/commandExecution/outputDelta', { threadId: T, turnId: TURN, itemId: 'c1', delta }])
  assert.equal(out('0123456789')[0].type, 'delta')
  assert.equal(out('abcdefghij')[0].type, 'delta') // exactly at the cap
  // Past the cap: the renderer gets the whole item (tail + flag) once, then at most once a second.
  const over = out('KLMNO')
  assert.ok(over.length === 1 && over[0].type === 'item' && over[0].item.kind === 'command' && over[0].item.output === '56789abcdefghijKLMNO' && over[0].item.outputTruncated)
  assert.deepEqual(out('PQ'), [])
  h.tick(1500)
  const later = out('RS')
  assert.ok(later.length === 1 && later[0].type === 'item' && later[0].item.kind === 'command' && later[0].item.output.endsWith('KLMNOPQRS'))
  const mine = h.chat.get('c1')
  assert.ok(mine?.kind === 'command' && mine.output.length === 20)
  // Completion: the tail of the full output, still flagged.
  h.feed(completed(cmdItem('c1', 'yes', { status: 'completed', aggregatedOutput: 'x'.repeat(50) + 'THE-END', exitCode: 0 }), TURN))
  const done = h.chat.get('c1')
  assert.ok(done?.kind === 'command' && done.output.length === 20 && done.output.endsWith('THE-END') && done.outputTruncated)
  assert.deepEqual(h.view, h.chat.list())

  // The list is bounded: the oldest items go.
  for (let i = 0; i < 10; i++) h.take(h.chat.notice('info', `n${i}`, h.ctx()))
  assert.equal(h.chat.list().length, 5)
  assert.deepEqual(h.chat.list().map((i) => i.kind === 'notice' && i.text), ['n5', 'n6', 'n7', 'n8', 'n9'])
  assert.deepEqual(h.chat.resetEvent(), { type: 'reset', sessionId: 'S', items: h.chat.list() })
  // A delta for an item that fell out (or never existed) is dropped, not sent.
  assert.deepEqual(out('late'), [])
  // list() is a copy.
  h.chat.list().pop()
  assert.equal(h.chat.list().length, 5)
})

// ---- approvals --------------------------------------------------------------------------------------

await t('approval cards: summary and detail from the request (and the file-change item)', () => {
  const inner = `node -e "require('fs').writeFileSync('ao-escalate.txt','ok')"`
  const request = {
    kind: 'command',
    threadId: T,
    turnId: '01a0fcb2-2d78',
    itemId: 'exec-c9c88d68',
    startedAtMs: 1790945940764,
    environmentId: 'local',
    reason: 'May I run the requested command outside the sandbox to write ao-escalate.txt?',
    command: `${PS}"${inner.replace(/"/g, '\\"')}"`,
    cwd: W,
    commandActions: [{ type: 'unknown', command: inner }],
    proposedExecpolicyAmendment: ['node', '-e', "require('fs').writeFileSync('ao-escalate.txt','ok')"],
    availableDecisions: ['accept', 'cancel']
  }
  const cmd = describeServerRequest('item/commandExecution/requestApproval', request)
  assert.ok(cmd.kind === 'card')
  assert.equal(cmd.kind === 'card' && cmd.card.toolName, 'Command')
  // The inner command, not the PowerShell wrapper.
  assert.equal(cmd.kind === 'card' && cmd.card.summary, `Command: ${inner}`)
  assert.ok(cmd.kind === 'card' && !/powershell/i.test(cmd.card.summary))
  assert.equal(cmd.kind === 'card' && cmd.card.detail, `${inner}\n\ncwd: ${W}\nreason: May I run the requested command outside the sandbox to write ao-escalate.txt?`)
  assert.equal(cmd.kind === 'card' && cmd.card.itemId, 'exec-c9c88d68')

  // The file-change request has no paths or diff: they come from the item with the same id.
  const h = chatHarness()
  h.feed(
    started(
      {
        type: 'fileChange',
        id: 'exec-dfff31bd',
        changes: [
          { path: `${W}\\ao-note.txt`, kind: { type: 'add' }, diff: 'agent office\ncodex spike\n' },
          { path: `${W}\\b.txt`, kind: { type: 'delete' }, diff: 'old\n' },
          { path: `${W}\\c.txt`, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }
        ],
        status: 'inProgress'
      },
      'turn'
    )
  )
  const fc = describeServerRequest('item/fileChange/requestApproval', { threadId: T, turnId: 'turn', itemId: 'exec-dfff31bd', startedAtMs: 1, reason: null, grantRoot: null }, h.chat.get('exec-dfff31bd'))
  assert.equal(fc.kind === 'card' && fc.card.toolName, 'File change')
  assert.equal(fc.kind === 'card' && fc.card.summary, `Edit: ${W}\\ao-note.txt (+2 more)`)
  assert.ok(fc.kind === 'card' && fc.card.detail.includes(`add ${W}\\ao-note.txt\n@@ -0,0 +1,2 @@\n+agent office\n+codex spike`))
  assert.ok(fc.kind === 'card' && fc.card.detail.includes(`delete ${W}\\b.txt\n@@ -1,1 +0,0 @@\n-old`))
  const blind = describeServerRequest('item/fileChange/requestApproval', { threadId: T, itemId: 'nope' })
  assert.equal(blind.kind === 'card' && blind.card.summary, 'Edit: files')

  const perms = describeServerRequest('item/permissions/requestApproval', { threadId: T, itemId: 'i', cwd: W, reason: 'needs the network', permissions: { network: { enabled: true }, fileSystem: null } })
  assert.ok(perms.kind === 'card' && /^Permissions: network access/.test(perms.card.summary) && /needs the network/.test(perms.card.detail))

  // A plugin asking yes/no fits a card; a form or a link does not, and is declined with a notice.
  const mcp = describeServerRequest('mcpServer/elicitation/request', { threadId: T, turnId: null, serverName: 'node_repl', mode: 'form', message: 'Allow node_repl to run js?', requestedSchema: { type: 'object', properties: {} } })
  assert.equal(mcp.kind === 'card' && mcp.card.summary, 'node_repl: Allow node_repl to run js?')
  const form = describeServerRequest('mcpServer/elicitation/request', { threadId: T, serverName: 'x', mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } })
  assert.deepEqual(form.kind === 'auto' && form.result, { action: 'decline', content: null, _meta: null })
  const link = describeServerRequest('mcpServer/elicitation/request', { threadId: T, serverName: 'x', mode: 'url', message: 'Open', url: 'https://example.com', elicitationId: 'e' })
  assert.equal(link.kind, 'auto')
  const question = describeServerRequest('item/tool/requestUserInput', { threadId: T, turnId: 't', itemId: 'i', questions: [{ id: 'q', question: 'Which one?' }], isBlocking: true })
  assert.deepEqual(question.kind === 'auto' && question.result, { answers: {} })
  assert.ok(question.kind === 'auto' && /Which one\?/.test(question.notice))
  assert.equal(describeServerRequest('item/tool/call', {}).kind, 'unknown')
  assert.equal(describeServerRequest('execCommandApproval', {}).kind, 'unknown')

  // Decisions: allow -> accept, deny -> decline, giving up -> cancel. Never a session-wide grant.
  const m = 'item/commandExecution/requestApproval'
  assert.deepEqual(approvalResult(m, request, { behavior: 'allow' }), { decision: 'accept' })
  assert.deepEqual(approvalResult(m, request, { behavior: 'deny', message: 'no' }), { decision: 'decline' })
  assert.deepEqual(approvalResult(m, request, null), { decision: 'cancel' })
  assert.deepEqual(approvalResult('item/fileChange/requestApproval', {}, { behavior: 'allow' }), { decision: 'accept' })
  const asked = { permissions: { network: { enabled: true }, fileSystem: null, extra: 'ignored' } }
  assert.deepEqual(approvalResult('item/permissions/requestApproval', asked, { behavior: 'allow' }), { permissions: { network: { enabled: true } }, scope: 'turn' })
  assert.deepEqual(approvalResult('item/permissions/requestApproval', asked, { behavior: 'deny' }), { permissions: {}, scope: 'turn' })
  assert.deepEqual(approvalResult('mcpServer/elicitation/request', {}, { behavior: 'allow' }), { action: 'accept', content: {}, _meta: null })
  assert.deepEqual(approvalResult('mcpServer/elicitation/request', {}, { behavior: 'deny' }), { action: 'decline', content: null, _meta: null })
})

// ---- world events -----------------------------------------------------------------------------------

await t('world: Codex items -> activities', () => {
  const act = (item: unknown) => {
    const a = worldActivityForItem(item)
    return a ? `${a.activity}|${a.detail}` : null
  }
  assert.equal(act(cmdItem('c', `node -e "console.log('ao-codex')"`)), `exec|node -e "console.log('ao-codex')"`)
  assert.equal(act({ type: 'commandExecution', command: 'git status', commandActions: [] }), 'exec|git status')
  assert.equal(act({ type: 'commandExecution', command: 'p', commandActions: [{ type: 'read', command: 'cat src/app.ts', name: 'app.ts', path: 'src/app.ts' }] }), 'read|src/app.ts')
  assert.equal(act({ type: 'commandExecution', command: 'p', commandActions: [{ type: 'listFiles', command: 'ls src', path: 'src' }] }), 'read|src')
  assert.equal(act({ type: 'commandExecution', command: 'p', commandActions: [{ type: 'search', command: 'rg TODO', query: 'TODO', path: null }] }), 'read|TODO')
  assert.equal(act({ type: 'commandExecution', command: 'p', commandActions: [{ type: 'read', command: 'cat a', path: 'a' }, { type: 'unknown', command: 'node x' }] }), 'exec|cat a | node x')
  assert.equal(act({ type: 'fileChange', changes: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }] }), 'write|a.ts (+2 more)')
  assert.equal(act({ type: 'fileChange', changes: [{ path: 'a.ts' }] }), 'write|a.ts')
  assert.equal(act({ type: 'webSearch', query: '', action: null }), 'web|')
  assert.equal(act({ type: 'webSearch', query: 'electron', action: { type: 'search', query: 'electron' } }), 'web|electron')
  assert.equal(act({ type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://example.com' } }), 'web|https://example.com')
  assert.equal(act({ type: 'mcpToolCall', server: 'node_repl', tool: 'js', arguments: {} }), 'exec|node_repl.js')
  assert.equal(act({ type: 'mcpToolCall', server: 'docs', tool: 'lookup', readOnlyHint: true }), 'read|docs.lookup')
  assert.equal(act({ type: 'mcpToolCall', server: 'cua', tool: 'take_screenshot' }), 'capture|cua.take_screenshot')
  assert.equal(act({ type: 'mcpToolCall', server: 'cua', tool: 'computer', arguments: { action: 'screenshot' } }), 'capture|cua.computer')
  assert.equal(act({ type: 'dynamicToolCall', namespace: null, tool: 'thing' }), 'exec|thing')
  assert.equal(act({ type: 'collabAgentToolCall', tool: 'spawnAgent' }), 'exec|delegating')
  assert.equal(act({ type: 'imageView', path: 'shot.png' }), 'read|shot.png')
  for (const type of ['agentMessage', 'reasoning', 'plan', 'userMessage', 'contextCompaction', 'sleep', 'somethingNew']) assert.equal(act({ type }), null, type)
  assert.equal(act(null), null)

  assert.deepEqual(
    collabInfo({ type: 'collabAgentToolCall', id: 'x', tool: 'spawnAgent', status: 'completed', senderThreadId: T, receiverThreadIds: ['child-1', 7, ''], prompt: 'list files', agentsStates: { 'child-1': { status: 'running', message: null }, 'child-0': { status: 'completed' } } }),
    { tool: 'spawnAgent', receivers: ['child-1'], prompt: 'list files', ended: ['child-0'] }
  )
  assert.equal(collabInfo({ type: 'commandExecution' }), null)
  assert.deepEqual(collabInfo({ type: 'collabAgentToolCall' }), { tool: '', receivers: [], prompt: '', ended: [] })
})

await t('world: the actor bookkeeping the Codex driver uses (provider codex, workers, waiting)', () => {
  const m = new ClaudeHookMapper({ rootId: 'S', displayName: 'gpt-6-luna', provider: 'codex', holdWaiting: true, endsWithProcess: true })
  const brief = (events: AgentEvent[]) => events.map((e) => `${e.agentId}|${e.parentId ?? '-'}|${e.provider}|${e.displayName}|${e.activity}|${e.detail}`)
  assert.deepEqual(brief(m.spawn(1)), ['S|-|codex|gpt-6-luna|idle|'])
  assert.deepEqual(brief(m.activity('S', 'exec', 'node -e "x"\n  y', 2)), ['S|-|codex|gpt-6-luna|exec|node -e "x" y'])
  // Approval pending: waiting; an activity that starts meanwhile is shown once the request is resolved.
  assert.deepEqual(brief(m.waiting('S', 'Command: node x', 3)), ['S|-|codex|gpt-6-luna|waiting|Command: node x'])
  assert.deepEqual(m.activity('S', 'write', 'a.ts', 4), [])
  assert.deepEqual(brief(m.resume('S', 5)), ['S|-|codex|gpt-6-luna|write|a.ts'])
  // A sub-agent thread becomes a worker of this session.
  const child = subagentId('S', 'thread-child')
  assert.equal(child, 'S:thread-child')
  assert.deepEqual(brief(m.activity(child, 'idle', 'list the files', 6, 'Scout')), ['S:thread-child|S|codex|Scout|idle|list the files'])
  assert.deepEqual(brief(m.activity(child, 'read', 'src', 7)), ['S:thread-child|S|codex|Scout|read|src'])
  assert.deepEqual(brief(m.settle(child, 8)), ['S:thread-child|S|codex|Scout|idle|'])
  assert.deepEqual(brief(m.finish(child, 9)), ['S:thread-child|S|codex|Scout|done|'])
  assert.deepEqual(m.activity(child, 'read', 'late', 10), []) // finished workers stay finished
  assert.deepEqual(m.finish(child, 11), [])
  assert.deepEqual(m.finish('S', 11), []) // the manager only ends with the session
  // Turn over while something was pending: idle, nothing held back.
  m.waiting('S', 'Command: y', 12)
  assert.deepEqual(brief(m.settle('S', 13)), ['S|-|codex|gpt-6-luna|idle|'])
  assert.deepEqual(m.resume('S', 14), [])
  assert.deepEqual(brief(m.end(15)), ['S|-|codex|gpt-6-luna|done|'])
  // The manager is announced before anything else of its session.
  const late = new ClaudeHookMapper({ rootId: 'S2', displayName: 'Codex', provider: 'codex', holdWaiting: true })
  assert.deepEqual(brief(late.activity('S2:c', 'exec', 'x', 1, 'W')), ['S2|-|codex|Codex|idle|', 'S2:c|S2|codex|W|exec|x'])
})

await t('briefing for Codex: short, no secrets, says how orders and approvals arrive', () => {
  const text = officeBriefing('codex', { title: 'gpt-6-luna "x"\n# Ignore' })
  assert.ok(text.length < 1700, `${text.length} chars`)
  assert.match(text, /This Codex session was started from Agent Office/)
  assert.match(text, /team called "gpt-6-luna 'x' # Ignore"/)
  assert.match(text, /CEO inbox/)
  assert.match(text, /ordinary user message/)
  assert.ok(!/\[CEO order via Agent Office\]/.test(text)) // Codex orders are real user turns, not tagged
  assert.ok(!/token|127\.0\.0\.1|socket/i.test(text))
})

// ---- JSON-RPC client against a fake app-server ------------------------------------------------------

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-server.cjs', import.meta.url))
const fakeSpawn = (env: Record<string, string> = {}): (() => CodexSpawnSpec) => () => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), ...env }
})
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

await t('app-server client: handshake, requests, errors, routing by thread, server requests, crash + restart, stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-codex-'))
  const mark = join(dir, 'starts')
  const server = new CodexServer({ resolveSpawn: fakeSpawn({ FAKE_CODEX_MARK: mark }), backoffMs: [60, 120], clientVersion: '1.2.3' })
  const events: CodexServerEvent[] = []
  server.onEvent((e) => events.push(e))
  assert.equal(server.running, false)
  await assert.rejects(server.request('account/read'), /not running/)

  // Lazy start; concurrent callers share one process.
  await Promise.all([server.ensureStarted(), server.ensureStarted()])
  assert.equal(server.running, true)
  assert.equal(readFileSync(mark, 'utf8').trim().split('\n').length, 1)
  assert.equal(server.info.codexHome, 'C:\\fake\\.codex')
  assert.deepEqual(events[0], { type: 'up' })
  await until(() => events.some((e) => e.type === 'notification' && e.method === 'remoteControl/status/changed'), 'a global notification')
  // stderr is kept (bounded, colours stripped), not printed.
  await until(() => server.stderrTail().includes('fake codex app-server started'), 'stderr captured')
  assert.ok(!server.stderrTail().includes('\u001b'))

  const log = async () => ((await server.request('fake/log')) as { received: { method: string; id?: number; params?: Record<string, unknown> }[] }).received
  const init = (await log())[0]
  assert.equal(init.method, 'initialize')
  assert.deepEqual(init.params, { clientInfo: { name: 'agent_office', title: 'Agent Office', version: '1.2.3' }, capabilities: { experimentalApi: false, requestAttestation: false } })
  assert.equal((await log())[1].method, 'initialized')
  assert.ok(!('jsonrpc' in init))

  // Request / response / error.
  assert.deepEqual(accountInfo(await server.request('account/read', { refreshToken: false })), { loggedIn: true, plan: 'free' })
  const err = await server.request('turn/steer', { threadId: 'nope', expectedTurnId: 'x', input: [] }).catch((e) => e)
  assert.ok(err instanceof CodexRpcError && err.code === -32600 && /no active turn to steer/.test(err.message))
  await assert.rejects(server.request('no/such/method'), /unknown method/)

  // Notifications and server requests are routed to the thread's subscriber; id 0 is answered.
  const started = (await server.request('thread/start', { cwd: dir, sandbox: 'workspace-write', approvalPolicy: 'untrusted' })) as { thread: { id: string }; sandbox: { type: string } }
  const thread = started.thread.id
  assert.equal(started.sandbox.type, 'workspaceWrite')
  const notes: string[] = []
  const requests: { id: number | string; method: string }[] = []
  const unsubscribe = server.subscribeThread(thread, {
    notification: (_t, method) => void notes.push(method),
    request: (_t, id, method) => void requests.push({ id, method })
  })
  const turn = (await server.request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'please approve', text_elements: [] }] })) as { turn: { id: string } }
  assert.match(turn.turn.id, /^turn-/)
  await until(() => requests.length === 1, 'the approval request')
  assert.deepEqual(requests[0], { id: 0, method: 'item/commandExecution/requestApproval' })
  assert.ok(!notes.includes('turn/completed'))
  server.respond(0, { decision: 'accept' })
  await until(() => notes.includes('turn/completed'), 'turn/completed')
  assert.ok(notes.includes('serverRequest/resolved') && notes.includes('item/commandExecution/outputDelta') && notes.includes('item/agentMessage/delta'))
  assert.ok(!events.some((e) => e.type === 'notification' && e.method.startsWith('item/'))) // routed, not broadcast

  // A server request for a thread nobody listens to is refused at once rather than left hanging.
  const other = ((await server.request('thread/start', {})) as { thread: { id: string } }).thread.id
  const refused: string[] = []
  await server.request('turn/start', { threadId: other, input: [{ type: 'text', text: 'approve', text_elements: [] }] })
  server.onEvent((e) => e.type === 'notification' && e.method === 'turn/completed' && refused.push(e.method))
  await until(() => refused.length === 1, 'the unanswerable request to be refused and the turn to end')

  // Crash: pending requests are rejected, subscribers hear `down`, and it restarts with backoff.
  const pid = server.pid
  const pending = server.request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'crash now', text_elements: [] }] }).then(
    () => server.request('fake/log'), // answered just before the exit; this one is caught by it
    (e) => Promise.reject(e)
  )
  await assert.rejects(pending, /stopped|not running/)
  await until(() => events.some((e) => e.type === 'down'), 'down event')
  assert.deepEqual(events.find((e) => e.type === 'down'), { type: 'down', expected: false })
  assert.equal(server.running, false)
  // A subscriber is still there, so it comes back by itself.
  await until(() => events.filter((e) => e.type === 'up').length === 2, 'automatic restart', 8000)
  assert.equal(readFileSync(mark, 'utf8').trim().split('\n').length, 2)
  assert.notEqual(server.pid, pid)
  assert.deepEqual(accountInfo(await server.request('account/read')), { loggedIn: true, plan: 'free' })

  // No subscriber: no automatic restart; the next need starts it (after the backoff).
  unsubscribe()
  const t0 = Date.now()
  await server.request('thread/start', {}).then((r) => server.request('turn/start', { threadId: (r as { thread: { id: string } }).thread.id, input: [{ type: 'text', text: 'crash', text_elements: [] }] })).catch(() => {})
  await until(() => !server.running, 'second crash')
  await sleep(300)
  assert.equal(server.running, false)
  assert.equal(readFileSync(mark, 'utf8').trim().split('\n').length, 2)
  await server.ensureStarted()
  assert.ok(Date.now() - t0 >= 100, 'the backoff was honoured')
  assert.equal(readFileSync(mark, 'utf8').trim().split('\n').length, 3)

  // Stop: stdin closes, the process exits, and nothing can start it again.
  const last = server.pid
  await server.stop()
  assert.equal(server.running, false)
  await until(() => !alive(last), 'the process to be gone')
  assert.deepEqual(events[events.length - 1], { type: 'down', expected: true })
  await assert.rejects(server.ensureStarted(), /shutting down/)
  rmSync(dir, { recursive: true, force: true })

  // Not installed / a server that never answers the handshake.
  const none = new CodexServer({ resolveSpawn: () => null })
  await assert.rejects(none.ensureStarted(), /not installed/)
  const missing = new CodexServer({ resolveSpawn: () => ({ file: join(tmpdir(), 'no-such-codex.exe'), args: [], env: {} }), backoffMs: [10] })
  await assert.rejects(missing.ensureStarted(), /could not start|stopped|exited/)
  await missing.stop()
})

// ---- the driver and the session manager on the fake server ------------------------------------------

class NoPty implements PtyHost {
  calls: string[] = []
  async spawn(): Promise<void> {
    this.calls.push('spawn')
  }
  write(): void {
    this.calls.push('write')
  }
  resize(): void {
    this.calls.push('resize')
  }
  kill(): void {
    this.calls.push('kill')
  }
  dispose(): void {
    this.calls.push('dispose')
  }
  async snapshot(): Promise<null> {
    this.calls.push('snapshot')
    return null
  }
  detach(): void {
    this.calls.push('detach')
  }
  ack(): void {
    this.calls.push('ack')
  }
}

function stack(env: Record<string, string> = {}) {
  const pty = new NoPty()
  const world: AgentEvent[] = []
  const chat: ChatEvent[] = []
  const opened: string[] = []
  const providerLists: ProviderInfo[][] = []
  let sessions: SessionInfo[] = []
  let permissions: PermissionRequestInfo[] = []
  const state = { allowOrders: false }
  const codex = codexProvider({
    openExternal: async (url) => void opened.push(url),
    server: { resolveSpawn: fakeSpawn(env), backoffMs: [50, 100] },
    findExecutable: () => process.execPath,
    version: async () => '0.160.0'
  })
  const manager = new SessionManager({
    pty,
    sink: { emit: (e) => void world.push(e) },
    providers: [codex],
    allowOrders: () => state.allowOrders,
    worldTopLevel: () => [{ id: 'ext-claude', provider: 'claude-code' }],
    onSessionsChanged: (list) => (sessions = list),
    onPermissionsChanged: (list) => (permissions = list),
    onTerminalData: () => {},
    onChatEvent: (e) => void chat.push(e),
    onProvidersChanged: (list) => void providerLists.push(list)
  })
  const received = async () => ((await codex.server.request('fake/log')) as { received: { method: string; params?: Record<string, unknown> }[] }).received
  return {
    pty, world, chat, opened, providerLists, state, codex, manager, received,
    sessions: () => sessions,
    permissions: () => permissions,
    session: (id: string) => manager.list().find((s) => s.id === id),
    waitState: (id: string, want: string) => until(() => manager.list().find((s) => s.id === id)?.state === want, `state ${want}`)
  }
}

await t('providers: codex available with account + usage; logged out -> start refused, login opens only a valid URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-codex-'))
  // Logged in.
  const a = stack()
  const list = await a.manager.providers()
  assert.deepEqual(list.map((p) => [p.id, p.available, p.reason]), [['claude-code', false, 'no driver'], ['codex', true, undefined], ['antigravity', false, 'driver coming in phase C']])
  assert.deepEqual(list[1], { id: 'codex', label: 'Codex', available: true, version: '0.160.0', account: { loggedIn: true, plan: 'free' }, usage: { usedPercent: 1, resetsAt: 1793536961000, windowMinutes: 43200 } })
  await assert.rejects(a.manager.start({ provider: 'antigravity', cwd: dir }), /phase C/)
  await assert.rejects(a.manager.login('antigravity'), /no login/)
  await assert.rejects(a.manager.login('bash'), /unknown provider/)
  await a.manager.login('codex') // already logged in: nothing to open
  assert.deepEqual(a.opened, [])
  await a.manager.shutdown()

  // Logged out: listed as available (the app offers "Log in"), but a session can't start.
  const b = stack({ FAKE_CODEX_LOGGED_OUT: '1' })
  const out = (await b.manager.providers())[1]
  assert.deepEqual(out, { id: 'codex', label: 'Codex', available: true, version: '0.160.0', account: { loggedIn: false } })
  await assert.rejects(b.manager.start({ provider: 'codex', cwd: dir }), /Not logged in to Codex — use Log in/)
  assert.deepEqual(b.manager.list(), [])
  assert.deepEqual(b.world, [])
  await b.manager.login('codex')
  assert.equal(b.opened.length, 1)
  assert.match(b.opened[0], /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
  assert.equal((await b.manager.providers())[1].account?.loggedIn, false) // not until the browser flow completes
  // The browser flow completes: the renderer is told, and sessions can start.
  b.providerLists.length = 0
  await b.codex.server.request('fake/login/complete')
  await until(() => b.providerLists.some((l) => l[1].account?.loggedIn && l[1].usage), 'providersChanged with the account and usage')
  const info = await b.manager.start({ provider: 'codex', cwd: dir })
  assert.equal(info.state, 'idle')
  // Logged out again behind our back: the session says so and refuses input until the login is back.
  await b.codex.server.request('fake/logout')
  await b.waitState(info.id, 'needs-attention')
  await assert.rejects(b.manager.chatSend(info.id, 'hello'), /Not logged in to Codex — use Log in/)
  const notice = b.manager.chatAttach(info.id).find((i) => i.kind === 'notice')
  assert.ok(notice?.kind === 'notice' && notice.level === 'error' && notice.text === NOT_LOGGED_IN)
  await b.codex.server.request('fake/login/complete')
  await b.waitState(info.id, 'idle')
  await b.manager.shutdown()

  // A login address that isn't OpenAI's is never opened.
  const c = stack({ FAKE_CODEX_LOGGED_OUT: '1', FAKE_CODEX_AUTH_URL: 'https://auth.openai.com.evil.example/oauth/authorize' })
  await assert.rejects(c.manager.login('codex'), /not an OpenAI login page/)
  assert.deepEqual(c.opened, [])
  assert.ok((await c.received()).some((m) => m.method === 'account/login/cancel')) // and the pending login is cancelled
  await c.manager.shutdown()

  // Not installed.
  const d = new SessionManager({
    pty: new NoPty(),
    sink: { emit: () => {} },
    providers: [codexProvider({ openExternal: async () => {}, findExecutable: () => null })],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: () => {},
    onTerminalData: () => {}
  })
  assert.deepEqual((await d.providers())[1], { id: 'codex', label: 'Codex', available: false, reason: 'not installed' })
  await assert.rejects(d.start({ provider: 'codex', cwd: dir }), /Codex is not available: not installed/)
  await assert.rejects(d.login('codex'), /not installed/)
  rmSync(dir, { recursive: true, force: true })
})

await t('codex session end to end: start, chat, approval allow/deny, order as steer, interrupt, stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-codex-'))
  const s = stack()
  const info = await s.manager.start({ provider: 'codex', cwd: dir, command: 'calc.exe', args: ['x'] })
  const id = info.id
  // Named after the model the thread reported; a chat session, not a terminal.
  assert.equal(info.title, 'gpt-6-luna')
  assert.equal(info.model, 'gpt-6-luna')
  assert.equal(info.surface, 'chat')
  assert.equal(info.state, 'idle')
  assert.equal(info.provider, 'codex')
  assert.equal(info.canReceiveOrders, true)
  assert.match(info.providerSessionId ?? '', /^thr-/)
  assert.deepEqual(s.world.map((e) => [e.agentId, e.parentId, e.provider, e.displayName, e.activity]), [[id, null, 'codex', 'gpt-6-luna', 'idle']])
  // thread/start carried the policy for the mode (default: ask before commands), the folder and the briefing.
  const start = (await s.received()).find((m) => m.method === 'thread/start')?.params ?? {}
  assert.equal(start.cwd, dir)
  assert.equal(start.approvalPolicy, 'untrusted')
  assert.equal(start.sandbox, 'workspace-write')
  assert.equal(start.approvalsReviewer, undefined) // stays "user", or approvals would never reach the app
  assert.match(String(start.developerInstructions), /Agent Office/)
  assert.ok(!('command' in start) && !('args' in start))

  // A chat session has no terminal: attach rejects cleanly and nothing reaches the pty.
  await assert.rejects(s.manager.attach(id), /no terminal/)
  s.manager.write(id, 'x')
  s.manager.resize(id, 80, 24)
  s.manager.ack(id, 10)
  s.manager.detach(id)
  assert.deepEqual(s.pty.calls, [])

  // Nothing is streamed until the renderer attaches; attach returns the list and sends it as a reset.
  assert.deepEqual(s.chat, [])
  assert.deepEqual(s.manager.chatAttach(id), [])
  assert.deepEqual(s.chat, [{ type: 'reset', sessionId: id, items: [] }])
  assert.throws(() => s.manager.chatAttach('s-nope'), /unknown session/)

  // chat.send validation.
  await assert.rejects(s.manager.chatSend(id, 42), /invalid message/)
  await assert.rejects(s.manager.chatSend(id, '  \n '), /empty/)
  await assert.rejects(s.manager.chatSend(id, 'x'.repeat(CHAT_MAX_PROMPT_CHARS + 1)), /longer than/)
  await assert.rejects(s.manager.chatSend('s-nope', 'hi'), /unknown session/)

  // ---- turn 1: plain answer. chat.send is not gated by "Allow CEO orders". ----
  assert.equal(s.state.allowOrders, false)
  await s.manager.chatSend(id, 'hello there')
  await until(() => s.chat.some((e) => e.type === 'turn' && e.status === 'completed'), 'turn 1 completed')
  await s.waitState(id, 'idle')
  let items = s.manager.chatAttach(id)
  assert.deepEqual(items.map((i) => [i.kind, i.kind === 'user' ? `${i.origin}:${i.text}` : i.kind === 'assistant' ? i.text : '']), [['user', 'human:hello there'], ['assistant', 'ok']])
  assert.match(items[0].id, /^ao-human-[0-9a-f]{16}$/)
  const turn1 = (await s.received()).filter((m) => m.method === 'turn/start')[0].params ?? {}
  // The policy and sandbox go out again with every turn.
  assert.equal(turn1.approvalPolicy, 'untrusted')
  assert.deepEqual(turn1.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
  assert.deepEqual(turn1.input, [{ type: 'text', text: 'hello there', text_elements: [] }])
  assert.equal(turn1.clientUserMessageId, items[0].id)
  // Usage reported after the model response reached the provider list.
  await until(() => s.providerLists.some((l) => l[1].usage?.usedPercent === 2), 'usage update broadcast')

  // ---- turn 2: approval, allowed from the CEO inbox ----
  s.chat.length = 0
  await s.manager.chatSend(id, 'please approve this')
  const perm = await until(() => s.permissions()[0], 'permission registered')
  assert.equal(perm.sessionId, id)
  assert.equal(perm.agentId, id)
  assert.equal(perm.provider, 'codex')
  assert.equal(perm.displayName, 'gpt-6-luna')
  assert.equal(perm.toolName, 'Command')
  assert.equal(perm.summary, `Command: node -e "console.log('ao-fake')"`)
  assert.equal(perm.detail, `node -e "console.log('ao-fake')"\n\ncwd: C:\\ws`)
  assert.equal(s.session(id)?.state, 'waiting-permission')
  assert.deepEqual([s.world[s.world.length - 1].activity, s.world[s.world.length - 1].detail], ['waiting', perm.summary])
  items = s.manager.chatAttach(id)
  const card = items.find((i) => i.kind === 'approval')
  const subject = items.find((i) => i.kind === 'command')
  assert.ok(card?.kind === 'approval' && card.requestId === perm.id && card.outcome === 'pending' && card.subjectId === subject?.id)
  assert.ok(subject?.kind === 'command' && subject.status === 'running')
  assert.equal(s.manager.decide(perm.id, { behavior: 'allow' }), 'allowed')
  assert.deepEqual(s.permissions(), [])
  await s.waitState(id, 'idle')
  assert.equal(s.manager.decide(perm.id, { behavior: 'allow' }), 'resolved-elsewhere') // a second click
  items = s.manager.chatAttach(id)
  const ran = items.find((i) => i.kind === 'command')
  assert.ok(ran?.kind === 'command' && ran.status === 'done' && ran.output === 'ao-fake\n' && ran.exitCode === 0)
  const allowed = items.find((i) => i.kind === 'approval')
  assert.ok(allowed?.kind === 'approval' && allowed.outcome === 'allowed')
  const lastItem = items[items.length - 1]
  assert.ok(lastItem.kind === 'assistant' && lastItem.text === 'ao-fake' && lastItem.phase === 'final' && !lastItem.streaming)
  // World: waiting -> back to the command -> idle at the end of the turn.
  const w2 = s.world.slice(1).map((e) => e.activity)
  assert.deepEqual(w2.slice(-4), ['exec', 'waiting', 'exec', 'idle'])
  // The streamed events rebuild exactly the list the main process holds.
  const view: ChatItem[] = []
  for (const e of s.chat) {
    if (e.type === 'reset') view.splice(0, view.length, ...e.items)
    else if (e.type === 'item') {
      const i = view.findIndex((x) => x.id === e.item.id)
      if (i >= 0) view[i] = e.item
      else view.push(e.item)
    } else if (e.type === 'delta') {
      const item = view.find((x) => x.id === e.itemId) as Record<string, unknown>
      item[e.field] = (item[e.field] as string) + e.delta
    }
  }
  assert.deepEqual(view, items)
  // ---- turn 3: denied with a message; the message follows as a steer ----
  await s.manager.chatSend(id, 'approve again')
  const perm2 = await until(() => s.permissions()[0], 'second permission')
  assert.equal(s.manager.decide(perm2.id, { behavior: 'deny', message: 'use the other script' }), 'denied')
  await s.waitState(id, 'idle')
  items = s.manager.chatAttach(id)
  const turn3 = items.filter((i) => i.turnId === items[items.length - 1].turnId)
  assert.deepEqual(turn3.map((i) => [i.kind, i.kind === 'user' ? `${i.origin}:${i.text}` : i.kind === 'command' ? i.status : i.kind === 'approval' ? i.outcome : i.kind === 'assistant' ? i.text : '']), [
    ['user', 'human:approve again'],
    ['assistant', 'I’ll run the requested command.'],
    ['command', 'declined'],
    ['approval', 'denied'],
    ['user', 'steer:use the other script'],
    ['assistant', 'Understood: use the other script']
  ])
  const steers = (await s.received()).filter((m) => m.method === 'turn/steer')
  assert.equal(steers.length, 1)
  assert.deepEqual(steers[0].params?.input, [{ type: 'text', text: 'use the other script', text_elements: [] }])

  // ---- turn 4: an order mid-turn is a steer; orders are gated, and reach Codex by provider target ----
  await s.manager.chatSend(id, 'run the slow command')
  await until(() => s.manager.chatAttach(id).some((i) => i.kind === 'command' && i.status === 'running'), 'slow command running')
  assert.equal(s.session(id)?.state, 'busy')
  let r = await s.manager.sendOrder({ target: 'provider:codex', text: 'end with steered-ok' })
  assert.deepEqual(r, { delivered: [], failed: [{ agentId: 'provider:codex', reason: REASON_DISABLED }] })
  s.state.allowOrders = true
  r = await s.manager.sendOrder({ target: 'provider:codex', text: 'end with steered-ok' })
  assert.deepEqual(r, { delivered: [id], failed: [] })
  await s.waitState(id, 'idle')
  items = s.manager.chatAttach(id)
  const order = items.find((i) => i.kind === 'user' && i.origin === 'order')
  // Not prefixed: for Codex an order is a real user turn.
  assert.ok(order?.kind === 'user' && order.text === 'end with steered-ok')
  const answer = items[items.length - 1]
  assert.ok(answer.kind === 'assistant' && answer.text === 'slow-done (end with steered-ok)')
  assert.equal(order?.turnId, answer.turnId) // same turn
  assert.equal((await s.received()).filter((m) => m.method === 'turn/steer').length, 2)
  // Other targets: everyone (the external Claude session can't be reached), one session id, another provider.
  r = await s.manager.sendOrder({ target: 'all', text: 'status?' })
  assert.deepEqual(r.delivered, [id])
  assert.deepEqual(r.failed.map((f) => f.agentId), ['ext-claude'])
  await until(() => s.session(id)?.state === 'idle' && s.manager.chatAttach(id).filter((i) => i.kind === 'user' && i.origin === 'order').length === 2, 'the order turn to finish')
  r = await s.manager.sendOrder({ target: id, text: 'again' })
  assert.deepEqual(r, { delivered: [id], failed: [] })
  await until(() => s.session(id)?.state === 'idle' && s.manager.chatAttach(id).filter((i) => i.kind === 'user' && i.origin === 'order').length === 3, 'the second order turn to finish')
  r = await s.manager.sendOrder({ target: 'provider:antigravity', text: 'x' })
  assert.match(r.failed[0].reason, /no active sessions/)

  // ---- turn: interrupt closes the running command (Codex sends no item/completed for it) ----
  await s.manager.chatSend(id, 'slow again')
  await until(() => s.manager.chatAttach(id).some((i) => i.kind === 'command' && i.status === 'running'), 'slow command running')
  s.chat.length = 0
  s.manager.interrupt(id)
  await s.waitState(id, 'idle')
  items = s.manager.chatAttach(id)
  const cut = items.filter((i) => i.kind === 'command').pop()
  assert.ok(cut?.kind === 'command' && cut.status === 'interrupted')
  assert.ok(s.chat.some((e) => e.type === 'turn' && e.status === 'interrupted'))
  assert.equal(s.world[s.world.length - 1].activity, 'idle')
  // Interrupting an approval that is pending clears its card as resolved-elsewhere.
  await s.manager.chatSend(id, 'approve once more')
  const perm3 = await until(() => s.permissions()[0], 'third permission')
  s.manager.interrupt(id)
  await s.waitState(id, 'idle')
  assert.deepEqual(s.permissions(), [])
  assert.equal(s.manager.decide(perm3.id, { behavior: 'allow' }), 'resolved-elsewhere')
  const dropped = s.manager.chatAttach(id).filter((i) => i.kind === 'approval').pop()
  assert.ok(dropped?.kind === 'approval' && dropped.outcome === 'resolved-elsewhere')

  // A failed turn: back to idle, with an error notice.
  await s.manager.chatSend(id, 'fail please')
  await until(() => s.manager.chatAttach(id).some((i) => i.kind === 'notice' && i.level === 'error'), 'error notice')
  await s.waitState(id, 'idle')

  // Detach: no more events for the renderer.
  s.manager.chatDetach(id)
  s.chat.length = 0
  await s.manager.chatSend(id, 'quiet')
  await until(() => s.manager.list()[0].state === 'idle' && s.codex.server.running, 'idle')
  await sleep(50)
  assert.deepEqual(s.chat, [])

  // ---- stop: the driver is dropped, the thread is unsubscribed (not archived), the manager leaves ----
  await s.manager.stop(id)
  assert.equal(s.session(id)?.state, 'exited')
  assert.equal(s.session(id)?.exitCode, 0)
  assert.equal(s.world[s.world.length - 1].activity, 'done')
  const methods = (await s.received()).map((m) => m.method)
  assert.ok(methods.includes('thread/unsubscribe'))
  assert.ok(!methods.some((m) => /archive|delete|shellCommand/.test(m)))
  await assert.rejects(s.manager.chatSend(id, 'too late'), /ended/)
  assert.equal(s.manager.chatAttach(id).length > 0, true) // the conversation stays readable until the session is removed
  await s.manager.stop(id) // removes the exited session
  assert.deepEqual(s.manager.list(), [])
  assert.deepEqual(s.pty.calls, [])

  // App quit: the app-server process is stopped.
  const pid = s.codex.server.pid
  assert.ok(alive(pid))
  await s.manager.shutdown()
  await until(() => !alive(pid), 'app-server gone')
  await assert.rejects(s.manager.start({ provider: 'codex', cwd: dir }), /shutting down/)
  rmSync(dir, { recursive: true, force: true })
})

await t('codex: resume rebuilds the chat; modes map to policies; a read-only downgrade is noticed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-codex-'))
  const s = stack()
  const info = await s.manager.start({ provider: 'codex', cwd: dir, resume: 'thr-old', permissionMode: 'plan', title: 'Docs team', model: 'gpt-5.5' })
  assert.equal(info.title, 'Docs team') // a title the user typed always wins
  assert.equal(info.model, 'gpt-5.5')
  assert.equal(info.providerSessionId, 'thr-old')
  const resume = (await s.received()).find((m) => m.method === 'thread/resume')?.params ?? {}
  // Resume restores neither: both are sent again.
  assert.deepEqual([resume.threadId, resume.excludeTurns, resume.approvalPolicy, resume.sandbox, resume.model, resume.cwd], ['thr-old', true, 'on-request', 'read-only', 'gpt-5.5', dir])
  const items = s.manager.chatAttach(info.id)
  assert.deepEqual(kinds(items), ['user', 'file-change', 'assistant', 'user', 'command', 'notice'])
  assert.ok(items[1].kind === 'file-change' && items[1].changes[0].diff.startsWith('@@ -0,0 +1,2 @@'))
  assert.ok(items[4].kind === 'command' && items[4].status === 'interrupted')
  assert.ok(items[5].kind === 'notice' && items[5].text === 'Turn interrupted')
  // A turn after the resume carries the plan-mode policy.
  await s.manager.chatSend(info.id, 'hi')
  await until(() => s.manager.chatAttach(info.id).some((i) => i.kind === 'assistant' && i.text === 'ok'), 'the answer')
  const turn = (await s.received()).find((m) => m.method === 'turn/start')?.params ?? {}
  assert.deepEqual([turn.approvalPolicy, turn.sandboxPolicy], ['on-request', { type: 'readOnly', networkAccess: false }])
  await assert.rejects(s.manager.start({ provider: 'codex', cwd: dir, resume: 'thr-missing' }), /could not resume.*no rollout found/)
  assert.equal(s.manager.list().length, 1)

  const edits = await s.manager.start({ provider: 'codex', cwd: dir, permissionMode: 'acceptEdits' })
  const second = (await s.received()).filter((m) => m.method === 'thread/start').pop()?.params ?? {}
  assert.deepEqual([second.approvalPolicy, second.sandbox], ['on-request', 'workspace-write'])
  assert.deepEqual(s.manager.chatAttach(edits.id), []) // sandbox as requested: no notice
  // Two sessions of the same model: the folder tells them apart (the first has the user's title).
  assert.equal(edits.title, 'gpt-6-luna')
  await s.manager.shutdown()

  const ro = stack({ FAKE_CODEX_READONLY: '1' })
  const downgraded = await ro.manager.start({ provider: 'codex', cwd: dir })
  const notice = ro.manager.chatAttach(downgraded.id)
  assert.ok(notice.length === 1 && notice[0].kind === 'notice' && notice[0].level === 'warning' && /read-only/.test(notice[0].text))
  // The read-only sandbox the server applied is not overridden per turn by a policy it refused.
  await ro.manager.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

await t('codex: an app-server crash marks the session, clears its cards, and the session reconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-codex-'))
  const s = stack()
  const info = await s.manager.start({ provider: 'codex', cwd: dir })
  const id = info.id
  s.manager.chatAttach(id)
  await s.manager.chatSend(id, 'approve this')
  const perm = await until(() => s.permissions()[0], 'permission')
  const pid = s.codex.server.pid
  process.kill(pid as number)
  await s.waitState(id, 'needs-attention')
  // The card is gone (nobody waits for the answer any more) and the open command is closed.
  assert.deepEqual(s.permissions(), [])
  assert.equal(s.manager.decide(perm.id, { behavior: 'allow' }), 'resolved-elsewhere')
  let items = s.manager.chatAttach(id)
  const cmd = items.find((i) => i.kind === 'command')
  assert.ok(cmd?.kind === 'command' && cmd.status === 'failed')
  assert.ok(items.some((i) => i.kind === 'notice' && i.level === 'error' && /stopped unexpectedly/.test(i.text)))
  assert.ok(s.chat.some((e) => e.type === 'turn' && e.status === 'failed'))
  assert.equal(s.session(id)?.canReceiveOrders, false)
  await assert.rejects(s.manager.chatSend(id, 'hello?'), /restarting/)
  // The server comes back (backoff) and the thread is loaded again with its policy.
  await s.waitState(id, 'idle')
  assert.notEqual(s.codex.server.pid, pid)
  const resume = (await s.received()).find((m) => m.method === 'thread/resume')?.params ?? {}
  assert.deepEqual([resume.threadId, resume.approvalPolicy, resume.sandbox], [info.providerSessionId, 'untrusted', 'workspace-write'])
  items = s.manager.chatAttach(id)
  assert.ok(items.some((i) => i.kind === 'notice' && /Reconnected/.test(i.text)))
  assert.ok(!items.some((i) => i.kind === 'notice' && /stopped unexpectedly/.test(i.text))) // replaced in place
  await s.manager.chatSend(id, 'still there?')
  await until(() => s.manager.chatAttach(id).filter((i) => i.kind === 'assistant' && i.text === 'ok').length === 1, 'a turn after the reconnect')
  await s.manager.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${pass} codex tests passed`)

await import('./ui.test.ts')
