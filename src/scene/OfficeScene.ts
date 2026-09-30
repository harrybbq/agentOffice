// The generic, theme-driven scene (named for the default theme). Knows only the required
// location types, HOME/MANAGER and the lifecycle conventions from shared/events.ts.
import Phaser from 'phaser'
import type { Activity, AgentEvent } from '../../shared/events'
import { activityDef, HOME, MANAGER } from '../../shared/theme'
import type { ActivityDef, Role, ThemeManifest } from '../../shared/theme'
import type { LoadedTheme } from '../../shared/ipc'
import { cssToInt, drawMap, preloadMap } from '../theme/loader'
import type { ParsedMap } from '../theme/loader'
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
  map: ParsedMap
  onReady: () => void
  onTeams: (teams: TeamInfo[]) => void
}

const DRIFT_HOME_MS = 4000
/** Late events for an agent that already left are ignored for this long. */
const DEPARTED_GRACE_MS = 30_000

export class OfficeScene extends Phaser.Scene {
  private opts: SceneOptions
  private manifest: ThemeManifest
  private roster!: Roster
  private stations = new Stations()
  private chars = new Map<string, Character>()
  private waiting = new Set<string>()
  private leaving = new Set<string>()
  private departed = new Map<string, number>()
  private waitingType = 'inbox'

  constructor(opts: SceneOptions) {
    super({ key: 'office' })
    this.opts = opts
    this.manifest = opts.theme.manifest
  }

  preload(): void {
    this.load.on('loaderror', (file: Phaser.Loader.File) =>
      console.warn(`[agent-office] failed to load ${file.key} (${String(file.url)})`)
    )
    preloadMap(this, this.opts.map, this.opts.theme.baseUrl)
    preloadSheets(this, this.manifest, this.opts.theme.baseUrl)
  }

  create(): void {
    const { map } = this.opts
    drawMap(this, map)
    ensureProps(this)
    createSheetAnims(this, this.manifest)

    const w = this.manifest.activities?.waiting ? activityDef(this.manifest, 'waiting').location : ''
    this.waitingType = map.locations.get(w)?.length ? w : 'inbox'
    this.roster = new Roster(
      map.locations,
      { provider: 'human', displayName: this.manifest.roles.boss.label },
      this.waitingType
    )
    const boss = this.roster.get(BOSS_ID)!
    const pos = this.stations.claim(BOSS_ID, boss.home)
    this.chars.set(BOSS_ID, this.makeCharacter(boss, pos))

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const c of this.chars.values()) c.destroy()
      this.chars.clear()
    })
    this.opts.onReady()
  }

  update(_time: number, delta: number): void {
    for (const c of this.chars.values()) c.tick(delta)
  }

  // ---- events ------------------------------------------------------------------------------

  handleEvent(e: AgentEvent): void {
    if (!this.roster) return
    const id = e.agentId
    if (this.leaving.has(id)) return
    if (this.recentlyDeparted(id)) return
    // A child of someone who is leaving would re-hire them; ignore it.
    if (e.parentId && (this.leaving.has(e.parentId) || this.recentlyDeparted(e.parentId))) return

    const { created, upgraded } = this.roster.ensure(e)
    for (const entry of created) this.spawn(entry)
    if (upgraded) {
      const c = this.chars.get(upgraded.id)
      c?.setName(upgraded.displayName)
      c?.setTint(this.tintFor(upgraded))
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

  private recentlyDeparted(id: string): boolean {
    const gone = this.departed.get(id)
    if (gone === undefined) return false
    if (Date.now() - gone < DEPARTED_GRACE_MS) return true
    this.departed.delete(id)
    return false
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  private spawn(entry: RosterEntry): void {
    const home = entry.home
    const door = nearest(this.opts.map.locations, 'entrance', home) ?? home
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
      target: (from) => {
        const slot =
          this.roster.claimInbox(entry.id) ?? nearest(this.opts.map.locations, this.waitingType, from)
        return slot ? this.claimAt(entry.id, c, slot, false) : this.goHome(entry, c)
      },
      onDone: () => this.roster.releaseInbox(entry.id)
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
        return nearest(this.opts.map.locations, 'entrance', from)
      },
      onArrive: () => this.despawn(entry.id)
    })
  }

  private despawn(id: string): void {
    const c = this.chars.get(id)
    this.stations.release(id)
    this.roster.remove(id)
    this.leaving.delete(id)
    this.departed.set(id, Date.now())
    if (this.waiting.delete(id)) this.updateBadge()
    this.chars.delete(id)
    c?.fadeOutAndDestroy(() => undefined)
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

  /** HOME -> own seat/desk; MANAGER -> manager's seat (own for a manager); else nearest of type. */
  private resolve(entry: RosterEntry, c: Character, loc: string, from: Point): Point {
    if (loc === HOME) return this.goHome(entry, c)
    if (loc === MANAGER) {
      const base = this.roster.managerHome(entry.id) ?? entry.home
      return this.claimAt(entry.id, c, base, base === entry.home)
    }
    const p = nearest(this.opts.map.locations, loc, from)
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
      onIdle: (c) => this.driftHome(entry.id, c)
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

  private emitTeams(): void {
    const teams = this.roster.managers().map((m) => ({
      id: m.id,
      name: m.displayName,
      provider: m.provider,
      color: this.manifest.providers[this.providerKey(m)]?.tint ?? this.manifest.providers.default?.tint ?? '#bab0ac',
      workers: this.roster.teamWorkers(m.id).length
    }))
    this.opts.onTeams(teams)
  }
}
