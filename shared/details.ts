// Stable texts and prefixes of AgentEvent.detail that mean something beyond "free text". The
// adapters (electron/) write them; theme rules and the inspector panel route by them. One place, so
// the two sides can't drift apart. The 8 activities (shared/events.ts) stay as they are: these only
// say more about WHAT an agent reads, writes or waits for.
//
//   activity   detail                      meaning
//   write      "planning: <summary>"       a plan / todo list is being written or updated
//   read       "checking the board"        an office-board tool (any of them, also the writing ones)
//   read|write "secrets: <path>"           the file read or changed looks like a secrets / agent-settings file
//   waiting    "question: <the question>"  the agent asked the user something (not a permission request)
//   exec       "delegating"                work is being handed to a sub-agent
//
// Pure string work: no imports, usable from the main process and the renderer.

export const DETAIL_PLANNING = 'planning: '
export const DETAIL_SECRETS = 'secrets: '
export const DETAIL_QUESTION = 'question: '
/** The whole detail (not a prefix). */
export const DETAIL_BOARD = 'checking the board'
/** The whole detail (not a prefix). */
export const DETAIL_DELEGATING = 'delegating'

/**
 * Paths that name a secrets file (.env, keys, credentials) or an agent's own settings folder. The
 * same idea as the SENSITIVE / AGENT_CONFIG patterns of shared/permissionText.ts (which decide the
 * risk badge of a permission card); kept here so the detail prefixes depend on nothing else.
 */
const SECRET_FILE =
  /(^|[\\/])(\.env(\.[\w.-]+)?|\.ssh|\.aws|\.gnupg|id_(rsa|ed25519)[\w.]*|credentials(\.\w+)?|\.npmrc|\.netrc|\.pypirc|auth\.json|secrets?(\.\w+)?|[\w.-]+\.(pem|key|pfx|p12|keystore))($|[\\/])/i
const AGENT_SETTINGS = /(^|[\\/])\.(claude|codex|gemini|agents)([\\/]|$)/i

export function isSensitivePath(path: string): boolean {
  return SECRET_FILE.test(path) || AGENT_SETTINGS.test(path)
}

export type DetailKind = 'planning' | 'secrets' | 'question' | 'board' | 'delegating'

/** Which of the stable details this is, or null for plain free text (a path, a command, a URL). */
export function detailKind(detail: string): DetailKind | null {
  if (detail.startsWith(DETAIL_PLANNING)) return 'planning'
  if (detail.startsWith(DETAIL_SECRETS)) return 'secrets'
  if (detail.startsWith(DETAIL_QUESTION)) return 'question'
  if (detail === DETAIL_BOARD) return 'board'
  if (detail === DETAIL_DELEGATING) return 'delegating'
  return null
}

/** The detail without its prefix: "planning: fix the tests" -> "fix the tests". */
export function detailText(detail: string): string {
  for (const prefix of [DETAIL_PLANNING, DETAIL_SECRETS, DETAIL_QUESTION]) if (detail.startsWith(prefix)) return detail.slice(prefix.length)
  return detail
}

/**
 * The detail of a file activity: `detail` as it is, or with the `secrets: ` prefix when `path` (the
 * file read or changed; default: the detail itself) looks like a secrets or agent-settings file.
 */
export function fileDetail(detail: string, path: string = detail): string {
  return path && isSensitivePath(path) && !detail.startsWith(DETAIL_SECRETS) ? `${DETAIL_SECRETS}${detail}` : detail
}
