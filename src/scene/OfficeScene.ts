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
//
// Who goes where (see also shared/theme.ts):
// - Workers stay in their branch: stations resolve there only and they path on the branch's own
//   nav grid (no corridors, no HQ). A waiting worker takes its memo to its manager's office.
// - Managers may use corridors and the HQ: the manager carries its team's memos (and its own) to the
//   HQ inbox, waits while anyone in the team waits, then goes home. Managers never path through
//   another branch.
// - Office-wide CEO order (opts.isOfficeWide): workers may use stations, corridors and the inbox
//   anywhere. When it ends, workers outside their branch walk home.
// - Each team has a colour (theme teams.colors) and its manager a distinct procedural head.
// - Stations: the theme's stationRules pick a more specific location than the activities table,
//   stationLabels put a floating tag above each station (StationLabels, a DOM layer), and after
//   idle.afterMs without activity a character walks to a free spot of the theme's idle location in
//   its own branch.
// - Pointing at a character shows a ring and a card; clicking one selects it (opts.onAgentClick),
//   clicking the floor deselects. The selected character keeps its ring.
import Phaser from 'phaser'
import type { Activity, AgentEvent } from '../../shared/events'
import { HOME, MANAGER, teamColors } from '../../shared/theme'
import type { Role, ThemeManifest } from '../../shared/theme'
import type { LoadedTheme } from '../../shared/ipc'
import { cssToInt, preloadTemplates } from '../theme/loader'
import type { ParsedMap, Rect } from '../theme/loader'
import { unionRects, WorldLayout } from '../world/layout'
import type { Block } from '../world/layout'
import { NavGrid } from '../world/pathfinding'
import { NavScopes } from '../world/scopes'
import { blockRect, buildNav, CorridorNetwork } from '../world/corridors'
import type { Cell, Corridor } from '../world/corridors'
import { BOSS_ID, idSeed, nearest, Roster, Stations } from './roster'
import type { Point, RosterEntry } from './roster'
import { BlockView } from './blockView'
import type { BuildTimes } from './blockView'
import { CorridorView } from './corridorView'
import { Character } from './Character'
import { RelayBook } from './relay'
import { TeamLooks } from './teamLook'
import { IdleClock } from './idle'
import { HoverCard, StationLabels } from './stationLabels'
import { SignBars } from './signBars'
import type { SignBarState } from './signBars'
import type { StationHit } from './stationLabels'
import { StationRouter } from '../theme/stations'
import { spanText } from '../ui/inspect'
import type { Action } from './Character'
import {
  createSheetAnims,
  PROP_SCALE,
  ensureProps,
  placeholderSkin,
  preloadSheets,
  propKey,
  providerSheetKey,
  roleSheetKey,
  sheetSkin,
  toneIndex
} from './charTextures'
import type { PlaceholderLook, Skin } from './charTextures'

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
  /** Team colour (CSS). */
  color: string
  /** Provider (body) colour (CSS). */
  providerColor: string
  workers: number
  /** False while the manager has left but workers are still walking out (not an order target). */
  live: boolean
}

export interface SceneOptions {
  theme: LoadedTheme
  hq: ParsedMap
  branch: ParsedMap
  overlay: boolean
  onReady: () => void
  onTeams: (teams: TeamInfo[]) => void
  /** Office-wide CEO order in progress (state lives outside the scene so rebuilds keep it). */
  isOfficeWide: () => boolean
  /** Layer over the canvas for station tags and the hover card (none: neither is shown). */
  overlayEl?: HTMLElement | null
  /** Show the station tags (the shell's "Labels" switch). */
  labels?: boolean
  /** A character was clicked (its agent id), or the floor (null). */
  onAgentClick?: (agentId: string | null) => void
  /** When an agent was first seen, for the hover card (survives a rebuild of the scene). */
  agentSince?: (agentId: string) => number | undefined
  /** The progress bars under the branch signs, by team id (the shell keeps them across rebuilds). */
  progress?: ReadonlyMap<string, SignBarState>
}

const DRIFT_HOME_MS = 4000
/** Late events for an agent that already left are ignored for this long. */
const DEPARTED_GRACE_MS = 30_000

