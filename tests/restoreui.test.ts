// Pure logic of "remember where I left off" in the shell (src/ui/restore.ts and the bits of
// format.ts it touches): asleep rows in the sidebar, the launch summary, relative times, the Recent
// list reducer, what the panel shows per state, and which session is selected at launch.
// Imported by ui.test.ts (npm test runs everything); also runs alone: tsx tests/restoreui.test.ts
import assert from 'node:assert/strict'
import type { SavedSession } from '../shared/restore.ts'
import type { ProviderInfo, SessionInfo, SessionState } from '../shared/sessions.ts'
import { composerState, groupSessions, orderTargets, sessionOrder, STATE_LABEL } from '../src/ui/format.ts'
import {
  canContinue,
  canWakeRow,
  EMPTY_RECENT,
  endedLabel,
  interruptedHeadline,
  interruptedTag,
  isLive,
  lastActiveLabel,
  panelContent,
  pendingPreview,
  recentReducer,
  restoreModeShort,
  restoreSelection,
  restoreSummary,
  visibleRecent
} from '../src/ui/restore.ts'
import type { RecentState } from '../src/ui/restore.ts'

let pass = 0
const t = (name: string, fn: () => void) => {
  fn()
  pass++
  console.log('ok -', name)
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)

const providers: ProviderInfo[] = [
  { id: 'claude-code', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true }
]

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  provider: 'claude-code',
  cwd: `C:\\repos\\${id}`,
  title: id,
  state: 'idle',
  startedAt: 1000,
  permissionMode: 'default',
  surface: 'terminal',
  canReceiveOrders: true,
  ...over
})

const asleep = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => session(id, { state: 'asleep', canReceiveOrders: false, wakeable: true, ...over })

const note = (closedAt: number, questions: string[] = []): NonNullable<SessionInfo['interruptedNote']> => ({
  closedAt,
  pending: questions.map((question, i) => ({ question, toolName: 'Bash', askedAt: closedAt - (i + 1) * MIN }))
})

const saved = (id: string, over: Partial<SavedSession> = {}): SavedSession => ({
  id,
  provider: 'claude-code',
  cwd: `C:\\repos\\${id}`,
  title: id,
  titleIsCustom: false,
  permissionMode: 'default',
  providerSessionId: `conv-${id}`,
  startedAt: NOW - 5 * HOUR,
  lastActiveAt: NOW - HOUR,
  interrupted: false,
  pendingAtClose: [],
  status: 'recent',
  ...over
})

t('asleep rows keep their place in the sidebar (and their Ctrl+N), woken or not', () => {
  // Saved start times come back with the rows: the order of before the restart.
  const before = [
    session('a', { startedAt: 10 }),
    session('x', { provider: 'codex', startedAt: 20 }),
    session('b', { startedAt: 30 }),
    session('c', { startedAt: 40 })
  ]
  const order = sessionOrder(providers, before).map((s) => s.id)
  assert.deepEqual(order, ['a', 'b', 'c', 'x'])

  // After the restart everything is asleep, in whatever order the list arrives.
  const restored = [before[3], before[1], before[0], before[2]].map((s) => ({ ...s, state: 'asleep' as SessionState, canReceiveOrders: false }))
  assert.deepEqual(
    sessionOrder(providers, restored).map((s) => s.id),
    order
  )
  // Waking the middle one keeps it between its neighbours; a session started now goes last.
  const woken = restored.map((s) => (s.id === 'b' ? { ...s, state: 'starting' as SessionState } : s))
  const withNew = [...woken, session('new', { startedAt: 99 })]
  assert.deepEqual(
    sessionOrder(providers, withNew).map((s) => s.id),
    ['a', 'b', 'c', 'new', 'x']
  )
  const groups = groupSessions(providers, withNew)
  assert.deepEqual(
    groups.map((g) => [g.provider.id, g.sessions.map((s) => `${s.id}:${s.state}`)]),
    [
      ['claude-code', ['a:asleep', 'b:starting', 'c:asleep', 'new:idle']],
      ['codex', ['x:asleep']]
    ]
  )
})

