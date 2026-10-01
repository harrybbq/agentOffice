// Corridor network: 2-tile-wide hallways built through the outside space between blocks. Pure logic.
//
// The space between blocks is not walkable; only block interiors and built corridors are. A
// corridor is an ordered polyline of lattice cells (16 px apart, = the nav grid cell); each cell
// stands for a 2x2-tile square centred on it, so consecutive cells overlap into a solid strip.
//
// Routing a new branch: multi-source A* over the cells outside every lot footprint (built or not,
// so a future branch never lands on a corridor), with a turn penalty and no U-turns. Sources are
// the doors of blocks reachable from the HQ and every cell of an existing corridor reachable from
// the HQ (branching off it); the target is any door of the new branch. A corridor that branches
// off another stores the full polyline from the original door, so every corridor starts at a door.
//
// Removing a branch drops its corridors. A branch that can then no longer reach the HQ (because
// its corridor started at the removed branch's door) gets a repair corridor. Cells no remaining
// corridor uses are retracted, far end first.
import type { Rect } from '../theme/parse'
import type { LocationPoint, Point } from '../scene/roster'
import { doorNormal, nearest } from '../scene/roster'
import { HQ_ID, unionRects } from './layout'
import type { Block, WorldLayout } from './layout'
import { CELL, MinHeap, NavGrid } from './pathfinding'

/** Lattice cell: world centre is (x * step, y * step). */
export interface Cell {
  x: number
  y: number
}

export interface Corridor {
  id: string
  fromBlock: string
  toBlock: string
  fromDoor: string
  toDoor: string
  /** Ordered polyline: path[0] is outside a door of fromBlock, the last cell outside a door of toBlock. */
  path: Cell[]
  /** Leading cells that already existed (another corridor) when this one was planned. */
  shared: number
  /** One rect per straight run of the path: the walkable strip. */
  strip: Rect[]
  /** The HQ porch: built from the start, never removed. */
  permanent: boolean
  /** Planned to reconnect a branch cut off by a removal. */
  repair: boolean
}

export interface RemovalPlan {
  /** Corridors dropped from the network (the removed branch's, plus those of stranded branches). */
  removed: Corridor[]
  /** Cells no remaining corridor uses, in retraction order (far ends first). */
  retract: Cell[]
  /** New corridors that reconnect branches the removal would have cut off. */
  repairs: Corridor[]
}

/** Extra cost of a 90 degree turn, in cells (16 px each). */
export const TURN_COST = 4

const DIRS = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 }
]
const NO_DIR = 4

function dirOf(v: Point): number {
  if (v.x > 0) return 0
  if (v.y > 0) return 1
  if (v.x < 0) return 2
  return 3
}

export function blockRect(b: Block): Rect {
  return { x: b.offset.x, y: b.offset.y, width: b.width, height: b.height }
}

/**
 * Nav grid where only the given blocks' interiors and corridor rects are walkable.
 * The grid covers `minBounds` plus everything walkable.
 */
export function buildNav(minBounds: Rect, blocks: Block[], corridorRects: Rect[]): NavGrid {
  const walk = [...blocks.map(blockRect), ...corridorRects]
  const u = unionRects([minBounds, ...walk])!
  const bounds = { x: 0, y: 0, width: u.x + u.width, height: u.y + u.height }
  return new NavGrid(bounds, blocks.flatMap((b) => b.blocked), walk)
}

interface Grid {
  w: number
  h: number
  valid: Uint8Array
}

interface Source {
  cell: Cell
  dir: number
  block?: Block
  door?: LocationPoint
  corridor?: Corridor
  index?: number
}

interface Target {
  dir: number
  extra: number
  door: LocationPoint
}

export class CorridorNetwork {
  /** Lattice spacing (px). */
  readonly step = CELL
  /** Half the corridor width (px): corridors are 2 tiles wide. */
  readonly half: number
  private list: Corridor[] = []
  private seq = 0
  /** Blocks treated as gone while planning a removal. */
  private ignore = new Set<string>()

