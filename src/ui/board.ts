// Pure logic of the Board panel (no DOM, no React): grouping the office board by project, finding
// files more than one team touched, what is new on the board (for the world animation), and the
// optimistic removal of a claim or note. The data itself comes from the main process
// (shared/board.ts); nothing here assumes an order of its lists.
import { BOARD_CONFLICT_WINDOW_MS } from '../../shared/board'
import type { BoardBranch, BoardClaim, BoardConflictMode, BoardFile, BoardNote, BoardSnapshot, BoardStatus, BoardWarning } from '../../shared/board'
import { whenAgo } from './format'

export const EMPTY_BOARD: BoardSnapshot = { branches: [], claims: [], notes: [], warnings: [] }

/** How many changed files a team row shows before "N more". */
export const BOARD_VISIBLE_FILES = 5

export const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  idle: 'idle',
  busy: 'working',
  waiting: 'waiting on you',
  ended: 'ended'
}

export const CONFLICT_MODES: readonly { value: BoardConflictMode; label: string; help: string }[] = [
  { value: 'block-once', label: 'Block once', help: 'A team is stopped once before it edits a file another team changed, and told who changed it.' },
  { value: 'note', label: 'Just note', help: 'The edit goes through; the team is told afterwards that another team changed the file.' },
  { value: 'off', label: 'Off', help: 'No warning. Teams still see who changed what when they read the board.' }
]

/** "just now", "3 min ago", "2 h ago" (timestamps are epoch milliseconds). */
export function relTime(ts: number, now: number): string {
  // A clock a little ahead of ours must not read as a date in the future.
  return whenAgo(Math.min(ts, now), now)
}

/** The same path however the separators were written. */
export function normPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** "src/ui/App.tsx" -> { dir: "src/ui/", base: "App.tsx" }: the folder may be cut short, the name never. */
export function splitPath(path: string): { dir: string; base: string } {
  const p = normPath(path)
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) }
}

/** A file that more than one team of a project touched within the conflict window. */
export interface FileOverlap {
  project: string
  path: string
  /** The teams involved (two or more), most recent edit first. */
  teams: { sessionId: string; team: string; ts: number }[]
  /** The most recent of those edits. */
  ts: number
}

/**
 * Two teams overlap on a file when both have it in their changed files, they belong to the same
 * project, and the two changes are at most `windowMs` apart: exactly the situation in which the
 * app warns the second team. The same team twice, or the same path in another project, is none.
 */
export function findOverlaps(branches: readonly BoardBranch[], windowMs = BOARD_CONFLICT_WINDOW_MS): FileOverlap[] {
  const byFile = new Map<string, { project: string; path: string; edits: { sessionId: string; team: string; ts: number }[] }>()
  for (const b of branches) {
    for (const f of b.files) {
      const path = normPath(f.path)
      const key = `${b.project}\n${path}`
      let entry = byFile.get(key)
      if (!entry) byFile.set(key, (entry = { project: b.project, path, edits: [] }))
      entry.edits.push({ sessionId: b.sessionId, team: b.team, ts: f.ts })
    }
  }
  const out: FileOverlap[] = []
  for (const { project, path, edits } of byFile.values()) {
    const involved = new Map<string, { sessionId: string; team: string; ts: number }>()
    for (const a of edits) {
      if (!edits.some((o) => o.sessionId !== a.sessionId && Math.abs(o.ts - a.ts) <= windowMs)) continue
      const prev = involved.get(a.sessionId)
      if (!prev || a.ts > prev.ts) involved.set(a.sessionId, a)
    }
    if (involved.size < 2) continue
    const teams = [...involved.values()].sort((x, y) => y.ts - x.ts || x.team.localeCompare(y.team))
    out.push({ project, path, teams, ts: teams[0].ts })
  }
  return out.sort((x, y) => y.ts - x.ts || x.path.localeCompare(y.path))
}

export function overlapSummary(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'} touched by more than one team`
}

export function overlapBadge(n: number): string {
  return `${n} ${n === 1 ? 'overlap' : 'overlaps'}`
}

export interface FileRow extends BoardFile {
  /** The other teams that touched this file within the conflict window ([] = no overlap). */
  others: { sessionId: string; team: string }[]
}

