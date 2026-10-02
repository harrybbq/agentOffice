// "Remember where I left off": sessions survive closing the app.
//
// The agent processes themselves do NOT survive (the app owns them and stops them on quit), but every
// provider keeps the conversation on disk and can resume it: Claude `--resume <id>`, Codex
// `thread/resume`, Antigravity `--conversation <id>`. So the app saves a small record per session and
// brings the session back by resuming the provider conversation.
//
// Rules:
// - A permission request can never be restored as "still waiting": it died with the process that asked.
//   The app saves the QUESTIONS that were pending so the resumed session can show "these were waiting".
// - Saved sessions come back as SLEEPING rows (no process, no memory use). Only the session that was
//   selected is woken automatically, unless the user chose otherwise. Waking = resuming the conversation.
// - Records hold no secrets: no tokens, no socket paths, no prompt text beyond a short preview.

import type { PermissionMode, ProviderId } from './sessions'

export interface SavedPendingRequest {
  /** The plain one-sentence question (shared/permissionText.ts). */
  question: string
  toolName: string
  askedAt: number
}

export interface SavedSession {
  /** Stable app id; a woken session keeps it, so the world team, colour and sidebar position stay. */
  id: string
  provider: ProviderId
  cwd: string
  /** The title shown last (model name or the user's own). */
  title: string
  /** True if the user typed the title (then it never changes). */
  titleIsCustom: boolean
  permissionMode: PermissionMode
  model?: string
  /** What the provider needs to resume: Claude session id, Codex thread id, agy conversation id. */
  providerSessionId?: string
  startedAt: number
  lastActiveAt: number
  /** Short preview of the last prompt, for the Recent list (<= 120 chars, one line). */
  lastPrompt?: string
  /** Was it working / waiting when the app closed? Drives the "was interrupted" note. */
  interrupted: boolean
  /** Requests that were waiting on the user when the app closed. */
  pendingAtClose: SavedPendingRequest[]
  /** 'open' = was in the sidebar at close (comes back as a sleeping row); 'recent' = ended earlier. */
  status: 'open' | 'recent'
}

export type RestoreMode =
  | 'last' //  wake the session that was selected, show the others asleep (default)
  | 'all' //   wake every open session (uses more memory)
  | 'none' //  show them all asleep

export interface RestoreSettings {
  mode: RestoreMode
}

/** A sleeping row can be woken only if the provider conversation is known. */
export const canWake = (s: SavedSession): boolean => typeof s.providerSessionId === 'string' && s.providerSessionId.length > 0

export const MAX_RECENT_SESSIONS = 30
export const MAX_SAVED_PENDING = 10
export const LAST_PROMPT_PREVIEW_CHARS = 120
