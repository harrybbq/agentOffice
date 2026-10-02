// Progress bars, main-process side (shared/progress.ts): the tracker (plans, helpers, run
// boundaries, orders), the Claude plan reader against hook payloads of the shapes seen with the real
// CLI (docs/progress-notes.md), and the drivers feeding it (a hosted Claude session through its
// hooks, the fake Codex app-server's `turn/plan/updated`, the fake agy). Runs with `npm test`
// (chained from inspector.test.ts).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, Activity } from '../shared/events.ts'
import {
  ORDER_RETAIN_MS,
  ORDERS_MAX,
  PROGRESS_HOLD_MS,
  PROGRESS_MAX_STEPS,
  PROGRESS_PUSH_MS,
  PROGRESS_TEXT_CHARS,
  type ProgressSnapshot,
  type ProgressStep,
  type SessionProgress
} from '../shared/progress.ts'
import { ClaudeHookMapper } from '../electron/adapters/claude-code-hooks.ts'
import { ClaudePlan, createdTaskId, listedTasks, todoSteps } from '../electron/adapters/claudePlan.ts'
import { agyProvider } from '../electron/drivers/agy.ts'
import { createAgyHooksAdapter } from '../electron/drivers/agyHookBridge.ts'
import { claudeProvider } from '../electron/drivers/claude.ts'
import { codexProvider } from '../electron/drivers/codex.ts'
import { planSteps } from '../electron/drivers/codexChat.ts'
import type { CodexSpawnSpec } from '../electron/drivers/codexServer.ts'
import type { PtyHandlers, PtyHost, ScreenSnapshot } from '../electron/drivers/types.ts'
import { SessionTokens } from '../electron/ingest/auth.ts'
import { startIngestServer } from '../electron/ingest/server.ts'
import { ORDER_QUEUED_TIMEOUT_MS, ProgressTracker, progressText, stepStatus } from '../electron/progress.ts'
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

function tracker(opts: { maxOrders?: number } = {}) {
  const time = fakeTime()
  const pushes: ProgressSnapshot[] = []
  const p = new ProgressTracker({ now: time.now, schedule: time.schedule, onChanged: (s) => void pushes.push(s), ...opts })
  /** A session that is up and idle. */
  const add = (id: string, title = id): void => {
    p.session(id, title)
    p.state(id, 'starting')
    p.state(id, 'idle')
  }
  /** A real prompt, then the turn starts. */
  const prompt = (id: string): void => {
    p.prompt(id)
    p.state(id, 'busy')
  }
  /** The turn ends, then the session goes idle. */
  const end = (id: string, how: 'completed' | 'interrupted' | 'failed' = 'completed'): void => {
    p.signal(id, { kind: 'turn-end', how })
    p.state(id, 'idle')
  }
  const worker = (parent: string, id: string, activity: Activity): void =>
    p.event({ agentId: `${parent}:${id}`, parentId: parent, provider: 'claude-code', displayName: id, activity, detail: '', ts: 0 })
  const of = (id: string): SessionProgress => {
    const s = p.get(id)
    assert.ok(s, `progress of ${id}`)
    return s
  }
  /** kind done/total [current] [stopped] [finished] */
  const line = (id: string): string => {
    const s = of(id)
    return [`${s.kind} ${s.done}/${s.total}`, s.current ? `[${s.current}]` : '', s.stopped ? `stopped:${s.stopped}` : '', s.finishedAt !== undefined ? 'finished' : ''].filter(Boolean).join(' ')
  }
  return { time, p, pushes, add, prompt, end, worker, of, line }
}

const steps = (...list: string[]): ProgressStep[] =>
  list.map((s) => {
    const mark = s[0]
    return { text: s.slice(1), status: mark === 'x' ? 'completed' : mark === '>' ? 'in-progress' : 'pending' }
  })

// ---- the tracker: plans ------------------------------------------------------------------------------

await t('progress: no count, no percentage: a busy session without a plan is "working", an idle one "idle"', () => {
  const { p, add, prompt, end, line, of } = tracker()
  assert.equal(p.get('s1'), null)
  p.session('s1', 'Sonnet')
  assert.equal(p.get('s1'), null) // no state yet: nothing to show
  add('s1')
  assert.equal(line('s1'), 'idle 0/0')
  prompt('s1')
  assert.equal(line('s1'), 'working 0/0')
  assert.equal(of('s1').steps, undefined)
  p.state('s1', 'waiting-permission')
  assert.equal(line('s1'), 'working 0/0')
  p.state('s1', 'busy')
  end('s1')
  assert.equal(line('s1'), 'idle 0/0')
  // An interrupted turn with nothing to count leaves nothing behind either.
  prompt('s1')
  p.state('s1', 'idle')
  assert.equal(line('s1'), 'idle 0/0')
  // Asleep or gone: no progress at all.
  p.state('s1', 'exited')
  assert.equal(p.get('s1'), null)
  assert.deepEqual(p.snapshot(), { sessions: [], orders: [] })
})

await t('progress: a plan makes the bar determinate; each plan replaces the last; the step in progress is "current"', () => {
  const { p, time, add, prompt, of, line } = tracker()
  add('s1')
  prompt('s1')
  const started = time.now()
  time.advance(2 * SEC)
  p.signal('s1', { kind: 'plan', steps: steps('>Create a.txt', ' Create b.txt', ' List the folder') })
  assert.equal(line('s1'), 'plan 0/3 [Create a.txt]')
  assert.deepEqual(of('s1').steps, [
    { text: 'Create a.txt', status: 'in-progress' },
    { text: 'Create b.txt', status: 'pending' },
    { text: 'List the folder', status: 'pending' }
  ])
  assert.deepEqual([of('s1').startedAt, of('s1').updatedAt], [started, started + 2 * SEC])
  p.signal('s1', { kind: 'plan', steps: steps('xCreate a.txt', '>Create b.txt', ' List the folder') })
  assert.equal(line('s1'), 'plan 1/3 [Create b.txt]')
  // Replace semantics: a shorter list is the list.
  p.signal('s1', { kind: 'plan', steps: steps('xCreate a.txt', 'xCreate b.txt') })
  assert.equal(line('s1'), 'plan 2/2')
  // An empty list clears it: back to "working".
  p.signal('s1', { kind: 'plan', steps: [] })
  assert.equal(line('s1'), 'working 0/0')
  // Fresh copies: a caller can't change what the tracker holds.
  p.signal('s1', { kind: 'plan', steps: steps('>One', ' Two') })
  of('s1').steps![0].text = 'changed'
  assert.equal(of('s1').steps![0].text, 'One')
})

