// A* on a half-tile grid over the world bounds, with line-of-sight path smoothing. Pure logic.
//
// With `walkable` rects (blocks + built corridors), only cells fully inside one of them are free;
// without, everything is. Then a cell is blocked if it overlaps (open intervals: touching edges
// don't count) any blocked rect.
// Walls are thin (8 px) and doors are >= 1 tile, so no inflation: a 32 px door keeps 2 free cells.
import type { Rect } from '../theme/parse'
import type { Point } from '../scene/roster'

export const CELL = 16
/** How far a goal inside a wall/solid furniture may be moved to the nearest free cell. */
const GOAL_SNAP_CELLS = 4
const START_SNAP_CELLS = 16
const SQRT2 = Math.SQRT2

/** Binary min-heap of cell indices keyed by f-score (lazy deletion by the caller). */
export class MinHeap {
  private idx: number[] = []
  private key: number[] = []

  get size(): number {
    return this.idx.length
  }

  push(i: number, k: number): void {
    const a = this.idx
    const b = this.key
    let n = a.length
    a.push(i)
    b.push(k)
    while (n > 0) {
      const p = (n - 1) >> 1
      if (b[p] <= k) break
      a[n] = a[p]
      b[n] = b[p]
      n = p
    }
    a[n] = i
    b[n] = k
  }

  pop(): number {
    const a = this.idx
    const b = this.key
    const top = a[0]
    const li = a.pop()!
    const lk = b.pop()!
    const len = a.length
    if (len > 0) {
      let n = 0
      for (;;) {
        let c = 2 * n + 1
        if (c >= len) break
        if (c + 1 < len && b[c + 1] < b[c]) c++
        if (b[c] >= lk) break
        a[n] = a[c]
        b[n] = b[c]
        n = c
      }
      a[n] = li
      b[n] = lk
    }
    return top
  }
}

export class NavGrid {
  readonly cols: number
  readonly rows: number
  readonly cell: number
  /** 1 = blocked. */
  readonly blocked: Uint8Array
  /** Connected component per cell (4-connected), -1 for blocked cells. */
  readonly comp: Int32Array

  constructor(bounds: Rect, rects: Rect[], walkable: Rect[] | null = null, cell = CELL) {
    this.cell = cell
    this.cols = Math.max(1, Math.ceil((bounds.x + bounds.width) / cell))
    this.rows = Math.max(1, Math.ceil((bounds.y + bounds.height) / cell))
    this.blocked = new Uint8Array(this.cols * this.rows)
    if (walkable) {
      this.blocked.fill(1)
      for (const r of walkable) this.clearInside(r)
    }
    for (const r of rects) this.rasterize(r)
    this.comp = new Int32Array(this.cols * this.rows).fill(-1)
    this.label()
  }

