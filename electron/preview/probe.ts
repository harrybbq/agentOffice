// "Does anything answer at this address?" for the preview. Loopback only: the address is validated
// here again, redirects are never followed, and only the first bytes of the answer are read.
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import { parsePreviewUrl } from '../../shared/preview'

export const PROBE_TIMEOUT_MS = 1500
const TITLE_BYTES = 64 * 1024

export interface ProbeResult {
  reachable: boolean
  /** The page's <title>, when the answer was HTML and had one. */
  title?: string
  /** False when the answer forbids being shown inside another page. */
  framable?: boolean
}

/** Do the response headers forbid showing the page in a frame of another origin? */
export function forbidsFraming(headers: IncomingMessage['headers']): boolean {
  const xfo = headers['x-frame-options']
  if (typeof xfo === 'string' && /\b(deny|sameorigin)\b/i.test(xfo)) return true
  const csp = ([] as string[]).concat(headers['content-security-policy'] ?? []).join(';')
  const m = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp)
  if (!m) return false
  const sources = m[1]!.trim().split(/\s+/)
  return !sources.some((s) => s === '*' || /^file:/i.test(s))
}

export function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([^<]{0,300})/i.exec(html)
  const title = m?.[1]?.replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, 120) : undefined
}

/** One GET. Any HTTP answer counts as reachable (a 404 page is still a server that is up). */
export function probeHttp(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const parsed = parsePreviewUrl(url)
  if (!parsed.ok) return Promise.resolve({ reachable: false })
  const u = new URL(parsed.url)
  return new Promise<ProbeResult>((resolve) => {
    let done = false
    const finish = (r: ProbeResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.destroy()
      resolve(r)
    }
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Accept: 'text/html,*/*;q=0.8', 'User-Agent': 'AgentOffice-Preview' },
        agent: false,
        // A dev server's own certificate: we only ask whether something answers, on this machine.
        ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        const framable = !forbidsFraming(res.headers)
        const html = /text\/html/i.test(String(res.headers['content-type'] ?? ''))
        if (!html) return finish({ reachable: true, framable })
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.length >= TITLE_BYTES || /<\/title>/i.test(body)) finish({ reachable: true, framable, title: titleOf(body) })
        })
        res.on('end', () => finish({ reachable: true, framable, title: titleOf(body) }))
        res.on('error', () => finish({ reachable: true, framable }))
      }
    )
    const timer = setTimeout(() => finish({ reachable: false }), timeoutMs)
    req.on('error', () => finish({ reachable: false }))
    req.end()
  })
}

/** Is the port open? Leaves no line in the server's request log (used for the repeated check). */
export function probePort(url: string, timeoutMs = 1000): Promise<boolean> {
  const parsed = parsePreviewUrl(url)
  if (!parsed.ok) return Promise.resolve(false)
  const host = new URL(parsed.url).hostname
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port: parsed.port })
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
