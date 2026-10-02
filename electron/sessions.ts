// Session manager: the sessions the app launched itself, whatever the provider. It validates every
// request from the renderer, owns the fixed provider table, routes terminal I/O, chat events and
// chat input, permission decisions and CEO orders, and tells the renderer when anything changes.
// A session's surface is a terminal (Claude Code) or the chat view (Codex, Antigravity); see drivers/types.ts.
//
// Security rules (shared/sessions.ts): the renderer picks a provider id and a folder, never a
// command, args or env; approvals and orders arrive over renderer IPC only.
//
// No Electron imports (main.ts and sessionsIpc.ts do the wiring), so tests can drive it with fakes.
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { CHAT_MAX_PROMPT_CHARS, type ChatEvent, type ChatItem } from '../shared/chat'
import type { AgentDetails } from '../shared/inspector'
import type { ProgressSnapshot } from '../shared/progress'
import { planOrder, REASON_ASLEEP, REASON_NOT_CONNECTED, type OrderResult } from '../shared/orders'
import { canWake, MAX_SAVED_PENDING, type RestoreMode, type RestoreSettings, type SavedPendingRequest, type SavedSession } from '../shared/restore'
import type {
  PermissionMode,
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderId,
  ProviderInfo,
  SessionHistoryEntry,
  SessionInfo,
  TerminalSnapshot
} from '../shared/sessions'
import type { HostedHookTarget, HostedSessions } from './adapters/claude-code-hooks'
import type { EventSink } from './adapters/types'
import type { AgentFact, AgentStats } from './agentStats'
import { boardAccess, boardStatus, parseBoardSettingsPatch, type Board, type BoardAccess, type BoardEndpoint } from './board'
import { resolveBoardProject, type BoardProject } from './boardProject'
import type { BoardSettings, BoardSnapshot } from '../shared/board'
import type { AgyHookTarget, AgyHookTargets } from './drivers/agyHookBridge'
import type { AgentDriver, ProviderDefinition, PtyHost, ValidatedStart } from './drivers/types'
import { parsePermissionDecision, PermissionRegistry } from './permissions'
import type { ProgressTracker } from './progress'
import { PTY_MAX_WRITE_CHARS } from './ptyProtocol'
import { assignTitles } from './sessionTitles'
import { promptPreview, type SessionStore } from './sessionStore'

export const MAX_LIVE_SESSIONS = 8
/** An exited session stays in the list this long, so its last screen and exit code can be seen. */
export const EXITED_RETENTION_MS = 60_000
/** Restore mode 'all': the next session is woken when this one is ready, or after this long. */
export const WAKE_ALL_WAIT_MS = 20_000
export const NO_SAVED_CONVERSATION = 'This session has no saved conversation to resume'
export const CONVERSATION_GONE = 'The saved conversation no longer exists, so this session could not be resumed'
export const STOP_BEFORE_FORGET = 'Stop the session before forgetting it'
const ASLEEP_FIRST = 'this session is asleep — wake it first'
const RESTORE_MODES: readonly RestoreMode[] = ['last', 'all', 'none']
const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']
const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity'
}
/** Providers without a driver yet, and the phase that brings it. (None at the moment.) */
const COMING: Partial<Record<ProviderId, string>> = {}

export interface SessionManagerOptions {
  pty: PtyHost
  /** World events. */
  sink: EventSink
  /** Providers that have a driver. The others are reported as unavailable. */
  providers: ProviderDefinition[]
  /** The tray's "Allow CEO orders" switch. */
  allowOrders: () => boolean
  /** Live top-level agents in the world (hosted or not), for order targets. */
  worldTopLevel: () => { id: string; provider: string }[]
  onSessionsChanged(sessions: SessionInfo[]): void
  onPermissionsChanged(pending: PermissionRequestInfo[]): void
  /** Output of a terminal the renderer is attached to. */
  onTerminalData(id: string, data: string): void
  /** A chat event of a session the renderer is attached to. */
  onChatEvent?(e: ChatEvent): void
  /** A provider's login state or usage changed: the full list again. */
  onProvidersChanged?(providers: ProviderInfo[]): void
  /** The office board. Absent = sessions run without one (no digest, no board tools, no warnings). */
  board?: SessionBoardOptions
  /** "Remember where I left off" (shared/restore.ts). Absent = nothing is saved or restored. */
  restore?: SessionRestoreOptions
  /**
   * The inspector's per-agent stats (agentStats.ts). The manager passes on what the drivers report
   * and answers `inspect()` from it. Absent = no inspector. Read-only: nothing here reaches an agent.
   */
  stats?: AgentStats
  /**
   * The progress bars (progress.ts): the manager tells it about prompts, states, plans and orders,
   * and answers `progress()` from it. Absent = no progress bars. Read-only: nothing here reaches an agent.
   */
  progress?: ProgressTracker
}

export interface SessionRestoreOptions {
  /** The saved records (`<userData>/sessions.json`). The manager loads it. */
  store: SessionStore
  /** What to wake on launch. Default: 'last'. */
  settings?: () => RestoreSettings
  /** Stores a settings change (config.json) and returns what now applies. */
  saveSettings?: (patch: Partial<RestoreSettings>) => RestoreSettings
  /** Restore mode 'all': how long to wait for one session before waking the next. */
  wakeWaitMs?: number
}

type InterruptedNote = NonNullable<SessionInfo['interruptedNote']>

/** A saved session without a process: a sleeping row, or (briefly) one whose conversation turned out to be gone. */
interface Sleeper {
  rec: SavedSession
  note?: InterruptedNote
  /** Shown as `exited` with this notice for a while, then dropped: it could not be resumed. */
  ended?: { notice: string; timer?: NodeJS.Timeout }
}

export interface SessionBoardOptions {
  model: Board
  /** Where a session's agent reaches the board tools, and the tokens for that route only. */
  endpoint?: BoardEndpoint
  /** Which repository a folder belongs to. Default: ask git (boardProject.ts). */
  resolveProject?: (cwd: string) => Promise<BoardProject>
  /** Stores a settings change (config.json) and returns what now applies. */
  saveSettings?: (patch: Partial<BoardSettings>) => BoardSettings
}

interface Session {
  id: string
  start: ValidatedStart
  startedAt: number
  /** The user's own title, or the model name (provider label until it is known); see sessionTitles.ts. */
  title: string
  /** The model id the session reported. */
  model?: string
  driver: AgentDriver
  exitCode?: number | null
  removeTimer?: NodeJS.Timeout
  lastActiveAt: number
  /** Preview of the user's last prompt (shared/restore.ts). */
  lastPrompt?: string
  /** It was working or waiting when the app last closed; shown until dismissed or the next prompt. */
  note?: InterruptedNote
  /** Started by resuming a saved record (wake / reopen). */
  restored?: boolean
  /** Got past its start-up at least once. */
  ready?: boolean
  /** Why it ended, when the app knows. */
  notice?: string
}

