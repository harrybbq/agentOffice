// The agent inspector, main-process side (shared/inspector.ts): the per-agent stats registry, the
// Claude subagent task correlation, the transcript tailer (token usage), the Codex and Antigravity
// token feeds against the fake servers, the watch throttle, and the stable activity details
// (shared/details.ts). Runs with `npm test` (chained from codex.test.ts; progress.test.ts follows).
//
// The transcript lines below are modelled on the SHAPE of a real Claude Code transcript (field
// names and nesting); every value in them is made up.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, Activity } from '../shared/events.ts'
import { DETAIL_BOARD, DETAIL_DELEGATING, DETAIL_PLANNING, DETAIL_QUESTION, DETAIL_SECRETS, detailKind, detailText, fileDetail, isSensitivePath } from '../shared/details.ts'
import { INSPECT_MAX_EVENTS, INSPECT_MAX_FILES, INSPECT_PREVIEW_CHARS, INSPECT_PUSH_MS, type AgentDetails, type TokenUsage } from '../shared/inspector.ts'
import type { PermissionRequestInfo, SessionInfo } from '../shared/sessions.ts'
import { subagentId } from '../shared/sessions.ts'
import { activityForTool, ClaudeHookMapper, createClaudeCodeHooksAdapter, planningSummary, toolDetail } from '../electron/adapters/claude-code-hooks.ts'
import { ClaudeHookObserver, SubagentTasks } from '../electron/adapters/claudeInspect.ts'
import { AgentStats, cleanUsage, InspectorWatch, STATS_DONE_TTL_MS, type AgentFact } from '../electron/agentStats.ts'
import { Board, DEFAULT_BOARD_SETTINGS } from '../electron/board.ts'
import { agyProvider } from '../electron/drivers/agy.ts'
import { createAgyHooksAdapter } from '../electron/drivers/agyHookBridge.ts'
import { AgyTokens, agyWorldActivity, parseAgyLine } from '../electron/drivers/agyStream.ts'
import { claudeProvider } from '../electron/drivers/claude.ts'
import { codexProvider } from '../electron/drivers/codex.ts'
import type { CodexSpawnSpec } from '../electron/drivers/codexServer.ts'
import { codexTokenUsage, planActivity, worldActivityForItem } from '../electron/drivers/codexWorld.ts'
import type { PtyHandlers, PtyHost, ScreenSnapshot } from '../electron/drivers/types.ts'
import { SessionTokens } from '../electron/ingest/auth.ts'
import { startIngestServer } from '../electron/ingest/server.ts'
import type { PtySpawnOptions } from '../electron/ptyProtocol.ts'
import { SessionInbox } from '../electron/sessionInbox.ts'
import { SessionManager } from '../electron/sessions.ts'
import {
  assistantUsage,
  ClaudeTranscripts,
  subagentTranscriptPath,
  TRANSCRIPT_CATCHUP_MS,
  TRANSCRIPT_DEBOUNCE_MS,
  TRANSCRIPT_MAX_LINE_BYTES,
  transcriptPath,
  TranscriptTail
} from '../electron/transcriptUsage.ts'

let pass = 0
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn()
  pass++
  console.log('ok -', name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(cond: () => T, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = cond()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

/** A clock and a scheduler that only move when the test says so. */
function fakeTime(start = 1_000_000) {
  let now = start
  let timers: { at: number; fn: () => void; seq: number }[] = []
  let seq = 0
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: now + ms, fn, seq: seq++ }
    timers.push(timer)
    return () => {
      timers = timers.filter((x) => x !== timer)
    }
  }
  const advance = (ms: number): void => {
    const end = now + ms
    for (;;) {
      const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!next) break
      timers = timers.filter((x) => x !== next)
      now = Math.max(now, next.at)
      next.fn()
    }
    now = end
  }
  return { now: () => now, schedule, advance, pending: () => timers.length }
}

const SEC = 1000
const MIN = 60 * SEC

// ---- the stats registry ------------------------------------------------------------------------------

function registry(opts: { maxAgents?: number } = {}) {
  const time = fakeTime()
  const changes: string[] = []
  const stats = new AgentStats({ now: time.now, onChange: (id) => void changes.push(id), ...opts })
  const ev = (agentId: string, activity: Activity, detail = '', parentId: string | null = null, displayName = agentId): void =>
    stats.event({ agentId, parentId, provider: 'claude-code', displayName, activity, detail, ts: 0 })
  return { time, stats, ev, changes }
}

await t('stats: activity, counts of starts, the recent log (identical repeats collapsed), and the working clock', () => {
  const { time, stats, ev } = registry()
  assert.equal(stats.details('M'), null)
  ev('M', 'idle')
  const t0 = time.now()
  time.advance(5 * SEC)
  ev('M', 'read', 'src/a.ts')
  time.advance(10 * SEC)
  ev('M', 'read', 'src/a.ts') // the same thing again (a rename, a replay): not a start
  time.advance(10 * SEC)
  ev('M', 'read', 'src/b.ts') // the same activity on something else: a start
  time.advance(5 * SEC)
  ev('M', 'write', 'src/b.ts')
  time.advance(20 * SEC)
  ev('M', 'idle')
  time.advance(MIN)

  let d = stats.details('M')!
  assert.equal(d.role, 'manager')
  assert.equal(d.state, 'idle')
  assert.equal(d.activity, 'idle')
  assert.equal(d.startedAt, t0)
  assert.equal(d.lastActiveAt, t0 + 50 * SEC)
  // 5 s idle, then 45 s of reading and writing, then idle again: only the 45 s count.
  assert.equal(d.activeMs, 45 * SEC)
  assert.deepEqual(d.counts, { idle: 2, read: 2, write: 1 })
  assert.deepEqual(
    d.recent.map((r) => `${r.activity}|${r.detail}|${(r.ts - t0) / SEC}`),
    ['idle||50', 'write|src/b.ts|30', 'read|src/b.ts|25', 'read|src/a.ts|5', 'idle||0']
  )
  assert.equal(d.turns, undefined) // nobody reported turns for this (observed) agent
  assert.equal(d.tokens, undefined)
  assert.equal(d.sessionId, undefined)
  assert.deepEqual(d.workers, [])
  assert.deepEqual(d.files, [])

  // While it works, activeMs runs up to now. Waiting on the user is working time too.
  ev('M', 'exec', 'npm test')
  time.advance(7 * SEC)
  assert.equal(stats.details('M')!.activeMs, 52 * SEC)
  assert.equal(stats.details('M')!.state, 'working')
  ev('M', 'waiting', 'run the tests')
  time.advance(3 * SEC)
  d = stats.details('M')!
  assert.equal(d.activeMs, 55 * SEC)
  assert.equal(d.state, 'waiting')
  // Allowed: it carries on with the same command. That is not another start of it.
  ev('M', 'exec', 'npm test')
  assert.deepEqual([stats.details('M')!.counts.exec, stats.details('M')!.counts.waiting], [1, 1])
  assert.deepEqual(stats.details('M')!.recent.slice(0, 3).map((r) => r.activity), ['exec', 'waiting', 'exec'])

  // A turn that is thinking shows no activity: the `busy` fact keeps the clock running through `idle`.
  ev('M', 'idle')
  stats.fact({ kind: 'busy', agentId: 'M', busy: true })
  time.advance(4 * SEC)
  assert.equal(stats.details('M')!.activeMs, 59 * SEC)
  assert.equal(stats.details('M')!.state, 'working')
  stats.fact({ kind: 'busy', agentId: 'M', busy: false })
  time.advance(30 * SEC)
  assert.equal(stats.details('M')!.activeMs, 59 * SEC)

  // done stops the clock for good.
  ev('M', 'read', 'x')
  time.advance(SEC)
  ev('M', 'done')
  time.advance(MIN)
  d = stats.details('M')!
  assert.equal(d.activeMs, 60 * SEC)
  assert.equal(d.state, 'done')
  assert.equal(d.counts.done, 1)
})

