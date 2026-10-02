// Per-session delivery info for CEO orders: Claude Code's inbox socket (a named pipe on Windows, a
// unix socket elsewhere) and its auth token, keyed by session id.
//
// Filled by a hosted session's SessionStart command hook (hook/claude-session-start.cjs), which reads
// CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN. Kept IN MEMORY ONLY: never written to
// disk, never logged, never sent to the renderer. Imports only node:net so tests can load it
// without Electron.
//
// Protocol (docs/spikes-phase-a.md, spike 4a): one connection per message. Write
// `{"type":"auth","token":"..."}\n`, then ONE JSON line shaped like an SDK user message, then close.
// A plain-text second line is silently dropped by Claude Code. The socket never answers, so
// delivery can only be confirmed by the session's UserPromptSubmit hook.
import { createConnection } from 'node:net'
import { REASON_NOT_CONNECTED } from '../shared/orders'

export interface SessionEndpoint {
  socketPath: string
  token: string
}

export const DELIVERY_TIMEOUT_MS = 5000

/** The auth line, then the message as one JSON line. Newlines stay inside the JSON string. */
export function wirePayload(token: string, text: string): string {
  const message = { type: 'user', message: { role: 'user', content: text } }
  return `${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify(message)}\n`
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
