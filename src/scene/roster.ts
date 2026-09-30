// Pure roster logic: who is who, which team, which branch, which seat. No Phaser, no DOM.
//
// Each manager (top-level agent) owns one branch of the world (WorldLayout). Workers sit at the
// nearest free desk of their team's branch; nested subagents live in the root team's branch.
// The boss sits at the HQ boss_seat. Waiting characters queue at the HQ inbox slots.
import type { Role } from '../../shared/theme'
import type { Block, WorldLayout } from '../world/layout'

export interface Point {
  x: number
  y: number
}

export interface LocationPoint extends Point {
  name: string
}

/** Location type -> points of that type, as parsed from the map. */
export type Locations = Map<string, LocationPoint[]>

export const BOSS_ID = '__boss__'

export interface RosterEntry {
  id: string
  role: Role
  /** Team = the top-level manager's id (the boss is its own team). */
  teamId: string
  /** Direct "manager": boss for managers, the parent for workers, null for the boss. */
  managerId: string | null
  provider: string
  displayName: string
  /** Where the character belongs (seat / desk / overflow spot), world coordinates. */
  home: LocationPoint
  /** True when created from a child's parentId before the parent's own events arrived. */
  implicit: boolean
}

export interface SpawnInput {
  agentId: string
  parentId: string | null
  provider: string
  displayName: string
}

export function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/** Nearest point of a location type to `from`, or null if there is none. */
export function nearest(locations: Locations, type: string, from: Point): LocationPoint | null {
  const pts = locations.get(type)
  if (!pts || pts.length === 0) return null
  let best = pts[0]
  let bestD = dist2(best, from)
  for (const p of pts) {
    const d = dist2(p, from)
    if (d < bestD) {
      best = p
      bestD = d
    }
  }
  return best
}

export function shortId(id: string): string {
  return id.replace(/^agent-/, '').slice(0, 6)
}

/** Fixed pool of named points; each slot holds at most one owner. */
class SlotPool {
  private owner = new Map<number, string>()
  constructor(readonly points: LocationPoint[]) {}

  claimFirst(id: string): number {
    for (let i = 0; i < this.points.length; i++) if (!this.owner.has(i)) return this.set(i, id)
    return -1
  }

  claimNearest(id: string, to: Point): number {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < this.points.length; i++) {
      if (this.owner.has(i)) continue
      const d = dist2(this.points[i], to)
      if (d < bestD) {
        best = i
        bestD = d
      }
    }
    return best < 0 ? -1 : this.set(best, id)
  }

  release(id: string): void {
    for (const [i, o] of this.owner) if (o === id) this.owner.delete(i)
  }

  indexOf(id: string): number {
    for (const [i, o] of this.owner) if (o === id) return i
    return -1
  }

  private set(i: number, id: string): number {
    this.owner.set(i, id)
    return i
  }
}

/** Overflow spots in a grid near an anchor, reused lowest-index first. */
class OverflowRow {
  private used = new Map<string, number>()
  constructor(
    private anchor: Point,
    /** Unit vector pointing away from the anchor (rows grow along it). */
    private dir: Point,
    private spacing: number,
    private perRow: number,
    private start: number,
    private label: string
  ) {}

  claim(id: string): LocationPoint {
    const held = this.used.get(id)
    if (held !== undefined) return this.at(held)
    const taken = new Set(this.used.values())
    let i = 0
    while (taken.has(i)) i++
    this.used.set(id, i)
    return this.at(i)
  }

  release(id: string): void {
    this.used.delete(id)
  }

  private at(i: number): LocationPoint {
    const row = Math.floor(i / this.perRow)
    const col = i % this.perRow
    // Alternate sides of the axis: 0, -1, +1, -2, +2 ...
    const k = col === 0 ? 0 : (col % 2 === 1 ? -1 : 1) * Math.ceil(col / 2)
    const depth = this.start + row * this.spacing
    const side = { x: -this.dir.y, y: this.dir.x }
    return {
      name: `${this.label}_${i}`,
      x: Math.round(this.anchor.x + this.dir.x * depth + side.x * k * this.spacing),
      y: Math.round(this.anchor.y + this.dir.y * depth + side.y * k * this.spacing)
    }
  }
}

/** Per-team seating in one block. */
interface Site {
  block: Block
  seat: LocationPoint
  desks: SlotPool
  overflow: OverflowRow
}

/** Outward normal of a door point on the block edge (defaults to "down"). */
export function doorNormal(block: Block, door: Point): Point {
  const lx = door.x - block.offset.x
  const ly = door.y - block.offset.y
  const d = [
    { n: { x: 0, y: -1 }, dist: Math.abs(ly) },
    { n: { x: 0, y: 1 }, dist: Math.abs(ly - block.height) },
    { n: { x: -1, y: 0 }, dist: Math.abs(lx) },
    { n: { x: 1, y: 0 }, dist: Math.abs(lx - block.width) }
  ]
  d.sort((a, b) => a.dist - b.dist)
  return d[0].n
}

