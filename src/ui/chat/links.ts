// What a click on a link in a chat answer does. In the app the main process opens the system
// browser (bridge.openExternal) and says whether it did; in the browser stub the link opens in a
// new tab. When neither works the URL is copied, so a link is never a dead end.
// Pure: the three effects come in through `deps`, so tests can drive every branch.

export type LinkOutcome =
  /** The system browser has it (the app). */
  | 'browser'
  /** A new tab has it (the stub in a real browser): nothing to say. */
  | 'tab'
  /** It could not be opened; the URL is on the clipboard. */
  | 'copied'
  | 'failed'

export interface LinkDeps {
  /** AgentOfficeBridge.openExternal, when the bridge has it. */
  openExternal?: (url: string) => Promise<boolean>
  /** window.open: truthy when a window was opened. */
  openWindow: (url: string) => unknown
  copy: (url: string) => Promise<void>
}

export async function openLink(href: string, deps: LinkDeps): Promise<LinkOutcome> {
  let opened = false
  if (deps.openExternal) {
    opened = await deps.openExternal(href).then(
      (ok) => ok === true,
      () => false
    )
    if (opened) return 'browser'
  } else {
    try {
      opened = !!deps.openWindow(href)
    } catch {
      opened = false
    }
    if (opened) return 'tab'
  }
  return deps.copy(href).then(
    () => 'copied' as const,
    () => 'failed' as const
  )
}

/** The note shown next to the link for a moment, or null when the outcome speaks for itself. */
export function linkNote(outcome: LinkOutcome): string | null {
  if (outcome === 'browser') return 'Opened in your browser'
  if (outcome === 'copied') return "Couldn't open it · link copied"
  return null
}
