// Web permissions for the renderer. Everything is refused except the clipboard for the app's own
// page: the terminal copies with Ctrl+Shift+C and pastes on right-click through navigator.clipboard.
// (Ctrl+V is a native paste and needs no permission.)

const ALLOWED: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'clipboard-read'])

/** `ours`: the request comes from the app's own window (never a webview, popup or other page). */
export function allowWebPermission(permission: string, ours: boolean): boolean {
  return ours && ALLOWED.has(permission)
}
