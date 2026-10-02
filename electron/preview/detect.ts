// Finds the addresses of local web servers in text an agent's tools printed (terminal output,
// command output, chat items): "Local: http://localhost:5173/". Pure: no I/O, no Electron.
// A found address is only a candidate; the preview manager checks that it answers before offering it.
import { parsePreviewUrl } from '../../shared/preview'

/** Addresses returned by one extractAddresses call at most. */
export const DETECT_MAX_PER_TEXT = 8
/** Addresses a StreamScanner remembers as "already reported". */
export const DETECT_MAX_REMEMBERED = 48
/** How much of the previous chunk a StreamScanner keeps, so an address split in two is still found. */
export const DETECT_TAIL_CHARS = 400

// CSI, OSC (terminated by BEL or ST), two-character escapes, then the remaining control characters
// (not tab, newline, carriage return).
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// A scheme, one of the loopback spellings, a port, then an optional path that ends at whitespace or
// at a character that usually closes the address in prose ("(http://0.0.0.0:8000/) ...").
const ADDRESS = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):\d{1,5})([/?#][^\s"'<>`()[\]{}|\\^]*)?/gi
/** The character before a match must not be part of a longer word ("xhttp://"). */
const WORD = /[A-Za-z0-9_]/
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

interface Found {
  url: string
  /** Index just past the match in the scanned text. */
  end: number
}

/** Does the text go on after the port in a way that makes it another address ("…:3000.evil.example", "…:80@host")? */
function continues(text: string, at: number): boolean {
  const c = text[at]
  if (c === undefined) return false
  if (/[A-Za-z0-9_@-]/.test(c)) return true
  // "at http://localhost:3000." ends a sentence; "…:3000.example" does not.
  if (c === '.' || c === ':') return WORD.test(text[at + 1] ?? '')
  return false
}

function find(text: string): Found[] {
  const out: Found[] = []
  ADDRESS.lastIndex = 0
  for (let m = ADDRESS.exec(text); m; m = ADDRESS.exec(text)) {
    const end = m.index + m[0].length
    if (m.index > 0 && WORD.test(text[m.index - 1]!)) continue
    if (m[2] === undefined && continues(text, end)) continue
    const parsed = parsePreviewUrl(m[1]! + (m[2] ?? '').replace(TRAILING_PUNCTUATION, ''), { anyHost: true })
    if (parsed.ok) out.push({ url: parsed.url, end })
  }
  return out
}

/**
 * The loopback addresses in `text`, in order of appearance, normalised (0.0.0.0, [::] and [::1]
 * become localhost), without duplicates, at most DETECT_MAX_PER_TEXT.
 */
export function extractAddresses(text: string): string[] {
  const out: string[] = []
  for (const f of find(stripAnsi(text))) {
    if (!out.includes(f.url)) out.push(f.url)
    if (out.length >= DETECT_MAX_PER_TEXT) break
  }
  return out
}

/**
 * Finds addresses in output that arrives in chunks. It keeps only the last few hundred characters
 * (never the whole output), reports every address once, and waits with an address that touches the
 * end of a chunk until it knows where the address ends ("…:51" then "73/").
 */
export class StreamScanner {
  private tail = ''
  private seen: string[] = []

  /** Feeds one chunk. Returns the addresses that are new. */
  push(chunk: string): string[] {
    return typeof chunk === 'string' && chunk.length > 0 ? this.scan(chunk, false) : []
  }

  /** The output paused: an address at the very end of what was seen counts now. */
  flush(): string[] {
    return this.scan('', true)
  }

  private scan(chunk: string, atEnd: boolean): string[] {
    const raw = this.tail + chunk
    this.tail = raw.length > DETECT_TAIL_CHARS ? raw.slice(-DETECT_TAIL_CHARS) : raw
    // Cheap way out for the usual chunk: nothing that looks like an address at all.
    if (!raw.includes('://')) return []
    const text = stripAnsi(raw)
    const fresh: string[] = []
    for (const f of find(text)) {
      if (!atEnd && f.end >= text.length) continue // may still be growing
      if (this.seen.includes(f.url) || fresh.includes(f.url)) continue
      fresh.push(f.url)
      if (fresh.length >= DETECT_MAX_PER_TEXT) break
    }
    this.seen.push(...fresh)
    if (this.seen.length > DETECT_MAX_REMEMBERED) this.seen.splice(0, this.seen.length - DETECT_MAX_REMEMBERED)
    return fresh
  }
}