await t('progress: step texts are one line and capped, statuses are tolerant, the list is capped while the count is not', () => {
  const { p, add, prompt, of } = tracker()
  add('s1')
  prompt('s1')
  const many = Array.from({ length: 45 }, (_, i) => ({ text: `Step ${i + 1}`, status: i < 40 ? 'completed' : 'pending' }) as ProgressStep)
  p.signal('s1', { kind: 'plan', steps: many })
  assert.deepEqual([of('s1').done, of('s1').total, of('s1').steps!.length], [40, 45, PROGRESS_MAX_STEPS])
  p.signal('s1', {
    kind: 'plan',
    steps: [
      { text: `Line one\nline two\t${'x'.repeat(300)}`, status: 'in_progress' as never },
      { text: '   ', status: 'DONE' as never },
      { text: 'Third', status: 'whatever' as never },
      null as never
    ]
  })
  const s = of('s1')
  assert.equal(s.steps![0].text.length, PROGRESS_TEXT_CHARS)
  assert.ok(s.steps![0].text.startsWith('Line one line two x'))
  assert.equal(s.current, s.steps![0].text)
  assert.deepEqual(s.steps!.slice(1), [{ text: 'Step', status: 'completed' }, { text: 'Third', status: 'pending' }])
  assert.deepEqual([s.done, s.total], [1, 3])
  // Not a signal at all: ignored.
  p.signal('s1', { kind: 'plan', steps: 'no' as never })
  p.signal('s1', { kind: 'turn-end', how: 'sideways' as never })
  p.signal('s1', null as never)
  assert.equal(of('s1').total, 3)

  assert.equal(progressText('  a\n\nb  '), 'a b')
  assert.equal(progressText(7), '')
  assert.deepEqual(['in_progress', 'inProgress', 'in-progress', 'completed', 'done', 'pending', '', undefined].map(stepStatus), ['in-progress', 'in-progress', 'in-progress', 'completed', 'completed', 'pending', 'pending', 'pending'])
})

// ---- the tracker: run boundaries --------------------------------------------------------------------

await t('progress: a finished plan is held at 100 % for 8 s, then the session is idle', () => {
  const { p, time, pushes, add, prompt, end, line, of } = tracker()
  add('s1')
  prompt('s1')
  p.signal('s1', { kind: 'plan', steps: steps('xA', 'xB', '>C') })
  assert.equal(line('s1'), 'plan 2/3 [C]')
  p.signal('s1', { kind: 'plan', steps: steps('xA', 'xB', 'xC') })
  // All steps done, the turn still runs (the summary is being written): 3/3, not finished yet.
  assert.equal(line('s1'), 'plan 3/3')
  time.advance(3 * SEC)
  end('s1')
  assert.equal(line('s1'), 'plan 3/3 finished')
  assert.equal(of('s1').finishedAt, time.now())
  time.advance(PROGRESS_HOLD_MS - 1)
  assert.equal(line('s1'), 'plan 3/3 finished')
  const before = pushes.length
  time.advance(1)
  assert.equal(line('s1'), 'idle 0/0')
  // ... and the renderer is told (the timer pushes by itself).
  time.advance(PROGRESS_PUSH_MS)
  assert.ok(pushes.length > before)
  assert.equal(pushes.at(-1)!.sessions[0].kind, 'idle')
})

await t('progress: a new prompt starts a new run; an unfinished plan stays until the new run writes its own', () => {
  const { p, time, add, prompt, end, line, of } = tracker()
  add('s1')
  prompt('s1')
  const first = time.now()
  p.signal('s1', { kind: 'plan', steps: steps('xA', '>B', ' C') })
  time.advance(5 * SEC)
  // The turn ends with steps left and nobody working on them: stopped where it is ("paused").
  end('s1')
  assert.equal(line('s1'), 'plan 1/3 [B] stopped:paused')
  time.advance(60 * SEC)
  assert.equal(line('s1'), 'plan 1/3 [B] stopped:paused') // until the next prompt
  // "continue": a new run; the list it carries on with is still there, and live again.
  prompt('s1')
  assert.equal(line('s1'), 'plan 1/3 [B]')
  assert.equal(of('s1').startedAt, first + 65 * SEC)
  p.signal('s1', { kind: 'plan', steps: steps('>New one', ' New two') })
  assert.equal(line('s1'), 'plan 0/2 [New one]')
  p.signal('s1', { kind: 'plan', steps: steps('xNew one', 'xNew two') })
  end('s1')
  assert.equal(line('s1'), 'plan 2/2 finished')
  // A prompt during the hold: the finished list is over at once.
  time.advance(2 * SEC)
  prompt('s1')
  assert.equal(line('s1'), 'working 0/0')
  time.advance(PROGRESS_HOLD_MS)
  assert.equal(line('s1'), 'working 0/0')
  // A prompt taken into the running turn is not a new run (the manager does not report it): a state
  // that stays busy changes nothing.
  p.signal('s1', { kind: 'plan', steps: steps('>Only') })
  const at = of('s1').startedAt
  time.advance(SEC)
  p.state('s1', 'busy')
  assert.deepEqual([line('s1'), of('s1').startedAt], ['plan 0/1 [Only]', at])
})

await t('progress: an interrupted or failed turn keeps the bar where it was, marked stopped, until the next prompt', () => {
  const { p, time, add, prompt, end, line } = tracker()
  add('s1')
  prompt('s1')
  p.signal('s1', { kind: 'plan', steps: steps('xA', '>B', ' C', ' D') })
  // Claude after Esc: no Stop hook, the session just goes idle.
  p.state('s1', 'idle')
  assert.equal(line('s1'), 'plan 1/4 [B] stopped:interrupted')
  time.advance(PROGRESS_HOLD_MS * 4)
  assert.equal(line('s1'), 'plan 1/4 [B] stopped:interrupted')
  // Codex / agy say how the turn ended.
  prompt('s1')
  assert.equal(line('s1'), 'plan 1/4 [B]')
  end('s1', 'failed')
  assert.equal(line('s1'), 'plan 1/4 [B] stopped:failed')
  prompt('s1')
  end('s1', 'interrupted')
  assert.equal(line('s1'), 'plan 1/4 [B] stopped:interrupted')
  // Even a complete list is not "finished" when the turn was cut short.
  prompt('s1')
  p.signal('s1', { kind: 'plan', steps: steps('xA', 'xB') })
  end('s1', 'interrupted')
  assert.equal(line('s1'), 'plan 2/2 stopped:interrupted')
  // The next prompt clears a list that was complete.
  prompt('s1')
  assert.equal(line('s1'), 'working 0/0')
})

