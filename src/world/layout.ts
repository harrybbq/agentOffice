// World composition: the HQ and one branch per team, stamped into fixed-size slots on a grid,
// separated by walkable corridors. Pure logic (no Phaser).
//
// Slot index -> grid cell is a fixed "shell" enumeration, so the arrangement stays roughly square
// as it grows and an allocated slot never moves:
//   0 1 4 9
//   2 3 5 10
//   6 7 8 11
//   12 ...
import type { FurnitureRect, ParsedMap, Rect, WallRect } from '../theme/parse'
import type { LocationPoint, Locations, Point } from '../scene/roster'

export const HQ_ID = '__hq__'

export type BlockKind = 'hq' | 'branch'

export interface Block {
  /** HQ_ID for the HQ, the team id (top-level agent id) for a branch. */
  id: string
  kind: BlockKind
  slot: number
  /** World position of the block's top-left corner. */
  offset: Point
  width: number
  height: number
  template: ParsedMap
  /** Location points in world coordinates. */
  locations: Locations
  furniture: FurnitureRect[]
  walls: WallRect[]
  /** Walls + solid furniture, world coordinates. */
  blocked: Rect[]
}

export interface LayoutOptions {
  /** Corridor width between slots, in tiles (min 2). */
  gutterTiles?: number
  /** Walkable margin around everything, in tiles. */
  marginTiles?: number
}

/** Grid cell of a slot index (shell order, see header). */
export function slotCell(index: number): { col: number; row: number } {
  const s = Math.floor(Math.sqrt(index))
  const j = index - s * s
  return j < s ? { col: s, row: j } : { col: j - s, row: s }
}

function shiftRect<T extends Rect>(r: T, o: Point): T {
  return { ...r, x: r.x + o.x, y: r.y + o.y }
}

function shiftLocations(locs: Locations, o: Point): Locations {
  const out: Locations = new Map()
  for (const [type, pts] of locs) {
    out.set(
      type,
      pts.map((p): LocationPoint => ({ name: p.name, x: p.x + o.x, y: p.y + o.y }))
    )
  }
  return out
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export class WorldLayout {
  readonly tile: number
  /** Slot size in px (max of both templates, whole tiles). */
  readonly slotW: number
  readonly slotH: number
  readonly gutter: number
  readonly margin: number
  /** Bumped on every add/remove so consumers can rebuild derived data. */
  version = 0

  private blocks = new Map<string, Block>()
  private slotOwner = new Map<number, string>()

  constructor(
    private hqMap: ParsedMap,
    private branchMap: ParsedMap,
    opts: LayoutOptions = {}
  ) {
    this.tile = branchMap.tileWidth || 32
    const tiles = (px: number) => Math.ceil(px / this.tile)
    this.slotW = Math.max(tiles(hqMap.widthPx), tiles(branchMap.widthPx)) * this.tile
    this.slotH = Math.max(tiles(hqMap.heightPx), tiles(branchMap.heightPx)) * this.tile
    this.gutter = Math.max(2, opts.gutterTiles ?? 3) * this.tile
    this.margin = Math.max(1, opts.marginTiles ?? 2) * this.tile
    this.place(HQ_ID, 'hq', 0, hqMap)
  }

  get hq(): Block {
    return this.blocks.get(HQ_ID)!
  }

  branch(teamId: string): Block | undefined {
    const b = this.blocks.get(teamId)
    return b && b.kind === 'branch' ? b : undefined
  }

  all(): Block[] {
    return [...this.blocks.values()]
  }

  branches(): Block[] {
    return this.all().filter((b) => b.kind === 'branch')
  }

  /** Allocates the lowest free slot (>= 1) for a team. Idempotent. */
  addBranch(teamId: string): Block {
    const existing = this.branch(teamId)
    if (existing) return existing
    if (teamId === HQ_ID) throw new Error('reserved block id')
    let slot = 1
    while (this.slotOwner.has(slot)) slot++
    return this.place(teamId, 'branch', slot, this.branchMap)
  }

  /** Frees a team's slot. Returns false if it had none. */
  removeBranch(teamId: string): boolean {
    const b = this.branch(teamId)
    if (!b) return false
    this.blocks.delete(teamId)
    this.slotOwner.delete(b.slot)
    this.version++
    return true
  }

  /** World rect of a slot. */
  slotRect(slot: number): Rect {
    const { col, row } = slotCell(slot)
    return {
      x: this.margin + col * (this.slotW + this.gutter),
      y: this.margin + row * (this.slotH + this.gutter),
      width: this.slotW,
      height: this.slotH
    }
  }

  /** Rect covering every occupied slot plus the margin; the walkable world. Starts at (0, 0). */
  bounds(): Rect {
    const u = unionRects([...this.slotOwner.keys()].map((s) => this.slotRect(s)))!
    return { x: 0, y: 0, width: u.x + u.width + this.margin, height: u.y + u.height + this.margin }
  }

  /** Tight rect around occupied blocks (for the camera). */
  occupiedBounds(): Rect {
    return unionRects(this.all().map((b) => ({ x: b.offset.x, y: b.offset.y, width: b.width, height: b.height })))!
  }

  blocked(): Rect[] {
    return this.all().flatMap((b) => b.blocked)
  }

  private place(id: string, kind: BlockKind, slot: number, map: ParsedMap): Block {
    const s = this.slotRect(slot)
    const tiles = (px: number) => Math.round(px / this.tile)
    // Centre the block in its slot, snapped to whole tiles; spare slot space is open floor
    // that joins the corridors, so every edge door opens onto a corridor.
    const offset = {
      x: s.x + Math.floor((tiles(this.slotW) - tiles(map.widthPx)) / 2) * this.tile,
      y: s.y + Math.floor((tiles(this.slotH) - tiles(map.heightPx)) / 2) * this.tile
    }
    const walls = map.walls.map((w) => shiftRect(w, offset))
    const furniture = map.furniture.map((f) => shiftRect(f, offset))
    const blocked: Rect[] = [
      ...walls.map(({ x, y, width, height }) => ({ x, y, width, height })),
      ...furniture.filter((f) => f.solid).map(({ x, y, width, height }) => ({ x, y, width, height }))
    ]
    const block: Block = {
      id,
      kind,
      slot,
      offset,
      width: map.widthPx,
      height: map.heightPx,
      template: map,
      locations: shiftLocations(map.locations, offset),
      furniture,
      walls,
      blocked
    }
    this.blocks.set(id, block)
    this.slotOwner.set(slot, id)
    this.version++
    return block
  }
}
