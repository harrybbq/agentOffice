// The generic, theme-driven scene (named for the default theme). Knows only the required
// location types, HOME/MANAGER and the lifecycle conventions from shared/events.ts.
//
// The world is an HQ plus one branch per team (WorldLayout), all visible at once, joined by built
// corridors (CorridorNetwork); characters walk between them along A* paths (NavGrid). Only block
// interiors and built corridors are walkable.
//
// A new team's branch is constructed before anyone moves in: the source door pulses, the corridor
// is laid from it cell by cell, then the branch floor wipes in, walls draw, furniture pops in and
// the sign drops. Its manager and workers wait (spawns and events are buffered) until it's ready.
// When a team has left, its branch is demolished and the corridor parts nobody else uses retract.
// Builds and demolitions run one at a time from a queue, faster while more are waiting.
import Phaser from 'phaser'
import type { Activity, AgentEvent } from '../../shared/events'
import { activityDef, HOME, MANAGER } from '../../shared/theme'
import type { ActivityDef, Role, ThemeManifest } from '../../shared/theme'
import type { LoadedTheme } from '../../shared/ipc'
import { cssToInt, preloadTemplates } from '../theme/loader'
import type { ParsedMap, Rect } from '../theme/loader'
import { unionRects, WorldLayout } from '../world/layout'
import type { Block } from '../world/layout'
import { NavGrid } from '../world/pathfinding'
import { blockRect, buildNav, CorridorNetwork } from '../world/corridors'
import type { Cell, Corridor } from '../world/corridors'
import { BOSS_ID, nearest, Roster, Stations } from './roster'
import type { Point, RosterEntry } from './roster'
import { BlockView } from './blockView'
import type { BuildTimes } from './blockView'
import { CorridorView } from './corridorView'
import { Character } from './Character'
import type { Action } from './Character'
import {
  createSheetAnims,
  ensureProps,
  placeholderSkin,
  preloadSheets,
  providerSheetKey,
  roleSheetKey,
  sheetSkin,
  toneIndex
} from './charTextures'
import type { Skin } from './charTextures'

// ---- construction timings (ms at normal speed; a new team takes about 2.6-3.3 s) -----------------
/** Highlight pulse on the source door. */
const PULSE_MS = 400
/** Corridor laying: per new cell (16 px), clamped to [min, max] for the whole corridor. */
const CORRIDOR_CELL_MS = 28
const CORRIDOR_MIN_MS = 500
const CORRIDOR_MAX_MS = 1200
/** Cells that already exist (shared with another corridor) are crossed at this fraction of the cost. */
const SHARED_CELL_WEIGHT = 0.2
/** Floor wipe, walls, furniture pop-in, sign drop (they overlap a little). */
const BUILD_TIMES: BuildTimes = { floorMs: 500, wallsMs: 550, furnitureMs: 600, signMs: 380 }
const DEMOLISH_TIMES: BuildTimes = { floorMs: 350, wallsMs: 400, furnitureMs: 450, signMs: 250 }
const RETRACT_CELL_MS = 22
const RETRACT_MAX_MS = 1000
/** Speed-up while more jobs are queued (bursts, simulate --teams N). */
const QUEUE_SPEEDUP = 2.5
/** Speed-up for the snapshot replayed after a reload (about 1 s per branch). */
const SNAPSHOT_SPEEDUP = 3.2
/** Events this soon after the scene starts count as the snapshot too. */
const SNAPSHOT_WINDOW_MS = 1500
/** A demolition waits (at most this long) until nobody stands in the area being removed. */
const CLEAR_TIMEOUT_MS = 6000
/** Buffered events per team while its branch is being built (waiting/done are always kept). */
const MAX_PENDING_EVENTS = 40

export interface TeamInfo {
  id: string
  name: string
  provider: string
  color: string
  workers: number
}

export interface SceneOptions {
  theme: LoadedTheme
  hq: ParsedMap
  branch: ParsedMap
  overlay: boolean
  onReady: () => void
  onTeams: (teams: TeamInfo[]) => void
}

const DRIFT_HOME_MS = 4000
/** Late events for an agent that already left are ignored for this long. */
const DEPARTED_GRACE_MS = 30_000

