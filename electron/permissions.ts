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
}

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

  constructor(private onChange: (pending: PermissionRequestInfo[]) => void = () => {}) {}

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
    this.pending.set(id, {
      info,
      handlers,
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
