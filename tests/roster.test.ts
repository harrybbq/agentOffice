// Runs with `npm test` (tsx). Also imports the other test files so one command runs everything.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Roster, Stations, BOSS_ID } from '../src/scene/roster.ts'
import { compactQueue } from '../src/scene/queue.ts'
import { parseMap } from '../src/theme/parse.ts'
import { WorldLayout } from '../src/world/layout.ts'

const load = (f: string) => parseMap(JSON.parse(readFileSync(new URL(`../themes/office/${f}`, import.meta.url), 'utf8')))
const hqMap = load('hq.json')
const branchMap = load('branch.json')

const ev = (agentId: string, parentId: string | null, displayName = agentId) => ({ agentId, parentId, provider: 'claude-code', displayName })
const mk = () => new Roster(new WorldLayout(hqMap, branchMap), { provider: 'human', displayName: 'CEO' })
let pass = 0
const t = (name: string, fn: () => void) => { fn(); pass++; console.log('ok -', name) }

t('boss exists at the HQ boss_seat', () => {
  const r = mk()
  const b = r.get(BOSS_ID)!
  assert.equal(b.role, 'boss'); assert.equal(b.home.name, 'boss_seat')
  assert.equal(r.blockOf(BOSS_ID).kind, 'hq')
  const hq = r.layout.hq
  assert.equal(b.home.x, hq.offset.x + 160); assert.equal(b.home.y, hq.offset.y + 51)
})

t('every manager gets its own branch and its manager_seat', () => {
  const r = mk()
  const res = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => r.ensure(ev(id, null)))
  const slots = res.map((x) => x.branches[0].slot)
  assert.deepEqual(slots, [1, 2, 3, 4, 5])
  for (const [i, x] of res.entries()) {
    const m = x.created[0]
    assert.equal(m.home.name, 'manager_seat')
    const b = r.blockOf(m.id)
    assert.equal(b.id, `m${i + 1}`)
    assert.equal(m.home.x, b.offset.x + 96); assert.equal(m.home.y, b.offset.y + 48)
  }
  // Distinct homes.
  assert.equal(new Set(res.map((x) => `${x.created[0].home.x},${x.created[0].home.y}`)).size, 5)
})

t('worker gets nearest free desk in its own branch; desks stable', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('m2', null))
  const w1 = r.ensure(ev('w1', 'm1')).created[0]
  assert.equal(w1.role, 'worker'); assert.equal(w1.teamId, 'm1'); assert.equal(w1.managerId, 'm1')
  const b1 = r.blockOf('m1')
  const inBlock = (p: { x: number; y: number }, b = b1) =>
    p.x >= b.offset.x && p.y >= b.offset.y && p.x <= b.offset.x + b.width && p.y <= b.offset.y + b.height
  assert.ok(inBlock(w1.home))
  const w2 = r.ensure(ev('w2', 'm1')).created[0]
  const w3 = r.ensure(ev('w3', 'm2')).created[0]
  assert.ok(inBlock(w2.home)); assert.ok(inBlock(w3.home, r.blockOf('m2'))); assert.ok(!inBlock(w3.home))
  assert.equal(w3.home.name, w1.home.name) // same desk name, different branch
  for (let i = 0; i < 20; i++) { r.ensure(ev('w1', 'm1')); r.ensure(ev('w2', 'm1')) }
  assert.equal(r.get('w1')!.home, w1.home); assert.equal(r.get('w2')!.home, w2.home)
  assert.equal(r.ensure(ev('w1', 'm1')).created.length, 0)
})

t('nearest desk to the manager seat', () => {
  const r = mk()
  r.ensure(ev('m1', null))
  // Seat (96,48): desk_1 (56,250) d2=1600+40804, desk_2 (152,250) d2=3136+40804 -> desk_1.
  assert.equal(r.ensure(ev('w1', 'm1')).created[0].home.name, 'desk_1')
  assert.equal(r.ensure(ev('w2', 'm1')).created[0].home.name, 'desk_2')
})

t('desk freed on remove and reused', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('w1', 'm1')); r.ensure(ev('w2', 'm1'))
  const res = r.remove('w1')!
  assert.equal(res.releasedBranch, null)
  assert.equal(r.get('w1'), undefined)
  assert.equal(r.ensure(ev('w3', 'm1')).created[0].home.name, 'desk_1')
  assert.equal(r.get('w2')!.home.name, 'desk_2')
})