const MIN_ZOOM = 0.3
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
const ORDER_DEPTH = 100_000
/** Below this zoom characters drop their name pill and speech bubble (they'd be specks). */
const COMPACT_ZOOM = 0.45
/** A character can be clicked within at least this many screen px of it, however far zoomed out. */
const HIT_MIN_HALF_W = 13
const HIT_MIN_H = 30

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
  private compact = false
  /** Branch the camera was last asked to show; re-framed when the view is resized. */
  private focusedTeam: string | null = null
  private lastDown = 0
  private dragging = false
  private downAt: Point = { x: 0, y: 0 }
  /** Waiting characters queued outside the HQ door (FIFO), promoted as inbox slots free up. */
  private queuedAtDoor = new Set<string>()
  /** Last known manager per team, so a branch keeps its name while workers finish leaving. */
  private teamLeads = new Map<string, RosterEntry>()
  private promoteClock = 0
  /** Per-role walkable areas (rebuilt with the nav grid). */
  private scopes!: NavScopes
  /** Open memos and which managers are relaying them to the HQ. Deferred items = manager actions. */
  private relay = new RelayBook<Action>()
  /** A manager's own waiting detail (shown while it relays). */
  private selfDetail = new Map<string, string>()
  private looks!: TeamLooks
  private palette: readonly string[] = []
  /** The theme's stationRules / stationLabels / idle, compiled once. */
  private router: StationRouter
  private idle: IdleClock
  private labels: StationLabels | null = null
  /** The progress bars under the branch signs (a DOM layer, like the station tags). */
  private signBars: SignBars | null = null
  private hoverCard: HoverCard | null = null
  private labelsOn: boolean
  /** Last event per agent with a character (what the hover card says it is doing). */
  private lastEvent = new Map<string, { activity: Activity; detail: string }>()
  private selectedId: string | null = null
  private hoverId: string | null = null
  private hoverStation: StationHit | null = null
  /** Second click of a double-click: its release is not a click on the floor. */
  private suppressClick = false
  /** Portrait data URLs by look. */
  private portraits = new Map<string, string>()
  private portraitSeq = 0

  constructor(opts: SceneOptions) {
    super({ key: 'office' })
    this.opts = opts
    this.manifest = opts.theme.manifest
    this.router = new StationRouter(this.manifest)
    this.idle = new IdleClock(this.router.idle?.afterMs ?? 0)
    this.labelsOn = opts.labels ?? true
  }

  preload(): void {
    this.load.on('loaderror', (file: Phaser.Loader.File) =>
      console.warn(`[agent-office] failed to load ${file.key} (${String(file.url)})`)
    )
    preloadTemplates(this, { hq: this.opts.hq, branch: this.opts.branch }, this.opts.theme.baseUrl, this.manifest.art)
    preloadSheets(this, this.manifest, this.opts.theme.baseUrl)
  }

  create(): void {
    const { hq, branch } = this.opts
    ensureProps(this)
    createSheetAnims(this, this.manifest)

    this.palette = teamColors(this.manifest)
    this.looks = new TeamLooks(this.palette.length)
    this.layout = new WorldLayout(hq, branch)
    const w = this.manifest.activities?.waiting ? this.router.table('waiting').location : ''
    this.waitingType = hq.locations.get(w)?.length ? w : 'inbox'
    this.roster = new Roster(
      this.layout,
      { provider: 'human', displayName: this.manifest.roles.boss.label },
      this.waitingType
    )

    this.network = new CorridorNetwork(this.layout)
    this.ground = this.add.graphics().setDepth(GROUND_DEPTH)
    this.corridors = new CorridorView(this, this.network, this.corridorStyle(), CORRIDOR_DEPTH)
    if (this.opts.overlayEl) {
      this.labels = new StationLabels(this.opts.overlayEl, this.router.labels, this.layout.tile)
      this.labels.setEnabled(this.labelsOn)
      this.hoverCard = new HoverCard(this.opts.overlayEl)
      this.signBars = new SignBars(this.opts.overlayEl)
      if (this.opts.progress) this.signBars.set(this.opts.progress)
    }
    this.addBlockView(this.layout.hq, true)
    this.labels?.add(this.layout.hq, false)
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
      if (this.autoFit) return this.fitCamera(false)
      // The shell's panels resize the view: keep the focused branch framed.
      const b = this.focusedTeam ? this.layout.branch(this.focusedTeam) : undefined
      if (b) this.frame(blockRect(b), false, MAX_FIT_ZOOM)
      else this.focusedTeam = null
    }
    this.scale.on(Phaser.Scale.Events.RESIZE, onResize)

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.alive = false
      this.jobs = []
      this.scale.off(Phaser.Scale.Events.RESIZE, onResize)
      for (const c of this.chars.values()) c.destroy()
      this.chars.clear()
      this.labels?.destroy()
      this.hoverCard?.destroy()
      this.signBars?.destroy()
      this.signBars = null
      this.labels = null
      this.hoverCard = null
      this.game.canvas.style.cursor = ''
    })
    this.opts.onReady()
  }

  update(_time: number, delta: number): void {
    const compact = this.cameras.main.zoom < COMPACT_ZOOM
    if (compact !== this.compact) {
      this.compact = compact
      for (const c of this.chars.values()) c.setCompact(compact)
    }
    for (const c of this.chars.values()) c.tick(delta)
    this.promoteClock += delta
    if (this.promoteClock >= 500) {
      this.promoteClock = 0
      this.promoteQueue()
      this.restIdle()
    }
    this.syncOverlay()
  }

  // ---- stations, selection, hover ----------------------------------------------------------------

  /** Station tags on or off (the shell's "Labels" switch). */
  setLabels(on: boolean): void {
    this.labelsOn = on
    this.labels?.setEnabled(on)
    if (!on) this.setHoverStation(null)
  }

  /** The progress bars under the branch signs, by team id (a team that is not in the map has none). */
  setProgress(states: ReadonlyMap<string, SignBarState>): void {
    this.signBars?.set(states)
  }

  /** The agent the inspector shows (null: nobody). Its character keeps a ring. */
  setSelectedAgent(id: string | null): void {
    if (id === this.selectedId) return
    const prev = this.selectedId
    this.selectedId = id
    if (prev) this.chars.get(prev)?.setHighlight(prev === this.hoverId ? 'hover' : 'none')
    if (id) this.chars.get(id)?.setHighlight('selected')
  }

  /** Pans/zooms to the branch an agent is in (a worker's row in the inspector). */
  focusAgent(id: string): void {
    const e = this.roster?.get(id)
    if (e && e.role !== 'boss') this.focusTeam(e.teamId)
  }

  /**
   * The character as a small picture (a data URL) for the inspector's header, or null when it
   * can't be made. Drawn from the same textures as the character, so real art shows up here too.
   */
  portrait(id: string, done: (url: string | null) => void): void {
    const entry = this.roster?.get(id)
    if (!entry || !this.alive) return done(null)
    try {
      const skin = this.skinFor(entry)
      const tint = this.tintFor(entry)
      const body = skin.body
      const over = skin.overlay
      const frame = skin.kind === 'sheet' ? 0 : 'stand'
      const overFrame = skin.kind === 'sheet' ? 0 : 'front'
      const sig = `${body}|${over ?? ''}|${tint}`
      const cached = this.portraits.get(sig)
      if (cached) return done(cached)
      const f = this.textures.getFrame(body, frame)
      if (!f) return done(null)
      const k = Math.max(1, Math.round(72 / f.height))
      const key = `portrait:${++this.portraitSeq}`
      const dt = this.textures.addDynamicTexture(key, f.width * k, f.height * k)
      if (!dt) return done(null)
      dt.stamp(body, frame, 0, 0, { tint, scale: k, originX: 0, originY: 0 })
      if (over) dt.stamp(over, overFrame, 0, 0, { scale: k, originX: 0, originY: 0 })
      dt.render()
      dt.snapshot((img) => {
        const url = img instanceof HTMLImageElement ? img.src : null
        if (url) this.portraits.set(sig, url)
        if (this.alive && this.textures.exists(key)) this.textures.remove(key)
        done(url)
      })
    } catch (err) {
      console.warn('[agent-office] no portrait', err)
      done(null)
    }
  }

  /** Where a character is on screen (canvas px), for tools that drive the app. */
  screenPosOf(id: string): Point | null {
    const c = this.chars.get(id)
    if (!c) return null
    const v = this.cameras.main.worldView
    const z = this.cameras.main.zoom
    return { x: (c.position.x - v.x) * z, y: (c.position.y - c.height / 2 - v.y) * z }
  }

  /**
   * Characters with nothing to do for the theme's idle.afterMs walk to its idle location: each to a
   * free spot of that type (a seat on the sofa, the water cooler), side by side at one where people
   * stand once all are taken (Stations.restSpot).
   */
  private restIdle(): void {
    const loc = this.router.idle?.location
    if (!loc) return
    for (const id of this.idle.due(Date.now(), (x) => this.canRest(x, loc))) {
      const entry = this.roster.get(id)
      const c = this.chars.get(id)
      if (!entry || !c) continue
      c.enqueue({
        kind: 'rest',
        activity: 'idle',
        lifecycle: false,
        target: (from) => {
          // Always inside the character's own branch, also for a manager.
          const spots = this.roster.blockOf(id).locations.get(loc) ?? []
          const p = this.stations.restSpot(id, spots, from, idSeed(id), (q) => this.seatAt(q) !== null)
          return p ? this.claimAt(id, c, p, false) : this.goHome(entry, c)
        }
      })
    }
  }

  private canRest(id: string, loc: string): boolean {
    const entry = this.roster.get(id)
    const c = this.chars.get(id)
    if (!entry || !c || entry.role === 'boss' || !c.isIdle) return false
    if (this.leaving.has(id) || this.waiting.has(id) || this.relay.isOpen(id)) return false
    if (entry.role === 'manager' && this.relay.isRelaying(entry.teamId)) return false
    return (this.roster.blockOf(id).locations.get(loc)?.length ?? 0) > 0
  }

  /** The character under a pointer: a generous box, never smaller than a fingertip on screen. */
  private charAt(p: Phaser.Input.Pointer): Character | null {
    const cam = this.cameras.main
    const w = cam.getWorldPoint(p.x, p.y)
    const z = cam.zoom
    let best: Character | null = null
    let bestD = Infinity
    for (const c of this.chars.values()) {
      if (c.id === BOSS_ID || this.leaving.has(c.id)) continue
      const h = Math.max(c.height + 6, HIT_MIN_H / z)
      const half = Math.max(c.height * 0.5, HIT_MIN_HALF_W / z)
      const { x, y } = c.position
      if (w.x < x - half || w.x > x + half || w.y > y + 5 / z || w.y < y - h) continue
      const d = Math.hypot(w.x - x, w.y - (y - c.height / 2))
      if (d < bestD) {
        best = c
        bestD = d
      }
    }
    return best
  }

  private setHoverChar(id: string | null): void {
    if (id === this.hoverId) return
    const prev = this.hoverId
    this.hoverId = id
    if (prev && prev !== this.selectedId) this.chars.get(prev)?.setHighlight('none')
    if (id && id !== this.selectedId) this.chars.get(id)?.setHighlight('hover')
    this.game.canvas.style.cursor = id ? 'pointer' : ''
    if (!id) this.hoverCard?.hide()
  }

  private setHoverStation(hit: StationHit | null): void {
    this.hoverStation = hit
    this.labels?.setHover(hit, hit ? this.namesAt(hit) : [])
  }

  /** Who stands at a station right now (not those still on their way). */
  private namesAt(hit: StationHit): string[] {
    const names: string[] = []
    for (const pt of hit.anchor.points) {
      for (const id of this.stations.occupantsAt(pt)) {
        const c = this.chars.get(id)
        const e = this.roster.get(id)
        if (!c || !e || !c.isSettled) continue
        if (Math.hypot(c.position.x - pt.x, c.position.y - pt.y) > 64) continue
        names.push(e.displayName)
      }
    }
    return names
  }

  private updateHover(p: Phaser.Input.Pointer): void {
    const c = this.charAt(p)
    this.setHoverChar(c?.id ?? null)
    const cam = this.cameras.main
    this.setHoverStation(c || !this.labels ? null : this.labels.stationAt(cam.getWorldPoint(p.x, p.y)))
  }

  private clearHover(): void {
    this.setHoverChar(null)
    this.setHoverStation(null)
  }

  /** Station tags and the hover card follow the camera (and the character pointed at). */
  private syncOverlay(): void {
    const cam = this.cameras.main
    const v = cam.worldView
    const view = { x: v.x, y: v.y, zoom: cam.zoom, width: cam.width, height: cam.height }
    this.signBars?.layout(view, (teamId) => {
      const box = this.views.get(teamId)?.signBox
      return box ? { ...box, color: this.teamColorCss(teamId) } : null
    })
    if (this.hoverStation && this.labels) this.labels.setHover(this.hoverStation, this.namesAt(this.hoverStation))
    if (this.labels) {
      // A tag fades while something is said behind it, or while someone stands or sits behind it.
      const bubbles = []
      for (const c of this.chars.values()) {
        const b = c.bubbleBounds
        if (b) bubbles.push(b)
        if (c.isSettled) bubbles.push({ x: c.position.x - 8, y: c.position.y - c.height, width: 16, height: c.height * 0.55 })
      }
      this.labels.layout(view, bubbles)
    }
    if (!this.hoverCard) return
    const c = this.hoverId ? this.chars.get(this.hoverId) : undefined
    const e = this.hoverId ? this.roster.get(this.hoverId) : undefined
    if (!c || !e || this.leaving.has(e.id)) {
      if (this.hoverId) this.setHoverChar(null)
      return
    }
    const last = this.lastEvent.get(e.id)
    const since = this.opts.agentSince?.(e.id)
    this.hoverCard.show(
      {
        name: e.displayName,
        role: this.manifest.roles[e.role]?.label ?? e.role,
        phrase: last ? this.router.phrase(last.activity, last.detail) : this.router.phrase('idle'),
        runtime: since ? `${spanText(Date.now() - since)} in the office` : '',
        color: this.teamColorCss(e.teamId)
      },
      (c.position.x - v.x) * cam.zoom,
      (c.position.y - c.height - 14 - v.y) * cam.zoom,
      view
    )
  }

  /** Moves the longest-queued waiting characters into free HQ inbox slots. */
  private promoteQueue(): void {
    for (const id of this.queuedAtDoor) {
      const c = this.chars.get(id)
      if (!c || !(this.waiting.has(id) || this.relay.isRelaying(id))) {
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

  /** Pans/zooms to a team's branch (session list click). Double-click the scene to auto-fit again. */
  focusTeam(teamId: string): void {
    const b = this.layout?.branch(teamId)
    if (!b) return
    this.autoFit = false
    this.focusedTeam = teamId
    this.frame(blockRect(b), true, MAX_FIT_ZOOM)
  }

  /** Back to the auto-fitted view of the whole office (same as a double-click). */
  fitAll(): void {
    this.autoFit = true
    this.focusedTeam = null
    this.fitCamera(true)
  }

  /**
   * The CEO speaks (order bar): a bubble over the CEO and a sealed order envelope flying to each
   * target team's manager, or to every manager for 'all'.
   */
  showOrder(targets: 'all' | readonly string[], text: string): void {
    if (!this.roster) return
    this.chars.get(BOSS_ID)?.say(`“${text}”`, 4500)
    const ids = targets === 'all' ? this.roster.managers().map((m) => m.id) : targets
    ids.forEach((id, i) => this.time.delayedCall(i * 160, () => this.flyOrder(id, text)))
  }

  /** Office-wide mode changed: re-plan walks; when it ends, workers come back to their branch. */
  setOfficeWide(on: boolean): void {
    if (!this.roster) return
    if (!on) {
      for (const entry of this.roster.all()) {
        if (entry.role !== 'worker' || this.leaving.has(entry.id)) continue
        const c = this.chars.get(entry.id)
        if (!c) continue
        if (this.relay.route(entry.id) === 'hq') {
          // Memo bound for the HQ: hand it to the manager instead.
          const atIt = c.currentAction?.kind === 'waiting'
          if (!atIt) {
            this.relay.open(entry.id, entry.teamId, 'manager') // not started: its target re-resolves
          } else if (c.canRelocate) {
            this.roster.releaseInbox(entry.id)
            this.queuedAtDoor.delete(entry.id)
            this.relay.open(entry.id, entry.teamId, 'manager')
            const spot = this.roster.claimMemoSpot(entry.id) ?? entry.home
            c.relocate(this.claimAt(entry.id, c, spot, false))
            this.relay.deliver(entry.id)
            this.syncRelay(entry.teamId)
          } // else: just arriving at the HQ inbox; that memo stays there until answered
        } else if (!this.insideOwnBranch(entry, c.position)) {
          c.enqueueFront({ kind: 'home', activity: 'idle', lifecycle: false, target: () => this.goHome(entry, c) })
        }
      }
    }
    for (const c of this.chars.values()) c.repath()
  }

  private flyOrder(managerId: string, text: string): void {
    const boss = this.chars.get(BOSS_ID)
    const mc = this.chars.get(managerId)
    if (!boss || !mc || this.leaving.has(managerId)) return
    this.flyProp(propKey('order'), { x: boss.position.x, y: boss.position.y - 24 }, () => ({ x: mc.position.x, y: mc.position.y - 22 }), {
      onArrive: () => {
        if (this.chars.get(managerId) === mc && !this.leaving.has(managerId)) mc.say(`Order: ${text}`, 3500)
      }
    })
  }

  /**
   * A team posted on the office board: a small note flies from its manager to the HQ's notice
   * area (a `noticeboard` location of the HQ map if the theme has one, else the HQ door), or, for
   * a hand-over meant for a team, to that team's manager. Quieter than an order: lower arc, no bubble.
   */
  showNote(fromTeam: string, toTeam: string | null, kind: 'note' | 'handover' = 'note'): void {
    if (!this.roster) return
    const from = this.chars.get(fromTeam)
    if (!from || this.leaving.has(fromTeam)) return
    const to = toTeam && toTeam !== fromTeam && !this.leaving.has(toTeam) ? this.chars.get(toTeam) : undefined
    const start = { x: from.position.x, y: from.position.y - 22 }
    const board = nearest(this.layout.hq.locations, 'noticeboard', start) ?? this.roster.hqDoor
    this.flyProp(propKey(kind === 'handover' ? 'handoff' : 'memo'), start, () => (to ? { x: to.position.x, y: to.position.y - 22 } : { x: board.x, y: board.y - 10 }), {
      arc: 0.55,
      fadeMs: 320,
      minScreenPx: 13
    })
  }

  /** A prop travelling along an arc from `start` to wherever `end()` is at that moment. */
  private flyProp(
    key: string,
    start: Point,
    end: () => Point,
    opts: { arc?: number; fadeMs?: number; minScreenPx?: number; onArrive?: () => void } = {}
  ): void {
    const img = this.add.image(start.x, start.y, key).setDepth(ORDER_DEPTH)
    // Zoomed out to the whole office a prop of a few pixels would vanish: keep it this wide on screen.
    // (Prop textures are drawn larger than they show: PROP_SCALE brings them to map size.)
    const base = opts.minScreenPx ? Math.max(PROP_SCALE, opts.minScreenPx / (img.width * this.cameras.main.zoom)) : PROP_SCALE
    img.setScale(base)
    const end0 = end()
    const dist = Math.hypot(end0.x - start.x, end0.y - start.y)
    const arc = opts.arc ?? 1
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: Phaser.Math.Clamp(700 + dist * 0.9, 900, 2400),
      ease: 'Sine.easeInOut',
      onUpdate: (tw) => {
        const t = tw.getValue() ?? 0
        const to = end()
        const mid = { x: (start.x + to.x) / 2, y: Math.min(start.y, to.y) - (60 + dist * 0.15) * arc }
        const u = 1 - t
        img.setPosition(u * u * start.x + 2 * u * t * mid.x + t * t * to.x, u * u * start.y + 2 * u * t * mid.y + t * t * to.y)
        img.setAngle(Math.sin(t * Math.PI) * 18 * arc)
      },
      onComplete: () => {
        opts.onArrive?.()
        if (!opts.fadeMs) {
          img.destroy()
          return
        }
        // Settles where it landed for a moment, then fades.
        this.tweens.add({ targets: img, alpha: 0, scale: base * 1.5, duration: opts.fadeMs, delay: 220, onComplete: () => img.destroy() })
      }
    })
  }

  private officeWide(): boolean {
    return this.opts.isOfficeWide()
  }

  private insideOwnBranch(entry: RosterEntry, p: Point): boolean {
    const b = this.layout.branch(entry.teamId)
    if (!b) return false
    const r = blockRect(b)
    return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
  }

  /** Acts on an event for an agent whose character exists. */
  private apply(e: AgentEvent): void {
    const id = e.agentId
    const entry = this.roster.get(id)
    const c = this.chars.get(id)
    if (!entry || !c || this.leaving.has(id) || entry.role === 'boss') return
    this.lastEvent.set(id, { activity: e.activity, detail: e.detail })
    // Real work restarts the idle clock; an agent that only says "idle" again stays where it rests.
    if (e.activity !== 'idle') this.idle.touch(id, Date.now())
    else if (this.idle.isResting(id) && !this.waiting.has(id) && !this.relay.isOpen(id)) return

    if (e.activity === 'waiting') {
      this.onWaiting(entry, c, e.detail)
      return
    }
    if (entry.role === 'manager') {
      this.managerEvent(entry, c, e)
      return
    }
    // Worker: its own memo (if any) is answered; it resumes its queue.
    if (this.waiting.delete(id)) {
      c.releaseStay()
      this.updateBadge()
    }
    if (this.relay.isOpen(id)) {
      this.relay.close(id)
      this.syncRelay(entry.teamId)
    }
    if (e.activity === 'done') this.workerDone(entry, c, e.detail)
    else c.enqueue(this.activityAction(entry, c, e.activity, e.detail))
  }

  /** A manager's non-waiting event. While it relays its workers' memos the event is deferred. */
  private managerEvent(entry: RosterEntry, c: Character, e: AgentEvent): void {
    const team = entry.teamId
    if (this.waiting.delete(entry.id)) this.updateBadge()
    this.selfDetail.delete(team)
    if (e.activity === 'done') {
      this.managerDone(entry)
      return
    }
    const action = this.activityAction(entry, c, e.activity, e.detail)
    if (this.relay.deferManagerEvent(team, action)) {
      this.syncRelay(team) // badge / bubble without its own memo
      return
    }
    // Own memo answered and nothing else to carry: the relay (if any) ends, then this runs.
    if (this.relay.isRelaying(team)) this.syncRelay(team, false)
    c.enqueue(action)
  }

  /** Starts / updates / ends the team manager's trip to the HQ inbox with the team's memos. */
  private syncRelay(teamId: string, returnHome = true): void {
    const m = this.roster.teamManager(teamId)
    const mc = m ? this.chars.get(m.id) : undefined
    const present = !!m && !!mc && !this.leaving.has(m.id)
    const step = this.relay.step(teamId, present)
    if (!present || !m || !mc) return
    const count = this.relay.relayCount(teamId)
    if (step === 'start') {
      // Whatever the manager had queued collapses to the latest; it runs after the relay.
      this.idle.touch(m.id, Date.now())
      const dropped = mc.dropQueued((a) => !a.lifecycle)
      if (dropped.length > 0) this.relay.setDeferred(teamId, dropped[dropped.length - 1])
      mc.enqueueFront(this.relayAction(m, mc))
      mc.setBadge(count)
    } else if (step === 'update') {
      mc.setBadge(count)
      if (mc.currentAction?.kind === 'relay') mc.setDetail(this.relayText(teamId))
    } else if (step === 'stop') {
      mc.setBadge(0)
      mc.dropQueued((a) => a.kind === 'relay') // never started: no trip needed
      mc.releaseStay()
      const d = this.relay.takeDeferred(teamId)
      if (d) mc.enqueue(d)
      else if (returnHome) mc.enqueue({ kind: 'return', activity: 'idle', lifecycle: false, target: () => this.goHome(m, mc) })
    }
  }

  private relayText(teamId: string): string {
    const n = this.relay.workerMemos(teamId)
    const own = this.relay.isOpen(teamId) ? this.selfDetail.get(teamId) ?? '' : ''
    const memos = n > 0 ? `${n} ${this.manifest.props.memo}${n === 1 ? '' : 's'}` : ''
    return [memos, own].filter((x) => x.length > 0).join(' · ')
  }

  /** The manager carries the team's memos to the HQ inbox (or the queue outside) and waits there. */
  private relayAction(m: RosterEntry, mc: Character): Action {
    const def = this.router.table('waiting')
    return {
      kind: 'relay',
      activity: 'waiting',
      lifecycle: true,
      stay: true,
      carry: 'memo',
      verb: def.verb,
      anim: def.anim,
      detail: this.relayText(m.teamId),
      target: () => {
        const { point, queued } = this.roster.claimInbox(m.id)
        if (queued) this.queuedAtDoor.add(m.id)
        return this.claimAt(m.id, mc, point, false)
      },
      onDone: () => {
        this.roster.releaseInbox(m.id)
        this.queuedAtDoor.delete(m.id)
        mc.setBadge(0)
      }
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
    this.scopes = new NavScopes(this.layout.bounds(), this.builtBlocks(), rects)
    this.nav = this.scopes.full()
    for (const c of this.chars.values()) c.repath()
  }

  private corridorStyle(): { floor: number; edge: number; seam?: number } {
    const c = this.manifest.corridor
    if (c && typeof c.floor === 'string' && typeof c.edge === 'string') {
      const floor = cssToInt(c.floor, 0xe9e4d8)
      return { floor, edge: cssToInt(c.edge, 0x5c5470), seam: c.seam ? cssToInt(c.seam, floor) : undefined }
    }
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
    const ground = this.manifest.ground
    g.fillStyle(ground?.color ? cssToInt(ground.color, bg) : mix(darken(bg, 0.9), GROUND_TINT, 0.18), 1)
    g.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)
    if (ground?.speckle) {
      // Sparse dots on a jittered grid (the same everywhere: a hash of the cell, no randomness).
      g.fillStyle(cssToInt(ground.speckle, 0xffffff), 1)
      const step = 22
      for (let y = 0; y < bounds.height; y += step) {
        for (let x = 0; x < bounds.width; x += step) {
          const h = Math.imul((x / step) * 73856093 ^ (y / step) * 19349663, 2654435761) >>> 0
          if (h % 3 !== 0) continue
          g.fillCircle(x + (h % 17), y + ((h >>> 8) % 17), 0.9 + ((h >>> 16) % 3) * 0.35)
        }
      }
    }
    g.lineStyle(1, 0xffffff, 0.05)
    for (const f of this.layout.footprintsIn(bounds)) {
      if (taken.some((r) => r.x === f.x && r.y === f.y)) continue
      g.strokeRect(f.x + 0.5, f.y + 0.5, f.width - 1, f.height - 1)
    }
  }

  private findPath(id: string, from: Point, to: Point): Point[] | null {
    return this.navFor(id, from).findPath(from, to)
  }

  /**
   * Where this character may walk: managers = HQ + corridors + own branch; workers = their branch
   * only (the whole world during an office-wide order, or when outside it so they can walk home).
   */
  private navFor(id: string, from: Point): NavGrid {
    const e = this.roster.get(id)
    if (!e || e.role === 'boss') return this.nav
    if (e.role === 'manager') return this.scopes.manager(e.teamId)
    if (this.officeWide()) return this.nav
    return this.insideOwnBranch(e, from) ? this.scopes.branch(e.teamId) : this.nav
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
    view.setSign(m?.displayName ?? blockId, this.teamColor(blockId), m ? this.tintFor(m) : null)
  }

  // ---- construction ------------------------------------------------------------------------

  private isFast(): boolean {
    return this.replaying || performance.now() < this.fastUntil
  }

  /** A team got a lot: plan its corridor now, build it when its turn in the queue comes. */
  private planBranch(block: Block): void {
    this.looks.ensure(block.id) // in arrival order: deterministic colours and heads
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
    this.looks.release(teamId)
    this.relay.dropTeam(teamId)
    this.selfDetail.delete(teamId)
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
    this.labels?.add(view.block, true)
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
    this.labels?.remove(view.block.id)
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
        this.focusedTeam = null
        const before = cam.getWorldPoint(p.x, p.y)
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM))
        const after = cam.getWorldPoint(p.x, p.y)
        cam.scrollX += before.x - after.x
        cam.scrollY += before.y - after.y
      }
    )
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const now = performance.now()
      this.dragging = false
      this.suppressClick = false
      this.downAt = { x: p.x, y: p.y }
      // A double-click on the floor fits the office; clicks on a character only ever select it.
      if (this.charAt(p)) {
        this.lastDown = 0
        return
      }
      if (now - this.lastDown < DOUBLE_CLICK_MS) {
        this.lastDown = 0
        this.suppressClick = true
        this.autoFit = true
        this.focusedTeam = null
        this.fitCamera(true)
        return
      }
      this.lastDown = now
    })
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown) {
        this.updateHover(p)
        return
      }
      if (!this.dragging && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) < 4) return
      if (!this.dragging) {
        this.dragging = true
        this.clearHover()
        this.stopCameraEffects()
        this.autoFit = false
        this.focusedTeam = null
      }
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom
    })
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.dragging) {
        this.dragging = false
        return
      }
      if (this.suppressClick || Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) >= 4) return
      // A click: on a character it selects that agent, on the floor it deselects.
      this.opts.onAgentClick?.(this.charAt(p)?.id ?? null)
      this.updateHover(p)
    })
    this.input.on('gameout', () => this.clearHover())
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  private spawn(entry: RosterEntry): void {
    const door = this.roster.entranceOf(entry.id)
    const c = this.makeCharacter(entry, door)
    c.setCompact(this.compact)
    this.chars.set(entry.id, c)
    this.idle.touch(entry.id, Date.now())
    if (entry.id === this.selectedId) c.setHighlight('selected')
    c.enqueue({
      kind: 'spawn',
      lifecycle: true,
      target: () => this.goHome(entry, c)
    })

    if (entry.role === 'worker' && entry.managerId) {
      const boss = this.roster.get(entry.managerId)
      const m = this.chars.get(entry.managerId)
      if (boss && m && !this.leaving.has(boss.id)) {
        this.idle.touch(boss.id, Date.now())
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

  private onWaiting(entry: RosterEntry, c: Character, rawDetail: string): void {
    if (entry.role === 'boss') return
    // A rule may give a waiting event its own verb ("Asking"); where it waits never changes.
    const route = this.router.route('waiting', rawDetail)
    const detail = route.detail
    if (this.waiting.has(entry.id)) {
      if (entry.role === 'manager') {
        this.selfDetail.set(entry.teamId, detail)
        if (c.currentAction?.kind === 'relay') c.setDetail(this.relayText(entry.teamId))
      } else c.setDetail(detail)
      return
    }
    this.waiting.add(entry.id)
    this.updateBadge()
    if (entry.role === 'manager') {
      // A manager's own permission request: it goes to the HQ inbox (with any team memos).
      this.selfDetail.set(entry.teamId, detail)
      this.relay.open(entry.id, entry.teamId, 'self')
      this.syncRelay(entry.teamId)
      if (c.currentAction?.kind === 'relay') c.setDetail(this.relayText(entry.teamId))
      return
    }
    // A worker: memo to its manager's office (straight to the HQ during an office-wide order).
    this.relay.open(entry.id, entry.teamId, this.officeWide() ? 'hq' : 'manager')
    const def = route.def
    c.enqueue({
      kind: 'waiting',
      activity: 'waiting',
      lifecycle: true,
      stay: true,
      carry: 'memo',
      verb: def.verb,
      anim: def.anim,
      detail,
      target: () => {
        if (this.relay.route(entry.id) === 'hq') {
          const { point, queued } = this.roster.claimInbox(entry.id)
          if (queued) this.queuedAtDoor.add(entry.id)
          return this.claimAt(entry.id, c, point, false)
        }
        const spot = this.roster.claimMemoSpot(entry.id) ?? this.roster.managerHome(entry.id) ?? entry.home
        return this.claimAt(entry.id, c, spot, false)
      },
      onArrive: () => {
        // The memo is on the manager's desk: the manager takes it to the HQ.
        if (this.relay.route(entry.id) !== 'manager') return
        this.relay.deliver(entry.id)
        this.syncRelay(entry.teamId)
      },
      onDone: () => {
        this.roster.releaseInbox(entry.id)
        this.roster.releaseMemoSpot(entry.id)
        this.queuedAtDoor.delete(entry.id)
      }
    })
  }

  private workerDone(entry: RosterEntry, c: Character, detail: string): void {
    this.leaving.add(entry.id)
    const route = this.router.route('done', detail)
    const def = route.def
    const loc = def.location === HOME ? MANAGER : def.location
    c.enqueue({
      kind: 'done',
      activity: 'done',
      lifecycle: true,
      carry: 'report',
      verb: def.verb,
      anim: def.anim,
      detail: route.detail || this.manifest.props.report,
      target: (from) => this.resolve(entry, c, loc, from)
    })
    this.queueLeave(entry, c)
  }

  private managerDone(entry: RosterEntry): void {
    if (entry.role === 'boss') return
    this.relay.dropTeam(entry.teamId)
    this.selfDetail.delete(entry.teamId)
    this.chars.get(entry.id)?.setBadge(0)
    for (const w of this.roster.teamWorkers(entry.teamId)) this.sendAway(w)
    this.sendAway(entry)
  }

  /** Drop whatever they were doing and walk out. */
  private sendAway(entry: RosterEntry): void {
    const c = this.chars.get(entry.id)
    if (!c) return
    this.leaving.add(entry.id)
    if (this.waiting.delete(entry.id)) this.updateBadge()
    this.relay.close(entry.id)
    this.roster.releaseInbox(entry.id)
    this.roster.releaseMemoSpot(entry.id)
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
    const teamId = this.roster.get(id)?.teamId
    if (this.relay.isOpen(id)) {
      this.relay.close(id)
      if (teamId) this.syncRelay(teamId)
    }
    this.stations.release(id)
    this.idle.forget(id)
    this.lastEvent.delete(id)
    if (this.hoverId === id) this.setHoverChar(null)
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

  /** The first matching stationRule decides where (and how it reads), else the activities table. */
  private activityAction(entry: RosterEntry, c: Character, a: Activity, detail: string): Action {
    const { def, detail: shown } = this.router.route(a, detail)
    return {
      kind: 'activity',
      activity: a,
      lifecycle: false,
      verb: def.verb,
      anim: def.anim,
      detail: shown,
      target: (from) => this.resolve(entry, c, def.location, from)
    }
  }

  /**
   * HOME -> own seat/desk; MANAGER -> manager's seat (own for a manager); the waiting type -> HQ
   * for managers; anything else -> nearest of that type in the character's branch (managers: then
   * the HQ), else home. Workers never resolve outside their branch unless an office-wide order runs.
   */
  private resolve(entry: RosterEntry, c: Character, loc: string, from: Point): Point {
    if (loc === HOME) return this.goHome(entry, c)
    if (loc === MANAGER) {
      const base = this.roster.managerHome(entry.id) ?? entry.home
      return this.claimAt(entry.id, c, base, base === entry.home)
    }
    const wide = entry.role === 'worker' && this.officeWide()
    const p =
      loc === this.waitingType && (entry.role !== 'worker' || wide)
        ? nearest(this.layout.hq.locations, loc, from)
        : this.roster.station(entry.id, loc, from, wide ? this.builtBlocks() : null)
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
      findPath: (from, to) => this.findPath(entry.id, from, to),
      teamColor: entry.role === 'boss' ? undefined : this.teamColor(entry.teamId) ?? undefined,
      seatAt: (p) => this.seatAt(p),
      facingAt: (p) => this.facingAt(p)
    })
  }

  /** Which way a character standing here looks (a location with `facing`, or a spot next to one). */
  private facingAt(p: Point): 'north' | 'south' | 'east' | 'west' | null {
    const blocks = this.layout.all()
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const x = p.x - b.offset.x
      const y = p.y - b.offset.y
      if (x < -32 || y < -32 || x > b.width + 32 || y > b.height + 32) continue
      // Characters sharing a spot stand up to two places to its side (see offsetFor in roster.ts).
      for (const f of b.template.facings) if (Math.abs(f.x - x) <= 25 && Math.abs(f.y - y) <= 13) return f.facing
    }
    return null
  }

  /** The seat at exactly this spot (a map location with `seat`), if any. */
  private seatAt(p: Point): 'north' | 'south' | null {
    const blocks = this.layout.all()
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const x = p.x - b.offset.x
      const y = p.y - b.offset.y
      if (x < 0 || y < 0 || x > b.width || y > b.height) continue
      for (const seat of b.template.seats) if (Math.abs(seat.x - x) < 1 && Math.abs(seat.y - y) < 1) return seat.facing
    }
    return null
  }

  /** After a while with nothing to do, wander back home. */
  private driftHome(id: string, c: Character): void {
    if (id === BOSS_ID || c.atHome) return
    this.time.delayedCall(DRIFT_HOME_MS, () => {
      const entry = this.roster.get(id)
      if (!entry || this.chars.get(id) !== c || !c.isIdle || c.atHome || this.leaving.has(id) || this.idle.isResting(id)) return
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
    return fromSheet || placeholderSkin(this, role, roleDef.placeholder, toneIndex(entry.id), this.lookFor(entry))
  }

  /** Team colour of a branch (null for the HQ / unknown). */
  private teamColor(teamId: string): number | null {
    if (teamId === BOSS_ID || !this.layout?.branch(teamId)) return null
    return cssToInt(this.palette[this.looks.ensure(teamId).color], 0xffffff)
  }

  private teamColorCss(teamId: string): string {
    return this.palette[this.looks.ensure(teamId).color] ?? '#ffffff'
  }

  /** Managers: distinct head + team-colour clipboard and collar. Workers: team collar + badge. */
  private lookFor(entry: RosterEntry): PlaceholderLook {
    const color = this.teamColor(entry.teamId)
    if (color === null) return {}
    if (entry.role === 'manager') return { head: this.looks.ensure(entry.teamId).head, accent: color, collar: color }
    return { collar: color }
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
        color: this.teamColorCss(b.id),
        providerColor:
          this.manifest.providers[this.providerKey(m)]?.tint ?? this.manifest.providers.default?.tint ?? '#bab0ac',
        workers: this.roster.teamWorkers(b.id).length,
        live: !!this.roster.get(b.id) && !this.leaving.has(b.id)
      })
    }
    this.opts.onTeams(teams)
  }
}