await t('progress: working again without a new prompt (a hand-back) carries the same run on', () => {
  const { p, time, add, prompt, end, line, of } = tracker()
  add('s1')
  prompt('s1')
  const started = of('s1').startedAt
  p.signal('s1', { kind: 'plan', steps: steps('xA', 'xB') })
  end('s1')
  assert.equal(line('s1'), 'plan 2/2 finished')
  time.advance(2 * SEC)
  // A task notification wakes the manager during the hold: the list is live again, not gone.
  p.state('s1', 'busy')
  assert.equal(line('s1'), 'plan 2/2')
  assert.equal(of('s1').startedAt, started)
  time.advance(PROGRESS_HOLD_MS)
  assert.equal(line('s1'), 'plan 2/2') // the old hold timer did not fire into the live run
  p.signal('s1', { kind: 'plan', steps: steps('xA', 'xB', '>C') })
  end('s1')
  assert.equal(line('s1'), 'plan 2/3 [C] stopped:paused')
  p.state('s1', 'busy')
  assert.equal(line('s1'), 'plan 2/3 [C]')
})

// ---- the tracker: helpers ---------------------------------------------------------------------------

await t('progress: without a plan, helpers spawned during the run are the count (finished / spawned)', () => {
  const { p, time, add, prompt, end, worker, line } = tracker()
  add('s1')
  // A helper seen while the manager is idle and no run is on belongs to no run.
  worker('s1', 'old', 'read')
  assert.equal(line('s1'), 'idle 0/0')
  prompt('s1')
  worker('s1', 'a', 'idle')
  worker('s1', 'a', 'read') // the same helper again: not another one
  worker('s1', 'b', 'exec')
  worker('s1', 'c', 'idle')
  assert.equal(line('s1'), 'workers 0/3')
  worker('s1', 'a', 'done')
  worker('s1', 'a', 'done')
  worker('s1', 'old', 'done') // never counted, so its end is not either
  assert.equal(line('s1'), 'workers 1/3')
  // Somebody else's helper, a manager's own event, a malformed one: ignored.
  worker('s2', 'x', 'read')
  p.event({ agentId: 's1', parentId: null, provider: 'claude-code', displayName: 's1', activity: 'exec', detail: '', ts: 0 })
  p.event({ agentId: 's1', parentId: 's1', provider: 'x', displayName: 'x', activity: 'exec', detail: '', ts: 0 })
  p.event(null as never)
  assert.equal(line('s1'), 'workers 1/3')
  // A plan wins over the helpers; without it they are back.
  p.signal('s1', { kind: 'plan', steps: steps('>A', ' B') })
  assert.equal(line('s1'), 'plan 0/2 [A]')
  p.signal('s1', { kind: 'plan', steps: [] })
  assert.equal(line('s1'), 'workers 1/3')
  worker('s1', 'b', 'done')
  worker('s1', 'c', 'done')
  assert.equal(line('s1'), 'workers 3/3')
  end('s1')
  assert.equal(line('s1'), 'workers 3/3 finished')
  time.advance(PROGRESS_HOLD_MS)
  assert.equal(line('s1'), 'idle 0/0')
  // The next run counts from zero. A helper that was seen outside a run stays uncounted when it
  // does something during one.
  worker('s1', 'stray', 'read')
  prompt('s1')
  assert.equal(line('s1'), 'working 0/0')
  worker('s1', 'stray', 'exec')
  assert.equal(line('s1'), 'working 0/0')
  worker('s1', 'd', 'read')
  assert.equal(line('s1'), 'workers 0/1')
  // Interrupted with a helper still out: stopped.
  p.state('s1', 'idle')
  assert.equal(line('s1'), 'workers 0/1 stopped:interrupted')
})

await t('progress: helpers still at it after the turn ended (Claude background agents) keep the bar live until the last one is back', () => {
  const { p, add, prompt, end, worker, line } = tracker()
  add('s1')
  prompt('s1')
  worker('s1', 'a', 'read')
  worker('s1', 'b', 'read')
  worker('s1', 'a', 'done')
  end('s1') // the manager's own turn is over; b is still working
  assert.equal(line('s1'), 'workers 1/2')
  worker('s1', 'c', 'read') // spawned by a helper's hand-back while the run is still on
  assert.equal(line('s1'), 'workers 1/3')
  worker('s1', 'b', 'done')
  assert.equal(line('s1'), 'workers 2/3')
  worker('s1', 'c', 'done')
  assert.equal(line('s1'), 'workers 3/3 finished')
  // With a plan that has steps left, the last helper coming back leaves it paused.
  prompt('s1')
  p.signal('s1', { kind: 'plan', steps: steps('xA', '>B') })
  worker('s1', 'd', 'read')
  end('s1')
  assert.equal(line('s1'), 'plan 1/2 [B]')
  worker('s1', 'd', 'done')
  assert.equal(line('s1'), 'plan 1/2 [B] stopped:paused')
  // A helper of the last run that is still out when the next prompt comes is not the new run's:
  // not counted, and its end changes nothing.
  prompt('s1')
  p.signal('s1', { kind: 'plan', steps: [] })
  worker('s1', 'e', 'read')
  end('s1')
  assert.equal(line('s1'), 'workers 0/1')
  prompt('s1')
  assert.equal(line('s1'), 'working 0/0')
  worker('s1', 'e', 'exec')
  assert.equal(line('s1'), 'working 0/0')
  worker('s1', 'f', 'read')
  worker('s1', 'e', 'done')
  assert.equal(line('s1'), 'workers 0/1')
  worker('s1', 'f', 'done')
  end('s1')
  assert.equal(line('s1'), 'workers 1/1 finished')
})

// ---- the tracker: orders ------------------------------------------------------------------------------