export class Roster {
  private entries = new Map<string, RosterEntry>()
  private sites = new Map<string, Site>()
  private inboxes: SlotPool
  private inboxQueue: OverflowRow
  /** Where the inbox queue starts: the HQ door nearest to the inbox slots. */
  readonly hqDoor: LocationPoint

  constructor(
    readonly layout: WorldLayout,
    boss: { provider: string; displayName: string },
    /** Location type used for waiting slots (theme's `waiting` activity location). */
    inboxType = 'inbox'
  ) {
    const hq = layout.hq
    const locs = hq.locations
    const bossSeat = locs.get('boss_seat')?.[0] ?? { name: 'boss_seat', x: hq.offset.x, y: hq.offset.y }
    const inboxPts = locs.get(inboxType) ?? locs.get('inbox') ?? []
    this.inboxes = new SlotPool(inboxPts)
    const centroid = inboxPts.length
      ? {
          x: inboxPts.reduce((s, p) => s + p.x, 0) / inboxPts.length,
          y: inboxPts.reduce((s, p) => s + p.y, 0) / inboxPts.length
        }
      : bossSeat
    this.hqDoor = nearest(locs, 'door', centroid) ?? { name: 'door', x: hq.offset.x, y: hq.offset.y + hq.height }
    this.inboxQueue = new OverflowRow(this.hqDoor, doorNormal(hq, this.hqDoor), 20, 3, 24, 'inbox_queue')

    this.sites.set(BOSS_ID, this.makeSite(hq, bossSeat))
    this.entries.set(BOSS_ID, {
      id: BOSS_ID,
      role: 'boss',
      teamId: BOSS_ID,
      managerId: null,
      provider: boss.provider,
      displayName: boss.displayName,
      home: bossSeat,
      implicit: false
    })
  }

