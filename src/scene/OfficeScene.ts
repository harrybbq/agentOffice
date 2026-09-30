// The generic, theme-driven scene (named for the default theme). Knows only the required
// location types, HOME/MANAGER and the lifecycle conventions from shared/events.ts.
//
// The world is an HQ plus one branch per team (WorldLayout), all visible at once; characters
// walk between them along A* paths (NavGrid) through the corridors.
import Phaser from 'phaser'
import type { Activity, AgentEvent } from '../../shared/events'
import { activityDef, HOME, MANAGER } from '../../shared/theme'
import type { ActivityDef, Role, ThemeManifest } from '../../shared/theme'
import type { LoadedTheme } from '../../shared/ipc'
import { cssToInt, drawBlock, preloadTemplates } from '../theme/loader'
import type { ParsedMap, Rect } from '../theme/loader'
import { WorldLayout } from '../world/layout'
import type { Block } from '../world/layout'
import { NavGrid } from '../world/pathfinding'
import { BOSS_ID, nearest, Roster, Stations } from './roster'
import type { Point, RosterEntry } from './roster'
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
const FADE_MS = 500
const DOUBLE_CLICK_MS = 320
const BLOCK_DEPTH = -1000
const SIGN_DEPTH = -900
const CORRIDOR_DEPTH = -2000

interface BlockView {
  block: Block
  objects: Phaser.GameObjects.GameObject[]
  signText: Phaser.GameObjects.Text
  signSwatch: Phaser.GameObjects.Rectangle | null
}

type Fadeable = Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Alpha

function darken(c: number, f: number): number {
  const r = Math.round(((c >> 16) & 0xff) * f)
  const g = Math.round(((c >> 8) & 0xff) * f)
  const b = Math.round((c & 0xff) * f)
  return (r << 16) | (g << 8) | b
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
  private corridor!: Phaser.GameObjects.Graphics
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

    this.corridor = this.add.graphics().setDepth(CORRIDOR_DEPTH)
    this.addBlockView(this.layout.hq, false)
    this.rebuildWorld()

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

  handleEvent(e: AgentEvent): void {
    if (!this.roster) return
    const id = e.agentId
    if (this.leaving.has(id)) return
    if (this.recentlyDeparted(id)) return
    // A child of someone who is leaving would re-hire them; ignore it.
    if (e.parentId && (this.leaving.has(e.parentId) || this.recentlyDeparted(e.parentId))) return

    const { created, upgraded, branches } = this.roster.ensure(e)
    if (branches.length > 0) {
      for (const b of branches) this.addBlockView(b, true)
      this.worldChanged()
    }
    for (const entry of created) this.spawn(entry)
    if (upgraded) {
      const c = this.chars.get(upgraded.id)
      c?.setName(upgraded.displayName)
      c?.setTint(this.tintFor(upgraded))
      this.updateSign(upgraded.teamId)
      this.emitTeams()
    }

    const entry = this.roster.get(id)
    const c = this.chars.get(id)
    if (!entry || !c) return

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

  /** Pans/zooms to a team's branch (HUD legend click). Double-click the scene to auto-fit again. */
  focusTeam(teamId: string): void {
    const b = this.layout?.branch(teamId)
    if (!b) return
    this.autoFit = false
    this.frame({ x: b.offset.x, y: b.offset.y, width: b.width, height: b.height }, true, MAX_FIT_ZOOM)
  }

  private recentlyDeparted(id: string): boolean {
    const gone = this.departed.get(id)
    if (gone === undefined) return false
    if (Date.now() - gone < DEPARTED_GRACE_MS) return true
    this.departed.delete(id)
    return false
  }

  // ---- world -------------------------------------------------------------------------------

  /** Rebuilds the nav grid and corridor floor after the layout changed. */
  private rebuildWorld(): void {
    const bounds = this.layout.bounds()
    this.nav = new NavGrid(bounds, this.layout.blocked())
    this.corridor.clear()
    if (!this.opts.overlay) {
      const bg = cssToInt(this.manifest.background, 0x2b2d42)
      this.corridor.fillStyle(darken(bg, 0.78), 1)
      this.corridor.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)
      // Faint plot outlines so free slots read as empty lots.
      this.corridor.lineStyle(1, 0xffffff, 0.04)
      this.corridor.strokeRect(bounds.x + 0.5, bounds.y + 0.5, bounds.width - 1, bounds.height - 1)
    }
  }

  private worldChanged(): void {
    this.rebuildWorld()
    for (const c of this.chars.values()) c.repath()
    if (this.autoFit) this.fitCamera(true)
  }

  private findPath(from: Point, to: Point): Point[] | null {
    return this.nav.findPath(from, to)
  }

  private addBlockView(block: Block, animate: boolean): void {
    const objects = drawBlock(this, block, BLOCK_DEPTH)
    const isHq = block.kind === 'hq'
    const signText = this.add
      .text(block.offset.x + block.width / 2, block.offset.y - 6, '', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#f4f1ea',
        backgroundColor: 'rgba(20, 22, 32, 0.85)',
        padding: { left: isHq ? 6 : 20, right: 6, top: 2, bottom: 2 },
        resolution: 2
      })
      .setOrigin(0.5, 1)
      .setDepth(SIGN_DEPTH)
    const signSwatch = isHq
      ? null
      : this.add.rectangle(0, 0, 10, 10, 0xffffff).setStrokeStyle(1, 0x000000, 0.6).setDepth(SIGN_DEPTH + 1)
    objects.push(signText)
    if (signSwatch) objects.push(signSwatch)
    const view: BlockView = { block, objects, signText, signSwatch }
    this.views.set(block.id, view)
    this.updateSign(block.id)
    if (animate) {
      for (const o of objects as Fadeable[]) {
        const alpha = o.alpha
        o.setAlpha(0)
        this.tweens.add({ targets: o, alpha, duration: FADE_MS, ease: 'Sine.easeOut' })
      }
    }
  }

  private removeBlockView(blockId: string): void {
    const view = this.views.get(blockId)
    if (!view) return
    this.views.delete(blockId)
    this.teamLeads.delete(blockId)
    for (const o of view.objects as Fadeable[]) {
      this.tweens.add({
        targets: o,
        alpha: 0,
        duration: FADE_MS,
        ease: 'Sine.easeIn',
        onComplete: () => o.destroy()
      })
    }
  }

  private updateSign(blockId: string): void {
    const view = this.views.get(blockId)
    if (!view) return
    if (view.block.kind === 'hq') {
      view.signText.setText('HQ')
      return
    }
    const live = this.roster?.get(blockId)
    if (live) this.teamLeads.set(blockId, { ...live })
    const m = live ?? this.teamLeads.get(blockId)
    view.signText.setText(m?.displayName ?? blockId)
    if (view.signSwatch && m) {
      view.signSwatch.setFillStyle(this.tintFor(m))
      const t = view.signText
      view.signSwatch.setPosition(t.x - t.width / 2 + 10, t.y - t.height / 2)
    }
  }

  // ---- camera ------------------------------------------------------------------------------

  /** Fits every occupied block (HQ + branches). */
  private fitCamera(animate: boolean): void {
    if (!this.layout) return
    this.frame(this.layout.occupiedBounds(), animate, MAX_FIT_ZOOM)
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
      // Whole team gone: the branch fades out and its slot is free for the next team.
      this.removeBlockView(removed.releasedBranch.id)
      this.worldChanged()
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
