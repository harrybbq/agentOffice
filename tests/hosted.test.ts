// Hosted sessions (main-process side): hook payload -> AgentEvent mapping, the session state
// machine, the permission registry, per-session ingest tokens, order targets, and the whole stack
// (session manager + Claude driver + ingest server) driven over real HTTP with a fake pty.
// Imported by rules.test.ts (npm test runs everything). Payload shapes: docs/spikes-phase-a.md.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../shared/events.ts'
import { planOrder, REASON_DISABLED, REASON_NO_SESSIONS, REASON_NOT_CONNECTED } from '../shared/orders.ts'
import { subagentId, type PermissionOutcome, type PermissionRequestInfo, type SessionInfo } from '../shared/sessions.ts'
import {
  activityForTool,
  ClaudeHookMapper,
  createClaudeCodeHooksAdapter,
  isSyntheticPrompt,
  TOOL_ACTIVITY,
  toolDetail
} from '../electron/adapters/claude-code-hooks.ts'
import type { RequestContext } from '../electron/adapters/types.ts'
import {
  buildClaudeSettings,
  claudeArgs,
  claudeProvider,
  isInboxSocketPath,
  permissionDecisionBody,
  ptyPromptWrites,
  sanitizeForTerminal,
  sweepSessionFiles,
  scrubbedEnv
} from '../electron/drivers/claude.ts'
import {
  SessionStateMachine,
  START_ATTENTION_MS,
  TITLE_IDLE_DEBOUNCE_MS,
  titleHint,
  type Scheduler
} from '../electron/drivers/sessionState.ts'
import type { PtyHandlers, PtyHost, ScreenSnapshot } from '../electron/drivers/types.ts'
import { authenticate, authorise, SessionTokens } from '../electron/ingest/auth.ts'
import { startIngestServer } from '../electron/ingest/server.ts'
import { parsePermissionDecision, PermissionRegistry, PERMISSION_DETAIL_MAX } from '../electron/permissions.ts'
import type { PtySpawnOptions } from '../electron/ptyProtocol.ts'
import { SessionInbox } from '../electron/sessionInbox.ts'
import { SessionManager } from '../electron/sessions.ts'

let pass = 0
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn()
  pass++
  console.log('ok -', name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}

// Common fields on every hook payload (spike 2).
const SID = '0b6f4f0e-1111-4222-8333-444455556666'
const common = (name: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID,
  transcript_path: `C:\\Users\\me\\.claude\\projects\\ws\\${SID}.jsonl`,
  cwd: 'C:\\work\\my-project',
  scratchpad_dir: 'C:\\tmp\\scratch',
  prompt_id: 'p1',
  hook_event_name: name,
  ...extra
})
const SUB = 'a7dbf87f777914f47'
const brief = (events: AgentEvent[]) => events.map((e) => `${e.agentId}|${e.parentId ?? '-'}|${e.activity}|${e.detail}`)

// ---- tool table -----------------------------------------------------------------------------------

await t('tool -> activity table', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'LSP', 'NotebookRead']) assert.equal(activityForTool(tool), 'read', tool)
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) assert.equal(activityForTool(tool), 'write', tool)
  for (const tool of ['Bash', 'PowerShell']) assert.equal(activityForTool(tool), 'exec', tool)
  for (const tool of ['WebFetch', 'WebSearch']) assert.equal(activityForTool(tool), 'web', tool)
  for (const tool of ['Agent', 'Task']) assert.equal(activityForTool(tool), 'exec', tool)
  assert.equal(activityForTool('mcp__claude-in-chrome__computer', { action: 'screenshot' }), 'capture')
  assert.equal(activityForTool('mcp__claude-in-chrome__computer', { action: 'left_click' }), 'exec')
  assert.equal(activityForTool('mcp__playwright__browser_take_screenshot'), 'capture')
  assert.equal(activityForTool('mcp__figma__get_screenshot'), 'capture')
  assert.equal(activityForTool('mcp__supabase__execute_sql'), 'exec')
  assert.equal(activityForTool('SomethingNew'), 'exec')
  assert.equal(activityForTool('constructor'), 'exec') // not fooled by Object.prototype
  assert.equal(TOOL_ACTIVITY.Read, 'read') // the table is one editable object

  assert.equal(toolDetail('Read', { file_path: 'C:\\work\\src\\app.ts' }), 'C:\\work\\src\\app.ts')
  assert.equal(toolDetail('Bash', { command: 'npm test\n  --watch', description: 'run tests' }), 'npm test --watch')
  assert.equal(toolDetail('WebFetch', { url: 'https://example.com/x', prompt: 'summarise' }), 'https://example.com/x')
  assert.equal(toolDetail('Grep', { pattern: 'TODO' }), 'TODO')
  assert.equal(toolDetail('Agent', { prompt: 'list files', subagent_type: 'Explore' }), 'delegating')
  assert.equal(toolDetail('Bash', { command: 'x'.repeat(5000) }).length, 200)
  assert.equal(toolDetail('Bash', null), '')
})

// ---- mapping ----------------------------------------------------------------------------------------

