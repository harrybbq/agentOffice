// Per-session delivery info for CEO orders: Claude Code's inbox socket (a named pipe on Windows, a
// unix socket elsewhere) and its auth token, keyed by session id.
//
// Filled by the Claude Code hook adapter (milestone 2) from CLAUDE_CODE_MESSAGING_SOCKET /
// CLAUDE_CODE_MESSAGING_TOKEN. Kept IN MEMORY ONLY: never written to disk, never logged, never sent
// to the renderer. Imports only node:net so tests can load it without Electron.
//
// Protocol (docs/claude-code-hooks-notes.md): connect, write `{"type":"auth","token":"..."}\n`, then
// the message text + `\n`, then close.
import { createConnection } from 'node:net'
import { REASON_NOT_CONNECTED } from '../shared/orders'

export interface SessionEndpoint {
  socketPath: string
  token: string
}

export const DELIVERY_TIMEOUT_MS = 5000

/** One message per line on the wire: newlines inside the text become spaces. */
export function wirePayload(token: string, text: string): string {
  const line = text.replace(/\r\n|\r|\n/g, ' ')
  return `${JSON.stringify({ type: 'auth', token })}\n${line}\n`
}

/**
 * Connects, writes the auth line and the message, closes. Resolves once the bytes are flushed;
 * rejects on a connection error or after `timeoutMs`. Errors never include the token.
 */
export function deliverToSocket(ep: SessionEndpoint, text: string, timeoutMs = DELIVERY_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const sock = createConnection(ep.socketPath)
    const settle = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        sock.destroy()
        reject(err)
      } else {
        resolve()
        // Let the peer read and hang up; don't keep the handle around for long.
        setTimeout(() => sock.destroy(), 1000).unref?.()
      }
    }
    const timer = setTimeout(() => settle(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
    sock.once('error', (err: NodeJS.ErrnoException) => settle(new Error(err.code ?? 'connection failed')))
    sock.once('connect', () => {
      sock.end(wirePayload(ep.token, text), () => settle())
    })
  })
}

export class SessionInbox {
  private endpoints = new Map<string, SessionEndpoint>()

  register(sessionId: string, ep: SessionEndpoint): void {
    this.endpoints.set(sessionId, { socketPath: ep.socketPath, token: ep.token })
  }

  unregister(sessionId: string): void {
    this.endpoints.delete(sessionId)
  }

  has(sessionId: string): boolean {
    return this.endpoints.has(sessionId)
  }

  clear(): void {
    this.endpoints.clear()
  }

  /** Delivers to one session. Never throws. */
  async deliver(
    sessionId: string,
    text: string,
    timeoutMs = DELIVERY_TIMEOUT_MS
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ep = this.endpoints.get(sessionId)
    if (!ep) return { ok: false, reason: REASON_NOT_CONNECTED }
    try {
      await deliverToSocket(ep, text, timeoutMs)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `delivery failed: ${err instanceof Error ? err.message : 'error'}` }
    }
  }

  /** Never serialise the endpoints (tokens) by accident. */
  toJSON(): object {
    return { sessions: this.endpoints.size }
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SessionInbox { ${this.endpoints.size} session(s) }`
  }
}