export interface TeamRow {
  branch: BoardBranch
  /** One entry per path: overlapping files first, then newest first. */
  files: FileRow[]
  /** What the collapsed row shows: BOARD_VISIBLE_FILES files, and every overlapping one. */
  visible: FileRow[]
  /** How many more "N more" stands for. */
  hidden: number
  overlaps: number
}

export interface ProjectGroup {
  project: string
  label: string
  teams: TeamRow[]
  overlaps: FileOverlap[]
  /** Newest first. */
  claims: BoardClaim[]
  notes: BoardNote[]
  warnings: BoardWarning[]
}

/** One row per team: its files newest first, one per path, with the overlapping ones on top. */
export function teamRow(branch: BoardBranch, overlaps: readonly FileOverlap[], visibleFiles = BOARD_VISIBLE_FILES): TeamRow {
  const others = new Map<string, FileRow['others']>()
  for (const o of overlaps) {
    if (o.project !== branch.project || !o.teams.some((t) => t.sessionId === branch.sessionId)) continue
    others.set(o.path, o.teams.filter((t) => t.sessionId !== branch.sessionId).map((t) => ({ sessionId: t.sessionId, team: t.team })))
  }
  const newest = new Map<string, BoardFile>()
  for (const f of branch.files) {
    const path = normPath(f.path)
    const prev = newest.get(path)
    if (!prev || f.ts > prev.ts) newest.set(path, { ...f, path })
  }
  const files: FileRow[] = [...newest.values()]
    .map((f) => ({ ...f, others: others.get(f.path) ?? [] }))
    .sort((x, y) => Number(y.others.length > 0) - Number(x.others.length > 0) || y.ts - x.ts || x.path.localeCompare(y.path))
  const overlapping = files.filter((f) => f.others.length > 0).length
  const visible = files.slice(0, Math.max(visibleFiles, overlapping))
  return { branch, files, visible, hidden: files.length - visible.length, overlaps: overlapping }
}

/**
 * The board by project. Projects with more teams come first (that is where coordination happens),
 * then by label. Teams keep `order` (the sidebar's order of session ids) with ended ones last.
 * Claims, notes and warnings whose project has no team left are still listed under their project.
 */
export function groupBoard(snapshot: BoardSnapshot, opts: { order?: readonly string[]; windowMs?: number } = {}): ProjectGroup[] {
  const overlaps = findOverlaps(snapshot.branches, opts.windowMs)
  const rank = new Map((opts.order ?? []).map((id, i) => [id, i]))
  const groups = new Map<string, ProjectGroup>()
  const group = (project: string): ProjectGroup => {
    let g = groups.get(project)
    if (!g) groups.set(project, (g = { project, label: '', teams: [], overlaps: [], claims: [], notes: [], warnings: [] }))
    return g
  }
  const sorted = [...snapshot.branches].sort(
    (x, y) =>
      Number(x.status === 'ended') - Number(y.status === 'ended') ||
      (rank.get(x.sessionId) ?? Infinity) - (rank.get(y.sessionId) ?? Infinity) ||
      x.team.localeCompare(y.team) ||
      x.sessionId.localeCompare(y.sessionId)
  )
  for (const b of sorted) {
    const g = group(b.project)
    if (!g.label) g.label = b.projectLabel
    g.teams.push(teamRow(b, overlaps))
  }
  for (const o of overlaps) group(o.project).overlaps.push(o)
  const newestFirst = <T extends { ts: number; id: string }>(a: T, b: T) => b.ts - a.ts || a.id.localeCompare(b.id)
  for (const c of [...snapshot.claims].sort(newestFirst)) group(c.project).claims.push(c)
  for (const n of [...snapshot.notes].sort(newestFirst)) group(n.project).notes.push(n)
  for (const w of [...snapshot.warnings].sort(newestFirst)) group(w.project).warnings.push(w)
  // No team left to name the project: the folder of its key (which may be a repository's .git folder).
  for (const g of groups.values()) if (!g.label) g.label = splitPath(normPath(g.project).replace(/\/\.git\/?$/, '')).base || g.project
  return [...groups.values()].sort(
    (x, y) => y.teams.length - x.teams.length || x.label.localeCompare(y.label) || x.project.localeCompare(y.project)
  )
}

