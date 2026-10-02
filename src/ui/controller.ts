// The shell's state and actions. One AppController per window: it subscribes to the bridge
// (sessions, permissions, settings, events), owns the world controller and the terminals, and
// exposes actions to the React components.
import { createContext, useContext } from 'react'
import type { AgentEvent } from '../../shared/events'
import type { AgentOfficeBridge, RendererSettings } from '../../shared/ipc'
import type { OrderResult } from '../../shared/orders'
import type {
  PermissionDecision,
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderInfo,
  SessionInfo,
  StartSessionRequest
} from '../../shared/sessions'
import type { WaitingInfo } from '../agents'
import { WorldController } from '../worldController'
import type { TeamInfo } from '../worldController'
import { appendLog, cleanError, orderSummary, orderTargets, pushRecent, retainExited, sessionOrder, vanished } from './format'
import type { LogEntry, OrderSummary } from './format'
import { Store, useStore } from './store'
import { TerminalManager } from './terminals'
import type { UiTheme } from './terminals'

export type Dock = 'auto' | 'right' | 'bottom'
export type PanelTab = 'terminal' | 'events'

export interface Layout {
  panelOpen: boolean
  dock: Dock
  sizeRight: number
  sizeBottom: number
  tab: PanelTab
  inboxOpen: boolean
  uiTheme: UiTheme
}

export const DEFAULT_LAYOUT: Layout = {
  panelOpen: true,
  dock: 'auto',
  sizeRight: 600,
  sizeBottom: 340,
  tab: 'terminal',
  inboxOpen: true,
  uiTheme: 'dark'
}

/** A request that just left the pending list, shown briefly with what happened to it. */
export interface ResolvedPermission {
  req: PermissionRequestInfo
  outcome: PermissionOutcome
  at: number
}

export interface OrderFeedback extends OrderSummary {
  key: number
}

export interface AppState {
  connection: 'connecting' | 'connected' | 'stub' | 'limited'
  settings: RendererSettings | null
  themeName: string
  worldError: string | null
  providers: ProviderInfo[]
  sessions: SessionInfo[]
  permissions: PermissionRequestInfo[]
  /** Ids being answered right now (buttons disabled). */
  deciding: ReadonlySet<string>
  resolved: ResolvedPermission[]
  teams: TeamInfo[]
  waiting: WaitingInfo[]
  log: LogEntry[]
  eventCount: number
  lastEventAt: number | null
  selectedId: string | null
  officeWideEndsAt: number | null
  banner: { text: string; key: number } | null
  orderFeedback: OrderFeedback | null
  sending: boolean
  dialog: 'new-session' | null
  layout: Layout
  recentFolders: string[]
}

const LAYOUT_KEY = 'agentOffice.layout'
const RECENT_KEY = 'agentOffice.recentFolders'
/** Survives a reload and the window swap of an overlay toggle, so the terminal comes back. */
const SELECTED_KEY = 'agentOffice.selected'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: preferences just don't persist */
  }
}

function loadLayout(): Layout {
  const raw = readJson<Partial<Layout>>(LAYOUT_KEY, {})
  const l = { ...DEFAULT_LAYOUT, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!['auto', 'right', 'bottom'].includes(l.dock)) l.dock = 'auto'
  if (l.tab !== 'terminal' && l.tab !== 'events') l.tab = 'terminal'
  if (l.uiTheme !== 'dark' && l.uiTheme !== 'light') l.uiTheme = 'dark'
  if (!Number.isFinite(l.sizeRight)) l.sizeRight = DEFAULT_LAYOUT.sizeRight
  if (!Number.isFinite(l.sizeBottom)) l.sizeBottom = DEFAULT_LAYOUT.sizeBottom
  return l
}

const GHOST_MS: Record<PermissionOutcome, number> = {
  allowed: 1600,
  denied: 1600,
  'resolved-elsewhere': 5000,
  'unknown-request': 5000
}

