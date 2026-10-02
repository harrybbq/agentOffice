// Local ingest server. Bound to 127.0.0.1 only; every request must carry the token header.
// Browsers are refused outright (Origin header, Host allow-list vs DNS rebinding, no CORS ever).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { createClaudeCodeHooksAdapter } from '../adapters/claude-code-hooks'
import { genericAdapter, ingestEvents } from '../adapters/generic'
import type { EventSink, HttpAdapter } from '../adapters/types'
import type { BoardMcpRoute } from '../boardMcp'
import { authenticate, authorise, type Auth, type SessionTokens } from './auth'

export const HOST = '127.0.0.1'
export const MAX_BODY = 256 * 1024

export interface IngestServerOptions {
  port: number
  /** Called on every request so a regenerated token applies immediately. */
  getToken: () => string
  sink: EventSink
  /** Tokens of sessions the app launched. They only reach the Claude Code hooks route. */
  sessionTokens?: SessionTokens
  /** The `/hooks/claude-code` adapter. Default: a stand-alone one that only knows external sessions. */
  claudeHooks?: HttpAdapter
  /**
   * The office board's MCP tools (electron/boardMcp.ts) and the tokens that reach them: one per
   * hosted session, valid for this route only. Absent = no such route.
   */
  board?: { route: BoardMcpRoute; tokens: SessionTokens }
  /**
   * Hosted Antigravity sessions (electron/drivers/agyHookBridge.ts): the `/hooks/agy` adapter and
   * the tokens of their hook scripts, valid for that route only. Absent = no such route.
   */
  agy?: { adapter: HttpAdapter; tokens: SessionTokens }
}

export interface IngestServer {
  port: number
  close(): Promise<void>
}

export class PortInUseError extends Error {
  constructor(public port: number) {
    super(
      `Port ${port} on ${HOST} is already in use (is another Agent Office running?). ` +
        `Change "port" in config.json and restart.`
    )
    this.name = 'PortInUseError'
  }
}

type Verdict = { ok: true; auth: Auth } | { ok: false; status: number; message: string }

/**
 * Shared gate for HTTP requests and WebSocket upgrades. Order: Origin, OPTIONS, Host, token, then
 * what that token may reach (a per-session token only POSTs to the Claude Code hooks route, a
 * board token only reaches the board route, an agy hook token only POSTs to the agy hooks route).
 */
function gate(req: IncomingMessage, port: number, token: string, sessionTokens?: SessionTokens, boardTokens?: SessionTokens, agyTokens?: SessionTokens): Verdict {
  if (req.headers.origin !== undefined) return { ok: false, status: 403, message: 'browser requests are not allowed' }
  if (req.method === 'OPTIONS') return { ok: false, status: 403, message: 'forbidden' }
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, message: 'bad host' }
  }
  const auth = authenticate(req, token, sessionTokens, boardTokens, agyTokens)
  if (!auth) return { ok: false, status: 401, message: 'unauthorized' }
  if (!authorise(auth, req, pathOf(req))) return { ok: false, status: 403, message: 'not allowed for this token' }
  return { ok: true, auth }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return ''
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  })
  res.end(data)
}

/** An answer without a body (MCP: a notification was accepted). */
function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Content-Length': 0, 'Cache-Control': 'no-store' })
  res.end()
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) {
      reject(new HttpError(413, 'payload too large'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > max) {
        failed = true
        reject(new HttpError(413, 'payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (!failed) {
        failed = true
        reject(err)
      }
    })
  })
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const text = await readBody(req, max)
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

const REASONS: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  )
  socket.destroy()
}

export function startIngestServer(opts: IngestServerOptions): Promise<IngestServer> {
  const { port, getToken, sink, sessionTokens, board, agy } = opts
  const adapters: HttpAdapter[] = [genericAdapter, opts.claudeHooks ?? createClaudeCodeHooksAdapter(), ...(agy ? [agy.adapter] : [])]

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const v = gate(req, port, getToken(), sessionTokens, board?.tokens, agy?.tokens)
    if (!v.ok) {
      // An MCP client told "401" looks for the scheme to use.
      const extra: Record<string, string> = v.status === 401 && board && pathOf(req) === board.route.route ? { 'WWW-Authenticate': 'Bearer' } : {}
      sendJson(res, v.status, { error: v.message }, extra)
      return
    }
    // A client that hangs up before we answer (Claude Code abandoning a pending hook) aborts this.
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) gone.abort()
    })
    const path = pathOf(req)
    try {
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }
      // The office board's MCP tools. Only a board token gets here (auth.ts), and the caller is the
      // session that token belongs to. The route answers JSON-RPC about the board and nothing else:
      // there is no way from here to a permission decision, a prompt or an order.
      if (board && path === board.route.route && v.auth.kind === 'board') {
        if (req.method === 'DELETE') return sendJson(res, 200, {})
        // No server-initiated stream (GET), and nothing else either.
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' }, { Allow: 'POST' })
        let message: unknown
        try {
          message = JSON.parse(await readBody(req, board.route.maxBody))
        } catch (err) {
          if (err instanceof HttpError) throw err // too large
          return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        }
        const out = board.route.handle(v.auth.sessionId, message)
        if (gone.signal.aborted || res.destroyed) return
        return out.body === null ? sendEmpty(res, out.status) : sendJson(res, out.status, out.body)
      }
      const adapter = req.method === 'POST' ? adapters.find((a) => a.route === path) : undefined
      if (!adapter) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const body = await readJson(req, adapter.maxBody ?? MAX_BODY)
      const out = await adapter.handle(body, sink, { auth: v.auth, signal: gone.signal })
      // The adapter may have held the request for a long time; the client can be gone by now.
      if (!gone.signal.aborted && !res.destroyed) sendJson(res, 200, out ?? {})
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error('[agent-office] ingest error:', err)
      if (!res.headersSent && !res.destroyed) {
        res.setHeader('Connection', 'close')
        sendJson(res, status, { error: err instanceof HttpError ? err.message : 'internal error' })
      }
      // Stop reading an oversized body once the 413 is on its way.
      if (status === 413) res.on('finish', () => req.destroy())
    }
  }

  const server: Server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void onRequest(req, res)
  })
  // Both bound how long a client may take to SEND a request. Neither limits how long we take to
  // answer, so a PermissionRequest held open for minutes is not cut (checked on Node 24: a response
  // held for 75 s under requestTimeout = 30 s was still delivered).
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.timeout = 0

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const v = gate(req, port, getToken(), sessionTokens, board?.tokens, agy?.tokens)
    if (!v.ok) return rejectUpgrade(socket, v.status, v.message)
    if (pathOf(req) !== '/ws') return rejectUpgrade(socket, 404, 'not found')
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    ws.on('error', (err) => console.warn('[agent-office] ws client error:', err.message))
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.send(JSON.stringify({ error: 'text frames only' }))
        return
      }
      let body: unknown
      try {
        body = JSON.parse(data.toString())
      } catch {
        ws.send(JSON.stringify({ error: 'invalid JSON' }))
        return
      }
      ws.send(JSON.stringify(ingestEvents(body, sink)))
    })
  })

  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      wss.close()
      reject(err.code === 'EADDRINUSE' ? new PortInUseError(port) : err)
    }
    const onListening = () => {
      server.off('error', onError)
      server.on('error', (err) => console.error('[agent-office] ingest server error:', err))
      console.log(`[agent-office] ingest listening on ${HOST}:${port}`)
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const c of wss.clients) c.terminate()
            wss.close()
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}
