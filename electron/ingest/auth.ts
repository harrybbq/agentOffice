import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const TOKEN_HEADER = 'x-agent-office-token'
export const SESSION_HEADER = 'x-agent-office-session'

/** The one route a per-session token may use. */
export const SESSION_TOKEN_ROUTE = '/hooks/claude-code'

/** The one route a board token may use (the office board's MCP tools, electron/boardMcp.ts). */
export const BOARD_TOKEN_ROUTE = '/mcp'

/**
 * Who a request is:
 * - `global`: the user's own tools (the token from config.json);
 * - `session`: an agent the app launched, reporting its hooks (per-session token in the token
 *   header; it only reaches SESSION_TOKEN_ROUTE, and only for its session);
 * - `board`: the same agent using the office board (a SEPARATE per-session token, sent as
 *   `Authorization: Bearer`; it only reaches BOARD_TOKEN_ROUTE). "Can post events" and "can use the
 *   board" are different scopes: neither token works on the other's route.
 */
export type Auth = { kind: 'global' } | { kind: 'session'; sessionId: string } | { kind: 'board'; sessionId: string }

function equalConstantTime(got: string, expected: string): boolean {
  const a = Buffer.from(got, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Still do a comparison of equal length so timing doesn't depend on where it failed.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Constant-time token check. The token is only ever read from the header, never the URL. */
export function checkToken(req: IncomingMessage, expected: string): boolean {
  const got = req.headers[TOKEN_HEADER]
  if (typeof got !== 'string' || expected.length === 0) return false
  return equalConstantTime(got, expected)
}

const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Per-session ingest tokens, in memory only. Lookups go through a SHA-256 of the presented token,
 * so the comparison time says nothing about how much of a real token was guessed.
 */
export class SessionTokens {
  private byDigest = new Map<string, string>()
  private bySession = new Map<string, string>()

  /** Creates (or replaces) the token of a session and returns it. */
  issue(sessionId: string): string {
    this.revoke(sessionId)
    const token = randomBytes(32).toString('hex')
    const d = digest(token)
    this.byDigest.set(d, sessionId)
    this.bySession.set(sessionId, d)
    return token
  }

  revoke(sessionId: string): void {
    const d = this.bySession.get(sessionId)
    if (d) this.byDigest.delete(d)
    this.bySession.delete(sessionId)
  }

  /** The session a token belongs to, or null. */
  sessionOf(token: string): string | null {
    if (token.length < 16 || token.length > 256) return null
    return this.byDigest.get(digest(token)) ?? null
  }

  get size(): number {
    return this.bySession.size
  }

  toJSON(): object {
    return { sessions: this.bySession.size }
  }
}

/** The bearer token of an `Authorization` header, or ''. */
function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const m = /^Bearer ([!-~]{1,512})$/.exec(header)
  return m ? m[1] : ''
}

/**
 * Resolves a request's credentials to an identity, or null when they match nothing. The token
 * header is looked up as the global token or a session's hook token; a bearer token only as a board
 * token (and only when no token header was sent). Tokens are never read from the URL.
 */
export function authenticate(req: IncomingMessage, globalToken: string, sessions?: SessionTokens, boards?: SessionTokens): Auth | null {
  const got = req.headers[TOKEN_HEADER]
  if (typeof got === 'string' && got.length > 0) {
    if (globalToken.length > 0 && equalConstantTime(got, globalToken)) return { kind: 'global' }
    const sessionId = sessions?.sessionOf(got)
    return sessionId ? { kind: 'session', sessionId } : null
  }
  if (got !== undefined) return null
  const bearer = bearerOf(req)
  const boardSession = bearer ? boards?.sessionOf(bearer) : null
  return boardSession ? { kind: 'board', sessionId: boardSession } : null
}

/**
 * What an identity may do. The global token may use everything except the board route (the board
 * needs to know which session is calling). A session token may only POST to SESSION_TOKEN_ROUTE,
 * and if it names a session in the session header, it must be its own. A board token only reaches
 * BOARD_TOKEN_ROUTE.
 */
export function authorise(auth: Auth, req: IncomingMessage, path: string): boolean {
  if (auth.kind === 'global') return path !== BOARD_TOKEN_ROUTE
  if (auth.kind === 'board') return path === BOARD_TOKEN_ROUTE
  if (req.method !== 'POST' || path !== SESSION_TOKEN_ROUTE) return false
  const claimed = req.headers[SESSION_HEADER]
  return typeof claimed !== 'string' || claimed.length === 0 || claimed === auth.sessionId
}
