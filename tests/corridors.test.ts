// Corridor network tests against the default office theme. Imported by world.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseMap } from '../src/theme/parse.ts'
import type { Rect } from '../src/theme/parse.ts'
import { HQ_ID, WorldLayout } from '../src/world/layout.ts'
import type { Block } from '../src/world/layout.ts'
import { blockRect, CorridorNetwork } from '../src/world/corridors.ts'
import type { Cell, Corridor } from '../src/world/corridors.ts'

const raw = (f: string) => JSON.parse(readFileSync(new URL(`../themes/office/${f}`, import.meta.url), 'utf8'))
const hqRaw = raw('hq.json')
const hqMap = parseMap(hqRaw)
const branchMap = parseMap(raw('branch.json'))

let pass = 0
const t = (name: string, fn: () => void) => { fn(); pass++; console.log('ok -', name) }

const overlapsOpen = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

function setup() {
  const l = new WorldLayout(hqMap, branchMap)
  return { l, net: new CorridorNetwork(l) }
}

/** The door cell of `name` on block b, or a failure. */
function doorCellOf(net: CorridorNetwork, b: Block, name: string): Cell {
  const d = b.locations.get('door')!.find((x) => x.name === name)
  assert.ok(d, `${b.id} has no door ${name}`)
  return net.doorCell(b, d)
}

function assertCorridorShape(net: CorridorNetwork, c: Corridor): void {
  for (let i = 1; i < c.path.length; i++) {
    const a = c.path[i - 1]
    const b = c.path[i]
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, `${c.id}: cells ${i - 1},${i} not adjacent`)
  }
  assert.equal(new Set(c.path.map((p) => net.key(p))).size, c.path.length, `${c.id} revisits a cell`)
  // The strip covers exactly the cells' squares.
  for (const p of c.path) assert.ok(c.strip.some((r) => inside(net.cellCenter(p), r)))
}

/** Every live block is reachable from the HQ inbox; nothing reaches the boss seat. */
function assertConnected(l: WorldLayout, net: CorridorNetwork): void {
  const nav = net.nav()
  const hub = nav.componentAt(net.hqPoint())
  assert.ok(hub >= 0)
  for (const b of l.branches()) {
    const e = b.locations.get('entrance')![0]
    assert.equal(nav.componentAt(e), hub, `${b.id} cut off from the HQ`)
    assert.ok(nav.findPath(e, net.hqPoint()), `${b.id} has no path to the inbox`)
  }
  assert.notEqual(nav.componentAt(l.hq.locations.get('boss_seat')![0]), hub, 'CEO office reachable')
}

t('the HQ porch is built from the start, outside the HQ door, and holds the inbox queue', () => {
  const { l, net } = setup()
  const porch = net.corridors().filter((c) => c.permanent)
  assert.equal(porch.length, 2)
  const door = l.hq.locations.get('door')!.find((d) => d.name === 'door_bottom')!
  const nav = net.nav()
  const hub = nav.componentAt(net.hqPoint())
  // Queue spots (OverflowRow below the door, 20 px spacing) on the porch.
  for (const dx of [0, -20, 20, -60, 60, -120, 120]) {
    for (const dy of [3, 23, 43]) assert.equal(nav.componentAt({ x: door.x + dx, y: door.y + dy }), hub)
  }
})

t('every new corridor starts at a built block\'s door and ends at the new branch\'s door', () => {
  const { l, net } = setup()
  const built = new Set<string>([HQ_ID])
  for (let i = 0; i < 12; i++) {
    const b = l.addBranch('T' + i)
    const c = net.connect(b)
    assert.ok(c, `T${i} not connected`)
    assert.equal(c.toBlock, b.id)
    assert.ok(built.has(c.fromBlock), `T${i} corridor starts at unbuilt ${c.fromBlock}`)
    const from = l.all().find((x) => x.id === c.fromBlock)!
    assert.deepEqual(c.path[0], doorCellOf(net, from, c.fromDoor), `T${i} does not start at ${c.fromBlock}/${c.fromDoor}`)
    assert.deepEqual(c.path[c.path.length - 1], doorCellOf(net, b, c.toDoor), `T${i} does not end at its door`)
    // The end squares touch their doors: the door point lies on the square's edge.
    const d0 = from.locations.get('door')!.find((d) => d.name === c.fromDoor)!
    const d1 = b.locations.get('door')!.find((d) => d.name === c.toDoor)!
    assert.ok(inside(d0, net.cellRect(c.path[0])))
    assert.ok(inside(d1, net.cellRect(c.path[c.path.length - 1])))
    assertCorridorShape(net, c)
    built.add(b.id)
  }
})

