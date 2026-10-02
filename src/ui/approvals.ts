// What the user is asked about ("everything", "important things only", or nothing: muted) and the
// list of what was allowed without asking. Pure helpers (no DOM, no React), covered by
// tests/inspect.test.ts.
//
// The main process owns the mode (RendererSettings.approvalMode) and the audit trail
// (permissions.recentAuto / onAuto). Everything here tolerates a main process without them.
// A dangerous request is never allowed automatically, in any mode: it always arrives as a card.

/**
 * all:       every permission request comes to the user
 * important: routine work inside the project is allowed automatically
 * auto:      muted: everything except dangerous requests is allowed automatically
 */
export type ApprovalMode = 'all' | 'important' | 'auto'

/** A request the app allowed by itself. */
export interface AutoAllowed {
  id: string
  sessionId: string
  agentId: string
  displayName: string
  provider: string
  question: string
  toolName: string
  at: number
  /** Why it was allowed: routine work ('important'), or because the inbox was muted ('auto'). */
  mode?: 'important' | 'auto'
}

/** The bridge calls of the approval mode, all optional (an older main process has none). */
export interface ApprovalsBridge {
  setApprovalMode?: (mode: ApprovalMode) => Promise<unknown>
  recentAuto?: () => Promise<AutoAllowed[]>
  onAuto?: (cb: (entry: AutoAllowed) => void) => () => void
}

/** Picks the approval calls off a bridge, wherever this build has them. */
export function approvalsBridge(bridge: unknown): ApprovalsBridge {
  const b = (bridge ?? {}) as { setApprovalMode?: unknown; permissions?: { setApprovalMode?: unknown; recentAuto?: unknown; onAuto?: unknown } }
  const perms = b.permissions
  // The setter sits next to setAllowOrders; one under `permissions` is accepted as well.
  const set = typeof b.setApprovalMode === 'function' ? b.setApprovalMode.bind(b) : perms && typeof perms.setApprovalMode === 'function' ? perms.setApprovalMode.bind(perms) : undefined
  return {
    setApprovalMode: set as ApprovalsBridge['setApprovalMode'],
    recentAuto: perms && typeof perms.recentAuto === 'function' ? (perms.recentAuto.bind(perms) as ApprovalsBridge['recentAuto']) : undefined,
    onAuto: perms && typeof perms.onAuto === 'function' ? (perms.onAuto.bind(perms) as ApprovalsBridge['onAuto']) : undefined
  }
}

export function isApprovalMode(v: unknown): v is ApprovalMode {
  return v === 'important' || v === 'all' || v === 'auto'
}

/** In the order the "Ask me about" control shows them. */
export const APPROVAL_MODES: readonly { value: ApprovalMode; label: string; status: string; help: string }[] = [
  {
    value: 'important',
    label: 'Important things only',
    status: 'Approvals: important only',
    help:
      'Routine work inside the project (reading and editing files, tests, builds, searches) is allowed automatically. ' +
      'Installs, deletes, pushes, anything outside the project and anything unusual still comes to you.'
  },
  { value: 'all', label: 'Everything', status: 'Approvals: everything', help: 'Every permission request comes to you, routine ones too.' },
  {
    value: 'auto',
    label: 'Only dangerous things',
    status: 'Approvals: automatic',
    help:
      'Requests are allowed for you and listed below. A dangerous one is not done: it is saved under "Held for you" ' +
      'and the team carries on with its other work until you approve or dismiss it.'
  }
]

const modeDef = (mode: ApprovalMode) => APPROVAL_MODES.find((m) => m.value === mode) ?? APPROVAL_MODES[0]

/** "Approvals: important only" for the status bar. */
export function approvalStatus(mode: ApprovalMode): string {
  return modeDef(mode).status
}

/** The one line under the "Ask me about" control. */
export function approvalHelp(mode: ApprovalMode): string {
  return modeDef(mode).help
}

export const isMuted = (mode: ApprovalMode | null | undefined): boolean => mode === 'auto'

export const MUTE_TITLE = 'Approve for me (dangerous requests are held for you, not done)'
export const UNMUTE_TITLE = 'Ask me again before things are done'
export const MUTED_HEAD = 'Approving for you'

/** The mode to go back to when nothing (valid) was remembered. */
export const DEFAULT_UNMUTED: Exclude<ApprovalMode, 'auto'> = 'important'

/**
 * The mute button: muting remembers the mode that was active, unmuting goes back to it.
 * `remembered` is whatever was stored last time (anything: it comes from localStorage).
 */
export function toggleMute(current: ApprovalMode, remembered: unknown): { next: ApprovalMode; remember: Exclude<ApprovalMode, 'auto'> } {
  const prev: Exclude<ApprovalMode, 'auto'> = remembered === 'all' || remembered === 'important' ? remembered : DEFAULT_UNMUTED
  if (current === 'auto') return { next: prev, remember: prev }
  return { next: 'auto', remember: current }
}

/** Does a pending request deserve the inbox's attention (auto-open, pulse)? While muted only a dangerous one does. */
export function wantsAttention(mode: ApprovalMode | null | undefined, risk: string | undefined): boolean {
  return mode === 'auto' ? risk === 'danger' : true
}

/** How many handled requests are kept and how many the inbox shows. */
export const HANDLED_KEEP = 50
export const HANDLED_VISIBLE = 20

function valid(e: unknown): e is AutoAllowed {
  const o = e as Partial<AutoAllowed> | null
  return !!o && typeof o.id === 'string' && typeof o.sessionId === 'string' && typeof o.at === 'number' && Number.isFinite(o.at)
}

/**
 * Adds entries to the handled list: newest first, one row per id (a repeated id keeps its newest
 * copy), capped. Malformed entries are dropped.
 */
export function pushHandled(list: readonly AutoAllowed[], add: readonly unknown[], keep = HANDLED_KEEP): AutoAllowed[] {
  const byId = new Map<string, AutoAllowed>()
  for (const e of [...list, ...add]) {
    if (!valid(e)) continue
    const prev = byId.get(e.id)
    if (!prev || e.at >= prev.at) byId.set(e.id, e)
  }
  return [...byId.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).slice(0, Math.max(0, keep))
}

/** The rows the inbox shows (newest first) and how many more there are. */
export function handledRows(list: readonly AutoAllowed[], visible = HANDLED_VISIBLE): { rows: AutoAllowed[]; more: number } {
  const rows = list.slice(0, Math.max(0, visible))
  return { rows, more: list.length - rows.length }
}

/**
 * The action of a handled question without its subject: "frontend wants to run the tests." ->
 * "run the tests". Falls back to the whole question, then the tool name.
 */
export function handledAction(e: Pick<AutoAllowed, 'question' | 'toolName'>): string {
  const q = (e.question ?? '').trim().replace(/\.$/, '')
  const m = /\bwants to\s+(.*)$/i.exec(q)
  if (m && m[1]) return m[1]
  return q || e.toolName || 'a routine request'
}

/** The small tag on a handled row: why it was allowed without asking. */
export function handledTag(e: Pick<AutoAllowed, 'mode'>): { text: string; tone: 'muted' | 'routine' } {
  return e.mode === 'auto' ? { text: 'muted', tone: 'muted' } : { text: 'routine', tone: 'routine' }
}
