// The agent inspector's selectors (src/ui/inspect.ts) and the approval-mode helpers
// (src/ui/approvals.ts): no DOM, no React rendering. Imported by ui.test.ts (npm test runs
// everything); also runs alone: tsx tests/inspect.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AgentDetails } from '../shared/inspector.ts'
import type { ThemeManifest } from '../shared/theme.ts'
import { StationRouter } from '../src/theme/stations.ts'
import { clockShort, compactNumber, contextUse, COUNTED, countRows, facts, NOT_REPORTED, roleLine, runtimeLine, spanText, stateChip, tokenBreakdown } from '../src/ui/inspect.ts'
import {
  APPROVAL_MODES,
  approvalHelp,
  approvalsBridge,
  approvalStatus,
  DEFAULT_UNMUTED,
  HANDLED_KEEP,
  HANDLED_VISIBLE,
  handledAction,
  handledRows,
  handledTag,
  isApprovalMode,
  isMuted,
  MUTE_TITLE,
  pushHandled,
  toggleMute,
  UNMUTE_TITLE,
  wantsAttention
} from '../src/ui/approvals.ts'
import type { AutoAllowed } from '../src/ui/approvals.ts'

const office = JSON.parse(readFileSync(new URL('../themes/office/theme.json', import.meta.url), 'utf8')) as ThemeManifest
const router = new StationRouter(office, () => undefined)

let pass = 0
const t = (name: string, fn: () => void) => {
  fn()
  pass++
  console.log('ok -', name)
}

const at = (h: number, m: number) => new Date(2026, 0, 5, h, m, 30).getTime()

const details = (o: Partial<AgentDetails> = {}): AgentDetails => ({
  agentId: 'a1',
  role: 'manager',
  displayName: 'frontend',
  provider: 'claude-code',
  state: 'busy',
  activity: 'web',
  detail: 'WebFetch: example.com',
  startedAt: at(14, 2),
  lastActiveAt: at(14, 14),
  activeMs: 12 * 60_000 + 20_000,
  counts: {},
  files: [],
  recent: [],
  ...o
})

// ---- phrases -------------------------------------------------------------------------------------

t('status phrase: the theme verb plus the detail', () => {
  assert.equal(router.phrase('web', 'example.com'), 'Copying · example.com')
  assert.equal(router.phrase('web', 'WebFetch: example.com'), 'Copying · example.com')
  assert.equal(router.phrase('read', 'src/ui/App.tsx'), 'Filing · src/ui/App.tsx')
  assert.equal(router.phrase('exec', 'npm test'), 'Running · npm test')
  assert.equal(router.phrase('write', 'planning: split the store'), 'Planning · split the store')
  assert.equal(router.phrase('read', 'checking the board'), 'Checking the board')
  assert.equal(router.phrase('read', 'secrets: .env.local'), 'In the vault · .env.local')
  assert.equal(router.phrase('waiting', 'question: Which runner?'), 'Asking · Which runner?')
  assert.equal(router.phrase('waiting', 'run the tests'), 'Awaiting sign-off · run the tests')
  // The office theme has no verb for idle: a plain word, never an empty status.
  assert.equal(router.phrase('idle', ''), 'Idle')
  assert.equal(router.phrase('done', ''), 'Reporting')
})

// ---- numbers and time ------------------------------------------------------------------------------

t('tokens: compact numbers (1.2k, 3.4M)', () => {
  const cases: [number, string][] = [
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [1960, '2k'],
    [9949, '9.9k'],
    [12_345, '12k'],
    [45_678, '46k'],
    [999_499, '999k'],
    [999_500, '1M'],
    [3_400_000, '3.4M'],
    [12_000_000, '12M'],
    [2_500_000_000, '2.5B']
  ]
  for (const [n, text] of cases) assert.equal(compactNumber(n), text, String(n))
  assert.equal(compactNumber(-5), '0')
  assert.equal(compactNumber(NaN), '0')
})