/** "Stopped <team> once before editing <path> (changed by <otherTeam>)". */
export function warningText(w: Pick<BoardWarning, 'team' | 'path' | 'otherTeam'>): string {
  return `Stopped ${w.team} once before editing ${normPath(w.path)} (changed by ${w.otherTeam})`
}

// ---- what is new (the note animation in the world) ---------------------------------------------

/** A note older than this is not announced in the world, even if this window sees it for the first time. */
export const NOTE_NEWS_MS = 20_000

/**
 * Notes that were not on the board before. `seen` is null for the first snapshot of a window:
 * what is already on the board when the app opens is not news. With `now`, old notes that only
 * turn up now (a board filled in one go) are left out as well.
 */
export function newNotes(seen: ReadonlySet<string> | null, notes: readonly BoardNote[], now?: number): BoardNote[] {
  if (!seen) return []
  return notes.filter((n) => !seen.has(n.id) && (now === undefined || n.ts >= now - NOTE_NEWS_MS))
}

/**
 * The session a hand-over is meant for: `to` names a team, so it is matched against the team names
 * of the note's own project. Null for a plain note, an unknown or ambiguous name, or the author.
 */
export function noteTarget(note: BoardNote, branches: readonly BoardBranch[]): string | null {
  if (note.kind !== 'handover' || !note.to) return null
  const want = note.to.trim().toLowerCase()
  const hits = branches.filter((b) => b.project === note.project && b.status !== 'ended' && b.team.trim().toLowerCase() === want)
  return hits.length === 1 && hits[0].sessionId !== note.sessionId ? hits[0].sessionId : null
}

// ---- optimistic removal ------------------------------------------------------------------------

export type RemoveKind = 'claim' | 'note'

export function removalKey(kind: RemoveKind, id: string): string {
  return `${kind}:${id}`
}

export type RemovalAction =
  /** The user pressed delete: hide the item at once. */
  | { type: 'remove'; key: string }
  /** The main process said no (false) or the call failed: show it again if it is still on the board. */
  | { type: 'rollback'; key: string }
  /** A new snapshot arrived: forget keys whose item is gone for real. */
  | { type: 'snapshot'; snapshot: BoardSnapshot }

/** The set of items hidden ahead of the main process. Returns the same set when nothing changes. */
export function removalReducer(state: ReadonlySet<string>, action: RemovalAction): ReadonlySet<string> {
  switch (action.type) {
    case 'remove':
      return state.has(action.key) ? state : new Set([...state, action.key])
    case 'rollback': {
      if (!state.has(action.key)) return state
      const next = new Set(state)
      next.delete(action.key)
      return next
    }
    case 'snapshot': {
      if (state.size === 0) return state
      const live = new Set([
        ...action.snapshot.claims.map((c) => removalKey('claim', c.id)),
        ...action.snapshot.notes.map((n) => removalKey('note', n.id))
      ])
      const next = new Set([...state].filter((k) => live.has(k)))
      return next.size === state.size ? state : next
    }
  }
}

/**
 * The snapshot as the user should see it: without the items being removed. A team whose current
 * task was a removed claim shows its next newest claim (or none). Same object if nothing is hidden.
 */
export function applyRemovals(snapshot: BoardSnapshot, removing: ReadonlySet<string>): BoardSnapshot {
  if (removing.size === 0) return snapshot
  const gone = snapshot.claims.filter((c) => removing.has(removalKey('claim', c.id)))
  const notes = snapshot.notes.filter((n) => !removing.has(removalKey('note', n.id)))
  if (gone.length === 0 && notes.length === snapshot.notes.length) return snapshot
  const claims = snapshot.claims.filter((c) => !gone.includes(c))
  const branches =
    gone.length === 0
      ? snapshot.branches
      : snapshot.branches.map((b) => {
          if (!gone.some((c) => c.sessionId === b.sessionId && c.task === b.task)) return b
          const next = claims.filter((c) => c.sessionId === b.sessionId).sort((x, y) => y.ts - x.ts)[0]
          return { ...b, task: next?.task ?? '' }
        })
  return { ...snapshot, branches, claims, notes }
}