const MIN_ZOOM = 0.5
const MAX_FIT_ZOOM = 2
const MAX_ZOOM = 4
const FIT_PAD = 40
const CAMERA_MS = 700
const DOUBLE_CLICK_MS = 320
const BLOCK_DEPTH = -1000
const SIGN_DEPTH = -900
const CORRIDOR_DEPTH = -2000
const GROUND_DEPTH = -2100
/** Outside ground: the background mixed with a little of this green. */
const GROUND_TINT = 0x4a6741

type BuildJob = { kind: 'build'; view: BlockView; corridor: Corridor | null; fast: boolean }
type CorridorJob = { kind: 'corridor'; corridor: Corridor }
type DemolishJob = { kind: 'demolish'; view: BlockView; retract: Cell[] }
type Job = BuildJob | CorridorJob | DemolishJob

function darken(c: number, f: number): number {
  const r = Math.round(((c >> 16) & 0xff) * f)
  const g = Math.round(((c >> 8) & 0xff) * f)
  const b = Math.round((c & 0xff) * f)
  return (r << 16) | (g << 8) | b
}

function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * (1 - t) + ((b >> s) & 0xff) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function scaleTimes(t: BuildTimes, speed: number): BuildTimes {
  return {
    floorMs: t.floorMs / speed,
    wallsMs: t.wallsMs / speed,
    furnitureMs: t.furnitureMs / speed,
    signMs: t.signMs / speed
  }
}

export class OfficeScene extends Phaser.Scene {
  private opts: SceneOptions
  private manifest: ThemeManifest
  private layout!: WorldLayout
  private nav!: NavGrid
  private roster!: Roster
  private stations = new Stations()
  private chars = new Map<string, Character>()
  private waiting = new Set<string>()
  private leaving = new Set<string>()
  private departed = new Map<string, number>()
  private waitingType = 'inbox'
  private views = new Map<string, BlockView>()
  /** Removed branches still standing until their demolition job runs (still walkable). */
  private doomed = new Set<BlockView>()
  private network!: CorridorNetwork
  private corridors!: CorridorView
  private ground!: Phaser.GameObjects.Graphics
  /** Corridor cells characters may walk on (built ones). */
  private walkable = new Map<number, Cell>()
  private jobs: Job[] = []
  private jobRunning = false
  /** Spawns and events for teams whose branch isn't built yet. */
  private pending = new Map<string, { spawn: RosterEntry[]; events: AgentEvent[] }>()
  private replaying = false
  private fastUntil = 0
  private alive = true
  private autoFit = true
  private lastDown = 0
  private dragging = false
  private downAt: Point = { x: 0, y: 0 }
  /** Waiting characters queued outside the HQ door (FIFO), promoted as inbox slots free up. */
  private queuedAtDoor = new Set<string>()
  /** Last known manager per team, so a branch keeps its name while workers finish leaving. */
  private teamLeads = new Map<string, RosterEntry>()
  private promoteClock = 0

  constructor(opts: SceneOptions) {
    super({ key: 'office' })
    this.opts = opts
    this.manifest = opts.theme.manifest
  }

  preload(): void {
    this.load.on('loaderror', (file: Phaser.Loader.File) =>
      console.warn(`[agent-office] failed to load ${file.key} (${String(file.url)})`)
    )
    preloadTemplates(this, { hq: this.opts.hq, branch: this.opts.branch }, this.opts.theme.baseUrl)
    preloadSheets(this, this.manifest, this.opts.theme.baseUrl)
  }

