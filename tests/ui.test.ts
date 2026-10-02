// Pure shell logic (src/ui/format.ts, keys.ts, store.ts): no DOM, no React rendering.
// Imported by hosted.test.ts (npm test runs everything); also runs alone: tsx tests/ui.test.ts
import assert from 'node:assert/strict'
import type { AgentEvent } from '../shared/events.ts'
import type { PermissionRequestInfo, ProviderInfo, SessionInfo } from '../shared/sessions.ts'
import {
  ago,
  appendLog,
  clampSplit,
  cleanError,
  filterLog,
  groupSessions,
  observedTeams,
  orderSummary,
  orderTargets,
  osc52Text,
  pushRecent,
  retainExited,
  sessionOrder,
  shortenPath,
  stripToolPrefix,
  terminalOnlyWaiting,
  vanished,
  windowsPtyOption
} from '../src/ui/format.ts'
import type { LogEntry, TeamLike } from '../src/ui/format.ts'
import { bulkAllowSplit } from '../src/ui/format.ts'
import { appChord } from '../src/ui/keys.ts'
import { Store } from '../src/ui/store.ts'

let pass = 0
const t = (name: string, fn: () => void) => {
  fn()
  pass++
  console.log('ok -', name)
}

const providers: ProviderInfo[] = [
  { id: 'claude-code', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: false, reason: 'driver coming in phase B' }
]
const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  provider: 'claude-code',
  cwd: `C:\\Users\\me\\src\\${id}`,
  title: id,
  state: 'idle',
  startedAt: 1,
  permissionMode: 'default',
  surface: 'terminal',
  canReceiveOrders: true,
  ...over
})
const team = (id: string, over: Partial<TeamLike> = {}): TeamLike => ({
  id,
  name: id,
  provider: 'claude-code',
  color: '#fff',
  workers: 0,
  live: true,
  ...over
})
const perm = (id: string, sessionId: string, agentId = sessionId): PermissionRequestInfo => ({
  id,
  sessionId,
  agentId,
  displayName: agentId,
  provider: 'claude-code',
  toolName: 'Bash',
  summary: 'Bash: ls',
  detail: '{}',
  createdAt: 0
})
const event = (agentId: string, over: Partial<AgentEvent> = {}): AgentEvent => ({
  agentId,
  parentId: null,
  provider: 'claude-code',
  displayName: agentId,
  activity: 'read',
  detail: '',
  ts: 0,
  ...over
})

t('ago and shortenPath format compactly', () => {
  assert.equal(ago(5_000), '5s')
  assert.equal(ago(125_000), '2m 5s')
  assert.equal(ago(3_720_000), '1h 2m')
  assert.equal(ago(-50), '0s')
  assert.equal(shortenPath('C:\\Users\\me\\source\\repos\\app'), '…\\repos\\app')
  assert.equal(shortenPath('C:\\Users\\me\\app'), '~\\app')
  assert.equal(shortenPath('/home/me/work/site/api', 2), '…/site/api')
  assert.equal(shortenPath('D:\\work'), 'D:\\work')
  assert.equal(shortenPath(''), '')
})

t('sessions are grouped by provider, unavailable providers stay listed', () => {
  const groups = groupSessions(providers, [session('b', { startedAt: 2 }), session('a', { startedAt: 1 })])
  assert.deepEqual(
    groups.map((g) => [g.provider.id, g.sessions.map((s) => s.id)]),
    [
      ['claude-code', ['a', 'b']],
      ['codex', []]
    ]
  )
  assert.deepEqual(
    sessionOrder(providers, [session('b', { startedAt: 2 }), session('a', { startedAt: 1 })]).map((s) => s.id),
    ['a', 'b']
  )
  // A session of a provider the list doesn't know still shows up.
  const odd = groupSessions([], [session('x', { provider: 'antigravity' })])
  assert.equal(odd.length, 1)
  assert.equal(odd[0].provider.id, 'antigravity')
})

t('order targets: everyone, per provider, each live session, plus world-only teams', () => {
  const targets = orderTargets(
    providers,
    [session('a'), session('gone', { state: 'exited' })],
    [team('a'), team('ext', { provider: 'simulate' }), team('leaving', { live: false })]
  )
  assert.deepEqual(
    targets.map((o) => o.value),
    ['all', 'provider:claude-code', 'provider:simulate', 'a', 'ext']
  )
  assert.deepEqual(targets[0].ids, ['a', 'ext'])
  assert.equal(targets[1].label, 'All Claude Code')
  assert.deepEqual(targets[1].ids, ['a'])
  assert.equal(orderTargets(providers, [], []).length, 1)
})

