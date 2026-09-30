// Local ingest server. Bound to 127.0.0.1 only; every request must carry the token header.
// Browsers are refused outright (Origin header, Host allow-list vs DNS rebinding, no CORS ever).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { claudeCodeHooksAdapter } from '../adapters/claude-code-hooks'
import { genericAdapter, ingestEvents } from '../adapters/generic'
import type { EventSink, HttpAdapter } from '../adapters/types'
import { checkToken } from './auth'

export const HOST = '127.0.0.1'
export const MAX_BODY = 256 * 1024

export interface IngestServerOptions {
  port: number
  /** Called on every request so a regenerated token applies immediately. */
  getToken: () => string
  sink: EventSink
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

const adapters: HttpAdapter[] = [genericAdapter, claudeCodeHooksAdapter]

type Verdict = { ok: true } | { ok: false; status: number; message: string }

/** Shared gate for HTTP requests and WebSocket upgrades. Order: Origin, OPTIONS, Host, token. */
function gate(req: IncomingMessage, port: number, token: string): Verdict {
  if (req.headers.origin !== undefined) return { ok: false, status: 403, message: 'browser requests are not allowed' }
  if (req.method === 'OPTIONS') return { ok: false, status: 403, message: 'forbidden' }
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, message: 'bad host' }
  }
  if (!checkToken(req, token)) return { ok: false, status: 401, message: 'unauthorized' }
  return { ok: true }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return ''
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(data)
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      reject(new HttpError(413, 'payload too large'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY) {
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req)
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
  const { port, getToken, sink } = opts

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const v = gate(req, port, getToken())
    if (!v.ok) {
      sendJson(res, v.status, { error: v.message })
      return
    }
    const path = pathOf(req)
    try {
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }
      const adapter = req.method === 'POST' ? adapters.find((a) => a.route === path) : undefined
      if (!adapter) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const body = await readJson(req)
      const out = await adapter.handle(body, sink)
      sendJson(res, 200, out ?? {})
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error('[agent-office] ingest error:', err)
      if (!res.headersSent) {
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
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const v = gate(req, port, getToken())
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
