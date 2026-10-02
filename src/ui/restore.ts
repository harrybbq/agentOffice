// Pure helpers for "remember where I left off" (shared/restore.ts): sleeping rows, the "was
// interrupted" note, the Recent list. No DOM, no React. Covered by tests/restoreui.test.ts.
import type { RestoreMode, SavedSession } from '../../shared/restore'
import type { SessionInfo } from '../../shared/sessions'
import { whenAgo } from './format'

export const isAsleep = (s: Pick<SessionInfo, 'state'> | null | undefined): boolean => s?.state === 'asleep'

/** Only an explicit `false` blocks waking: a main process that doesn't say is taken at its word. */
export const canWakeRow = (s: Pick<SessionInfo, 'state' | 'wakeable'>): boolean => s.state === 'asleep' && s.wakeable !== false

/** Is a process behind this row (so it counts as running and can take orders)? */
export const isLive = (s: Pick<SessionInfo, 'state'>): boolean => s.state !== 'exited' && s.state !== 'asleep'

/** "last active 2 h ago"; empty when the time is unknown. */
export function lastActiveLabel(ts: number | undefined, now = Date.now()): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
  return `last active ${whenAgo(Math.min(ts, now), now)}`
}

/** "ended 3 h ago" for a Recent entry. */
export function endedLabel(ts: number | undefined, now = Date.now()): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
  return `ended ${whenAgo(Math.min(ts, now), now)}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export interface RestoreSummary {
  restored: number
  interrupted: number
  /** Permission requests that were waiting when the app closed. */
  lost: number
  /** "3 sessions restored · 2 were interrupted · 2 requests were lost" */
  text: string
  /** The first interrupted session in the order given (the sidebar's). */
  firstInterruptedId: string
  /** When the app closed (the newest note): the summary is shown once per close. */
  closedAt: number
}

/**
 * The one-time launch summary, or null when no restored session was interrupted. A row counts as
 * restored when it is asleep, carries a note, or was started before the app last closed.
 * Pass the sessions in sidebar order.
 */
export function restoreSummary(sessions: readonly SessionInfo[]): RestoreSummary | null {
  const noted = sessions.filter((s) => s.interruptedNote)
  if (noted.length === 0) return null
  const closedAt = Math.max(...noted.map((s) => s.interruptedNote!.closedAt))
  const restored = sessions.filter((s) => s.state === 'asleep' || s.interruptedNote || s.startedAt < closedAt).length
  const lost = noted.reduce((n, s) => n + (s.interruptedNote!.pending?.length ?? 0), 0)
  const parts = [`${plural(restored, 'session', 'sessions')} restored`, `${noted.length} ${noted.length === 1 ? 'was' : 'were'} interrupted`]
  if (lost > 0) parts.push(`${plural(lost, 'request was', 'requests were')} lost`)
  return { restored, interrupted: noted.length, lost, text: parts.join(' · '), firstInterruptedId: noted[0].id, closedAt }
}

/** "Agent Office closed while this session was working (2 h ago)." */
export function interruptedHeadline(closedAt: number, now = Date.now()): string {
  const when = Number.isFinite(closedAt) && closedAt > 0 ? ` (${whenAgo(Math.min(closedAt, now), now)})` : ''
  return `Agent Office closed while this session was working${when}.`
}

export const PENDING_SHOWN = 5

/** The saved questions for the note: the first few, and how many more there were. */
export function pendingPreview(pending: readonly { question: string }[] | undefined, max = PENDING_SHOWN): { shown: string[]; more: number } {
  const all = (pending ?? []).map((p) => p.question?.trim()).filter((q): q is string => !!q)
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) }
}

/** The short marker under an interrupted row: "Interrupted · 2 requests lost". */
export function interruptedTag(note: NonNullable<SessionInfo['interruptedNote']>): string {
  const n = note.pending?.length ?? 0
  return n > 0 ? `Interrupted · ${plural(n, 'request', 'requests')} lost` : 'Interrupted'
}

export type PanelContent =
  | 'wake' //      an asleep row: the wake screen
  | 'terminal' //  a live or exited session with a terminal
  | 'chat' //      a live or exited session with a chat
  | 'empty' //     nothing hosted is selected

/** What the first panel tab shows for the selected session. An asleep row never attaches anything. */
export function panelContent(session: Pick<SessionInfo, 'state' | 'surface'> | null | undefined): PanelContent {
  if (!session) return 'empty'
  if (session.state === 'asleep') return 'wake'
  return session.surface === 'chat' ? 'chat' : 'terminal'
}

/** "Tell it to continue" needs a session that is waiting for a prompt. */
export function canContinue(session: Pick<SessionInfo, 'state'>): boolean {
  return session.state === 'idle'
}

/**
 * The session to select at launch: the one selected last time if it is still there; otherwise the
 * first interrupted one, then the restored (asleep) row that was active last. null = select
 * nothing. Pass the sessions in sidebar order.
 */
export function restoreSelection(savedId: unknown, sessions: readonly SessionInfo[]): string | null {
  if (typeof savedId === 'string' && sessions.some((s) => s.id === savedId)) return savedId
  const interrupted = sessions.find((s) => s.interruptedNote)
  if (interrupted) return interrupted.id
  let best: SessionInfo | null = null
  for (const s of sessions) {
    if (s.state !== 'asleep') continue
    if (!best || (s.lastActiveAt ?? s.startedAt) > (best.lastActiveAt ?? best.startedAt)) best = s
  }
  return best?.id ?? null
}

// ---- Recent list --------------------------------------------------------------------------------

export interface RecentState {
  /** As the main process last sent them. */
  items: readonly SavedSession[]
  /** Entries the user forgot that the main process has not confirmed yet (hidden meanwhile). */
  forgetting: ReadonlySet<string>
}

export const EMPTY_RECENT: RecentState = { items: [], forgetting: new Set() }

export type RecentAction =
  | { type: 'loaded'; items: readonly SavedSession[] }
  | { type: 'forget'; id: string } //     optimistic: hide it now
  | { type: 'forgotten'; id: string } //  the main process confirmed
  | { type: 'rollback'; id: string } //   it refused or failed: show it again
  | { type: 'reopened'; id: string } //   it is a live session now

export function recentReducer(state: RecentState, action: RecentAction): RecentState {
  const without = (id: string): ReadonlySet<string> => {
    if (!state.forgetting.has(id)) return state.forgetting
    const next = new Set(state.forgetting)
    next.delete(id)
    return next
  }
  switch (action.type) {
    case 'loaded': {
      const items = action.items.filter((x) => x && typeof x.id === 'string')
      // An answer from before the forget still lists the entry: it stays hidden until confirmed.
      const present = new Set(items.map((x) => x.id))
      const forgetting = [...state.forgetting].every((id) => present.has(id)) ? state.forgetting : new Set([...state.forgetting].filter((id) => present.has(id)))
      return { items, forgetting }
    }
    case 'forget':
      if (state.forgetting.has(action.id) || !state.items.some((x) => x.id === action.id)) return state
      return { items: state.items, forgetting: new Set([...state.forgetting, action.id]) }
    case 'rollback':
      return state.forgetting.has(action.id) ? { items: state.items, forgetting: without(action.id) } : state
    case 'forgotten':
    case 'reopened':
      if (!state.items.some((x) => x.id === action.id) && !state.forgetting.has(action.id)) return state
      return { items: state.items.filter((x) => x.id !== action.id), forgetting: without(action.id) }
  }
}

/** What the Recent section lists: newest first, without the entries being forgotten. */
export function visibleRecent(state: RecentState): SavedSession[] {
  return state.items.filter((x) => !state.forgetting.has(x.id)).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
}

// ---- settings -----------------------------------------------------------------------------------

export const RESTORE_MODES: { id: RestoreMode; label: string; short: string }[] = [
  { id: 'last', label: 'Wake the last session', short: 'wake last' },
  { id: 'all', label: 'Wake all sessions', short: 'wake all' },
  { id: 'none', label: 'Wake none', short: 'wake none' }
]

export function restoreModeShort(mode: RestoreMode | undefined): string {
  return RESTORE_MODES.find((m) => m.id === mode)?.short ?? 'wake last'
}