await t('hook payloads -> AgentEvents: a turn with a background subagent (spike 2 sequence)', () => {
  const m = new ClaudeHookMapper({ rootId: 'S', displayName: 'my-project', holdWaiting: true })
  const sub = subagentId('S', SUB)
  const run = (name: string, extra?: Record<string, unknown>) => m.handle(common(name, extra), 1000)

  let r = run('SessionStart', { source: 'startup', model: 'claude-opus-5-5' })
  assert.equal(r.kind, 'session-start')
  assert.deepEqual(r.events, [
    { agentId: 'S', parentId: null, provider: 'claude-code', displayName: 'my-project', activity: 'idle', detail: '', ts: 1000 }
  ])

  r = run('UserPromptSubmit', { prompt: 'Use the Agent tool to have a subagent list files', permission_mode: 'default' })
  assert.equal(r.kind, 'prompt')
  assert.deepEqual(r.events, [])

  r = run('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'list files', subagent_type: 'Explore' }, tool_use_id: 'tu1' })
  assert.deepEqual(brief(r.events), ['S|-|exec|delegating'])

  r = run('SubagentStart', { agent_id: SUB, agent_type: 'Explore' })
  assert.equal(r.kind, 'subagent-start')
  assert.equal(r.agentId, sub)
  assert.deepEqual(r.events, [
    { agentId: sub, parentId: 'S', provider: 'claude-code', displayName: 'Explore', activity: 'idle', detail: 'Explore', ts: 1000 }
  ])

  r = run('PostToolUse', { tool_name: 'Agent', tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: SUB }, duration_ms: 18 })
  assert.deepEqual(r.events, [])

  // The main turn stops while the subagent is still running in the background.
  r = run('Stop', { stop_hook_active: false, background_tasks: [{ id: SUB, type: 'subagent', status: 'running' }] })
  assert.equal(r.kind, 'stop')
  assert.deepEqual(brief(r.events), ['S|-|idle|'])

  // Tool events inside the subagent carry agent_id + agent_type.
  r = run('PreToolUse', { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' }, tool_use_id: 'tu2', agent_id: SUB, agent_type: 'Explore' })
  assert.equal(r.agentId, sub)
  assert.deepEqual(brief(r.events), [`${sub}|S|exec|Get-ChildItem`])
  assert.equal(r.events[0].displayName, 'Explore')
  r = run('PostToolUse', { tool_name: 'PowerShell', tool_input: {}, tool_response: {}, agent_id: SUB, agent_type: 'Explore' })
  assert.deepEqual(r.events, [])
  r = run('PreToolUse', { tool_name: 'SubagentHandback', tool_input: { message: 'done' }, agent_id: SUB, agent_type: 'Explore' })
  assert.deepEqual(brief(r.events), [`${sub}|S|exec|`])

  // The hand-back raises a UserPromptSubmit the user never typed.
  r = run('UserPromptSubmit', { prompt: `<agent-message from="${SUB}">\n[Subagent hand-back] 2 files` })
  assert.equal(r.kind, 'synthetic-prompt')
  assert.deepEqual(r.events, [])

  r = run('SubagentStop', { agent_id: SUB, agent_type: 'Explore', last_assistant_message: 'done', background_tasks: [] })
  assert.equal(r.kind, 'subagent-stop')
  assert.deepEqual(brief(r.events), [`${sub}|S|done|`])
  assert.deepEqual(m.subagents(), [])
  // A straggler for the finished subagent must not bring it back.
  assert.deepEqual(run('PostToolUse', { tool_name: 'Read', agent_id: SUB, agent_type: 'Explore' }).events, [])
  assert.deepEqual(run('PreToolUse', { tool_name: 'Read', tool_input: {}, agent_id: SUB, agent_type: 'Explore' }).events, [])

  r = run('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>${SUB}</task-id>` })
  assert.equal(r.kind, 'synthetic-prompt')

  // The prompt-suggestion generator: SubagentStop with agent_type "" and no SubagentStart.
  r = run('SubagentStop', { agent_id: 'a000suggest', agent_type: '', last_assistant_message: 'what did the subagent find?' })
  assert.equal(r.kind, 'ignored')
  assert.deepEqual(r.events, [])
  // ...and a SubagentStop for an id that never started.
  assert.equal(run('SubagentStop', { agent_id: 'never-started', agent_type: 'Explore' }).kind, 'ignored')

  r = run('SessionEnd', { reason: 'prompt_input_exit' })
  assert.equal(r.kind, 'session-end')
  assert.deepEqual(brief(r.events), ['S|-|done|'])
})

await t('mapping: activities, details, synthetic prompt filter, done for live subagents', () => {
  const m = new ClaudeHookMapper({ rootId: 'S', displayName: 'proj' })
  const act = (tool: string, input: unknown, extra: Record<string, unknown> = {}) =>
    brief(m.handle(common('PreToolUse', { tool_name: tool, tool_input: input, ...extra }), 5).events)
  // The first hook of an unknown session spawns its manager.
  assert.deepEqual(act('Read', { file_path: 'src/a.ts' }), ['S|-|read|src/a.ts'])
  assert.deepEqual(act('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), ['S|-|write|src/a.ts'])
  assert.deepEqual(act('Bash', { command: 'npm test' }), ['S|-|exec|npm test'])
  assert.deepEqual(act('WebSearch', { query: 'electron utilityProcess' }), ['S|-|web|electron utilityProcess'])
  assert.deepEqual(act('mcp__claude-in-chrome__computer', { action: 'screenshot' }), ['S|-|capture|'])
  // A subagent whose SubagentStart was missed: its manager exists, it appears with its first tool.
  assert.deepEqual(act('Grep', { pattern: 'foo' }, { agent_id: 'x1', agent_type: 'Explore' }), ['S:x1|S|read|foo'])

  assert.ok(isSyntheticPrompt('<agent-message from="a1">\nhello'))
  assert.ok(isSyntheticPrompt('<task-notification>\n<task-id>a1</task-id>'))
  assert.ok(!isSyntheticPrompt('Please read <agent-message> docs'))
  assert.ok(!isSyntheticPrompt('fix the bug'))
  assert.ok(!isSyntheticPrompt(undefined))

  // A hook for a session we have never seen that produces no activity still spawns the manager.
  const m2 = new ClaudeHookMapper({ rootId: 'T', displayName: 't' })
  assert.deepEqual(brief(m2.handle(common('UserPromptSubmit', { prompt: 'hi' }), 1).events), ['T|-|idle|'])
  assert.deepEqual(brief(m2.handle(common('SubagentStart', { agent_id: 'b2', agent_type: '' }), 1).events), ['T:b2|T|idle|'])
  assert.equal(m2.handle(common('SubagentStart', { agent_id: 'b3', agent_type: 'Plan' }), 1).events[0].displayName, 'Plan')
  // Session end: subagents first, then the manager.
  assert.deepEqual(brief(m2.end(9)), ['T:b2|T|done|', 'T:b3|T|done|', 'T|-|done|'])
  assert.deepEqual(m2.end(9), [])
  // A hosted session ends with its process, not with SessionEnd (`/clear` fires one and carries on).
  const m3 = new ClaudeHookMapper({ rootId: 'H', displayName: 'h', endsWithProcess: true })
  m3.spawn(1, 'starting')
  assert.deepEqual(m3.handle(common('SessionEnd', { reason: 'clear' }), 2).events, [])
  assert.deepEqual(brief(m3.end(3)), ['H|-|done|'])
  assert.deepEqual(m.handle(null).events, [])
  assert.equal(m.handle({ hook_event_name: 'SomethingElse' }).kind, 'ignored')
})

await t('mapping: PermissionRequest -> waiting, resolved -> previous activity or idle', () => {
  const m = new ClaudeHookMapper({ rootId: 'S', displayName: 'proj', holdWaiting: true })
  m.handle(common('SessionStart'), 1)
  m.handle(common('PreToolUse', { tool_name: 'PowerShell', tool_input: { command: 'node -e "1"' } }), 2)
  // PermissionRequest has no tool_use_id (spike 3).
  const perm = common('PermissionRequest', {
    tool_name: 'PowerShell',
    tool_input: { command: 'node -e "1"' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: 'node -e "1"' }], behavior: 'allow', destination: 'localSettings' }],
    permission_mode: 'default'
  })
  let r = m.handle(perm, 3)
  assert.equal(r.kind, 'permission')
  assert.equal(r.agentId, 'S')
  assert.deepEqual(brief(r.events), ['S|-|waiting|PowerShell: node -e "1"'])
  // Hosted: it stays waiting until resume(), whatever else arrives.
  assert.deepEqual(m.handle(common('PostToolUse', { tool_name: 'PowerShell' }), 4).events, [])
  assert.deepEqual(brief(m.resume('S', 5)), ['S|-|exec|node -e "1"'])
  assert.deepEqual(m.resume('S', 6), [])

  // Waiting from idle goes back to idle.
  m.handle(common('Stop'), 7)
  m.handle(perm, 8)
  assert.deepEqual(brief(m.resume('S', 9)), ['S|-|idle|'])

  // Two pending requests: still waiting after the first is resolved.
  m.handle(perm, 10)
  m.handle(perm, 11)
  assert.deepEqual(m.resume('S', 12), [])
  assert.equal(m.resume('S', 13).length, 1)

  // A subagent's request blocks the subagent, not the manager.
  r = m.handle({ ...perm, agent_id: SUB, agent_type: 'Explore' }, 14)
  assert.equal(r.agentId, subagentId('S', SUB))
  assert.equal(r.displayName, 'Explore')
  assert.equal(r.events[0].activity, 'waiting')
  assert.equal(r.events[0].parentId, 'S')
  assert.deepEqual(brief(m.resume(subagentId('S', SUB), 15)), [`S:${SUB}|S|idle|`])

  // External sessions are never told the outcome: the next tool event ends the wait.
  const ext = new ClaudeHookMapper({ rootId: SID, displayName: 'ext' })
  ext.handle(common('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x' } }), 1)
  assert.equal(ext.handle(common('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }), 2).events[0].activity, 'waiting')
  assert.deepEqual(brief(ext.handle(common('PostToolUse', { tool_name: 'Bash' }), 3).events), [`${SID}|-|exec|rm x`])
  ext.handle(common('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm y' } }), 4)
  assert.deepEqual(brief(ext.handle(common('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a' } }), 5).events), [`${SID}|-|read|a`])
})