t('order summary groups failures by reason and names sessions', () => {
  const names: Record<string, string> = { a: 'Alpha', b: 'Beta', c: 'Gamma' }
  const nameOf = (id: string) => names[id] ?? id
  const partial = orderSummary(
    { delivered: ['a'], failed: [{ agentId: 'b', reason: 'busy' }, { agentId: 'c', reason: 'busy' }] },
    nameOf
  )
  assert.equal(partial.headline, 'Delivered to 1 of 3')
  assert.equal(partial.tone, 'partial')
  assert.deepEqual(partial.failures, [{ reason: 'busy', names: ['Beta', 'Gamma'] }])
  const ok = orderSummary({ delivered: ['a'], failed: [] }, nameOf)
  assert.deepEqual([ok.ok, ok.tone, ok.headline], [true, 'ok', 'Delivered to 1'])
  // A failure about the target itself (disabled, no sessions) carries no name.
  const off = orderSummary({ delivered: [], failed: [{ agentId: 'provider:codex', reason: 'disabled' }] }, nameOf)
  assert.equal(off.tone, 'fail')
  assert.deepEqual(off.failures, [{ reason: 'disabled', names: [] }])
  assert.equal(orderSummary({ delivered: [], failed: [] }, nameOf).headline, 'Nothing sent')
})

t('waiting agents without a permission card are listed as terminal-only', () => {
  const waiting = [
    { agentId: 's1', teamId: 's1', displayName: 'S1', detail: '', since: 1 }, // manager relaying its worker's card
    { agentId: 's1:w', teamId: 's1', displayName: 'W', detail: 'Edit', since: 2 }, // has a card
    { agentId: 's2', teamId: 's2', displayName: 'S2', detail: 'trust?', since: 3 }, // hosted, no card
    { agentId: 'ext:1', teamId: 'ext', displayName: 'X', detail: 'Bash', since: 4 } // external
  ]
  const out = terminalOnlyWaiting(waiting, [perm('p1', 's1', 's1:w')], [session('s1'), session('s2')])
  assert.deepEqual(
    out.map((w) => [w.agentId, w.hosted]),
    [
      ['s2', true],
      ['ext:1', false]
    ]
  )
})

t('a session the app hosted is never listed as an observed team', () => {
  const teams = [{ id: 's1' }, { id: 's-gone' }, { id: 'ext' }]
  // s-gone was hosted and removed from the list: its branch is still being cleared in the world.
  assert.deepEqual(observedTeams(teams, [session('s1')], new Set(['s1', 's-gone'])), [{ id: 'ext' }])
  assert.deepEqual(observedTeams(teams, [], new Set()), teams)
})

t('OSC 52 sets the clipboard text and never answers a query', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  assert.equal(osc52Text(`c;${b64('hello')}`), 'hello')
  assert.equal(osc52Text(`;${b64('line one\nünï 日本')}`), 'line one\nünï 日本')
  assert.equal(osc52Text('c;?'), null)
  assert.equal(osc52Text('c;'), null)
  assert.equal(osc52Text('c'), null)
  assert.equal(osc52Text('c;not base64!'), null)
})

t('xterm gets the real Windows build, and nothing off Windows', () => {
  assert.deepEqual(windowsPtyOption(26200), { backend: 'conpty', buildNumber: 26200 })
  assert.equal(windowsPtyOption(0), undefined)
  assert.equal(windowsPtyOption(undefined), undefined) // an older main process
  assert.equal(windowsPtyOption(Number.NaN), undefined)
})

t('permission requests that vanish without a local decision were answered elsewhere', () => {
  const prev = [perm('p1', 's'), perm('p2', 's'), perm('p3', 's')]
  const gone = vanished(prev, [perm('p2', 's')], new Set(['p3']))
  assert.deepEqual(
    gone.map((p) => p.id),
    ['p1']
  )
})