t('an asleep row has a label, takes no orders and no prompts, and does not count as running', () => {
  assert.equal(STATE_LABEL.asleep, 'Asleep')
  const sessions = [session('live'), asleep('zz'), asleep('cx', { provider: 'codex' }), session('gone', { state: 'exited' })]
  const targets = orderTargets(providers, sessions, [])
  assert.deepEqual(
    targets.map((o) => o.value),
    ['all', 'provider:claude-code', 'live']
  )
  assert.deepEqual(targets[0].ids, ['live'])
  // Nothing but asleep rows: only "Everyone", with nobody in it.
  assert.deepEqual(orderTargets(providers, [asleep('zz')], []), [{ value: 'all', label: 'Everyone', group: 'everyone', ids: [] }])

  const c = composerState('asleep', 'Codex')
  assert.equal(c.enabled, false)
  assert.match(c.reason ?? '', /Wake/)

  assert.deepEqual(sessions.map(isLive), [true, false, false, false])
  assert.equal(isLive(session('s', { state: 'starting' })), true)
})

t('which rows can be woken', () => {
  assert.equal(canWakeRow(asleep('a')), true)
  assert.equal(canWakeRow(asleep('a', { wakeable: undefined })), true) // a main process that does not say
  assert.equal(canWakeRow(asleep('a', { wakeable: false })), false) //    no conversation id was saved
  assert.equal(canWakeRow(session('a', { wakeable: true })), false) //    already awake
})

t('what the panel shows for each state', () => {
  assert.equal(panelContent(null), 'empty')
  assert.equal(panelContent(undefined), 'empty')
  assert.equal(panelContent(asleep('a')), 'wake')
  // An asleep chat session shows the wake screen too: no chat is attached to it.
  assert.equal(panelContent(asleep('a', { surface: 'chat' })), 'wake')
  for (const state of ['starting', 'needs-attention', 'idle', 'busy', 'waiting-permission', 'exited'] as const) {
    assert.equal(panelContent(session('a', { state })), 'terminal', state)
    assert.equal(panelContent(session('a', { state, surface: 'chat' })), 'chat', state)
  }
  // The walk of a woken row: wake screen, then its terminal for good.
  assert.deepEqual(
    (['asleep', 'starting', 'idle'] as const).map((state) => panelContent(session('a', { state }))),
    ['wake', 'terminal', 'terminal']
  )
})

t('"Tell it to continue" only for a session that waits for a prompt', () => {
  assert.equal(canContinue(session('a', { state: 'idle' })), true)
  for (const state of ['asleep', 'starting', 'busy', 'waiting-permission', 'needs-attention', 'exited'] as const) {
    assert.equal(canContinue(session('a', { state })), false, state)
  }
})

t('relative "last active" and "ended" labels', () => {
  assert.equal(lastActiveLabel(NOW - 2 * HOUR - 10 * MIN, NOW), 'last active 2 h ago')
  assert.equal(lastActiveLabel(NOW - 12 * MIN, NOW), 'last active 12 min ago')
  assert.equal(lastActiveLabel(NOW - 20_000, NOW), 'last active just now')
  assert.equal(lastActiveLabel(NOW - 26 * HOUR, NOW), 'last active yesterday')
  assert.equal(lastActiveLabel(NOW - 3 * DAY, NOW), 'last active 3 days ago')
  // A clock that jumped: never "in the future".
  assert.equal(lastActiveLabel(NOW + 5 * MIN, NOW), 'last active just now')
  // Unknown: no label at all (the row just says "Asleep").
  assert.equal(lastActiveLabel(undefined, NOW), '')
  assert.equal(lastActiveLabel(0, NOW), '')
  assert.equal(lastActiveLabel(Number.NaN, NOW), '')

  assert.equal(endedLabel(NOW - 3 * HOUR, NOW), 'ended 3 h ago')
  assert.equal(endedLabel(NOW - 40 * MIN, NOW), 'ended 40 min ago')
  assert.equal(endedLabel(undefined, NOW), '')
  // Older than a week: the date.
  assert.match(endedLabel(NOW - 12 * DAY, NOW), /^ended .*\d/)
  assert.ok(!endedLabel(NOW - 12 * DAY, NOW).includes('ago'))
})

