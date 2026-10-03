// Movement scopes, memo relay, team looks, CEO order validation/gating and session inbox delivery.
// Imported by corridors.test.ts (npm test runs everything).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMap } from '../src/theme/parse.ts'
import type { Rect } from '../src/theme/parse.ts'
import { WorldLayout } from '../src/world/layout.ts'
import { blockRect, CorridorNetwork } from '../src/world/corridors.ts'
import { NavScopes } from '../src/world/scopes.ts'
import { RelayBook } from '../src/scene/relay.ts'
import { HAIR_STYLES, TeamLooks } from '../src/scene/teamLook.ts'
import { OfficeWide } from '../src/officeWide.ts'
import type { Point } from '../src/scene/roster.ts'
import { planOrder, REASON_DISABLED, REASON_NOT_CONNECTED, ORDER_MAX_CHARS } from '../shared/orders.ts'
import { deliverToSocket, SessionInbox, wirePayload } from '../electron/sessionInbox.ts'

const load = (f: string) => parseMap(JSON.parse(readFileSync(new URL(`../themes/office/${f}`, import.meta.url), 'utf8')))
const hqMap = load('hq.json')
const branchMap = load('branch.json')

let pass = 0
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn()
  pass++
  console.log('ok -', name)
}

function world(n: number) {
  const l = new WorldLayout(hqMap, branchMap)
  const net = new CorridorNetwork(l)
  for (let i = 0; i < n; i++) assert.ok(net.connect(l.addBranch('T' + i)))
  const scopes = new NavScopes(l.bounds(), l.all(), net.cells().map((c) => net.cellRect(c)))
  return { l, net, scopes }
}

const inRect = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
const strictlyIn = (p: Point, r: Rect) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height

/** Every point (1 px sampling) of from -> path. */
function* samples(from: Point, path: Point[]): Generator<Point> {
  let a = from
  for (const b of path) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)))
    for (let i = 0; i <= n; i++) yield { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }
    a = b
  }
}

// ---- movement scopes ---------------------------------------------------------------------------

await t('normal mode: worker paths stay inside their branch interior; HQ and other branches unreachable', () => {
  const { l, scopes } = world(4)
  for (const b of l.branches()) {
    const nav = scopes.branch(b.id)
    const r = blockRect(b)
    const desks = b.locations.get('desk')!
    const targets = ['printer', 'filing_cabinet', 'server_room', 'photo_booth', 'water_cooler', 'manager_seat', 'entrance']
      .map((ty) => b.locations.get(ty)![0])
    for (const d of desks) {
      for (const to of targets) {
        const path = nav.findPath(d, to)
        assert.ok(path, `${b.id}: no path ${d.name} -> ${to.name}`)
        for (const p of samples(d, path)) assert.ok(inRect(p, r), `${b.id}: path leaves the branch at (${p.x},${p.y})`)
      }
    }
    // A resting spot is walked onto exactly (a seat only counts at its very point): never snapped
    // off a cushion because the sofa blocks it.
    for (const spot of b.locations.get('lounge')!) {
      const path = nav.findPath(desks[0], spot)
      assert.ok(path && path.length > 0, `${b.id}: no path to the lounge spot ${spot.name}`)
      assert.deepEqual(path[path.length - 1], { x: spot.x, y: spot.y }, `${b.id}: ${spot.name} is not reached exactly`)
      for (const p of samples(desks[0], path)) assert.ok(inRect(p, r), `${b.id}: path leaves the branch at (${p.x},${p.y})`)
    }
    // The HQ inbox and every other branch are out of reach.
    assert.equal(nav.findPath(desks[0], l.hq.locations.get('inbox')![0]), null)
    for (const o of l.branches()) if (o.id !== b.id) assert.equal(nav.findPath(desks[0], o.locations.get('printer')![0]), null)
  }
})

await t('office-wide mode: the full nav lets a worker reach other branches and the HQ inbox', () => {
  const { l, scopes } = world(4)
  const nav = scopes.full()
  const [a, b] = l.branches()
  const desk = a.locations.get('desk')![0]
  assert.ok(nav.findPath(desk, b.locations.get('printer')![0]))
  assert.ok(nav.findPath(desk, l.hq.locations.get('inbox')![0]))
})

await t('managers reach the HQ inbox via corridors but never walk through another branch', () => {
  const { l, scopes } = world(8)
  const inbox = l.hq.locations.get('inbox')!
  for (const b of l.branches()) {
    const nav = scopes.manager(b.id)
    const seat = b.locations.get('manager_seat')![0]
    for (const ib of inbox) {
      const path = nav.findPath(seat, ib)
      assert.ok(path, `${b.id}: manager can't reach ${ib.name}`)
      for (const p of samples(seat, path)) {
        for (const o of l.branches()) {
          if (o.id !== b.id) assert.ok(!strictlyIn(p, blockRect(o)), `${b.id}'s manager walks through ${o.id}`)
        }
      }
    }
    // Other branches' rooms are never entered (a goal near a door may snap onto the corridor outside).
    for (const o of l.branches()) {
      if (o.id === b.id) continue
      for (const to of [o.locations.get('desk')![0], o.locations.get('manager_seat')![0], o.locations.get('printer')![0]]) {
        const path = nav.findPath(seat, to)
        if (path) for (const p of samples(seat, path)) assert.ok(!strictlyIn(p, blockRect(o)), `${b.id}'s manager enters ${o.id}`)
      }
    }
  }
})