t('tokens: the breakdown lists only what the provider reports; the context bar needs both numbers', () => {
  assert.equal(tokenBreakdown({ input: 12_300, output: 3400, total: 15_700 }), '12k in · 3.4k out')
  assert.equal(tokenBreakdown({ input: 12_300, output: 3400, cached: 80_000, reasoning: 1200, total: 96_900 }), '12k in · 3.4k out · 80k cached · 1.2k reasoning')
  assert.equal(tokenBreakdown({ input: 1, output: 2, cached: 0, total: 3 }), '1 in · 2 out · 0 cached')
  assert.deepEqual(contextUse({ input: 0, output: 0, total: 0, contextUsed: 124_000, contextWindow: 200_000 }), { percent: 62, label: '62% of the context used (124k of 200k)' })
  assert.equal(contextUse({ input: 0, output: 0, total: 0, contextUsed: 250_000, contextWindow: 200_000 })!.percent, 100)
  assert.equal(contextUse({ input: 0, output: 0, total: 0, contextUsed: 10 }), null)
  assert.equal(contextUse({ input: 0, output: 0, total: 0, contextWindow: 200_000 }), null)
  assert.equal(contextUse({ input: 0, output: 0, total: 0, contextUsed: 10, contextWindow: 0 }), null)
  assert.equal(contextUse(undefined), null)
})

t('runtime: "12 min working · started 14:02"', () => {
  assert.equal(spanText(0), 'under a minute')
  assert.equal(spanText(59_999), 'under a minute')
  assert.equal(spanText(60_000), '1 min')
  assert.equal(spanText(59 * 60_000 + 59_000), '59 min')
  assert.equal(spanText(60 * 60_000), '1 h')
  assert.equal(spanText(125 * 60_000), '2 h 5 min')
  assert.equal(clockShort(at(14, 2)), '14:02')
  assert.equal(clockShort(at(9, 5)), '09:05')
  assert.equal(runtimeLine(details()), '12 min working · started 14:02')
  assert.equal(runtimeLine({ activeMs: 0, startedAt: at(8, 0) }), 'under a minute working · started 08:00')
  assert.equal(runtimeLine({ activeMs: NaN, startedAt: at(8, 0) }), 'started 08:00')
})

// ---- facts ---------------------------------------------------------------------------------------

t('facts: task, status, runtime, tokens, turns in that order', () => {
  const list = facts(details({ task: '  Refactor the store  ', turns: 4, tokens: { input: 12_000, output: 3400, cached: 80_000, total: 95_400 } }), router)
  assert.deepEqual(list.map((f) => f.key), ['task', 'status', 'runtime', 'tokens', 'turns'])
  assert.deepEqual(list.map((f) => f.label), ['Task', 'Status', 'Runtime', 'Tokens', 'Turns'])
  assert.equal(list[0].value, 'Refactor the store')
  assert.equal(list[1].value, 'Copying · example.com')
  assert.equal(list[2].value, '12 min working · started 14:02')
  assert.equal(list[3].value, '95k')
  assert.equal(list[3].title, '12k in · 3.4k out · 80k cached')
  assert.equal(list[4].value, '4')
})

t('facts: missing fields are left out; tokens say "not reported" instead', () => {
  // An observed agent: no task, no tokens, no turns.
  const list = facts(details({ provider: 'simulate', state: 'working' }), router)
  assert.deepEqual(list.map((f) => f.key), ['status', 'runtime', 'tokens'])
  const tokens = list.find((f) => f.key === 'tokens')!
  assert.deepEqual([tokens.value, tokens.title, tokens.missing], ['—', NOT_REPORTED, true])
  assert.equal(facts(details({ task: '   ' }), router).some((f) => f.key === 'task'), false)
  assert.equal(facts(details({ turns: 0 }), router).find((f) => f.key === 'turns')!.value, '0')
  // An idle agent still has a status.
  assert.equal(facts(details({ activity: 'idle', detail: '' }), router)[0].value, 'Idle')
})

t('counts: reads, edits, commands, web, screenshots in that order; empty ones and states left out', () => {
  assert.deepEqual(COUNTED, ['read', 'write', 'exec', 'web', 'capture'])
  const rows = countRows({ capture: 1, web: 2, idle: 9, waiting: 4, done: 1, exec: 3, read: 12, write: 0 }, router)
  assert.deepEqual(rows.map((r) => [r.activity, r.count]), [['read', 12], ['exec', 3], ['web', 2], ['capture', 1]])
  // Named by the theme: its verbs and its stations.
  assert.deepEqual(rows.map((r) => r.verb), ['Filing', 'Running', 'Copying', 'Snapping'])
  assert.deepEqual(rows.map((r) => r.station), ['Filing cabinet', 'Server room', 'Printer', 'Photo booth'])
  assert.equal(Math.round(rows.reduce((s, r) => s + r.share, 0) * 1000), 1000)
  assert.equal(rows[0].share, 12 / 18)
  // Writing happens at home in the office theme: no station to name, the verb stands in.
  assert.deepEqual(countRows({ write: 5 }, router).map((r) => [r.verb, r.station]), [['Typing', null]])
  assert.deepEqual(countRows({}, router), [])
  assert.deepEqual(countRows(undefined, router), [])
  assert.deepEqual(countRows({ read: -3, exec: 2.9 }, router).map((r) => [r.activity, r.count]), [['exec', 2]])
})

