// App-level keyboard chords. These are the only keys taken away from a focused terminal.

export type AppChord = { kind: 'new-session' } | { kind: 'toggle-panel' } | { kind: 'select'; index: number }

type KeyLike = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'>

export function appChord(ev: KeyLike): AppChord | null {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return null
  if (ev.code === 'KeyN') return { kind: 'new-session' }
  if (ev.code === 'Backquote') return { kind: 'toggle-panel' }
  const m = /^Digit([1-9])$/.exec(ev.code)
  if (m) return { kind: 'select', index: Number(m[1]) - 1 }
  return null
}

export function inTerminal(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && typeof el.closest === 'function' && !!el.closest('.xterm')
}

/** Is the user typing somewhere (input, textarea, terminal)? Single-key shortcuts must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || inTerminal(el)
}