await t('stats: caps (recent, files, preview length), files newest first, turns and tokens', () => {
  const { time, stats, ev } = registry()
  for (let i = 0; i < INSPECT_MAX_EVENTS + 12; i++) {
    ev('M', 'read', `file-${i}.ts`)
    time.advance(10)
  }
  let d = stats.details('M')!
  assert.equal(d.recent.length, INSPECT_MAX_EVENTS)
  assert.equal(d.recent[0].detail, `file-${INSPECT_MAX_EVENTS + 11}.ts`)
  assert.equal(d.counts.read, INSPECT_MAX_EVENTS + 12)
  // One line, capped.
  ev('M', 'exec', `echo ${'x'.repeat(400)}\nsecond line`)
  d = stats.details('M')!
  assert.ok(d.detail.length <= INSPECT_PREVIEW_CHARS && d.detail.endsWith('…') && !d.detail.includes('\n'))
  assert.equal(d.recent[0].detail, d.detail)

  stats.fact({ kind: 'file', agentId: 'M', path: 'src/new.ts', change: 'create' })
  time.advance(10)
  stats.fact({ kind: 'file', agentId: 'M', path: 'src/old.ts', change: 'edit' })
  time.advance(10)
  stats.fact({ kind: 'file', agentId: 'M', path: 'src/new.ts', change: 'edit' }) // created, then edited: still a new file
  d = stats.details('M')!
  assert.deepEqual(d.files.map((f) => `${f.path}|${f.kind}`), ['src/new.ts|create', 'src/old.ts|edit'])
  assert.ok(d.files[0].ts > d.files[1].ts)
  for (let i = 0; i < INSPECT_MAX_FILES + 5; i++) stats.fact({ kind: 'file', agentId: 'M', path: `f${i}.ts`, change: 'edit' })
  d = stats.details('M')!
  assert.equal(d.files.length, INSPECT_MAX_FILES)
  assert.equal(d.files[0].path, `f${INSPECT_MAX_FILES + 4}.ts`)

  stats.fact({ kind: 'turn', agentId: 'M' })
  stats.fact({ kind: 'turn', agentId: 'M' })
  stats.fact({ kind: 'tokens', agentId: 'M', usage: { input: 10.7, output: -5, cached: 3, total: 0, contextUsed: 13, contextWindow: 0 }, model: 'claude-haiku-4-5' })
  d = stats.details('M')!
  assert.equal(d.turns, 2)
  assert.deepEqual(d.tokens, { input: 10, output: 0, cached: 3, total: 13, contextUsed: 13 })
  assert.equal(d.model, 'claude-haiku-4-5')
  assert.deepEqual(cleanUsage({ input: 1, output: 2, total: 9 } as TokenUsage), { input: 1, output: 2, total: 9 })

  // A fact for an agent the world has not shown yet is kept, and applies once it appears.
  stats.fact({ kind: 'worker', agentId: 'M:w9', agentType: 'Explore', task: 'Look around' })
  assert.equal(stats.details('M:w9'), null)
  ev('M:w9', 'idle', 'Explore', 'M', 'Explore')
  assert.equal(stats.details('M:w9')!.task, 'Look around')
  // Garbage in: ignored.
  stats.fact({ kind: 'turn', agentId: '' })
  stats.event({ agentId: '', parentId: null, provider: 'x', displayName: 'x', activity: 'idle', detail: '', ts: 0 })
})

await t('stats: a manager lists its workers (live and recently finished); finished agents go after 10 minutes', () => {
  const { time, stats, ev, changes } = registry()
  ev('M', 'idle', '', null, 'Sonnet 5.5')
  time.advance(SEC)
  ev('M:w1', 'idle', 'Explore', 'M', 'Explore')
  stats.fact({ kind: 'worker', agentId: 'M:w1', agentType: 'Explore', task: 'List the files' })
  time.advance(SEC)
  ev('M:w2', 'idle', 'general-purpose', 'M', 'general-purpose')
  stats.fact({ kind: 'worker', agentId: 'M:w2', agentType: 'general-purpose' })
  ev('OTHER', 'idle') // another team: not listed
  ev('OTHER:w', 'read', 'x', 'OTHER')
  time.advance(SEC)
  changes.length = 0
  ev('M:w1', 'read', 'README.md', 'M', 'Explore')
  // The manager's panel shows the worker's activity: both are told.
  assert.deepEqual(changes, ['M:w1', 'M'])
  time.advance(4 * SEC)
  ev('M:w1', 'done', '', 'M', 'Explore')

  const d = stats.details('M')!
  assert.deepEqual(
    d.workers!.map((w) => [w.agentId, w.displayName, w.agentType, w.activity, w.done, w.task]),
    [
      ['M:w2', 'general-purpose', 'general-purpose', 'idle', false, undefined],
      ['M:w1', 'Explore', 'Explore', 'done', true, 'List the files']
    ]
  )
  const w = stats.details('M:w1')!
  assert.equal(w.role, 'worker')
  assert.equal(w.parentId, 'M')
  assert.equal(w.workers, undefined)
  assert.equal(w.task, 'List the files')
  assert.equal(w.agentType, 'Explore')
  assert.equal(w.state, 'done')
  assert.equal(w.activeMs, 4 * SEC)

  // Ten minutes after it finished the worker is dropped; the live one stays.
  time.advance(STATS_DONE_TTL_MS)
  assert.equal(stats.details('M')!.workers!.length, 2)
  time.advance(1)
  assert.deepEqual(stats.details('M')!.workers!.map((x) => x.agentId), ['M:w2'])
  assert.equal(stats.details('M:w1'), null)

  // A finished manager is kept as long, then gone; the same id coming back before that revives it.
  ev('M', 'done')
  time.advance(STATS_DONE_TTL_MS - 1)
  assert.equal(stats.details('M')!.state, 'done')
  ev('M', 'idle')
  time.advance(STATS_DONE_TTL_MS + 1)
  assert.equal(stats.details('M')!.state, 'idle')
  ev('M', 'done')
  time.advance(STATS_DONE_TTL_MS + 1)
  assert.equal(stats.details('M'), null)
})

await t('stats: the registry is capped; finished agents are dropped first, then the longest inactive', () => {
  const { time, stats, ev } = registry({ maxAgents: 5 })
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    ev(id, 'read', 'x')
    time.advance(SEC)
  }
  ev('c', 'done')
  time.advance(SEC)
  ev('a', 'read', 'y') // a is active again: b is now the longest inactive
  time.advance(SEC)
  ev('f', 'idle')
  assert.equal(stats.size, 5)
  assert.equal(stats.has('c'), false) // the finished one went first
  ev('g', 'idle')
  assert.equal(stats.size, 5)
  assert.equal(stats.has('b'), false)
  assert.deepEqual(['a', 'd', 'e', 'f', 'g'].map((id) => stats.has(id)), [true, true, true, true, true])
})

await t('stats: hosted sessions add state, model, folder, the task (prompt or newer board claim) and what it waits on', () => {
  const { time, stats, ev } = registry()
  const session: SessionInfo = {
    id: 's-1', provider: 'claude-code', cwd: 'C:\\work\\proj', title: 'Sonnet 5.5', state: 'busy', startedAt: 500, permissionMode: 'default',
    model: 'claude-sonnet-5-5', surface: 'terminal', canReceiveOrders: true, lastPrompt: 'the saved preview'
  }
  let pending: PermissionRequestInfo[] = []
  let claim: { task: string; ts: number } | undefined
  const sources = { session: (id: string) => (id === 's-1' ? session : undefined), pending: () => pending, claim: () => claim }

  // A sleeping or just-started session with no event yet still answers.
  let d = stats.details('s-1', sources)!
  assert.deepEqual([d.role, d.state, d.activity, d.displayName, d.provider, d.model, d.cwd, d.sessionId, d.startedAt, d.turns, d.task], [
    'manager', 'busy', 'idle', 'Sonnet 5.5', 'claude-code', 'claude-sonnet-5-5', 'C:\\work\\proj', 's-1', 500, 0, 'the saved preview'
  ])
  assert.equal(stats.details('nope', sources), null)

  ev('s-1', 'idle', '', null, 'Sonnet 5.5')
  stats.fact({ kind: 'task', agentId: 's-1', text: 'Fix the\n  title   of the page' })
  assert.equal(stats.details('s-1', sources)!.task, 'Fix the title of the page')
  // A board claim made after the prompt says more exactly what the team is doing.
  time.advance(SEC)
  claim = { task: 'page title', ts: time.now() }
  assert.equal(stats.details('s-1', sources)!.task, 'page title')
  time.advance(SEC)
  stats.fact({ kind: 'task', agentId: 's-1', text: 'Now add a footer' })
  assert.equal(stats.details('s-1', sources)!.task, 'Now add a footer')

  // Its worker belongs to the same hosted session and works in the same folder.
  ev('s-1:w', 'read', 'a.ts', 's-1', 'Explore')
  const w = stats.details('s-1:w', sources)!
  assert.deepEqual([w.sessionId, w.cwd, w.parentId, w.role, w.state, w.turns], ['s-1', 'C:\\work\\proj', 's-1', 'worker', 'working', undefined])

  // Blocked on the user: the oldest pending request of that agent.
  const req = (id: string, agentId: string, question: string, createdAt: number): PermissionRequestInfo => ({
    id, sessionId: 's-1', agentId, displayName: 'x', provider: 'claude-code', toolName: 'Bash', summary: 's', detail: 'd', question, risk: 'caution', createdAt
  })
  pending = [req('p1', 's-1:w', 'Explore wants to delete files (`rm x`).', 900), req('p2', 's-1', 'Sonnet 5.5 wants to install software packages (`npm i`).', 950), req('p3', 's-1', 'later', 990)]
  d = stats.details('s-1', sources)!
  assert.deepEqual(d.waitingOn, { question: 'Sonnet 5.5 wants to install software packages (`npm i`).', risk: 'caution', since: 950 })
  assert.deepEqual(stats.details('s-1:w', sources)!.waitingOn, { question: 'Explore wants to delete files (`rm x`).', risk: 'caution', since: 900 })
  pending = []
  assert.equal(stats.details('s-1', sources)!.waitingOn, undefined)
  // A question the agent asked (not a permission request) is what it waits on, too.
  ev('s-1', 'waiting', `${DETAIL_QUESTION}Which colour?`, null, 'Sonnet 5.5')
  const asked = time.now()
  time.advance(SEC)
  assert.deepEqual(stats.details('s-1', sources)!.waitingOn, { question: 'Which colour?', risk: 'normal', since: asked })
})

// ---- watching one agent --------------------------------------------------------------------------------