t('the launch summary: N restored · M interrupted · K requests lost', () => {
  const closed = NOW - 2 * HOUR
  const three = [
    asleep('a', { interruptedNote: note(closed, ['wants to run `npm test`', 'wants to edit `a.ts`']) }),
    asleep('b'),
    asleep('c', { interruptedNote: note(closed) })
  ]
  const s = restoreSummary(three)!
  assert.equal(s.text, '3 sessions restored · 2 were interrupted · 2 requests were lost')
  assert.deepEqual([s.restored, s.interrupted, s.lost], [3, 2, 2])
  assert.equal(s.firstInterruptedId, 'a')
  assert.equal(s.closedAt, closed)

  // Singular, everywhere.
  assert.equal(restoreSummary([asleep('a', { interruptedNote: note(closed, ['q']) })])!.text, '1 session restored · 1 was interrupted · 1 request was lost')
  // Interrupted with nothing waiting: no "requests" part.
  assert.equal(restoreSummary([asleep('a', { interruptedNote: note(closed) }), asleep('b')])!.text, '2 sessions restored · 1 was interrupted')
  assert.equal(restoreSummary([asleep('a', { interruptedNote: note(closed) }), asleep('b', { interruptedNote: note(closed, ['q']) })])!.text, '2 sessions restored · 2 were interrupted · 1 request was lost')

  // Nothing was interrupted: no summary (the asleep rows speak for themselves).
  assert.equal(restoreSummary([asleep('a'), asleep('b')]), null)
  assert.equal(restoreSummary([]), null)

  // The session that was woken at launch still counts as restored and as interrupted; one started
  // after the app came back does not.
  const mixed = [
    session('woken', { state: 'idle', startedAt: closed - HOUR, interruptedNote: note(closed, ['q']) }),
    session('woken-clean', { state: 'idle', startedAt: closed - 2 * HOUR }),
    asleep('z', { startedAt: closed - 3 * HOUR }),
    session('fresh', { startedAt: closed + HOUR })
  ]
  const m = restoreSummary(mixed)!
  assert.equal(m.text, '3 sessions restored · 1 was interrupted · 1 request was lost')
  assert.equal(m.firstInterruptedId, 'woken')

  // The first interrupted one in the order given (the sidebar order).
  assert.equal(restoreSummary([asleep('a'), asleep('b', { interruptedNote: note(closed) }), asleep('c', { interruptedNote: note(closed + 5) })])!.firstInterruptedId, 'b')
  assert.equal(restoreSummary([asleep('b', { interruptedNote: note(closed) }), asleep('c', { interruptedNote: note(closed + 5) })])!.closedAt, closed + 5)
})

t('the "where you left off" note: headline, lost requests (max 5 + N more), row tag', () => {
  assert.equal(interruptedHeadline(NOW - 2 * HOUR, NOW), 'Agent Office closed while this session was working (2 h ago).')
  assert.equal(interruptedHeadline(NOW - 30_000, NOW), 'Agent Office closed while this session was working (just now).')
  assert.equal(interruptedHeadline(0, NOW), 'Agent Office closed while this session was working.')

  const qs = Array.from({ length: 8 }, (_, i) => ({ question: `question ${i + 1}` }))
  assert.deepEqual(pendingPreview(qs), { shown: ['question 1', 'question 2', 'question 3', 'question 4', 'question 5'], more: 3 })
  assert.deepEqual(pendingPreview(qs.slice(0, 5)), { shown: qs.slice(0, 5).map((q) => q.question), more: 0 })
  assert.deepEqual(pendingPreview(qs.slice(0, 2)), { shown: ['question 1', 'question 2'], more: 0 })
  assert.deepEqual(pendingPreview([]), { shown: [], more: 0 })
  assert.deepEqual(pendingPreview(undefined), { shown: [], more: 0 })
  // Blank questions are not listed (and not counted as "more").
  assert.deepEqual(pendingPreview([{ question: '  ' }, { question: ' a ' }]), { shown: ['a'], more: 0 })

  assert.equal(interruptedTag(note(NOW)), 'Interrupted')
  assert.equal(interruptedTag(note(NOW, ['q'])), 'Interrupted · 1 request lost')
  assert.equal(interruptedTag(note(NOW, ['q', 'r'])), 'Interrupted · 2 requests lost')
})

