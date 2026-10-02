// What the user is asked about (shared/approvals.ts) and how the registry applies it.
import assert from 'node:assert/strict'
import { approvalVerdict, HELD_APPROVAL_TTL_MS, HELD_MESSAGE, type ApprovalMode, type AutoAllowed, type HeldRequest } from '../shared/approvals'
import { plainPermission } from '../shared/permissionText'
import type { PermissionDecision, PermissionOutcome } from '../shared/sessions'
import { PermissionRegistry, type NewPermission } from '../electron/permissions'

let n = 0
const t = (name: string, fn: () => void) => {
  fn()
  n++
  console.log('ok -', name)
}

t('the rule: dangerous is never allowed, in any mode', () => {
  for (const mode of ['all', 'important', 'auto'] as ApprovalMode[]) {
    for (const routine of [true, false]) assert.notEqual(approvalVerdict(mode, { risk: 'danger', routine }), 'allow')
  }
  assert.equal(approvalVerdict('auto', { risk: 'danger', routine: false }), 'hold')
  assert.equal(approvalVerdict('important', { risk: 'danger', routine: false }), 'ask')
  assert.equal(approvalVerdict('all', { risk: 'danger', routine: false }), 'ask')
})

t('the rule: what each mode allows', () => {
  assert.equal(approvalVerdict('all', { risk: 'normal', routine: true }), 'ask')
  assert.equal(approvalVerdict('important', { risk: 'normal', routine: true }), 'allow')
  assert.equal(approvalVerdict('important', { risk: 'normal', routine: false }), 'ask')
  assert.equal(approvalVerdict('important', { risk: 'caution', routine: true }), 'ask')
  assert.equal(approvalVerdict('auto', { risk: 'normal', routine: false }), 'allow')
  assert.equal(approvalVerdict('auto', { risk: 'caution', routine: false }), 'allow')
})

/** A registry on a fake clock with a switchable mode, and a way to submit a request the way a driver does. */
function harness(initial: ApprovalMode) {
  let mode = initial
  let now = 1_000_000
  const auto: AutoAllowed[] = []
  let held: HeldRequest[] = []
  let pending = 0
  const reg = new PermissionRegistry((p) => (pending = p.length), {
    mode: () => mode,
    onAuto: (e) => auto.push(e),
    onHeld: (h) => (held = h),
    now: () => now
  })
  const ask = (tool: string, input: unknown, sessionId = 's1') => {
    const plain = plainPermission({ who: 'Team', tool, input, cwd: 'C:/proj' })
    const req: NewPermission = { sessionId, agentId: sessionId, displayName: 'Team', provider: 'claude-code', toolName: tool, summary: `${tool}: ${JSON.stringify(input)}`, detail: '', ...plain }
    const got: { outcome?: PermissionOutcome; decision?: PermissionDecision | null } = {}
    const id = reg.add(req, { onResolved: (outcome, decision) => Object.assign(got, { outcome, decision }) })
    return { id, got }
  }
  return { reg, ask, auto, held: () => held, pending: () => pending, setMode: (m: ApprovalMode) => (mode = m), tick: (ms: number) => (now += ms) }
}

t('all: everything becomes a card and waits', () => {
  const h = harness('all')
  const r = h.ask('Bash', { command: 'npm test' })
  assert.ok(r.id)
  assert.equal(r.got.outcome, undefined)
  assert.equal(h.pending(), 1)
  assert.equal(h.auto.length, 0)
})

t('important: routine work is allowed and listed; the rest waits', () => {
  const h = harness('important')
  const routine = h.ask('Bash', { command: 'npm test' })
  assert.equal(routine.id, null)
  assert.equal(routine.got.outcome, 'allowed')
  assert.deepEqual(routine.got.decision, { behavior: 'allow' })
  assert.equal(h.auto.length, 1)
  assert.equal(h.auto[0].mode, 'important')
  assert.match(h.auto[0].question, /run the tests/)
  assert.ok(h.ask('Bash', { command: 'npm install left-pad' }).id) // caution: asks
  assert.ok(h.ask('Bash', { command: 'frobnicate' }).id) // unknown: asks
  assert.ok(h.ask('Bash', { command: 'rm -rf dist' }).id) // danger: asks and blocks
  assert.equal(h.pending(), 3)
  assert.equal(h.held().length, 0)
})

t('auto: everything but the dangerous is allowed; a dangerous request is held, not blocking', () => {
  const h = harness('auto')
  for (const command of ['npm test', 'npm install left-pad', 'frobnicate --all', 'git push']) {
    const r = h.ask('Bash', { command })
    assert.equal(r.id, null, command)
    assert.equal(r.got.outcome, 'allowed', command)
  }
  assert.equal(h.auto.length, 4)
  assert.ok(h.auto.every((e) => e.mode === 'auto'))

  const danger = h.ask('Bash', { command: 'rm -rf dist' })
  assert.equal(danger.id, null) // no card that blocks the agent
  assert.equal(danger.got.outcome, 'denied')
  assert.deepEqual(danger.got.decision, { behavior: 'deny', message: HELD_MESSAGE })
  assert.equal(h.pending(), 0)
  assert.equal(h.held().length, 1)
  assert.match(h.held()[0].question, /delete files or folders permanently/)
  assert.equal(h.auto.length, 4) // a held request is not "handled"

  // The agent asks again although it was told to wait: still one row, still refused.
  const again = h.ask('Bash', { command: 'rm -rf dist' })
  assert.equal(again.got.outcome, 'denied')
  assert.equal(h.held().length, 1)
})

