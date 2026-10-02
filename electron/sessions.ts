// Session manager: the sessions the app launched itself, whatever the provider. It validates every
// request from the renderer, owns the fixed provider table, routes terminal I/O, chat events and
// chat input, permission decisions and CEO orders, and tells the renderer when anything changes.
// A session's surface is a terminal (Claude Code) or the chat view (Codex); see drivers/types.ts.
//
// Security rules (shared/sessions.ts): the renderer picks a provider id and a folder, never a
// command, args or env; approvals and orders arrive over renderer IPC only.
//
// No Electron imports (main.ts and sessionsIpc.ts do the wiring), so tests can drive it with fakes.
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { CHAT_MAX_PROMPT_CHARS, type ChatEvent, type ChatItem } from '../shared/chat'
import { planOrder, REASON_NOT_CONNECTED, type OrderResult } from '../shared/orders'
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
import type { AgentDriver, ProviderDefinition, PtyHost, ValidatedStart } from './drivers/types'
import { parsePermissionDecision, PermissionRegistry } from './permissions'
import { PTY_MAX_WRITE_CHARS } from './ptyProtocol'
import { assignTitles } from './sessionTitles'

export const MAX_LIVE_SESSIONS = 8
/** An exited session stays in the list this long, so its last screen and exit code can be seen. */
export const EXITED_RETENTION_MS = 60_000
const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']
const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity'
}
/** Providers without a driver yet, and the phase that brings it. */
const COMING: Partial<Record<ProviderId, string>> = {
  antigravity: 'driver coming in phase C'
}

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
}

const cleanText = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()

export class SessionManager implements HostedSessions {
  readonly permissions: PermissionRegistry
  private sessions = new Map<string, Session>()
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
    this.permissions = new PermissionRegistry((pending) => opts.onPermissionsChanged(pending))
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

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s))
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
    const live = [...this.sessions.values()].filter((s) => s.driver.state !== 'exited').length
    if (live >= MAX_LIVE_SESSIONS) throw new Error(`too many sessions (at most ${MAX_LIVE_SESSIONS} at a time)`)

    const id = `s-${randomBytes(6).toString('hex')}`
    const driver = def.createDriver!({
      sessionId: id,
      start,
      pty: this.opts.pty,
      sink: this.opts.sink,
      permissions: this.permissions,
      events: {
        onState: () => this.changed(),
        onProviderSession: () => this.changed(),
        onModel: (model) => this.onModel(id, model),
        onChanged: () => this.changed(),
        onExit: (code) => this.onExit(id, code),
        onChat: (e) => {
          if (this.chatAttached.has(id)) this.opts.onChatEvent?.(e)
        }
      }
    })
    const session: Session = { id, start, startedAt: Date.now(), title: start.title, driver }
    this.sessions.set(id, session)
    this.retitle() // another live session may already go by this name
    try {
      await driver.start()
    } catch (err) {
      this.sessions.delete(id)
      this.retitle()
      throw err instanceof Error ? err : new Error('could not start the session')
    }
    this.changed()
    return this.info(session)
  }

  private onModel(id: string, model: string): void {
    const s = this.sessions.get(id)
    if (!s || s.model === model) return
    s.model = model
    this.retitle()
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
    }
  }

  private onExit(id: string, exitCode: number | null): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.exitCode = exitCode
    s.removeTimer = setTimeout(() => this.remove(id), EXITED_RETENTION_MS)
    s.removeTimer.unref?.()
    this.changed()
  }

  private remove(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.removeTimer) clearTimeout(s.removeTimer)
    this.sessions.delete(id)
    this.attached.delete(id)
    this.chatAttached.delete(id)
    if (s.driver.surface === 'terminal') this.opts.pty.dispose(id)
    this.changed()
  }

  private get(id: unknown): Session {
    const s = typeof id === 'string' && id.length <= 64 ? this.sessions.get(id) : undefined
    if (!s) throw new Error('unknown session')
    return s
  }

  /** Asks the agent to exit and kills its process tree if it doesn't. An exited session is removed. */
  async stop(id: unknown): Promise<void> {
    const s = this.get(id)
    if (s.driver.state === 'exited') return this.remove(s.id)
    await s.driver.stop()
  }

  interrupt(id: unknown): void {
    this.get(id).driver.interrupt()
  }

  // ---- hooks (HostedSessions, used by the /hooks/claude-code adapter) ----

  hookTarget(sessionId: string): HostedHookTarget | undefined {
    const driver = this.sessions.get(sessionId)?.driver as (AgentDriver & Partial<HostedHookTarget>) | undefined
    return driver && typeof driver.handleHook === 'function' ? (driver as AgentDriver & HostedHookTarget) : undefined
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
    const hostedIds = new Set(this.sessions.keys())
    // Sessions the app didn't start are valid targets by name, but nothing can be delivered to them.
    const external = this.opts.worldTopLevel().filter((k) => !hostedIds.has(k.id))
    const plan = planOrder(input, { allowOrders: this.opts.allowOrders(), known: [...hosted, ...external] })
    if (!plan.ok) return plan.result
    const result: OrderResult = { delivered: [], failed: [] }
    await Promise.all(
      plan.targets.map(async (id) => {
        const s = this.sessions.get(id)
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
    return result
  }

  // ---- lifecycle ----

  /** Stops taking new sessions. The pty host (killed by the caller) takes the terminal processes down. */
  close(): void {
    this.closing = true
    for (const s of this.sessions.values()) if (s.removeTimer) clearTimeout(s.removeTimer)
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