await t('orders: each session is working until its manager goes idle after the order; done/total counts sessions', () => {
  const { p, time, add, prompt, end, of } = tracker()
  for (const id of ['a', 'b', 'c']) add(id, `Team ${id.toUpperCase()}`)
  assert.equal(p.order({ text: 'x', target: 'all', sentAt: time.now(), delivered: [] }), null)
  assert.equal(p.order({ text: 'x', target: 'all', sentAt: time.now(), delivered: ['nobody'] }), null)

  const sentAt = time.now()
  prompt('a') // a took it and is working by the time the delivery is over
  p.state('b', 'busy')
  p.state('b', 'waiting-permission')
  const id = p.order({ text: `  Add a\nREADME ${'y'.repeat(200)}`, target: 'all', sentAt, delivered: ['a', 'b', 'c', 'a'] })!
  let o = p.snapshot().orders[0]
  assert.equal(o.id, id)
  assert.equal(o.text.length, PROGRESS_TEXT_CHARS)
  assert.ok(o.text.startsWith('Add a README y'))
  assert.deepEqual([o.target, o.sentAt, o.done, o.total, o.finishedAt], ['all', sentAt, 0, 3, undefined])
  assert.deepEqual(o.sessions.map((s) => `${s.sessionId}|${s.title}|${s.state}|${s.progress?.kind ?? '-'}`), ['a|Team A|working|working', 'b|Team B|waiting|working', 'c|Team C|queued|-'])

  // c starts, b is answered, a writes a plan: each row carries that session's own progress.
  prompt('c')
  p.state('b', 'busy')
  p.signal('a', { kind: 'plan', steps: steps('xOne', '>Two') })
  o = p.snapshot().orders[0]
  assert.deepEqual(o.sessions.map((s) => `${s.sessionId}|${s.state}|${s.progress?.kind}|${s.progress?.done}/${s.progress?.total}`), ['a|working|plan|1/2', 'b|working|working|0/0', 'c|working|working|0/0'])
  assert.deepEqual(o.sessions[0].progress, of('a'))

  end('b')
  o = p.snapshot().orders[0]
  assert.deepEqual([o.done, o.total, o.finishedAt, o.sessions[1].state, o.sessions[1].progress], [1, 3, undefined, 'done', undefined])
  // A session renamed meanwhile goes by its new name in the order too.
  p.session('c', 'Team Carol')
  assert.equal(p.snapshot().orders[0].sessions[2].title, 'Team Carol')

  p.signal('a', { kind: 'plan', steps: steps('xOne', 'xTwo') })
  end('a')
  end('c')
  o = p.snapshot().orders[0]
  assert.deepEqual([o.done, o.total, o.finishedAt], [3, 3, time.now()])
  assert.deepEqual(o.sessions.map((s) => s.state), ['done', 'done', 'done'])
  assert.equal(o.sessions[0].progress?.finishedAt, time.now()) // a's finished list is still on show
  // A later turn of a session does not reopen a finished order.
  prompt('b')
  assert.equal(p.snapshot().orders[0].sessions[1].state, 'done')
  // Finished orders stay for 30 s.
  time.advance(ORDER_RETAIN_MS - 1)
  assert.equal(p.snapshot().orders.length, 1)
  time.advance(1)
  assert.deepEqual(p.snapshot().orders, [])
})

await t('orders: a failed delivery, a session that exits, a turn cut short and a session that never starts are "failed"', () => {
  const { p, time, add, prompt, end, worker } = tracker()
  for (const id of ['a', 'b', 'c', 'd', 'e']) add(id)
  const sentAt = time.now()
  for (const id of ['a', 'b', 'c']) prompt(id)
  p.order({
    text: 'Ship it',
    target: 'provider:claude-code',
    sentAt,
    delivered: ['a', 'b', 'c', 'd'],
    failed: [
      { sessionId: 'e', reason: 'the session is not ready yet (check its terminal)' },
      { sessionId: 'unknown', reason: 'x' },
      { sessionId: 'a', reason: 'both delivered and failed: delivered wins' }
    ]
  })
  const rows = (): string[] => p.snapshot().orders[0].sessions.map((s) => `${s.sessionId}|${s.state}|${s.reason ?? ''}`)
  assert.deepEqual(rows(), ['a|working|', 'b|working|', 'c|working|', 'd|queued|', 'e|failed|the session is not ready yet (check its terminal)'])
  assert.deepEqual([p.snapshot().orders[0].done, p.snapshot().orders[0].total], [0, 5])

  p.state('a', 'exited')
  end('b', 'interrupted')
  // c: its own turn is over, a helper is still working on it: not done yet.
  worker('c', 'w', 'read')
  end('c')
  assert.deepEqual(rows().slice(0, 3), ['a|failed|the session ended', 'b|failed|interrupted', 'c|working|'])
  worker('c', 'w', 'done')
  assert.equal(rows()[2], 'c|done|')
  assert.equal(p.snapshot().orders[0].finishedAt, undefined)
  // d never starts on it.
  time.advance(ORDER_QUEUED_TIMEOUT_MS)
  assert.equal(rows()[3], 'd|failed|did not start')
  const o = p.snapshot().orders[0]
  assert.deepEqual([o.done, o.total, o.finishedAt], [1, 5, time.now()])

  // A turn that failed; a session removed from the list while it worked.
  add('f')
  add('g')
  prompt('f')
  prompt('g')
  p.order({ text: 'Again', target: 'all', sentAt: time.now(), delivered: ['f', 'g'] })
  end('f', 'failed')
  p.forget('g')
  assert.deepEqual(p.snapshot().orders[1].sessions.map((s) => `${s.sessionId}|${s.title}|${s.state}|${s.reason}`), ['f|f|failed|the turn failed', 'g|g|failed|the session ended'])
  assert.equal(p.get('g'), null)
})

await t('orders: a session that started and finished before the delivery to the others was over is done; one session is tracked too', () => {
  const { p, time, add, prompt, end } = tracker()
  add('a')
  add('b')
  const sentAt = time.now()
  time.advance(100)
  prompt('a')
  end('a') // a one-line answer, finished while b's delivery was still being confirmed
  time.advance(5 * SEC)
  prompt('b')
  p.order({ text: 'Say hi', target: 'all', sentAt, delivered: ['a', 'b'] })
  assert.deepEqual(p.snapshot().orders[0].sessions.map((s) => s.state), ['done', 'working'])
  // A turn from before the order does not count as "started on it".
  add('c')
  prompt('c')
  end('c')
  time.advance(SEC)
  const one = p.order({ text: 'Only you', target: 'c', sentAt: time.now(), delivered: ['c'] })!
  const o = p.snapshot().orders.find((x) => x.id === one)!
  assert.deepEqual([o.target, o.total, o.sessions[0].state], ['c', 1, 'queued'])
  prompt('c')
  end('c')
  assert.deepEqual(p.snapshot().orders.find((x) => x.id === one)!.sessions[0].state, 'done')
})

