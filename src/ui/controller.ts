// The shell's state and actions. One AppController per window: it subscribes to the bridge
// (sessions, permissions, settings, events), owns the world controller and the terminals, and
// exposes actions to the React components.
import { createContext, useContext } from 'react'
import type { BoardSettings, BoardSnapshot } from '../../shared/board'
import type { AgentEvent } from '../../shared/events'
import type { AgentDetails } from '../../shared/inspector'
import type { ThemeManifest } from '../../shared/theme'
import type { AgentOfficeBridge, RendererSettings } from '../../shared/ipc'
import type { OrderResult } from '../../shared/orders'
import type { RestoreSettings } from '../../shared/restore'
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
import { approvalsBridge, isApprovalMode, pushHandled, toggleMute, wantsAttention } from './approvals'
import type { ApprovalMode, AutoAllowed } from './approvals'
import { EMPTY_RECENT, recentReducer, restoreSelection, restoreSummary } from './restore'
import type { RecentState, RestoreSummary } from './restore'
import { Store, useStore } from './store'
import { TerminalManager } from './terminals'
import type { UiTheme } from './terminals'

export type Dock = 'auto' | 'right' | 'bottom'
export type PanelTab = 'terminal' | 'inspect' | 'events' | 'board'
const PANEL_TABS: readonly PanelTab[] = ['terminal', 'inspect', 'events', 'board']

export interface Layout {
  panelOpen: boolean
  dock: Dock
  sizeRight: number
  sizeBottom: number
  tab: PanelTab
  inboxOpen: boolean
  uiTheme: UiTheme
  /** The sidebar's Recent section (collapsed by default). */
  recentOpen: boolean
  /** The floating station tags in the world. */
  labels: boolean
  /** The inbox's "Handled for you" list (collapsed by default). */
  handledOpen: boolean
}

export const DEFAULT_LAYOUT: Layout = {
  panelOpen: true,
  dock: 'auto',
  sizeRight: 600,
  sizeBottom: 420,
  tab: 'terminal',
  inboxOpen: true,
  uiTheme: 'dark',
  recentOpen: false,
  labels: true,
  handledOpen: false
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

  // ---- restore: sessions survive closing the app (shared/restore.ts) ----
  /** Asleep rows being woken right now. */
  waking: ReadonlySet<string>
  /** Why the last wake of a row failed (shown on its wake screen). */
  wakeErrors: Readonly<Record<string, string>>
  /** Sessions that ended earlier and can be reopened. */
  recent: RecentState
  recentStatus: 'idle' | 'loading' | 'ready' | 'error'
  recentError: string | null
  /** Recent entries being reopened right now. */
  reopening: ReadonlySet<string>
  recentActionError: { id: string; text: string } | null
  /** What happens to saved sessions when the app opens; null until read (or without restore). */
  restoreSettings: RestoreSettings | null
  /** The one-time "3 sessions restored · 2 were interrupted" notice of this launch. */
  restoreNotice: RestoreSummary | null

  // ---- the agent inspector (shared/inspector.ts) ----
  /** The loaded world theme: its verbs and station names word what an agent is doing. */
  theme: ThemeManifest | null
  /** The agent the inspector shows (a manager = its session id, or a worker); its character has the ring. */
  agentId: string | null
  /** What the main process last said about that agent; null while loading or when it knows nothing. */
  agentDetails: AgentDetails | null
  agentStatus: 'none' | 'loading' | 'ready' | 'unknown'

  // ---- approvals: what the app allowed without asking ----
  /** Routine requests allowed automatically, newest first (the inbox's "Handled for you"). */
  handled: AutoAllowed[]
}

const LAYOUT_KEY = 'agentOffice.layout'
const RECENT_KEY = 'agentOffice.recentFolders'
/** Survives a reload and the window swap of an overlay toggle, so the terminal comes back. */
const SELECTED_KEY = 'agentOffice.selected'
/** closedAt of the last restore summary shown: once per close, also across an overlay window swap. */
const RESTORE_SEEN_KEY = 'agentOffice.restoreSeen'
/** The approval mode to go back to when the inbox is unmuted. */
const UNMUTED_MODE_KEY = 'agentOffice.unmutedMode'

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
  if (!PANEL_TABS.includes(l.tab)) l.tab = 'terminal'
  l.labels = l.labels !== false
  l.handledOpen = l.handledOpen === true
  if (l.uiTheme !== 'dark' && l.uiTheme !== 'light') l.uiTheme = 'dark'
  l.recentOpen = l.recentOpen === true
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