t('header: role line and state chip', () => {
  const labels = { manager: 'Manager', worker: 'Worker' }
  assert.equal(roleLine({ role: 'manager' }, 'frontend', labels), 'Manager of frontend')
  assert.equal(roleLine({ role: 'worker', agentType: 'Explore' }, 'frontend', labels), 'Worker in frontend · Explore')
  assert.equal(roleLine({ role: 'worker' }, null, labels), 'Worker')
  assert.equal(roleLine({ role: 'manager', agentType: 'ignored' }, null, { manager: 'Guard', worker: 'Inmate' }), 'Guard')
  assert.deepEqual(stateChip('busy'), { label: 'Working', tone: 'busy' })
  assert.deepEqual(stateChip('waiting-permission'), { label: 'Waiting for permission', tone: 'waiting-permission' })
  assert.deepEqual(stateChip('working'), { label: 'Working', tone: 'busy' })
  assert.deepEqual(stateChip('waiting'), { label: 'Waiting on you', tone: 'waiting-permission' })
  assert.deepEqual(stateChip('done'), { label: 'Done', tone: 'exited' })
  assert.deepEqual(stateChip('idle'), { label: 'Idle', tone: 'idle' })
})

// ---- approvals -------------------------------------------------------------------------------------

const auto = (id: string, at: number, o: Partial<AutoAllowed> = {}): AutoAllowed => ({
  id,
  sessionId: 's1',
  agentId: 's1',
  displayName: 'frontend',
  provider: 'claude-code',
  question: 'frontend wants to run the tests (`npm test`).',
  toolName: 'Bash',
  at,
  ...o
})

t('handled list: newest first, one row per id, capped; malformed entries dropped', () => {
  let list = pushHandled([], [auto('a', 10), auto('b', 30), auto('c', 20)])
  assert.deepEqual(list.map((e) => e.id), ['b', 'c', 'a'])
  // A pushed entry lands on top; a repeated id keeps its newest copy and its place by time.
  list = pushHandled(list, [auto('d', 40)])
  assert.deepEqual(list.map((e) => e.id), ['d', 'b', 'c', 'a'])
  list = pushHandled(list, [auto('a', 50, { toolName: 'Edit' })])
  assert.deepEqual(list.map((e) => e.id), ['a', 'd', 'b', 'c'])
  assert.equal(list[0].toolName, 'Edit')
  // The initial list arriving after a push does not undo it.
  assert.deepEqual(pushHandled([auto('x', 99)], [auto('y', 5), auto('x', 99)]).map((e) => e.id), ['x', 'y'])
  // Junk from an unexpected main process is ignored.
  assert.deepEqual(pushHandled([], [null, 'x', { id: 'q' }, { id: 'z', sessionId: 's', at: NaN }, auto('ok', 1)]).map((e) => e.id), ['ok'])
  // Capped: the oldest fall off.
  const many = pushHandled([], Array.from({ length: HANDLED_KEEP + 15 }, (_, i) => auto(`e${i}`, i)))
  assert.equal(many.length, HANDLED_KEEP)
  assert.equal(many[0].id, `e${HANDLED_KEEP + 14}`)
  assert.equal(many[many.length - 1].id, 'e15')
  const shown = handledRows(many)
  assert.equal(shown.rows.length, HANDLED_VISIBLE)
  assert.equal(HANDLED_VISIBLE, 20)
  assert.equal(shown.more, HANDLED_KEEP - HANDLED_VISIBLE)
  assert.equal(shown.rows[0].id, many[0].id)
  assert.deepEqual(handledRows(list), { rows: list, more: 0 })
})

