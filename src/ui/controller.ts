// The shell's state and actions. One AppController per window: it subscribes to the bridge
// (sessions, permissions, settings, events), owns the world controller and the terminals, and
// exposes actions to the React components.
import { createContext, useContext } from 'react'
import type { BoardSettings, BoardSnapshot } from '../../shared/board'
import type { AgentEvent } from '../../shared/events'
import type { AgentOfficeBridge, RendererSettings } from '../../shared/ipc'
import type { OrderResult } from '../../shared/orders'
import type {
  PermissionDecision,
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderId,
  ProviderInfo,
  SessionHistoryEntry,
  SessionInfo,
  StartSessionRequest
} from '../../shared/sessions'
import type { WaitingInfo } from '../agents'
import { WorldController } from '../worldController'
import type { TeamInfo } from '../worldController'
import { findOverlaps, newNotes, noteTarget, removalKey, removalReducer } from './board'
import type { RemoveKind } from './board'
import { ChatManager } from './chats'
import { appendLog, cleanError, orderSummary, orderTargets, pushRecent, retainExited, sessionOrder, vanished } from './format'
import type { LogEntry, OrderSummary } from './format'
import { Store, useStore } from './store'
import { TerminalManager } from './terminals'
import type { UiTheme } from './terminals'

export type Dock = 'auto' | 'right' | 'bottom'
export type PanelTab = 'terminal' | 'events' | 'board'

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
  sizeBottom: 420,
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
  /** Providers whose login was started here and has not finished yet. */
  loggingIn: ReadonlySet<ProviderId>
  loginError: { provider: ProviderId; text: string } | null
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
  /** Every session id this window has seen hosted (never listed as an observed team). */
  everHosted: ReadonlySet<string>
  officeWideEndsAt: number | null
  banner: { text: string; key: number } | null
  orderFeedback: OrderFeedback | null
  sending: boolean
  dialog: 'new-session' | null
  layout: Layout
  recentFolders: string[]
  /** The office board as the main process last sent it; null until it arrives (or without a board). */
  board: BoardSnapshot | null
  boardSettings: BoardSettings | null
  /** Claims / notes the user deleted that the main process has not confirmed yet (removalKey). */
  boardRemoving: ReadonlySet<string>
  /** Files more than one team touched (the amber badge on the Board tab and in the status bar). */
  boardOverlaps: number
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
  if (l.tab !== 'terminal' && l.tab !== 'events' && l.tab !== 'board') l.tab = 'terminal'
  if (l.uiTheme !== 'dark' && l.uiTheme !== 'light') l.uiTheme = 'dark'
  if (!Number.isFinite(l.sizeRight)) l.sizeRight = DEFAULT_LAYOUT.sizeRight
  if (!Number.isFinite(l.sizeBottom)) l.sizeBottom = DEFAULT_LAYOUT.sizeBottom
  return l
}

