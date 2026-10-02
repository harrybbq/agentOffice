import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const TOKEN_HEADER = 'x-agent-office-token'
export const SESSION_HEADER = 'x-agent-office-session'

/** The one route a per-session token may use. */
export const SESSION_TOKEN_ROUTE = '/hooks/claude-code'

/**
 * Who a request is: the user's own tools (global token from config.json), or an agent the app
 * launched (per-session token, which only reaches SESSION_TOKEN_ROUTE and only for its session).
 */
export type Auth = { kind: 'global' } | { kind: 'session'; sessionId: string }

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

/** Resolves the token header to an identity, or null when it matches nothing. */
export function authenticate(req: IncomingMessage, globalToken: string, sessions?: SessionTokens): Auth | null {
  const got = req.headers[TOKEN_HEADER]
  if (typeof got !== 'string' || got.length === 0) return null
  if (globalToken.length > 0 && equalConstantTime(got, globalToken)) return { kind: 'global' }
  const sessionId = sessions?.sessionOf(got)
  return sessionId ? { kind: 'session', sessionId } : null
}

/**
 * What an identity may do. The global token may use everything. A session token may only POST to
 * SESSION_TOKEN_ROUTE, and if it names a session in the session header, it must be its own.
 */
export function authorise(auth: Auth, req: IncomingMessage, path: string): boolean {
  if (auth.kind === 'global') return true
  if (req.method !== 'POST' || path !== SESSION_TOKEN_ROUTE) return false
  const claimed = req.headers[SESSION_HEADER]
  return typeof claimed !== 'string' || claimed.length === 0 || claimed === auth.sessionId
}