t('handled rows: who + the action phrase; a tag says why it was allowed', () => {
  assert.equal(handledAction(auto('a', 1)), 'run the tests (`npm test`)')
  assert.equal(handledAction(auto('a', 1, { question: "Explore (frontend's team) wants to read `src/ui/store.ts`." })), 'read `src/ui/store.ts`')
  assert.equal(handledAction(auto('a', 1, { question: 'Something unusual happened' })), 'Something unusual happened')
  assert.equal(handledAction(auto('a', 1, { question: '' })), 'Bash')
  assert.deepEqual(handledTag(auto('a', 1, { mode: 'auto' })), { text: 'muted', tone: 'muted' })
  assert.deepEqual(handledTag(auto('a', 1, { mode: 'important' })), { text: 'routine', tone: 'routine' })
  assert.deepEqual(handledTag(auto('a', 1)), { text: 'routine', tone: 'routine' })
})

t('approval modes: labels for the control, the status bar and the help line', () => {
  assert.deepEqual(APPROVAL_MODES.map((m) => [m.value, m.label]), [['important', 'Important things only'], ['all', 'Everything'], ['auto', 'Only dangerous things']])
  assert.equal(approvalStatus('important'), 'Approvals: important only')
  assert.equal(approvalStatus('all'), 'Approvals: everything')
  assert.equal(approvalStatus('auto'), 'Approvals: automatic')
  assert.match(approvalHelp('important'), /^Routine work inside the project \(reading and editing files, tests, builds, searches\) is allowed automatically\. Installs, deletes, pushes, anything outside the project and anything unusual still comes to you\.$/)
  assert.match(approvalHelp('auto'), /Held for you/)
  assert.ok(isApprovalMode('auto') && isApprovalMode('all') && isApprovalMode('important'))
  assert.ok(!isApprovalMode('none') && !isApprovalMode(undefined) && !isApprovalMode(1))
  assert.ok(isMuted('auto') && !isMuted('important') && !isMuted('all') && !isMuted(null))
  assert.equal(MUTE_TITLE, 'Approve for me (dangerous requests are held for you, not done)')
  assert.equal(UNMUTE_TITLE, 'Ask me again before things are done')
})

t('mute: remembers the mode that was active and goes back to it', () => {
  assert.equal(DEFAULT_UNMUTED, 'important')
  // Muting from either mode remembers it.
  assert.deepEqual(toggleMute('all', null), { next: 'auto', remember: 'all' })
  assert.deepEqual(toggleMute('important', 'all'), { next: 'auto', remember: 'important' })
  // Unmuting goes back to what was remembered ...
  assert.deepEqual(toggleMute('auto', 'all'), { next: 'all', remember: 'all' })
  assert.deepEqual(toggleMute('auto', 'important'), { next: 'important', remember: 'important' })
  // ... and to "important" when nothing sensible was (first run, cleared storage, muted from the tray).
  for (const junk of [null, undefined, 'auto', 'everything', 7, {}]) assert.deepEqual(toggleMute('auto', junk), { next: 'important', remember: 'important' })
  // A full round trip.
  let stored: unknown = null
  let mode = toggleMute('all', stored)
  stored = mode.remember
  assert.equal(mode.next, 'auto')
  mode = toggleMute(mode.next, stored)
  assert.equal(mode.next, 'all')
})

t('mute: only a dangerous request asks for attention while muted', () => {
  assert.equal(wantsAttention('auto', 'danger'), true)
  assert.equal(wantsAttention('auto', 'normal'), false)
  assert.equal(wantsAttention('auto', 'caution'), false)
  assert.equal(wantsAttention('auto', undefined), false)
  for (const mode of ['all', 'important', null, undefined] as const) for (const risk of ['normal', 'caution', 'danger', undefined]) assert.equal(wantsAttention(mode, risk), true)
})

t('approvals bridge: an older main process simply has none of the calls', () => {
  assert.deepEqual(approvalsBridge({ permissions: { list: () => [] } }), { setApprovalMode: undefined, recentAuto: undefined, onAuto: undefined })
  assert.deepEqual(approvalsBridge(undefined), { setApprovalMode: undefined, recentAuto: undefined, onAuto: undefined })
  const full = approvalsBridge({ setApprovalMode: async () => undefined, permissions: { recentAuto: async () => [], onAuto: () => () => undefined } })
  assert.ok(full.setApprovalMode && full.recentAuto && full.onAuto)
})

console.log(`\n${pass} inspector tests passed\n`)