await t('orders: at most five are kept (finished ones go first), and one can be dismissed', () => {
  const { p, time, add, prompt, end } = tracker()
  add('a')
  add('b')
  prompt('a')
  const ids: string[] = []
  for (let i = 0; i < ORDERS_MAX; i++) ids.push(p.order({ text: `Order ${i}`, target: 'a', sentAt: time.now(), delivered: ['a'] })!)
  assert.equal(new Set(ids).size, ORDERS_MAX)
  assert.deepEqual(p.snapshot().orders.map((o) => o.text), ['Order 0', 'Order 1', 'Order 2', 'Order 3', 'Order 4'])
  // All running: the oldest makes room.
  ids.push(p.order({ text: 'Order 5', target: 'a', sentAt: time.now(), delivered: ['a'] })!)
  assert.deepEqual(p.snapshot().orders.map((o) => o.text), ['Order 1', 'Order 2', 'Order 3', 'Order 4', 'Order 5'])
  // A finished one goes before a running one, however new it is.
  prompt('b')
  p.order({ text: 'For b', target: 'b', sentAt: time.now(), delivered: ['b'] })
  assert.deepEqual(p.snapshot().orders.map((o) => o.text), ['Order 2', 'Order 3', 'Order 4', 'Order 5', 'For b'])
  end('b')
  assert.ok(p.snapshot().orders.at(-1)!.finishedAt !== undefined)
  p.order({ text: 'Order 6', target: 'a', sentAt: time.now(), delivered: ['a'] })
  assert.deepEqual(p.snapshot().orders.map((o) => o.text), ['Order 2', 'Order 3', 'Order 4', 'Order 5', 'Order 6'])

  assert.equal(p.dismissOrder(ids[2]), true)
  assert.equal(p.dismissOrder(ids[2]), false)
  assert.equal(p.dismissOrder('nope'), false)
  assert.equal(p.dismissOrder(7), false)
  assert.deepEqual(p.snapshot().orders.map((o) => o.text), ['Order 3', 'Order 4', 'Order 5', 'Order 6'])
  // Dismissed and dropped orders leave no timers behind that could bring anything back.
  end('a')
  time.advance(ORDER_RETAIN_MS)
  assert.deepEqual(p.snapshot().orders, [])
  p.dispose()
  assert.equal(time.pending(), 0)
})

await t('progress: pushes are coalesced, at most one per 250 ms, the full snapshot, and none when nothing changed', () => {
  const { p, time, pushes, add, prompt } = tracker()
  add('s1')
  prompt('s1')
  p.signal('s1', { kind: 'plan', steps: steps('>A', ' B') })
  assert.equal(pushes.length, 0) // never synchronously
  time.advance(0)
  assert.equal(pushes.length, 1)
  assert.deepEqual(pushes[0].sessions.map((s) => `${s.sessionId}|${s.kind}|${s.done}/${s.total}`), ['s1|plan|0/2'])
  // A burst right after: one push, PROGRESS_PUSH_MS after the last one.
  p.signal('s1', { kind: 'plan', steps: steps('xA', '>B') })
  p.signal('s1', { kind: 'plan', steps: steps('xA', 'xB') })
  time.advance(PROGRESS_PUSH_MS - 1)
  assert.equal(pushes.length, 1)
  time.advance(1)
  assert.equal(pushes.length, 2)
  assert.equal(pushes[1].sessions[0].done, 2)
  // The same plan again is not news.
  p.signal('s1', { kind: 'plan', steps: steps('xA', 'xB') })
  p.session('s1', 's1')
  time.advance(10 * SEC)
  assert.equal(pushes.length, 2)
  // Each push is a fresh object.
  pushes[1].sessions[0].done = 99
  assert.equal(p.get('s1')!.done, 2)
  // A throwing listener is not the tracker's problem.
  const bad = new ProgressTracker({ now: time.now, schedule: time.schedule, onChanged: () => { throw new Error('window gone') } })
  bad.session('x', 'x')
  bad.state('x', 'idle')
  time.advance(SEC)
})

// ---- Claude: the plan in the hook payloads ----------------------------------------------------------------

/** A mapper + plan reader for one hosted session, fed with hook payloads. */
function claudePlan(rootId = 'root') {
  const mapper = new ClaudeHookMapper({ rootId, displayName: 'Haiku', holdWaiting: true, endsWithProcess: true })
  const plan = new ClaudePlan(rootId)
  const hook = (name: string, extra: Record<string, unknown> = {}): ProgressStep[] | null => {
    const body = { session_id: 'sid', cwd: 'C:\\work', hook_event_name: name, ...extra }
    return plan.observe(body, mapper.handle(body))
  }
  const view = (s: ProgressStep[] | null): string[] | null => (s ? s.map((x) => `${x.status === 'completed' ? 'x' : x.status === 'in-progress' ? '>' : ' '}${x.text}`) : null)
  return { hook, view }
}

await t('claude plan: TodoWrite replaces the whole list each time (the input is the list; the response repeats it)', () => {
  const { hook, view } = claudePlan()
  const todos = (a: string, b: string, c: string) => [
    { content: 'Create a.txt', status: a, activeForm: 'Creating a.txt' },
    { content: 'Create b.txt', status: b, activeForm: 'Creating b.txt' },
    { content: 'List the folder', status: c, activeForm: 'Listing the folder' }
  ]
  assert.deepEqual(view(hook('PreToolUse', { tool_name: 'TodoWrite', tool_use_id: 't1', tool_input: { todos: todos('in_progress', 'pending', 'pending') } })), ['>Create a.txt', ' Create b.txt', ' List the folder'])
  // PostToolUse of the same call: nothing new.
  assert.equal(hook('PostToolUse', { tool_name: 'TodoWrite', tool_use_id: 't1', tool_input: { todos: todos('in_progress', 'pending', 'pending') }, tool_response: { oldTodos: [], newTodos: todos('in_progress', 'pending', 'pending') } }), null)
  assert.deepEqual(view(hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: todos('completed', 'in_progress', 'pending') } })), ['xCreate a.txt', '>Create b.txt', ' List the folder'])
  // Another tool in between says nothing about the plan.
  assert.equal(hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'C:\\work\\b.txt', content: 'b' } }), null)
  assert.equal(hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: 'C:\\work\\b.txt' }, tool_response: { type: 'create' } }), null)
  // A shorter list replaces the longer one.
  assert.deepEqual(view(hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Only this', status: 'completed' }] } })), ['xOnly this'])
  // A subagent's own list does not replace the manager's.
  assert.equal(hook('PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Sub step', status: 'pending' }] } }), null)
  // Unreadable input: the list stays as it was last known.
  assert.equal(hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: 'three steps' } }), null)
  assert.equal(hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [7, null] } }), null)
  assert.equal(hook('PreToolUse', { tool_name: 'TodoWrite' }), null)
  // A failed call changed nothing.
  assert.equal(hook('PostToolUseFailure', { tool_name: 'TodoWrite', tool_input: { todos: [] }, error: 'x' }), null)
  // An empty list clears it.
  assert.deepEqual(hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [] } }), [])

  assert.deepEqual(todoSteps([{ content: 'A', status: 'in-progress' }, { activeForm: 'Doing B', status: 'completed' }, { status: 'pending' }]), [
    { text: 'A', status: 'in-progress' },
    { text: 'Doing B', status: 'completed' }
  ])
  assert.equal(todoSteps({}), null)
})

