// Pure selectors for the agent inspector (components/InspectView.tsx): what an agent is doing in
// the theme's words, runtime and token formatting, which facts to show. No DOM, no React.
// Covered by tests/inspect.test.ts.
import type { Activity } from '../../shared/events'
import type { AgentDetails, TokenUsage } from '../../shared/inspector'
import type { SessionState } from '../../shared/sessions'
import type { StationRouter } from '../theme/stations'
import { STATE_LABEL } from './format'

/** 950 -> "950", 1234 -> "1.2k", 45_678 -> "46k", 3_400_000 -> "3.4M". */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  const fmt = (v: number, unit: string) => {
    // One decimal below 10 of a unit, none above; "1.0k" reads as "1k".
    const text = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))
    return text + unit
  }
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) return fmt(n / 1000, 'k')
  if (n < 999_500_000) return fmt(n / 1_000_000, 'M')
  return fmt(n / 1_000_000_000, 'B')
}

/** "under a minute", "12 min", "2 h 5 min": a time span without ticking seconds. */
export function spanText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'under a minute'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`
}

/** "14:02" */
export function clockShort(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "12 min working · started 14:02" */
export function runtimeLine(d: Pick<AgentDetails, 'activeMs' | 'startedAt'>): string {
  const parts: string[] = []
  if (Number.isFinite(d.activeMs) && d.activeMs >= 0) parts.push(`${spanText(d.activeMs)} working`)
  if (Number.isFinite(d.startedAt) && d.startedAt > 0) parts.push(`started ${clockShort(d.startedAt)}`)
  return parts.join(' · ')
}

/** "12k in · 3.4k out · 80k cached · 1.2k reasoning": only what the provider reports. */
export function tokenBreakdown(t: TokenUsage): string {
  const parts = [`${compactNumber(t.input)} in`, `${compactNumber(t.output)} out`]
  if (typeof t.cached === 'number') parts.push(`${compactNumber(t.cached)} cached`)
  if (typeof t.reasoning === 'number') parts.push(`${compactNumber(t.reasoning)} reasoning`)
  return parts.join(' · ')
}

export interface ContextUse {
  /** 0..100 */
  percent: number
  /** "62% of the context used (124k of 200k)" */
  label: string
}

/** The "context used" bar, when the provider reports both numbers. */
export function contextUse(t: TokenUsage | undefined): ContextUse | null {
  if (!t || typeof t.contextUsed !== 'number' || typeof t.contextWindow !== 'number' || !(t.contextWindow > 0) || t.contextUsed < 0) return null
  const percent = Math.min(100, Math.round((t.contextUsed / t.contextWindow) * 100))
  return { percent, label: `${percent}% of the context used (${compactNumber(t.contextUsed)} of ${compactNumber(t.contextWindow)})` }
}

/** The activities the breakdown shows, in this order (waiting / idle / done are states, not work). */
export const COUNTED: readonly Activity[] = ['read', 'write', 'exec', 'web', 'capture']

export interface CountRow {
  activity: Activity
  count: number
  /** The theme's verb ("Filing"). */
  verb: string
  /** The station it happens at, when the theme names it ("Filing cabinet"). */
  station: string | null
  /** Share of the counted total, 0..1. */
  share: number
}

/** Reads, edits, commands, web, screenshots: in that fixed order, empty ones left out. */
export function countRows(counts: AgentDetails['counts'] | undefined, router: StationRouter): CountRow[] {
  const rows = COUNTED.map((activity) => ({ activity, count: Math.max(0, Math.floor(counts?.[activity] ?? 0)) })).filter((r) => r.count > 0)
  const total = rows.reduce((s, r) => s + r.count, 0)
  return rows.map((r) => ({ ...r, verb: router.verb(r.activity), station: router.stationTitle(r.activity), share: r.count / total }))
}

export type ChipTone = 'starting' | 'needs-attention' | 'idle' | 'busy' | 'waiting-permission' | 'exited' | 'asleep'

/** The state chip: a hosted session's state, or working / waiting / done for everyone else. */
export function stateChip(state: AgentDetails['state']): { label: string; tone: ChipTone } {
  if (state === 'working') return { label: 'Working', tone: 'busy' }
  if (state === 'waiting') return { label: 'Waiting on you', tone: 'waiting-permission' }
  if (state === 'done') return { label: 'Done', tone: 'exited' }
  const s = state as SessionState
  return { label: STATE_LABEL[s] ?? String(state), tone: s }
}

/** "Manager of frontend" / "Worker in frontend · Explore" */
export function roleLine(d: Pick<AgentDetails, 'role' | 'agentType'>, teamName: string | null, roleLabels: { manager: string; worker: string }): string {
  const head = d.role === 'manager' ? `${roleLabels.manager}${teamName ? ` of ${teamName}` : ''}` : `${roleLabels.worker}${teamName ? ` in ${teamName}` : ''}`
  return d.role === 'worker' && d.agentType ? `${head} · ${d.agentType}` : head
}

export interface Fact {
  key: 'task' | 'status' | 'runtime' | 'tokens' | 'turns'
  label: string
  value: string
  /** Hover text. */
  title?: string
  /** Shown dimmed (a value the provider does not report). */
  missing?: boolean
}

export const NOT_REPORTED = 'not reported by this provider'

/**
 * The grid of key facts. A field the main process did not send is left out, except TOKENS, which
 * says so with a dash (people look for it).
 */
export function facts(d: AgentDetails, router: StationRouter): Fact[] {
  const out: Fact[] = []
  if (d.task && d.task.trim()) out.push({ key: 'task', label: 'Task', value: d.task.trim() })
  out.push({ key: 'status', label: 'Status', value: router.phrase(d.activity, d.detail), title: d.detail || undefined })
  const runtime = runtimeLine(d)
  if (runtime) out.push({ key: 'runtime', label: 'Runtime', value: runtime })
  if (d.tokens && Number.isFinite(d.tokens.total)) {
    out.push({ key: 'tokens', label: 'Tokens', value: compactNumber(d.tokens.total), title: tokenBreakdown(d.tokens) })
  } else {
    out.push({ key: 'tokens', label: 'Tokens', value: '—', title: NOT_REPORTED, missing: true })
  }
  if (typeof d.turns === 'number' && d.turns >= 0) out.push({ key: 'turns', label: 'Turns', value: String(d.turns) })
  return out
}

export const FILE_KIND: Record<'create' | 'edit' | 'delete', { glyph: string; label: string }> = {
  create: { glyph: '+', label: 'Created' },
  edit: { glyph: '~', label: 'Edited' },
  delete: { glyph: '−', label: 'Deleted' }
}