export class AppController {
  readonly store: Store<AppState>
  readonly world: WorldController
  readonly terminals: TerminalManager
  private pendingLog: LogEntry[] = []
  private logTimer = 0
  private seq = 0
  private keySeq = 0
  /** Exited sessions the user removed from the list (the contract has no remove call). */
  private dismissed = new Set<string>()
  private decidedHere = new Set<string>()
  private bannerTimer = 0
  private feedbackTimer = 0
  /** Set by the order bar so shortcuts can focus it. */
  focusOrderBar: () => void = () => undefined
  focusInbox: () => void = () => undefined

  constructor(
    readonly bridge: AgentOfficeBridge,
    connection: AppState['connection']
  ) {
    const recent = readJson<unknown>(RECENT_KEY, [])
    this.store = new Store<AppState>({
      connection,
      settings: null,
      themeName: '',
      worldError: null,
      providers: [],
      sessions: [],
      permissions: [],
      deciding: new Set(),
      resolved: [],
      teams: [],
      waiting: [],
      log: [],
      eventCount: 0,
      lastEventAt: null,
      selectedId: null,
      officeWideEndsAt: null,
      banner: null,
      orderFeedback: null,
      sending: false,
      dialog: null,
      layout: loadLayout(),
      recentFolders: Array.isArray(recent) ? recent.filter((x): x is string => typeof x === 'string') : []
    })
    this.world = new WorldController({
      onTeams: (teams) => this.store.set({ teams }),
      onThemeName: (themeName) => this.store.set({ themeName }),
      onError: (worldError) => this.store.set({ worldError }),
      onOfficeWide: (officeWideEndsAt) => this.store.set({ officeWideEndsAt })
    })
    this.terminals = new TerminalManager(bridge)
    this.terminals.setTheme(this.store.get().layout.uiTheme)
    document.documentElement.dataset.uiTheme = this.store.get().layout.uiTheme
  }

  async boot(): Promise<void> {
    const b = this.bridge
    b.onEvent((e) => this.onEvent(e))
    b.onSettings((s) => this.applySettings(s))
    // A pushed list is newer than the initial list() answer still in flight.
    let pushedSessions = false
    let pushedPermissions = false
    b.sessions.onChanged((list) => {
      pushedSessions = true
      this.setSessions(list)
    })
    b.permissions.onChanged((list) => {
      pushedPermissions = true
      this.setPermissions(list)
    })

    try {
      this.applySettings(await b.getSettings())
    } catch (err) {
      this.store.set({ worldError: `Couldn't read settings: ${String(err)}` })
    }
    const [providers, sessions, permissions] = await Promise.all([
      b.sessions.providers().catch(() => [] as ProviderInfo[]),
      b.sessions.list().catch(() => [] as SessionInfo[]),
      b.permissions.list().catch(() => [] as PermissionRequestInfo[])
    ])
    this.store.set({ providers })
    if (!pushedSessions) this.setSessions(sessions)
    if (!pushedPermissions) this.setPermissions(permissions)
    const last = readJson<unknown>(SELECTED_KEY, null)
    const state = this.store.get()
    if (typeof last === 'string' && !state.selectedId && state.sessions.some((s) => s.id === last)) {
      this.select(last, { reveal: false })
    }
  }

  // ---- bridge -> state ---------------------------------------------------------------------

  private applySettings(s: RendererSettings): void {
    this.store.set({ settings: s })
    document.body.classList.toggle('overlay', s.overlay)
    this.world.applySettings(s, this.bridge)
  }

  private onEvent(e: AgentEvent): void {
    const teamId = this.world.agents.rootOf(e)
    this.world.handleEvent(e)
    this.pendingLog.push({ seq: ++this.seq, teamId, event: e })
    // A timer, not rAF: events keep arriving while the window is hidden in the tray.
    if (!this.logTimer) this.logTimer = window.setTimeout(() => this.flushLog(), 120)
  }

  private flushLog(): void {
    this.logTimer = 0
    const add = this.pendingLog
    this.pendingLog = []
    const agents = this.world.agents
    this.store.set((s) => ({
      log: appendLog(s.log, add),
      eventCount: agents.eventCount,
      lastEventAt: agents.lastEventAt,
      waiting: agents.waiting
    }))
  }

