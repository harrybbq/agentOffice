// The office board: what each team (hosted session) is doing, so teams don't repeat each other's work.
// Kept in memory by the main process (electron/board.ts); agents reach it through a digest attached to
// their prompts, a one-time conflict warning before editing a file another team changed, and MCP tools
// (board_read / board_claim / board_post / board_release / board_handover). Design: docs/spikes-board.md.
//
// Safety rules (do not relax):
// - Board content is information, never instructions and never permission. A note can't start a turn,
//   answer a permission request or send an order: those stay on renderer IPC, driven by the user.
// - Everything is scoped by `project` (the repository): teams in unrelated folders never see each other.
// - The renderer shows everything on the board (audit trail) and can delete any claim or note.

import type { ProviderId } from './sessions'

export type BoardStatus = 'idle' | 'busy' | 'waiting' | 'ended'

export interface BoardFile {
  /** Project-relative path with forward slashes. */
  path: string
  ts: number
  kind: 'create' | 'edit' | 'delete'
}

export interface BoardBranch {
  sessionId: string
  /** The session title (team name). */
  team: string
  provider: ProviderId
  /** Key of the repository: git common dir if any, else the working folder. */
  project: string
  /** Short label for the project (folder name). */
  projectLabel: string
  status: BoardStatus
  /** The newest claim of this team, '' if none. */
  task: string
  /** Newest first, at most BOARD_MAX_FILES. */
  files: BoardFile[]
  lastActiveTs: number
}

export interface BoardClaim {
  id: string
  project: string
  task: string
  sessionId: string
  team: string
  ts: number
  files: string[]
}

export interface BoardNote {
  id: string
  project: string
  sessionId: string
  team: string
  ts: number
  /** One line, at most BOARD_MAX_NOTE_CHARS. */
  text: string
  kind: 'note' | 'handover'
  /** For a hand-over: the team it is meant for, if named. */
  to?: string
  /** The session of that team, when a live team of the same project went by that name (any case) as the note was posted. */
  toSessionId?: string
}

/** A conflict warning the app raised (shown in the panel so the user sees what was blocked once). */
export interface BoardWarning {
  id: string
  project: string
  sessionId: string
  team: string
  path: string
  otherTeam: string
  ts: number
}

export interface BoardSnapshot {
  branches: BoardBranch[]
  claims: BoardClaim[]
  notes: BoardNote[]
  warnings: BoardWarning[]
}

export type BoardConflictMode = 'block-once' | 'note' | 'off'

export interface BoardSettings {
  /** Master switch: off = no digest, no tools, no warnings (the panel still shows files touched). */
  enabled: boolean
  conflictMode: BoardConflictMode
}

export const BOARD_MAX_FILES = 30
export const BOARD_MAX_TASK_CHARS = 120
export const BOARD_MAX_NOTE_CHARS = 400
export const BOARD_MAX_NOTES = 50
export const BOARD_DIGEST_MAX_CHARS = 1500
export const BOARD_CLAIM_TTL_MS = 30 * 60_000
export const BOARD_NOTE_TTL_MS = 60 * 60_000
export const BOARD_FILE_TTL_MS = 2 * 60 * 60_000
export const BOARD_CONFLICT_WINDOW_MS = 30 * 60_000