await t('watch: one watch per window, pushes at most once per interval and only when something changed', () => {
  const time = fakeTime()
  const state: Record<string, AgentDetails | null> = {}
  const mk = (agentId: string, detail: string, activeMs = 0): AgentDetails => ({
    agentId, role: 'manager', displayName: agentId, provider: 'p', state: 'idle', activity: 'idle', detail, startedAt: 1, lastActiveAt: 1, activeMs, counts: {}, files: [], recent: []
  })
  const sent: string[] = []
  const watch = new InspectorWatch<number>({
    details: (id) => state[id] ?? null,
    send: (key, d) => void sent.push(`${key}|${d.agentId}|${d.detail}|${Math.round((time.now() - 1_000_000) / 100) / 10}`),
    now: time.now,
    schedule: time.schedule
  })
  state.A = mk('A', 'one')
  assert.deepEqual(watch.watch(1, 'A'), state.A)
  assert.equal(watch.watch(1, 'unknown'), null) // a new watch replaces the old one: still one
  assert.equal(watch.size, 1)
  assert.equal(watch.watching(1), 'unknown')
  assert.equal(watch.watch(1, 'A')?.detail, 'one')

  // Nothing changed: nothing is pushed, however long it takes.
  time.advance(5 * INSPECT_PUSH_MS)
  assert.deepEqual(sent, [])

  // A burst of changes right after a push window opened: one push, with the latest, at once (but never synchronously).
  state.A = mk('A', 'two')
  watch.poke()
  state.A = mk('A', 'three')
  watch.poke()
  assert.deepEqual(sent, [])
  time.advance(0)
  assert.deepEqual(sent, ['1|A|three|5'])

  // Changes inside the interval wait for its end; only the last state is sent.
  time.advance(200)
  state.A = mk('A', 'four')
  watch.poke()
  time.advance(300)
  state.A = mk('A', 'five')
  watch.poke()
  time.advance(499)
  assert.equal(sent.length, 1)
  time.advance(1)
  assert.deepEqual(sent.slice(1), ['1|A|five|6'])

  // A change nobody poked about (a session's state, a pending question) is found by the next look.
  state.A = mk('A', 'six')
  time.advance(INSPECT_PUSH_MS)
  assert.deepEqual(sent.slice(2), ['1|A|six|7'])

  // A working agent's time moves: about one push per interval, never more.
  let ms = 0
  const before = sent.length
  const ticking = new InspectorWatch<number>({ details: () => mk('B', 'busy', (ms += 1)), send: () => void sent.push('tick'), now: time.now, schedule: time.schedule })
  ticking.watch(7, 'B')
  for (let i = 0; i < 50; i++) {
    ticking.poke()
    time.advance(100)
  }
  assert.equal(sent.length - before, 5)
  ticking.clear()

  // Two windows are independent; unwatch stops one; an agent that is gone is simply not pushed.
  const at = sent.length
  watch.watch(2, 'A')
  state.A = mk('A', 'seven')
  watch.poke()
  time.advance(INSPECT_PUSH_MS)
  assert.deepEqual(sent.slice(at).map((s) => s.split('|').slice(0, 3).join('|')).sort(), ['1|A|seven', '2|A|seven'])
  watch.unwatch(1)
  state.A = mk('A', 'eight')
  time.advance(INSPECT_PUSH_MS)
  assert.deepEqual(sent.slice(at + 2).map((s) => s.split('|').slice(0, 3).join('|')), ['2|A|eight'])
  state.A = null
  watch.poke()
  time.advance(3 * INSPECT_PUSH_MS)
  assert.equal(sent.length, at + 3)
  state.A = mk('A', 'back')
  time.advance(INSPECT_PUSH_MS)
  assert.equal(sent.length, at + 4)
  watch.clear()
  assert.equal(watch.size, 0)
  state.A = mk('A', 'nobody listens')
  watch.poke()
  time.advance(10 * INSPECT_PUSH_MS)
  assert.equal(sent.length, at + 4)
  assert.equal(time.pending(), 0) // no timer is left behind
})

// ---- Claude: a subagent's task comes from the Agent call that started it -------------------------------

// Payload shapes: docs/spikes-phase-a.md (spike 2, "What arrived" and "Subagents").
const SID = '0b6f4f0e-1111-4222-8333-444455556666'
const SUB = 'a7dbf87f777914f47'
const SUB2 = 'b81c0aa2e55d3c9f1'

await t('claude: Agent tool calls are matched to the subagents they start (in order, by type; PostToolUse confirms)', () => {
  const tasks = new SubagentTasks()
  // One call, one subagent.
  tasks.requested('toolu_01', { description: 'List the files', subagent_type: 'Explore', prompt: 'List every file in this folder and report back.' })
  assert.deepEqual(tasks.started(SUB, 'Explore'), { task: 'List the files', agentType: 'Explore' })
  assert.deepEqual(tasks.confirmed('toolu_01', SUB), []) // the guess was right
  assert.equal(tasks.open, 0)

  // Two calls in one message, of different types: each subagent gets the call of its type, whatever the order they start in.
  tasks.requested('toolu_02', { description: 'Find the tests', subagent_type: 'Explore', prompt: 'x' })
  tasks.requested('toolu_03', { description: 'Write the summary', subagent_type: 'general-purpose', prompt: 'y' })
  assert.equal(tasks.started('g1', 'general-purpose')?.task, 'Write the summary')
  assert.equal(tasks.started('e1', 'Explore')?.task, 'Find the tests')
  assert.deepEqual([tasks.confirmed('toolu_02', 'e1'), tasks.confirmed('toolu_03', 'g1')], [[], []])

  // Two of the same type that start the other way round: PostToolUse (`tool_response.agentId`) puts it right.
  tasks.requested('toolu_04', { description: 'First job', subagent_type: 'Explore' })
  tasks.requested('toolu_05', { description: 'Second job', subagent_type: 'Explore' })
  assert.equal(tasks.started('x2', 'Explore')?.task, 'First job') // in order: a guess
  assert.equal(tasks.started('x1', 'Explore')?.task, 'Second job')
  assert.deepEqual(tasks.confirmed('toolu_04', 'x1'), [
    { agent: 'x1', task: 'First job', agentType: 'Explore' },
    { agent: 'x2', task: 'Second job', agentType: 'Explore' }
  ])
  assert.deepEqual(tasks.confirmed('toolu_05', 'x2'), [])
  assert.equal(tasks.open, 0)

  // No description: a preview of the prompt (one line, capped, nothing token-shaped). No type on the call: it fits any.
  tasks.requested('toolu_06', { prompt: `Read the config.\nUse api_key=sk-abcdefghijklmnop1234 ${'and more '.repeat(40)}` })
  const info = tasks.started('p1', 'general-purpose')!
  assert.ok(info.task.startsWith('Read the config. Use api_key=[hidden]') && info.task.length <= INSPECT_PREVIEW_CHARS && !info.task.includes('sk-abc'))
  // A subagent nobody asked for (no open call): no task. A failed call is forgotten. The list is capped.
  assert.equal(tasks.started('lonely', 'Explore'), null)
  tasks.requested('toolu_07', { description: 'Never starts', subagent_type: 'Explore' })
  tasks.dropped('toolu_07')
  assert.equal(tasks.started('late', 'Explore'), null)
  for (let i = 0; i < 80; i++) tasks.requested(`toolu_cap_${i}`, { description: `job ${i}` })
  assert.ok(tasks.open <= 51)
})

