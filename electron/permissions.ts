// Pending permission requests of hosted sessions. A driver adds a request with a resolver callback
// (`onResolved`) and holds the agent's question open until the CEO office decides, or until the
// agent gives up on us (answered in the terminal, hook timeout, interrupt). What "holding open"
// means is the driver's business: for Claude Code it is the PermissionRequest hook's HTTP response
// (with an abort signal when Claude hangs up), for Codex a JSON-RPC server request that is
// answered on the app-server pipe. The registry knows neither.
//
// Decisions only ever arrive through `decide()`, which the main process calls from renderer IPC.
// No Electron imports: the tests load this file under plain Node.
import type {
  PermissionDecision,
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderId
} from '../shared/sessions'
import { asPermissionRisk, type PermissionRisk } from '../shared/permissionText'
import {
  approvalVerdict,
  DEFAULT_APPROVAL_MODE,
  HELD_APPROVAL_TTL_MS,
  HELD_MESSAGE,
  MAX_AUTO_KEPT,
  MAX_HELD,
  type ApprovalMode,
  type AutoAllowed,
  type HeldRequest
} from '../shared/approvals'

export const PERMISSION_DETAIL_MAX = 4096
export const PERMISSION_QUESTION_MAX = 240
export const PERMISSION_RISK_NOTE_MAX = 60
export const PERMISSION_SUMMARY_MAX = 200
export const DENY_MESSAGE_MAX = 1000
export const DEFAULT_DENY_MESSAGE = 'Denied from the Agent Office CEO desk.'
const MAX_PENDING = 200
const REMEMBER_RESOLVED = 200

export interface NewPermission {
  sessionId: string
  agentId: string
  displayName: string
  provider: ProviderId
  toolName: string
  summary: string
  detail: string
  /** The plain one-sentence question (shared/permissionText.ts). Default: the summary. */
  question?: string
  risk?: PermissionRisk
  riskNote?: string
  /** Routine work inside the project (PlainPermission.routine): may be allowed without asking. */
  routine?: boolean
}

/** How the registry is told what the user wants to be asked about (shared/approvals.ts). */
export interface ApprovalOptions {
  /** The current mode; read on every request so a change applies to the next one. */
  mode?: () => ApprovalMode
  /** A request was allowed without asking. */
  onAuto?: (entry: AutoAllowed) => void
  /** The list of held (dangerous, saved for the user) requests changed. */
  onHeld?: (held: HeldRequest[]) => void
  now?: () => number
}

export interface PermissionHandlers {
  /** Called exactly once when the request leaves the registry, however it was resolved. */
  onResolved(outcome: PermissionOutcome, decision: PermissionDecision | null): void
  /**
   * Optional: aborts when the agent stops waiting for us (e.g. Claude Code closed the hook
   * connection). Drivers that learn it another way call `resolveElsewhere()` / `clearSession()`.
   */
  signal?: AbortSignal
}

interface Pending {
  info: PermissionRequestInfo
  handlers: PermissionHandlers
  unlisten: () => void
  routine: boolean
}

/** Identifies "the same request again" (an agent retrying a held action the user approved). */
const retryKey = (info: { sessionId: string; toolName: string; summary: string }): string =>
  `${info.sessionId}\n${info.toolName}\n${info.summary}`

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** Validates a decision coming from the renderer. Returns null if it isn't one. */
export function parsePermissionDecision(input: unknown): PermissionDecision | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (o.behavior === 'allow') return { behavior: 'allow' }
  if (o.behavior === 'deny') {
    if (o.message !== undefined && typeof o.message !== 'string') return null
    const message = typeof o.message === 'string' ? o.message.trim().slice(0, DENY_MESSAGE_MAX) : ''
    return message ? { behavior: 'deny', message } : { behavior: 'deny' }
  }
  return null
}