await t('adapter: external sessions (global token) appear under their session_id and are never answered', async () => {
  const seen: AgentEvent[] = []
  const sink = { emit: (e: AgentEvent) => void seen.push(e) }
  const hostedCalls: unknown[] = []
  const adapter = createClaudeCodeHooksAdapter({
    hookTarget: (id) => (id === 's-hosted' ? { handleHook: (b) => (hostedCalls.push(b), { held: true }) } : undefined),
    ownsProviderSession: (id) => id === 'claude-id-of-hosted'
  })
  const global: RequestContext = { auth: { kind: 'global' }, signal: new AbortController().signal }
  assert.equal(adapter.route, '/hooks/claude-code')

  assert.deepEqual(await adapter.handle(common('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' } }), sink, global), {})
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agentId, SID)
  assert.equal(seen[0].parentId, null)
  assert.equal(seen[0].displayName, 'my-project') // the folder name
  assert.equal(seen[0].provider, 'claude-code')
  // PermissionRequest: `{}` at once, so the terminal's own dialog decides.
  const out = adapter.handle(common('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' } }), sink, global)
  assert.ok(!(out instanceof Promise))
  assert.deepEqual(out, {})
  assert.equal(seen[1].activity, 'waiting')
  // An inbox endpoint posted with the global token is dropped, not registered or forwarded.
  await adapter.handle(common('SessionStart', { _ao: { socket: '\\\\.\\pipe\\evil', token: 'x' } }), sink, global)
  assert.ok(!JSON.stringify(seen).includes('evil'))
  // A hosted session whose hooks also arrive with the global token must not get a second manager.
  const before = seen.length
  await adapter.handle({ ...common('PreToolUse', { tool_name: 'Read' }), session_id: 'claude-id-of-hosted' }, sink, global)
  assert.equal(seen.length, before)
  await adapter.handle(common('SessionEnd', { reason: 'prompt_input_exit' }), sink, global)
  assert.equal(seen[seen.length - 1].activity, 'done')
  assert.deepEqual(await adapter.handle('nonsense', sink, global), {})
  assert.deepEqual(await adapter.handle({ hook_event_name: 'Stop' }, sink, global), {}) // no session_id

  // A per-session token goes to that session's driver and nowhere else.
  const session = (sessionId: string): RequestContext => ({ auth: { kind: 'session', sessionId }, signal: new AbortController().signal })
  assert.deepEqual(await adapter.handle(common('Stop'), sink, session('s-hosted')), { held: true })
  assert.equal(hostedCalls.length, 1)
  const n = seen.length
  assert.deepEqual(await adapter.handle(common('Stop'), sink, session('s-gone')), {})
  assert.equal(seen.length, n)
})

// ---- state machine ----------------------------------------------------------------------------------

function fakeClock() {
  let now = 0
  let timers: { at: number; fn: () => void }[] = []
  const schedule: Scheduler = (fn, ms) => {
    const timer = { at: now + ms, fn }
    timers.push(timer)
    return () => {
      timers = timers.filter((x) => x !== timer)
    }
  }
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
      timers = timers.filter((x) => x !== timer)
      timer.fn()
    }
  }
  return { schedule, advance }
}

await t('session state machine', () => {
  const mk = () => {
    const clock = fakeClock()
    const seen: string[] = []
    const m = new SessionStateMachine((s) => void seen.push(s), clock.schedule)
    return { m, seen, ...clock }
  }
  // starting -> idle on SessionStart; the attention timer is cancelled.
  let x = mk()
  assert.equal(x.m.state, 'starting')
  x.advance(1500)
  x.m.ready()
  assert.equal(x.m.state, 'idle')
  x.advance(START_ATTENTION_MS * 2)
  assert.equal(x.m.state, 'idle')

  // No SessionStart within ~4 s: folder trust / login. The user answers in the terminal.
  x = mk()
  x.advance(START_ATTENTION_MS - 1)
  assert.equal(x.m.state, 'starting')
  x.advance(1)
  assert.equal(x.m.state, 'needs-attention')
  x.m.title('idle') // the title means nothing here
  x.advance(TITLE_IDLE_DEBOUNCE_MS * 2)
  assert.equal(x.m.state, 'needs-attention')
  x.m.ready()
  assert.equal(x.m.state, 'idle')

  // busy on UserPromptSubmit / PreToolUse, idle on Stop.
  x.m.activity()
  assert.equal(x.m.state, 'busy')
  x.m.turnEnded()
  assert.equal(x.m.state, 'idle')

  // waiting-permission while a request is pending; back to busy when it is resolved.
  x.m.activity()
  x.m.permissions(1)
  assert.equal(x.m.state, 'waiting-permission')
  x.m.activity() // PostToolUse of a parallel tool
  assert.equal(x.m.state, 'waiting-permission')
  x.m.permissions(2)
  x.m.permissions(1)
  assert.equal(x.m.state, 'waiting-permission')
  x.m.permissions(0)
  assert.equal(x.m.state, 'busy')
  x.m.turnEnded()
  assert.deepEqual(x.seen, ['needs-attention', 'idle', 'busy', 'idle', 'busy', 'waiting-permission', 'busy', 'idle'])

  // Interrupt: no Stop hook. The title shows the idle glyph; after the debounce the session is idle.
  x = mk()
  x.m.ready()
  x.m.title('busy')
  x.m.activity()
  x.m.title('idle')
  x.advance(TITLE_IDLE_DEBOUNCE_MS - 1)
  assert.equal(x.m.state, 'busy')
  x.advance(1)
  assert.equal(x.m.state, 'idle')

  // A flicker of the idle glyph mid-turn doesn't count, and a new tool call restarts the wait.
  x.m.activity()
  x.m.title('idle')
  x.advance(TITLE_IDLE_DEBOUNCE_MS - 100)
  x.m.title('busy')
  x.advance(TITLE_IDLE_DEBOUNCE_MS)
  assert.equal(x.m.state, 'busy')
  x.m.title('idle')
  x.advance(TITLE_IDLE_DEBOUNCE_MS - 100)
  x.m.activity()
  x.advance(TITLE_IDLE_DEBOUNCE_MS - 100)
  assert.equal(x.m.state, 'busy')
  x.advance(100)
  assert.equal(x.m.state, 'idle')

  // The title also shows the idle glyph while a permission dialog is open: no effect there, but
  // Esc on the dialog (request resolved elsewhere, no Stop) ends up idle.
  x.m.activity()
  x.m.permissions(1)
  x.advance(TITLE_IDLE_DEBOUNCE_MS * 3)
  assert.equal(x.m.state, 'waiting-permission')
  x.m.permissions(0)
  assert.equal(x.m.state, 'busy')
  x.advance(TITLE_IDLE_DEBOUNCE_MS)
  assert.equal(x.m.state, 'idle')

  // exited is final.
  x.m.exited()
  x.m.activity()
  x.m.ready()
  x.m.permissions(1)
  assert.equal(x.m.state, 'exited')

  assert.equal(titleHint('✳ Claude Code'), 'idle')
  assert.equal(titleHint('◐ Running tests'), 'busy')
  assert.equal(titleHint('◑ Running tests'), 'busy')
  assert.equal(titleHint('C:\\Windows\\system32\\cmd.exe'), null)
  assert.equal(titleHint(''), null)
})

// ---- permission registry ----------------------------------------------------------------------------