// ---- memo relay --------------------------------------------------------------------------------

await t('relay: worker memo -> manager office -> manager relays to HQ; returns when all clear', () => {
  const r = new RelayBook<string>()
  r.open('w1', 'm1', 'manager')
  // Not delivered yet: the manager doesn't move until the memo reaches its office.
  assert.equal(r.relayCount('m1'), 0)
  assert.equal(r.step('m1', true), null)
  r.deliver('w1')
  assert.equal(r.step('m1', true), 'start')
  assert.ok(r.isRelaying('m1'))
  r.open('w2', 'm1', 'manager'); r.deliver('w2')
  assert.equal(r.relayCount('m1'), 2)
  assert.equal(r.step('m1', true), 'update')
  assert.deepEqual(r.waitingIn('m1').sort(), ['w1', 'w2'])
  r.close('w1')
  assert.equal(r.step('m1', true), 'update') // w2 still waiting
  r.close('w2')
  assert.equal(r.step('m1', true), 'stop')
  assert.ok(!r.isRelaying('m1'))
  assert.equal(r.step('m1', true), null)
})

await t('relay: manager\'s own non-waiting events are deferred (latest only) while workers still wait', () => {
  const r = new RelayBook<string>()
  r.open('m1', 'm1', 'self')
  assert.equal(r.step('m1', true), 'start') // a manager's own permission request -> HQ
  r.open('w1', 'm1', 'manager'); r.deliver('w1')
  assert.equal(r.relayCount('m1'), 2)
  assert.equal(r.deferManagerEvent('m1', 'read'), true) // own memo closes, w1 still waits
  assert.equal(r.deferManagerEvent('m1', 'write'), true)
  assert.equal(r.relayCount('m1'), 1)
  assert.equal(r.step('m1', true), 'update')
  r.close('w1')
  assert.equal(r.step('m1', true), 'stop')
  assert.equal(r.takeDeferred('m1'), 'write')
  assert.equal(r.takeDeferred('m1'), undefined)
  // Only the manager waiting: its next event isn't deferred, the relay just stops.
  r.open('m1', 'm1', 'self')
  assert.equal(r.step('m1', true), 'start')
  assert.equal(r.deferManagerEvent('m1', 'exec'), false)
  assert.equal(r.step('m1', true), 'stop')
})

await t('relay: no manager -> workers wait in the office, nobody goes to HQ; HQ-route memos skip the manager', () => {
  const r = new RelayBook()
  r.open('w1', 'm1', 'manager'); r.deliver('w1')
  assert.equal(r.step('m1', false), null)
  assert.deepEqual(r.waitingIn('m1'), ['w1']) // still listed
  r.open('w2', 'm2', 'hq')
  assert.equal(r.relayCount('m2'), 0)
  assert.equal(r.step('m2', true), null)
  // Office-wide ends: the HQ memo is re-routed to the manager.
  r.open('w2', 'm2', 'manager'); r.deliver('w2')
  assert.equal(r.step('m2', true), 'start')
  r.dropTeam('m2')
  assert.equal(r.waitingIn('m2').length, 0)
  assert.ok(!r.isRelaying('m2'))
})

// ---- team looks --------------------------------------------------------------------------------

await t('team looks: deterministic, colours and hairstyles unique among live teams', () => {
  const a = new TeamLooks(10)
  const b = new TeamLooks(10)
  const ids = ['sess-a1', 'sess-b2', 'sess-c3', 'sess-d4', 'sess-e5', 'sess-f6']
  const la = ids.map((id) => a.ensure(id))
  const lb = ids.map((id) => b.ensure(id))
  assert.deepEqual(la, lb)
  assert.equal(new Set(la.map((l) => l.color)).size, ids.length)
  assert.equal(new Set(la.map((l) => l.head.style)).size, Math.min(ids.length, HAIR_STYLES.length))
  assert.deepEqual(a.ensure('sess-a1'), la[0]) // stable
  a.release('sess-a1')
  const again = a.ensure('sess-zz')
  assert.ok(!la.slice(1).some((l) => l.color === again.color))
})

// ---- office-wide mode ----------------------------------------------------------------------------