/** Pretty-printed tool input for the approval card, truncated. */
export function describeToolInput(toolInput: unknown): string {
  let text: string
  try {
    text = typeof toolInput === 'string' ? toolInput : (JSON.stringify(toolInput, null, 2) ?? '')
  } catch {
    text = ''
  }
  return truncate(text, PERMISSION_DETAIL_MAX)
}

export class PermissionRegistry {
  private pending = new Map<string, Pending>()
  /** Ids that were resolved recently, so a late click gets a precise answer. */
  private resolved = new Map<string, PermissionOutcome>()
  private seq = 0
  /** Allowed without asking, newest first. */
  private auto: AutoAllowed[] = []
  /** Dangerous requests refused for now and saved for the user (auto mode). */
  private held = new Map<string, HeldRequest>()
  /** Held requests the user approved: the agent's retry is let through once, until the grant expires. */
  private grants = new Map<string, number>()

  constructor(
    private onChange: (pending: PermissionRequestInfo[]) => void = () => {},
    private approvals: ApprovalOptions = {}
  ) {}

  private now(): number {
    return this.approvals.now ? this.approvals.now() : Date.now()
  }

  /** What the user wants to be asked about. Without options: everything (the old behaviour). */
  mode(): ApprovalMode {
    return this.approvals.mode ? this.approvals.mode() : 'all'
  }

  // ---- allowed / held without the user ---------------------------------------------------------

  recentAuto(): AutoAllowed[] {
    return this.auto.map((e) => ({ ...e }))
  }

  listHeld(): HeldRequest[] {
    return [...this.held.values()].map((h) => ({ ...h })).sort((a, b) => b.heldAt - a.heldAt)
  }

  /**
   * The user approved a held request. The caller tells the agent; this lets the agent's retry of
   * the same request through once. Returns the request, or null if it is not held (any more).
   * Only reachable from renderer IPC.
   */
  approveHeld(id: unknown): HeldRequest | null {
    if (typeof id !== 'string') return null
    const h = this.held.get(id)
    if (!h || h.approvedAt) return null
    h.approvedAt = this.now()
    this.grants.set(retryKey(h), h.approvedAt + HELD_APPROVAL_TTL_MS)
    this.heldChanged()
    return { ...h }
  }

  /** The user does not want it done (or it is no longer relevant). Only reachable from renderer IPC. */
  dismissHeld(id: unknown): boolean {
    if (typeof id !== 'string') return false
    const h = this.held.get(id)
    if (!h) return false
    this.held.delete(id)
    this.grants.delete(retryKey(h))
    this.heldChanged()
    return true
  }

  /** Held requests of a session that ended can no longer be approved. */
  dropHeld(sessionId: string): void {
    let n = 0
    for (const [id, h] of [...this.held]) {
      if (h.sessionId !== sessionId) continue
      this.held.delete(id)
      this.grants.delete(retryKey(h))
      n++
    }
    if (n > 0) this.heldChanged()
  }

  /**
   * The user changed the mode: requests already waiting are settled by the new rule (allowed, or
   * held if dangerous in auto mode). Asking for more never un-answers anything.
   */
  applyMode(): void {
    const mode = this.mode()
    for (const [id, p] of [...this.pending]) {
      const verdict = approvalVerdict(mode, { risk: p.info.risk, routine: p.routine })
      if (verdict === 'allow') {
        this.recordAuto(p.info, mode === 'auto' ? 'auto' : 'important')
        this.finish(id, p, 'allowed', { behavior: 'allow' }, false)
      } else if (verdict === 'hold') {
        this.hold(p.info)
        this.finish(id, p, 'denied', { behavior: 'deny', message: HELD_MESSAGE }, false)
      }
    }
    this.changed()
  }