await t('claude: the hook observer reports turns, workers with their task, changed files, and when to read a transcript', () => {
  const root = 's-app1'
  const mapper = new ClaudeHookMapper({ rootId: root, displayName: 'Sonnet 5.5', holdWaiting: true, endsWithProcess: true })
  const stats = new AgentStats()
  const facts: AgentFact[] = []
  const pokes: string[] = []
  const transcript = `C:\\Users\\me\\.claude\\projects\\C--work-my-project\\${SID}.jsonl`
  const observer = new ClaudeHookObserver({
    rootId: root,
    emit: (f) => {
      facts.push(f)
      stats.fact(f)
    },
    transcripts: { poke: (agentId, path, main) => void pokes.push(`${agentId}|${String(path)}|${main}`) },
    cwd: 'C:\\work\\my-project'
  })
  const hook = (name: string, extra: Record<string, unknown> = {}): void => {
    const body = { session_id: SID, transcript_path: transcript, cwd: 'C:\\work\\my-project', scratchpad_dir: 'C:\\tmp\\s', prompt_id: 'p1', hook_event_name: name, ...extra }
    const mapped = mapper.handle(body)
    for (const e of mapped.events) stats.event(e)
    observer.observe(body, mapped)
  }
  const sub = { agent_id: SUB, agent_type: 'Explore' }
  const worker = subagentId(root, SUB)

  hook('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5' })
  hook('UserPromptSubmit', { prompt: 'Find out what is in here', permission_mode: 'default' })
  hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_A', tool_input: { description: 'List the files', subagent_type: 'Explore', prompt: 'List the files here and hand back the names.' } })
  hook('SubagentStart', sub)
  hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_A', tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: SUB } })
  hook('Stop', { background_tasks: [{ id: SUB, type: 'subagent', status: 'running' }] })
  hook('PreToolUse', { ...sub, tool_name: 'PowerShell', tool_use_id: 'toolu_B', tool_input: { command: 'Get-ChildItem' } })
  hook('PostToolUse', { ...sub, tool_name: 'PowerShell', tool_use_id: 'toolu_B', tool_input: { command: 'Get-ChildItem' }, tool_response: {} })
  hook('PreToolUse', { ...sub, tool_name: 'Write', tool_use_id: 'toolu_C', tool_input: { file_path: 'C:\\work\\my-project\\notes\\files.md', content: 'x' } })
  hook('PostToolUse', { ...sub, tool_name: 'Write', tool_use_id: 'toolu_C', tool_input: { file_path: 'C:\\work\\my-project\\notes\\files.md', content: 'x' }, tool_response: { type: 'create' } })
  // The hand-back and the task notification are not prompts of the user: no turn.
  hook('UserPromptSubmit', { prompt: `<agent-message from="${SUB}">\n[Subagent hand-back] done` })
  hook('SubagentStop', { ...sub, agent_transcript_path: `C:\\Users\\me\\.claude\\projects\\C--work-my-project\\${SID}\\subagents\\agent-${SUB}.jsonl` })
  hook('SubagentStop', { agent_id: 'internal1', agent_type: '' }) // the prompt-suggestion agent: ignored
  hook('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>${SUB}</task-id>` })
  hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_D', tool_input: { file_path: 'C:\\work\\my-project\\README.md' } })
  hook('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_D', tool_input: { file_path: 'C:\\work\\my-project\\README.md' }, tool_response: { type: 'update' } })
  hook('PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 'toolu_E', tool_input: { file_path: 'C:\\work\\my-project\\broken.md' } })
  hook('PostToolUse', { tool_name: 'Write', tool_use_id: 'toolu_F', tool_input: { file_path: 'D:\\elsewhere\\out.txt' }, tool_response: { type: 'create' } })
  hook('Stop', { background_tasks: [] })

  assert.deepEqual(
    facts.map((f) => (f.kind === 'worker' ? `worker ${f.agentId} ${f.agentType} "${f.task}"` : f.kind === 'file' ? `file ${f.agentId} ${f.path} ${f.change}` : f.kind === 'busy' ? `busy ${f.agentId}` : `${f.kind} ${f.agentId}`)),
    [
      `turn ${root}`,
      `worker ${worker} Explore "List the files"`,
      `busy ${worker}`,
      `file ${worker} notes/files.md create`,
      `file ${root} README.md edit`,
      `file ${root} D:\\elsewhere\\out.txt create` // outside the folder: as it is
    ]
  )
  const derived = `C:\\Users\\me\\.claude\\projects\\C--work-my-project\\${SID}\\subagents\\agent-${SUB}.jsonl`
  assert.deepEqual(pokes, [
    `${root}|${transcript}|true`, //     PostToolUse Agent
    `${root}|${transcript}|true`, //     Stop
    `${worker}|${derived}|false`, //     the worker's PostToolUse: its own file next to the main transcript
    `${worker}|${derived}|false`,
    `${worker}|${derived}|false`, //     SubagentStop names the file itself
    `${root}|${transcript}|true`, //     PostToolUse Edit
    `${root}|${transcript}|true`, //     the failed edit: tokens were still spent
    `${root}|${transcript}|true`,
    `${root}|${transcript}|true` //      Stop
  ])

  const d = stats.details(root)!
  assert.equal(d.turns, 1)
  assert.deepEqual(d.workers!.map((w) => [w.agentId, w.agentType, w.task, w.done]), [[worker, 'Explore', 'List the files', true]])
  assert.deepEqual(d.files.map((f) => f.path), ['D:\\elsewhere\\out.txt', 'README.md'])
  assert.deepEqual(d.counts, { idle: 3, exec: 1, write: 1 })
  const w = stats.details(worker)!
  assert.deepEqual([w.task, w.agentType, w.role, w.parentId, w.state], ['List the files', 'Explore', 'worker', root, 'done'])
  assert.deepEqual(w.files.map((f) => `${f.path}|${f.kind}`), ['notes/files.md|create'])
  assert.deepEqual(w.counts, { idle: 1, exec: 1, write: 1, done: 1 })

  // An observer that throws on a strange payload never gets in the way of a hook.
  observer.observe({ tool_name: 12, tool_input: 'x', agent_id: {} } as never, { kind: 'post-tool', agentId: root, displayName: 'x', events: [] })
  // The path helper.
  assert.equal(subagentTranscriptPath(transcript, SUB), derived)
  assert.equal(subagentTranscriptPath(transcript, SUB, 'C:\\given.jsonl'), 'C:\\given.jsonl')
  assert.equal(subagentTranscriptPath(derived, SUB), derived)
  assert.equal(subagentTranscriptPath(transcript, '../../evil'), null)
  assert.equal(subagentTranscriptPath(undefined, SUB), null)
})

await t('claude: sessions the app did not start are observed too (their prompt is their task)', () => {
  const stats = new AgentStats()
  const adapter = createClaudeCodeHooksAdapter(undefined, (rootId) => new ClaudeHookObserver({ rootId, emit: (f) => stats.fact(f), managerTask: true }))
  const sink = { emit: (e: AgentEvent) => stats.event(e) }
  const ctx = { auth: { kind: 'global' }, signal: new AbortController().signal } as never
  const post = (name: string, extra: Record<string, unknown> = {}) =>
    adapter.handle({ session_id: SID, transcript_path: 'x', cwd: 'C:\\work\\other-project', hook_event_name: name, ...extra }, sink, ctx)
  post('UserPromptSubmit', { prompt: 'Tidy up the docs\nplease' })
  post('PreToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'Check the links', subagent_type: 'Explore' } })
  post('SubagentStart', { agent_id: SUB2, agent_type: 'Explore' })
  post('PostToolUse', { tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: 'C:\\work\\other-project\\docs\\a.md' }, tool_response: {} })
  const d = stats.details(SID)!
  assert.deepEqual([d.displayName, d.task, d.turns, d.sessionId, d.state], ['other-project', 'Tidy up the docs please', 1, undefined, 'working'])
  assert.deepEqual(d.files.map((f) => f.path), ['docs/a.md'])
  assert.deepEqual(d.workers!.map((w) => [w.agentType, w.task]), [['Explore', 'Check the links']])
  post('SessionEnd', { reason: 'prompt_input_exit' })
  assert.equal(stats.details(SID)!.state, 'done')
})

// ---- Claude: token usage from the transcript -----------------------------------------------------------

/** One assistant entry as Claude Code writes it (shape only; the values are made up). */
const assistantLine = (id: string, usage: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}, text = 'ok'): string =>
  JSON.stringify({
    parentUuid: '11111111-2222-4333-8444-555555555555',
    isSidechain: false,
    message: {
      container: null,
      content: [{ type: 'text', text }],
      id,
      model: 'claude-haiku-4-5-20251001',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      ...(usage ? { usage } : {})
    },
    sessionId: SID,
    timestamp: '2026-10-02T10:00:00.000Z',
    type: 'assistant',
    uuid: `uuid-${id}-${Math.random().toString(36).slice(2)}`,
    userType: 'external',
    entrypoint: 'cli',
    cwd: 'C:\\work\\my-project',
    version: '2.1.284',
    ...extra
  })