await t('permission registry: decide / disconnect / unknown id', () => {
  const broadcasts: PermissionRequestInfo[][] = []
  const reg = new PermissionRegistry((list) => void broadcasts.push(list))
  const outcomes: string[] = []
  const add = (sessionId: string, agentId = sessionId, signal?: AbortSignal) =>
    reg.add(
      { sessionId, agentId, displayName: 'proj', provider: 'claude-code', toolName: 'Bash', summary: 'Bash: npm   test\n', detail: 'x'.repeat(10_000) },
      { signal, onResolved: (outcome, d) => void outcomes.push(`${sessionId}:${outcome}:${d?.behavior ?? '-'}`) }
    )!

  const a = add('s1')
  assert.equal(broadcasts.length, 1)
  assert.equal(broadcasts[0].length, 1)
  const info = reg.list()[0]
  assert.equal(info.id, a)
  assert.equal(info.summary, 'Bash: npm test')
  assert.equal(info.detail.length, PERMISSION_DETAIL_MAX) // truncated to ~4 KB
  assert.equal(info.provider, 'claude-code')

  // decide: allow / deny, and the full pending list is broadcast on every change.
  assert.equal(reg.decide(a, { behavior: 'allow' }), 'allowed')
  assert.deepEqual(outcomes, ['s1:allowed:allow'])
  assert.deepEqual(broadcasts[1], [])
  const b = add('s1')
  assert.equal(reg.decide(b, { behavior: 'deny', message: 'no' }), 'denied')
  assert.equal(outcomes[1], 's1:denied:deny')

  // Answering twice, or an id that never existed.
  assert.equal(reg.decide(a, { behavior: 'allow' }), 'resolved-elsewhere')
  assert.equal(reg.decide('perm-nope', { behavior: 'allow' }), 'unknown-request')
  assert.equal(reg.decide(42, { behavior: 'allow' }), 'unknown-request')
  assert.throws(() => reg.decide(a, { behavior: 'maybe' }))
  assert.throws(() => reg.decide(a, null))

  // The client disconnects (answered in the terminal, hook timeout, interrupt).
  const gone = new AbortController()
  const c = add('s2', 's2', gone.signal)
  const n = broadcasts.length
  gone.abort()
  assert.equal(outcomes[2], 's2:resolved-elsewhere:-')
  assert.equal(broadcasts.length, n + 1)
  assert.deepEqual(reg.list(), [])
  assert.equal(reg.decide(c, { behavior: 'allow' }), 'resolved-elsewhere')
  assert.equal(outcomes.length, 3) // not resolved twice

  // Already disconnected when it arrives.
  const dead = new AbortController()
  dead.abort()
  assert.equal(reg.add({ sessionId: 's3', agentId: 's3', displayName: '', provider: 'claude-code', toolName: 'Bash', summary: '', detail: '' }, { signal: dead.signal, onResolved: (o) => void outcomes.push(`s3:${o}`) }), null)
  assert.equal(outcomes[3], 's3:resolved-elsewhere')

  // clearSession: all of a session, or only one agent's (a turn ended; a subagent may still wait).
  add('s4')
  add('s4', 's4:sub')
  add('s5')
  assert.equal(reg.count('s4'), 2)
  assert.equal(reg.clearSession('s4', 's4'), 1)
  assert.deepEqual(reg.list().map((p) => p.agentId), ['s4:sub', 's5'])
  assert.equal(reg.clearSession('s4'), 1)
  assert.equal(reg.clearSession('s4'), 0)
  assert.deepEqual(reg.list().map((p) => p.sessionId), ['s5'])

  assert.deepEqual(parsePermissionDecision({ behavior: 'allow', message: 'ignored', extra: 1 }), { behavior: 'allow' })
  assert.deepEqual(parsePermissionDecision({ behavior: 'deny' }), { behavior: 'deny' })
  assert.equal(parsePermissionDecision({ behavior: 'deny', message: 5 }), null)
  assert.equal(parsePermissionDecision('allow'), null)
  assert.deepEqual(permissionDecisionBody({ behavior: 'allow' }), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
  })
  assert.deepEqual(permissionDecisionBody({ behavior: 'deny', message: 'Not on my watch' }), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not on my watch' } }
  })
  // Deny without a message was never tried against Claude Code, so one is always sent.
  const noMsg = permissionDecisionBody({ behavior: 'deny' }) as { hookSpecificOutput: { decision: { message: string } } }
  assert.ok(noMsg.hookSpecificOutput.decision.message.length > 0)
})

// ---- ingest auth ------------------------------------------------------------------------------------

const fakeReq = (method: string, headers: Record<string, string>) => ({ method, headers }) as never

await t('ingest auth: a per-session token only authorises /hooks/claude-code for its session', () => {
  const tokens = new SessionTokens()
  const tokA = tokens.issue('s-a')
  const tokB = tokens.issue('s-b')
  assert.notEqual(tokA, tokB)
  assert.equal(tokA.length, 64)
  const GLOBAL = 'g'.repeat(64)
  const auth = (token: string) => authenticate(fakeReq('POST', { 'x-agent-office-token': token }), GLOBAL, tokens)

  assert.deepEqual(auth(GLOBAL), { kind: 'global' })
  assert.deepEqual(auth(tokA), { kind: 'session', sessionId: 's-a' })
  assert.deepEqual(auth(tokB), { kind: 'session', sessionId: 's-b' })
  assert.equal(auth('nope'), null)
  assert.equal(auth(''), null)
  assert.equal(auth(tokA.slice(0, 63)), null)
  assert.equal(authenticate(fakeReq('POST', {}), GLOBAL, tokens), null)
  assert.equal(authenticate(fakeReq('POST', { 'x-agent-office-token': '' }), '', tokens), null)

  const sa = { kind: 'session', sessionId: 's-a' } as const
  assert.ok(authorise(sa, fakeReq('POST', {}), '/hooks/claude-code'))
  assert.ok(authorise(sa, fakeReq('POST', { 'x-agent-office-session': 's-a' }), '/hooks/claude-code'))
  assert.ok(!authorise(sa, fakeReq('POST', { 'x-agent-office-session': 's-b' }), '/hooks/claude-code'))
  assert.ok(!authorise(sa, fakeReq('POST', {}), '/events'))
  assert.ok(!authorise(sa, fakeReq('GET', {}), '/hooks/claude-code'))
  assert.ok(!authorise(sa, fakeReq('GET', {}), '/health'))
  assert.ok(!authorise(sa, fakeReq('GET', {}), '/ws'))
  assert.ok(authorise({ kind: 'global' }, fakeReq('POST', {}), '/events'))

  // Re-issuing replaces the old token; revoking kills it.
  const tokA2 = tokens.issue('s-a')
  assert.equal(auth(tokA), null)
  assert.deepEqual(auth(tokA2), { kind: 'session', sessionId: 's-a' })
  tokens.revoke('s-a')
  assert.equal(auth(tokA2), null)
  assert.equal(tokens.size, 1)
  assert.ok(!JSON.stringify(tokens).includes(tokB))
})

// ---- orders -----------------------------------------------------------------------------------------