await t('claude plan: the task tools keep a list by id (create, update, delete, list), from PostToolUse', () => {
  const { hook, view } = claudePlan()
  const create = (subject: string, response: unknown, extra: Record<string, unknown> = {}) =>
    hook('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject, description: `${subject} in the folder`, activeForm: `${subject}…`, ...extra }, tool_response: response })
  const update = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    hook('PostToolUse', { tool_name: 'TaskUpdate', tool_input: input, tool_response: { success: true, taskId: input.taskId, updatedFields: ['status'], statusChange: { from: 'pending', to: input.status } }, ...extra })

  // PreToolUse knows no id yet: the list changes when the call has run.
  assert.equal(hook('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Create a.txt' } }), null)
  assert.deepEqual(view(create('Create a.txt', { task: { id: '1', subject: 'Create a.txt' } })), [' Create a.txt'])
  assert.deepEqual(view(create('Create b.txt', { task: { id: '2', subject: 'Create b.txt' } })), [' Create a.txt', ' Create b.txt'])
  // A response that names no id: Claude numbers its tasks, so this is the next one.
  assert.deepEqual(view(create('List the folder', 'Task created')), [' Create a.txt', ' Create b.txt', ' List the folder'])

  assert.deepEqual(view(update({ taskId: '1', status: 'in_progress' })), ['>Create a.txt', ' Create b.txt', ' List the folder'])
  assert.deepEqual(view(update({ taskId: '1', status: 'completed' })), ['xCreate a.txt', ' Create b.txt', ' List the folder'])
  assert.equal(update({ taskId: '1', status: 'completed' }), null) // no change, no news
  assert.deepEqual(view(update({ taskId: '3', status: 'in-progress' })), ['xCreate a.txt', ' Create b.txt', '>List the folder']) // the guessed id, the other spelling
  // A new subject; an update without a status keeps the status.
  assert.deepEqual(view(update({ taskId: '2', subject: 'Create b.md' })), ['xCreate a.txt', ' Create b.md', '>List the folder'])
  // Unknown fields are ignored; an unknown id without a subject changes nothing.
  assert.equal(update({ taskId: '2', owner: 'someone', addBlockedBy: ['1'], metadata: { x: 1 } }), null)
  assert.equal(update({ taskId: '9', status: 'completed' }), null)
  assert.equal(update({ status: 'completed' }), null)
  // A failed update, a subagent's update, an update before it ran: nothing.
  assert.equal(hook('PostToolUseFailure', { tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'completed' }, error: 'no such task' }), null)
  assert.equal(update({ taskId: '2', status: 'completed' }, { agent_id: 'a1', agent_type: 'general-purpose' }), null)
  assert.equal(hook('PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'completed' } }), null)
  // Deleted: gone from the list.
  assert.deepEqual(view(update({ taskId: '2', status: 'deleted' })), ['xCreate a.txt', '>List the folder'])
  assert.equal(update({ taskId: '2', status: 'deleted' }), null)

  // TaskList is the list as Claude holds it: it replaces ours (and repairs a wrong guess).
  const listed = hook('PostToolUse', {
    tool_name: 'TaskList',
    tool_input: {},
    tool_response: { tasks: [{ id: '1', subject: 'Create a.txt', status: 'completed', blockedBy: [] }, { id: '3', subject: 'List the folder', status: 'completed' }, { id: '4', subject: 'Write the notes', status: 'pending', owner: 'x' }, { id: '5', subject: 'Dropped', status: 'deleted' }] }
  })
  assert.deepEqual(view(listed), ['xCreate a.txt', 'xList the folder', ' Write the notes'])
  // A response that is text, or holds no readable task: the list stays as it was last known.
  assert.equal(hook('PostToolUse', { tool_name: 'TaskList', tool_input: {}, tool_response: '#1 [completed] Create a.txt' }), null)
  assert.equal(hook('PostToolUse', { tool_name: 'TaskList', tool_input: {}, tool_response: { tasks: [{ nothing: true }] } }), null)
  assert.equal(hook('PostToolUse', { tool_name: 'TaskGet', tool_input: { taskId: '1' }, tool_response: { task: { id: '1' } } }), null)

  // When every task is completed, the next TaskCreate starts a new list.
  assert.deepEqual(view(update({ taskId: '4', status: 'completed' })), ['xCreate a.txt', 'xList the folder', 'xWrite the notes'])
  assert.deepEqual(view(create('Second round', { task: { id: '6', subject: 'Second round' } })), [' Second round'])
  // TodoWrite after the task tools replaces everything.
  assert.deepEqual(view(hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'A todo', status: 'pending' }] } })), [' A todo'])
  assert.deepEqual(view(create('After the todo', { task: { id: '7' } })), [' After the todo'])

  assert.deepEqual([createdTaskId({ task: { id: '12' } }), createdTaskId({ id: 4 }), createdTaskId({ taskId: 'x9' }), createdTaskId('Task #5 created successfully: Do it'), createdTaskId('{"task":{"id":"8"}}'), createdTaskId('nope'), createdTaskId(null)], ['12', '4', 'x9', '5', '8', '', ''])
  assert.deepEqual(listedTasks([{ id: 1, subject: 'A', status: 'in_progress' }]), [{ id: '1', step: { text: 'A', status: 'in-progress' } }])
  assert.deepEqual(listedTasks({ tasks: [] }), [])
  assert.equal(listedTasks('text'), null)
})

// ---- the drivers --------------------------------------------------------------------------------------

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