const cleanText = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()

export class SessionManager implements HostedSessions, AgyHookTargets {
  readonly permissions: PermissionRegistry
  private sessions = new Map<string, Session>()
  /** Saved sessions without a process (state `asleep`), by app id. */
  private asleep = new Map<string, Sleeper>()
  /** Wakes in flight, so a second click gets the same answer. */
  private waking = new Map<string, Promise<SessionInfo>>()
  private readonly store: SessionStore | undefined
  private stateWaiters: Array<() => void> = []
  private restoring = false
  /** The selection the store held at launch (the renderer may report a new one before it is used). */
  private launchSelected: string | null | undefined
  private providerTable = new Map<ProviderId, ProviderDefinition>()
  /** Terminals whose output is streamed to the renderer. */
  private attached = new Set<string>()
  /** Chat sessions whose events are streamed to the renderer. */
  private chatAttached = new Set<string>()
  private broadcastQueued = false
  private providersQueued = false
  private closing = false

  constructor(private readonly opts: SessionManagerOptions) {
    for (const p of opts.providers) {
      this.providerTable.set(p.id, p)
      p.onChanged?.(() => this.providersChanged())
    }
    this.permissions = new PermissionRegistry((pending) => {
      opts.onPermissionsChanged(pending)
      // The pending questions are part of what is saved about a session.
      for (const s of this.sessions.values()) this.save(s)
    })
    this.store = opts.restore?.store
    this.loadSaved()
  }

  // ---- providers ----

  async providers(): Promise<ProviderInfo[]> {
    const ids = Object.keys(PROVIDER_LABELS) as ProviderId[]
    return Promise.all(
      ids.map(async (id): Promise<ProviderInfo> => {
        const def = this.providerTable.get(id)
        if (!def?.createDriver) return { id, label: PROVIDER_LABELS[id], available: false, reason: COMING[id] ?? 'no driver' }
        try {
          return await def.probe()
        } catch {
          return { id, label: def.label, available: false, reason: 'not installed' }
        }
      })
    )
  }

  /** Coalesces bursts (usage is reported after every model response) into one broadcast. */
  private providersChanged(): void {
    if (this.providersQueued || this.closing || !this.opts.onProvidersChanged) return
    this.providersQueued = true
    setImmediate(() => {
      this.providersQueued = false
      if (this.closing) return
      void this.providers().then(
        (list) => this.opts.onProvidersChanged?.(list),
        () => {}
      )
    })
  }

