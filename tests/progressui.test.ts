// The progress bars' selectors (src/ui/progress.ts): which kind of bar, its fraction and words,
// the step window of the Inspect tab, and an order's overall bar. No DOM, no React rendering.
// Also the stub's demo steps. Imported by ui.test.ts (npm test runs everything); also runs alone:
// tsx tests/progressui.test.ts
import assert from 'node:assert/strict'
import type { OrderProgress, OrderSessionProgress, ProgressStep, SessionProgress } from '../shared/progress.ts'
import { ORDER_BAR_MIN_SESSIONS } from '../shared/progress.ts'
import { DEMO_PLAN, demoSteps } from '../src/dev/stubProgress.ts'
import {
  barView,
  cleanSnapshot,
  fractionOf,
  isDeterminate,
  orderBars,
  orderFraction,
  orderView,
  progressById,
  rowBar,
  rowStateText,
  showOrderBar,
  signBars,
  sourceText,
  STEPS_COLLAPSED,
  stepWindow,
  teamFraction
} from '../src/ui/progress.ts'

let pass = 0
const t = (name: string, fn: () => void) => {
  fn()
  pass++
  console.log('ok -', name)
}

const sp = (kind: SessionProgress['kind'], done = 0, total = 0, extra: Partial<SessionProgress> = {}): SessionProgress => ({ sessionId: 's1', kind, done, total, startedAt: 1000, updatedAt: 2000, ...extra })
const row = (state: OrderSessionProgress['state'], progress?: SessionProgress, extra: Partial<OrderSessionProgress> = {}): OrderSessionProgress => ({ sessionId: `s-${state}`, title: `Team ${state}`, state, ...(progress ? { progress } : {}), ...extra })
const order = (sessions: OrderSessionProgress[], extra: Partial<OrderProgress> = {}): OrderProgress => ({
  id: 'o-1',
  text: 'Add a CHANGELOG entry',
  target: 'all',
  sentAt: 1000,
  sessions,
  done: sessions.filter((s) => s.state === 'done').length,
  total: sessions.length,
  ...extra
})

t('progress: a bar is determinate only with a real count; otherwise it is "working", or there is no bar', () => {
  // A plan: the fraction is steps done / steps.
  let v = barView(sp('plan', 3, 7, { current: 'Create b.txt' }))!
  assert.deepEqual(v, { mode: 'determinate', fraction: 3 / 7, tone: 'live', label: '3/7', tooltip: '3 of 7 plan steps', current: 'Create b.txt' })
  // Helpers: finished / spawned.
  v = barView(sp('workers', 2, 3))!
  assert.deepEqual(v, { mode: 'determinate', fraction: 2 / 3, tone: 'live', label: '2/3', tooltip: '2 of 3 helpers finished' })
  assert.equal(barView(sp('workers', 0, 1))!.tooltip, '0 of 1 helper finished')
  assert.equal(barView(sp('plan', 1, 1))!.tooltip, '1 of 1 plan step')
  // No count: indeterminate, fraction 0, no "3/7", and the tooltip says so.
  v = barView(sp('working'))!
  assert.deepEqual(v, { mode: 'indeterminate', fraction: 0, tone: 'live', label: '', tooltip: 'Working' })
  // Even if a number sneaks in next to "working", it is not shown as a fraction.
  assert.deepEqual([barView(sp('working', 5, 10))!.mode, barView(sp('working', 5, 10))!.fraction, barView(sp('working', 5, 10))!.label], ['indeterminate', 0, ''])
  // Idle, unknown, or a "plan" without steps: no bar.
  for (const none of [sp('idle'), sp('plan', 0, 0), sp('workers', 0, 0), sp('plan', 1, Number.NaN), null, undefined]) assert.equal(barView(none), null)

  assert.deepEqual([isDeterminate(sp('plan', 0, 2)), isDeterminate(sp('working', 1, 2)), isDeterminate(sp('idle')), isDeterminate(null)], [true, false, false, false])
  // Out-of-range numbers never make a bar longer than full or shorter than empty.
  assert.deepEqual([fractionOf(sp('plan', 9, 4)), fractionOf(sp('plan', -3, 4)), fractionOf(sp('plan', 2, 4)), fractionOf(sp('working', 2, 4)), fractionOf(undefined)], [1, 0, 0.5, 0, 0])
  assert.equal(barView(sp('plan', 9, 4))!.label, '4/4')
  assert.deepEqual([sourceText(sp('working')), sourceText(sp('idle')), sourceText(sp('plan', 9, 4))], ['Working', 'Idle', '4 of 4 plan steps'])
})