const usageOf = (input: number, output: number, cacheRead: number, cacheCreate: number): Record<string, unknown> => ({
  cache_creation: { ephemeral_1h_input_tokens: cacheCreate, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: cacheCreate,
  cache_read_input_tokens: cacheRead,
  inference_geo: 'not_available',
  input_tokens: input,
  iterations: [{}],
  output_tokens: output,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: 'standard'
})
const userLine = (text: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p', message: { role: 'user', content: text }, sessionId: SID, type: 'user', uuid: 'u1', cwd: 'C:\\work\\my-project' })

function transcriptRoot() {
  const base = mkdtempSync(join(tmpdir(), 'ao-inspector-'))
  const root = join(base, '.claude', 'projects')
  const project = join(root, 'C--work-my-project')
  mkdirSync(project, { recursive: true })
  return { base, root, project, main: join(project, `${SID}.jsonl`) }
}

await t('transcript: only .jsonl files inside the transcripts folder are ever read', () => {
  const { base, root, main } = transcriptRoot()
  assert.equal(transcriptPath(main, root), main)
  assert.equal(transcriptPath(join(root, 'p', SID, 'subagents', `agent-${SUB}.jsonl`), root), join(root, 'p', SID, 'subagents', `agent-${SUB}.jsonl`))
  for (const bad of [
    join(base, 'elsewhere.jsonl'), //                       outside
    join(root, '..', 'settings.jsonl'), //                 climbs out
    join(root, 'p', '..', '..', '..', 'secret.jsonl'),
    join(root, 'p', 'notes.txt'), //                       not a transcript
    join(root, 'p', 'x.jsonl.bak'),
    `${root}.jsonl`, //                                    a sibling with the same prefix
    'relative\\path.jsonl',
    `${main}\0.jsonl`,
    '',
    42,
    null,
    undefined,
    { path: main },
    `${'a'.repeat(2000)}.jsonl`
  ]) {
    assert.equal(transcriptPath(bad, root), null, String(bad))
  }
})

await t('transcript: appended bytes only, partial lines wait, the same message is counted once, unknown shapes are skipped', () => {
  const { main } = transcriptRoot()
  const tail = new TranscriptTail(main, true)
  // No file yet: nothing, and no error.
  assert.deepEqual(tail.read(), { changed: false, more: false })
  assert.equal(tail.usage(), undefined)

  writeFileSync(
    main,
    [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: SID }),
      userLine('Please say "assistant" and count my tokens'), //   mentions the word, is not an assistant entry
      assistantLine('msg_01', usageOf(2, 100, 0, 5000)), //       the same message, written once per content block:
      assistantLine('msg_01', usageOf(2, 100, 0, 5000), {}, 'second block'), // counted once
      assistantLine('msg_01', usageOf(2, 100, 0, 5000), {}, 'third block'),
      '{"type":"assistant","message":{"id":"msg_broken","usage":{"input_tokens":', // cut off mid-line by a crash
      assistantLine('msg_02', usageOf(4, 30, 5000, 200)),
      ''
    ].join('\n')
  )
  assert.deepEqual(tail.read(), { changed: true, more: false })
  assert.deepEqual(tail.usage(), { input: 6, output: 130, cached: 10200, total: 10336, contextUsed: 5204 })
  assert.equal(tail.model, 'claude-haiku-4-5-20251001')
  assert.equal(tail.position, statSync(main).size)

  // Nothing new: nothing read.
  assert.deepEqual(tail.read(), { changed: false, more: false })

  // A line arrives in two writes, cut in the middle of a multi-byte character.
  const line = Buffer.from(assistantLine('msg_03', usageOf(10, 20, 30, 40), {}, 'caf\u00e9 \u2603 d\u00e9j\u00e0 vu') + '\n', 'utf8')
  const cut = line.indexOf(Buffer.from('\u2603', 'utf8')) + 1
  appendFileSync(main, line.subarray(0, cut))
  assert.deepEqual(tail.read(), { changed: false, more: false }) // read, but not a whole line yet
  assert.equal(tail.position, statSync(main).size)
  appendFileSync(main, line.subarray(cut))
  assert.deepEqual(tail.read(), { changed: true, more: false })
  assert.deepEqual(tail.usage(), { input: 16, output: 150, cached: 10270, total: 10436, contextUsed: 80 })

  // The same id again with newer numbers (a streamed message that grew): the latest count, not both.
  appendFileSync(main, assistantLine('msg_03', usageOf(10, 60, 30, 40)) + '\n')
  tail.read()
  assert.deepEqual(tail.usage(), { input: 16, output: 190, cached: 10270, total: 10476, contextUsed: 80 })

  // Shapes this code does not know: skipped, never an error, and the sums stay.
  appendFileSync(
    main,
    [
      assistantLine('msg_04', undefined), //                                         no usage
      JSON.stringify({ type: 'assistant', message: { id: 'msg_05', usage: 'a lot' } }),
      JSON.stringify({ type: 'assistant', message: 'text only' }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_06', model: '<synthetic>', usage: usageOf(0, 0, 0, 0) } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 'many', output_tokens: null } } }),
      JSON.stringify(['assistant']),
      '"assistant"',
      'not json at all "assistant"',
      assistantLine('msg_side', usageOf(1000, 1000, 1000, 1000), { isSidechain: true, agentId: SUB }), // a subagent's entry in a main file
      ''
    ].join('\n')
  )
  assert.deepEqual(tail.read(), { changed: false, more: false })
  assert.deepEqual(tail.usage(), { input: 16, output: 190, cached: 10270, total: 10476, contextUsed: 80 })
  assert.equal(assistantUsage({ type: 'user' }, true), null)
  assert.equal(assistantUsage(null, true), null)

  // A subagent's own file: its entries are sidechain entries, and they count there.
  const { project } = transcriptRoot()
  const sub = join(project, `agent-${SUB}.jsonl`)
  writeFileSync(sub, assistantLine('msg_s1', usageOf(2, 199, 22961, 12395), { isSidechain: true, agentId: SUB }) + '\n')
  const subTail = new TranscriptTail(sub, false)
  subTail.read()
  assert.deepEqual(subTail.usage(), { input: 2, output: 199, cached: 35356, total: 35557, contextUsed: 35358 })

  // The file was replaced by a shorter one: start over instead of reading from the middle.
  writeFileSync(main, assistantLine('msg_new', usageOf(1, 2, 3, 4)) + '\n')
  assert.deepEqual(tail.read(), { changed: true, more: false })
  assert.deepEqual(tail.usage(), { input: 1, output: 2, cached: 7, total: 10, contextUsed: 8 })
})

await t('transcript: work per tick is capped, a huge line is never buffered, and reads are debounced by hook', () => {
  const { root, project, main, base } = transcriptRoot()
  // 40 messages; a tick of 2 KB reads a few lines at a time and says there is more.
  const lines = Array.from({ length: 40 }, (_, i) => assistantLine(`msg_${i}`, usageOf(1, 2, 3, 4)))
  writeFileSync(main, lines.join('\n') + '\n')
  const size = statSync(main).size
  const tail = new TranscriptTail(main, true)
  let ticks = 0
  for (;;) {
    const before = tail.position
    const r = tail.read(2048)
    ticks++
    assert.ok(tail.position - before <= 2048)
    if (!r.more) break
    assert.ok(ticks < 500)
  }
  assert.ok(ticks > 5)
  assert.equal(tail.position, size)
  assert.deepEqual(tail.usage(), { input: 40, output: 80, cached: 280, total: 400, contextUsed: 8 })

  // A tool result of several megabytes (a `user` line) and a line over the limit: skipped, and what follows still counts.
  const big = join(project, 'big.jsonl')
  writeFileSync(big, userLine('x'.repeat(3 * 1024 * 1024)) + '\n')
  appendFileSync(big, `{"type":"assistant","message":{"id":"msg_huge","junk":"${'y'.repeat(TRANSCRIPT_MAX_LINE_BYTES + 1024)}"}}\n`)
  appendFileSync(big, assistantLine('msg_after', usageOf(5, 6, 7, 8)) + '\n')
  const bigTail = new TranscriptTail(big, true)
  while (bigTail.read().more) {
    // catching up
  }
  assert.deepEqual(bigTail.usage(), { input: 5, output: 6, cached: 15, total: 26, contextUsed: 20 })

  // The reader: hooks poke, a read happens once after the debounce time, and only when the sums moved is anyone told.
  const time = fakeTime()
  const told: Array<{ agentId: string; usage: TokenUsage; model?: string }> = []
  const reader = new ClaudeTranscripts({ root, schedule: time.schedule, tickBytes: 4096, onUsage: (agentId, usage, model) => void told.push({ agentId, usage, model }) })
  reader.poke('s-1', main)
  reader.poke('s-1', main)
  reader.poke('s-1', main)
  assert.equal(time.pending(), 1)
  time.advance(TRANSCRIPT_DEBOUNCE_MS - 1)
  assert.equal(told.length, 0)
  time.advance(1)
  // The first tick read 4 KB of it; the rest follows in short ticks, without another hook.
  assert.equal(told.length, 1)
  assert.ok(told[0].usage.total > 0 && told[0].usage.total < 400)
  time.advance(TRANSCRIPT_CATCHUP_MS * 40)
  assert.deepEqual(told[told.length - 1], { agentId: 's-1', usage: { input: 40, output: 80, cached: 280, total: 400, contextUsed: 8 }, model: 'claude-haiku-4-5-20251001' })
  assert.equal(time.pending(), 0) // no timer of its own once it has caught up
  const count = told.length
  reader.poke('s-1', main) // a hook, but nothing was appended
  time.advance(TRANSCRIPT_DEBOUNCE_MS)
  assert.equal(told.length, count)
  appendFileSync(main, assistantLine('msg_more', usageOf(10, 10, 10, 10)) + '\n')
  reader.poke('s-1', main)
  time.advance(TRANSCRIPT_DEBOUNCE_MS)
  assert.deepEqual(told[told.length - 1].usage, { input: 50, output: 90, cached: 300, total: 440, contextUsed: 30 })

  // `/clear`: the session goes on in a new transcript; what the old one counted is kept.
  const second = join(project, 'aaaaaaaa-1111-4222-8333-444455556666.jsonl')
  writeFileSync(second, assistantLine('msg_c1', usageOf(1, 1, 1, 1)) + '\n')
  reader.poke('s-1', second)
  time.advance(TRANSCRIPT_DEBOUNCE_MS)
  assert.deepEqual(told[told.length - 1].usage, { input: 51, output: 91, cached: 302, total: 444, contextUsed: 3 })

  // A path outside the transcripts folder is never opened, and schedules nothing.
  const outside = join(base, 'outside.jsonl')
  writeFileSync(outside, assistantLine('msg_out', usageOf(9, 9, 9, 9)) + '\n')
  const before = told.length
  reader.poke('s-2', outside)
  reader.poke('s-2', join(root, '..', '..', 'outside.jsonl'))
  reader.poke('s-2', 'C:\\Windows\\win.ini')
  reader.poke('s-2', undefined)
  assert.equal(time.pending(), 0)
  // A link inside the folder that points outside it is not followed (when the platform lets us make one).
  const link = join(project, 'link.jsonl')
  let linked = false
  try {
    symlinkSync(outside, link, 'file')
    linked = true
  } catch {
    // no privilege to create links here: the check is still in place, just not exercised
  }
  if (linked) {
    reader.poke('s-3', link)
    time.advance(TRANSCRIPT_DEBOUNCE_MS)
  }
  // A transcript that does not exist (yet): nothing, no error.
  reader.poke('s-4', join(project, 'missing.jsonl'))
  time.advance(TRANSCRIPT_DEBOUNCE_MS)
  // A transcript of a shape nobody knows: the agent just has no tokens.
  const strange = join(project, 'strange.jsonl')
  writeFileSync(strange, `${JSON.stringify({ kind: 'assistant', tokens: 5 })}\n${JSON.stringify({ type: 'assistant', usage: { in: 1 } })}\n`)
  reader.poke('s-5', strange)
  time.advance(TRANSCRIPT_DEBOUNCE_MS)
  assert.equal(told.length, before)
  reader.close()
  assert.equal(time.pending(), 0)
  assert.ok(readFileSync(outside, 'utf8').length > 0)
})

// ---- the stable details (shared/details.ts) ---------------------------------------------------------------

await t('details: planning, secrets, questions, the board and delegation have stable texts in every adapter', () => {
  assert.deepEqual([DETAIL_PLANNING, DETAIL_SECRETS, DETAIL_QUESTION, DETAIL_BOARD, DETAIL_DELEGATING], ['planning: ', 'secrets: ', 'question: ', 'checking the board', 'delegating'])
  assert.deepEqual(
    ['planning: fix it', 'secrets: .env', 'question: Which one?', 'checking the board', 'delegating', 'src/app.ts', ''].map(detailKind),
    ['planning', 'secrets', 'question', 'board', 'delegating', null, null]
  )
  assert.deepEqual(['planning: fix it', 'secrets: .env', 'question: Which one?', 'src/app.ts'].map(detailText), ['fix it', '.env', 'Which one?', 'src/app.ts'])
  for (const p of ['.env', 'C:\\work\\p\\.env.local', 'config/secrets.json', '/home/u/.ssh/id_ed25519', '~/.aws/credentials', 'certs/server.pem', 'C:\\Users\\me\\.claude\\settings.json', '.npmrc', 'auth.json']) {
    assert.equal(isSensitivePath(p), true, p)
  }
  for (const p of ['src/app.ts', 'README.md', 'package.json', 'docs/environment.md', 'src/keys.ts', 'tsconfig.json']) assert.equal(isSensitivePath(p), false, p)
  assert.equal(fileDetail('src/app.ts'), 'src/app.ts')
  assert.equal(fileDetail('.env'), 'secrets: .env')
  assert.equal(fileDetail('secrets: .env'), 'secrets: .env')
  assert.equal(fileDetail('a.ts (+2 more)', '.env'), 'secrets: a.ts (+2 more)')

  // Claude Code: tools -> activity + detail.
  const claude = (tool: string, input?: unknown): string => `${activityForTool(tool, input)}|${toolDetail(tool, input)}`
  const todos = [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Fix the title', status: 'in_progress', activeForm: 'Fixing the title' },
    { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' }
  ]
  assert.equal(claude('TodoWrite', { todos }), 'write|planning: Fix the title (1/3 done)')
  assert.equal(claude('TodoWrite', { todos: todos.map((x) => ({ ...x, status: 'completed' })) }), 'write|planning: to-do list (3/3 done)')
  assert.equal(claude('TodoWrite', {}), 'write|planning: updating the to-do list')
  assert.equal(claude('TaskCreate', { subject: 'Add a footer', description: 'x' }), 'write|planning: new task: Add a footer')
  assert.equal(claude('TaskUpdate', { taskId: '3', status: 'in_progress' }), 'write|planning: task 3 is in progress')
  assert.equal(claude('TaskUpdate', { taskId: '3' }), 'write|planning: updating task 3')
  assert.equal(claude('TaskList'), 'write|planning: checking the task list')
  assert.equal(claude('EnterPlanMode'), 'write|planning: starting a plan')
  assert.equal(claude('ExitPlanMode', { plan: 'long text' }), 'write|planning: presenting the plan')
  assert.equal(planningSummary('SomethingElse', {}), 'planning')
  assert.equal(claude('AskUserQuestion', { questions: [{ question: 'Which colour\nshould it be?', header: 'Colour', options: [] }] }), 'waiting|question: Which colour should it be?')
  assert.equal(claude('AskUserQuestion', {}), 'waiting|question: asks you something')
  assert.equal(claude('Read', { file_path: 'C:\\work\\p\\.env' }), 'read|secrets: C:\\work\\p\\.env')
  assert.equal(claude('Edit', { file_path: 'C:\\Users\\me\\.claude\\settings.json' }), 'write|secrets: C:\\Users\\me\\.claude\\settings.json')
  assert.equal(claude('Read', { file_path: 'C:\\work\\p\\src\\app.ts' }), 'read|C:\\work\\p\\src\\app.ts')
  assert.equal(claude('Bash', { command: 'cat .env' }), 'exec|cat .env') // a command is a command
  assert.equal(claude('Agent', { description: 'x' }), 'exec|delegating')
  assert.equal(claude('Task', { description: 'x' }), 'exec|delegating') // the old name of Agent, not a to-do tool
  assert.equal(claude('mcp__agent-office__board_read', {}), 'read|checking the board')
  // Still the 8 activities, and ordinary tools are as before.
  assert.equal(claude('Write', { file_path: 'a.ts' }), 'write|a.ts')
  assert.equal(claude('WebFetch', { url: 'https://example.com' }), 'web|https://example.com')

  // A question is a wait nobody resolves through the inbox: the answer (PostToolUse) ends it.
  const mapper = new ClaudeHookMapper({ rootId: 'S', displayName: 'Sonnet', holdWaiting: true, endsWithProcess: true })
  const seen = (name: string, extra: Record<string, unknown>): string[] =>
    mapper.handle({ session_id: SID, hook_event_name: name, ...extra }).events.map((e) => `${e.activity}|${e.detail}`)
  assert.deepEqual(seen('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Tabs or spaces?' }] } }), ['waiting|question: Tabs or spaces?'])
  assert.deepEqual(seen('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {} }), ['idle|'])
  assert.deepEqual(seen('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos } }), ['write|planning: Fix the title (1/3 done)'])
  assert.deepEqual(seen('PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos }, tool_response: {} }), []) // other tools: as before

  // Codex.
  const codex = (item: unknown, cwd?: string): string => {
    const a = worldActivityForItem(item, cwd)
    return a ? `${a.activity}|${a.detail}` : 'null'
  }
  assert.equal(codex({ type: 'plan', text: 'First…' }), 'write|planning: writing a plan')
  assert.equal(codex({ type: 'fileChange', changes: [{ path: 'C:\\ws\\.env', kind: { type: 'update' } }] }, 'C:\\ws'), 'write|secrets: .env')
  assert.equal(codex({ type: 'fileChange', changes: [{ path: 'C:\\ws\\a.ts' }, { path: 'C:\\ws\\.env' }] }, 'C:\\ws'), 'write|secrets: .env (+1 more)')
  assert.equal(codex({ type: 'fileChange', changes: [{ path: 'C:\\ws\\a.ts' }, { path: 'C:\\ws\\b.ts' }] }, 'C:\\ws'), 'write|a.ts (+1 more)')
  assert.equal(codex({ type: 'commandExecution', command: 'cat .env', commandActions: [{ type: 'read', path: '.env', name: '.env', command: 'cat .env' }] }), 'read|secrets: .env')
  assert.equal(codex({ type: 'commandExecution', command: 'cat a.ts', commandActions: [{ type: 'read', path: 'a.ts', name: 'a.ts', command: 'cat a.ts' }] }), 'read|a.ts')
  assert.equal(codex({ type: 'collabAgentToolCall', tool: 'spawnAgent' }), 'exec|delegating')
  const plan = (steps: Array<[string, string]>, explanation?: string) => planActivity({ explanation, plan: steps.map(([step, status]) => ({ step, status })) })
  assert.deepEqual(plan([['Read the notes', 'completed'], ['Write the summary', 'inProgress'], ['Check it', 'pending']]), { activity: 'write', detail: 'planning: Write the summary (1/3 done)' })
  assert.deepEqual(plan([['Read the notes', 'pending']]), { activity: 'write', detail: 'planning: Read the notes (0/1 done)' })
  assert.deepEqual(plan([], 'Thinking about the order'), { activity: 'write', detail: 'planning: Thinking about the order' })
  assert.deepEqual(planActivity(null), { activity: 'write', detail: 'planning: the plan' })

  // Antigravity.
  const agy = (tool: string, params: Record<string, unknown>): string => {
    const a = agyWorldActivity(tool, params, 'C:\\ws')
    return a ? `${a.activity}|${a.detail}` : 'null'
  }
  assert.equal(agy('view_file', { AbsolutePath: 'C:\\ws\\.env' }), 'read|secrets: .env')
  assert.equal(agy('write_to_file', { TargetFile: 'C:\\ws\\config\\secrets.json' }), 'write|secrets: config\\secrets.json')
  assert.equal(agy('view_file', { AbsolutePath: 'C:\\ws\\src\\a.ts' }), 'read|src\\a.ts')
  assert.equal(agy('ask_question', { questions: [{ question: 'Which port?' }] }), 'waiting|question: Which port?')
  assert.equal(agy('ask_question', { questions: ['Plain text?'] }), 'waiting|question: Plain text?')
  assert.equal(agy('invoke_subagent', {}), 'exec|delegating')
  assert.equal(agy('finish', {}), 'null')
})

// ---- token feeds: Codex and Antigravity ------------------------------------------------------------------

await t('tokens: the Codex and Antigravity usage shapes', () => {
  // docs/spikes-phase-b.md: thread/tokenUsage/updated.
  const params = {
    threadId: 'T',
    turnId: 'u',
    tokenUsage: {
      total: { totalTokens: 13265, inputTokens: 13203, cachedInputTokens: 5888, cacheWriteInputTokens: 0, outputTokens: 62, reasoningOutputTokens: 0 },
      last: { totalTokens: 7000, inputTokens: 6950, cachedInputTokens: 5888, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 },
      modelContextWindow: 258400
    }
  }
  // Codex counts the cached part inside inputTokens: here input is the rest, so the parts add up to the total.
  assert.deepEqual(codexTokenUsage(params), { input: 7315, output: 62, cached: 5888, total: 13265, contextUsed: 7000, contextWindow: 258400 })
  assert.deepEqual(codexTokenUsage({ tokenUsage: { total: { inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2 } } }), { input: 10, output: 5, cached: 0, total: 15, reasoning: 2 })
  for (const bad of [null, {}, { tokenUsage: null }, { tokenUsage: { total: 'x' } }, { tokenUsage: { total: {} } }, { tokenUsage: { last: {} } }]) assert.equal(codexTokenUsage(bad), null)

  // docs/spikes-phase-c.md: `result.usage` is a running total of the process; a step's usage is one model call.
  const result = (input: number, output: number, total: number, thinking = 0) =>
    parseAgyLine(JSON.stringify({ event: 'result', result: { conversation_id: 'C', status: 'SUCCESS', response: '', num_turns: 1, usage: { input_tokens: input, output_tokens: output, thinking_tokens: thinking, cache_read_tokens: 0, total_tokens: total } } }))
  const first = result(73069, 496, 73565)
  assert.ok(first?.type === 'result')
  assert.deepEqual(first.usage, { input: 73069, output: 496, thinking: 0, cacheRead: 0, total: 73565 })
  const step = parseAgyLine(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'C', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 13413, output_tokens: 131, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 13544 } } }))
  assert.ok(step?.type === 'step' && step.usage?.input === 13413)
  const noUsage = parseAgyLine(JSON.stringify({ event: 'result', result: { conversation_id: 'C', status: 'SUCCESS', response: '' } }))
  assert.ok(noUsage?.type === 'result' && noUsage.usage === null)

  const tokens = new AgyTokens()
  assert.equal(tokens.usage(), null)
  assert.equal(tokens.result(null), null) // a turn that reported nothing
  tokens.step(step.usage)
  assert.deepEqual(tokens.result(first.usage), { input: 73069, output: 496, total: 73565, contextUsed: 13413 })
  // The second turn's result is the total so far: it replaces the first, it is not added to it.
  const second = result(105528, 700, 106228, 529)
  assert.ok(second?.type === 'result')
  assert.deepEqual(tokens.result(second.usage), { input: 105528, output: 700, total: 106228, reasoning: 529, contextUsed: 13413 })
  // After an interrupt a new process counts from zero again: what the old one had is kept.
  const third = result(12000, 100, 12100)
  assert.ok(third?.type === 'result')
  assert.deepEqual(tokens.result(third.usage), { input: 117528, output: 800, total: 118328, reasoning: 529, contextUsed: 13413 })
  assert.deepEqual(tokens.result(null), { input: 117528, output: 800, total: 118328, reasoning: 529, contextUsed: 13413 })
})

