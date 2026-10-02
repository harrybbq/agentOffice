// Pure helpers for the shell (no DOM, no React): formatting, order targets, list shaping.
// Covered by tests/ui.test.ts.
import type { AgentEvent, Activity } from '../../shared/events'
import type { OrderResult } from '../../shared/orders'
import { PROVIDER_TARGET_PREFIX } from '../../shared/orders'
import type { PermissionRequestInfo, ProviderInfo, SessionInfo, SessionState } from '../../shared/sessions'

/** The slice of a world team the shell needs (see scene/OfficeScene TeamInfo). */
export interface TeamLike {
  id: string
  name: string
  provider: string
  color: string
  workers: number
  live: boolean
}

export interface WaitingLike {
  agentId: string
  teamId: string
  displayName: string
  detail: string
  since: number
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** "C:\Users\me\src\repos\app" -> "…\repos\app"; home becomes "~". Keeps the last `keep` parts. */
export function shortenPath(path: string, keep = 2): string {
  if (!path) return ''
  const sep = path.includes('\\') ? '\\' : '/'
  const home = path.match(/^(?:[A-Za-z]:\\Users\\[^\\]+|\/(?:home|Users)\/[^/]+)/)?.[0]
  let rest = path
  let prefix = ''
  if (home) {
    rest = path.slice(home.length)
    prefix = '~'
  }
  const parts = rest.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= keep) {
    if (prefix) return [prefix, ...parts].join(sep)
    return path
  }
  return ['…', ...parts.slice(-keep)].join(sep)
}

export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export const STATE_LABEL: Record<SessionState, string> = {
  starting: 'Starting',
  'needs-attention': 'Needs attention',
  idle: 'Idle',
  busy: 'Working',
  'waiting-permission': 'Waiting for permission',
  exited: 'Exited'
}

export interface ProviderGroup {
  provider: ProviderInfo
  sessions: SessionInfo[]
}

/** Sidebar groups: every known provider (even unavailable ones), sessions in start order. */
export function groupSessions(providers: readonly ProviderInfo[], sessions: readonly SessionInfo[]): ProviderGroup[] {
  const groups: ProviderGroup[] = providers.map((p) => ({ provider: p, sessions: [] }))
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt)
  for (const s of sorted) {
    let g = groups.find((x) => x.provider.id === s.provider)
    if (!g) {
      g = { provider: { id: s.provider, label: s.provider, available: true }, sessions: [] }
      groups.push(g)
    }
    g.sessions.push(s)
  }
  return groups
}

/** Sessions in the order the sidebar shows them (Ctrl+1..9). */
export function sessionOrder(providers: readonly ProviderInfo[], sessions: readonly SessionInfo[]): SessionInfo[] {
  return groupSessions(providers, sessions).flatMap((g) => g.sessions)
}

export interface OrderTargetOption {
  value: string
  label: string
  group: 'everyone' | 'provider' | 'session'
  /** Sessions the world should fly an envelope to. */
  ids: string[]
}

const providerLabel = (providers: readonly ProviderInfo[], id: string): string =>
  providers.find((p) => p.id === id)?.label ?? id

/**
 * Order bar targets: Everyone, one entry per provider with a live session, then each live session.
 * Hosted sessions come from the session list; world-only teams (external hook sessions) are added
 * from the live teams.
 */
export function orderTargets(
  providers: readonly ProviderInfo[],
  sessions: readonly SessionInfo[],
  teams: readonly TeamLike[]
): OrderTargetOption[] {
  const live: { id: string; name: string; provider: string }[] = []
  for (const s of sessionOrder(providers, sessions)) {
    if (s.state !== 'exited') live.push({ id: s.id, name: s.title, provider: s.provider })
  }
  for (const t of teams) {
    if (t.live && !sessions.some((s) => s.id === t.id)) live.push({ id: t.id, name: t.name, provider: t.provider })
  }
  const out: OrderTargetOption[] = [{ value: 'all', label: 'Everyone', group: 'everyone', ids: live.map((l) => l.id) }]
  const seen = new Set<string>()
  for (const l of live) {
    if (seen.has(l.provider)) continue
    seen.add(l.provider)
    out.push({
      value: PROVIDER_TARGET_PREFIX + l.provider,
      label: `All ${providerLabel(providers, l.provider)}`,
      group: 'provider',
      ids: live.filter((x) => x.provider === l.provider).map((x) => x.id)
    })
  }
  for (const l of live) out.push({ value: l.id, label: l.name, group: 'session', ids: [l.id] })
  return out
}

export interface OrderSummary {
  ok: boolean
  /** ok = everyone got it, partial = some did, fail = nobody did. */
  tone: 'ok' | 'partial' | 'fail'
  headline: string
  failures: { reason: string; names: string[] }[]
}