t('progress: tones: waiting on the user, stopped where it was, finished', () => {
  assert.deepEqual([barView(sp('plan', 1, 4), true)!.tone, barView(sp('plan', 1, 4), true)!.tooltip], ['waiting', '1 of 4 plan steps · waiting on you'])
  assert.deepEqual([barView(sp('working'), true)!.tone, barView(sp('working'), true)!.tooltip], ['waiting', 'Working · waiting on you'])
  // Stopped wins over waiting; the bar stays where it was.
  let v = barView(sp('plan', 1, 4, { stopped: 'interrupted', current: 'B' }), true)!
  assert.deepEqual([v.tone, v.fraction, v.tooltip, v.current], ['stopped', 0.25, '1 of 4 plan steps · interrupted', 'B'])
  assert.equal(barView(sp('plan', 1, 4, { stopped: 'failed' }))!.tooltip, '1 of 4 plan steps · the turn failed')
  assert.equal(barView(sp('workers', 1, 2, { stopped: 'paused' }))!.tooltip, '1 of 2 helpers finished · the turn ended with steps left')
  // Finished: full, no "current" any more.
  v = barView(sp('plan', 4, 4, { finishedAt: 5000, current: 'D' }))!
  assert.deepEqual(v, { mode: 'determinate', fraction: 1, tone: 'finished', label: '4/4', tooltip: '4 of 4 plan steps · done' })
})

t('progress: the snapshot from the bridge is made safe; sessions are looked up by id', () => {
  assert.deepEqual(cleanSnapshot(undefined), { sessions: [], orders: [] })
  assert.deepEqual(cleanSnapshot({ sessions: 'x', orders: null }), { sessions: [], orders: [] })
  const a = sp('plan', 1, 2)
  const o = order([row('working'), row('done')])
  assert.deepEqual(cleanSnapshot({ sessions: [a, null, { kind: 'plan' }], orders: [o, { id: 'x' }, 7] }), { sessions: [a], orders: [o] })
  const b = { ...sp('working'), sessionId: 's2' }
  assert.deepEqual(progressById([a, b]), { s1: a, s2: b })
  assert.deepEqual(progressById(undefined), {})
})

t('progress: the bars under the branch signs: one per session that has a bar', () => {
  const bars = signBars([sp('plan', 1, 4), { ...sp('working'), sessionId: 's2' }, { ...sp('idle'), sessionId: 's3' }, { ...sp('workers', 1, 2, { stopped: 'interrupted' }), sessionId: 's4' }], new Set(['s2']))
  assert.deepEqual([...bars.keys()], ['s1', 's2', 's4'])
  assert.deepEqual(bars.get('s1'), { mode: 'determinate', fraction: 0.25, tone: 'live', label: '1/4' })
  assert.deepEqual(bars.get('s2'), { mode: 'indeterminate', fraction: 0, tone: 'waiting', label: '' })
  assert.deepEqual(bars.get('s4'), { mode: 'determinate', fraction: 0.5, tone: 'stopped', label: '1/2' })
})

t('progress: a long step list collapses to six around the step in progress', () => {
  const list = (n: number, current: number): ProgressStep[] => Array.from({ length: n }, (_, i) => ({ text: `Step ${i + 1}`, status: i < current ? 'completed' : i === current ? 'in-progress' : 'pending' }))
  assert.equal(STEPS_COLLAPSED, 6)
  assert.deepEqual(stepWindow(list(6, 2)), { start: 0, end: 6, before: 0, after: 0 })
  assert.deepEqual(stepWindow([]), { start: 0, end: 0, before: 0, after: 0 })
  // At the start: the first six.
  assert.deepEqual(stepWindow(list(10, 0)), { start: 0, end: 6, before: 0, after: 4 })
  // In the middle: one finished step above the current one.
  assert.deepEqual(stepWindow(list(10, 4)), { start: 3, end: 9, before: 3, after: 1 })
  // Near the end: the last six.
  assert.deepEqual(stepWindow(list(10, 9)), { start: 4, end: 10, before: 4, after: 0 })
  // Nothing in progress: from the first step that is not done; all done: the last six.
  const pending = list(10, 3).map((s) => (s.status === 'in-progress' ? { ...s, status: 'pending' as const } : s))
  assert.deepEqual(stepWindow(pending), { start: 2, end: 8, before: 2, after: 2 })
  assert.deepEqual(stepWindow(list(10, 10)), { start: 4, end: 10, before: 4, after: 0 })
  assert.deepEqual(stepWindow(list(10, 4), 3), { start: 3, end: 6, before: 3, after: 4 })
})