t('the event log is capped and filterable', () => {
  let log: LogEntry[] = []
  for (let i = 1; i <= 12; i++) {
    log = appendLog(log, [{ seq: i, teamId: i % 2 ? 'a' : 'b', event: event(`ag${i}`, { activity: i % 3 ? 'read' : 'exec', detail: `file${i}.ts` }) }], 10)
  }
  assert.equal(log.length, 10)
  assert.equal(log[0].seq, 3)
  assert.equal(filterLog(log, { text: '', activities: null, teamId: 'a' }).length, 5)
  assert.deepEqual(
    filterLog(log, { text: 'FILE12', activities: null, teamId: null }).map((l) => l.seq),
    [12]
  )
  assert.deepEqual(
    filterLog(log, { text: '', activities: new Set(['exec']), teamId: null }).map((l) => l.seq),
    [3, 6, 9, 12]
  )
})

t('split sizes stay inside the workspace', () => {
  assert.equal(clampSplit(600, 1200, 360, 300), 600)
  assert.equal(clampSplit(100, 1200, 360, 300), 360)
  assert.equal(clampSplit(5000, 1200, 360, 300), 900)
  assert.equal(clampSplit(500, 500, 360, 300), 360) // too small for both: the panel minimum wins
})

t('recent folders: newest first, no duplicates, capped', () => {
  let list: string[] = []
  for (const p of ['C:\\a', 'C:\\b', 'c:\\A', '  ', '/x/Y', '/x/y']) list = pushRecent(list, p, 3)
  assert.deepEqual(list, ['/x/y', '/x/Y', 'c:\\A'])
})

t('exited sessions with an open terminal outlive the main process list', () => {
  const prev = [session('a'), session('dead', { state: 'exited' }), session('unseen', { state: 'exited' })]
  const next = retainExited(prev, [session('a')], (id) => id === 'dead')
  assert.deepEqual(
    next.map((s) => s.id),
    ['a', 'dead']
  )
  // A running session that vanishes is not resurrected.
  assert.equal(retainExited([session('a')], [], () => true).length, 0)
})

t('error wrappers and tool prefixes are stripped only when they match', () => {
  assert.equal(cleanError(new Error("Error invoking remote method 'agent-office:sessions:start': Error: Folder not found")), 'Folder not found')
  assert.equal(cleanError(new Error('plain')), 'plain')
  assert.equal(cleanError('text'), 'text')
  assert.equal(stripToolPrefix('Bash: npm test', 'Bash'), 'npm test')
  assert.equal(stripToolPrefix('Run (a+b)*: x', '(a+b)*'), 'Run (a+b)*: x')
})

t('app chords: Ctrl+N, Ctrl+`, Ctrl+1..9 only', () => {
  const key = (code: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = { ctrlKey: true }) => ({
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code,
    ...mods
  })
  assert.deepEqual(appChord(key('KeyN')), { kind: 'new-session' })
  assert.deepEqual(appChord(key('Backquote')), { kind: 'toggle-panel' })
  assert.deepEqual(appChord(key('Digit3')), { kind: 'select', index: 2 })
  assert.equal(appChord(key('Digit0')), null)
  assert.equal(appChord(key('KeyK')), null) // stays with the terminal (kill-line)
  assert.equal(appChord(key('KeyC')), null)
  assert.equal(appChord(key('KeyN', {})), null)
  assert.equal(appChord(key('KeyN', { ctrlKey: true, shiftKey: true })), null)
})

t('store notifies only on real changes and keeps untouched slices', () => {
  const list = [1, 2]
  const store = new Store({ a: 1, list })
  let calls = 0
  const off = store.subscribe(() => calls++)
  store.set({ a: 1 })
  assert.equal(calls, 0)
  store.set({ a: 2 })
  assert.equal(calls, 1)
  assert.equal(store.get().list, list)
  store.set((s) => ({ a: s.a + 1 }))
  assert.equal(store.get().a, 3)
  off()
  store.set({ a: 9 })
  assert.equal(calls, 2)
})

t('allow all never includes dangerous requests', () => {
  const pending = [{ id: 'a', risk: 'normal' }, { id: 'b', risk: 'danger' }, { id: 'c', risk: 'caution' }, { id: 'd' }]
  const { allow, keep } = bulkAllowSplit(pending)
  assert.deepEqual(allow.map((p) => p.id), ['a', 'c', 'd'])
  assert.deepEqual(keep.map((p) => p.id), ['b'])
  assert.deepEqual(bulkAllowSplit([{ id: 'x', risk: 'danger' }]).allow, [])
})

console.log(`\n${pass} ui tests passed`)

await import('./chat.test.ts')
await import('./boardui.test.ts')
await import('./restoreui.test.ts')
await import('./inspect.test.ts')