  /**
   * What `add()` would do with such a request, without doing it: lets a driver skip the "waiting on
   * the user" animation for something the user is not going to be asked about.
   */
  peek(req: { sessionId: string; toolName: string; summary: string; risk?: PermissionRisk; routine?: boolean }): 'ask' | 'allow' | 'hold' {
    const summary = truncate(req.summary.replace(/\s+/g, ' ').trim(), PERMISSION_SUMMARY_MAX)
    const until = this.grants.get(retryKey({ sessionId: req.sessionId, toolName: truncate(req.toolName, 200), summary }))
    if (until !== undefined && until >= this.now()) return 'allow'
    return approvalVerdict(this.mode(), { risk: asPermissionRisk(req.risk), routine: req.routine === true })
  }

  private takeGrant(key: string): boolean {
    const until = this.grants.get(key)
    if (until === undefined) return false
    this.grants.delete(key)
    for (const [id, h] of this.held) {
      if (h.approvedAt && retryKey(h) === key) {
        this.held.delete(id)
        this.heldChanged()
        break
      }
    }
    return until >= this.now()
  }

  private recordAuto(info: PermissionRequestInfo, mode: AutoAllowed['mode']): void {
    const entry: AutoAllowed = {
      id: `auto-${this.now().toString(36)}-${(++this.seq).toString(36)}`,
      sessionId: info.sessionId,
      agentId: info.agentId,
      displayName: info.displayName,
      provider: info.provider,
      question: info.question,
      toolName: info.toolName,
      at: this.now(),
      mode
    }
    this.auto.unshift(entry)
    if (this.auto.length > MAX_AUTO_KEPT) this.auto.length = MAX_AUTO_KEPT
    try {
      this.approvals.onAuto?.({ ...entry })
    } catch (err) {
      console.error('[agent-office] auto-approval listener failed:', err instanceof Error ? err.message : err)
    }
  }

  private hold(info: PermissionRequestInfo): void {
    const key = retryKey(info)
    // The agent asked again although it was told to wait: one row, not two.
    for (const h of this.held.values()) {
      if (!h.approvedAt && retryKey(h) === key) {
        h.heldAt = this.now()
        this.heldChanged()
        return
      }
    }
    const id = `held-${this.now().toString(36)}-${(++this.seq).toString(36)}`
    const h: HeldRequest = {
      id,
      sessionId: info.sessionId,
      agentId: info.agentId,
      displayName: info.displayName,
      provider: info.provider,
      toolName: info.toolName,
      question: info.question,
      risk: info.risk,
      summary: info.summary,
      detail: info.detail,
      heldAt: this.now()
    }
    if (info.riskNote) h.riskNote = info.riskNote
    this.held.set(id, h)
    while (this.held.size > MAX_HELD) this.held.delete(this.held.keys().next().value as string)
    this.heldChanged()
  }

  private heldChanged(): void {
    try {
      this.approvals.onHeld?.(this.listHeld())
    } catch (err) {
      console.error('[agent-office] held-request listener failed:', err instanceof Error ? err.message : err)
    }
  }

  /** Pending requests, oldest first. */
  list(): PermissionRequestInfo[] {
    return [...this.pending.values()].map((p) => ({ ...p.info }))
  }

  /** One pending request, as the renderer sees it. */
  get(id: string): PermissionRequestInfo | undefined {
    const p = this.pending.get(id)
    return p ? { ...p.info } : undefined
  }

  count(sessionId: string): number {
    let n = 0
    for (const p of this.pending.values()) if (p.info.sessionId === sessionId) n++
    return n
  }