  constructor(readonly layout: WorldLayout) {
    this.half = layout.tile
    this.addPorch()
  }

  corridors(): Corridor[] {
    return [...this.list]
  }

  get(id: string): Corridor | undefined {
    return this.list.find((c) => c.id === id)
  }

  key(c: Cell): number {
    return c.x * 65536 + c.y
  }

  cellRect(c: Cell): Rect {
    const h = this.half
    return { x: c.x * this.step - h, y: c.y * this.step - h, width: 2 * h, height: 2 * h }
  }

  cellCenter(c: Cell): Point {
    return { x: c.x * this.step, y: c.y * this.step }
  }

  /** Every cell of every corridor, once. */
  cells(): Cell[] {
    const seen = new Map<number, Cell>()
    for (const c of this.list) for (const p of c.path) seen.set(this.key(p), p)
    return [...seen.values()]
  }

  /** The cell just outside a door: snapped along the edge, one half-width out. */
  doorCell(block: Block, door: Point): Cell {
    const n = doorNormal(block, door)
    const s = this.step
    if (n.y !== 0) {
      const edge = n.y < 0 ? block.offset.y : block.offset.y + block.height
      return { x: Math.round(door.x / s), y: Math.round((edge + n.y * this.half) / s) }
    }
    const edge = n.x < 0 ? block.offset.x : block.offset.x + block.width
    return { x: Math.round((edge + n.x * this.half) / s), y: Math.round(door.y / s) }
  }

  /** Nav grid of the planned world: every block in the layout plus every corridor. */
  nav(): NavGrid {
    return this.navOf(this.liveBlocks())
  }

  /** A point inside the HQ that everyone must be able to reach (the first inbox slot). */
  hqPoint(): Point {
    const hq = this.layout.hq
    const ib = hq.locations.get('inbox')?.[0]
    if (ib) return ib
    const d = hq.locations.get('door')?.[0]
    if (!d) return { x: hq.offset.x + hq.width / 2, y: hq.offset.y + hq.height / 2 }
    const n = doorNormal(hq, d)
    return { x: d.x - n.x * 12, y: d.y - n.y * 12 }
  }

  /** True if one of the block's doors leads into the HQ's component. */
  reachable(nav: NavGrid, block: Block, hqComp = nav.componentAt(this.hqPoint())): boolean {
    if (hqComp < 0) return false
    if (block.id === HQ_ID) return true
    for (const d of block.locations.get('door') ?? []) {
      const n = doorNormal(block, d)
      if (nav.componentAt({ x: d.x - n.x * 12, y: d.y - n.y * 12 }) === hqComp) return true
    }
    return false
  }