await t('claude (hosted): the hooks of a to-do list turn give plan 0/3 → 3/3 with the current step, then finished, then idle', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ao-progress-work-'))
  const sessionsDir = mkdtempSync(join(tmpdir(), 'ao-progress-sessions-'))
  const time = fakeTime()
  const progress = new ProgressTracker({ now: time.now, schedule: time.schedule })
  const pty = new FakePty()
  const manager = new SessionManager({
    pty,
    sink: { emit: (e) => progress.event(e) },
    providers: [
      claudeProvider({
        sessionsDir,
        hookScript: 'C:\\app\\hook\\claude-session-start.cjs',
        inbox: new SessionInbox(),
        ingest: { baseUrl: () => 'http://127.0.0.1:9', tokens: new SessionTokens() },
        findExecutable: () => process.execPath,
        schedule: time.schedule
      })
    ],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: () => {},
    onTerminalData: () => {},
    progress
  })
  try {
    const info = await manager.start({ provider: 'claude-code', cwd: work, model: 'haiku' })
    const id = info.id
    const target = manager.hookTarget(id)!
    const hook = (name: string, extra: Record<string, unknown> = {}): unknown =>
      target.handleHook(
        { session_id: 'sid-1', transcript_path: join(work, 't.jsonl'), cwd: work, hook_event_name: name, ...extra },
        { auth: { kind: 'session', sessionId: id }, signal: new AbortController().signal } as never
      )
    const line = (): string => {
      const s = manager.progress().sessions.find((x) => x.sessionId === id)
      return s ? [`${s.kind} ${s.done}/${s.total}`, s.current ? `[${s.current}]` : '', s.stopped ? `stopped:${s.stopped}` : '', s.finishedAt !== undefined ? 'finished' : ''].filter(Boolean).join(' ') : 'none'
    }
    const todos = (a: string, b: string, c: string) => [
      { content: 'Create a.txt', status: a, activeForm: 'Creating a.txt' },
      { content: 'Create b.txt', status: b, activeForm: 'Creating b.txt' },
      { content: 'List the folder', status: c, activeForm: 'Listing the folder' }
    ]
    const todo = (a: string, b: string, c: string): void => {
      hook('PreToolUse', { tool_name: 'TodoWrite', tool_use_id: `t-${a}-${b}-${c}`, tool_input: { todos: todos(a, b, c) } })
      hook('PostToolUse', { tool_name: 'TodoWrite', tool_use_id: `t-${a}-${b}-${c}`, tool_input: { todos: todos(a, b, c) }, tool_response: { oldTodos: [], newTodos: todos(a, b, c) } })
    }

    assert.equal(line(), 'idle 0/0') // starting: nothing to show
    hook('SessionStart', { source: 'startup', model: 'claude-haiku-4-5-20251001' })
    assert.equal(line(), 'idle 0/0')
    hook('UserPromptSubmit', { prompt: 'Make a todo list with exactly three steps…' })
    assert.equal(line(), 'working 0/0')
    const started = manager.progress().sessions[0].startedAt
    time.advance(SEC)

    todo('pending', 'pending', 'pending')
    assert.equal(line(), 'plan 0/3')
    todo('in_progress', 'pending', 'pending')
    assert.equal(line(), 'plan 0/3 [Create a.txt]')
    hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: join(work, 'a.txt'), content: 'a' } })
    hook('PostToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: join(work, 'a.txt') }, tool_response: { type: 'create' } })
    todo('completed', 'in_progress', 'pending')
    assert.equal(line(), 'plan 1/3 [Create b.txt]')
    // A subagent's own to-do list does not replace the manager's.
    hook('SubagentStart', { agent_id: 'sub1', agent_type: 'Explore' })
    hook('PreToolUse', { agent_id: 'sub1', agent_type: 'Explore', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Sub step', status: 'in_progress' }] } })
    assert.equal(line(), 'plan 1/3 [Create b.txt]')
    hook('SubagentStop', { agent_id: 'sub1', agent_type: 'Explore' })
    // A prompt delivered into the running turn is not a new run.
    hook('UserPromptSubmit', { prompt: 'also keep them short' })
    assert.deepEqual([line(), manager.progress().sessions[0].startedAt], ['plan 1/3 [Create b.txt]', started])
    todo('completed', 'completed', 'in_progress')
    assert.equal(line(), 'plan 2/3 [List the folder]')
    todo('completed', 'completed', 'completed')
    assert.equal(line(), 'plan 3/3')
    hook('Stop', {})
    assert.equal(line(), 'plan 3/3 finished')
    assert.equal(manager.list()[0].state, 'idle')
    time.advance(PROGRESS_HOLD_MS)
    assert.equal(line(), 'idle 0/0')

    // The next prompt is a new run; a turn cut short with Esc (no Stop hook; the title goes back to
    // the idle glyph) leaves its list stopped where it was.
    time.advance(SEC)
    hook('UserPromptSubmit', { prompt: 'Now two more' })
    assert.equal(manager.progress().sessions[0].startedAt, time.now())
    hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'in_progress' }] } })
    assert.equal(line(), 'plan 1/2 [Two]')
    pty.spawned.get(id)!.handlers.onTitle?.('✳ Claude Code')
    time.advance(10 * SEC)
    assert.equal(manager.list()[0].state, 'idle')
    assert.equal(line(), 'plan 1/2 [Two] stopped:interrupted')

    // The task tools, through the same hooks.
    hook('UserPromptSubmit', { prompt: 'And a task list' })
    assert.equal(line(), 'plan 1/2 [Two]') // the unfinished list, until the run writes its own
    hook('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Read the notes', description: 'x' }, tool_response: { task: { id: '1', subject: 'Read the notes' } } })
    hook('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Write the summary', description: 'x' }, tool_response: { task: { id: '2', subject: 'Write the summary' } } })
    assert.equal(line(), 'plan 0/2')
    hook('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress' }, tool_response: { success: true } })
    assert.equal(line(), 'plan 0/2 [Read the notes]')
    hook('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' }, tool_response: { success: true } })
    hook('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'completed' }, tool_response: { success: true } })
    hook('Stop', {})
    assert.equal(line(), 'plan 2/2 finished')

    // The session exits: no progress.
    pty.spawned.get(id)!.handlers.onExit(0)
    assert.deepEqual(manager.progress(), { sessions: [], orders: [] })
  } finally {
    manager.close()
    progress.dispose()
  }
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

