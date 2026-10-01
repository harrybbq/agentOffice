// World layout + pathfinding tests against the default office theme. Imported by roster.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseMap } from '../src/theme/parse.ts'
import type { Rect } from '../src/theme/parse.ts'
import { slotCell, WorldLayout } from '../src/world/layout.ts'
import type { Block } from '../src/world/layout.ts'
import { CorridorNetwork } from '../src/world/corridors.ts'
import { doorNormal } from '../src/scene/roster.ts'
import type { Point } from '../src/scene/roster.ts'

const raw = (f: string) => JSON.parse(readFileSync(new URL(`../themes/office/${f}`, import.meta.url), 'utf8'))
const hqRaw = raw('hq.json')
const hqMap = parseMap(hqRaw)
const branchMap = parseMap(raw('branch.json'))

let pass = 0
const t = (name: string, fn: () => void) => { fn(); pass++; console.log('ok -', name) }

/** Builds a world: the HQ plus n branches, each connected by its corridor. */
function world(n: number): { l: WorldLayout; net: CorridorNetwork } {
  const l = new WorldLayout(hqMap, branchMap)
  const net = new CorridorNetwork(l)
  for (let i = 0; i < n; i++) assert.ok(net.connect(l.addBranch('T' + i)), `T${i} not connected`)
  return { l, net }
}
const navOf = (net: CorridorNetwork) => net.nav()
/** Component of the HQ inbox = the one every live character must be able to reach. */
const hqComp = (net: CorridorNetwork) => net.nav().componentAt(net.hqPoint())
const strictlyInside = (p: Point, r: Rect) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height
const allPoints = (b: Block) => [...b.locations.values()].flat()
const first = (b: Block, type: string) => b.locations.get(type)![0]

/** The sealed CEO office, from the HQ map's "ceo_room" area (inside its walls). */
const ceoArea = (() => {
  const o = hqRaw.layers.find((l: any) => l.name === 'furniture').objects.find((o: any) => o.name === 'ceo_room')
  return { x: o.x, y: o.y, width: o.width, height: o.height } as Rect
})()
const ceoRoom = (l: WorldLayout): Rect => ({ ...ceoArea, x: ceoArea.x + l.hq.offset.x, y: ceoArea.y + l.hq.offset.y })

/** Samples every 1 px along the polyline and checks it never enters a blocked rect. */
function assertClear(from: Point, path: Point[], blocked: Rect[], extra: Rect[] = []): void {
  let a = from
  for (const b of path) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)))
    for (let i = 0; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }
      for (const r of blocked) assert.ok(!strictlyInside(p, r), `path point (${p.x},${p.y}) inside blocked rect ${JSON.stringify(r)}`)
      for (const r of extra) assert.ok(!strictlyInside(p, r), `path point (${p.x},${p.y}) inside forbidden rect ${JSON.stringify(r)}`)
    }
    a = b
  }
}