t('branch released only when the whole team has left; slot reused', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('w1', 'm1')); r.ensure(ev('w2', 'm1')); r.ensure(ev('n1', 'w1'))
  r.ensure(ev('m2', null))
  const team = r.teamWorkers('m1').map((e) => e.id).sort()
  assert.deepEqual(team, ['n1', 'w1', 'w2'])
  const slot = r.layout.branch('m1')!.slot
  assert.equal(r.remove('m1')!.releasedBranch, null) // workers still walking out
  assert.equal(r.remove('w1')!.releasedBranch, null)
  assert.equal(r.remove('n1')!.releasedBranch, null)
  const last = r.remove('w2')!
  assert.equal(last.releasedBranch?.id, 'm1')
  assert.equal(r.layout.branch('m1'), undefined)
  const mx = r.ensure(ev('mX', null))
  assert.equal(mx.branches[0].slot, slot)
  assert.equal(r.ensure(ev('wX', 'mX')).created[0].home.name, 'desk_1')
  assert.equal(r.layout.branch('m2')!.slot, 2)
})

t('implicit parent created first (with a branch), then upgraded', () => {
  const r = mk()
  const { created, branches } = r.ensure({ agentId: 'w1', parentId: 'abcdef123456', provider: 'codex', displayName: 'W' })
  assert.equal(created.length, 2)
  assert.equal(branches.length, 1); assert.equal(branches[0].id, 'abcdef123456')
  assert.equal(created[0].id, 'abcdef123456'); assert.equal(created[0].role, 'manager')
  assert.equal(created[0].implicit, true); assert.equal(created[0].provider, 'codex')
  assert.equal(created[0].displayName, 'Session abcdef')
  assert.equal(created[1].managerId, 'abcdef123456'); assert.equal(created[1].teamId, 'abcdef123456')
  const up = r.ensure({ agentId: 'abcdef123456', parentId: null, provider: 'claude-code', displayName: 'Real' })
  assert.equal(up.created.length, 0); assert.equal(up.upgraded?.displayName, 'Real'); assert.equal(up.branches.length, 0)
  assert.equal(r.get('abcdef123456')!.implicit, false)
  assert.equal(r.get('abcdef123456')!.home.name, 'manager_seat')
})

t('nested subagent: manager = direct parent, root team branch', () => {
  const r = mk()
  r.ensure(ev('m1', null)); const w1 = r.ensure(ev('w1', 'm1')).created[0]
  const n1 = r.ensure(ev('n1', 'w1')).created[0]
  assert.equal(n1.managerId, 'w1'); assert.equal(n1.teamId, 'm1')
  assert.equal(r.blockOf('n1').id, 'm1')
  assert.equal(n1.home.name, 'desk_5') // nearest free desk to w1's desk_1 (56,250) is desk_5 (56,342)
  assert.equal(r.managerHome('n1'), w1.home)
  r.remove('w1')
  assert.equal(r.managerHome('n1'), n1.home)
})

t('desk overflow near the branch entrance when all 8 taken; desk-for-life kept', () => {
  const r = mk()
  r.ensure(ev('m1', null))
  const homes = Array.from({ length: 8 }, (_, i) => r.ensure(ev('w' + i, 'm1')).created[0].home)
  const o1 = r.ensure(ev('w8', 'm1')).created[0].home
  const o2 = r.ensure(ev('w9', 'm1')).created[0].home
  assert.ok(o1.name.startsWith('overflow_m1')); assert.ok(o2.name.startsWith('overflow_m1'))
  assert.notDeepEqual([o1.x, o1.y], [o2.x, o2.y])
  const ent = r.entranceOf('w8')
  assert.ok(Math.hypot(o1.x - ent.x, o1.y - ent.y) < 64)
  r.remove('w3')
  for (let i = 0; i < 8; i++) if (i !== 3) assert.equal(r.get('w' + i)!.home, homes[i])
  assert.equal(r.get('w8')!.home, o1) // overflow keeps its spot
})

t('worker stations resolve only within its own branch (no HQ fallback); managers fall back to the HQ', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('m2', null)); r.ensure(ev('w1', 'm2'))
  const b2 = r.blockOf('w1')
  const p = r.station('w1', 'printer', r.get('w1')!.home)!
  assert.equal(p.x, b2.offset.x + 248); assert.equal(p.y, b2.offset.y + 86)
  // Even standing right next to m1's printer, the worker uses its own branch's.
  const b1 = r.blockOf('m1')
  const p2 = r.station('w1', 'printer', { x: b1.offset.x + 250, y: b1.offset.y + 90 })!
  assert.equal(p2.x, p.x); assert.equal(p2.y, p.y)
  const e = r.entranceOf('w1')
  assert.equal(e.x, b2.offset.x + 256); assert.equal(e.y, b2.offset.y + 362)
  // inbox only exists in the HQ: a worker gets nothing (goes home), a manager gets the HQ inbox.
  assert.equal(r.station('w1', 'inbox', r.get('w1')!.home), null)
  assert.ok(r.station('m2', 'inbox', r.get('m2')!.home)!.name.startsWith('inbox'))
  assert.equal(r.station('w1', 'no_such_station', { x: 0, y: 0 }), null)
})

