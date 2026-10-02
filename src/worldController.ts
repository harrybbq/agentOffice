// Owns the Phaser world: theme loading, game lifecycle (rebuilt on theme / overlay change), the
// scene-independent agent record and office-wide mode. The React shell talks to it through this
// small imperative API and never touches Phaser directly.
import Phaser from 'phaser'
import type { AgentEvent } from '../shared/events'
import type { AgentOfficeBridge, LoadedTheme, RendererSettings } from '../shared/ipc'
import type { ThemeManifest } from '../shared/theme'
import { parseMap, ThemeError, validateTheme } from './theme/loader'
import { OfficeScene } from './scene/OfficeScene'
import type { TeamInfo } from './scene/OfficeScene'
import type { SignBarState } from './scene/signBars'
import { AgentStore } from './agents'
import { OfficeWide } from './officeWide'

export type { TeamInfo }

export interface WorldCallbacks {
  /** One row per branch, whenever the roster changes. */
  onTeams(teams: TeamInfo[]): void
  onThemeName(name: string): void
  /** A readable problem (bad theme, ...) or null once it is gone. */
  onError(message: string | null): void
  /** When office-wide mode ends at the latest, or null when it is off. */
  onOfficeWide(endsAt: number | null): void
  /** The loaded theme's manifest (verbs and station names for the inspector), or null while none is. */
  onTheme?(manifest: ThemeManifest | null): void
  /** A character was clicked in the world (its agent id), or the floor (null). */
  onAgentClick?(agentId: string | null): void
}

export class WorldController {
  readonly agents = new AgentStore()
  private officeWide = new OfficeWide()
  private game: Phaser.Game | null = null
  private scene: OfficeScene | null = null
  private host: HTMLElement | null = null
  /** Layer over the canvas for the station tags and the hover card. */
  private overlayEl: HTMLElement | null = null
  private selectedAgent: string | null = null
  private labelsOn = true
  /** The progress bars under the branch signs (kept here so a rebuilt scene shows them again). */
  private progress: ReadonlyMap<string, SignBarState> = new Map()
  private observer: ResizeObserver | null = null
  private generation = 0
  private settings: RendererSettings | null = null
  private bridge: AgentOfficeBridge | null = null
  private timer = 0

  constructor(private cb: WorldCallbacks) {}

  /** Attaches the world to its container. The game is (re)built once settings are known. */
  mount(host: HTMLElement, overlay: HTMLElement | null = null): void {
    if (this.host === host) return
    this.unmount()
    this.host = host
    this.overlayEl = overlay
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.timer = window.setInterval(() => {
      if (this.officeWide.check()) this.syncOfficeWide()
    }, 1000)
    if (this.settings && this.bridge) void this.build()
  }

  unmount(): void {
    this.generation++
    this.observer?.disconnect()
    this.observer = null
    window.clearInterval(this.timer)
    this.game?.destroy(true)
    this.game = null
    this.scene = null
    this.host = null
    this.overlayEl = null
  }

  /** Applies settings; rebuilds the game only when the theme or overlay mode changed. */
  applySettings(s: RendererSettings, bridge: AgentOfficeBridge): void {
    const prev = this.settings
    this.settings = s
    this.bridge = bridge
    if (s.officeWideTimeoutMs > 0) this.officeWide.timeoutMs = s.officeWideTimeoutMs
    if (!prev || prev.theme !== s.theme || prev.overlay !== s.overlay) void this.build()
  }

  handleEvent(e: AgentEvent): void {
    this.agents.apply(e)
    this.scene?.handleEvent(e)
    if (this.officeWide.observe(e)) this.syncOfficeWide()
  }

  focusTeam(teamId: string): void {
    this.scene?.focusTeam(teamId)
  }

  fitAll(): void {
    this.scene?.fitAll()
  }

  /** The agent the inspector shows: its character gets a ring that follows it (null: nobody). */
  setSelectedAgent(agentId: string | null): void {
    this.selectedAgent = agentId
    this.scene?.setSelectedAgent(agentId)
  }

  /** Brings an agent's branch into view. */
  focusAgent(agentId: string): void {
    this.scene?.focusAgent(agentId)
  }

  /** A small picture of an agent's character (a data URL), or null when there is none. */
  portrait(agentId: string): Promise<string | null> {
    const scene = this.scene
    if (!scene) return Promise.resolve(null)
    return new Promise((resolve) => {
      // The snapshot arrives with the next frame; a hidden window renders none, so don't wait forever.
      const timer = window.setTimeout(() => resolve(null), 1500)
      scene.portrait(agentId, (url) => {
        window.clearTimeout(timer)
        resolve(url)
      })
    })
  }