/** The same set when nothing is new, so subscribers don't re-render. */
function withIds(set: ReadonlySet<string>, items: readonly { id: string }[]): ReadonlySet<string> {
  return items.every((x) => set.has(x.id)) ? set : new Set([...set, ...items.map((x) => x.id)])
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
  readonly chats: ChatManager
  private pendingLog: LogEntry[] = []
  private logTimer = 0
  private seq = 0
  private keySeq = 0
  /** Exited sessions the user removed from the list (the contract has no remove call). */
  private dismissed = new Set<string>()
  private decidedHere = new Set<string>()
  private waitingKey = ''
  private bannerTimer = 0
  private feedbackTimer = 0
  /** Note ids already seen on the board; null until the first snapshot (which is not news). */
  private seenNotes: Set<string> | null = null
  /** Set by the order bar so shortcuts can focus it. */
  focusOrderBar: () => void = () => undefined
  focusInbox: () => void = () => undefined
  /** Set by the chat composer. */
  focusChat: (draft?: string) => void = () => undefined

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
      loggingIn: new Set(),
      loginError: null,
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
      everHosted: new Set(),
      officeWideEndsAt: null,
      banner: null,
      orderFeedback: null,
      sending: false,
      dialog: null,
      layout: loadLayout(),
      recentFolders: Array.isArray(recent) ? recent.filter((x): x is string => typeof x === 'string') : [],
      board: null,
      boardSettings: null,
      boardRemoving: new Set(),
      boardOverlaps: 0
    })
    this.world = new WorldController({
      onTeams: (teams) => this.store.set({ teams }),
      onThemeName: (themeName) => this.store.set({ themeName }),
      onError: (worldError) => this.store.set({ worldError }),
      onOfficeWide: (officeWideEndsAt) => this.store.set({ officeWideEndsAt })
    })
    this.terminals = new TerminalManager(bridge)
    this.chats = new ChatManager(bridge)
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
    let pushedProviders = false
    b.sessions.onProvidersChanged((list) => {
      pushedProviders = true
      this.setProviders(list)
    })
    b.sessions.onChanged((list) => {
      pushedSessions = true
      this.setSessions(list)
    })
    b.permissions.onChanged((list) => {
      pushedPermissions = true
      this.setPermissions(list)
    })

    // The office board (a main process from before it has none: the tab stays hidden).
    let pushedBoard = false
    if (this.hasBoard) {
      b.board.onChanged((snapshot) => {
        pushedBoard = true
        this.setBoard(snapshot)
      })
    }

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
    if (!pushedProviders) this.setProviders(providers)
    if (!pushedSessions) this.setSessions(sessions)
    if (!pushedPermissions) this.setPermissions(permissions)
    if (this.hasBoard) {
      void b.board
        .get()
        .then((got) => {
          if (got?.settings) this.store.set({ boardSettings: got.settings })
          if (!pushedBoard && got?.snapshot) this.setBoard(got.snapshot)
        })
        .catch((err) => console.warn('[agent-office] could not read the office board', err))
    }
    const last = readJson<unknown>(SELECTED_KEY, null)
    const state = this.store.get()
    if (typeof last === 'string' && !state.selectedId && state.sessions.some((s) => s.id === last)) {
      this.select(last, { reveal: false, focusWorld: false })
    }
  }

  // ---- bridge -> state ---------------------------------------------------------------------

  private applySettings(s: RendererSettings): void {
    this.store.set({ settings: s })
    document.body.classList.toggle('overlay', s.overlay)
    this.terminals.setWindowsBuild(s.windowsBuild)
    this.world.applySettings(s, this.bridge)
  }

  private onEvent(e: AgentEvent): void {
    const teamId = this.world.agents.rootOf(e)
    this.world.handleEvent(e)
    // The inbox must not show a stale "waiting" entry next to a permission list that already moved on.
    const waitingKey = this.world.agents.waiting.map((w) => `${w.agentId}\n${w.detail}`).join('\n\n')
    if (waitingKey !== this.waitingKey) {
      this.waitingKey = waitingKey
      this.store.set({ waiting: this.world.agents.waiting })
    }
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

  /** Login state and usage arrive here; a finished login clears its "signing in" note. */
  private setProviders(providers: ProviderInfo[]): void {
    this.store.set((s) => {
      const done = providers.filter((p) => p.account?.loggedIn && s.loggingIn.has(p.id)).map((p) => p.id)
      return {
        providers,
        loggingIn: done.length > 0 ? new Set([...s.loggingIn].filter((id) => !done.includes(id))) : s.loggingIn,
        loginError: s.loginError && done.includes(s.loginError.provider) ? null : s.loginError
      }
    })
  }

  private setSessions(list: SessionInfo[]): void {
    const present = new Set(list.map((s) => s.id))
    for (const id of [...this.dismissed]) if (!present.has(id)) this.dismissed.delete(id)
    const sessions = retainExited(this.store.get().sessions, list, (id) => this.terminals.has(id) || this.chats.has(id)).filter(
      (s) => !this.dismissed.has(s.id)
    )
    const live = new Set(sessions.map((s) => s.id))
    this.terminals.prune(live)
    this.chats.prune(live)
    this.store.set((s) => ({ sessions, everHosted: withIds(s.everHosted, sessions) }))
  }

  private setPermissions(next: PermissionRequestInfo[]): void {
    const prev = this.store.get().permissions
    for (const req of vanished(prev, next, this.decidedHere)) {
      this.addResolved(req, 'resolved-elsewhere')
      // The same request's card in the chat (the main process's own item update overrides this).
      this.chats.resolveApproval(req.id, 'resolved-elsewhere')
    }
    const known = new Set(prev.map((p) => p.id))
    // A request of the chat session on screen shows as a card in that chat: no need to open the
    // inbox over it. Anything else new opens the inbox.
    const s0 = this.store.get()
    const onScreen = s0.layout.panelOpen && s0.layout.tab === 'terminal' && s0.sessions.find((x) => x.id === s0.selectedId)?.surface === 'chat' ? s0.selectedId : null
    const fresh = next.some((p) => !known.has(p.id) && p.sessionId !== onScreen)
    this.store.set((s) => ({
      permissions: next,
      layout: fresh && !s.layout.inboxOpen ? { ...s.layout, inboxOpen: true } : s.layout
    }))
  }

  /** A new board snapshot: store it, and show notes that were not there before in the world. */
  private setBoard(snapshot: BoardSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.branches) || !Array.isArray(snapshot.notes)) return
    for (const note of newNotes(this.seenNotes, snapshot.notes, Date.now())) {
      this.world.showNote(note.sessionId, noteTarget(note, snapshot.branches), note.kind)
    }
    // Ids are never reused; keep the old ones too so a note can't be announced twice.
    const seen = this.seenNotes && this.seenNotes.size < 2000 ? this.seenNotes : new Set<string>()
    for (const n of snapshot.notes) seen.add(n.id)
    this.seenNotes = seen
    this.store.set((s) => ({
      board: snapshot,
      boardRemoving: removalReducer(s.boardRemoving, { type: 'snapshot', snapshot }),
      boardOverlaps: findOverlaps(snapshot.branches).length
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
  select(id: string | null, opts: { focusTerminal?: boolean; reveal?: boolean; focusWorld?: boolean } = {}): void {
    const s = this.store.get()
    const session = id ? s.sessions.find((x) => x.id === id) : undefined
    const hosted = !!session
    const patch: Partial<AppState> = { selectedId: id }
    if (id && (opts.reveal ?? true) && hosted) patch.layout = { ...s.layout, panelOpen: true, tab: 'terminal' }
    this.store.set(patch)
    writeJson(SELECTED_KEY, id)
    if (patch.layout) this.saveLayout()
    if (id && (opts.focusWorld ?? true)) this.world.focusTeam(id)
    if (session && opts.focusTerminal) {
      window.setTimeout(() => (session.surface === 'chat' ? this.focusChat() : this.terminals.focus()), 80)
    }
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
      .then((providers) => this.setProviders(providers))
      .catch(() => undefined)
  }

  /** Starts the provider's own sign-in (system browser). The result arrives via onProvidersChanged. */
  async login(provider: ProviderId): Promise<void> {
    if (this.store.get().loggingIn.has(provider)) return
    this.store.set((s) => ({ loggingIn: new Set([...s.loggingIn, provider]), loginError: null }))
    try {
      await this.bridge.sessions.login(provider)
      // Already signed in: nothing will be pushed, so ask once.
      this.setProviders(await this.bridge.sessions.providers())
    } catch (err) {
      this.store.set((s) => ({
        loggingIn: new Set([...s.loggingIn].filter((id) => id !== provider)),
        loginError: { provider, text: cleanError(err) }
      }))
    }
  }

  /** Does this main process have an office board? (An older preload has none.) */
  get hasBoard(): boolean {
    const board = (this.bridge as Partial<AgentOfficeBridge>).board
    return !!board && typeof board.get === 'function' && typeof board.onChanged === 'function'
  }

  /** Opens the panel on the Board tab (the overlap badges). */
  openBoard(): void {
    if (this.hasBoard) this.setLayout({ panelOpen: true, tab: 'board' })
  }

  /**
   * The user deletes a claim or note: it disappears at once and comes back if the main process
   * refuses (false) or the call fails. The next snapshot confirms it.
   */
  async removeBoardItem(kind: RemoveKind, id: string): Promise<void> {
    if (!this.hasBoard) return
    const key = removalKey(kind, id)
    if (this.store.get().boardRemoving.has(key)) return
    this.store.set((s) => ({ boardRemoving: removalReducer(s.boardRemoving, { type: 'remove', key }) }))
    let ok = false
    try {
      ok = (await this.bridge.board.remove(kind, id)) === true
    } catch (err) {
      console.warn('[agent-office] could not remove the board item', err)
    }
    if (!ok) this.store.set((s) => ({ boardRemoving: removalReducer(s.boardRemoving, { type: 'rollback', key }) }))
  }

  /** The board switch and the conflict mode. Shown at once, put back if the main process refuses. */
  async setBoardSettings(patch: Partial<BoardSettings>): Promise<void> {
    const prev = this.store.get().boardSettings
    if (!this.hasBoard || !prev) return
    const optimistic = { ...prev, ...patch }
    this.store.set({ boardSettings: optimistic })
    try {
      const next = await this.bridge.board.setSettings(patch)
      // Only if nothing newer was chosen meanwhile.
      if (next && this.store.get().boardSettings === optimistic) this.store.set({ boardSettings: next })
    } catch (err) {
      console.warn('[agent-office] could not change the board settings', err)
      if (this.store.get().boardSettings === optimistic) this.store.set({ boardSettings: prev })
    }
  }

  /** The "Allow CEO orders" switch. The main process pushes the new settings (onSettings) as well. */
  async setAllowOrders(on: boolean): Promise<void> {
    if (typeof this.bridge.setAllowOrders !== 'function') return
    try {
      this.applySettings(await this.bridge.setAllowOrders(on))
    } catch (err) {
      console.warn('[agent-office] could not change the orders setting', err)
    }
  }

  /** Is there an in-app Quit (a preload that has it)? */
  get canQuit(): boolean {
    return typeof this.bridge.quit === 'function'
  }

  /** Quits the app; hosted sessions are stopped. */
  quit(): void {
    if (typeof this.bridge.quit === 'function') void this.bridge.quit().catch(() => undefined)
  }

  closeDialog(): void {
    this.store.set({ dialog: null })
  }

  pickFolder(): Promise<string | null> {
    return this.bridge.sessions.pickFolder()
  }

  /** Earlier conversations of a provider in a folder (newest first). Rejects with a readable message. */
  async history(provider: ProviderId, cwd: string): Promise<SessionHistoryEntry[]> {
    // An older preload has no history: the dialog then simply offers nothing to resume.
    if (typeof this.bridge.sessions.history !== 'function') return []
    const list = await this.bridge.sessions.history(provider, cwd)
    return Array.isArray(list) ? list : []
  }

  /** Rejects with a readable message; the dialog shows it inline. */
  async startSession(req: StartSessionRequest): Promise<void> {
    const info = await this.bridge.sessions.start(req)
    const recentFolders = pushRecent(this.store.get().recentFolders, req.cwd)
    writeJson(RECENT_KEY, recentFolders)
    this.store.set((s) => ({
      recentFolders,
      dialog: null,
      everHosted: withIds(s.everHosted, [info]),
      sessions: s.sessions.some((x) => x.id === info.id) ? s.sessions : [...s.sessions, info]
    }))
    // The world keeps its whole-office view: the new branch is built next to the HQ, and its
    // manager's walks to the CEO stay in sight.
    this.select(info.id, { focusTerminal: true, focusWorld: false })
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
    this.chats.dispose(id)
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
    this.chats.resolveApproval(req.id, outcome === 'unknown-request' ? 'resolved-elsewhere' : outcome)
    window.setTimeout(() => this.decidedHere.delete(req.id), 10_000)
    this.store.set((s) => {
      const deciding = new Set(s.deciding)
      deciding.delete(req.id)
      // Hide the card right away; the next onChanged confirms it.
      return { deciding, permissions: s.permissions.filter((p) => p.id !== req.id) }
    })
  }

  /** Stops waiting for a sign-in that was started here (the browser tab may have been closed). */
  cancelLogin(provider: ProviderId): void {
    this.store.set((s) => ({ loggingIn: new Set([...s.loggingIn].filter((id) => id !== provider)) }))
  }

  /**
   * Allow / Deny from an approval card in the chat: the same request the inbox shows, so both go
   * through decide(). `fallback` describes the request when it is not in the pending list (any more).
   */
  decideById(requestId: string, decision: PermissionDecision, fallback: Omit<PermissionRequestInfo, 'id'>): Promise<void> {
    const req = this.store.get().permissions.find((p) => p.id === requestId) ?? { ...fallback, id: requestId }
    return this.decide(req, decision)
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