await t('office-wide mode ends when every team that got the order reports idle/done, or on timeout', () => {
  const ev = (agentId: string, activity: 'idle' | 'done' | 'read', parentId: string | null = null) =>
    ({ agentId, parentId, provider: 'x', displayName: agentId, activity, detail: '', ts: 0 })
  const w = new OfficeWide(1000)
  w.start(['s1', 's2'], 0)
  assert.ok(w.active)
  assert.equal(w.observe(ev('s1', 'read')), false)
  assert.equal(w.observe(ev('w1', 'idle', 's1')), false) // a worker doesn't count
  assert.equal(w.observe(ev('s1', 'idle')), false)
  assert.deepEqual(w.waitingOn, ['s2'])
  assert.equal(w.observe(ev('s2', 'done')), true)
  assert.ok(!w.active)
  w.start(null, 0) // dev flag: no tracking
  assert.equal(w.observe(ev('s1', 'idle')), false)
  assert.equal(w.check(999), false)
  assert.equal(w.check(1000), true)
  assert.ok(!w.active)
})

// ---- CEO orders ----------------------------------------------------------------------------------

await t('sendOrder validation: text 1..4000, target all or a known top-level id', () => {
  const known = ['s1', 's2']
  const on = { allowOrders: true, known }
  const reason = (x: unknown, o = on) => {
    const p = planOrder(x, o)
    return p.ok ? null : p.result.failed[0].reason
  }
  assert.match(reason(null)!, /invalid/)
  assert.match(reason({ target: 's1' })!, /text/)
  assert.match(reason({ target: 's1', text: '   ' })!, /empty/)
  assert.match(reason({ target: 's1', text: 'x'.repeat(ORDER_MAX_CHARS + 1) })!, /longer/)
  assert.equal(reason({ target: 's1', text: 'x'.repeat(ORDER_MAX_CHARS) }), null)
  assert.match(reason({ target: 'nope', text: 'hi' })!, /unknown/)
  assert.match(reason({ target: '', text: 'hi' })!, /target/)
  const one = planOrder({ target: 's2', text: ' ship it ' }, on)
  assert.ok(one.ok); assert.deepEqual(one.targets, ['s2']); assert.equal(one.text, 'ship it')
  const all = planOrder({ target: 'all', text: 'stand-up' }, on)
  assert.ok(all.ok); assert.deepEqual(all.targets, ['s1', 's2'])
  assert.match(reason({ target: 'all', text: 'x' }, { allowOrders: true, known: [] })!, /no active sessions/)
})

await t('sendOrder gating: disabled by default -> failed with the tray hint', () => {
  const off = { allowOrders: false, known: ['s1'] }
  for (const target of ['all', 's1']) {
    const p = planOrder({ target, text: 'hello' }, off)
    assert.ok(!p.ok)
    assert.deepEqual(p.result.delivered, [])
    assert.equal(p.result.failed[0].reason, REASON_DISABLED)
    assert.equal(p.result.failed[0].agentId, target)
  }
})

// ---- session inbox -------------------------------------------------------------------------------

function socketPath(tag: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-office-test-${process.pid}-${tag}`
    : join(tmpdir(), `agent-office-test-${process.pid}-${tag}.sock`)
}

function listen(path: string, onData: (data: string) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('data', (d) => (buf += d))
      sock.on('end', () => {
        onData(buf)
        sock.end()
      })
    })
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}

await t('session inbox: writes the auth line, then the message, to the session socket', async () => {
  const path = socketPath('ok')
  let got: string | null = null
  const received = new Promise<void>((resolve) => {
    void listen(path, (d) => {
      got = d
      resolve()
    }).then((s) => (server = s))
  })
  let server: Server | null = null
  while (!server) await new Promise((r) => setTimeout(r, 10))
  const inbox = new SessionInbox()
  inbox.register('sess-1', { socketPath: path, token: 'tok-123' })
  const res = await inbox.deliver('sess-1', 'Ship the release\nnotes today')
  assert.deepEqual(res, { ok: true })
  await received
  // Wire format from docs/spikes-phase-a.md (4a): auth line, then ONE JSON line. Newlines survive
  // inside the JSON string; a plain-text second line is silently dropped by Claude Code.
  const lines = (got as unknown as string).split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[2], '')
  assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token: 'tok-123' })
  assert.deepEqual(JSON.parse(lines[1]), { type: 'user', message: { role: 'user', content: 'Ship the release\nnotes today' } })
  assert.equal(
    wirePayload('t', 'a\nb'),
    '{"type":"auth","token":"t"}\n{"type":"user","message":{"role":"user","content":"a\\nb"}}\n'
  )
  // Tokens never leak through serialisation.
  assert.ok(!JSON.stringify(inbox).includes('tok-123'))
  await new Promise<void>((r) => (server as Server).close(() => r()))
})

await t('session inbox: unregistered session -> not connected; dead socket -> failed without the token', async () => {
  const inbox = new SessionInbox()
  assert.deepEqual(await inbox.deliver('nobody', 'hi'), { ok: false, reason: REASON_NOT_CONNECTED })
  inbox.register('dead', { socketPath: socketPath('missing'), token: 'secret-token' })
  const res = await inbox.deliver('dead', 'hi', 2000)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.match(res.reason, /^delivery failed/)
    assert.ok(!res.reason.includes('secret-token'))
  }
  await assert.rejects(deliverToSocket({ socketPath: socketPath('missing2'), token: 'x' }, 'hi', 2000))
})

console.log(`\n${pass} rules tests passed\n`)

await import('./hosted.test.ts')