await t('codex: `turn/plan/updated` drives the bar; an order to two sessions is tracked until both managers are idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-progress-codex-'))
  const pushes: ProgressSnapshot[] = []
  const progress = new ProgressTracker({ onChanged: (s) => void pushes.push(s) })
  // Every state the bar went through after a signal of the driver (pushes are throttled; this is not).
  const seen: string[] = []
  const signal = progress.signal.bind(progress)
  progress.signal = (id, sig) => {
    signal(id, sig)
    const s = progress.get(id)
    if (s) seen.push(`${sig.kind}: ${s.kind} ${s.done}/${s.total}${s.current ? ` [${s.current}]` : ''}`)
  }
  const codex = codexProvider({
    openExternal: async () => {},
    server: { resolveSpawn: (): CodexSpawnSpec => ({ file: process.execPath, args: [FAKE_CODEX], env: { ...(process.env as Record<string, string>) } }), backoffMs: [50, 100] },
    findExecutable: () => process.execPath,
    version: async () => '0.160.0'
  })
  const manager = new SessionManager({
    pty: new NoPty(),
    sink: { emit: (e: AgentEvent) => progress.event(e) },
    providers: [codex],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: () => {},
    onTerminalData: () => {},
    progress
  })
  try {
    const a = (await manager.start({ provider: 'codex', cwd: dir, title: 'Alpha' })).id
    const of = (id: string): SessionProgress | undefined => manager.progress().sessions.find((s) => s.sessionId === id)
    const state = (id: string): string | undefined => manager.list().find((s) => s.id === id)?.state
    assert.deepEqual([of(a)?.kind, of(a)?.total], ['idle', 0])

    // No plan: indeterminate while it works; an interrupted turn with nothing counted leaves nothing behind.
    await manager.chatSend(a, 'slow please')
    const working = await until(() => (of(a)?.kind === 'working' ? of(a) : null), 'the slow turn to start')
    assert.deepEqual([working.done, working.total, working.steps, working.stopped], [0, 0, undefined, undefined])
    await until(() => pushes.some((s) => s.sessions.some((x) => x.sessionId === a && x.kind === 'working' && x.total === 0)), 'the pushed "working"')
    manager.interrupt(a)
    await until(() => state(a) === 'idle' && of(a)?.kind === 'idle', 'the interrupt')

    // The fake server's plan: 0/2 with step one in progress, then 1/2 with step two in progress; the
    // turn ends there, so the list is left paused at 1/2.
    await manager.chatSend(a, 'make a todo-list first')
    const paused = await until(() => (state(a) === 'idle' && of(a)?.stopped ? of(a) : null), 'the plan turn')
    assert.deepEqual([paused.kind, paused.done, paused.total, paused.current, paused.stopped], ['plan', 1, 2, 'Write the summary', 'paused'])
    assert.deepEqual(paused.steps, [
      { text: 'Read the notes', status: 'completed' },
      { text: 'Write the summary', status: 'in-progress' }
    ])
    assert.deepEqual(seen, ['turn-end: working 0/0', 'plan: plan 0/2 [Read the notes]', 'plan: plan 1/2 [Write the summary]', 'turn-end: plan 1/2 [Write the summary]'])
    await until(() => pushes.at(-1)?.sessions.some((x) => x.sessionId === a && x.kind === 'plan' && x.done === 1 && x.stopped === 'paused'), 'the pushed 1/2')

    // An order to everyone: two sessions, each with its own row; done when both are idle again.
    const b = (await manager.start({ provider: 'codex', cwd: dir, title: 'Beta' })).id
    const before = pushes.length
    const res = await manager.sendOrder({ target: 'all', text: 'say hi to the office' })
    assert.deepEqual([...res.delivered].sort(), [a, b].sort())
    const done = await until(() => {
      const o = manager.progress().orders[0]
      return o && o.finishedAt !== undefined ? o : null
    }, 'the order to finish')
    assert.deepEqual([done.text, done.target, done.done, done.total], ['say hi to the office', 'all', 2, 2])
    assert.deepEqual(done.sessions.map((s) => `${s.title}|${s.state}`).sort(), ['Alpha|done', 'Beta|done'])
    // The renderer is told about it (the fake's turns are over within one push interval, so the order may arrive finished).
    await until(() => pushes.slice(before).some((s) => s.orders.some((o) => o.id === done.id && o.total === 2)) || null, 'a push of the order')
    assert.equal(manager.dismissOrder(done.id), true)
    assert.deepEqual(manager.progress().orders, [])
    // The new run cleared nothing it should not: a's unfinished list is still there, live or paused.
    assert.equal(of(a)?.kind, 'plan')

    await manager.stop(a)
    assert.equal(of(a), undefined)
  } finally {
    await manager.shutdown()
    progress.dispose()
  }
})

await t('codex: the plan steps of a `turn/plan/updated` notification', () => {
  assert.deepEqual(planSteps({ plan: [{ step: 'A', status: 'inProgress' }, { step: 'B', status: 'completed' }, { step: 'C', status: 'pending' }, 'junk', { step: 'D' }] }), [
    { text: 'A', status: 'in-progress' },
    { text: 'B', status: 'completed' },
    { text: 'C', status: 'pending' },
    { text: 'D', status: 'pending' }
  ])
  assert.deepEqual(planSteps({}), [])
})

await t('antigravity: no plan tool is known, so its bar is only ever "working" or "idle"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ao progress agy '))
  const home = join(root, 'fake home')
  const userData = join(root, 'user data')
  const work = join(root, 'project')
  for (const d of [home, userData, work]) mkdirSync(d, { recursive: true })
  const port = await freePort()
  const agyTokens = new SessionTokens()
  const pushes: ProgressSnapshot[] = []
  const progress = new ProgressTracker({ onChanged: (s) => void pushes.push(s) })
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
    sink: { emit: (e) => progress.event(e) },
    providers: [provider],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: () => {},
    onPermissionsChanged: () => {},
    onTerminalData: () => {},
    progress
  })
  const server = await startIngestServer({ port, getToken: () => 'G'.repeat(64), sink: { emit: () => {} }, agy: { adapter: createAgyHooksAdapter(manager), tokens: agyTokens } })
  try {
    const id = (await manager.start({ provider: 'antigravity', cwd: work, permissionMode: 'acceptEdits' })).id
    const state = (): string | undefined => manager.list().find((s) => s.id === id)?.state
    const of = (): SessionProgress | undefined => manager.progress().sessions.find((s) => s.sessionId === id)
    await manager.chatSend(id, 'write: notes.txt|hello\nsay: written')
    await until(() => pushes.some((s) => s.sessions.some((x) => x.sessionId === id && x.kind === 'working')), 'working', 20_000)
    await until(() => state() === 'idle' && of()?.kind === 'idle', 'the turn to end', 20_000)
    assert.ok(pushes.every((s) => s.sessions.every((x) => x.kind === 'working' || x.kind === 'idle')))
    assert.ok(pushes.every((s) => s.sessions.every((x) => x.total === 0 && x.done === 0 && !x.steps)))
  } finally {
    await manager.shutdown()
    provider.cli.killSync()
    await server.close()
    progress.dispose()
  }
})

console.log(`\n${pass} progress tests passed\n`)