  get(id: string): RosterEntry | undefined {
    return this.entries.get(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  all(): RosterEntry[] {
    return [...this.entries.values()]
  }

  managers(): RosterEntry[] {
    return this.all().filter((e) => e.role === 'manager')
  }

  /** Everyone on a team except the manager itself. */
  teamWorkers(teamId: string): RosterEntry[] {
    return this.all().filter((e) => e.teamId === teamId && e.role === 'worker')
  }

  /** The block (HQ or branch) an agent lives in. */
  blockOf(id: string): Block {
    const e = this.entries.get(id)
    return (e && this.sites.get(e.teamId)?.block) ?? this.layout.hq
  }

  /** Home of this entry's manager; a manager/boss gets its own; falls back to own home. */
  managerHome(id: string): LocationPoint | null {
    const e = this.entries.get(id)
    if (!e) return null
    if (e.role !== 'worker') return e.home
    const m = e.managerId ? this.entries.get(e.managerId) : undefined
    return m ? m.home : e.home
  }

  /**
   * Nearest point of a station type for this agent: its own branch first, then the HQ.
   * null if neither has it (caller goes home).
   */
  station(id: string, type: string, from: Point): LocationPoint | null {
    const block = this.blockOf(id)
    return nearest(block.locations, type, from) ?? nearest(this.layout.hq.locations, type, from)
  }

  /** Where the agent arrives / leaves: nearest entrance of its branch (HQ door for the HQ). */
  entranceOf(id: string, from?: Point): LocationPoint {
    const block = this.blockOf(id)
    const at = from ?? this.entries.get(id)?.home ?? block.offset
    return (
      nearest(block.locations, 'entrance', at) ??
      nearest(block.locations, 'door', at) ?? { name: 'entrance', x: block.offset.x, y: block.offset.y }
    )
  }

  /**
   * Makes sure an agent (and, if needed, an implicit parent) exists.
   * Returns the entries created by this call, parents first, and any branches allocated.
   * Existing entries are returned in `upgraded` when an implicit manager receives its own first event.
   */
  ensure(e: SpawnInput): { created: RosterEntry[]; upgraded: RosterEntry | null; branches: Block[] } {
    const created: RosterEntry[] = []
    const branches: Block[] = []
    const existing = this.entries.get(e.agentId)
    if (existing) {
      if (existing.implicit) {
        existing.implicit = false
        existing.displayName = e.displayName
        existing.provider = e.provider
        return { created, upgraded: existing, branches }
      }
      return { created, upgraded: null, branches }
    }

    if (e.parentId === null) {
      const m = this.addManager(e.agentId, e.provider, e.displayName, false)
      created.push(m)
      branches.push(this.sites.get(m.id)!.block)
      return { created, upgraded: null, branches }
    }

    let parent = this.entries.get(e.parentId)
    if (!parent) {
      parent = this.addManager(e.parentId, e.provider, `Session ${shortId(e.parentId)}`, true)
      created.push(parent)
      branches.push(this.sites.get(parent.id)!.block)
    }
    created.push(this.addWorker(e.agentId, parent, e.provider, e.displayName))
    return { created, upgraded: null, branches }
  }

  /**
   * Removes an agent and frees its seat/desk/inbox slot. The boss can't be removed.
   * When the last member of a team leaves, its branch is released (`releasedBranch`).
   */
  remove(id: string): { entry: RosterEntry; releasedBranch: Block | null } | undefined {
    if (id === BOSS_ID) return undefined
    const e = this.entries.get(id)
    if (!e) return undefined
    this.entries.delete(id)
    this.releaseInbox(id)
    const site = this.sites.get(e.teamId)
    site?.desks.release(id)
    site?.overflow.release(id)
    let releasedBranch: Block | null = null
    if (site && e.teamId !== BOSS_ID && !this.all().some((x) => x.teamId === e.teamId)) {
      this.sites.delete(e.teamId)
      this.layout.removeBranch(e.teamId)
      releasedBranch = site.block
    }
    return { entry: e, releasedBranch }
  }

  /** Claims an HQ inbox slot, or a spot in the queue outside the HQ door when all are taken. */
  claimInbox(id: string): { point: LocationPoint; queued: boolean } {
    const held = this.inboxes.indexOf(id)
    if (held >= 0) return { point: this.inboxes.points[held], queued: false }
    const i = this.inboxes.claimFirst(id)
    if (i >= 0) {
      this.inboxQueue.release(id)
      return { point: this.inboxes.points[i], queued: false }
    }
    return { point: this.inboxQueue.claim(id), queued: true }
  }

  releaseInbox(id: string): void {
    this.inboxes.release(id)
    this.inboxQueue.release(id)
  }

  private makeSite(block: Block, seat: LocationPoint): Site {
    const entrance = nearest(block.locations, 'entrance', seat) ?? nearest(block.locations, 'door', seat) ?? seat
    // Overflow workers stand in rows just inside the entrance.
    const inward = block.kind === 'branch' ? { x: -doorNormal(block, entrance).x, y: -doorNormal(block, entrance).y } : { x: 0, y: -1 }
    return {
      block,
      seat,
      desks: new SlotPool(block.locations.get('desk') ?? []),
      overflow: new OverflowRow(entrance, inward, 22, 5, 26, `overflow_${block.id}`)
    }
  }

  private addManager(id: string, provider: string, displayName: string, implicit: boolean): RosterEntry {
    const block = this.layout.addBranch(id)
    const seat =
      block.locations.get('manager_seat')?.[0] ??
      nearest(block.locations, 'entrance', block.offset) ?? { name: 'manager_seat', x: block.offset.x, y: block.offset.y }
    this.sites.set(id, this.makeSite(block, seat))
    const entry: RosterEntry = {
      id,
      role: 'manager',
      teamId: id,
      managerId: BOSS_ID,
      provider,
      displayName,
      home: seat,
      implicit
    }
    this.entries.set(id, entry)
    return entry
  }

  private addWorker(id: string, parent: RosterEntry, provider: string, displayName: string): RosterEntry {
    const teamId = parent.role === 'boss' ? parent.id : parent.teamId
    const site = this.sites.get(teamId)!
    const i = site.desks.claimNearest(id, parent.home)
    const home = i >= 0 ? site.desks.points[i] : site.overflow.claim(id)
    const entry: RosterEntry = {
      id,
      role: 'worker',
      teamId,
      managerId: parent.id,
      provider,
      displayName,
      home,
      implicit: false
    }
    this.entries.set(id, entry)
    return entry
  }
}

/**
 * Tracks how many characters share a station so they can stand side by side.
 * Keyed by location point; each character holds at most one claim.
 */
export class Stations {
  private byKey = new Map<string, Map<number, string>>()
  private held = new Map<string, string>()

  static key(p: Point): string {
    return `${Math.round(p.x)},${Math.round(p.y)}`
  }

  /** Claims a spot at `base` and returns the offset position. */
  claim(id: string, base: Point): Point {
    const key = Stations.key(base)
    const prev = this.held.get(id)
    if (prev === key) return offsetFor(base, this.indexOf(key, id))
    this.release(id)
    let slots = this.byKey.get(key)
    if (!slots) this.byKey.set(key, (slots = new Map()))
    let i = 0
    while (slots.has(i)) i++
    slots.set(i, id)
    this.held.set(id, key)
    return offsetFor(base, i)
  }

  release(id: string): void {
    const key = this.held.get(id)
    if (key === undefined) return
    this.held.delete(id)
    const slots = this.byKey.get(key)
    if (!slots) return
    for (const [i, o] of slots) if (o === id) slots.delete(i)
    if (slots.size === 0) this.byKey.delete(key)
  }

  private indexOf(key: string, id: string): number {
    for (const [i, o] of this.byKey.get(key) ?? []) if (o === id) return i
    return 0
  }
}

const SPREAD = 12

/** 0 -> on the spot, then alternate right/left, next row after 5. */
export function offsetFor(base: Point, i: number): Point {
  const col = i % 5
  const row = Math.floor(i / 5)
  const k = col === 0 ? 0 : (col % 2 === 1 ? 1 : -1) * Math.ceil(col / 2)
  return { x: base.x + k * SPREAD, y: base.y + row * SPREAD }
}
