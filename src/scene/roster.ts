// Pure roster logic: who is who, which team, which seat. No Phaser, no DOM.
import type { Role } from '../../shared/theme'

export interface Point {
  x: number
  y: number
}

export interface LocationPoint extends Point {
  name: string
}

/** Location type -> points of that type, as parsed from the map. */
export type Locations = Map<string, LocationPoint[]>

/** Location types the scene is allowed to know about by name. */
export const REQUIRED_TYPES = ['boss_seat', 'manager_seat', 'desk', 'inbox', 'entrance'] as const

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
  /** Where the character belongs (seat / desk / overflow spot). */
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

/** Nearest point of a location type to `from`, or null if the map has none. */
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

/** Overflow spots: a row near an anchor point, reused lowest-index first. */
class OverflowRow {
  private used = new Map<string, number>()
  constructor(
    private anchor: Point,
    private dx: number,
    private dy: number,
    private label: string
  ) {}

  claim(id: string): LocationPoint {
    const taken = new Set(this.used.values())
    let i = 0
    while (taken.has(i)) i++
    this.used.set(id, i)
    // Alternate sides of the anchor: 0, -1, +1, -2, +2 ...
    const k = i === 0 ? 0 : (i % 2 === 1 ? -1 : 1) * Math.ceil(i / 2)
    return { name: `${this.label}_${i}`, x: this.anchor.x + k * this.dx, y: this.anchor.y + this.dy }
  }

  release(id: string): void {
    this.used.delete(id)
  }
}

export class Roster {
  private entries = new Map<string, RosterEntry>()
  private managerSeats: SlotPool
  private desks: SlotPool
  private inboxes: SlotPool
  private managerOverflow: OverflowRow
  private workerOverflow: OverflowRow

  constructor(
    private locations: Locations,
    boss: { provider: string; displayName: string },
    /** Location type used for waiting slots (theme's `waiting` activity location). */
    inboxType = 'inbox'
  ) {
    const bossSeat = locations.get('boss_seat')?.[0] ?? { name: 'boss_seat', x: 0, y: 0 }
    this.managerSeats = new SlotPool(locations.get('manager_seat') ?? [])
    this.desks = new SlotPool(locations.get('desk') ?? [])
    this.inboxes = new SlotPool(locations.get(inboxType) ?? locations.get('inbox') ?? [])
    const entrance = locations.get('entrance')?.[0] ?? { x: 0, y: 0 }
    this.managerOverflow = new OverflowRow(entrance, 22, -26, 'overflow_manager')
    this.workerOverflow = new OverflowRow(entrance, 22, -50, 'overflow_worker')
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

  /** Home of this entry's manager; a manager/boss gets its own; falls back to own home. */
  managerHome(id: string): LocationPoint | null {
    const e = this.entries.get(id)
    if (!e) return null
    if (e.role !== 'worker') return e.home
    const m = e.managerId ? this.entries.get(e.managerId) : undefined
    return m ? m.home : e.home
  }

  /**
   * Makes sure an agent (and, if needed, an implicit parent) exists.
   * Returns the entries created by this call, parents first. Existing entries are
   * returned in `upgraded` when an implicit manager receives its own first event.
   */
  ensure(e: SpawnInput): { created: RosterEntry[]; upgraded: RosterEntry | null } {
    const created: RosterEntry[] = []
    const existing = this.entries.get(e.agentId)
    if (existing) {
      if (existing.implicit) {
        existing.implicit = false
        existing.displayName = e.displayName
        existing.provider = e.provider
        return { created, upgraded: existing }
      }
      return { created, upgraded: null }
    }

    if (e.parentId === null) {
      created.push(this.addManager(e.agentId, e.provider, e.displayName, false))
      return { created, upgraded: null }
    }

    let parent = this.entries.get(e.parentId)
    if (!parent) {
      parent = this.addManager(e.parentId, e.provider, `Session ${shortId(e.parentId)}`, true)
      created.push(parent)
    }
    created.push(this.addWorker(e.agentId, parent, e.provider, e.displayName))
    return { created, upgraded: null }
  }

  /** Removes an agent and frees its seat/desk/inbox slot. The boss can't be removed. */
  remove(id: string): RosterEntry | undefined {
    if (id === BOSS_ID) return undefined
    const e = this.entries.get(id)
    if (!e) return undefined
    this.entries.delete(id)
    this.managerSeats.release(id)
    this.desks.release(id)
    this.inboxes.release(id)
    this.managerOverflow.release(id)
    this.workerOverflow.release(id)
    return e
  }

  /** Claims a free waiting slot (e.g. an inbox tray). Returns null when all are taken. */
  claimInbox(id: string): LocationPoint | null {
    const held = this.inboxes.indexOf(id)
    if (held >= 0) return this.inboxes.points[held]
    const i = this.inboxes.claimFirst(id)
    if (i >= 0) return this.inboxes.points[i]
    return null
  }

  releaseInbox(id: string): void {
    this.inboxes.release(id)
  }

  private addManager(id: string, provider: string, displayName: string, implicit: boolean): RosterEntry {
    const i = this.managerSeats.claimFirst(id)
    const home = i >= 0 ? this.managerSeats.points[i] : this.managerOverflow.claim(id)
    const entry: RosterEntry = {
      id,
      role: 'manager',
      teamId: id,
      managerId: BOSS_ID,
      provider,
      displayName,
      home,
      implicit
    }
    this.entries.set(id, entry)
    return entry
  }

  private addWorker(id: string, parent: RosterEntry, provider: string, displayName: string): RosterEntry {
    const i = this.desks.claimNearest(id, parent.home)
    const home = i >= 0 ? this.desks.points[i] : this.workerOverflow.claim(id)
    const entry: RosterEntry = {
      id,
      role: 'worker',
      teamId: parent.role === 'boss' ? parent.id : parent.teamId,
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