  /**
   * Registers a request. Returns its id, or null when it could not be held (the agent already gave
   * up, or too many are pending); `onResolved('resolved-elsewhere')` has then been called.
   */
  add(req: NewPermission, handlers: PermissionHandlers): string | null {
    if (handlers.signal?.aborted || this.pending.size >= MAX_PENDING) {
      handlers.onResolved('resolved-elsewhere', null)
      return null
    }
    const id = `perm-${Date.now().toString(36)}-${(++this.seq).toString(36)}`
    const onAbort = () => this.resolveElsewhere(id)
    handlers.signal?.addEventListener('abort', onAbort, { once: true })
    const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
    const summary = truncate(oneLine(req.summary), PERMISSION_SUMMARY_MAX)
    const info: PermissionRequestInfo = {
      id,
      sessionId: req.sessionId,
      agentId: req.agentId,
      displayName: truncate(req.displayName, 100),
      provider: req.provider,
      toolName: truncate(req.toolName, 200),
      summary,
      detail: truncate(req.detail, PERMISSION_DETAIL_MAX),
      question: truncate(oneLine(req.question ?? '') || summary, PERMISSION_QUESTION_MAX),
      risk: asPermissionRisk(req.risk),
      createdAt: Date.now()
    }
    const note = oneLine(req.riskNote ?? '')
    if (note && info.risk !== 'normal') info.riskNote = truncate(note, PERMISSION_RISK_NOTE_MAX)

    // What the user asked to be bothered with (shared/approvals.ts). The rule looks at the request
    // exactly as the card would show it; a dangerous one is never allowed here.
    const routine = req.routine === true
    const mode = this.mode()
    const granted = this.takeGrant(retryKey(info)) // the user approved this held request: its retry
    const verdict = granted ? 'allow' : approvalVerdict(mode, { risk: info.risk, routine })
    if (verdict !== 'ask') {
      handlers.signal?.removeEventListener('abort', onAbort)
      if (verdict === 'allow') this.recordAuto(info, granted ? 'held' : mode === 'auto' ? 'auto' : 'important')
      else this.hold(info)
      try {
        if (verdict === 'allow') handlers.onResolved('allowed', { behavior: 'allow' })
        else handlers.onResolved('denied', { behavior: 'deny', message: HELD_MESSAGE })
      } catch (err) {
        console.error('[agent-office] permission handler failed:', err instanceof Error ? err.message : err)
      }
      return null
    }

    this.pending.set(id, {
      info,
      handlers,
      routine,
      unlisten: () => handlers.signal?.removeEventListener('abort', onAbort)
    })
    this.changed()
    return id
  }

  /** The CEO office decided. Only reachable from renderer IPC. */
  decide(id: unknown, decision: unknown): PermissionOutcome {
    if (typeof id !== 'string') return 'unknown-request'
    const d = parsePermissionDecision(decision)
    if (!d) throw new Error('invalid permission decision')
    const p = this.pending.get(id)
    if (!p) return this.resolved.get(id) ?? 'unknown-request'
    const outcome: PermissionOutcome = d.behavior === 'allow' ? 'allowed' : 'denied'
    this.finish(id, p, outcome, d)
    return outcome
  }

  /** The agent no longer waits for us: answered in the terminal, timed out, or interrupted. */
  resolveElsewhere(id: string): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.finish(id, p, 'resolved-elsewhere', null)
    return true
  }

  /** Drops the pending requests of a session (session ended), or of one of its agents (turn ended). */
  clearSession(sessionId: string, agentId?: string): number {
    let n = 0
    for (const [id, p] of [...this.pending]) {
      if (p.info.sessionId !== sessionId) continue
      if (agentId !== undefined && p.info.agentId !== agentId) continue
      this.finish(id, p, 'resolved-elsewhere', null, false)
      n++
    }
    if (n > 0) this.changed()
    return n
  }

  private finish(id: string, p: Pending, outcome: PermissionOutcome, decision: PermissionDecision | null, notify = true): void {
    this.pending.delete(id)
    p.unlisten()
    // A second answer to the same request finds it already settled.
    this.resolved.set(id, 'resolved-elsewhere')
    if (this.resolved.size > REMEMBER_RESOLVED) this.resolved.delete(this.resolved.keys().next().value as string)
    try {
      p.handlers.onResolved(outcome, decision)
    } catch (err) {
      console.error('[agent-office] permission handler failed:', err instanceof Error ? err.message : err)
    }
    if (notify) this.changed()
  }

  private changed(): void {
    this.onChange(this.list())
  }
}
