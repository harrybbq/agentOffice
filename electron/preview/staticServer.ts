// The preview's own web server: serves ONE folder (a session's working folder) on 127.0.0.1 at a
// random port, read-only, with a live-reload hook for HTML pages. No Electron imports.
//
// What it refuses, always:
// - anything that is not GET or HEAD;
// - a Host header that is not 127.0.0.1:<port> / localhost:<port> (DNS rebinding);
// - requests another web page makes in the background (a foreign Origin, or Sec-Fetch-Site saying
//   "another site" for anything but opening the page itself);
// - every path that leaves the folder once links and junctions are resolved;
// - dotfiles and dot-folders (.env, .git, …), device names and odd Windows spellings;
// - folders: no listing, only their index.html.
import { createReadStream, promises as fsp } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, sep } from 'node:path'

export const STATIC_HOST = '127.0.0.1'
/** The live-reload stream and the script that listens to it. Never files of the folder. */
export const RELOAD_ROUTE = '/__ao_reload'
export const RELOAD_SCRIPT_ROUTE = '/__ao_reload.js'
/** HTML pages larger than this are served as they are, without the reload hook. */
export const INJECT_MAX_BYTES = 8 * 1024 * 1024
const MAX_RELOAD_CLIENTS = 16
const HEARTBEAT_MS = 25_000

const RELOAD_SCRIPT =
  '(function(){if(window.__aoReload)return;window.__aoReload=true;var n=0;' +
  "var es=new EventSource('" +
  RELOAD_ROUTE +
  "');" +
  "es.addEventListener('reload',function(){location.reload()});" +
  'es.onopen=function(){n=0};es.onerror=function(){if(++n>40)es.close()}})();\n'
const RELOAD_TAG = `<script src="${RELOAD_SCRIPT_ROUTE}"></script>`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf'
}

export function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

// ---- paths ---------------------------------------------------------------------------------------

const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/** One path segment a request (or a serveFolder entry) may name. */
export function isServableSegment(seg: string): boolean {
  if (seg.length === 0 || seg.length > 255) return false
  if (seg.startsWith('.')) return false // dotfiles, dot-folders, "." and ".."
  if (/[\u0000-\u001f\u007f\\/:*?"<>|]/.test(seg)) return false // separators, drive letters, streams, wildcards
  if (/[. ]$/.test(seg)) return false // Windows drops trailing dots and spaces: "x.env." would be "x.env"
  if (seg.includes('~')) return false // 8.3 short names ("GIT~1")
  return !DEVICE_NAME.test(seg)
}

/**
 * The segments of a request path ("/css/site.css" -> ["css", "site.css"]), percent-decoded once.
 * Null when the path is malformed or names anything that is never served.
 */
export function requestSegments(pathname: string): string[] | null {
  if (!pathname.startsWith('/')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const segs = decoded.split('/').filter((s) => s.length > 0)
  if (segs.length > 64) return null
  return segs.every(isServableSegment) ? segs : null
}

/** Is `target` (already resolved) inside `rootReal` (or the root itself), without passing a dot-folder? */
export function isInside(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target)
  if (rel === '') return true
  if (isAbsolute(rel) || rel.startsWith('..')) return false
  return rel.split(sep).every((s) => !s.startsWith('.'))
}

/**
 * The real file behind `segments` under the folder: links and junctions are followed first, and the
 * result must still be inside the folder. Null = does not exist, is not servable, or escapes.
 */
export async function resolveInFolder(rootReal: string, segments: readonly string[]): Promise<{ path: string; isDirectory: boolean; size: number } | null> {
  if (!segments.every(isServableSegment)) return null
  try {
    const real = await fsp.realpath(join(rootReal, ...segments))
    if (!isInside(rootReal, real)) return null
    const st = await fsp.stat(real)
    if (st.isDirectory()) return { path: real, isDirectory: true, size: 0 }
    return st.isFile() ? { path: real, isDirectory: false, size: st.size } : null
  } catch {
    return null
  }
}

// ---- server --------------------------------------------------------------------------------------

export interface StaticServerOptions {
  /** The folder to serve. Must exist. */
  root: string
}

export interface StaticServer {
  port: number
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** Tells every open page to reload. */
  reload(): void
  /** Pages listening for reloads right now. */
  listeners(): number
  close(): Promise<void>
}

function send(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...baseHeaders(),
    ...extra
  })
  res.end(text)
}

function baseHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Other sites may not pull these files in as images, scripts or styles.
    'Cross-Origin-Resource-Policy': 'same-origin'
  }
}