t('selection at launch: the saved one, else the first interrupted, else the last active asleep row', () => {
  const closed = NOW - HOUR
  const rows = [
    asleep('a', { lastActiveAt: NOW - 5 * HOUR }),
    asleep('b', { lastActiveAt: NOW - 2 * HOUR }),
    asleep('c', { lastActiveAt: NOW - 3 * HOUR, interruptedNote: note(closed) })
  ]
  // Still there: selected again, asleep or not.
  assert.equal(restoreSelection('a', rows), 'a')
  assert.equal(restoreSelection('live', [...rows, session('live')]), 'live')
  // The saved id no longer exists (removed, or forgotten): the interrupted one.
  assert.equal(restoreSelection('gone', rows), 'c')
  assert.equal(restoreSelection(null, rows), 'c')
  assert.equal(restoreSelection(42, rows), 'c')
  // Nothing interrupted: the asleep row that was active last.
  assert.equal(restoreSelection('gone', rows.slice(0, 2)), 'b')
  assert.equal(restoreSelection('gone', [asleep('x', { startedAt: 5 }), asleep('y', { startedAt: 9 })]), 'y')
  // No restored rows: nothing is selected by itself (as before).
  assert.equal(restoreSelection('gone', [session('live'), session('other', { state: 'exited' })]), null)
  assert.equal(restoreSelection('gone', []), null)
  assert.equal(restoreSelection(null, []), null)
})

t('Recent list: newest first, optimistic forget, rollback, late answers', () => {
  const items = [saved('old', { lastActiveAt: NOW - 3 * DAY }), saved('new', { lastActiveAt: NOW - HOUR }), saved('mid', { lastActiveAt: NOW - DAY })]
  let s: RecentState = recentReducer(EMPTY_RECENT, { type: 'loaded', items })
  assert.deepEqual(visibleRecent(s).map((x) => x.id), ['new', 'mid', 'old'])
  assert.equal(s.forgetting.size, 0)

  // Forget: gone at once, the stored list untouched.
  const before = s
  s = recentReducer(s, { type: 'forget', id: 'mid' })
  assert.deepEqual(visibleRecent(s).map((x) => x.id), ['new', 'old'])
  assert.equal(s.items, before.items)
  // Twice, or for an unknown entry: the same state object (no re-render).
  assert.equal(recentReducer(s, { type: 'forget', id: 'mid' }), s)
  assert.equal(recentReducer(s, { type: 'forget', id: 'nope' }), s)

  // A list answer from before the forget still has the entry: it stays hidden.
  const stale = recentReducer(s, { type: 'loaded', items })
  assert.deepEqual(visibleRecent(stale).map((x) => x.id), ['new', 'old'])
  assert.equal(stale.forgetting, s.forgetting)

  // The main process refused: it is back, in its old place.
  const back = recentReducer(s, { type: 'rollback', id: 'mid' })
  assert.deepEqual(visibleRecent(back).map((x) => x.id), ['new', 'mid', 'old'])
  assert.equal(back.forgetting.size, 0)
  assert.equal(recentReducer(back, { type: 'rollback', id: 'mid' }), back)

  // Confirmed: gone from the list and from the pending set.
  const done = recentReducer(s, { type: 'forgotten', id: 'mid' })
  assert.deepEqual(done.items.map((x) => x.id), ['old', 'new'])
  assert.equal(done.forgetting.size, 0)
  // A rollback that arrives after the confirmation changes nothing.
  assert.equal(recentReducer(done, { type: 'rollback', id: 'mid' }), done)

  // A fresh list without the entry clears the pending forget as well.
  const fresh = recentReducer(s, { type: 'loaded', items: items.filter((x) => x.id !== 'mid') })
  assert.equal(fresh.forgetting.size, 0)
  assert.deepEqual(visibleRecent(fresh).map((x) => x.id), ['new', 'old'])

  // Reopened: it is a live session now.
  const reopened = recentReducer(back, { type: 'reopened', id: 'new' })
  assert.deepEqual(visibleRecent(reopened).map((x) => x.id), ['mid', 'old'])
  assert.equal(recentReducer(reopened, { type: 'reopened', id: 'new' }), reopened)

  // A broken answer never breaks the list.
  const junk = recentReducer(EMPTY_RECENT, { type: 'loaded', items: [null, { nope: 1 }, saved('ok')] as unknown as SavedSession[] })
  assert.deepEqual(visibleRecent(junk).map((x) => x.id), ['ok'])
})

t('the "when the app opens" setting reads short in the status bar', () => {
  assert.equal(restoreModeShort('last'), 'wake last')
  assert.equal(restoreModeShort('all'), 'wake all')
  assert.equal(restoreModeShort('none'), 'wake none')
  assert.equal(restoreModeShort(undefined), 'wake last')
})

console.log(`\n${pass} restore ui tests passed`)
