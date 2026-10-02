// Where a frame inside the app's window may go. The window's own page keeps its own rules
// (main.ts); every other frame (the preview and whatever the previewed page embeds) may only load
// loopback http(s) pages that are not the app itself. Pure: no Electron imports.
import { parsePreviewUrl } from '../../shared/preview'
import { isExternalWebUrl } from '../webPermissions'

export type FrameVerdict =
  | 'allow'
  | 'external' // cancel it here; a plain web address may open in the system browser instead
  | 'block' //    cancel it

/** `selfPorts`: loopback ports that are the app itself (ingest server, dev renderer). */
export function subFrameNavigation(url: unknown, selfPorts: readonly number[] = []): FrameVerdict {
  if (typeof url !== 'string') return 'block'
  // An empty frame a page creates for itself. It has the origin of that page, never the app's.
  if (url === 'about:blank' || url === 'about:srcdoc') return 'allow'
  const local = parsePreviewUrl(url)
  if (local.ok) return selfPorts.includes(local.port) ? 'block' : 'allow'
  if (!isExternalWebUrl(url)) return 'block'
  // A web address on this machine that is not a preview address (no port, the app's own port, …).
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0') return 'block'
  } catch {
    return 'block'
  }
  return 'external'
}

/**
 * Lets at most one page per `everyMs` out to the system browser: a previewed page that redirects
 * itself in a loop must not fill the browser with tabs.
 */
export class ExternalGate {
  private last = Number.NEGATIVE_INFINITY

  constructor(
    private readonly everyMs = 3000,
    private readonly now: () => number = Date.now
  ) {}

  allow(): boolean {
    const t = this.now()
    if (t - this.last < this.everyMs) return false
    this.last = t
    return true
  }
}

/** Chromium's net error for a navigation the embedding page's content security policy forbids (frame-src). */
export const ERR_BLOCKED_BY_CSP = -30
/** Chromium's net error for "the response forbids being shown here" (X-Frame-Options, frame-ancestors). */
export const ERR_BLOCKED_BY_RESPONSE = -27
/** A navigation that was replaced or cancelled (also by our own guard): not a failure of the page. */
export const ERR_ABORTED = -3