/** What "Tell it to continue" sends: a bare "continue" made Claude ask what to do next. */
export const CONTINUE_TEXT = 'Continue with what you were doing before the app closed. Re-run anything that was interrupted.'

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
  /** "Was interrupted" notes the user dismissed that the main process has not confirmed yet. */
  private notesDismissed = new Set<string>()
  private recentGen = 0
  private decidedHere = new Set<string>()
  private waitingKey = ''
  private bannerTimer = 0
  private feedbackTimer = 0
  /** Note ids already seen on the board; null until the first snapshot (which is not news). */
  private seenNotes: Set<string> | null = null
  /** The agent the main process is pushing details for right now (one watch at a time). */
  private watching: string | null = null
  /** Set by the order bar so shortcuts can focus it. */
  focusOrderBar: () => void = () => undefined
  /** Opens the inbox; with an agent id, on that agent's request. */
  focusInbox: (agentId?: string) => void = () => undefined
  /** Set by the chat composer. */
  focusChat: (draft?: string) => void = () => undefined
  /** Set by the wake screen (an asleep row has no terminal or chat to focus). */
  focusWake: () => void = () => undefined

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
      boardOverlaps: 0,
      waking: new Set(),
      wakeErrors: {},
      recent: EMPTY_RECENT,
      recentStatus: 'idle',
      recentError: null,
      reopening: new Set(),
      recentActionError: null,
      restoreSettings: null,
      restoreNotice: null,
      theme: null,
      agentId: null,
      agentDetails: null,
      agentStatus: 'none',
      handled: []
    })
    this.world = new WorldController({
      onTeams: (teams) => this.store.set({ teams }),
      onThemeName: (themeName) => this.store.set({ themeName }),
      onError: (worldError) => this.store.set({ worldError }),
      onOfficeWide: (officeWideEndsAt) => this.store.set({ officeWideEndsAt }),
      onTheme: (theme) => this.store.set({ theme }),
      onAgentClick: (agentId) => this.onWorldClick(agentId)
    })
    this.world.setLabels(this.store.get().layout.labels)
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
      // The switches changed in the main process (the tray, or this panel): follow.
      b.board.onSettingsChanged?.((settings) => this.store.set({ boardSettings: settings }))
    }

    // The inspector: details of the watched agent, pushed about once a second.
    if (this.hasInspector) {
      b.inspector.onChanged((details) => {
        if (details && details.agentId === this.watching && this.store.get().agentId === details.agentId) {
          this.store.set({ agentDetails: details, agentStatus: 'ready' })
        }
      })
    }

    // Requests the app allowed without asking ("important only" mode): a quiet audit trail.
    const approvals = approvalsBridge(b)
    let pushedAuto = false
    approvals.onAuto?.((entry) => {
      pushedAuto = true
      this.store.set((s) => ({ handled: pushHandled(s.handled, [entry]) }))
    })
    void approvals
      .recentAuto?.()
      .then((list) => {
        if (Array.isArray(list)) this.store.set((s) => ({ handled: pushHandled(pushedAuto ? s.handled : [], list) }))
      })
      .catch((err) => console.warn('[agent-office] could not read the handled requests', err))

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
    await this.bootRestore()
  }

  /**
   * Where the user left off: the saved settings, the Recent list, the selection of last time and
   * the one-time summary of what was restored (and what was interrupted).
   */
  private async bootRestore(): Promise<void> {
    const api = this.bridge.sessions
    if (this.hasRestore) {
      void api
        .getRestoreSettings()
        .then((rs) => {
          if (rs && typeof rs.mode === 'string' && this.store.get().restoreSettings === null) this.store.set({ restoreSettings: rs })
        })
        .catch((err) => console.warn('[agent-office] could not read the restore settings', err))
      void this.refreshRecent()
    }
    // The main process knows what was selected when the app closed; this window's own memory
    // covers a reload and the window swap of an overlay toggle.
    let saved: unknown = readJson<unknown>(SELECTED_KEY, null)
    const known = (id: unknown) => typeof id === 'string' && this.store.get().sessions.some((s) => s.id === id)
    if (!known(saved) && typeof api.getSelected === 'function') {
      saved = await api.getSelected().catch(() => null)
    }
    const state = this.store.get()
    const ordered = sessionOrder(state.providers, state.sessions)
    if (!state.selectedId) {
      const pick = restoreSelection(saved, ordered)
      if (pick) this.select(pick, { reveal: false, focusWorld: false })
    }
    const summary = restoreSummary(ordered)
    if (summary && readJson<unknown>(RESTORE_SEEN_KEY, 0) !== summary.closedAt) {
      writeJson(RESTORE_SEEN_KEY, summary.closedAt)
      this.store.set({ restoreNotice: summary })
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
    // A dismissed note is gone here at once; the main process's list confirms it a moment later.
    for (const id of [...this.notesDismissed]) if (!list.some((s) => s.id === id && s.interruptedNote)) this.notesDismissed.delete(id)
    const sessions = retainExited(this.store.get().sessions, list, (id) => this.terminals.has(id) || this.chats.has(id))
      .filter((s) => !this.dismissed.has(s.id))
      .map((s) => (s.interruptedNote && this.notesDismissed.has(s.id) ? { ...s, interruptedNote: undefined } : s))
    // An asleep row has no process: nothing may stay attached to it (a failed wake goes back to
    // asleep, and the next wake must attach from scratch).
    const live = new Set(sessions.filter((s) => s.state !== 'asleep').map((s) => s.id))
    this.terminals.prune(live)
    this.chats.prune(live)
    this.store.set((s) => {
      const gone = Object.keys(s.wakeErrors).filter((id) => !sessions.some((x) => x.id === id && x.state === 'asleep'))
      const patch: Partial<AppState> = { sessions, everHosted: withIds(s.everHosted, sessions) }
      if (gone.length > 0) patch.wakeErrors = Object.fromEntries(Object.entries(s.wakeErrors).filter(([id]) => !gone.includes(id)))
      return patch
    })
  }

  private setPermissions(next: PermissionRequestInfo[]): void {
    const prev = this.store.get().permissions
    // Muted: what leaves the list without an answer from here was allowed for the user (a dangerous
    // request is never allowed that way, so it was answered in the terminal).
    const muted = this.approvalMode === 'auto'
    for (const req of vanished(prev, next, this.decidedHere)) {
      const outcome: PermissionOutcome = muted && req.risk !== 'danger' ? 'allowed' : 'resolved-elsewhere'
      this.addResolved(req, outcome)
      // The same request's card in the chat (the main process's own item update overrides this).
      this.chats.resolveApproval(req.id, outcome === 'allowed' ? 'allowed' : 'resolved-elsewhere')
    }
    const known = new Set(prev.map((p) => p.id))
    // A request of the chat session on screen shows as a card in that chat: no need to open the
    // inbox over it. Anything else new opens the inbox.
    const s0 = this.store.get()
    const onScreen = s0.layout.panelOpen && s0.layout.tab === 'terminal' && s0.sessions.find((x) => x.id === s0.selectedId)?.surface === 'chat' ? s0.selectedId : null
    // Muted: only a dangerous request opens it (everything else was allowed for the user).
    const mode = this.approvalMode
    const fresh = next.some((p) => !known.has(p.id) && p.sessionId !== onScreen && wantsAttention(mode, p.risk))
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
  select(id: string | null, opts: { focusTerminal?: boolean; reveal?: boolean; focusWorld?: boolean; inspect?: boolean } = {}): void {
    const s = this.store.get()
    const session = id ? s.sessions.find((x) => x.id === id) : undefined
    const hosted = !!session
    const patch: Partial<AppState> = { selectedId: id }
    if (id && (opts.reveal ?? true) && hosted) patch.layout = { ...s.layout, panelOpen: true, tab: 'terminal' }
    this.store.set(patch)
    writeJson(SELECTED_KEY, id)
    // The main process remembers it for the next launch. Looking at a team the app only observes
    // (or at nothing) does not forget which session was selected last.
    if (hosted && s.selectedId !== id) this.tellSelected(id)
    if (patch.layout) this.saveLayout()
    if (id && (opts.focusWorld ?? true)) this.world.focusTeam(id)
    // A session's manager is the agent the inspector shows (the tab is not opened by this).
    if (opts.inspect ?? true) this.inspectAgent(id)
    if (session && opts.focusTerminal) {
      window.setTimeout(() => {
        // Read the state again: a row that was asleep a moment ago may be starting now.
        const now = this.store.get().sessions.find((x) => x.id === id) ?? session
        if (now.state === 'asleep') this.focusWake()
        else if (now.surface === 'chat') this.focusChat()
        else this.terminals.focus()
      }, 80)
    }
  }

  private tellSelected(id: string | null): void {
    try {
      // An older preload has no setSelected.
      ;(this.bridge.sessions as Partial<AgentOfficeBridge['sessions']>).setSelected?.(id)
    } catch (err) {
      console.warn('[agent-office] could not save the selection', err)
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

  // ---- the agent inspector ----------------------------------------------------------------------

  /** Does this main process keep agent details? (An older preload has no inspector.) */
  get hasInspector(): boolean {
    const api = (this.bridge as Partial<AgentOfficeBridge>).inspector
    return !!api && typeof api.watch === 'function' && typeof api.onChanged === 'function'
  }

  /**
   * Picks the agent the inspector shows (null: nobody). Its character gets the ring; `reveal` also
   * opens the panel on the Inspect tab, `focusWorld` brings its branch into view.
   */
  inspectAgent(agentId: string | null, opts: { reveal?: boolean; focusWorld?: boolean } = {}): void {
    const s = this.store.get()
    if (s.agentId !== agentId) {
      this.store.set({ agentId, agentDetails: null, agentStatus: agentId ? 'loading' : 'none' })
    }
    this.world.setSelectedAgent(agentId)
    if (agentId && opts.focusWorld) this.world.focusAgent(agentId)
    if (agentId && opts.reveal && this.hasInspector) this.setLayout({ panelOpen: true, tab: 'inspect' })
    else this.syncWatch()
  }

  /** A click in the world: a character selects that agent (and its session), the floor deselects. */
  private onWorldClick(agentId: string | null): void {
    if (!agentId) {
      this.inspectAgent(null)
      return
    }
    const last = this.world.agents.last(agentId)
    const teamId = last ? this.world.agents.rootOf(last) : agentId
    // The session follows, but its terminal is not brought up: the click asked about the agent.
    if (this.store.get().selectedId !== teamId) this.select(teamId, { reveal: false, focusWorld: false, inspect: false })
    this.inspectAgent(agentId, { reveal: true })
  }

  /**
   * One watch at a time, and only while the Inspect tab is on screen: the main process pushes the
   * watched agent's details about once a second.
   */
  private syncWatch(): void {
    const s = this.store.get()
    const want = this.hasInspector && s.layout.panelOpen && s.layout.tab === 'inspect' ? s.agentId : null
    if (want === this.watching) return
    const api = this.bridge.inspector
    if (this.watching) {
      try {
        api.unwatch()
      } catch (err) {
        console.warn('[agent-office] unwatch failed', err)
      }
    }
    this.watching = want
    if (!want) return
    api
      .watch(want)
      .then((details) => {
        if (this.watching !== want || this.store.get().agentId !== want) return
        this.store.set(details ? { agentDetails: details, agentStatus: 'ready' } : { agentDetails: null, agentStatus: 'unknown' })
      })
      .catch((err) => {
        console.warn('[agent-office] could not read the agent details', err)
        if (this.watching === want && this.store.get().agentId === want) this.store.set({ agentStatus: 'unknown' })
      })
  }

  // ---- approvals: ask about everything, or only about what matters ------------------------------

  /** Does this main process have the "important only" mode? (An older one asks about everything.) */
  get hasApprovalMode(): boolean {
    return typeof approvalsBridge(this.bridge).setApprovalMode === 'function' && isApprovalMode(this.approvalMode)
  }

  /** The mode in force, or null when the main process has none. */
  get approvalMode(): ApprovalMode | null {
    const mode = (this.store.get().settings as { approvalMode?: unknown } | null)?.approvalMode
    return isApprovalMode(mode) ? mode : null
  }

  /** Shown at once, put back if the main process refuses. */
  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    const prev = this.store.get().settings
    const api = approvalsBridge(this.bridge)
    if (!prev || typeof api.setApprovalMode !== 'function') return
    const optimistic = { ...prev, approvalMode: mode } as RendererSettings
    this.store.set({ settings: optimistic })
    try {
      const next = await api.setApprovalMode(mode)
      // The main process pushes the new settings too (onSettings); a returned copy is applied at once.
      if (next && typeof next === 'object' && typeof (next as RendererSettings).theme === 'string') this.applySettings(next as RendererSettings)
    } catch (err) {
      console.warn('[agent-office] could not change the approval mode', err)
      if (this.store.get().settings === optimistic) this.store.set({ settings: prev })
    }
  }

  /** The inbox's mute button: mute remembers the mode that was active, unmute goes back to it. */
  async toggleMute(): Promise<void> {
    const current = this.approvalMode
    if (!current || !this.hasApprovalMode) return
    const { next, remember } = toggleMute(current, readJson<unknown>(UNMUTED_MODE_KEY, null))
    writeJson(UNMUTED_MODE_KEY, remember)
    await this.setApprovalMode(next)
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

  /**
   * Removes an exited or asleep session from the list and frees its terminal. The main process
   * keeps its record: it moves to Recent, from where it can be reopened.
   */
  removeSession(id: string): void {
    this.dismissed.add(id)
    // For the main process, stopping a session without a process takes it out of the list.
    void this.bridge.sessions
      .stop(id)
      .catch(() => undefined)
      .then(() => this.refreshRecent())
    this.terminals.dispose(id)
    this.chats.dispose(id)
    const wasSelected = this.store.get().selectedId === id
    this.store.set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId
    }))
    if (wasSelected) {
      writeJson(SELECTED_KEY, null)
      this.tellSelected(null)
    }
    if (this.store.get().agentId === id) this.inspectAgent(null)
  }

  // ---- restore: sessions survive closing the app -----------------------------------------------

  /** Does this main process save sessions? (An older preload has no wake.) */
  get hasRestore(): boolean {
    const api = this.bridge.sessions as Partial<AgentOfficeBridge['sessions']>
    return typeof api.wake === 'function' && typeof api.recent === 'function'
  }

  /** Puts a SessionInfo the main process returned into the list (in place, or at the end). */
  private mergeSession(info: SessionInfo): void {
    if (!info || typeof info.id !== 'string') return
    this.dismissed.delete(info.id)
    this.store.set((s) => ({
      everHosted: withIds(s.everHosted, [info]),
      sessions: s.sessions.some((x) => x.id === info.id) ? s.sessions.map((x) => (x.id === info.id ? info : x)) : [...s.sessions, info]
    }))
  }

  /**
   * Wakes an asleep row: the provider conversation is resumed under the same id, so the row keeps
   * its place and its terminal or chat appears as soon as the state leaves 'asleep'. A failure is
   * kept in `wakeErrors` and shown on the wake screen.
   */
  async wake(id: string): Promise<boolean> {
    const s0 = this.store.get()
    const row = s0.sessions.find((x) => x.id === id)
    if (!this.hasRestore || !row || row.state !== 'asleep' || row.wakeable === false || s0.waking.has(id)) return false
    this.store.set((s) => ({
      waking: new Set([...s.waking, id]),
      wakeErrors: Object.fromEntries(Object.entries(s.wakeErrors).filter(([k]) => k !== id))
    }))
    const done = (patch: Partial<AppState> = {}) =>
      this.store.set((s) => ({ ...patch, waking: new Set([...s.waking].filter((x) => x !== id)) }))
    try {
      const info = await this.bridge.sessions.wake(id)
      // A pushed list may already be newer than this answer: only replace a row that is still asleep.
      if (this.store.get().sessions.find((x) => x.id === id)?.state === 'asleep') this.mergeSession(info)
      done()
      if (this.store.get().selectedId === id) this.select(id, { focusTerminal: true, focusWorld: false })
      return true
    } catch (err) {
      done({ wakeErrors: { ...this.store.get().wakeErrors, [id]: cleanError(err) } })
      return false
    }
  }

  /** Hides a session's "was interrupted" note: at once here, and for good in the main process. */
  async dismissInterrupted(id: string): Promise<void> {
    const note = this.store.get().sessions.find((x) => x.id === id)?.interruptedNote
    if (!note) return
    this.notesDismissed.add(id)
    this.store.set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, interruptedNote: undefined } : x)) }))
    try {
      if (this.hasRestore) await this.bridge.sessions.dismissInterrupted(id)
    } catch (err) {
      console.warn('[agent-office] could not dismiss the note', err)
      // Put it back: it would return with the next list anyway.
      this.notesDismissed.delete(id)
      this.store.set((s) => ({ sessions: s.sessions.map((x) => (x.id === id && !x.interruptedNote ? { ...x, interruptedNote: note } : x)) }))
    }
  }

  /**
   * "Tell it to continue": types `continue` + Enter into a terminal session, or sends it as a chat
   * prompt. Like typing there yourself, so it is not gated by the orders switch. Resolves false
   * (with nothing sent) when a draft is waiting in the chat box or the chat refused the prompt.
   */
  async tellContinue(id: string): Promise<boolean> {
    const session = this.store.get().sessions.find((x) => x.id === id)
    if (!session || session.state !== 'idle') return false
    if (session.surface === 'chat') {
      // The user's own half-typed prompt comes first: point at it instead of sending around it.
      if (this.chats.ui(id).draft.trim()) {
        this.focusChat()
        return false
      }
      if (!(await this.chats.send(id, CONTINUE_TEXT))) return false
    } else {
      // Text first, Enter a moment later: an agent TUI takes one burst that ends in Enter for a paste.
      this.bridge.terminal.write(id, CONTINUE_TEXT)
      await new Promise((r) => window.setTimeout(r, 150))
      this.bridge.terminal.write(id, '\r')
      this.terminals.focus()
    }
    void this.dismissInterrupted(id)
    return true
  }

  dismissRestoreNotice(): void {
    this.store.set({ restoreNotice: null })
  }

  /** The launch summary was clicked: show the first interrupted session. */
  openRestoreNotice(): void {
    const s = this.store.get()
    const notice = s.restoreNotice
    if (!notice) return
    const target = s.sessions.find((x) => x.id === notice.firstInterruptedId) ?? s.sessions.find((x) => x.interruptedNote)
    this.store.set({ restoreNotice: null })
    if (target) this.select(target.id, { focusTerminal: true, focusWorld: false })
  }

  /** Asks for the Recent list again (on open, and after anything that changes it). */
  async refreshRecent(): Promise<void> {
    if (!this.hasRestore) return
    const gen = ++this.recentGen
    if (this.store.get().recentStatus !== 'ready') this.store.set({ recentStatus: 'loading', recentError: null })
    try {
      const items = await this.bridge.sessions.recent()
      if (gen !== this.recentGen) return
      this.store.set((s) => ({
        recent: recentReducer(s.recent, { type: 'loaded', items: Array.isArray(items) ? items : [] }),
        recentStatus: 'ready',
        recentError: null
      }))
    } catch (err) {
      if (gen !== this.recentGen) return
      this.store.set({ recentStatus: 'error', recentError: cleanError(err) })
    }
  }

  /** Reopens a recent session: its conversation is resumed as a live session, which is selected. */
  async reopenRecent(id: string): Promise<void> {
    if (!this.hasRestore || this.store.get().reopening.has(id)) return
    this.store.set((s) => ({ reopening: new Set([...s.reopening, id]), recentActionError: null }))
    const done = (patch: Partial<AppState> = {}) =>
      this.store.set((s) => ({ ...patch, reopening: new Set([...s.reopening].filter((x) => x !== id)) }))
    try {
      const info = await this.bridge.sessions.reopen(id)
      const known = this.store.get().sessions.find((x) => x.id === info.id)
      if (!known || known.state === 'asleep' || known.state === 'exited') this.mergeSession(info)
      done({ recent: recentReducer(this.store.get().recent, { type: 'reopened', id }) })
      this.select(info.id, { focusTerminal: true, focusWorld: false })
      void this.refreshRecent()
    } catch (err) {
      done({ recentActionError: { id, text: cleanError(err) } })
    }
  }

  /** Forgets a recent entry: gone at once, back if the main process refuses. */
  async forgetRecent(id: string): Promise<void> {
    if (!this.hasRestore || this.store.get().recent.forgetting.has(id)) return
    this.store.set((s) => ({ recent: recentReducer(s.recent, { type: 'forget', id }), recentActionError: null }))
    try {
      await this.bridge.sessions.forget(id)
      this.store.set((s) => ({ recent: recentReducer(s.recent, { type: 'forgotten', id }) }))
    } catch (err) {
      this.store.set((s) => ({
        recent: recentReducer(s.recent, { type: 'rollback', id }),
        recentActionError: { id, text: cleanError(err) }
      }))
    }
  }

  clearRecentError(): void {
    this.store.set({ recentActionError: null })
  }

  /** What happens to saved sessions when the app opens. Shown at once, put back on a refusal. */
  async setRestoreSettings(patch: Partial<RestoreSettings>): Promise<void> {
    const prev = this.store.get().restoreSettings
    if (!this.hasRestore || !prev) return
    const optimistic = { ...prev, ...patch }
    this.store.set({ restoreSettings: optimistic })
    try {
      const next = await this.bridge.sessions.setRestoreSettings(patch)
      if (next && this.store.get().restoreSettings === optimistic) this.store.set({ restoreSettings: next })
    } catch (err) {
      console.warn('[agent-office] could not change the restore settings', err)
      if (this.store.get().restoreSettings === optimistic) this.store.set({ restoreSettings: prev })
    }
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
    if (patch.labels !== undefined) this.world.setLabels(patch.labels)
    if (persist) this.saveLayout()
    // The Inspect tab came on screen or left it: start or stop the watch.
    this.syncWatch()
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