t('office-wide: worker stations resolve world-wide (nearest of the type in any given block)', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('m2', null)); r.ensure(ev('w1', 'm2'))
  const world = r.layout.all()
  const b1 = r.blockOf('m1')
  const near1 = { x: b1.offset.x + 250, y: b1.offset.y + 90 }
  const p = r.station('w1', 'printer', near1, world)!
  assert.equal(p.x, b1.offset.x + 248); assert.equal(p.y, b1.offset.y + 86)
  const ib = r.station('w1', 'inbox', r.get('w1')!.home, world)!
  assert.ok(ib.name.startsWith('inbox'))
})

t('memo spots sit in the team manager office,distinct per worker, stable, freed on remove', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('w1', 'm1')); r.ensure(ev('w2', 'm1')); r.ensure(ev('n1', 'w1'))
  const seat = r.get('m1')!.home
  const a = r.claimMemoSpot('w1')!; const b = r.claimMemoSpot('w2')!; const c = r.claimMemoSpot('n1')!
  assert.equal(new Set([a, b, c].map((p) => `${p.x},${p.y}`)).size, 3)
  // In front of the manager's desk, inside the manager's room (0..192 x 0..160 of the branch).
  const o = r.blockOf('m1').offset
  for (const p of [a, b, c]) {
    assert.ok(p.y > seat.y + 50 && p.y - o.y < 160, `memo spot ${p.x},${p.y} outside the office`)
    assert.ok(p.x - o.x > 8 && p.x - o.x < 184)
  }
  assert.deepEqual(r.claimMemoSpot('w1'), a)
  assert.equal(r.teamManager('n1')!.id, 'm1') // nested subagents relay via the team manager
  r.remove('w1')
  assert.deepEqual(r.claimMemoSpot('w2'), b)
  const d = r.claimMemoSpot('n1')!
  assert.deepEqual(d, c)
})

t('inbox slots at HQ, overflow queues outside the HQ door', () => {
  const r = mk()
  const hq = r.layout.hq
  assert.equal(r.claimInbox('a').point.name, 'inbox_1'); assert.equal(r.claimInbox('b').point.name, 'inbox_2')
  assert.equal(r.claimInbox('a').point.name, 'inbox_1')
  for (const id of ['c', 'd', 'e', 'f']) assert.equal(r.claimInbox(id).queued, false)
  const q1 = r.claimInbox('g'); const q2 = r.claimInbox('h')
  assert.equal(q1.queued, true); assert.equal(q2.queued, true)
  assert.notDeepEqual([q1.point.x, q1.point.y], [q2.point.x, q2.point.y])
  // Outside the HQ block, below its bottom door.
  assert.ok(q1.point.y > hq.offset.y + hq.height)
  assert.deepEqual(r.claimInbox('g').point, q1.point) // stable
  r.releaseInbox('a'); assert.equal(r.claimInbox('g').point.name, 'inbox_1')
})

t('stations offset sharers 12px apart and reuse slots', () => {
  const s = new Stations(); const p = { x: 100, y: 100 }
  assert.deepEqual(s.claim('a', p), { x: 100, y: 100 })
  assert.deepEqual(s.claim('b', p), { x: 112, y: 100 })
  assert.deepEqual(s.claim('c', p), { x: 88, y: 100 })
  s.release('b'); assert.deepEqual(s.claim('d', p), { x: 112, y: 100 })
  assert.deepEqual(s.claim('a', p), { x: 100, y: 100 })
})

t('queue compaction', () => {
  const A = (activity: string) => ({ lifecycle: false, activity })
  const L = (activity: string) => ({ lifecycle: true, activity })
  assert.equal(compactQueue([A('read'), A('read')]).length, 2)
  const q = [L('spawn'), A('read'), A('read'), A('read'), A('write'), A('exec'), A('web'), A('read')]
  const out = compactQueue(q)
  assert.deepEqual(out.map((x) => x.activity), ['spawn', 'read', 'write', 'exec', 'web', 'read'])
  assert.equal(out[1], q[3])
  const many = [A('a'), L('waiting'), A('b'), A('c'), A('d'), A('e'), A('f'), L('done'), A('g')]
  const o2 = compactQueue(many)
  assert.deepEqual(o2.map((x) => x.activity), ['waiting', 'd', 'e', 'f', 'done', 'g'])
  assert.equal(compactQueue(Array.from({ length: 8 }, () => L('waiting'))).length, 8)
})
console.log(`\n${pass} roster tests passed\n`)

await import('./world.test.ts')