  /**
   * Plans the corridor for a newly placed block (already in the layout). null if it can't be
   * reached (it stays unconnected). The corridor is registered in the network.
   */
  connect(block: Block, repair = false): Corridor | null {
    const others = this.liveBlocks().filter((b) => b.id !== block.id)
    const nav = this.navOf(others)
    const hqComp = nav.componentAt(this.hqPoint())
    const grid = this.grid()
    const valid = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < grid.w && c.y < grid.h && grid.valid[c.y * grid.w + c.x] === 1

    const sources: Source[] = []
    for (const b of others) {
      for (const d of b.locations.get('door') ?? []) {
        const n = doorNormal(b, d)
        if (nav.componentAt({ x: d.x - n.x * 12, y: d.y - n.y * 12 }) !== hqComp) continue
        const cell = this.doorCell(b, d)
        if (valid(cell)) sources.push({ cell, dir: dirOf(n), block: b, door: d })
      }
    }
    for (const c of this.list) {
      c.path.forEach((cell, index) => {
        if (valid(cell) && nav.componentAt(this.cellCenter(cell)) === hqComp) {
          sources.push({ cell, dir: NO_DIR, corridor: c, index })
        }
      })
    }

    const entrance = nearest(block.locations, 'entrance', block.offset) ?? block.offset
    const targets = new Map<number, Target[]>()
    const targetCells: Cell[] = []
    for (const d of block.locations.get('door') ?? []) {
      const cell = this.doorCell(block, d)
      if (!valid(cell)) continue
      const n = doorNormal(block, d)
      // Ties go to the door nearest the entrance, where characters arrive.
      const extra = (Math.hypot(d.x - entrance.x, d.y - entrance.y) / this.step) * 0.001
      const v = cell.y * grid.w + cell.x
      if (!targets.has(v)) targets.set(v, [])
      targets.get(v)!.push({ dir: dirOf({ x: -n.x, y: -n.y }), extra, door: d })
      targetCells.push(cell)
    }
    if (sources.length === 0 || targets.size === 0) return null

    const found = this.astar(grid, sources, targets, targetCells)
    if (!found) return null
    const { cells, source, target } = found

    let path: Cell[]
    let fromBlock: string
    let fromDoor: string
    if (source.corridor) {
      path = [...source.corridor.path.slice(0, source.index! + 1), ...cells.slice(1)]
      fromBlock = source.corridor.fromBlock
      fromDoor = source.corridor.fromDoor
    } else {
      path = cells
      fromBlock = source.block!.id
      fromDoor = source.door!.name
    }
    path = this.removeLoops(path)
    const existing = new Set(this.cells().map((c) => this.key(c)))
    let shared = 0
    while (shared < path.length && existing.has(this.key(path[shared]))) shared++

    const corridor: Corridor = {
      id: `${repair ? 'repair' : 'corridor'}-${++this.seq}`,
      fromBlock,
      toBlock: block.id,
      fromDoor,
      toDoor: target.door.name,
      path,
      shared,
      strip: this.stripOf(path),
      permanent: false,
      repair
    }
    this.list.push(corridor)
    return corridor
  }

  /**
   * Drops a removed block's corridors and keeps every other branch connected to the HQ.
   * Call after the block left the layout (it is ignored either way).
   */
  remove(blockId: string): RemovalPlan {
    this.ignore.add(blockId)
    try {
      const removed = this.list.filter((c) => !c.permanent && c.toBlock === blockId)
      this.list = this.list.filter((c) => !removed.includes(c))

      // Branches cut off from the HQ (their corridor started at the removed block's door, directly
      // or via another stranded branch). Upstream ones first: once repaired, those downstream of
      // them are usually reachable again through their rooms and keep their corridors.
      const live = this.liveBlocks()
      const stranded = live
        .filter((b) => b.kind === 'branch' && !this.reachable(this.navOf(live), b))
        .sort((a, b) => this.depth(a.id) - this.depth(b.id) || a.slot - b.slot)
      const repairs: Corridor[] = []
      for (const b of stranded) {
        if (this.reachable(this.navOf(this.liveBlocks()), b)) continue
        const dead = this.list.filter((c) => !c.permanent && c.toBlock === b.id)
        removed.push(...dead)
        this.list = this.list.filter((c) => !dead.includes(c))
        const c = this.connect(b, true)
        if (c) repairs.push(c)
      }

      const keep = new Set(this.cells().map((c) => this.key(c)))
      const retract: Cell[] = []
      for (const c of removed) {
        for (let i = c.path.length - 1; i >= 0; i--) {
          const k = this.key(c.path[i])
          if (keep.has(k)) continue
          keep.add(k)
          retract.push(c.path[i])
        }
      }
      return { removed, retract, repairs }
    } finally {
      this.ignore.delete(blockId)
    }
  }

  // ---- internals -----------------------------------------------------------------------------