await t('order targets: all / provider:<id> / one session', () => {
  const known = [
    { id: 's-1', provider: 'claude-code' },
    { id: 's-2', provider: 'claude-code' },
    { id: 'cx-1', provider: 'codex' },
    'legacy-id'
  ]
  const on = { allowOrders: true, known }
  const targets = (target: string) => {
    const p = planOrder({ target, text: ' go ' }, on)
    return p.ok ? p.targets : p.result.failed[0].reason
  }
  assert.deepEqual(targets('all'), ['s-1', 's-2', 'cx-1', 'legacy-id'])
  assert.deepEqual(targets('provider:claude-code'), ['s-1', 's-2'])
  assert.deepEqual(targets('provider:codex'), ['cx-1'])
  assert.equal(targets('provider:antigravity'), REASON_NO_SESSIONS)
  assert.match(targets('provider:') as string, /no provider/)
  assert.deepEqual(targets('s-2'), ['s-2'])
  assert.deepEqual(targets('legacy-id'), ['legacy-id'])
  assert.equal(targets('s-9'), 'unknown session')
  // The gate applies to every kind of target.
  for (const target of ['all', 'provider:claude-code', 's-1']) {
    const p = planOrder({ target, text: 'go' }, { allowOrders: false, known })
    assert.ok(!p.ok)
    assert.equal(p.result.failed[0].reason, REASON_DISABLED)
  }
})

// ---- driver helpers ---------------------------------------------------------------------------------

await t('claude driver: settings file, args, env scrub, typed-prompt fallback', () => {
  const settings = buildClaudeSettings({ hooksUrl: 'http://127.0.0.1:4321/hooks/claude-code', hookScript: 'C:\\app\\hook\\claude-session-start.cjs' })
  const hooks = settings.hooks as Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>
  assert.deepEqual(Object.keys(hooks).sort(), [
    'Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd',
    'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'
  ])
  // SessionStart can't be an http hook.
  assert.deepEqual(hooks.SessionStart[0].hooks[0], { type: 'command', command: 'node "C:/app/hook/claude-session-start.cjs"', timeout: 10 })
  for (const [event, entries] of Object.entries(hooks)) {
    if (event === 'SessionStart') continue
    const h = entries[0].hooks[0]
    assert.equal(h.type, 'http')
    assert.equal(h.url, 'http://127.0.0.1:4321/hooks/claude-code')
    assert.deepEqual(h.headers, { 'X-Agent-Office-Token': '$AO_TOKEN', 'X-Agent-Office-Session': '$AO_SESSION' })
    assert.deepEqual(h.allowedEnvVars, ['AO_TOKEN', 'AO_SESSION'])
    // The user may take an hour over a permission; nothing else may stall Claude.
    assert.equal(h.timeout, event === 'PermissionRequest' ? 3600 : 5)
    assert.equal(entries[0].matcher, ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(event) ? '*' : undefined)
  }
  // No secret in the file: the token only travels in the env.
  assert.ok(!/[0-9a-f]{32}/.test(JSON.stringify(settings)))

  const start = { provider: 'claude-code' as const, cwd: 'C:\\w', permissionMode: 'acceptEdits' as const, title: 'w' }
  assert.deepEqual(claudeArgs(start, 'C:\\s\\x.json'), ['--settings', 'C:\\s\\x.json', '--permission-mode', 'acceptEdits'])
  assert.deepEqual(claudeArgs({ ...start, permissionMode: 'default', model: 'opus', resume: 'abc-123' }, 'f'), [
    '--settings', 'f', '--permission-mode', 'default', '--model', 'opus', '--resume', 'abc-123'
  ])

  const env = scrubbedEnv({
    PATH: 'C:\\bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', claude_pid: '4',
    AI_AGENT: 'claude-code', ANTHROPIC_API_KEY: 'k', UNSET: undefined
  })
  assert.deepEqual(env, { PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'k' })

  // Short single line: one bracketed paste, then Enter.
  assert.deepEqual(ptyPromptWrites('  Reply with ok  '), [
    { data: '\x1b[200~Reply with ok\x1b[201~', delayMs: 150 },
    { data: '\r', delayMs: 0 }
  ])
  // Multi-line: typed, Ctrl+J between lines, no paste markers (4+ lines would become a placeholder).
  const multi = ptyPromptWrites('line one\r\nline two\nline three\nline four')!
  const typed = multi.map((w) => w.data).join('')
  assert.equal(typed, 'line one\nline two\nline three\nline four\r')
  assert.ok(!typed.includes('\x1b'))
  // Long single line: typed in chunks, not pasted (a 900-char paste collapses).
  const long = ptyPromptWrites('y'.repeat(900))!
  assert.ok(long.length > 10)
  assert.ok(long.every((w) => w.data.length <= 64))
  assert.equal(long.map((w) => w.data).join(''), 'y'.repeat(900) + '\r')
  // Escape sequences can't be smuggled in, and mode-switching first characters are refused.
  assert.equal(sanitizeForTerminal('a\x1b[201~b\x00c\td\x9be'), 'a[201~bc de')
  assert.equal(ptyPromptWrites('hi\x1b[201~\rmore')!.map((w) => w.data).join(''), 'hi[201~\nmore\r')
  assert.equal(ptyPromptWrites('!rm -rf /'), null)
  assert.equal(ptyPromptWrites('/exit'), null)
  assert.equal(ptyPromptWrites('   '), null)

  // Settings files a crashed run left behind are swept at the next start; nothing else is touched.
  const stale = mkdtempSync(join(tmpdir(), 'agent-office-sweep-'))
  writeFileSync(join(stale, 's-dead.settings.json'), '{}')
  writeFileSync(join(stale, 'keep.txt'), 'x')
  sweepSessionFiles(stale)
  assert.deepEqual(readdirSync(stale), ['keep.txt'])
  sweepSessionFiles(join(stale, 'missing')) // no directory: no error
  rmSync(stale, { recursive: true, force: true })

  assert.ok(isInboxSocketPath('\\\\.\\pipe\\LOCAL\\cc-msg-a7cbf973297579f7a15e8d12500e7bd6', 'win32'))
  assert.ok(!isInboxSocketPath('C:\\Windows\\System32\\x', 'win32'))
  assert.ok(!isInboxSocketPath('\\\\evil-host\\share\\pipe', 'win32'))
  assert.ok(isInboxSocketPath('/tmp/cc-msg-1.sock', 'linux'))
  assert.ok(!isInboxSocketPath('relative.sock', 'linux'))
  assert.ok(!isInboxSocketPath(null, 'linux'))
})

// ---- the whole stack with a fake pty ----------------------------------------------------------------