t('corridors never pass through any block or any free lot', () => {
  const { l, net } = setup()
  for (let i = 0; i < 15; i++) net.connect(l.addBranch('T' + i))
  const lots = l.footprintsIn(l.bounds())
  assert.ok(lots.length >= 16)
  for (const c of net.corridors()) {
    for (const p of c.path) {
      const r = net.cellRect(p)
      for (const b of l.all()) assert.ok(!overlapsOpen(r, blockRect(b)), `${c.id} enters block ${b.id}`)
      for (const f of lots) assert.ok(!overlapsOpen(r, f), `${c.id} enters a lot`)
    }
  }
})

t('removing B keeps A and C reachable; B\'s corridor goes unless C depends on it', () => {
  const { l, net } = setup()
  for (const id of ['A', 'B', 'C']) net.connect(l.addBranch(id))
  const bCorr = net.corridors().find((c) => c.toBlock === 'B')!
  l.removeBranch('B')
  const plan = net.remove('B')
  assert.ok(plan.removed.includes(bCorr))
  assert.ok(!net.corridors().some((c) => c.toBlock === 'B'))
  const keep = new Set(net.cells().map((c) => net.key(c)))
  const retracted = new Set(plan.retract.map((c) => net.key(c)))
  for (const p of bCorr.path) {
    const k = net.key(p)
    assert.ok(keep.has(k) !== retracted.has(k), 'each cell of B\'s corridor is either kept (still used) or retracted')
  }
  assert.ok(plan.retract.length > 0)
  // Retraction starts at B's end.
  assert.deepEqual(plan.retract[0], bCorr.path[bCorr.path.length - 1])
  assertConnected(l, net)
})

t('a branch hanging off a removed branch\'s door gets a repair corridor', () => {
  const { l, net } = setup()
  for (const id of ['A', 'B', 'C']) net.connect(l.addBranch(id))
  // In this layout C (slot 3) is closest to B's (slot 2) right door.
  const cCorr = net.corridors().find((c) => c.toBlock === 'C')!
  assert.equal(cCorr.fromBlock, 'B')
  l.removeBranch('B')
  const plan = net.remove('B')
  assert.equal(plan.repairs.length, 1)
  const r = plan.repairs[0]
  assert.equal(r.toBlock, 'C'); assert.ok(r.repair)
  assert.ok(['A', HQ_ID].includes(r.fromBlock))
  assert.ok(!net.corridors().includes(cCorr))
  assertConnected(l, net)
})

t('random add/remove sequences keep every live branch connected; retracted cells are unused', () => {
  const rand = rng(7)
  for (let round = 0; round < 6; round++) {
    const { l, net } = setup()
    const live: string[] = []
    let n = 0
    for (let step = 0; step < 30; step++) {
      if (live.length === 0 || (rand() < 0.6 && live.length < 10)) {
        const id = `R${n++}`
        assert.ok(net.connect(l.addBranch(id)))
        live.push(id)
      } else {
        const id = live.splice(Math.floor(rand() * live.length), 1)[0]
        l.removeBranch(id)
        const plan = net.remove(id)
        const used = new Set(net.cells().map((c) => net.key(c)))
        for (const c of plan.retract) assert.ok(!used.has(net.key(c)), 'retracted a cell still in use')
      }
      assertConnected(l, net)
      for (const c of net.corridors()) {
        assertCorridorShape(net, c)
        for (const p of c.path) for (const b of l.all()) assert.ok(!overlapsOpen(net.cellRect(p), blockRect(b)))
      }
    }
  }
})

t('nothing outside blocks and corridors is walkable', () => {
  const { l, net } = setup()
  for (let i = 0; i < 6; i++) net.connect(l.addBranch('T' + i))
  const nav = net.nav()
  const blocks = l.all().map(blockRect)
  const strips = net.cells().map((c) => net.cellRect(c))
  let free = 0
  for (let i = 0; i < nav.cols * nav.rows; i++) {
    if (nav.blocked[i]) continue
    free++
    const p = nav.center(i)
    assert.ok(blocks.some((r) => inside(p, r)) || strips.some((r) => inside(p, r)), `(${p.x},${p.y}) walkable outside`)
  }
  assert.ok(free > 1000)
  // The gutter between two branches with no corridor is not walkable: the outer margin corner.
  assert.ok(!nav.isFreeAt({ x: 8, y: 8 }))
})

t('the sealed CEO office stays unreachable with corridors on every side', () => {
  const { l, net } = setup()
  for (let i = 0; i < 8; i++) net.connect(l.addBranch('T' + i))
  const nav = net.nav()
  const seat = l.hq.locations.get('boss_seat')![0]
  for (const b of l.branches()) assert.equal(nav.findPath(b.locations.get('entrance')![0], seat), null)
  for (const c of net.cells()) assert.equal(nav.findPath(net.cellCenter(c), seat), null)
  assert.equal(nav.findPath(net.hqPoint(), seat), null)
})

console.log(`\n${pass} corridor tests passed`)