class NoPty implements PtyHost {
  async spawn(): Promise<void> {
    throw new Error('a chat session must not spawn a terminal')
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  dispose(): void {}
  async snapshot(): Promise<ScreenSnapshot | null> {
    return null
  }
  detach(): void {}
  ack(): void {}
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

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-server.cjs', import.meta.url))
const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.cjs', import.meta.url))
const AGY_HOOK = fileURLToPath(new URL('../hook/agy-hook.cjs', import.meta.url))

await t('codex: turns, the thread token total, plan updates, changed files and a pending question reach the inspector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-inspector-codex-'))
  const stats = new AgentStats()
  const world: AgentEvent[] = []
  const codex = codexProvider({
    openExternal: async () => {},
    server: { resolveSpawn: (): CodexSpawnSpec => ({ file: process.execPath, args: [FAKE_CODEX], env: { ...(process.env as Record<string, string>) } }), backoffMs: [50, 100] },
    findExecutable: () => process.execPath,
    version: async () => '0.160.0'
  })
  const manager = new SessionManager({
    pty: new NoPty(),
    sink: {
      emit: (e) => {
        world.push(e)
        stats.event(e)
      }
    },
    providers: [codex],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: () => {},
    onTerminalData: () => {},
    stats
  })
  try {
    const info = await manager.start({ provider: 'codex', cwd: dir })
    const id = info.id
    const state = (): string | undefined => manager.list().find((s) => s.id === id)?.state
    const turn = async (text: string, n: number): Promise<AgentDetails> => {
      await manager.chatSend(id, text)
      return until(() => {
        const d = manager.inspect(id)
        return d && d.turns === n && state() === 'idle' && d.tokens?.total === 1050 * n ? d : null
      }, `turn ${n} "${text}"`)
    }

    let d = manager.inspect(id)!
    assert.deepEqual([d.role, d.provider, d.sessionId, d.cwd, d.turns, d.tokens, d.task, d.state], ['manager', 'codex', id, dir, 0, undefined, undefined, 'idle'])

    d = await turn('hello there', 1)
    assert.equal(d.task, 'hello there')
    // 1000 input of which 400 cached, 50 output of which 10 reasoning; the context is the last request.
    assert.deepEqual(d.tokens, { input: 600, output: 50, cached: 400, total: 1050, reasoning: 10, contextUsed: 1050, contextWindow: 258400 })
    assert.ok(d.model)

    // The plan: `write` with a "planning: " detail, once per update.
    d = await turn('make a todo-list first', 2)
    assert.deepEqual(
      world.filter((e) => e.detail.startsWith(DETAIL_PLANNING)).map((e) => `${e.agentId === id}|${e.activity}|${e.detail}`),
      ['true|write|planning: Read the notes (0/2 done)', 'true|write|planning: Write the summary (1/2 done)']
    )
    assert.equal(d.counts.write, 2)
    assert.equal(d.task, 'make a todo-list first')
    // The total of the thread replaced the first one (it is not added twice).
    assert.deepEqual(d.tokens, { input: 1200, output: 100, cached: 800, total: 2100, reasoning: 20, contextUsed: 1050, contextWindow: 258400 })
    assert.ok(d.recent.some((r) => r.detail === 'planning: Write the summary (1/2 done)'))

    // A file change that asks first: the inspector says what it waits on; once allowed, the file is listed.
    await manager.chatSend(id, 'apply the patch')
    const pending = await until(() => manager.listPermissions().find((p) => p.sessionId === id), 'the approval request')
    d = manager.inspect(id)!
    assert.equal(d.state, 'waiting-permission')
    assert.equal(d.activity, 'waiting')
    assert.deepEqual(d.waitingOn, { question: pending.question, risk: pending.risk, since: pending.createdAt })
    assert.equal(manager.decide(pending.id, { behavior: 'allow' }), 'allowed')
    d = await until(() => {
      const x = manager.inspect(id)
      return x && x.turns === 3 && state() === 'idle' && x.files.length > 0 ? x : null
    }, 'the patch turn')
    assert.equal(d.waitingOn, undefined)
    assert.deepEqual(d.files.map((f) => `${f.path}|${f.kind}`), ['C:\\ws\\ao-note.txt|create']) // outside the session's folder: as it is
    assert.ok(d.activeMs > 0)

    await manager.stop(id)
    assert.equal(manager.inspect(id)!.state, 'exited')
    assert.equal(manager.inspect(id)!.activity, 'done')
    assert.equal(manager.inspect(42), null)
    assert.equal(manager.inspect('x'.repeat(300)), null)
  } finally {
    await manager.shutdown()
  }
})