/** "Delivered to 2 of 3" plus failures grouped by reason. */
export function orderSummary(res: OrderResult, nameOf: (id: string) => string): OrderSummary {
  const total = res.delivered.length + res.failed.length
  const byReason = new Map<string, string[]>()
  for (const f of res.failed) {
    if (!byReason.has(f.reason)) byReason.set(f.reason, [])
    const isTarget = !f.agentId || f.agentId === 'all' || f.agentId.startsWith(PROVIDER_TARGET_PREFIX)
    if (!isTarget) byReason.get(f.reason)!.push(nameOf(f.agentId))
  }
  const headline =
    res.delivered.length > 0
      ? `Delivered to ${res.delivered.length}${total > 1 ? ` of ${total}` : ''}`
      : total > 0
        ? 'Not delivered'
        : 'Nothing sent'
  const ok = res.failed.length === 0 && res.delivered.length > 0
  return {
    ok,
    tone: ok ? 'ok' : res.delivered.length > 0 ? 'partial' : 'fail',
    headline,
    failures: [...byReason].map(([reason, names]) => ({ reason, names }))
  }
}

export interface WaitingEntry extends WaitingLike {
  /** True when the app hosts this agent's session (its terminal is one click away). */
  hosted: boolean
}

/**
 * World "waiting" agents that have no permission card: external or simulated sessions the app
 * can't answer, and hosted sessions asking something only their terminal can answer.
 */
export function terminalOnlyWaiting(
  waiting: readonly WaitingLike[],
  permissions: readonly PermissionRequestInfo[],
  sessions: readonly SessionInfo[]
): WaitingEntry[] {
  const carded = new Set(permissions.map((p) => p.agentId))
  const cardedSessions = new Set(permissions.map((p) => p.sessionId))
  const out: WaitingEntry[] = []
  for (const w of waiting) {
    if (carded.has(w.agentId)) continue
    const hosted = sessions.some((s) => s.id === w.teamId)
    // A manager relaying its worker's request: the card already covers it.
    if (hosted && w.agentId === w.teamId && cardedSessions.has(w.teamId)) continue
    out.push({ ...w, hosted })
  }
  return out
}

export interface LogEntry {
  seq: number
  /** Top-level session (team) of the agent. */
  teamId: string
  event: AgentEvent
}

export const LOG_CAP = 500

/** Appends and keeps the newest LOG_CAP rows; returns a new array. */
export function appendLog(log: readonly LogEntry[], add: readonly LogEntry[], cap = LOG_CAP): LogEntry[] {
  const out = log.concat(add)
  return out.length > cap ? out.slice(out.length - cap) : out
}

export function filterLog(
  log: readonly LogEntry[],
  opts: { text: string; activities: ReadonlySet<Activity> | null; teamId: string | null }
): LogEntry[] {
  const q = opts.text.trim().toLowerCase()
  return log.filter((l) => {
    if (opts.teamId && l.teamId !== opts.teamId) return false
    if (opts.activities && !opts.activities.has(l.event.activity)) return false
    if (!q) return true
    const e = l.event
    return (
      e.displayName.toLowerCase().includes(q) ||
      e.detail.toLowerCase().includes(q) ||
      e.activity.includes(q) ||
      e.provider.toLowerCase().includes(q)
    )
  })
}

/** Split size clamped so both sides stay usable. */
export function clampSplit(size: number, total: number, min: number, minOther: number): number {
  const max = Math.max(min, total - minOther)
  return Math.round(Math.min(max, Math.max(min, size)))
}

/** Most recent first, no duplicates (case-insensitive on Windows-style paths), capped. */
export function pushRecent(list: readonly string[], item: string, cap = 8): string[] {
  const key = (p: string) => (p.includes('\\') ? p.toLowerCase() : p)
  const trimmed = item.trim()
  if (!trimmed) return [...list]
  return [trimmed, ...list.filter((x) => key(x) !== key(trimmed))].slice(0, cap)
}

/** Requests that vanished from the pending list without this window deciding them. */
export function vanished(
  prev: readonly PermissionRequestInfo[],
  next: readonly PermissionRequestInfo[],
  decidedHere: ReadonlySet<string>
): PermissionRequestInfo[] {
  const still = new Set(next.map((p) => p.id))
  return prev.filter((p) => !still.has(p.id) && !decidedHere.has(p.id))
}

/** "Bash: npm test" -> "npm test" when the tool name is already shown as a chip. */
export function stripToolPrefix(summary: string, toolName: string): string {
  const prefix = `${toolName}:`
  return summary.startsWith(prefix) ? summary.slice(prefix.length).trimStart() : summary
}

/**
 * The main process forgets an exited session after a while. If its terminal is open here, keep the
 * row (and so its last output) until the user removes it.
 */
export function retainExited(
  prev: readonly SessionInfo[],
  next: readonly SessionInfo[],
  hasTerminal: (id: string) => boolean
): SessionInfo[] {
  const present = new Set(next.map((s) => s.id))
  const kept = prev.filter((s) => s.state === 'exited' && !present.has(s.id) && hasTerminal(s.id))
  return kept.length > 0 ? [...next, ...kept] : [...next]
}

/** A readable message without Electron's "Error invoking remote method" wrapper. */
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
}