  private setSessions(list: SessionInfo[]): void {
    const present = new Set(list.map((s) => s.id))
    for (const id of [...this.dismissed]) if (!present.has(id)) this.dismissed.delete(id)
    const sessions = retainExited(this.store.get().sessions, list, (id) => this.terminals.has(id)).filter(
      (s) => !this.dismissed.has(s.id)
    )
    this.terminals.prune(new Set(sessions.map((s) => s.id)))
    this.store.set({ sessions })
  }

  private setPermissions(next: PermissionRequestInfo[]): void {
    const prev = this.store.get().permissions
    for (const req of vanished(prev, next, this.decidedHere)) this.addResolved(req, 'resolved-elsewhere')
    const known = new Set(prev.map((p) => p.id))
    const fresh = next.some((p) => !known.has(p.id))
    this.store.set((s) => ({
      permissions: next,
      layout: fresh && !s.layout.inboxOpen ? { ...s.layout, inboxOpen: true } : s.layout
    }))
  }

  private addResolved(req: PermissionRequestInfo, outcome: PermissionOutcome): void {
    const entry: ResolvedPermission = { req, outcome, at: Date.now() }
    this.store.set((s) => ({ resolved: [...s.resolved.filter((r) => r.req.id !== req.id), entry] }))
    window.setTimeout(
      () => this.store.set((s) => ({ resolved: s.resolved.filter((r) => r !== entry) })),
      GHOST_MS[outcome]
    )
  }

  // ---- actions -----------------------------------------------------------------------------

  /** Selects a session or world team: focuses its branch and (for hosted sessions) its terminal. */
  select(id: string | null, opts: { focusTerminal?: boolean; reveal?: boolean } = {}): void {
    const s = this.store.get()
    const hosted = !!id && s.sessions.some((x) => x.id === id)
    const patch: Partial<AppState> = { selectedId: id }
    if (id && (opts.reveal ?? true) && hosted) patch.layout = { ...s.layout, panelOpen: true, tab: 'terminal' }
    this.store.set(patch)
    writeJson(SELECTED_KEY, id)
    if (patch.layout) this.saveLayout()
    if (id) this.world.focusTeam(id)
    if (hosted && opts.focusTerminal) window.setTimeout(() => this.terminals.focus(), 80)
  }

  selectByIndex(index: number): void {
    const s = this.store.get()
    const target = sessionOrder(s.providers, s.sessions)[index]
    if (target) this.select(target.id, { focusTerminal: true })
  }

  openNewSession(): void {
    this.store.set({ dialog: 'new-session' })
    // Providers can change (CLI installed since launch).
    void this.bridge.sessions
      .providers()
      .then((providers) => this.store.set({ providers }))
      .catch(() => undefined)
  }

  closeDialog(): void {
    this.store.set({ dialog: null })
  }

  pickFolder(): Promise<string | null> {
    return this.bridge.sessions.pickFolder()
  }

  /** Rejects with a readable message; the dialog shows it inline. */
  async startSession(req: StartSessionRequest): Promise<void> {
    const info = await this.bridge.sessions.start(req)
    const recentFolders = pushRecent(this.store.get().recentFolders, req.cwd)
    writeJson(RECENT_KEY, recentFolders)
    this.store.set((s) => ({
      recentFolders,
      dialog: null,
      sessions: s.sessions.some((x) => x.id === info.id) ? s.sessions : [...s.sessions, info]
    }))
    this.select(info.id, { focusTerminal: true })
  }

  interrupt(id: string): void {
    void this.bridge.sessions.interrupt(id).catch((err) => console.warn('[agent-office] interrupt failed', err))
  }

  stop(id: string): void {
    void this.bridge.sessions.stop(id).catch((err) => console.warn('[agent-office] stop failed', err))
  }