await t('antigravity: turns, running token totals (not double counted) and changed files reach the inspector', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ao inspector agy '))
  const home = join(root, 'fake home')
  const userData = join(root, 'user data')
  const work = join(root, 'project')
  for (const d of [home, userData, work]) mkdirSync(d, { recursive: true })
  const port = await freePort()
  const agyTokens = new SessionTokens()
  const stats = new AgentStats()
  const provider = agyProvider({
    sessionsDir: join(userData, 'agy-sessions'),
    protectedPaths: [userData],
    hookScript: AGY_HOOK,
    ingest: { baseUrl: () => `http://127.0.0.1:${port}`, tokens: agyTokens },
    cli: {
      findExecutable: () => process.execPath,
      resolveSpawn: (_exe, args) => ({ file: process.execPath, args: [FAKE_AGY, ...args] }),
      env: { ...process.env, FAKE_AGY_HOME: home }
    }
  })
  const manager = new SessionManager({
    pty: new NoPty(),
    sink: { emit: (e) => stats.event(e) },
    providers: [provider],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: () => {},
    onTerminalData: () => {},
    stats
  })
  const server = await startIngestServer({ port, getToken: () => 'G'.repeat(64), sink: { emit: () => {} }, agy: { adapter: createAgyHooksAdapter(manager), tokens: agyTokens } })
  try {
    const info = await manager.start({ provider: 'antigravity', cwd: work, permissionMode: 'acceptEdits' })
    const id = info.id
    const turn = async (text: string, n: number): Promise<AgentDetails> => {
      await manager.chatSend(id, text)
      return until(() => {
        const d = manager.inspect(id)
        return d && d.turns === n && manager.list().find((s) => s.id === id)?.state === 'idle' ? d : null
      }, `turn ${n}`, 20_000)
    }
    let d = await turn('write: notes.txt|hello\nsay: written', 1)
    assert.deepEqual(d.files.map((f) => `${f.path}|${f.kind}`), ['notes.txt|create'])
    assert.deepEqual(d.tokens, { input: 100, output: 20, total: 120, contextUsed: 100 })
    assert.equal(d.task, 'write: notes.txt|hello say: written')
    assert.deepEqual([d.provider, d.sessionId, d.cwd, d.state], ['antigravity', id, work, 'idle'])
    assert.equal(d.counts.write, 1)
    assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'hello')

    // The second result carries the conversation's running total: 240, not 120 + 240.
    d = await turn('read: notes.txt\nreplace: notes.txt|hello|goodbye\nsay: changed', 2)
    assert.deepEqual(d.tokens, { input: 200, output: 40, total: 240, contextUsed: 100 })
    assert.deepEqual(d.files.map((f) => `${f.path}|${f.kind}`), ['notes.txt|create']) // created, then edited: still its new file
    assert.equal(d.counts.read, 1)
    assert.ok(d.recent.some((r) => r.activity === 'read' && r.detail === 'notes.txt'))
  } finally {
    await manager.shutdown()
    provider.cli.killSync()
    await server.close()
  }
})