  /** How many corridors deep a block hangs off the network (0 for the HQ or no corridor). */
  private depth(id: string, seen = new Set<string>()): number {
    const c = this.list.find((x) => !x.permanent && x.toBlock === id)
    if (!c || c.fromBlock === HQ_ID || seen.has(id)) return 0
    seen.add(id)
    return 1 + this.depth(c.fromBlock, seen)
  }

  private liveBlocks(): Block[] {
    return this.layout.all().filter((b) => !this.ignore.has(b.id))
  }

  private navOf(blocks: Block[]): NavGrid {
    return buildNav(
      this.layout.bounds(),
      blocks,
      this.cells().map((c) => this.cellRect(c))
    )
  }

  /** Lattice over the layout bounds; a cell is valid when its square stays outside every lot. */
  private grid(): Grid {
    const b = this.layout.bounds()
    const s = this.step
    const h = this.half
    const w = Math.floor((b.x + b.width) / s) + 1
    const hh = Math.floor((b.y + b.height) / s) + 1
    const valid = new Uint8Array(w * hh)
    const x0 = Math.ceil(h / s)
    const x1 = Math.floor((b.x + b.width - h) / s)
    const y0 = Math.ceil(h / s)
    const y1 = Math.floor((b.y + b.height - h) / s)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) valid[y * w + x] = 1
    for (const f of this.layout.footprintsIn(b)) {
      // Square [c*s - h, c*s + h] overlaps (f.x, f.x + f.width) with open intervals.
      const i0 = Math.max(0, Math.floor((f.x - h) / s) + 1)
      const i1 = Math.min(w - 1, Math.ceil((f.x + f.width + h) / s) - 1)
      const j0 = Math.max(0, Math.floor((f.y - h) / s) + 1)
      const j1 = Math.min(hh - 1, Math.ceil((f.y + f.height + h) / s) - 1)
      for (let y = j0; y <= j1; y++) for (let x = i0; x <= i1; x++) valid[y * w + x] = 0
    }
    return { w, h: hh, valid }
  }

  /** (cell, heading) A* with a turn penalty; a virtual goal makes arriving straight into a door free. */
  private astar(
    grid: Grid,
    sources: Source[],
    targets: Map<number, Target[]>,
    targetCells: Cell[]
  ): { cells: Cell[]; source: Source; target: Target } | null {
    const { w, h, valid } = grid
    const n = w * h * 5
    const GOAL = n
    const g = new Float64Array(n).fill(Infinity)
    const parent = new Int32Array(n).fill(-1)
    const closed = new Uint8Array(n)
    const srcAt = new Map<number, Source>()
    const heur = (v: number) => {
      const x = v % w
      const y = (v - x) / w
      let best = Infinity
      for (const t of targetCells) best = Math.min(best, Math.abs(t.x - x) + Math.abs(t.y - y))
      return best
    }
    const heap = new MinHeap()
    for (const s of sources) {
      const st = (s.cell.y * w + s.cell.x) * 5 + s.dir
      if (srcAt.has(st)) continue
      srcAt.set(st, s)
      g[st] = 0
      heap.push(st, heur(st / 5 | 0))
    }
    let goalCost = Infinity
    let goalFrom = -1
    let goalTarget: Target | null = null
    while (heap.size > 0) {
      const st = heap.pop()
      if (st === GOAL) break
      if (closed[st]) continue
      closed[st] = 1
      const v = (st / 5) | 0
      const d = st % 5
      const ts = targets.get(v)
      if (ts) {
        for (const t of ts) {
          const total = g[st] + (d === NO_DIR || d === t.dir ? 0 : TURN_COST) + t.extra
          if (total < goalCost) {
            goalCost = total
            goalFrom = st
            goalTarget = t
            heap.push(GOAL, total)
          }
        }
      }
      const x = v % w
      const y = (v - x) / w
      for (let nd = 0; nd < 4; nd++) {
        if (d !== NO_DIR && nd === (d + 2) % 4) continue // no U-turns
        const nx = x + DIRS[nd].x
        const ny = y + DIRS[nd].y
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const nv = ny * w + nx
        if (!valid[nv]) continue
        const ns = nv * 5 + nd
        if (closed[ns]) continue
        const ng = g[st] + 1 + (d !== NO_DIR && nd !== d ? TURN_COST : 0)
        if (ng < g[ns]) {
          g[ns] = ng
          parent[ns] = st
          heap.push(ns, ng + heur(nv))
        }
      }
    }
    if (goalFrom < 0 || !goalTarget) return null
    const states: number[] = []
    for (let st = goalFrom; st >= 0; st = parent[st]) states.push(st)
    states.reverse()
    const source = srcAt.get(states[0])!
    const cells = states.map((st) => {
      const v = (st / 5) | 0
      return { x: v % w, y: (v / w) | 0 }
    })
    return { cells, source, target: goalTarget }
  }

  /** Cuts out any loop (a cell visited twice), keeping the polyline simple. */
  private removeLoops(path: Cell[]): Cell[] {
    const out: Cell[] = []
    const at = new Map<number, number>()
    for (const c of path) {
      const k = this.key(c)
      const i = at.get(k)
      if (i !== undefined) {
        for (const r of out.splice(i + 1)) at.delete(this.key(r))
        continue
      }
      at.set(k, out.length)
      out.push(c)
    }
    return out
  }

  private stripOf(path: Cell[]): Rect[] {
    const rects: Rect[] = []
    let start = 0
    for (let i = 1; i <= path.length; i++) {
      const runEnds =
        i === path.length ||
        (i >= start + 2 &&
          (path[i].x - path[i - 1].x !== path[i - 1].x - path[i - 2].x ||
            path[i].y - path[i - 1].y !== path[i - 1].y - path[i - 2].y))
      if (runEnds) {
        rects.push(unionRects([this.cellRect(path[start]), this.cellRect(path[i - 1])])!)
        start = i - 1
      }
    }
    return rects
  }

  /** A short built strip along the HQ edge outside the door nearest the inbox (the inbox queue). */
  private addPorch(): void {
    const hq = this.layout.hq
    const inbox = hq.locations.get('inbox') ?? []
    const centroid = inbox.length
      ? { x: inbox.reduce((s, p) => s + p.x, 0) / inbox.length, y: inbox.reduce((s, p) => s + p.y, 0) / inbox.length }
      : { x: hq.offset.x + hq.width / 2, y: hq.offset.y + hq.height }
    const door = nearest(hq.locations, 'door', centroid)
    if (!door) return
    const grid = this.grid()
    const valid = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < grid.w && c.y < grid.h && grid.valid[c.y * grid.w + c.x] === 1
    const start = this.doorCell(hq, door)
    if (!valid(start)) return
    const n = doorNormal(hq, door)
    const along = n.y !== 0 ? { x: 1, y: 0 } : { x: 0, y: 1 }
    const lo = n.y !== 0 ? hq.offset.x + this.half : hq.offset.y + this.half
    const hi = n.y !== 0 ? hq.offset.x + hq.width - this.half : hq.offset.y + hq.height - this.half
    for (const sign of [-1, 1]) {
      const path: Cell[] = [start]
      for (;;) {
        const last = path[path.length - 1]
        const next = { x: last.x + along.x * sign, y: last.y + along.y * sign }
        const coord = (n.y !== 0 ? next.x : next.y) * this.step
        if (coord < lo || coord > hi || !valid(next)) break
        path.push(next)
      }
      if (path.length < 2) continue
      this.list.push({
        id: `porch-${sign < 0 ? 'a' : 'b'}`,
        fromBlock: HQ_ID,
        toBlock: HQ_ID,
        fromDoor: door.name,
        toDoor: door.name,
        path,
        shared: 0,
        strip: this.stripOf(path),
        permanent: true,
        repair: false
      })
    }
  }
}