  /** The progress bars under the branch signs, by team id (see ui/progress.ts signBars). */
  setProgress(states: ReadonlyMap<string, SignBarState>): void {
    this.progress = states
    this.scene?.setProgress(states)
  }

  /** The station tags on or off. */
  setLabels(on: boolean): void {
    this.labelsOn = on
    this.scene?.setLabels(on)
  }

  /** The CEO says it: speech bubble plus an order envelope to each target manager. */
  speak(targets: 'all' | readonly string[], text: string): void {
    this.scene?.showOrder(targets, text)
  }

  /**
   * A team put a note on the office board: a small note travels from its manager to the HQ, or to
   * the manager of the team a hand-over is meant for. Nothing happens if either is not in the world.
   */
  showNote(fromTeam: string, toTeam: string | null, kind: 'note' | 'handover' = 'note'): void {
    this.scene?.showNote(fromTeam, toTeam, kind)
  }

  /** Office-wide mode on (tracking the teams that got the order; null = until timeout) or off. */
  setOfficeWide(on: boolean, teams: string[] | null = null): void {
    if (on) this.officeWide.start(teams)
    else if (this.officeWide.active) this.officeWide.end()
    else return
    this.syncOfficeWide()
  }

  /** Dev handle: lets workers roam without a real order. */
  devOfficeWide(on: boolean, timeoutMs?: number): boolean {
    if (on && typeof timeoutMs === 'number' && timeoutMs > 0) this.officeWide.timeoutMs = timeoutMs
    this.setOfficeWide(on, null)
    return this.officeWide.active
  }

  devScene(): OfficeScene | null {
    return this.scene
  }

  private syncOfficeWide(): void {
    this.scene?.setOfficeWide(this.officeWide.active)
    this.cb.onOfficeWide(this.officeWide.active ? Date.now() + this.officeWide.remainingMs() : null)
  }

  /** Keeps the canvas the size of its container (Phaser itself only polls every 500 ms). */
  private resize(): void {
    const scale = this.game?.scale
    if (!scale || !this.host) return
    if (this.host.clientWidth < 2 || this.host.clientHeight < 2) return
    if (scale.getParentBounds()) scale.refresh()
  }

  private async build(): Promise<void> {
    const s = this.settings
    const bridge = this.bridge
    const host = this.host
    if (!s || !bridge || !host) return
    const gen = ++this.generation
    this.game?.destroy(true)
    this.game = null
    this.scene = null

    let theme: LoadedTheme
    try {
      theme = await bridge.loadTheme(s.theme)
    } catch (err) {
      this.cb.onError(`Couldn't load theme "${s.theme}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (gen !== this.generation) return

    let hq, branch
    try {
      hq = parseMap(theme.hq, theme.manifest.hq ?? 'HQ map')
      branch = parseMap(theme.branch, theme.manifest.branch ?? 'Branch map')
      for (const w of validateTheme(theme.manifest, hq, branch)) console.warn(`[agent-office] ${w}`)
    } catch (err) {
      this.cb.onError(err instanceof ThemeError ? err.message : `Invalid theme: ${String(err)}`)
      return
    }
    this.cb.onError(null)
    this.cb.onThemeName(theme.manifest.displayName)
    this.cb.onTheme?.(theme.manifest)

    const sc = new OfficeScene({
      theme,
      hq,
      branch,
      overlay: s.overlay,
      onTeams: (teams) => {
        if (gen === this.generation) this.cb.onTeams(teams)
      },
      isOfficeWide: () => this.officeWide.active,
      overlayEl: this.overlayEl,
      labels: this.labelsOn,
      agentSince: (id) => this.agents.since(id),
      onAgentClick: (id) => {
        if (gen === this.generation) this.cb.onAgentClick?.(id)
      },
      onReady: () => {
        if (gen !== this.generation) return
        this.scene = sc
        sc.setSelectedAgent(this.selectedAgent)
        sc.setProgress(this.progress)
        // Rebuild the roster from what we already know; characters walk in again.
        sc.replay(this.agents.replay())
      }
    })

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      width: Math.max(2, host.clientWidth),
      height: Math.max(2, host.clientHeight),
      pixelArt: true,
      roundPixels: true,
      transparent: s.overlay,
      backgroundColor: s.overlay ? undefined : theme.manifest.background,
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
      // The shell owns the keyboard (terminal, order bar, shortcuts); the scene only uses the mouse.
      input: { keyboard: false },
      banner: false,
      scene: [sc]
    })
  }
}