class FakePty implements PtyHost {
  spawned = new Map<string, { opts: PtySpawnOptions; handlers: PtyHandlers }>()
  writes: { id: string; data: string }[] = []
  killed: string[] = []
  disposed: string[] = []
  failNext: string | null = null
  async spawn(id: string, opts: PtySpawnOptions, handlers: PtyHandlers): Promise<void> {
    if (this.failNext) {
      const message = this.failNext
      this.failNext = null
      throw new Error(message)
    }
    this.spawned.set(id, { opts, handlers })
  }
  write(id: string, data: string): void {
    this.writes.push({ id, data })
  }
  resize(): void {}
  kill(id: string): void {
    this.killed.push(id)
    setTimeout(() => this.exit(id, 1), 5)
  }
  dispose(id: string): void {
    this.disposed.push(id)
  }
  async snapshot(id: string): Promise<ScreenSnapshot | null> {
    return this.spawned.has(id) ? { data: 'SNAP', cols: 120, rows: 40, text: 'screen' } : null
  }
  detach(): void {}
  ack(): void {}
  exit(id: string, code: number | null): void {
    this.spawned.get(id)?.handlers.onExit(code)
  }
  title(id: string, title: string): void {
    this.spawned.get(id)?.handlers.onTitle?.(title)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

interface HttpResult {
  status: number
  body: unknown
}
/** POST/GET as Claude Code's http hooks do: JSON, no Origin, Host 127.0.0.1:<port>. */
function http(port: number, method: string, path: string, token: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const data = body === undefined ? '' : JSON.stringify(body)
  const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extra }
  if (token !== null) headers['x-agent-office-token'] = token
  const req = request({ host: '127.0.0.1', port, method, path, headers })
  const result = new Promise<HttpResult>((resolve, reject) => {
    req.on('response', (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (text += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
  })
  req.end(data)
  return { result, abort: () => req.destroy() }
}

await t('hosted session end to end: start, hooks, state, permission allow/deny/disconnect, orders, exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
  const sessionsDir = join(dir, 'sessions')
  const port = await freePort()
  const GLOBAL = 'G'.repeat(64)
  const tokens = new SessionTokens()
  const inbox = new SessionInbox()
  const pty = new FakePty()
  const world: AgentEvent[] = []
  const sink = { emit: (e: AgentEvent) => void world.push(e) }
  let sessionLists: SessionInfo[][] = []
  let permissionLists: PermissionRequestInfo[][] = []
  let allowOrders = false
  let serverUp = false
  const manager = new SessionManager({
    pty,
    sink,
    providers: [
      claudeProvider({
        sessionsDir,
        hookScript: 'C:\\app\\hook\\claude-session-start.cjs',
        inbox,
        ingest: { baseUrl: () => (serverUp ? `http://127.0.0.1:${port}` : null), tokens },
        findExecutable: () => process.execPath // any existing program that answers --version
      })
    ],
    allowOrders: () => allowOrders,
    worldTopLevel: () => [{ id: 'ext-claude', provider: 'claude-code' }],
    onSessionsChanged: (list) => void sessionLists.push(list),
    onPermissionsChanged: (list) => void permissionLists.push(list),
    onTerminalData: () => {}
  })

  // ---- providers and validation: the renderer never picks a command, args or env ----
  const providers = await manager.providers()
  assert.deepEqual(providers.map((p) => [p.id, p.available]), [['claude-code', true], ['codex', false], ['antigravity', false]])
  assert.equal(providers[1].reason, 'driver coming in phase B')
  assert.equal(providers[2].reason, 'driver coming in phase C')
  assert.ok(providers[0].version)
  const bad = async (req: unknown, re: RegExp) => assert.rejects(manager.start(req), re)
  await bad(null, /invalid/)
  await bad({ provider: 'bash', cwd: dir }, /unknown provider/)
  await bad({ provider: 'constructor', cwd: dir }, /unknown provider/)
  await bad({ provider: 'codex', cwd: dir }, /phase B/)
  await bad({ provider: 'claude-code', cwd: join(dir, 'missing') }, /does not exist/)
  await bad({ provider: 'claude-code', cwd: join(dir, 'x', '..', 'nope') }, /does not exist/)
  await bad({ provider: 'claude-code', cwd: 'relative\\path' }, /absolute/)
  await bad({ provider: 'claude-code', cwd: 42 }, /invalid folder/)
  await bad({ provider: 'claude-code', cwd: dir, permissionMode: 'bypassPermissions' }, /permission mode/)
  await bad({ provider: 'claude-code', cwd: dir, model: '--dangerously-skip-permissions' }, /invalid model/)
  await bad({ provider: 'claude-code', cwd: dir, model: 'opus --x' }, /invalid model/)
  await bad({ provider: 'claude-code', cwd: dir, resume: '../../x' }, /invalid session/)
  await bad({ provider: 'claude-code', cwd: dir, title: 7 }, /invalid title/)
  // The ingest server must be up, or the session could never report back.
  await bad({ provider: 'claude-code', cwd: dir }, /ingest server/)
  assert.equal(pty.spawned.size, 0)
  assert.deepEqual(manager.list(), [])

  const server = await startIngestServer({ port, getToken: () => GLOBAL, sink, sessionTokens: tokens, claudeHooks: createClaudeCodeHooksAdapter(manager) })
  serverUp = true

  // A pty that fails to spawn leaves nothing behind.
  pty.failNext = 'could not start the process: boom'
  await bad({ provider: 'claude-code', cwd: dir }, /boom/)
  assert.equal(tokens.size, 0)
  assert.deepEqual(readdirSync(sessionsDir), [])

  // ---- start ----
  const info = await manager.start({
    provider: 'claude-code',
    cwd: dir,
    model: 'claude-opus-5-5',
    // Extra fields a compromised renderer might send are ignored.
    command: 'cmd.exe', args: ['/c', 'calc'], env: { X: '1' }
  })
  const id = info.id
  assert.match(id, /^s-[0-9a-f]{12}$/)
  assert.equal(info.state, 'starting')
  assert.equal(info.provider, 'claude-code')
  assert.equal(info.permissionMode, 'default')
  assert.equal(info.cwd, dir)
  assert.ok(dir.endsWith(info.title)) // the folder name
  assert.equal(info.canReceiveOrders, false)
  const spawn = pty.spawned.get(id)!.opts
  const settingsFile = join(sessionsDir, `${id}.settings.json`)
  assert.equal(spawn.file, process.execPath)
  assert.deepEqual(spawn.args, ['--settings', settingsFile, '--permission-mode', 'default', '--model', 'claude-opus-5-5'])
  assert.equal(spawn.cwd, dir)
  assert.equal(spawn.env.AO_SESSION, id)
  assert.equal(spawn.env.AO_URL, `http://127.0.0.1:${port}/hooks/claude-code`)
  assert.equal(spawn.env.X, undefined)
  assert.ok(!Object.keys(spawn.env).some((k) => /^(CLAUDE|AI_AGENT)/i.test(k)))
  const token = spawn.env.AO_TOKEN
  assert.notEqual(token, GLOBAL)
  assert.ok(existsSync(settingsFile))
  assert.ok(!readFileSync(settingsFile, 'utf8').includes(token)) // no secret on disk
  // The manager is in the world from the start.
  assert.deepEqual(brief(world), [`${id}|-|idle|starting`])
  assert.equal(world[0].provider, 'claude-code')

  const hook = (name: string, extra: Record<string, unknown> = {}, tok = token) =>
    http(port, 'POST', '/hooks/claude-code', tok, common(name, extra), { 'x-agent-office-session': id })
  const state = () => manager.list()[0].state

  // ---- per-session token scoping, over real HTTP ----
  assert.equal((await http(port, 'GET', '/health', GLOBAL).result).status, 200)
  assert.equal((await http(port, 'GET', '/health', token).result).status, 403)
  assert.equal((await http(port, 'POST', '/events', token, world[0]).result).status, 403)
  assert.equal((await http(port, 'POST', '/hooks/claude-code', 'wrong-token-wrong-token', common('Stop')).result).status, 401)
  assert.equal((await http(port, 'POST', '/hooks/claude-code', null, common('Stop')).result).status, 401)
  assert.equal((await http(port, 'POST', '/hooks/claude-code', token, common('Stop'), { 'x-agent-office-session': 's-other' }).result).status, 403)
  assert.equal((await http(port, 'POST', '/hooks/claude-code', token, common('Stop'), { origin: 'http://evil.example' }).result).status, 403)
  // There is no HTTP route that approves a permission or sends a prompt.
  for (const path of ['/permissions', '/permissions/decide', '/orders', '/sessions', '/hooks/claude-code/decide']) {
    assert.equal((await http(port, 'POST', path, GLOBAL, {}).result).status, 404, path)
  }
  assert.equal(state(), 'starting')

  // ---- SessionStart command hook: ready, and the inbox endpoint is registered (memory only) ----
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\agent-office-test-${process.pid}-hosted` : join(dir, 'inbox.sock')
  const inboxGot: string[] = []
  const pipeServer: Server = await new Promise((resolve, reject) => {
    const s = createServer((sock) => {
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('data', (d) => (buf += d))
      sock.on('end', () => {
        inboxGot.push(buf)
        sock.end()
      })
    })
    s.once('error', reject)
    s.listen(pipe, () => resolve(s))
  })
  assert.deepEqual((await hook('SessionStart', { source: 'startup', model: 'claude-opus-5-5', _ao: { socket: pipe, token: 'inbox-secret-token' } }).result).body, {})
  assert.equal(state(), 'idle')
  assert.ok(inbox.has(id))
  await until(() => sessionLists.length > 0 && sessionLists[sessionLists.length - 1][0].state === 'idle', 'sessionsChanged idle')
  const last = sessionLists[sessionLists.length - 1][0]
  assert.equal(last.providerSessionId, SID)
  assert.equal(last.canReceiveOrders, true)
  assert.ok(!JSON.stringify(sessionLists).includes('inbox-secret-token'))
  assert.ok(!JSON.stringify(world).includes('inbox-secret-token'))

  // The same Claude session posting with the GLOBAL token (user-level hooks) is not duplicated.
  const worldBefore = world.length
  await http(port, 'POST', '/hooks/claude-code', GLOBAL, common('PreToolUse', { tool_name: 'Read', tool_input: {} })).result
  assert.equal(world.length, worldBefore)

  // ---- a turn with a permission request, allowed from the CEO office ----
  await hook('UserPromptSubmit', { prompt: 'Run node -e', permission_mode: 'default' }).result
  assert.equal(state(), 'busy')
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'node -e "console.log(1)"' }, tool_use_id: 'tu1' }).result
  assert.equal(world[world.length - 1].activity, 'exec')
  const held = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'node -e "console.log(1)"', description: 'print' } })
  await until(() => manager.listPermissions().length === 1, 'permission registered')
  const pending = manager.listPermissions()[0]
  assert.equal(pending.sessionId, id)
  assert.equal(pending.agentId, id)
  assert.equal(pending.toolName, 'Bash')
  assert.equal(pending.summary, 'Bash: node -e "console.log(1)"')
  assert.match(pending.detail, /"description": "print"/)
  assert.equal(pending.provider, 'claude-code')
  assert.equal(state(), 'waiting-permission')
  assert.equal(world[world.length - 1].activity, 'waiting')
  assert.deepEqual(permissionLists[permissionLists.length - 1].map((p) => p.id), [pending.id])
  // Still held: nothing came back yet.
  let answered = false
  void held.result.then(() => (answered = true))
  await sleep(50)
  assert.equal(answered, false)
  assert.throws(() => manager.decide(pending.id, { behavior: 'yes please' }), /invalid/)
  assert.equal(manager.decide('perm-unknown', { behavior: 'allow' }), 'unknown-request')
  assert.equal(manager.decide(pending.id, { behavior: 'allow' }), 'allowed')
  assert.deepEqual((await held.result).body, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
  })
  assert.equal(state(), 'busy')
  assert.deepEqual(manager.listPermissions(), [])
  assert.deepEqual(permissionLists[permissionLists.length - 1], [])
  assert.deepEqual(brief(world.slice(-1)), [`${id}|-|exec|node -e "console.log(1)"`]) // back to what it was doing
  assert.equal(manager.decide(pending.id, { behavior: 'allow' }), 'resolved-elsewhere')
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: { stdout: '1' } }).result

  // ---- denied, with the CEO's message ----
  const held2 = hook('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: 'C:\\x\\secret.txt', content: 'c'.repeat(9000) } })
  await until(() => manager.listPermissions().length === 1, 'second permission')
  assert.ok(manager.listPermissions()[0].detail.length <= PERMISSION_DETAIL_MAX)
  assert.equal(manager.decide(manager.listPermissions()[0].id, { behavior: 'deny', message: 'Not that file.' }), 'denied')
  assert.deepEqual((await held2.result).body, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not that file.' } }
  })

  // ---- Claude hangs up first (answered in the terminal / timeout / interrupt) ----
  const held3 = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'del x' } })
  held3.result.catch(() => {})
  await until(() => manager.listPermissions().length === 1, 'third permission')
  const third = manager.listPermissions()[0].id
  assert.equal(state(), 'waiting-permission')
  held3.abort()
  await until(() => manager.listPermissions().length === 0, 'card dismissed after disconnect')
  assert.deepEqual(permissionLists[permissionLists.length - 1], [])
  assert.equal(manager.decide(third, { behavior: 'allow' }), 'resolved-elsewhere')
  assert.equal(state(), 'busy')
  assert.notEqual(world[world.length - 1].activity, 'waiting')

  // ---- a subagent's tools don't make the session busy; Stop -> idle ----
  await hook('Stop', { stop_hook_active: false, background_tasks: [] }).result
  assert.equal(state(), 'idle')
  await hook('SubagentStart', { agent_id: SUB, agent_type: 'Explore' }).result
  await hook('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' }, agent_id: SUB, agent_type: 'Explore' }).result
  assert.equal(state(), 'idle')
  assert.deepEqual(brief(world.slice(-1)), [`${id}:${SUB}|${id}|read|x`])
  // A subagent's request survives the main turn's Stop.
  const held4 = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' }, agent_id: SUB, agent_type: 'Explore' })
  await until(() => manager.listPermissions().length === 1, 'subagent permission')
  assert.equal(manager.listPermissions()[0].agentId, subagentId(id, SUB))
  assert.equal(manager.listPermissions()[0].displayName, 'Explore')
  await hook('Stop', { background_tasks: [{ id: SUB, type: 'subagent', status: 'running' }] }).result
  assert.equal(manager.listPermissions().length, 1)
  manager.decide(manager.listPermissions()[0].id, { behavior: 'allow' })
  await held4.result
  await hook('Stop').result
  assert.equal(state(), 'idle')

  // ---- interrupt: Esc into the pty; no Stop arrives, the title's idle glyph settles the state ----
  await hook('UserPromptSubmit', { prompt: 'long task' }).result
  assert.equal(state(), 'busy')
  manager.interrupt(id)
  assert.deepEqual(pty.writes[pty.writes.length - 1], { id, data: '\x1b' })
  pty.title(id, '✳ Claude Code')
  await until(() => state() === 'idle', 'idle after interrupt (title hint)', TITLE_IDLE_DEBOUNCE_MS + 2000)

  // ---- orders: gated, then delivered over the inbox socket as a JSON line ----
  assert.deepEqual(await manager.sendOrder({ target: id, text: 'ship it' }), { delivered: [], failed: [{ agentId: id, reason: REASON_DISABLED }] })
  assert.equal(inboxGot.length, 0)
  allowOrders = true
  const order = manager.sendOrder({ target: 'provider:claude-code', text: 'Ship the release\nnotes today' })
  await until(() => inboxGot.length === 1, 'inbox delivery')
  const lines = inboxGot[0].split('\n')
  assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token: 'inbox-secret-token' })
  assert.deepEqual(JSON.parse(lines[1]), { type: 'user', message: { role: 'user', content: 'Ship the release\nnotes today' } })
  // Idle delivery is confirmed by the session's own UserPromptSubmit.
  await hook('UserPromptSubmit', { prompt: 'Ship the release\nnotes today' }).result
  assert.deepEqual(await order, {
    delivered: [id],
    failed: [{ agentId: 'ext-claude', reason: REASON_NOT_CONNECTED }] // an external session can't be reached
  })
  // Mid-turn: handed over (queued), no confirmation possible.
  assert.equal(state(), 'busy')
  assert.deepEqual(await manager.sendOrder({ target: id, text: 'also update the changelog' }), { delivered: [id], failed: [] })
  await until(() => inboxGot.length === 2, 'second inbox delivery')
  assert.deepEqual((await manager.sendOrder({ target: 'provider:codex', text: 'x' })).failed[0].reason, REASON_NO_SESSIONS)
  assert.deepEqual((await manager.sendOrder({ target: 'ext-claude', text: 'x' })).failed, [{ agentId: 'ext-claude', reason: REASON_NOT_CONNECTED }])
  assert.equal((await manager.sendOrder({ target: 's-nope', text: 'x' })).failed[0].reason, 'unknown session')
  await hook('Stop').result

  // ---- terminal: typing is not gated; input is validated ----
  allowOrders = false
  const snap = await manager.attach(id)
  assert.deepEqual(snap, { data: 'SNAP', cols: 120, rows: 40 })
  manager.write(id, 'ls\r')
  assert.deepEqual(pty.writes[pty.writes.length - 1], { id, data: 'ls\r' })
  const nWrites = pty.writes.length
  manager.write('s-nope', 'x')
  manager.write(id, 42)
  manager.write(id, 'x'.repeat(2 * 1024 * 1024))
  manager.resize(id, 'wide', 40)
  manager.resize(id, 100000, 40)
  manager.ack(id, -5)
  assert.equal(pty.writes.length, nWrites)
  await assert.rejects(manager.attach('s-nope'), /unknown session/)
  assert.throws(() => manager.interrupt({ id }), /unknown session/)

  // ---- exit: done for subagents and the manager, token revoked, settings file deleted ----
  const held5 = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'y' } })
  held5.result.catch(() => {})
  await until(() => manager.listPermissions().length === 1, 'permission before exit')
  const stopping = manager.stop(id) // not idle (waiting-permission): straight to killing the tree
  await stopping
  assert.deepEqual(pty.killed, [id])
  assert.equal(state(), 'exited')
  assert.equal(manager.list()[0].exitCode, 1)
  assert.equal(manager.list()[0].canReceiveOrders, false)
  assert.deepEqual(brief(world.slice(-2)), [`${id}:${SUB}|${id}|done|`, `${id}|-|done|`])
  assert.deepEqual(manager.listPermissions(), [])
  assert.deepEqual((await held5.result).body, {})
  assert.ok(!existsSync(settingsFile))
  assert.ok(!inbox.has(id))
  assert.equal(tokens.size, 0)
  assert.equal((await hook('Stop').result).status, 401) // the dead session's token is worthless
  assert.equal((await manager.sendOrder({ target: id, text: 'x' })).failed[0].reason, 'unknown session')
  // Stopping an exited session removes it from the list and frees its terminal.
  await manager.stop(id)
  assert.deepEqual(manager.list(), [])
  assert.deepEqual(pty.disposed, [id])
  await until(() => sessionLists.length > 0 && sessionLists[sessionLists.length - 1].length === 0, 'sessionsChanged []')

  // ---- typed fallback when the session has no inbox socket ----
  allowOrders = true
  const s2 = (await manager.start({ provider: 'claude-code', cwd: dir, title: '  My\tTeam\n' })).id
  assert.equal(manager.list()[0].title, 'My Team')
  const tok2 = pty.spawned.get(s2)!.opts.env.AO_TOKEN
  const hook2 = (name: string, extra: Record<string, unknown> = {}) => http(port, 'POST', '/hooks/claude-code', tok2, common(name, extra))
  assert.match((await manager.sendOrder({ target: s2, text: 'hi' })).failed[0].reason, /not ready/)
  await hook2('SessionStart', { _ao: { socket: null, token: null } }).result // no endpoint reported
  assert.ok(!inbox.has(s2))
  assert.equal(manager.list()[0].canReceiveOrders, true)
  const typedOrder = manager.sendOrder({ target: s2, text: 'Reply with ok' })
  await until(() => pty.writes.some((w) => w.id === s2 && w.data === '\r'), 'typed order')
  assert.deepEqual(pty.writes.filter((w) => w.id === s2).map((w) => w.data), ['\x1b[200~Reply with ok\x1b[201~', '\r'])
  await hook2('UserPromptSubmit', { prompt: 'Reply with ok' }).result
  assert.deepEqual(await typedOrder, { delivered: [s2], failed: [] })
  // Busy without a socket: nothing is typed (keystrokes could land in a dialog).
  const before = pty.writes.length
  assert.match((await manager.sendOrder({ target: s2, text: 'more' })).failed[0].reason, /busy/)
  assert.equal(pty.writes.length, before)
  await hook2('Stop').result
  assert.match((await manager.sendOrder({ target: s2, text: '!del *' })).failed[0].reason, /cannot be typed/)
  // The agent exits by itself.
  pty.exit(s2, 0)
  assert.equal(manager.list()[0].state, 'exited')
  assert.equal(manager.list()[0].exitCode, 0)
  assert.equal(world[world.length - 1].activity, 'done')

  manager.close()
  await assert.rejects(manager.start({ provider: 'claude-code', cwd: dir }), /shutting down/)
  await new Promise<void>((r) => pipeServer.close(() => r()))
  await server.close()
  rmSync(dir, { recursive: true, force: true })
  sessionLists = []
  permissionLists = []
})

// ---- the SessionStart command hook ------------------------------------------------------------------

await t('hook/claude-session-start.cjs: posts stdin + inbox endpoint, exits 0, prints nothing', async () => {
  const script = fileURLToPath(new URL('../hook/claude-session-start.cjs', import.meta.url))
  const run = (env: Record<string, string>, stdin: string) =>
    new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
      const t0 = Date.now()
      const child = spawn(process.execPath, [script], { env: { ...scrubbedEnv(process.env), ...env } })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('exit', (code) => resolve({ code, out, ms: Date.now() - t0 }))
      child.stdin.end(stdin)
    })
  const got: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = []
  const server = createHttpServer((req, res) => {
    let text = ''
    req.on('data', (d) => (text += d))
    req.on('end', () => {
      got.push({ headers: req.headers, body: JSON.parse(text) })
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as { port: number }
  const env = {
    AO_URL: `http://127.0.0.1:${port}/hooks/claude-code`,
    AO_TOKEN: 'session-token',
    AO_SESSION: 's-1',
    CLAUDE_CODE_MESSAGING_SOCKET: 'the-socket',
    CLAUDE_CODE_MESSAGING_TOKEN: 'the-inbox-token'
  }
  let r = await run(env, JSON.stringify(common('SessionStart', { source: 'startup', model: 'm' })))
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
  assert.equal(got.length, 1)
  assert.equal(got[0].headers['x-agent-office-token'], 'session-token')
  assert.equal(got[0].headers['x-agent-office-session'], 's-1')
  assert.deepEqual(got[0].body, { ...common('SessionStart', { source: 'startup', model: 'm' }), _ao: { socket: 'the-socket', token: 'the-inbox-token' } })
  // Unparseable stdin still reports the endpoint.
  r = await run(env, 'not json')
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
  assert.deepEqual(got[1].body, { hook_event_name: 'SessionStart', _ao: { socket: 'the-socket', token: 'the-inbox-token' } })
  // A dead app, no URL, or a URL that isn't the loopback app: exit 0 fast, send nothing.
  for (const AO_URL of ['http://127.0.0.1:1/hooks/claude-code', '', 'http://example.com/hooks/claude-code', 'https://127.0.0.1/x']) {
    r = await run({ ...env, AO_URL }, '{}')
    assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' }, AO_URL)
    assert.ok(r.ms < 3500, AO_URL)
  }
  assert.equal(got.length, 2)
  await new Promise<void>((res) => server.close(() => res()))
})

console.log(`\n${pass} hosted-session tests passed`)

await import('./ui.test.ts')