t('orders: the overall bar is the average of the teams; a team without a count is 0 while working and 1 when done', () => {
  assert.equal(ORDER_BAR_MIN_SESSIONS, 2)
  assert.deepEqual([teamFraction(row('queued')), teamFraction(row('working')), teamFraction(row('waiting')), teamFraction(row('done')), teamFraction(row('failed'))], [0, 0, 0, 1, null])
  assert.equal(teamFraction(row('working', sp('plan', 3, 6))), 0.5)
  assert.equal(teamFraction(row('waiting', sp('workers', 1, 4))), 0.25)
  assert.equal(teamFraction(row('working', sp('working'))), 0)
  // A team whose own list is finished and held at 100 % counts as 1, done or not.
  assert.equal(teamFraction(row('working', sp('plan', 2, 2, { finishedAt: 9 }))), 1)
  // Done is done, whatever its last plan said.
  assert.equal(teamFraction(row('done', sp('plan', 1, 5, { stopped: 'paused' }))), 1)

  const o = order([row('done'), row('working', sp('plan', 1, 2)), row('working', sp('working')), row('queued')])
  assert.equal(orderFraction(o), (1 + 0.5 + 0 + 0) / 4)
  let v = orderView(o)
  assert.deepEqual([v.label, v.fraction, v.finished, v.allDone, v.failed], ['1 of 4 teams done', 0.375, false, false, 0])
  assert.match(v.tooltip, /average of the teams/)

  // Failed teams are left out of the average, and named.
  const withFailed = order([row('done'), row('working', sp('plan', 1, 2)), row('failed', undefined, { reason: 'the session ended' })])
  assert.equal(orderFraction(withFailed), 0.75)
  assert.equal(orderView(withFailed).label, '1 of 3 teams done · 1 failed')
  assert.equal(orderFraction(order([row('failed'), row('failed')])), 0)
  assert.equal(orderFraction(order([])), 0)

  // Finished.
  v = orderView(order([row('done'), row('done'), row('done')], { finishedAt: 9000 }))
  assert.deepEqual([v.label, v.fraction, v.finished, v.allDone], ['All 3 teams done', 1, true, true])
  assert.equal(orderView(order([row('done'), row('done')], { finishedAt: 9000 })).label, 'Both teams done')
  v = orderView(order([row('done'), row('failed')], { finishedAt: 9000 }))
  assert.deepEqual([v.label, v.fraction, v.finished, v.allDone, v.failed], ['1 of 2 teams done · 1 failed', 1, true, false, 1])
  assert.equal(orderView(order([row('done')], { finishedAt: 1 })).label, 'Done')
})

t('orders: the big bar is for two teams or more; the newest orders show first', () => {
  const one = order([row('working')], { id: 'o-1' })
  const two = order([row('working'), row('done')], { id: 'o-2' })
  const three = order([row('working'), row('done'), row('queued')], { id: 'o-3' })
  const four = order([row('done'), row('done')], { id: 'o-4', finishedAt: 5 })
  assert.deepEqual([showOrderBar(one), showOrderBar(two)], [false, true])
  assert.deepEqual(orderBars([one, two, three, four]).map((o) => o.id), ['o-4', 'o-3'])
  assert.deepEqual(orderBars([one, two, three, four], 5).map((o) => o.id), ['o-4', 'o-3', 'o-2'])
  assert.deepEqual(orderBars([one]), [])
  assert.deepEqual(orderBars(undefined), [])
})

t('orders: each team row has its own bar and state', () => {
  assert.deepEqual(['queued', 'working', 'waiting', 'done', 'failed'].map((s) => rowStateText(row(s as OrderSessionProgress['state']))), ['Queued', 'Working', 'Waiting on you', 'Done', 'Failed'])
  assert.equal(rowStateText(row('failed', undefined, { reason: 'interrupted' })), 'Failed: interrupted')
  // Working with a plan: its own count. Without one: stripes.
  assert.deepEqual(rowBar(row('working', sp('plan', 2, 5, { current: 'C' }))), { mode: 'determinate', fraction: 0.4, tone: 'live', label: '2/5', tooltip: '2 of 5 plan steps', current: 'C' })
  assert.deepEqual(rowBar(row('working')), { mode: 'indeterminate', fraction: 0, tone: 'live', label: '', tooltip: 'Working' })
  assert.deepEqual(rowBar(row('waiting')), { mode: 'indeterminate', fraction: 0, tone: 'waiting', label: '', tooltip: 'Working · waiting on you' })
  assert.equal(rowBar(row('waiting', sp('plan', 1, 4)))!.tone, 'waiting')
  // Done: full. Failed: empty and grey. Queued: empty.
  assert.deepEqual([rowBar(row('done'))!.fraction, rowBar(row('done'))!.tone, rowBar(row('done'))!.label], [1, 'finished', ''])
  assert.equal(rowBar(row('done', sp('plan', 3, 3, { finishedAt: 1 })))!.label, '3/3')
  assert.deepEqual([rowBar(row('failed', undefined, { reason: 'the session ended' }))!.fraction, rowBar(row('failed', undefined, { reason: 'the session ended' }))!.tone, rowBar(row('failed', undefined, { reason: 'the session ended' }))!.tooltip], [0, 'stopped', 'Failed: the session ended'])
  assert.deepEqual([rowBar(row('queued'))!.mode, rowBar(row('queued'))!.fraction], ['determinate', 0])
})

t('stub: the demo plan marks the steps before `done` completed and the next one in progress', () => {
  assert.equal(DEMO_PLAN.length, 7)
  assert.deepEqual(demoSteps(2).map((s) => s.status), ['completed', 'completed', 'in-progress', 'pending', 'pending', 'pending', 'pending'])
  assert.ok(demoSteps(7).every((s) => s.status === 'completed'))
  assert.deepEqual(demoSteps(0, ['a', 'b']), [
    { text: 'a', status: 'in-progress' },
    { text: 'b', status: 'pending' }
  ])
})

console.log(`\n${pass} progress ui tests passed`)
