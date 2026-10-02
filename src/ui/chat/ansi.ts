// Terminal escape codes in command output: strip them, or keep the SGR colours as spans.
// Pure; covered by tests/chat.test.ts.

// CSI (ESC [ ... final), OSC (ESC ] ... BEL | ESC \), and two-character escapes.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** "\r\n" -> "\n"; a lone "\r" restarts the line (progress bars), so only what follows it stays. */
export function normalizeNewlines(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      const cr = line.lastIndexOf('\r')
      if (cr < 0) return line
      // A trailing "\r" (the chunk ended mid-update) keeps the text before it.
      const tail = line.slice(cr + 1)
      return tail || line.slice(line.lastIndexOf('\r', cr - 1) + 1, cr)
    })
    .join('\n')
}

/** Plain text: no escape sequences, no control characters, "\n" line ends. */
export function stripAnsi(text: string): string {
  return normalizeNewlines(text.replace(ESCAPES, '')).replace(CONTROLS, '')
}

export interface AnsiSpan {
  text: string
  /** 0-15: the palette (CSS class). A string: a literal CSS colour (256-colour / truecolor). */
  fg?: number | string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

interface Style {
  fg?: number | string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

const CUBE = [0, 95, 135, 175, 215, 255]

function color256(n: number): number | string {
  if (n < 16) return n
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const c = n - 16
  return `rgb(${CUBE[Math.floor(c / 36)]},${CUBE[Math.floor(c / 6) % 6]},${CUBE[c % 6]})`
}

const byte = (n: number) => Math.max(0, Math.min(255, n | 0))

function applySgr(style: Style, params: number[]): Style {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) {
      delete s.fg
      delete s.bold
      delete s.dim
      delete s.italic
      delete s.underline
    } else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 22) {
      delete s.bold
      delete s.dim
    } else if (p === 23) delete s.italic
    else if (p === 24) delete s.underline
    else if (p >= 30 && p <= 37) s.fg = p - 30
    else if (p >= 90 && p <= 97) s.fg = p - 90 + 8
    else if (p === 39) delete s.fg
    else if (p === 38 || p === 48) {
      // Extended colour: consume its arguments; background colours are not rendered.
      const mode = params[i + 1]
      if (mode === 5) {
        if (p === 38 && Number.isFinite(params[i + 2])) s.fg = color256(byte(params[i + 2]))
        i += 2
      } else if (mode === 2) {
        if (p === 38) s.fg = `rgb(${byte(params[i + 2])},${byte(params[i + 3])},${byte(params[i + 4])})`
        i += 4
      }
    }
  }
  return s
}

/**
 * Splits output into styled spans (foreground colour, bold, dim, italic, underline). Every other
 * escape sequence is dropped. The span texts joined together equal stripAnsi(text).
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  if (!text.includes('\x1b') && !text.includes('\x9b')) {
    const plain = stripAnsi(text)
    return plain ? [{ text: plain }] : []
  }
  const src = normalizeNewlines(text)
  let style: Style = {}
  let last = 0
  const push = (raw: string) => {
    const clean = raw.replace(CONTROLS, '')
    if (!clean) return
    const prev = spans[spans.length - 1]
    if (prev && prev.fg === style.fg && !!prev.bold === !!style.bold && !!prev.dim === !!style.dim && !!prev.italic === !!style.italic && !!prev.underline === !!style.underline) {
      prev.text += clean
    } else spans.push({ text: clean, ...style })
  }
  ESCAPES.lastIndex = 0
  for (let m = ESCAPES.exec(src); m; m = ESCAPES.exec(src)) {
    push(src.slice(last, m.index))
    last = m.index + m[0].length
    const sgr = /^(?:\x1b\[|\x9b)([0-9;:]*)m$/.exec(m[0]) // eslint-disable-line no-control-regex
    if (sgr) {
      const params = sgr[1] === '' ? [0] : sgr[1].split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)))
      style = applySgr(style, params)
    }
  }
  push(src.slice(last))
  return spans
}

/** The last `max` lines of a text, and how many were cut above them. */
export function tailLines(text: string, max: number): { text: string; cut: number } {
  let count = 0
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) !== 10) continue
    // A final "\n" ends the last line; it does not start an empty one.
    if (i === text.length - 1) continue
    if (++count >= max) {
      let cut = 1
      for (let j = 0; j < i; j++) if (text.charCodeAt(j) === 10) cut++
      return { text: text.slice(i + 1), cut }
    }
  }
  return { text, cut: 0 }
}

export function countLines(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length - 1; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