  create(): void {
    const { hq, branch } = this.opts
    ensureProps(this)
    createSheetAnims(this, this.manifest)

    this.layout = new WorldLayout(hq, branch)
    const w = this.manifest.activities?.waiting ? activityDef(this.manifest, 'waiting').location : ''
    this.waitingType = hq.locations.get(w)?.length ? w : 'inbox'
    this.roster = new Roster(
      this.layout,
      { provider: 'human', displayName: this.manifest.roles.boss.label },
      this.waitingType
    )

    this.network = new CorridorNetwork(this.layout)
    this.ground = this.add.graphics().setDepth(GROUND_DEPTH)
    this.corridors = new CorridorView(this, this.network, this.corridorStyle(), CORRIDOR_DEPTH)
    this.addBlockView(this.layout.hq, true)
    // The HQ porch (where the inbox queue forms) exists from the start.
    for (const c of this.network.cells()) {
      this.corridors.add(c)
      this.walkable.set(this.network.key(c), c)
    }
    this.corridors.setBuiltBlocks(this.builtBlocks().map(blockRect))
    this.corridors.redraw()
    this.drawGround()
    this.rebuildNav()
    this.fastUntil = performance.now() + SNAPSHOT_WINDOW_MS

    const boss = this.roster.get(BOSS_ID)!
    const pos = this.stations.claim(BOSS_ID, boss.home)
    this.chars.set(BOSS_ID, this.makeCharacter(boss, pos))

    this.setupCameraInput()
    this.fitCamera(false)
    const onResize = () => {
      if (this.autoFit) this.fitCamera(false)
    }
    this.scale.on(Phaser.Scale.Events.RESIZE, onResize)

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.alive = false
      this.jobs = []
      this.scale.off(Phaser.Scale.Events.RESIZE, onResize)
      for (const c of this.chars.values()) c.destroy()
      this.chars.clear()
    })
    this.opts.onReady()
  }

  update(_time: number, delta: number): void {
    for (const c of this.chars.values()) c.tick(delta)
    this.promoteClock += delta
    if (this.promoteClock >= 500) {
      this.promoteClock = 0
      this.promoteQueue()
    }
  }

  /** Moves the longest-queued waiting characters into free HQ inbox slots. */
  private promoteQueue(): void {
    for (const id of this.queuedAtDoor) {
      const c = this.chars.get(id)
      if (!c || !this.waiting.has(id)) {
        this.queuedAtDoor.delete(id)
        continue
      }
      if (!c.canRelocate) continue
      const claim = this.roster.claimInbox(id)
      if (claim.queued) return // no free slot; keep FIFO order
      this.queuedAtDoor.delete(id)
      c.relocate(this.claimAt(id, c, claim.point, false))
    }
  }

  // ---- events ------------------------------------------------------------------------------

  /** The snapshot replayed after a (re)load: branches build quickly, one after another. */
  replay(events: AgentEvent[]): void {
    this.replaying = true
    try {
      for (const e of events) this.handleEvent(e)
    } finally {
      this.replaying = false
    }
  }

  handleEvent(e: AgentEvent): void {
    if (!this.roster) return
    const id = e.agentId
    if (this.leaving.has(id)) return
    if (this.recentlyDeparted(id)) return
    // A child of someone who is leaving would re-hire them; ignore it.
    if (e.parentId && (this.leaving.has(e.parentId) || this.recentlyDeparted(e.parentId))) return

    const { created, upgraded, branches } = this.roster.ensure(e)
    for (const b of branches) this.planBranch(b)
    for (const entry of created) {
      // Nobody moves into a branch before it's built.
      if (this.teamReady(entry.teamId)) this.spawn(entry)
      else this.pendingFor(entry.teamId).spawn.push(entry)
    }
    if (upgraded) {
      const c = this.chars.get(upgraded.id)
      c?.setName(upgraded.displayName)
      c?.setTint(this.tintFor(upgraded))
      this.updateSign(upgraded.teamId)
    }
    if (upgraded || branches.length > 0) this.emitTeams()

    const entry = this.roster.get(id)
    if (!entry) return
    if (!this.teamReady(entry.teamId)) {
      this.bufferEvent(entry.teamId, e)
      return
    }
    this.apply(e)
  }

  /** Pans/zooms to a team's branch (HUD legend click). Double-click the scene to auto-fit again. */
  focusTeam(teamId: string): void {
    const b = this.layout?.branch(teamId)
    if (!b) return
    this.autoFit = false
    this.frame(blockRect(b), true, MAX_FIT_ZOOM)
  }

  /** Acts on an event for an agent whose character exists. */
  private apply(e: AgentEvent): void {
    const id = e.agentId
    const entry = this.roster.get(id)
    const c = this.chars.get(id)
    if (!entry || !c || this.leaving.has(id)) return

    if (e.activity !== 'waiting' && this.waiting.delete(id)) {
      c.releaseStay()
      this.updateBadge()
    }

    switch (e.activity) {
      case 'waiting':
        this.onWaiting(entry, c, e.detail)
        break
      case 'done':
        if (entry.role === 'worker') this.workerDone(entry, c, e.detail)
        else this.managerDone(entry)
        break
      default:
        c.enqueue(this.activityAction(entry, c, e.activity, e.detail))
    }
  }

  private teamReady(teamId: string): boolean {
    return teamId === BOSS_ID || this.views.get(teamId)?.state === 'ready'
  }

  private pendingFor(teamId: string): { spawn: RosterEntry[]; events: AgentEvent[] } {
    let p = this.pending.get(teamId)
    if (!p) this.pending.set(teamId, (p = { spawn: [], events: [] }))
    return p
  }

  private bufferEvent(teamId: string, e: AgentEvent): void {
    const q = this.pendingFor(teamId).events
    q.push(e)
    if (q.length > MAX_PENDING_EVENTS) {
      const i = q.findIndex((x) => x.activity !== 'waiting' && x.activity !== 'done')
      if (i >= 0) q.splice(i, 1)
    }
  }

  /** The branch is built: its team walks in and catches up on what happened meanwhile. */
  private releasePending(teamId: string): void {
    const p = this.pending.get(teamId)
    if (!p) return
    this.pending.delete(teamId)
    for (const entry of p.spawn) {
      if (this.roster.get(entry.id) === entry && !this.chars.has(entry.id)) this.spawn(entry)
    }
    for (const e of p.events) this.apply(e)
  }

  private recentlyDeparted(id: string): boolean {
    const gone = this.departed.get(id)
    if (gone === undefined) return false
    if (Date.now() - gone < DEPARTED_GRACE_MS) return true
    this.departed.delete(id)
    return false
  }

  // ---- world -------------------------------------------------------------------------------

  /** Blocks characters may be in: built ones, plus removed ones not yet demolished. */
  private builtBlocks(): Block[] {
    const out: Block[] = []
    for (const v of this.views.values()) if (v.state === 'ready') out.push(v.block)
    for (const v of this.doomed) out.push(v.block)
    return out
  }

  /** Rebuilds the nav grid from built blocks and corridors; everyone walking re-plans. */
  private rebuildNav(): void {
    const rects = [...this.walkable.values()].map((c) => this.network.cellRect(c))
    this.nav = buildNav(this.layout.bounds(), this.builtBlocks(), rects)
    for (const c of this.chars.values()) c.repath()
  }

  private corridorStyle(): { floor: number; edge: number } {
    const t = this.opts.branch
    const floor = t.furniture.find((f) => f.name === 'floor' && !f.solid)?.color ?? 0xe9e4d8
    const edge = t.walls[0]?.color ?? 0x5c5470
    return { floor: darken(floor, 0.86), edge }
  }

  /** Outside ground (not in overlay mode) with faint outlines of the free lots. */
  private drawGround(): void {
    const g = this.ground
    g.clear()
    if (this.opts.overlay) return
    const taken = [...this.views.values(), ...this.doomed].map((v) => v.rect)
    const u = unionRects([this.layout.bounds(), ...taken])!
    const bounds = { x: 0, y: 0, width: u.x + u.width, height: u.y + u.height }
    const bg = cssToInt(this.manifest.background, 0x2b2d42)
    g.fillStyle(mix(darken(bg, 0.9), GROUND_TINT, 0.18), 1)
    g.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)
    g.lineStyle(1, 0xffffff, 0.05)
    for (const f of this.layout.footprintsIn(bounds)) {
      if (taken.some((r) => r.x === f.x && r.y === f.y)) continue
      g.strokeRect(f.x + 0.5, f.y + 0.5, f.width - 1, f.height - 1)
    }
  }

  private findPath(from: Point, to: Point): Point[] | null {
    return this.nav.findPath(from, to)
  }

  private addBlockView(block: Block, built: boolean): BlockView {
    const view = new BlockView(this, block, { depth: BLOCK_DEPTH, signDepth: SIGN_DEPTH, built })
    this.views.set(block.id, view)
    this.updateSign(block.id)
    return view
  }

  private updateSign(blockId: string): void {
    const view = this.views.get(blockId)
    if (!view) return
    if (view.block.kind === 'hq') {
      view.setSign('HQ', null)
      return
    }
    const live = this.roster?.get(blockId)
    if (live) this.teamLeads.set(blockId, { ...live })
    const m = live ?? this.teamLeads.get(blockId)
    view.setSign(m?.displayName ?? blockId, m ? this.tintFor(m) : null)
  }

  // ---- construction ------------------------------------------------------------------------

  private isFast(): boolean {
    return this.replaying || performance.now() < this.fastUntil
  }

  /** A team got a lot: plan its corridor now, build it when its turn in the queue comes. */
  private planBranch(block: Block): void {
    const view = this.addBlockView(block, false)
    const corridor = this.network.connect(block)
    if (!corridor) console.warn(`[agent-office] no corridor route to branch ${block.id}; it stays unconnected`)
    this.jobs.push({ kind: 'build', view, corridor, fast: this.isFast() })
    this.drawGround()
    this.pump()
  }

  /** The team has left: repair corridors (if any) are built first, then the branch is demolished. */
  private planDemolish(teamId: string): void {
    const view = this.views.get(teamId)
    this.pending.delete(teamId)
    if (!view) return
    this.views.delete(teamId)
    this.teamLeads.delete(teamId)
    this.doomed.add(view)
    const plan = this.network.remove(teamId)
    for (const corridor of plan.repairs) this.jobs.push({ kind: 'corridor', corridor })
    this.jobs.push({ kind: 'demolish', view, retract: plan.retract })
    this.pump()
  }

  private pump(): void {
    if (this.jobRunning || !this.alive) return
    const job = this.jobs.shift()
    if (!job) return
    this.jobRunning = true
    const run =
      job.kind === 'build'
        ? this.runBuild(job)
        : job.kind === 'corridor'
          ? this.runCorridor(job.corridor, this.speed(false))
          : this.runDemolish(job)
    run
      .catch((err) => console.error('[agent-office] construction failed', err))
      .finally(() => {
        this.jobRunning = false
        this.pump()
      })
  }

  private speed(fast: boolean): number {
    if (fast) return SNAPSHOT_SPEEDUP
    return this.jobs.length > 0 ? QUEUE_SPEEDUP : 1
  }

  private async runBuild(job: BuildJob): Promise<void> {
    const { view, corridor } = job
    if (view.state !== 'planned') return
    const sp = this.speed(job.fast)
    view.state = 'building'
    if (this.autoFit) this.fitCamera(true)
    if (corridor) await this.layCorridor(corridor, sp)
    if (!this.alive) return
    const door = corridor ? view.block.locations.get('door')?.find((d) => d.name === corridor.toDoor) : undefined
    await view.build(scaleTimes(BUILD_TIMES, sp), door ?? this.roster.entranceOf(view.block.id))
    if (!this.alive) return
    view.state = 'ready'
    if (corridor) this.markWalkable(corridor)
    this.corridors.setBuiltBlocks(this.builtBlocks().map(blockRect))
    this.corridors.redraw()
    this.rebuildNav()
    this.releasePending(view.block.id)
    this.emitTeams()
  }

  private async runCorridor(corridor: Corridor, sp: number): Promise<void> {
    await this.layCorridor(corridor, sp)
    if (!this.alive) return
    this.markWalkable(corridor)
    this.rebuildNav()
  }

  private markWalkable(corridor: Corridor): void {
    for (const c of corridor.path) this.walkable.set(this.network.key(c), c)
  }

  /** Pulse on the source door, then lay the corridor from it; existing cells are crossed quickly. */
  private async layCorridor(corridor: Corridor, sp: number): Promise<void> {
    const path = corridor.path
    if (path.length === 0) return
    await this.corridors.pulse(path[0], PULSE_MS / sp)
    const cum: number[] = []
    let total = 0
    let fresh = 0
    for (const c of path) {
      const isNew = !this.corridors.has(c)
      if (isNew) fresh++
      total += isNew ? 1 : SHARED_CELL_WEIGHT
      cum.push(total)
    }
    const ms = Phaser.Math.Clamp(total * CORRIDOR_CELL_MS, fresh > 0 ? CORRIDOR_MIN_MS : 0, CORRIDOR_MAX_MS) / sp
    let next = 0
    const lay = (upTo: number) => {
      let changed = false
      while (next < path.length && cum[next] <= upTo + 1e-6) {
        changed = this.corridors.add(path[next]) || changed
        next++
      }
      this.corridors.setHead(path[Math.max(0, next - 1)])
      if (changed) this.corridors.redraw()
    }
    await new Promise<void>((resolve) => {
      this.tweens.addCounter({
        from: 0,
        to: total,
        duration: Math.max(1, ms),
        ease: 'Linear',
        onUpdate: (tw) => lay(tw.getValue() ?? 0),
        onComplete: () => {
          lay(total)
          resolve()
        }
      })
    })
    this.corridors.setHead(null)
  }

  private async runDemolish(job: DemolishJob): Promise<void> {
    const { view, retract } = job
    await this.waitUntilClear([view.rect, ...retract.map((c) => this.network.cellRect(c))])
    if (!this.alive) return
    // From here nobody may walk into what's being removed.
    this.doomed.delete(view)
    for (const c of retract) this.walkable.delete(this.network.key(c))
    this.rebuildNav()
    const sp = this.speed(false)
    await view.demolish(scaleTimes(DEMOLISH_TIMES, sp))
    if (!this.alive) return
    this.corridors.setBuiltBlocks(this.builtBlocks().map(blockRect))
    // Retract from the far end back toward the source; skip cells a newer corridor uses again.
    const gone = (c: Cell) => !this.walkable.has(this.network.key(c))
    if (retract.length > 0) {
      const ms = Math.min(RETRACT_MAX_MS, retract.length * RETRACT_CELL_MS) / sp
      let done = 0
      await new Promise<void>((resolve) => {
        this.tweens.addCounter({
          from: 0,
          to: retract.length,
          duration: Math.max(1, ms),
          ease: 'Sine.easeIn',
          onUpdate: (tw) => {
            const upTo = Math.floor(tw.getValue() ?? 0)
            let changed = false
            while (done < upTo) {
              const c = retract[done++]
              if (gone(c)) changed = this.corridors.remove(c) || changed
            }
            if (changed) this.corridors.redraw()
          },
          onComplete: () => resolve()
        })
      })
      for (const c of retract) if (gone(c)) this.corridors.remove(c)
    }
    this.corridors.redraw()
    this.drawGround()
    if (this.autoFit) this.fitCamera(true)
  }

  /** Resolves when no character stands in any of the rects (or after CLEAR_TIMEOUT_MS). */
  private async waitUntilClear(rects: Rect[]): Promise<void> {
    const until = performance.now() + CLEAR_TIMEOUT_MS
    for (;;) {
      if (!this.alive) return
      let busy = false
      for (const c of this.chars.values()) {
        const p = c.position
        if (rects.some((r) => p.x > r.x - 4 && p.x < r.x + r.width + 4 && p.y > r.y - 4 && p.y < r.y + r.height + 4)) {
          busy = true
          break
        }
      }
      if (!busy || performance.now() > until) return
      await new Promise<void>((resolve) => this.time.delayedCall(200, () => resolve()))
    }
  }

  // ---- camera ------------------------------------------------------------------------------

  /** Fits every block that is built or under construction (HQ + branches). */
  private fitCamera(animate: boolean): void {
    if (!this.layout) return
    const rects: Rect[] = []
    for (const v of this.views.values()) if (v.state !== 'planned') rects.push(v.rect)
    for (const v of this.doomed) rects.push(v.rect)
    const r = unionRects(rects)
    if (r) this.frame(r, animate, MAX_FIT_ZOOM)
  }

  private frame(r: Rect, animate: boolean, maxZoom: number): void {
    const cam = this.cameras.main
    // Extra room on top for the branch signs.
    const box = { x: r.x - FIT_PAD, y: r.y - FIT_PAD - 16, width: r.width + FIT_PAD * 2, height: r.height + FIT_PAD * 2 + 16 }
    const zoom = Phaser.Math.Clamp(Math.min(cam.width / box.width, cam.height / box.height), MIN_ZOOM, maxZoom)
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    if (animate) {
      cam.pan(cx, cy, CAMERA_MS, 'Sine.easeInOut', true)
      cam.zoomTo(zoom, CAMERA_MS, 'Sine.easeInOut', true)
    } else {
      cam.panEffect.reset()
      cam.zoomEffect.reset()
      cam.setZoom(zoom)
      cam.centerOn(cx, cy)
    }
  }

  private stopCameraEffects(): void {
    const cam = this.cameras.main
    cam.panEffect.reset()
    cam.zoomEffect.reset()
  }

  private setupCameraInput(): void {
    const cam = this.cameras.main
    this.input.on(
      'wheel',
      (p: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
        if (dy === 0) return
        this.stopCameraEffects()
        this.autoFit = false
        const before = cam.getWorldPoint(p.x, p.y)
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM))
        const after = cam.getWorldPoint(p.x, p.y)
        cam.scrollX += before.x - after.x
        cam.scrollY += before.y - after.y
      }
    )
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const now = performance.now()
      if (now - this.lastDown < DOUBLE_CLICK_MS) {
        this.lastDown = 0
        this.autoFit = true
        this.fitCamera(true)
        return
      }
      this.lastDown = now
      this.dragging = false
      this.downAt = { x: p.x, y: p.y }
    })
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return
      if (!this.dragging && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) < 4) return
      if (!this.dragging) {
        this.dragging = true
        this.stopCameraEffects()
        this.autoFit = false
      }
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom
    })
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  private spawn(entry: RosterEntry): void {
    const door = this.roster.entranceOf(entry.id)
    const c = this.makeCharacter(entry, door)
    this.chars.set(entry.id, c)
    c.enqueue({
      kind: 'spawn',
      lifecycle: true,
      target: () => this.goHome(entry, c)
    })

    if (entry.role === 'worker' && entry.managerId) {
      const boss = this.roster.get(entry.managerId)
      const m = this.chars.get(entry.managerId)
      if (boss && m && !this.leaving.has(boss.id)) {
        m.enqueue({
          kind: 'handoff',
          lifecycle: true,
          carry: 'handoff',
          detail: `${this.manifest.props.handoff} → ${entry.displayName}`,
          target: () => this.claimAt(boss.id, m, entry.home, false)
        })
        m.enqueue({ kind: 'return', lifecycle: true, target: () => this.goHome(boss, m) })
      }
    }
    this.emitTeams()
  }

  private onWaiting(entry: RosterEntry, c: Character, detail: string): void {
    if (this.waiting.has(entry.id)) {
      c.setDetail(detail)
      return
    }
    this.waiting.add(entry.id)
    this.updateBadge()
    const def = this.def('waiting')
    c.enqueue({
      kind: 'waiting',
      activity: 'waiting',
      lifecycle: true,
      stay: true,
      carry: 'memo',
      verb: def.verb,
      anim: def.anim,
      detail,
      // Always the HQ inbox (or the queue outside the HQ door), whatever branch they're in.
      target: () => {
        const { point, queued } = this.roster.claimInbox(entry.id)
        if (queued) this.queuedAtDoor.add(entry.id)
        return this.claimAt(entry.id, c, point, false)
      },
      onDone: () => {
        this.roster.releaseInbox(entry.id)
        this.queuedAtDoor.delete(entry.id)
      }
    })
  }

  private workerDone(entry: RosterEntry, c: Character, detail: string): void {
    this.leaving.add(entry.id)
    const def = this.def('done')
    const loc = def.location === HOME ? MANAGER : def.location
    c.enqueue({
      kind: 'done',
      activity: 'done',
      lifecycle: true,
      carry: 'report',
      verb: def.verb,
      anim: def.anim,
      detail: detail || this.manifest.props.report,
      target: (from) => this.resolve(entry, c, loc, from)
    })
    this.queueLeave(entry, c)
  }

  private managerDone(entry: RosterEntry): void {
    if (entry.role === 'boss') return
    for (const w of this.roster.teamWorkers(entry.teamId)) this.sendAway(w)
    this.sendAway(entry)
  }

  /** Drop whatever they were doing and walk out. */
  private sendAway(entry: RosterEntry): void {
    const c = this.chars.get(entry.id)
    if (!c) return
    this.leaving.add(entry.id)
    if (this.waiting.delete(entry.id)) this.updateBadge()
    this.roster.releaseInbox(entry.id)
    c.clearQueue()
    c.interrupt()
    this.queueLeave(entry, c)
  }

  private queueLeave(entry: RosterEntry, c: Character): void {
    c.enqueue({
      kind: 'leave',
      lifecycle: true,
      target: (from) => {
        this.stations.release(entry.id)
        c.atHome = false
        return this.roster.entranceOf(entry.id, from)
      },
      onArrive: () => this.despawn(entry.id)
    })
  }

  private despawn(id: string): void {
    const c = this.chars.get(id)
    this.stations.release(id)
    const removed = this.roster.remove(id)
    this.leaving.delete(id)
    this.departed.set(id, Date.now())
    if (this.waiting.delete(id)) this.updateBadge()
    this.chars.delete(id)
    c?.fadeOutAndDestroy(() => undefined)
    if (removed?.releasedBranch) {
      // Whole team gone: the branch is demolished and its slot is free for the next team.
      this.planDemolish(removed.releasedBranch.id)
    }
    this.emitTeams()
  }

  // ---- targets -----------------------------------------------------------------------------

  private def(a: Activity): ActivityDef {
    return this.manifest.activities?.[a] ? activityDef(this.manifest, a) : { location: HOME }
  }

  private activityAction(entry: RosterEntry, c: Character, a: Activity, detail: string): Action {
    const def = this.def(a)
    return {
      kind: 'activity',
      activity: a,
      lifecycle: false,
      verb: def.verb,
      anim: def.anim,
      detail,
      target: (from) => this.resolve(entry, c, def.location, from)
    }
  }

  /**
   * HOME -> own seat/desk; MANAGER -> manager's seat (own for a manager); the waiting type ->
   * HQ; anything else -> nearest of that type in the character's branch, then the HQ, then home.
   */
  private resolve(entry: RosterEntry, c: Character, loc: string, from: Point): Point {
    if (loc === HOME) return this.goHome(entry, c)
    if (loc === MANAGER) {
      const base = this.roster.managerHome(entry.id) ?? entry.home
      return this.claimAt(entry.id, c, base, base === entry.home)
    }
    const p =
      loc === this.waitingType ? nearest(this.layout.hq.locations, loc, from) : this.roster.station(entry.id, loc, from)
    return p ? this.claimAt(entry.id, c, p, false) : this.goHome(entry, c)
  }

  private goHome(entry: RosterEntry, c: Character): Point {
    return this.claimAt(entry.id, c, entry.home, true)
  }

  private claimAt(id: string, c: Character, base: Point, home: boolean): Point {
    c.atHome = home
    return this.stations.claim(id, base)
  }

  // ---- characters --------------------------------------------------------------------------

  private makeCharacter(entry: RosterEntry, at: Point): Character {
    return new Character(this, {
      id: entry.id,
      name: entry.displayName,
      skin: this.skinFor(entry),
      tint: this.tintFor(entry),
      x: at.x,
      y: at.y,
      onIdle: (c) => this.driftHome(entry.id, c),
      findPath: (from, to) => this.findPath(from, to)
    })
  }

  /** After a while with nothing to do, wander back home. */
  private driftHome(id: string, c: Character): void {
    if (id === BOSS_ID || c.atHome) return
    this.time.delayedCall(DRIFT_HOME_MS, () => {
      const entry = this.roster.get(id)
      if (!entry || this.chars.get(id) !== c || !c.isIdle || c.atHome || this.leaving.has(id)) return
      c.enqueue({ kind: 'home', activity: 'idle', lifecycle: false, target: () => this.goHome(entry, c) })
    })
  }

  private providerKey(entry: RosterEntry): string {
    const p = entry.role === 'boss' ? 'human' : entry.provider
    return this.manifest.providers[p] ? p : 'default'
  }

  private tintFor(entry: RosterEntry): number {
    const skin = this.manifest.providers[this.providerKey(entry)]
    return cssToInt(skin?.tint ?? this.manifest.providers.default?.tint, 0xbab0ac)
  }

  private skinFor(entry: RosterEntry): Skin {
    const role: Role = entry.role
    const prov = this.providerKey(entry)
    const provSheet = this.manifest.providers[prov]?.sprites?.[role]
    const roleDef = this.manifest.roles[role]
    const fromSheet =
      (provSheet && sheetSkin(this, providerSheetKey(prov, role), provSheet)) ||
      (roleDef.sprite && sheetSkin(this, roleSheetKey(role), roleDef.sprite))
    return fromSheet || placeholderSkin(this, role, roleDef.placeholder, toneIndex(entry.id))
  }

  private updateBadge(): void {
    this.chars.get(BOSS_ID)?.setBadge(this.waiting.size)
  }

  /** One legend row per branch (a team stays listed until its last member has left). */
  private emitTeams(): void {
    const teams: TeamInfo[] = []
    for (const b of this.layout.branches().sort((x, y) => x.slot - y.slot)) {
      const m = this.roster.get(b.id) ?? this.teamLeads.get(b.id)
      if (!m) continue
      teams.push({
        id: b.id,
        name: m.displayName,
        provider: m.provider,
        color:
          this.manifest.providers[this.providerKey(m)]?.tint ?? this.manifest.providers.default?.tint ?? '#bab0ac',
        workers: this.roster.teamWorkers(b.id).length
      })
    }
    this.opts.onTeams(teams)
  }
}