/** Adds the reload hook to an HTML page: before the last </body>, or at the end. */
export function injectReload(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at === -1 ? html + RELOAD_TAG : html.slice(0, at) + RELOAD_TAG + html.slice(at)
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServer> {
  const rootReal = await fsp.realpath(opts.root)
  if (!(await fsp.stat(rootReal)).isDirectory()) throw new Error('that is not a folder')
  const streams = new Set<ServerResponse>()
  let port = 0

  const allowed = (req: IncomingMessage): { status: number; message: string } | null => {
    const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { status: 403, message: 'bad host' }
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return { status: 403, message: 'forbidden' }
    // A page of another site (or of another local server) fetching from here in the background.
    const site = req.headers['sec-fetch-site']
    if ((site === 'cross-site' || site === 'same-site') && req.headers['sec-fetch-mode'] !== 'navigate') return { status: 403, message: 'forbidden' }
    return null
  }

  const serveFile = async (req: IncomingMessage, res: ServerResponse, file: { path: string; size: number }): Promise<void> => {
    const type = mimeOf(file.path)
    const head = req.method === 'HEAD'
    if (type.startsWith('text/html') && file.size <= INJECT_MAX_BYTES) {
      const body = Buffer.from(injectReload(await fsp.readFile(file.path, 'utf8')), 'utf8')
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, ...baseHeaders() })
      res.end(head ? undefined : body)
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': file.size, ...baseHeaders() })
    if (head) return void res.end()
    const stream = createReadStream(file.path)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const no = allowed(req)
    if (no) return send(res, no.status, no.message)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET and HEAD only', { Allow: 'GET, HEAD' })
    const raw = req.url ?? '/'
    const cut = raw.search(/[?#]/)
    const pathname = cut === -1 ? raw : raw.slice(0, cut)
    const query = cut === -1 ? '' : raw.slice(cut)

    if (pathname === RELOAD_SCRIPT_ROUTE) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(RELOAD_SCRIPT), ...baseHeaders() })
      return void res.end(req.method === 'HEAD' ? undefined : RELOAD_SCRIPT)
    }
    if (pathname === RELOAD_ROUTE) {
      if (req.method === 'HEAD') return send(res, 405, 'GET only', { Allow: 'GET' })
      if (streams.size >= MAX_RELOAD_CLIENTS) return send(res, 503, 'too many pages are listening')
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', ...baseHeaders() })
      res.write('retry: 1500\n: connected\n\n')
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }

    const segments = requestSegments(pathname)
    if (!segments) return send(res, 404, 'not found')
    const found = await resolveInFolder(rootReal, segments)
    if (!found) return send(res, 404, 'not found')
    if (!found.isDirectory) return serveFile(req, res, found)
    // A folder: its index.html, never a listing. Without the trailing slash relative links would break.
    const index = await resolveInFolder(rootReal, [...segments, 'index.html'])
    if (!index || index.isDirectory) return send(res, 404, 'not found')
    if (!pathname.endsWith('/')) return send(res, 301, 'moved', { Location: '/' + segments.map(encodeURIComponent).join('/') + '/' + (query.startsWith('?') ? query : '') })
    return serveFile(req, res, index)
  }

  const server: Server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'internal error')
      else res.destroy()
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.timeout = 0 // the reload stream stays open

  const heartbeat = setInterval(() => {
    for (const s of streams) s.write(': still here\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, STATIC_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('the preview server did not start')
  }
  port = address.port
  server.on('error', (err) => console.error('[agent-office] preview server error:', err))

  let closed: Promise<void> | null = null
  return {
    port,
    origin: `http://${STATIC_HOST}:${port}`,
    reload: () => {
      for (const s of streams) s.write('event: reload\ndata: 1\n\n')
    },
    listeners: () => streams.size,
    close: () =>
      (closed ??= new Promise<void>((done) => {
        clearInterval(heartbeat)
        for (const s of streams) s.destroy()
        streams.clear()
        server.closeAllConnections()
        server.close(() => done())
      }))
  }
}

// ---- folder watching -----------------------------------------------------------------------------

/** Folders whose changes are never a reason to reload. */
export const WATCH_IGNORED: readonly string[] = ['node_modules', '.git', 'out', 'dist']
export const WATCH_DEBOUNCE_MS = 150

/**
 * Does a change of this path (relative to the watched folder) matter? Dot-folders, node_modules and
 * build output do not, unless `keep` names one of them (the page being served lives in it: "dist").
 */
export function isWatchedPath(rel: string, keep: readonly string[] = []): boolean {
  const segs = rel.split(/[\\/]/).filter((s) => s.length > 0)
  if (segs.length === 0) return false
  return !segs.some((s) => !keep.includes(s) && (WATCH_IGNORED.includes(s) || s.startsWith('.')))
}