  /** Starts a provider's own login flow (system browser). Rejects with a readable message. */
  async login(provider: unknown): Promise<void> {
    if (this.closing) throw new Error('the app is shutting down')
    if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_LABELS, provider)) throw new Error('unknown provider')
    const def = this.providerTable.get(provider as ProviderId)
    if (!def?.login) throw new Error(`${PROVIDER_LABELS[provider as ProviderId]} has no login in Agent Office`)
    await def.login()
    this.providersChanged()
  }

  // ---- sessions ----

  /** Live, exited and sleeping sessions, in the order they were first started. */
  list(): SessionInfo[] {
    const rows = [...this.sessions.values()].map((s) => this.info(s))
    for (const row of this.asleep.values()) rows.push(this.sleeperInfo(row))
    // Stable: sessions started in the same millisecond keep their order.
    return rows.sort((a, b) => a.startedAt - b.startedAt)
  }

  private info(s: Session): SessionInfo {
    const info: SessionInfo = {
      id: s.id,
      provider: s.start.provider,
      cwd: s.start.cwd,
      title: s.title,
      state: s.driver.state,
      startedAt: s.startedAt,
      permissionMode: s.start.permissionMode,
      surface: s.driver.surface,
      canReceiveOrders: s.driver.canReceiveOrders
    }
    const model = s.model ?? s.start.model
    if (model) info.model = model
    if (s.driver.providerSessionId) info.providerSessionId = s.driver.providerSessionId
    if (s.driver.state === 'exited') info.exitCode = s.exitCode ?? null
    if (this.store) info.lastActiveAt = s.lastActiveAt
    if (s.lastPrompt) info.lastPrompt = s.lastPrompt
    if (this.waking.has(s.id)) info.waking = true
    if (s.note) info.interruptedNote = { closedAt: s.note.closedAt, pending: s.note.pending.map((p) => ({ ...p })) }
    const notice = s.notice ?? (s.driver.state === 'exited' ? s.driver.endNotice : undefined)
    if (notice) info.notice = notice
    return info
  }

  /** A sleeping row: the saved record, no process. */
  private sleeperInfo(row: Sleeper): SessionInfo {
    const { rec } = row
    const info: SessionInfo = {
      id: rec.id,
      provider: rec.provider,
      cwd: rec.cwd,
      title: rec.title,
      state: row.ended ? 'exited' : 'asleep',
      startedAt: rec.startedAt,
      permissionMode: rec.permissionMode,
      surface: rec.provider === 'claude-code' ? 'terminal' : 'chat',
      canReceiveOrders: false,
      lastActiveAt: rec.lastActiveAt
    }
    if (rec.model) info.model = rec.model
    if (rec.providerSessionId) info.providerSessionId = rec.providerSessionId
    if (rec.lastPrompt) info.lastPrompt = rec.lastPrompt
    if (this.waking.has(rec.id)) info.waking = true
    if (row.ended) {
      info.exitCode = null
      info.notice = row.ended.notice
    } else {
      info.wakeable = canWake(rec)
      if (row.note) info.interruptedNote = { closedAt: row.note.closedAt, pending: row.note.pending.map((p) => ({ ...p })) }
    }
    return info
  }

  /** An untrusted folder path -> the existing directory it names. Throws an Error with a message fit for the UI. */
  private folder(input: unknown): string {
    if (typeof input !== 'string' || input.length === 0 || input.length > 1024 || input.includes('\0')) throw new Error('invalid folder')
    if (!isAbsolute(input)) throw new Error('the folder must be an absolute path')
    const cwd = resolve(input)
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) throw new Error('that folder does not exist')
    return cwd
  }

  /**
   * Earlier conversations of a provider in a folder, for the new-session dialog's "Resume previous…".
   * A conversation that a live session of the app already has open is left out. Empty for a
   * provider that keeps no history the app can list.
   */
  async history(provider: unknown, cwd: unknown): Promise<SessionHistoryEntry[]> {
    if (this.closing) throw new Error('the app is shutting down')
    if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_LABELS, provider)) throw new Error('unknown provider')
    const folder = this.folder(cwd)
    const def = this.providerTable.get(provider as ProviderId)
    if (!def?.history) return []
    const open = new Set<string>()
    for (const s of this.sessions.values()) {
      const id = s.driver.state === 'exited' ? undefined : (s.driver.providerSessionId ?? s.start.resume)
      if (id) open.add(id)
    }
    // A sleeping row already stands for its conversation: wake it instead of opening it twice.
    for (const row of this.asleep.values()) if (!row.ended && row.rec.providerSessionId) open.add(row.rec.providerSessionId)
    return (await def.history(folder)).filter((h) => !open.has(h.id))
  }

  /** Validates an untrusted start request. Throws an Error with a message fit for the UI. */
  private async validate(input: unknown): Promise<{ start: ValidatedStart; def: ProviderDefinition }> {
    if (!input || typeof input !== 'object') throw new Error('invalid request')
    const o = input as Record<string, unknown>
    const def = typeof o.provider === 'string' ? this.providerTable.get(o.provider as ProviderId) : undefined
    if (typeof o.provider !== 'string' || !Object.hasOwn(PROVIDER_LABELS, o.provider)) throw new Error('unknown provider')
    if (!def?.createDriver) throw new Error(`${PROVIDER_LABELS[o.provider as ProviderId]}: ${COMING[o.provider as ProviderId] ?? 'no driver'}`)

    const cwd = this.folder(o.cwd)

    let permissionMode: PermissionMode = 'default'
    if (o.permissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(o.permissionMode as PermissionMode)) throw new Error('invalid permission mode')
      permissionMode = o.permissionMode as PermissionMode
    }
    const optional = (v: unknown, re: RegExp, what: string): string | undefined => {
      if (v === undefined || v === null || v === '') return undefined
      // A leading "-" could be read as another flag by the CLI.
      if (typeof v !== 'string' || !re.test(v)) throw new Error(`invalid ${what}`)
      return v
    }
    const model = optional(o.model, /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, 'model')
    const resume = optional(o.resume, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, 'session to resume')
    if (o.title !== undefined && typeof o.title !== 'string') throw new Error('invalid title')
    const userTitle = (typeof o.title === 'string' ? cleanText(o.title).slice(0, 60) : '') || undefined

    const probe = await def.probe()
    if (!probe.available) throw new Error(`${def.label} is not available: ${probe.reason ?? 'not installed'}`)
    return { start: { provider: def.id, cwd, permissionMode, model, resume, title: userTitle ?? def.label, userTitle }, def }
  }

  async start(input: unknown): Promise<SessionInfo> {
    if (this.closing) throw new Error('the app is shutting down')
    const { start, def } = await this.validate(input)
    // Which repository the folder belongs to (asks git once, with a short timeout): the project
    // that scopes the office board. Nothing may be awaited between the count below and the
    // session being listed, or two starts could both pass it.
    const project = await this.project(start.cwd)
    if (this.closing) throw new Error('the app is shutting down')
    this.checkLiveLimit()
    const id = `s-${randomBytes(6).toString('hex')}`
    this.makeRoom()
    return this.launch(id, start, def, project, {})
  }

  private async project(cwd: string): Promise<BoardProject | null> {
    const boardOpts = this.opts.board
    return boardOpts ? (boardOpts.resolveProject ?? resolveBoardProject)(cwd) : null
  }

  private liveCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.driver.state !== 'exited') n++
    return n
  }

  /** Sleeping rows don't count: they have no process. */
  private checkLiveLimit(): void {
    if (this.liveCount() >= MAX_LIVE_SESSIONS) throw new Error(`too many sessions (at most ${MAX_LIVE_SESSIONS} at a time)`)
  }

  /**
   * Creates the driver and starts the agent under the app id `id`: a new session, or a saved one
   * that is woken (then `start.resume` is its conversation and `saved` what is carried over).
   * Synchronous up to the point where the session is listed.
   */
  private async launch(
    id: string,
    start: ValidatedStart,
    def: ProviderDefinition,
    project: BoardProject | null,
    saved: { startedAt?: number; model?: string; lastPrompt?: string; note?: InterruptedNote; restored?: boolean }
  ): Promise<SessionInfo> {
    // The session's row on the board before the agent starts: its driver may ask for the board's
    // endpoint right away.
    const board = project ? this.joinBoard(id, start, project) : undefined
    const driver = def.createDriver!({
      sessionId: id,
      start,
      pty: this.opts.pty,
      sink: this.opts.sink,
      permissions: this.permissions,
      board,
      events: {
        onState: (state) => this.onState(id, state),
        onProviderSession: () => this.touched(id),
        onModel: (model) => this.onModel(id, model),
        onChanged: () => this.touched(id),
        onExit: (code) => this.onExit(id, code),
        onChat: (e) => {
          if (this.chatAttached.has(id)) this.opts.onChatEvent?.(e)
        },
        onPrompt: (text, o) => this.onPrompt(id, text, o?.midTurn === true),
        onFact: (fact) => this.fact(fact),
        onProgress: (signal) => this.track((p) => p.signal(id, signal))
      }
    })
    const now = Date.now()
    const session: Session = { id, start, startedAt: saved.startedAt ?? now, title: start.title, driver, lastActiveAt: now }
    if (saved.model) session.model = saved.model
    if (saved.lastPrompt) session.lastPrompt = saved.lastPrompt
    if (saved.note) session.note = saved.note
    if (saved.restored) session.restored = true
    this.sessions.set(id, session)
    this.track((p) => {
      p.session(id, session.title)
      p.state(id, driver.state)
    })
    this.retitle() // another live session may already go by this name
    try {
      await driver.start()
    } catch (err) {
      this.sessions.delete(id)
      this.track((p) => p.forget(id))
      this.leaveBoard(id, board, true)
      this.retitle()
      // Whatever was saved while it was starting (a woken session's record is put back by wake()).
      if (!saved.restored && !this.closing) this.store?.remove(id)
      throw err instanceof Error ? err : new Error('could not start the session')
    }
    this.opts.board?.model.setStatus(id, boardStatus(driver.state))
    this.save(session)
    this.changed()
    return this.info(session)
  }

  /** Something for the inspector. Never in the way of a session. */
  private fact(fact: AgentFact): void {
    try {
      this.opts.stats?.fact(fact)
    } catch {
      // the inspector is a convenience
    }
  }

  /** Something for the progress bars. Never in the way of a session. */
  private track(fn: (progress: ProgressTracker) => void): void {
    const progress = this.opts.progress
    if (!progress) return
    try {
      fn(progress)
    } catch {
      // the progress bars are a convenience
    }
  }

  /** What the progress bars show: every live session's progress and the orders being worked on. */
  progress(): ProgressSnapshot {
    return this.opts.progress?.snapshot() ?? { sessions: [], orders: [] }
  }

  /** The user closed an order's progress bar. False if it was already gone. */
  dismissOrder(id: unknown): boolean {
    return this.opts.progress?.dismissOrder(id) ?? false
  }

  private onState(id: string, state: SessionInfo['state']): void {
    this.opts.board?.model.setStatus(id, boardStatus(state))
    this.track((p) => p.state(id, state))
    // A turn that is thinking shows no activity in the world: the manager's working clock follows the session's state.
    this.fact({ kind: 'busy', agentId: id, busy: state === 'busy' || state === 'waiting-permission' })
    const s = this.sessions.get(id)
    if (s) {
      if (state === 'idle' || state === 'busy' || state === 'waiting-permission') s.ready = true
      s.lastActiveAt = Date.now()
      this.save(s)
    }
    for (const w of this.stateWaiters.splice(0)) w()
    this.changed()
  }

  /** Something the record holds may have changed (provider session id, workers, inbox). */
  private touched(id: string): void {
    const s = this.sessions.get(id)
    if (s) this.save(s)
    this.changed()
  }

  /** The user sent a prompt (typed, or an order). `midTurn`: into a turn that was already running. */
  private onPrompt(id: string, text: string, midTurn = false): void {
    const s = this.sessions.get(id)
    if (!s) return
    // A new piece of work: the progress bar starts over.
    if (!midTurn) this.track((p) => p.prompt(id))
    const preview = promptPreview(text)
    if (preview) {
      s.lastPrompt = preview
      // What the manager was asked to do, as the inspector shows it (the same redacted one-line preview).
      this.fact({ kind: 'task', agentId: id, text: preview })
    }
    s.lastActiveAt = Date.now()
    // They are working with the session again: the "was interrupted" note has done its job.
    delete s.note
    this.save(s)
    this.changed()
  }

  // ---- office board ----

  /** Puts a starting session on the board and returns its own view of it (what its driver gets). */
  private joinBoard(id: string, start: ValidatedStart, project: BoardProject): BoardAccess | undefined {
    const board = this.opts.board
    if (!board) return undefined
    board.model.addBranch({ sessionId: id, team: start.title, provider: start.provider, ...project })
    return boardAccess(board.model, id, board.endpoint)
  }

  /** The session is over (its row stays for a while as "ended") or never started (`drop`). Its board token dies. */
  private leaveBoard(id: string, access: BoardAccess | undefined, drop = false): void {
    access?.revoke()
    this.opts.board?.endpoint?.tokens.revoke(id)
    if (drop) this.opts.board?.model.dropBranch(id)
    else this.opts.board?.model.end(id)
  }

  /** What the board panel shows. Empty without a board. */
  board(): { snapshot: BoardSnapshot; settings: BoardSettings } {
    const model = this.opts.board?.model
    if (!model) return { snapshot: { branches: [], claims: [], notes: [], warnings: [] }, settings: { enabled: false, conflictMode: 'off' } }
    return { snapshot: model.snapshot(), settings: model.settings }
  }

  /** The user deleted a claim or a note in the panel. False if it was already gone (or the arguments are not valid). */
  boardRemove(kind: unknown, id: unknown): boolean {
    if (kind !== 'claim' && kind !== 'note') throw new Error('invalid board item kind')
    if (typeof id !== 'string' || id.length === 0 || id.length > 100) throw new Error('invalid board item id')
    return this.opts.board?.model.remove(kind, id) ?? false
  }

  /** The board's switches. Throws on anything that is not a valid patch. Applies to live sessions at once. */
  boardSetSettings(input: unknown): BoardSettings {
    const patch = parseBoardSettingsPatch(input)
    if (!patch) throw new Error('invalid board settings')
    const board = this.opts.board
    if (!board) throw new Error('the office board is not available')
    return board.saveSettings ? board.saveSettings(patch) : board.model.settings
  }

  private onModel(id: string, model: string): void {
    const s = this.sessions.get(id)
    if (!s || s.model === model) return
    s.model = model
    this.retitle()
    this.save(s)
    this.changed()
  }

  /**
   * Gives every live session its title: the user's own, else the model name, made unique with the
   * folder name. The drivers pass a new title on to the world (manager name, branch sign).
   */
  private retitle(): void {
    const live = [...this.sessions.values()].filter((s) => s.driver.state !== 'exited')
    const titles = assignTitles(
      live.map((s) => ({
        id: s.id,
        userTitle: s.start.userTitle,
        providerLabel: PROVIDER_LABELS[s.start.provider],
        model: s.model,
        folder: basename(s.start.cwd)
      }))
    )
    for (const s of live) {
      const title = titles.get(s.id)
      if (!title || title === s.title) continue
      s.title = title
      s.driver.setTitle(title)
      this.track((p) => p.session(s.id, title))
      // Its team goes by the new name on the board too.
      this.opts.board?.model.rename(s.id, title)
      this.save(s)
    }
  }

  private onExit(id: string, exitCode: number | null): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.exitCode = exitCode
    this.leaveBoard(id, undefined)
    s.removeTimer = setTimeout(() => this.remove(id), EXITED_RETENTION_MS)
    s.removeTimer.unref?.()
    delete s.note
    this.ended(s)
    for (const w of this.stateWaiters.splice(0)) w()
    this.changed()
  }

  /**
   * The session ended while the app keeps running (the user stopped it, or it exited by itself):
   * its record moves to Recent. When the app itself is closing, the record stays as it is: `open`.
   */
  private ended(s: Session): void {
    const store = this.store
    if (!store || this.closing) return
    const rec = store.get(s.id)
    if (!rec) return
    // It never had a conversation (stopped before it was ready): nothing to come back to.
    if (!canWake(rec)) return void store.remove(s.id)
    store.update(s.id, { status: 'recent', interrupted: false, pendingAtClose: [], interruptedAt: undefined, lastActiveAt: Date.now() })
    if (s.restored && !s.ready) void this.checkGone(s)
  }

  /** A resumed terminal session that exited before it was ready: does its screen say the conversation is gone? */
  private async checkGone(s: Session): Promise<void> {
    const gone = this.providerTable.get(s.start.provider)?.conversationGone
    if (!gone || s.driver.surface !== 'terminal') return
    const snap = await this.opts.pty.snapshot(s.id, false).catch(() => null)
    if (this.closing || !snap || !gone({ screen: snap.text })) return
    s.notice = CONVERSATION_GONE
    this.store?.update(s.id, { providerSessionId: undefined })
    this.changed()
  }

  private remove(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.removeTimer) clearTimeout(s.removeTimer)
    this.sessions.delete(id)
    this.track((p) => p.forget(id))
    this.attached.delete(id)
    this.chatAttached.delete(id)
    if (s.driver.surface === 'terminal') this.opts.pty.dispose(id)
    this.changed()
  }

  private get(id: unknown): Session {
    const s = typeof id === 'string' && id.length <= 64 ? this.sessions.get(id) : undefined
    if (!s) {
      const row = typeof id === 'string' ? this.asleep.get(id) : undefined
      // An ended row without a process has no terminal and no chat: say why it ended.
      if (row) throw new Error(row.ended ? row.ended.notice : ASLEEP_FIRST)
      throw new Error('unknown session')
    }
    return s
  }

  /**
   * Asks the agent to exit and kills its process tree if it doesn't. An exited session is removed.
   * A sleeping row leaves the sidebar and stays in Recent.
   */
  async stop(id: unknown): Promise<void> {
    const row = typeof id === 'string' ? this.asleep.get(id) : undefined
    if (row) return this.dropSleeper(row, 'recent')
    const s = this.get(id)
    if (s.driver.state === 'exited') return this.remove(s.id)
    await s.driver.stop()
  }

  interrupt(id: unknown): void {
    this.get(id).driver.interrupt()
  }

  // ---- restore: sessions survive closing the app (shared/restore.ts, sessionStore.ts) ----

  /** Launch: every record that was open comes back as a sleeping row. Nothing is started here. */
  private loadSaved(): void {
    const store = this.store
    if (!store) return
    store.load()
    this.launchSelected = store.selectedId
    for (const rec of store.open()) {
      const row: Sleeper = { rec }
      const note = noteOf(rec)
      if (note) {
        row.note = note
        // Pinned, so the note still says when it happened after another restart.
        row.rec = store.update(rec.id, { interrupted: true, interruptedAt: note.closedAt }) ?? rec
      }
      this.asleep.set(rec.id, row)
    }
  }

  /**
   * Writes what would be lost if the app died now: the session's identity, its conversation id, a
   * preview of the last prompt, whether it is working, and the questions it is waiting on.
   */
  private save(s: Session): void {
    const store = this.store
    if (!store || this.closing) return
    const state = s.driver.state
    if (state === 'exited') return // ended() decides what becomes of the record
    const pending: SavedPendingRequest[] = this.permissions
      .list()
      .filter((p) => p.sessionId === s.id)
      .map((p) => ({ question: p.question, toolName: p.toolName, askedAt: p.createdAt }))
    const working = state === 'busy' || state === 'waiting-permission' || (s.driver.workers ?? 0) > 0
    const rec: SavedSession = {
      id: s.id,
      provider: s.start.provider,
      cwd: s.start.cwd,
      title: s.title,
      titleIsCustom: !!s.start.userTitle,
      permissionMode: s.start.permissionMode,
      model: s.model ?? s.start.model,
      providerSessionId: s.driver.providerSessionId ?? s.start.resume,
      startedAt: s.startedAt,
      lastActiveAt: s.lastActiveAt,
      lastPrompt: s.lastPrompt,
      // A note that was not dismissed yet is kept as it was, with anything new added.
      interrupted: working || !!s.note,
      pendingAtClose: (s.note ? mergePending(s.note.pending, pending) : pending).slice(0, MAX_SAVED_PENDING),
      interruptedAt: s.note?.closedAt,
      status: 'open'
    }
    store.put(rec)
  }

  /**
   * The sidebar holds at most MAX_LIVE_SESSIONS rows: before one is added, the sleeping row that
   * was active longest ago moves to Recent (it keeps its "was interrupted" note for a reopen).
   */
  private makeRoom(): void {
    for (;;) {
      const sleepers = [...this.asleep.values()].filter((r) => !r.ended)
      if (sleepers.length === 0 || this.liveCount() + sleepers.length < MAX_LIVE_SESSIONS) return
      this.dropSleeper(sleepers.reduce((a, b) => (b.rec.lastActiveAt < a.rec.lastActiveAt ? b : a)), 'recent', true)
    }
  }

  /** Takes a sleeping row out of the sidebar: its record moves to Recent, or is forgotten. */
  private dropSleeper(row: Sleeper, to: 'recent' | 'forget', keepNote = false): void {
    const id = row.rec.id
    if (row.ended?.timer) clearTimeout(row.ended.timer)
    if (this.asleep.get(id) === row) this.asleep.delete(id)
    const store = this.store
    if (store && !this.closing) {
      if (to === 'forget') store.remove(id)
      else if (row.ended) void 0 // already in Recent, as a record that can't be resumed
      else if (!canWake(row.rec)) store.remove(id) // never had a conversation: nothing to come back to
      else if (keepNote) store.update(id, { status: 'recent' })
      else store.update(id, { status: 'recent', interrupted: false, pendingAtClose: [], interruptedAt: undefined })
    }
    this.changed()
  }

  /**
   * Wakes a sleeping session: resumes its provider conversation under the same app id. A second
   * call while the first is in flight gets the same answer; waking a session that is already
   * running resolves with it.
   */
  wake(id: unknown): Promise<SessionInfo> {
    if (typeof id !== 'string' || id.length > 64) return Promise.reject(new Error('unknown session'))
    const inFlight = this.waking.get(id)
    if (inFlight) return inFlight
    const run = (async (): Promise<SessionInfo> => {
      try {
        // The answer describes the session as it is once the wake is over.
        const { waking: _inFlight, ...info } = await this.doWake(id)
        return info
      } finally {
        this.waking.delete(id)
        this.changed()
      }
    })()
    this.waking.set(id, run)
    // The row says `waking` from now until the agent is started (or could not be).
    this.changed()
    return run
  }

  private async doWake(id: string): Promise<SessionInfo> {
    if (this.closing) throw new Error('the app is shutting down')
    const live = this.sessions.get(id)
    if (live && live.driver.state !== 'exited') return this.info(live)
    const row = this.asleep.get(id)
    if (!row || row.ended) throw new Error('unknown session')
    const { rec } = row
    if (!canWake(rec)) throw new Error(NO_SAVED_CONVERSATION)
    const label = PROVIDER_LABELS[rec.provider]
    const def = this.providerTable.get(rec.provider)
    if (!def?.createDriver) throw new Error(`${label}: ${COMING[rec.provider] ?? 'no driver'}`)
    const cwd = this.folder(rec.cwd)
    const probe = await def.probe()
    if (!probe.available) throw new Error(`${def.label} is not available: ${probe.reason ?? 'not installed'}`)
    const project = await this.project(cwd)
    if (this.closing) throw new Error('the app is shutting down')
    // Forgotten, stopped or moved to Recent while we were asking.
    if (this.asleep.get(id) !== row) throw new Error('unknown session')
    // Nothing is awaited between this count and the session being listed.
    this.checkLiveLimit()
    const start: ValidatedStart = {
      provider: rec.provider,
      cwd,
      permissionMode: rec.permissionMode,
      model: rec.model,
      resume: rec.providerSessionId,
      title: rec.title,
      userTitle: rec.titleIsCustom ? rec.title : undefined
    }
    this.asleep.delete(id)
    try {
      return await this.launch(id, start, def, project, {
        startedAt: rec.startedAt,
        model: rec.model,
        lastPrompt: rec.lastPrompt,
        note: row.note,
        restored: true
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'could not start the session'
      if (this.closing) throw new Error(message)
      if (def.conversationGone?.({ error: message })) {
        this.conversationGone(rec)
        throw new Error(CONVERSATION_GONE)
      }
      // Still asleep, exactly as it was.
      this.store?.put(rec)
      this.asleep.set(id, row)
      this.changed()
      throw new Error(message)
    }
  }

  /**
   * The provider no longer has the conversation: the row is shown as ended, with the reason, for
   * a while; its record can't be woken or reopened any more.
   */
  private conversationGone(rec: SavedSession): void {
    const { providerSessionId: _gone, interruptedAt: _at, ...rest } = rec
    const record: SavedSession = { ...rest, status: 'recent', interrupted: false, pendingAtClose: [] }
    this.store?.put(record)
    const row: Sleeper = { rec: record, ended: { notice: CONVERSATION_GONE } }
    row.ended!.timer = setTimeout(() => {
      if (this.asleep.get(rec.id) !== row) return
      this.asleep.delete(rec.id)
      this.changed()
    }, EXITED_RETENTION_MS)
    row.ended!.timer.unref?.()
    this.asleep.set(rec.id, row)
    this.changed()
  }

  /** Sessions that ended earlier and can be reopened, newest first. */
  recent(): SavedSession[] {
    return this.store?.recent() ?? []
  }

  /** Reopens a recent session: it is back in the sidebar and its conversation is resumed. */
  async reopen(id: unknown): Promise<SessionInfo> {
    if (this.closing) throw new Error('the app is shutting down')
    if (typeof id !== 'string' || id.length > 64) throw new Error('unknown session')
    // Already back (a second click), or never gone.
    const live = this.sessions.get(id)
    if (this.waking.has(id) || (live && live.driver.state !== 'exited') || (this.asleep.has(id) && !this.asleep.get(id)!.ended)) return this.wake(id)
    const store = this.store
    const rec = store?.get(id)
    if (!store || !rec || rec.status !== 'recent') throw new Error('That session is no longer in the recent list')
    if (!canWake(rec)) throw new Error(NO_SAVED_CONVERSATION)
    this.checkLiveLimit()
    // Its ended row may still be on show.
    if (live) this.remove(id)
    this.makeRoom()
    const row: Sleeper = { rec: store.update(id, { status: 'open' }) ?? { ...rec, status: 'open' } }
    const note = noteOf(row.rec)
    if (note) row.note = note
    this.asleep.set(id, row)
    try {
      return await this.wake(id)
    } catch (err) {
      // Not resumed: back to the recent list (unless its conversation turned out to be gone).
      if (this.asleep.get(id) === row) {
        this.asleep.delete(id)
        if (!this.closing) store.update(id, { status: 'recent' })
        this.changed()
      }
      throw err
    }
  }

  /**
   * Removes a saved session for good: a sleeping row, an ended row or a recent entry. The
   * provider's own history is never touched. A running session must be stopped first.
   */
  forget(id: unknown): void {
    if (typeof id !== 'string' || id.length > 64) throw new Error('unknown session')
    const live = this.sessions.get(id)
    if (this.waking.has(id) || (live && live.driver.state !== 'exited')) throw new Error(STOP_BEFORE_FORGET)
    if (live) this.remove(id)
    const row = this.asleep.get(id)
    if (row) this.dropSleeper(row, 'forget')
    else if (!this.closing) this.store?.remove(id)
    this.changed()
  }

  /** Hides the "was interrupted" note of a session (sleeping or awake). */
  dismissInterrupted(id: unknown): void {
    if (typeof id !== 'string') return
    const live = this.sessions.get(id)
    if (live?.note) {
      delete live.note
      this.save(live)
      return this.changed()
    }
    const row = this.asleep.get(id)
    if (!row?.note) return
    delete row.note
    if (!this.closing) row.rec = this.store?.update(id, { interrupted: false, pendingAtClose: [], interruptedAt: undefined }) ?? row.rec
    this.changed()
  }

  /** The renderer's selection (null = none): remembered, so the next launch wakes that session. */
  setSelected(id: unknown): void {
    if (!this.store || this.closing) return
    if (id === null) this.store.setSelected(null)
    else if (typeof id === 'string' && (this.sessions.has(id) || this.asleep.has(id))) this.store.setSelected(id)
  }

  /** The session that was selected when the app last closed, if it is still listed. */
  getSelected(): string | null {
    const id = this.launchSelected
    return typeof id === 'string' && (this.sessions.has(id) || this.asleep.has(id)) ? id : null
  }

  getRestoreSettings(): RestoreSettings {
    const mode = this.opts.restore?.settings?.().mode
    return { mode: RESTORE_MODES.includes(mode as RestoreMode) ? (mode as RestoreMode) : 'last' }
  }

  /** Throws on anything that is not a valid patch. */
  setRestoreSettings(input: unknown): RestoreSettings {
    const patch = parseRestoreSettingsPatch(input)
    if (!patch) throw new Error('invalid restore settings')
    const save = this.opts.restore?.saveSettings
    if (!save) throw new Error('session restore is not available')
    return save(patch)
  }

  /**
   * Launch, once the sessions can report back (the ingest server is up): wakes what the restore
   * mode says. 'last' = the session that was selected (the most recently active one if the
   * selection was never reported); 'all' = every open session, one at a time; 'none' = nothing.
   * Never throws: a session that can't be woken simply stays asleep.
   */
  async restoreOnLaunch(): Promise<void> {
    if (this.restoring || this.closing || !this.store) return
    this.restoring = true
    const { mode } = this.getRestoreSettings()
    const rows = [...this.asleep.values()].filter((r) => !r.ended && canWake(r.rec)).sort((a, b) => a.rec.startedAt - b.rec.startedAt)
    const wake = async (id: string): Promise<boolean> => {
      try {
        await this.wake(id)
        return true
      } catch (err) {
        console.warn(`[agent-office] could not wake a saved session: ${err instanceof Error ? err.message : 'error'}`)
        return false
      }
    }
    if (mode === 'none' || rows.length === 0) return
    if (mode === 'last') {
      const selected = this.launchSelected
      const target =
        selected === undefined ? rows.reduce((a, b) => (b.rec.lastActiveAt > a.rec.lastActiveAt ? b : a)) : rows.find((r) => r.rec.id === selected)
      if (target) await wake(target.rec.id)
      return
    }
    // One at a time, so several agents don't start (and take their memory) at the same moment.
    for (const row of rows) {
      if (this.closing) return
      if (this.asleep.get(row.rec.id) !== row) continue // woken, stopped or forgotten meanwhile
      if (await wake(row.rec.id)) await this.settled(row.rec.id, this.opts.restore?.wakeWaitMs ?? WAKE_ALL_WAIT_MS)
    }
  }

  /** Resolves when the session takes input (or asks for attention, or is gone), or after `ms`. */
  private settled(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let finished = false
      const done = (): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve()
      }
      const check = (): void => {
        if (finished) return
        const state = this.sessions.get(id)?.driver.state
        if (this.closing || state === undefined || state === 'idle' || state === 'needs-attention' || state === 'exited') return done()
        this.stateWaiters.push(check)
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      check()
    })
  }

  // ---- hooks (HostedSessions, used by the /hooks/claude-code adapter) ----

  hookTarget(sessionId: string): HostedHookTarget | undefined {
    const driver = this.sessions.get(sessionId)?.driver as (AgentDriver & Partial<HostedHookTarget>) | undefined
    return driver && typeof driver.handleHook === 'function' ? (driver as AgentDriver & HostedHookTarget) : undefined
  }

  /** The driver of a live hosted Antigravity session, for the `/hooks/agy` route (drivers/agyHookBridge.ts). */
  agyHookTarget(sessionId: string): AgyHookTarget | undefined {
    const driver = this.sessions.get(sessionId)?.driver as (AgentDriver & Partial<AgyHookTarget>) | undefined
    return driver && driver.provider === 'antigravity' && typeof driver.handleAgyHook === 'function' ? (driver as AgentDriver & AgyHookTarget) : undefined
  }

  ownsProviderSession(providerSessionId: string): boolean {
    for (const s of this.sessions.values()) if (s.driver.providerSessionId === providerSessionId) return true
    return false
  }

  // ---- terminal ----

  async attach(id: unknown): Promise<TerminalSnapshot> {
    const s = this.get(id)
    if (s.driver.surface !== 'terminal') throw new Error('this session has no terminal (it uses the chat view)')
    // Until the snapshot arrives, output still in flight belongs to an older attachment: drop it.
    this.attached.delete(s.id)
    const snap = await this.opts.pty.snapshot(s.id, true)
    if (!snap) throw new Error('that terminal is gone')
    this.attached.add(s.id)
    return { data: snap.data, cols: snap.cols, rows: snap.rows }
  }

  detach(id: unknown): void {
    if (!this.isTerminal(id)) return
    this.attached.delete(id)
    this.opts.pty.detach(id)
  }

  /** The renderer reloaded or its window was replaced: nobody is listening any more. */
  detachAll(): void {
    for (const id of [...this.attached]) this.detach(id)
    this.chatAttached.clear()
  }

  /** Is this a terminal session? (Keystrokes, resizes and acks for anything else are dropped.) */
  private isTerminal(id: unknown): id is string {
    return typeof id === 'string' && this.sessions.get(id)?.driver.surface === 'terminal'
  }

  /** Keystrokes from the terminal pane. Not gated by "Allow CEO orders": it is the user's own terminal. */
  write(id: unknown, data: unknown): void {
    if (typeof data !== 'string' || !this.isTerminal(id)) return
    if (data.length === 0 || data.length > PTY_MAX_WRITE_CHARS) return
    this.opts.pty.write(id, data)
  }

  resize(id: unknown, cols: unknown, rows: unknown): void {
    if (!this.isTerminal(id)) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    if ((cols as number) < 2 || (cols as number) > 500 || (rows as number) < 1 || (rows as number) > 300) return
    this.opts.pty.resize(id, cols as number, rows as number)
  }

  ack(id: unknown, chars: unknown): void {
    if (!this.isTerminal(id)) return
    if (!Number.isInteger(chars) || (chars as number) <= 0 || (chars as number) > 10_000_000) return
    this.opts.pty.ack(id, chars as number)
  }

  /** Called by the pty client for every batch of output. */
  terminalData(id: string, data: string): void {
    if (this.attached.has(id)) this.opts.onTerminalData(id, data)
  }

  // ---- chat (sessions with surface 'chat') ----

  private chatSession(id: unknown): Session {
    const s = this.get(id)
    if (s.driver.surface !== 'chat' || !s.driver.chatItems) throw new Error('this session has no chat view (it uses the terminal)')
    return s
  }

  /**
   * The session's current chat list. From here on its ChatEvents go to the renderer. The same list
   * is also sent as a `reset` event first, so a listener that only follows events is complete too.
   * Synchronous on purpose: no event can fall between the snapshot and the subscription.
   */
  chatAttach(id: unknown): ChatItem[] {
    const s = this.chatSession(id)
    const items = s.driver.chatItems!()
    this.chatAttached.add(s.id)
    this.opts.onChatEvent?.({ type: 'reset', sessionId: s.id, items })
    return items
  }

  chatDetach(id: unknown): void {
    if (typeof id === 'string') this.chatAttached.delete(id)
  }

  /**
   * A prompt typed in the chat box: starts a turn, or steers the running one. Not gated by
   * "Allow CEO orders": like keystrokes in a terminal pane, it is the user's own input.
   */
  async chatSend(id: unknown, text: unknown): Promise<void> {
    const s = this.chatSession(id)
    if (typeof text !== 'string') throw new Error('invalid message')
    if (text.length > CHAT_MAX_PROMPT_CHARS) throw new Error(`the message is longer than ${CHAT_MAX_PROMPT_CHARS} characters`)
    // Control characters have no business in a prompt; line breaks and tabs do.
    const clean = text
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
      .trim()
    if (clean.length === 0) throw new Error('the message is empty')
    if (s.driver.state === 'exited') throw new Error('the session has ended')
    const r = await s.driver.sendPrompt(clean, 'human')
    if (!r.ok) throw new Error(r.reason)
  }

  // ---- inspector (shared/inspector.ts): read-only ----

  /**
   * What one agent of the world is doing: a hosted manager, one of its workers, an observed
   * session, or a sleeping session's row. Null for an id nobody knows (or without stats).
   */
  inspect(agentId: unknown): AgentDetails | null {
    const stats = this.opts.stats
    if (!stats || typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 200) return null
    return stats.details(agentId, {
      session: (id) => {
        const live = this.sessions.get(id)
        if (live) return this.info(live)
        const row = this.asleep.get(id)
        return row ? this.sleeperInfo(row) : undefined
      },
      pending: () => this.permissions.list(),
      claim: (sessionId) => this.opts.board?.model.claimOf(sessionId)
    })
  }

  // ---- permissions ----

  listPermissions(): PermissionRequestInfo[] {
    return this.permissions.list()
  }

  /** A decision from the CEO office. Throws on a malformed decision. */
  decide(id: unknown, decision: unknown): PermissionOutcome {
    const parsed = parsePermissionDecision(decision)
    if (!parsed) throw new Error('invalid permission decision')
    if (typeof id !== 'string' || id.length > 100) return 'unknown-request'
    const pending = this.permissions.list().find((p) => p.id === id)
    const driver = pending ? this.sessions.get(pending.sessionId)?.driver : undefined
    // Not pending any more (or never was): the registry knows which.
    return driver ? driver.answerPermission(id, parsed) : this.permissions.decide(id, parsed)
  }

  // ---- orders ----

  /** CEO speech bar -> sessions. Validated, gated by the tray toggle, never throws. */
  async sendOrder(input: unknown): Promise<OrderResult> {
    const hosted = [...this.sessions.values()]
      .filter((s) => s.driver.state !== 'exited')
      .map((s) => ({ id: s.id, provider: s.start.provider as string }))
    // Sleeping rows can be named (and are part of "all"), but nothing is delivered to them.
    for (const row of this.asleep.values()) if (!row.ended) hosted.push({ id: row.rec.id, provider: row.rec.provider })
    const hostedIds = new Set([...this.sessions.keys(), ...this.asleep.keys()])
    // Sessions the app didn't start are valid targets by name, but nothing can be delivered to them.
    const external = this.opts.worldTopLevel().filter((k) => !hostedIds.has(k.id))
    const plan = planOrder(input, { allowOrders: this.opts.allowOrders(), known: [...hosted, ...external] })
    if (!plan.ok) return plan.result
    const result: OrderResult = { delivered: [], failed: [] }
    const sentAt = this.opts.progress?.now() ?? Date.now()
    await Promise.all(
      plan.targets.map(async (id) => {
        const s = this.sessions.get(id)
        if (!s && this.asleep.has(id)) return void result.failed.push({ agentId: id, reason: REASON_ASLEEP })
        if (!s) return void result.failed.push({ agentId: id, reason: REASON_NOT_CONNECTED })
        try {
          const r = await s.driver.sendPrompt(plan.text, 'order')
          if (r.ok) result.delivered.push(id)
          else result.failed.push({ agentId: id, reason: r.reason })
        } catch {
          result.failed.push({ agentId: id, reason: 'delivery failed' })
        }
      })
    )
    // The order's own progress bar: the sessions that took it, and the live ones that could not.
    this.track((p) =>
      p.order({
        text: plan.text,
        target: typeof (input as { target?: unknown }).target === 'string' ? (input as { target: string }).target : '',
        sentAt,
        delivered: result.delivered,
        failed: result.failed.filter((f) => this.sessions.has(f.agentId)).map((f) => ({ sessionId: f.agentId, reason: f.reason }))
      })
    )
    return result
  }

  // ---- lifecycle ----

  /** Stops taking new sessions. The pty host (killed by the caller) takes the terminal processes down. */
  close(): void {
    this.closing = true
    for (const s of this.sessions.values()) if (s.removeTimer) clearTimeout(s.removeTimer)
    for (const row of this.asleep.values()) if (row.ended?.timer) clearTimeout(row.ended.timer)
    // From here on the records are frozen: the sessions that are about to be killed stay `open`,
    // with what they were doing, and come back asleep on the next launch.
    this.store?.flush()
  }

  /**
   * App quit: drops the chat-based sessions (their threads stay in the provider's own history) and
   * stops what the providers keep running, e.g. the shared Codex app-server and its process tree.
   */
  async shutdown(): Promise<void> {
    this.close()
    const drops = [...this.sessions.values()]
      .filter((s) => s.driver.surface === 'chat' && s.driver.state !== 'exited')
      .map((s) => s.driver.stop().catch(() => {}))
    const timeout = new Promise<void>((r) => setTimeout(r, 3000))
    await Promise.race([Promise.all(drops), timeout])
    await Promise.all([...this.providerTable.values()].map((p) => p.shutdown?.().catch(() => {})))
  }

  /** Coalesces bursts of changes into one broadcast. */
  private changed(): void {
    if (this.broadcastQueued) return
    this.broadcastQueued = true
    setImmediate(() => {
      this.broadcastQueued = false
      this.opts.onSessionsChanged(this.list())
    })
  }
}

/** The "was interrupted" note a saved record calls for, if any. */
function noteOf(rec: SavedSession): InterruptedNote | undefined {
  if (!rec.interrupted && rec.pendingAtClose.length === 0) return undefined
  return { closedAt: rec.interruptedAt ?? rec.lastActiveAt, pending: rec.pendingAtClose.map((p) => ({ ...p })) }
}

/** The questions of an earlier note, then the ones waiting now. */
function mergePending(earlier: readonly SavedPendingRequest[], now: readonly SavedPendingRequest[]): SavedPendingRequest[] {
  const out = earlier.map((p) => ({ ...p }))
  for (const p of now) if (!out.some((o) => o.question === p.question && o.askedAt === p.askedAt)) out.push(p)
  return out
}

/** Validates a restore settings patch from the renderer. Returns null if it isn't one (unknown keys included). */
export function parseRestoreSettingsPatch(input: unknown): Partial<RestoreSettings> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as Record<string, unknown>
  for (const key of Object.keys(o)) if (key !== 'mode') return null
  if (o.mode === undefined) return {}
  return RESTORE_MODES.includes(o.mode as RestoreMode) ? { mode: o.mode as RestoreMode } : null
}
