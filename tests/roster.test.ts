import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Roster, Stations, BOSS_ID } from '../src/scene/roster.ts'
import { compactQueue } from '../src/scene/queue.ts'

const map = JSON.parse(readFileSync(new URL('../themes/office/map.json', import.meta.url), 'utf8'))
const locations = new Map<string, { name: string; x: number; y: number }[]>()
for (const o of map.layers.find((l: any) => l.name === 'locations').objects) {
  const t = o.type || o.class
  if (!locations.has(t)) locations.set(t, [])
  locations.get(t)!.push({ name: o.name, x: o.x, y: o.y })
}
const ev = (agentId: string, parentId: string | null, displayName = agentId) => ({ agentId, parentId, provider: 'claude-code', displayName })
const mk = () => new Roster(locations, { provider: 'human', displayName: 'CEO' })
let pass = 0
const t = (name: string, fn: () => void) => { fn(); pass++; console.log('ok -', name) }

t('boss exists at boss_seat', () => {
  const b = mk().get(BOSS_ID)!
  assert.equal(b.role, 'boss'); assert.equal(b.home.name, 'boss_seat')
})

t('managers take first free seat, overflow to entrance row', () => {
  const r = mk()
  const seats = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => r.ensure(ev(id, null)).created[0].home)
  assert.deepEqual(seats.slice(0, 3).map((s) => s.name), ['manager_seat_1', 'manager_seat_2', 'manager_seat_3'])
  assert.ok(seats[3].name.startsWith('overflow_manager'))
  assert.notDeepEqual([seats[3].x, seats[3].y], [seats[4].x, seats[4].y])
  r.remove('m2')
  assert.equal(r.ensure(ev('m6', null)).created[0].home.name, 'manager_seat_2')
})

t('worker gets nearest free desk to manager seat; desks stable', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('m2', null)); r.ensure(ev('m3', null))
  const w1 = r.ensure(ev('w1', 'm1')).created[0]
  assert.equal(w1.role, 'worker'); assert.equal(w1.teamId, 'm1'); assert.equal(w1.managerId, 'm1')
  assert.equal(w1.home.name, 'desk_4')
  assert.equal(r.ensure(ev('w2', 'm1')).created[0].home.name, 'desk_7')
  assert.equal(r.ensure(ev('w3', 'm3')).created[0].home.name, 'desk_10')
  for (let i = 0; i < 20; i++) { r.ensure(ev('w1', 'm1')); r.ensure(ev('w2', 'm1')) }
  assert.equal(r.get('w1')!.home.name, 'desk_4'); assert.equal(r.get('w2')!.home.name, 'desk_7')
  assert.equal(r.ensure(ev('w1', 'm1')).created.length, 0)
})

t('desk freed on remove and reused', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('w1', 'm1')); r.ensure(ev('w2', 'm1'))
  r.remove('w1')
  assert.equal(r.get('w1'), undefined)
  assert.equal(r.ensure(ev('w3', 'm1')).created[0].home.name, 'desk_4')
  assert.equal(r.get('w2')!.home.name, 'desk_7')
})

t('manager cascade frees team desks and seat', () => {
  const r = mk()
  r.ensure(ev('m1', null)); r.ensure(ev('w1', 'm1')); r.ensure(ev('w2', 'm1')); r.ensure(ev('n1', 'w1'))
  const team = r.teamWorkers('m1').map((e) => e.id).sort()
  assert.deepEqual(team, ['n1', 'w1', 'w2'])
  for (const id of [...team, 'm1']) r.remove(id)
  assert.equal(r.ensure(ev('mX', null)).created[0].home.name, 'manager_seat_1')
  assert.equal(r.ensure(ev('wX', 'mX')).created[0].home.name, 'desk_4')
})

t('implicit parent created first, then upgraded', () => {
  const r = mk()
  const { created } = r.ensure({ agentId: 'w1', parentId: 'abcdef123456', provider: 'codex', displayName: 'W' })
  assert.equal(created.length, 2)
  assert.equal(created[0].id, 'abcdef123456'); assert.equal(created[0].role, 'manager')
  assert.equal(created[0].implicit, true); assert.equal(created[0].provider, 'codex')
  assert.equal(created[0].displayName, 'Session abcdef')
  assert.equal(created[1].managerId, 'abcdef123456')
  const up = r.ensure({ agentId: 'abcdef123456', parentId: null, provider: 'claude-code', displayName: 'Real' })
  assert.equal(up.created.length, 0); assert.equal(up.upgraded?.displayName, 'Real')
  assert.equal(r.get('abcdef123456')!.implicit, false)
  assert.equal(r.get('abcdef123456')!.home.name, 'manager_seat_1')
})

t('nested subagent: manager = direct parent, same team', () => {
  const r = mk()
  r.ensure(ev('m1', null)); const w1 = r.ensure(ev('w1', 'm1')).created[0]
  const n1 = r.ensure(ev('n1', 'w1')).created[0]
  assert.equal(n1.managerId, 'w1'); assert.equal(n1.teamId, 'm1')
  assert.equal(n1.home.name, 'desk_5')
  assert.equal(r.managerHome('n1'), w1.home)
  r.remove('w1')
  assert.equal(r.managerHome('n1'), n1.home)
})

t('desk overflow when all 12 taken', () => {
  const r = mk()
  r.ensure(ev('m1', null))
  for (let i = 0; i < 12; i++) r.ensure(ev('w' + i, 'm1'))
  assert.ok(r.ensure(ev('w12', 'm1')).created[0].home.name.startsWith('overflow_worker'))
})

t('inbox slots claimed and released', () => {
  const r = mk()
  assert.equal(r.claimInbox('a')!.name, 'inbox_1'); assert.equal(r.claimInbox('b')!.name, 'inbox_2')
  assert.equal(r.claimInbox('a')!.name, 'inbox_1')
  r.claimInbox('c'); r.claimInbox('d'); assert.equal(r.claimInbox('e'), null)
  r.releaseInbox('a'); assert.equal(r.claimInbox('e')!.name, 'inbox_1')
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
console.log(`\n${pass} passed`)
