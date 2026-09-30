import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const TOKEN_HEADER = 'x-agent-office-token'

/** Constant-time token check. The token is only ever read from the header, never the URL. */
export function checkToken(req: IncomingMessage, expected: string): boolean {
  const got = req.headers[TOKEN_HEADER]
  if (typeof got !== 'string' || expected.length === 0) return false
  const a = Buffer.from(got, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Still do a comparison of equal length so timing doesn't depend on where it failed.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}
