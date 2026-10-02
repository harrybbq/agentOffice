// The live preview pane: the web app a session's team is building, shown next to the office.
// Contract between main process and renderer (`window.agentOffice.preview`).
//
// Security rules (do not relax):
// - Only loopback addresses are ever shown: http(s)://localhost | 127.0.0.1 | [::1], with a port.
//   The main process validates every address again; the renderer's check is only for a quick message.
// - The renderer never supplies a command line. `run` takes the NAME of a package.json script that
//   `scripts` returned; the main process builds `npm run <name>` itself.
// - `serveFolder` only ever serves files inside the session's own working folder.

export type PreviewKind =
  | 'dev-server' //  an address a server printed (in the session's output, or a script the app runs)
  | 'static' //      the app serves the session's folder itself, with live reload
  | 'manual' //      an address the user typed

export type PreviewStatus =
  | 'starting' //    a script is starting, or the address has not answered yet
  | 'ready'
  | 'unreachable' // nothing answers at the address (any more)
  | 'stopped' //     the preview is over (only seen in onChanged; `get` then answers null)

export interface PreviewInfo {
  sessionId: string
  /** The address shown in the frame. Empty while a script is starting and has printed none yet. */
  url: string
  kind: PreviewKind
  status: PreviewStatus
  /** The page's <title>, when the app could read it. */
  title?: string
  /** Where the address came from: "terminal", "command output", "npm run dev". */
  detectedFrom?: string
  /** The package.json script the app runs for this preview (`run`). */
  script?: string
  /** Where the frame is now, after links were followed inside it (same server). */
  currentUrl?: string
  /** False when the page tells browsers not to show it inside another page. */
  framable?: boolean
  /** One plain sentence when something is wrong ("The script exited (code 1)."). */
  note?: string
}

export interface PreviewSuggestion {
  url: string
  /** "terminal", "command output", "npm run dev". */
  source: string
}

export interface PreviewBlocked {
  url: string
  /** It was handed to the system browser. */
  opened: boolean
}

export interface PreviewBridge {
  /** The session's preview, or null when it has none. */
  get(sessionId: string): Promise<PreviewInfo | null>
  /** Addresses seen in that session's output that answer right now, newest first. */
  suggestions(sessionId: string): Promise<PreviewSuggestion[]>
  /** Show an address (typed, or a suggestion). Loopback only; rejects with a readable message otherwise. */
  open(sessionId: string, url: string): Promise<PreviewInfo>
  /** Pages the app could serve from the session's folder ("index.html", "dist/index.html"); empty = none. */
  staticEntries(sessionId: string): Promise<string[]>
  /** The app serves the session's folder on a loopback port (with live reload) and shows `relativeEntry`. */
  serveFolder(sessionId: string, relativeEntry?: string): Promise<PreviewInfo>
  /** Names of package.json scripts in the session's folder that look like dev servers. */
  scripts(sessionId: string): Promise<string[]>
  /** The app runs `npm run <scriptName>` in the session's folder and shows the address it prints.
   *  `scriptName` must be one of the names `scripts` returned. */
  run(sessionId: string, scriptName: string): Promise<PreviewInfo>
  /** The recent output of the script the app runs for this session ("" when there is none). */
  log(sessionId: string): Promise<string>
  /** Ends the preview: the app's own server and script are stopped. The session is untouched. */
  stop(sessionId: string): Promise<void>
  onChanged(cb: (info: PreviewInfo) => void): () => void
  /** A hint that files of that session's folder changed (the page reloads by itself). */
  onReload(cb: (sessionId: string) => void): () => void
  /** A new address was seen in that session's output: `suggestions` may answer differently now. */
  onDetected(cb: (sessionId: string) => void): () => void
  /** The page in the frame tried to go to `url`, which is not on this computer: it was stopped
   *  (`opened`: and opened in the system browser instead). The frame should go back to its page. */
  onBlocked(cb: (blocked: PreviewBlocked) => void): () => void
  /** Browser stub only: the built-in demo page to show instead of loading `url`. */
  demoDoc?(sessionId: string): string | null
}

export const PREVIEW_IPC = {
  /** invoke */
  get: 'agent-office:preview:get',
  suggestions: 'agent-office:preview:suggestions',
  open: 'agent-office:preview:open',
  staticEntries: 'agent-office:preview:static-entries',
  serveFolder: 'agent-office:preview:serve-folder',
  scripts: 'agent-office:preview:scripts',
  run: 'agent-office:preview:run',
  log: 'agent-office:preview:log',
  stop: 'agent-office:preview:stop',
  /** main -> renderer: one PreviewInfo */
  changed: 'agent-office:preview:changed',
  /** main -> renderer: a session id */
  reload: 'agent-office:preview:reload',
  detected: 'agent-office:preview:detected',
  /** main -> renderer: one PreviewBlocked */
  blocked: 'agent-office:preview:blocked'
} as const

// ---- addresses ----------------------------------------------------------------------------------

export const PREVIEW_URL_MAX = 2048

export type PreviewUrlResult = { ok: true; url: string; port: number } | { ok: false; error: string }

export const NOT_LOOPBACK =
  'Only addresses on this computer can be previewed (localhost or 127.0.0.1 with a port, like http://localhost:5173).'
const NEEDS_PORT = 'Add the port, like http://localhost:5173.'
const NOT_AN_ADDRESS = 'That is not a web address. Try http://localhost:5173.'

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Not addresses of their own, but what servers print when they listen on every interface. */
const ANY_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '[::]'])

/**
 * Validates an address for the preview frame and returns its normal form.
 * Accepted: http(s) on localhost, 127.0.0.1 or [::1], with an explicit port, without credentials.
 * `[::1]` becomes `localhost` (the app's content security policy cannot name an IPv6 address).
 * With `anyHost`, 0.0.0.0 and [::] (as printed by servers) are accepted and become `localhost` too.
 */
export function parsePreviewUrl(raw: unknown, opts: { anyHost?: boolean } = {}): PreviewUrlResult {
  if (typeof raw !== 'string') return { ok: false, error: NOT_AN_ADDRESS }
  const text = raw.trim()
  if (text.length === 0 || text.length > PREVIEW_URL_MAX || /[\u0000- \u007f\\]/.test(text)) return { ok: false, error: NOT_AN_ADDRESS }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { ok: false, error: NOT_AN_ADDRESS }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: NOT_LOOPBACK }
  if (u.username || u.password) return { ok: false, error: 'An address with a user name or password in it cannot be previewed.' }
  const host = u.hostname.toLowerCase()
  const any = opts.anyHost === true && ANY_HOSTS.has(host)
  if (!LOOPBACK_HOSTS.has(host) && !any) return { ok: false, error: NOT_LOOPBACK }
  // The URL parser drops a default port, so ":80" on http counts as "no port" as well.
  const port = Number(u.port)
  if (!u.port || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: NEEDS_PORT }
  if (host !== '127.0.0.1') u.hostname = 'localhost'
  return { ok: true, url: u.href, port }
}

/** What the user typed in the address field: "localhost:5173" and ":5173" get the missing parts. */
export function completeAddress(typed: string): string {
  const text = typed.trim()
  if (/^:?\d{2,5}(\/.*)?$/.test(text)) return `http://localhost:${text.replace(/^:/, '')}`
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  return `http://${text}`
}

/** Same server? (scheme + port; localhost and 127.0.0.1 count as the same machine). */
export function samePreviewServer(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === y.protocol && x.port === y.port && x.port !== ''
  } catch {
    return false
  }
}