  /** Removes an exited session from the list and frees its terminal. */
  removeSession(id: string): void {
    this.dismissed.add(id)
    // For the main process, stopping an already exited session forgets it.
    void this.bridge.sessions.stop(id).catch(() => undefined)
    this.terminals.dispose(id)
    this.store.set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId
    }))
  }

  async decide(req: PermissionRequestInfo, decision: PermissionDecision): Promise<void> {
    if (this.store.get().deciding.has(req.id)) return
    this.decidedHere.add(req.id)
    this.store.set((s) => ({ deciding: new Set([...s.deciding, req.id]) }))
    let outcome: PermissionOutcome
    try {
      outcome = await this.bridge.permissions.decide(req.id, decision)
    } catch (err) {
      console.warn('[agent-office] decide failed', err)
      outcome = 'unknown-request'
    }
    this.addResolved(req, outcome)
    window.setTimeout(() => this.decidedHere.delete(req.id), 10_000)
    this.store.set((s) => {
      const deciding = new Set(s.deciding)
      deciding.delete(req.id)
      // Hide the card right away; the next onChanged confirms it.
      return { deciding, permissions: s.permissions.filter((p) => p.id !== req.id) }
    })
  }

  /** The CEO speaks (bubble, envelopes, PA banner), then the order is sent. */
  async sendOrder(target: string, text: string): Promise<OrderResult> {
    const s = this.store.get()
    const options = orderTargets(s.providers, s.sessions, s.teams)
    const opt = options.find((o) => o.value === target)
    this.world.speak(target === 'all' ? 'all' : (opt?.ids ?? [target]), text)
    if (opt && opt.group !== 'session') this.showBanner(opt.group === 'everyone' ? 'all staff' : opt.label.replace(/^All /, 'all '), text)
    this.store.set({ sending: true })
    let res: OrderResult
    try {
      res = await this.bridge.sendOrder({ target, text })
    } catch (err) {
      res = { delivered: [], failed: [{ agentId: target, reason: cleanError(err) }] }
    } finally {
      this.store.set({ sending: false })
    }
    if (target === 'all' && res.delivered.length > 0) this.world.setOfficeWide(true, res.delivered)
    const now = this.store.get()
    const nameOf = (id: string) =>
      now.sessions.find((x) => x.id === id)?.title ?? now.teams.find((t) => t.id === id)?.name ?? id.slice(0, 8)
    const feedback: OrderFeedback = { ...orderSummary(res, nameOf), key: ++this.keySeq }
    this.store.set({ orderFeedback: feedback })
    window.clearTimeout(this.feedbackTimer)
    this.feedbackTimer = window.setTimeout(
      () => this.store.set((st) => (st.orderFeedback === feedback ? { orderFeedback: null } : {})),
      feedback.ok ? 6000 : 12_000
    )
    return res
  }

  dismissOrderFeedback(): void {
    this.store.set({ orderFeedback: null })
  }

  private showBanner(audience: string, text: string): void {
    this.store.set({ banner: { text: `CEO to ${audience}: ${text}`, key: ++this.keySeq } })
    window.clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => this.store.set({ banner: null }), 5000)
  }

  endOfficeWide(): void {
    this.world.setOfficeWide(false)
  }

  /** `persist: false` while dragging a splitter; call again with {} to save. */
  setLayout(patch: Partial<Layout>, persist = true): void {
    this.store.set((s) => ({ layout: { ...s.layout, ...patch } }))
    if (patch.uiTheme) {
      document.documentElement.dataset.uiTheme = patch.uiTheme
      this.terminals.setTheme(patch.uiTheme)
    }
    if (persist) this.saveLayout()
  }

  togglePanel(): void {
    this.setLayout({ panelOpen: !this.store.get().layout.panelOpen })
  }

  private saveLayout(): void {
    writeJson(LAYOUT_KEY, this.store.get().layout)
  }
}

export const AppContext = createContext<AppController | null>(null)

export function useApp(): AppController {
  const app = useContext(AppContext)
  if (!app) throw new Error('AppContext missing')
  return app
}

export function useAppState<S>(selector: (s: AppState) => S): S {
  return useStore(useApp().store, selector)
}