/** Deterministic PRNG for repeatable random tests. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

t('slot cells: unique, fixed, roughly square', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) {
    const { col, row } = slotCell(i)
    const k = `${col},${row}`
    assert.ok(!seen.has(k)); seen.add(k)
    const side = Math.ceil(Math.sqrt(i + 1))
    assert.ok(col < side && row < side, `slot ${i} outside ${side}x${side}`)
  }
  assert.deepEqual([0, 1, 2, 3].map(slotCell), [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 1 }])
})

t('slot allocation is stable: removed slot reused, others never move', () => {
  const l = new WorldLayout(hqMap, branchMap)
  assert.equal(l.hq.slot, 0)
  const A = l.addBranch('A'); const B = l.addBranch('B'); const C = l.addBranch('C')
  assert.deepEqual([A.slot, B.slot, C.slot], [1, 2, 3])
  const aOff = { ...A.offset }; const bOff = { ...B.offset }; const cOff = { ...C.offset }; const hqOff = { ...l.hq.offset }
  assert.equal(l.addBranch('A'), A) // idempotent
  assert.ok(l.removeBranch('B'))
  assert.equal(l.branch('B'), undefined)
  const D = l.addBranch('D')
  assert.equal(D.slot, 2); assert.deepEqual(D.offset, bOff)
  assert.deepEqual(l.branch('A')!.offset, aOff); assert.deepEqual(l.branch('C')!.offset, cOff)
  // Growing past a 2x2 grid must not move anything already placed.
  for (const id of ['E', 'F', 'G', 'H', 'I']) l.addBranch(id)
  assert.deepEqual(l.branch('A')!.offset, aOff); assert.deepEqual(l.branch('C')!.offset, cOff)
  assert.deepEqual(l.branch('D')!.offset, bOff); assert.deepEqual(l.hq.offset, hqOff)
  assert.deepEqual(l.branches().map((b) => b.slot).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8])
})

t('blocks sit inside bounds, never overlap, with corridors >= 2 tiles between them', () => {
  const l = new WorldLayout(hqMap, branchMap)
  for (let i = 0; i < 8; i++) l.addBranch('T' + i)
  const b = l.bounds()
  const blocks = l.all()
  for (const x of blocks) {
    assert.ok(x.offset.x >= b.x + l.tile && x.offset.y >= b.y + l.tile)
    assert.ok(x.offset.x + x.width <= b.x + b.width - l.tile && x.offset.y + x.height <= b.y + b.height - l.tile)
  }
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const p = blocks[i]; const q = blocks[j]
      const gapX = Math.max(q.offset.x - (p.offset.x + p.width), p.offset.x - (q.offset.x + q.width))
      const gapY = Math.max(q.offset.y - (p.offset.y + p.height), p.offset.y - (q.offset.y + q.height))
      assert.ok(Math.max(gapX, gapY) >= 2 * l.tile, `blocks ${p.id} and ${q.id} too close`)
    }
  }
})

t('door gaps are open; every corridor door opens onto its corridor and the HQ network', () => {
  const { l, net } = world(3)
  const nav = navOf(net)
  const hub = nav.componentAt(net.hqPoint())
  assert.ok(hub >= 0)
  let doors = 0
  for (const c of net.corridors()) {
    for (const [id, name] of [[c.fromBlock, c.fromDoor], [c.toBlock, c.toDoor]]) {
      const b = l.all().find((x) => x.id === id)!
      const d = b.locations.get('door')!.find((x) => x.name === name)!
      const n = doorNormal(b, d)
      assert.equal(nav.componentAt({ x: d.x + n.x * 8, y: d.y + n.y * 8 }), hub, `door ${b.id}/${d.name} outside`)
      assert.equal(nav.componentAt({ x: d.x - n.x * 12, y: d.y - n.y * 12 }), hub, `door ${b.id}/${d.name} inside`)
      doors++
    }
  }
  assert.ok(doors >= 6)
  // The branch manager-room door (x 64..112) keeps 3 free half-tile cells.
  const b = l.branch('T0')!
  let free = 0
  for (let x = 64; x < 112; x += 16) if (nav.isFreeAt({ x: b.offset.x + x + 8, y: b.offset.y + 164 })) free++
  assert.equal(free, 3)
})

t('A* never crosses a wall or solid furniture (1 px sampling of smoothed paths)', () => {
  const { l, net } = world(4)
  const nav = navOf(net)
  const blocked = l.blocked()
  const pts = l.all().flatMap(allPoints).filter((p) => nav.componentAt(p) === hqComp(net))
  const rand = rng(42)
  let paths = 0
  for (let k = 0; k < 400; k++) {
    const a = pts[Math.floor(rand() * pts.length)]
    const b = pts[Math.floor(rand() * pts.length)]
    const path = nav.findPath(a, b)
    assert.ok(path, `no path ${a.name} -> ${b.name}`)
    assertClear(a, path, blocked, [ceoRoom(l)])
    paths++
  }
  const bounds = l.bounds()
  // Random free points anywhere walkable (most of the world is outside now).
  for (let k = 0, tries = 0; k < 300 && tries < 20000; tries++) {
    const a = { x: rand() * bounds.width, y: rand() * bounds.height }
    const b = { x: rand() * bounds.width, y: rand() * bounds.height }
    if (!nav.isFreeAt(a)) continue
    const path = nav.findPath(a, b)
    if (path) assertClear(a, path, blocked)
    paths++
    k++
  }
  assert.ok(paths > 500)
})

t('smoothing: a straight corridor walk is a single segment', () => {
  const { net } = world(1)
  const nav = navOf(net)
  // T0 sits right of the HQ: its corridor is one straight run from the HQ's right door.
  const c = net.corridors().find((x) => x.toBlock === 'T0')!
  assert.equal(c.strip.length, 1)
  const a = net.cellCenter(c.path[0])
  const b = net.cellCenter(c.path[c.path.length - 1])
  const path = nav.findPath(a, b)!
  assert.equal(path.length, 1)
})

t('every branch point can reach every HQ inbox slot and the inbox queue', () => {
  const { l, net } = world(4)
  const nav = navOf(net)
  const inboxes = l.hq.locations.get('inbox')!
  const door = l.hq.locations.get('door')!.find((d) => d.name === 'door_bottom')!
  const queueSpot = { x: door.x, y: door.y + 44 }
  for (const b of l.branches()) {
    for (const p of allPoints(b)) {
      for (const ib of inboxes) {
        const path = nav.findPath(p, ib)
        assert.ok(path && path.length > 0, `${b.id}/${p.name} can't reach ${ib.name}`)
        assert.deepEqual(path[path.length - 1], { x: ib.x, y: ib.y })
      }
      assert.ok(nav.findPath(p, queueSpot), `${b.id}/${p.name} can't reach the inbox queue`)
    }
  }
})

t('nothing inside the sealed CEO office is reachable from any branch', () => {
  const { l, net } = world(4)
  const nav = navOf(net)
  const room = ceoRoom(l)
  let cells = 0
  for (let y = room.y + 8; y < room.y + room.height; y += 16) {
    for (let x = room.x + 8; x < room.x + room.width; x += 16) {
      const target = { x, y }
      if (!nav.isFreeAt(target)) continue
      cells++
      for (const b of l.branches()) {
        for (const p of allPoints(b)) {
          assert.notEqual(nav.componentAt(p), nav.componentAt(target))
        }
        const path = nav.findPath(first(b, 'entrance'), target)
        if (path) {
          // A goal right against the wall may snap to reception; it must never end inside.
          const end = path[path.length - 1]
          assert.ok(!strictlyInside(end, room), `reached (${x},${y}) in the CEO office from ${b.id}`)
          assertClear(first(b, 'entrance'), path, l.blocked(), [room])
        }
      }
    }
  }
  assert.ok(cells > 50, `expected free cells in the CEO office, found ${cells}`)
})

t('the HQ boss_seat is unreachable from outside the CEO office', () => {
  const { l, net } = world(4)
  const nav = navOf(net)
  const seat = first(l.hq, 'boss_seat')
  assert.ok(nav.isFreeAt(seat))
  const froms: Point[] = [...l.hq.locations.get('inbox')!, ...l.hq.locations.get('door')!]
  for (const b of l.branches()) froms.push(...allPoints(b))
  for (const p of froms) assert.equal(nav.findPath(p, seat), null, `boss_seat reachable from (${p.x},${p.y})`)
  // The boss itself can move around inside its office.
  assert.ok(nav.findPath(seat, { x: seat.x + 60, y: seat.y + 60 }))
})

t('grid rebuild after removing a branch; paths still valid', () => {
  const { l, net } = world(4)
  const before = l.bounds()
  l.removeBranch('T3') // slot 4 (col 2) -> bounds shrink back to 2x2
  net.remove('T3')
  const after = l.bounds()
  assert.ok(after.width < before.width)
  const nav = navOf(net)
  const path = nav.findPath(first(l.branch('T2')!, 'entrance'), l.hq.locations.get('inbox')![0])
  assert.ok(path); assertClear(first(l.branch('T2')!, 'entrance'), path, l.blocked())
})

t('performance: corner-to-corner path in a ~120x90 tile world', () => {
  const t00 = performance.now()
  const { l, net } = world(35)
  const routing = performance.now() - t00
  const b = l.bounds()
  const t0 = performance.now()
  const nav = navOf(net)
  const t1 = performance.now()
  const far = l.branches().reduce((m, x) => (x.slot > m.slot ? x : m))
  const path = nav.findPath(first(far, 'manager_seat'), l.hq.locations.get('inbox')![0])
  const t2 = performance.now()
  assert.ok(path)
  assertClear(first(far, 'manager_seat'), path, l.blocked())
  console.log(`   world ${b.width / 32}x${b.height / 32} tiles, grid ${nav.cols}x${nav.rows}: 35 corridors ${routing.toFixed(0)} ms, build ${(t1 - t0).toFixed(1)} ms, path ${(t2 - t1).toFixed(1)} ms, ${path.length} waypoints`)
  assert.ok(t2 - t1 < 250)
})

console.log(`\n${pass} world tests passed`)

await import('./corridors.test.ts')
