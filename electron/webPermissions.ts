// Web permissions for the renderer. Everything is refused except the clipboard for the app's own
// page: the terminal copies with Ctrl+Shift+C and pastes on right-click through navigator.clipboard.
// (Ctrl+V is a native paste and needs no permission.)

const ALLOWED: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'clipboard-read'])

/**
 * `ours`: the request comes from the app's own window (never a webview, popup or other page).
 * `mainFrame`: it comes from the window's own page, not from a frame inside it: the preview pane
 * shows other pages in a frame of the same window, and those get nothing.
 */
export function allowWebPermission(permission: string, ours: boolean, mainFrame = true): boolean {
  return ours && mainFrame === true && ALLOWED.has(permission)
}

/** Absolute http(s) URL without credentials: safe to hand to the system browser. */
export function isExternalWebUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  try {
    const u = new URL(raw)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
  } catch {
    return false
  }
}