t('a held request the user approves is let through once, then asks again', () => {
  const h = harness('auto')
  h.ask('Bash', { command: 'rm -rf dist' })
  const heldId = h.held()[0].id
  assert.equal(h.reg.approveHeld('nope'), null)
  const approved = h.reg.approveHeld(heldId)
  assert.ok(approved?.approvedAt)
  assert.equal(h.reg.approveHeld(heldId), null) // only once

  // a different dangerous command is not covered by that approval
  assert.equal(h.ask('Bash', { command: 'rm -rf src' }).got.outcome, 'denied')
  // another session's identical command is not covered either
  assert.equal(h.ask('Bash', { command: 'rm -rf dist' }, 's2').got.outcome, 'denied')

  const retry = h.ask('Bash', { command: 'rm -rf dist' })
  assert.equal(retry.got.outcome, 'allowed')
  assert.equal(h.auto[0].mode, 'held')
  assert.ok(!h.held().some((x) => x.id === heldId)) // the row is gone once used

  const third = h.ask('Bash', { command: 'rm -rf dist' })
  assert.equal(third.got.outcome, 'denied') // one approval, one run
})

t('an approval that is not used in time expires; a dismissed one grants nothing', () => {
  const h = harness('auto')
  h.ask('Bash', { command: 'git push --force' })
  h.reg.approveHeld(h.held()[0].id)
  h.tick(HELD_APPROVAL_TTL_MS + 1)
  assert.equal(h.ask('Bash', { command: 'git push --force' }).got.outcome, 'denied')

  const h2 = harness('auto')
  h2.ask('Bash', { command: 'git reset --hard' })
  assert.equal(h2.reg.dismissHeld(h2.held()[0].id), true)
  assert.equal(h2.held().length, 0)
  assert.equal(h2.ask('Bash', { command: 'git reset --hard' }).got.outcome, 'denied')
  assert.equal(h2.reg.dismissHeld('nope'), false)
})

t('switching the mode settles what is already waiting', () => {
  const h = harness('all')
  const a = h.ask('Bash', { command: 'npm test' })
  const b = h.ask('Bash', { command: 'npm install x' })
  const c = h.ask('Bash', { command: 'rm -rf dist' })
  assert.equal(h.pending(), 3)

  h.setMode('important')
  h.reg.applyMode()
  assert.equal(a.got.outcome, 'allowed')
  assert.equal(b.got.outcome, undefined)
  assert.equal(c.got.outcome, undefined)
  assert.equal(h.pending(), 2)

  h.setMode('auto')
  h.reg.applyMode()
  assert.equal(b.got.outcome, 'allowed')
  assert.equal(c.got.outcome, 'denied')
  assert.deepEqual(c.got.decision, { behavior: 'deny', message: HELD_MESSAGE })
  assert.equal(h.pending(), 0)
  assert.equal(h.held().length, 1)

  // asking for more again never un-answers anything
  h.setMode('all')
  h.reg.applyMode()
  assert.equal(h.held().length, 1)
  assert.ok(h.ask('Bash', { command: 'npm test' }).id)
})

t('peek tells a driver what will happen without doing it', () => {
  const h = harness('auto')
  const peek = (command: string) => {
    const plain = plainPermission({ who: 'Team', tool: 'Bash', input: { command }, cwd: 'C:/proj' })
    return h.reg.peek({ sessionId: 's1', toolName: 'Bash', summary: `Bash: ${JSON.stringify({ command })}`, risk: plain.risk, routine: plain.routine })
  }
  assert.equal(peek('npm test'), 'allow')
  assert.equal(peek('rm -rf dist'), 'hold')
  assert.equal(h.auto.length, 0)
  assert.equal(h.held().length, 0)
  h.ask('Bash', { command: 'rm -rf dist' })
  h.reg.approveHeld(h.held()[0].id)
  assert.equal(peek('rm -rf dist'), 'allow') // the approved retry
  assert.equal(peek('rm -rf dist'), 'allow') // peeking does not use the approval up
  h.setMode('all')
  assert.equal(peek('npm test'), 'ask')
})

t('a session that ends takes its held requests with it; the lists are capped', () => {
  const h = harness('auto')
  h.ask('Bash', { command: 'rm -rf a' }, 's1')
  h.ask('Bash', { command: 'rm -rf b' }, 's2')
  h.reg.dropHeld('s1')
  assert.deepEqual(h.held().map((x) => x.sessionId), ['s2'])
  for (let i = 0; i < 80; i++) h.ask('Bash', { command: `echo ${i}` })
  assert.equal(h.reg.recentAuto().length, 50)
  for (let i = 0; i < 80; i++) h.ask('Bash', { command: `rm -rf d${i}` })
  assert.equal(h.held().length, 50)
})

t('the held message is fixed text', () => {
  assert.ok(HELD_MESSAGE.length < 500)
  assert.match(HELD_MESSAGE, /NOT done/)
  assert.match(HELD_MESSAGE, /Do not retry/)
})

console.log(`${n} approval tests passed`)