// ---- a hosted Claude session, end to end (fake terminal, real driver, real transcript reader) ---------------

class FakePty implements PtyHost {
  spawned = new Map<string, { opts: PtySpawnOptions; handlers: PtyHandlers }>()
  async spawn(id: string, opts: PtySpawnOptions, handlers: PtyHandlers): Promise<void> {
    this.spawned.set(id, { opts, handlers })
  }
  write(): void {}
  resize(): void {}
  kill(id: string): void {
    setTimeout(() => this.spawned.get(id)?.handlers.onExit(1), 5)
  }
  dispose(): void {}
  async snapshot(): Promise<ScreenSnapshot | null> {
    return { data: '', cols: 120, rows: 40, text: '' }
  }
  detach(): void {}
  ack(): void {}
}

await t('claude (hosted): inspect() gives the task, the worker with its description, tokens from the transcripts, files and what it waits on', async () => {
  const { root, project } = transcriptRoot()
  const work = mkdtempSync(join(tmpdir(), 'ao-inspector-work-'))
  const sessionsDir = mkdtempSync(join(tmpdir(), 'ao-inspector-sessions-'))
  const board = new Board({ settings: () => ({ ...DEFAULT_BOARD_SETTINGS }) })
  const stats = new AgentStats()
  const time = fakeTime()
  const transcripts = new ClaudeTranscripts({ root, schedule: time.schedule, onUsage: (agentId, usage, model) => stats.fact({ kind: 'tokens', agentId, usage, model }) })
  const pty = new FakePty()
  const manager = new SessionManager({
    pty,
    sink: { emit: (e) => stats.event(e) },
    providers: [
      claudeProvider({
        sessionsDir,
        hookScript: 'C:\\app\\hook\\claude-session-start.cjs',
        inbox: new SessionInbox(),
        transcripts,
        ingest: { baseUrl: () => 'http://127.0.0.1:9', tokens: new SessionTokens() },
        findExecutable: () => process.execPath
      })
    ],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: () => {},
    onTerminalData: () => {},
    board: { model: board, resolveProject: async (cwd) => ({ project: cwd, projectLabel: 'work', root: cwd }) as never },
    stats
  })
  try {
    const info = await manager.start({ provider: 'claude-code', cwd: work, model: 'haiku' })
    const id = info.id
    const main = join(project, `${SID}.jsonl`)
    const subFile = join(project, SID, 'subagents', `agent-${SUB}.jsonl`)
    const target = manager.hookTarget(id)!
    const hook = (name: string, extra: Record<string, unknown> = {}): unknown =>
      target.handleHook(
        { session_id: SID, transcript_path: main, cwd: work, scratchpad_dir: 'x', prompt_id: 'p1', hook_event_name: name, ...extra },
        { auth: { kind: 'session', sessionId: id }, signal: new AbortController().signal } as never
      )
    const sub = { agent_id: SUB, agent_type: 'Explore' }
    const worker = subagentId(id, SUB)

    hook('SessionStart', { source: 'startup', model: 'claude-haiku-4-5-20251001' })
    let d = manager.inspect(id)!
    assert.deepEqual([d.state, d.model, d.cwd, d.sessionId, d.turns, d.task, d.tokens], ['idle', 'claude-haiku-4-5-20251001', work, id, 0, undefined, undefined])

    hook('UserPromptSubmit', { prompt: 'Look at this folder\nand fix the title', permission_mode: 'default' })
    d = manager.inspect(id)!
    assert.deepEqual([d.state, d.turns, d.task], ['busy', 1, 'Look at this folder and fix the title'])

    // The Agent call, then the subagent it starts.
    hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_A', tool_input: { description: 'List the files', subagent_type: 'Explore', prompt: 'List the files here.' } })
    hook('SubagentStart', sub)
    hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_A', tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: SUB } })
    hook('PreToolUse', { ...sub, tool_name: 'Glob', tool_use_id: 'toolu_B', tool_input: { pattern: '**/*' } })
    d = manager.inspect(id)!
    assert.deepEqual(d.workers!.map((w) => [w.agentId, w.displayName, w.agentType, w.task, w.activity, w.done]), [[worker, 'Explore', 'Explore', 'List the files', 'read', false]])
    assert.equal(d.activity, 'exec')
    assert.equal(d.detail, 'delegating')

    // The transcripts grow; the hooks ask for a read; the debounce time passes.
    mkdirSync(join(project, SID, 'subagents'), { recursive: true })
    writeFileSync(main, [userLine('Look at this folder'), assistantLine('msg_m1', usageOf(3, 120, 0, 21000)), ''].join('\n'))
    writeFileSync(subFile, assistantLine('msg_s1', usageOf(2, 40, 9000, 500), { isSidechain: true, agentId: SUB }) + '\n')
    hook('PostToolUse', { ...sub, tool_name: 'Glob', tool_use_id: 'toolu_B', tool_input: { pattern: '**/*' }, tool_response: {} })
    assert.equal(manager.inspect(id)!.tokens, undefined) // not read on the hook itself
    time.advance(TRANSCRIPT_DEBOUNCE_MS)
    assert.deepEqual(manager.inspect(id)!.tokens, { input: 3, output: 120, cached: 21000, total: 21123, contextUsed: 21003 })
    let w = manager.inspect(worker)!
    assert.deepEqual(w.tokens, { input: 2, output: 40, cached: 9500, total: 9542, contextUsed: 9502 })
    assert.deepEqual([w.role, w.parentId, w.sessionId, w.cwd, w.task, w.agentType, w.model, w.state], ['worker', id, id, work, 'List the files', 'Explore', 'claude-haiku-4-5-20251001', 'working'])

    hook('SubagentStop', { ...sub, agent_transcript_path: subFile })
    w = manager.inspect(worker)!
    assert.equal(w.state, 'done')
    assert.equal(manager.inspect(id)!.workers![0].done, true)

    // An edit that asks first: what it waits on; then the file is listed, relative to the folder.
    hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_C', tool_input: { command: 'npm install left-pad' } })
    const held = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }) as Promise<unknown>
    const pending = manager.listPermissions()[0]
    d = manager.inspect(id)!
    assert.equal(d.state, 'waiting-permission')
    assert.deepEqual(d.waitingOn, { question: pending.question, risk: 'caution', since: pending.createdAt })
    assert.match(d.waitingOn!.question, /wants to install software packages/)
    manager.decide(pending.id, { behavior: 'deny', message: 'not now' })
    await held
    assert.equal(manager.inspect(id)!.waitingOn, undefined)
    hook('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_D', tool_input: { file_path: join(work, 'index.html') } })
    hook('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_D', tool_input: { file_path: join(work, 'index.html') }, tool_response: { type: 'update' } })
    appendFileSync(main, assistantLine('msg_m2', usageOf(4, 60, 21000, 300)) + '\n')
    hook('Stop', { background_tasks: [] })
    time.advance(TRANSCRIPT_DEBOUNCE_MS)
    d = manager.inspect(id)!
    assert.equal(d.state, 'idle')
    assert.deepEqual(d.files.map((f) => `${f.path}|${f.kind}`), ['index.html|edit'])
    assert.deepEqual(d.tokens, { input: 7, output: 180, cached: 42300, total: 42487, contextUsed: 21304 })
    // "starting", then the end of the turn; the command it went back to after the question counts once.
    assert.deepEqual(d.counts, { idle: 2, exec: 2, waiting: 1, write: 1 })
    assert.deepEqual(
      d.recent.map((r) => `${r.activity}|${r.detail}`),
      ['idle|', `write|${join(work, 'index.html')}`, 'exec|npm install left-pad', 'waiting|install software packages (`npm install left-pad`)', 'exec|npm install left-pad', 'exec|delegating', 'idle|starting']
    )

    // The team claims a task on the board after the prompt: that is what it is doing now.
    await sleep(5)
    assert.equal(board.claim(id, 'page title').ok, true)
    assert.equal(manager.inspect(id)!.task, 'page title')
    hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>x</task-id>' }) // not a prompt: the task and the turns stay
    assert.deepEqual([manager.inspect(id)!.turns, manager.inspect(id)!.task], [1, 'page title'])
    await sleep(5)
    hook('UserPromptSubmit', { prompt: 'Now the footer' })
    assert.deepEqual([manager.inspect(id)!.turns, manager.inspect(id)!.task], [2, 'Now the footer'])

    pty.spawned.get(id)!.handlers.onExit(0)
    d = manager.inspect(id)!
    assert.deepEqual([d.state, d.activity], ['exited', 'done'])
  } finally {
    manager.close()
    transcripts.close()
  }
})

console.log(`\n${pass} inspector tests passed\n`)

await import('./progress.test.ts')