  private rasterize(r: Rect): void {
    if (r.width <= 0 || r.height <= 0) return
    const c0 = Math.max(0, Math.floor(r.x / this.cell))
    const c1 = Math.min(this.cols - 1, Math.ceil((r.x + r.width) / this.cell) - 1)
    const r0 = Math.max(0, Math.floor(r.y / this.cell))
    const r1 = Math.min(this.rows - 1, Math.ceil((r.y + r.height) / this.cell) - 1)
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) this.blocked[y * this.cols + x] = 1
  }

  /** Frees the cells lying fully inside r. */
  private clearInside(r: Rect): void {
    const c0 = Math.max(0, Math.ceil(r.x / this.cell - 1e-9))
    const c1 = Math.min(this.cols - 1, Math.floor((r.x + r.width) / this.cell + 1e-9) - 1)
    const r0 = Math.max(0, Math.ceil(r.y / this.cell - 1e-9))
    const r1 = Math.min(this.rows - 1, Math.floor((r.y + r.height) / this.cell + 1e-9) - 1)
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) this.blocked[y * this.cols + x] = 0
  }

  private label(): void {
    const { cols, rows, blocked, comp } = this
    const stack: number[] = []
    let id = 0
    for (let s = 0; s < cols * rows; s++) {
      if (blocked[s] || comp[s] >= 0) continue
      comp[s] = id
      stack.push(s)
      while (stack.length) {
        const i = stack.pop()!
        const x = i % cols
        const y = (i - x) / cols
        const visit = (j: number) => {
          if (!blocked[j] && comp[j] < 0) {
            comp[j] = id
            stack.push(j)
          }
        }
        if (x > 0) visit(i - 1)
        if (x < cols - 1) visit(i + 1)
        if (y > 0) visit(i - cols)
        if (y < rows - 1) visit(i + cols)
      }
      id++
    }
  }

  // ---- queries -----------------------------------------------------------------------------

  inGrid(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows
  }

  /** Out-of-grid counts as blocked. */
  isBlocked(cx: number, cy: number): boolean {
    return !this.inGrid(cx, cy) || this.blocked[cy * this.cols + cx] === 1
  }

  cellX(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)))
  }

  cellY(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)))
  }

  indexOf(p: Point): number {
    return this.cellY(p.y) * this.cols + this.cellX(p.x)
  }

  center(i: number): Point {
    const x = i % this.cols
    const y = (i - x) / this.cols
    return { x: (x + 0.5) * this.cell, y: (y + 0.5) * this.cell }
  }

  isFreeAt(p: Point): boolean {
    return this.blocked[this.indexOf(p)] === 0
  }

  /** Component id of the cell under p (-1 if blocked). */
  componentAt(p: Point): number {
    return this.comp[this.indexOf(p)]
  }

  /**
   * Nearest free cell to p within `radius` rings (-1 if none). Within the first ring that has a
   * free cell, cells of `prefer` component win ties, so a point on a wall snaps to the caller's side.
   */
  snap(p: Point, radius: number, prefer = -1): number {
    const cx = this.cellX(p.x)
    const cy = this.cellY(p.y)
    const here = cy * this.cols + cx
    if (!this.blocked[here]) return here
    for (let r = 1; r <= radius; r++) {
      let best = -1
      let bestD = Infinity
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const x = cx + dx
          const y = cy + dy
          if (!this.inGrid(x, y)) continue
          const i = y * this.cols + x
          if (this.blocked[i]) continue
          const c = this.center(i)
          // Other components rank after every cell of the preferred one.
          const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2 + (prefer >= 0 && this.comp[i] !== prefer ? 1e12 : 0)
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  /**
   * True if the straight segment a->b only passes through free cells. Supercover traversal:
   * when the segment passes exactly through a cell corner both side cells must be free.
   */
  lineOfSight(a: Point, b: Point): boolean {
    const cs = this.cell
    let cx = Math.floor(a.x / cs)
    let cy = Math.floor(a.y / cs)
    const ex = Math.floor(b.x / cs)
    const ey = Math.floor(b.y / cs)
    if (this.isBlocked(cx, cy)) return false
    const dx = b.x - a.x
    const dy = b.y - a.y
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0
    const tdx = sx !== 0 ? cs / Math.abs(dx) : Infinity
    const tdy = sy !== 0 ? cs / Math.abs(dy) : Infinity
    let tmx = sx > 0 ? ((cx + 1) * cs - a.x) / dx : sx < 0 ? (cx * cs - a.x) / dx : Infinity
    let tmy = sy > 0 ? ((cy + 1) * cs - a.y) / dy : sy < 0 ? (cy * cs - a.y) / dy : Infinity
    let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 4
    while ((cx !== ex || cy !== ey) && guard-- > 0) {
      const diff = tmx - tmy
      if (Math.abs(diff) < 1e-9) {
        if (tmx > 1) break
        if (this.isBlocked(cx + sx, cy) || this.isBlocked(cx, cy + sy)) return false
        cx += sx
        cy += sy
        tmx += tdx
        tmy += tdy
      } else if (diff < 0) {
        if (tmx > 1) break
        cx += sx
        tmx += tdx
      } else {
        if (tmy > 1) break
        cy += sy
        tmy += tdy
      }
      if (this.isBlocked(cx, cy)) return false
    }
    return true
  }

  /**
   * Waypoints from `from` to `to` (excluding `from`), or null when there is no path.
   * Start and goal are snapped to the nearest free cell; if the goal's cell is not connected to
   * the start's (a sealed room), there is no path. [] = already there.
   */
  findPath(from: Point, to: Point): Point[] | null {
    const start = this.snap(from, START_SNAP_CELLS)
    if (start < 0) return null
    const component = this.comp[start]
    const goal = this.snap(to, GOAL_SNAP_CELLS, component)
    // Different component = behind walls (e.g. the sealed boss office): no path, never snap across.
    if (goal < 0 || this.comp[goal] !== component) return null
    const goalExact = this.indexOf(to) === goal
    const end = goalExact ? { x: to.x, y: to.y } : this.center(goal)

    const cells = start === goal ? [start] : this.astar(start, goal)
    if (!cells) return null

    const pts: Point[] = [from]
    for (const i of cells) pts.push(this.center(i))
    pts.push(end)
    const out = this.smooth(pts)
    out.shift()
    // Drop no-op moves.
    return out.filter((p, i) => {
      const prev = i === 0 ? from : out[i - 1]
      return Math.abs(p.x - prev.x) >= 0.5 || Math.abs(p.y - prev.y) >= 0.5
    })
  }

  /** Greedy forward string pulling: from each anchor, jump to the furthest point still in sight. */
  private smooth(pts: Point[]): Point[] {
    const out: Point[] = [pts[0]]
    let a = 0
    const last = pts.length - 1
    while (a < last) {
      let j = a + 1
      while (j < last && this.lineOfSight(pts[a], pts[j + 1])) j++
      out.push(pts[j])
      a = j
    }
    return out
  }

  /** 8-neighbour A*, no corner cutting. Returns cell indices start..goal. */
  private astar(start: number, goal: number): number[] | null {
    const { cols, rows, blocked } = this
    const n = cols * rows
    const g = new Float64Array(n).fill(Infinity)
    const parent = new Int32Array(n).fill(-1)
    const closed = new Uint8Array(n)
    const gx = goal % cols
    const gy = (goal - gx) / cols
    const h = (i: number) => {
      const x = i % cols
      const y = (i - x) / cols
      const dx = Math.abs(x - gx)
      const dy = Math.abs(y - gy)
      return dx + dy + (SQRT2 - 2) * Math.min(dx, dy)
    }
    const heap = new MinHeap()
    g[start] = 0
    heap.push(start, h(start))
    while (heap.size > 0) {
      const i = heap.pop()
      if (closed[i]) continue
      if (i === goal) break
      closed[i] = 1
      const x = i % cols
      const y = (i - x) / cols
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const j = ny * cols + nx
          if (blocked[j] || closed[j]) continue
          let cost = 1
          if (dx !== 0 && dy !== 0) {
            // No corner cutting: both orthogonal neighbours must be free.
            if (blocked[y * cols + nx] || blocked[ny * cols + x]) continue
            cost = SQRT2
          }
          const ng = g[i] + cost
          if (ng < g[j]) {
            g[j] = ng
            parent[j] = i
            heap.push(j, ng + h(j))
          }
        }
      }
    }
    if (parent[goal] < 0 && goal !== start) return null
    const path: number[] = []
    for (let i = goal; i >= 0; i = parent[i]) {
      path.push(i)
      if (i === start) break
    }
    return path.reverse()
  }
}
