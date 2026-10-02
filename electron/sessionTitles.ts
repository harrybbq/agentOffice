// Titles of hosted sessions (and so of their teams in the world). A title the user typed always
// wins and never changes. Otherwise a session is named after its model, or after its provider
// while the model isn't known yet; sessions that would share a title get the folder name added,
// and a number if that is still not enough.
import { friendlyModelName } from '../shared/models'

export interface TitleInput {
  id: string
  /** The title typed in the new-session dialog, if any. */
  userTitle?: string
  /** "Claude Code": used until the model is known. */
  providerLabel: string
  /** The model id the session reported, if it has. */
  model?: string
  /** Name of the working folder. */
  folder: string
}

/** The title without any disambiguation. */
export function baseTitle(s: TitleInput): string {
  if (s.userTitle) return s.userTitle
  return (s.model && friendlyModelName(s.model)) || s.providerLabel
}

/** Titles for the live sessions, given in start order. */
export function assignTitles(sessions: readonly TitleInput[]): Map<string, string> {
  const count = (titles: readonly string[]): Map<string, number> => {
    const n = new Map<string, number>()
    for (const t of titles) n.set(t, (n.get(t) ?? 0) + 1)
    return n
  }
  // 1. Names that clash get the folder (never a title the user chose).
  const bases = sessions.map(baseTitle)
  const baseCount = count(bases)
  const withFolder = sessions.map((s, i) => (!s.userTitle && (baseCount.get(bases[i]) ?? 0) > 1 && s.folder ? `${bases[i]} · ${s.folder}` : bases[i]))
  // 2. Still the same (same model, same folder name): number the later ones.
  const seen = new Map<string, number>()
  const total = count(withFolder)
  const out = new Map<string, string>()
  sessions.forEach((s, i) => {
    const t = withFolder[i]
    const nth = (seen.get(t) ?? 0) + 1
    seen.set(t, nth)
    out.set(s.id, !s.userTitle && (total.get(t) ?? 0) > 1 && nth > 1 ? `${t} #${nth}` : t)
  })
  return out
}
