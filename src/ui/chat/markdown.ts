// A small Markdown tokenizer for assistant messages: text -> a plain AST. The renderer
// (components/chat/Markdown.tsx) turns the AST into React elements, so model text never becomes
// HTML: there is no raw-HTML node type at all, and "<script>" is just text.
// Tolerant of half-written input (a message is re-parsed while it streams).
// Pure; covered by tests/chat.test.ts.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'del'; children: Inline[] }
  /** `href` is always an absolute http(s) URL (see safeHref). */
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'br' }

export interface ListItem {
  /** Task list state ("- [x] done"), or null for a normal item. */
  checked: boolean | null
  blocks: Block[]
}

export type Align = 'left' | 'center' | 'right' | null

export type Block = (
  | { t: 'p'; children: Inline[] }
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  /** `closed` is false while the closing fence has not arrived yet. */
  | { t: 'code'; lang: string; text: string; closed: boolean }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }
) & {
  /** The source lines of the block: equal source means equal output (lets the renderer skip work). */
  src: string
}

const MAX_DEPTH = 8
/** Longer inline runs are shown as plain text (keeps the worst case linear). */
const MAX_INLINE_CHARS = 20_000

/**
 * The URL to open for a Markdown link, or null when it must not be a link. Only absolute http and
 * https URLs pass: no javascript:, data:, file:, custom schemes, relative paths or credentials.
 */
export function safeHref(raw: string): string | null {
  const s = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (!/^https?:\/\//i.test(s) || /[\x00-\x20\x7f]/.test(s)) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname || u.username || u.password) return null
    return u.href
  } catch {
    return null
  }
}

// ---- inline -----------------------------------------------------------------------------------

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i

/** Trailing punctuation of a bare URL belongs to the sentence, and so does an unmatched ")". */
function trimUrl(url: string): string {
  let u = url.replace(/[.,;:!?*_~]+$/, '')
  const count = (ch: string) => u.split(ch).length - 1
  while (u.endsWith(')') && count('(') < count(')')) u = u.slice(0, -1).replace(/[.,;:!?]+$/, '')
  return u
}

function pushText(out: Inline[], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.t === 'text') last.text += text
  else out.push({ t: 'text', text })
}

/** Finds the closing delimiter of an emphasis run that opened at `from - delim.length`. */
function findClose(s: string, delim: string, from: number): number {
  let i = from
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1)
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (s.startsWith(delim, i) && !isSpace(s[i - 1])) {
      // "**" must not match the first two stars of "***".
      if (delim.length === 1 && (delim === '*' || delim === '_') && s[i + 1] === delim && s[i - 1] !== delim) {
        i += 2
        continue
      }
      if (delim === '_' || delim === '__') {
        if (isWord(s[i + delim.length])) {
          i += delim.length
          continue
        }
      }
      return i
    }
    i++
  }
  return -1
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = []
  if (depth > MAX_DEPTH || src.length > MAX_INLINE_CHARS) {
    pushText(out, src)
    return out
  }
  let i = 0
  let text = ''
  const flush = () => {
    pushText(out, text)
    text = ''
  }
  while (i < src.length) {
    const c = src[i]

    if (c === '\\') {
      const n = src[i + 1]
      if (n === '\n') {
        flush()
        out.push({ t: 'br' })
        i += 2
        continue
      }
      if (n && /[\\`*_{}[\]()#+\-.!|<>~]/.test(n)) {
        text += n
        i += 2
        continue
      }
      text += c
      i++
      continue
    }

    if (c === '\n') {
      // GitHub-comment style: a line break in the source is a line break in the output.
      text = text.replace(/[ \t]+$/, '')
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }

    if (c === '`') {
      let run = 1
      while (src[i + run] === '`') run++
      const fence = '`'.repeat(run)
      let end = src.indexOf(fence, i + run)
      while (end >= 0 && src[end + run] === '`') {
        // A longer run of backticks is not the closer.
        let skip = end
        while (src[skip] === '`') skip++
        end = src.indexOf(fence, skip)
      }
      if (end >= 0) {
        flush()
        let code = src.slice(i + run, end).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
        out.push({ t: 'code', text: code })
        i = end + run
        continue
      }
      text += fence
      i += run
      continue
    }

    if (c === '*' || c === '_' || c === '~') {
      const double = src[i + 1] === c
      if (c === '~' && !double) {
        text += c
        i++
        continue
      }
      const delim = double ? c + c : c
      const after = src[i + delim.length]
      const before = src[i - 1]
      const canOpen = !isSpace(after) && (c !== '_' || !isWord(before))
      if (canOpen) {
        const close = findClose(src, delim, i + delim.length)
        if (close > i + delim.length) {
          flush()
          const children = parseInline(src.slice(i + delim.length, close), depth + 1)
          out.push(c === '~' ? { t: 'del', children } : double ? { t: 'strong', children } : { t: 'em', children })
          i = close + delim.length
          continue
        }
      }
      text += delim
      i += delim.length
      continue
    }

    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      // [label](url "title"); images are shown as links to the image (nothing is fetched).
      const open = c === '!' ? i + 1 : i
      let j = open + 1
      let level = 1
      while (j < src.length && level > 0) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') level++
        else if (src[j] === ']') level--
        if (level > 0) j++
      }
      if (level === 0 && src[j + 1] === '(') {
        let k = j + 2
        let paren = 1
        while (k < src.length && paren > 0) {
          if (src[k] === '\\') k++
          else if (src[k] === '(') paren++
          else if (src[k] === ')') paren--
          else if (src[k] === '\n') break
          if (paren > 0) k++
        }
        if (paren === 0) {
          const label = src.slice(open + 1, j)
          const target = src
            .slice(j + 2, k)
            .trim()
            .replace(/\s+["'(].*["')]$/, '')
            .replace(/^<(.*)>$/, '$1')
          const href = safeHref(target)
          flush()
          if (href) {
            const children = parseInline(label || target, depth + 1)
            out.push({ t: 'link', href, children: stripLinks(children) })
          } else {
            // Not a URL we would open: keep what the author wrote, as text.
            pushText(out, src.slice(i, k + 1))
          }
          i = k + 1
          continue
        }
      }
      text += c
      i++
      continue
    }

    if (c === '<') {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i, i + 2100))
      const href = m && safeHref(m[1])
      if (m && href) {
        flush()
        out.push({ t: 'link', href, children: [{ t: 'text', text: m[1] }] })
        i += m[0].length
        continue
      }
      text += c
      i++
      continue
    }

    if ((c === 'h' || c === 'H') && !isWord(src[i - 1])) {
      const m = BARE_URL.exec(src.slice(i, i + 2100))
      if (m) {
        const url = trimUrl(m[0])
        const href = safeHref(url)
        if (href) {
          flush()
          out.push({ t: 'link', href, children: [{ t: 'text', text: url }] })
          i += url.length
          continue
        }
      }
    }

    text += c
    i++
  }
  flush()
  return out
}

/** A link inside a link label is just its text. */
function stripLinks(nodes: Inline[]): Inline[] {
  return nodes.flatMap((n) => (n.t === 'link' ? stripLinks(n.children) : 'children' in n ? [{ ...n, children: stripLinks(n.children) }] : [n]))
}

/** The text of inline nodes, without formatting (for titles, aria labels and tests). */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.text : n.t === 'br' ? '\n' : inlineText(n.children))).join('')
}

// ---- blocks -----------------------------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

function splitRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inCode = false
  const s = line.trim()
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '`') {
      inCode = !inCode
      cur += c
    } else if (c === '|' && !inCode) {
      cells.push(cur)
      cur = ''
    } else cur += c
  }
  cells.push(cur)
  if (s.startsWith('|')) cells.shift()
  if (s.endsWith('|') && !s.endsWith('\\|')) cells.pop()
  return cells.map((x) => x.trim())
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line)
}

export function parseMarkdown(text: string, depth = 0): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const blocks: Block[] = []
  if (depth > MAX_DEPTH) {
    if (text.trim()) blocks.push({ t: 'p', children: [{ t: 'text', text }], src: text })
    return blocks
  }
  let i = 0
  const srcOf = (from: number, to: number) => lines.slice(from, to).join('\n')

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const start = i

    const fence = FENCE.exec(line)
    if (fence) {
      const indent = fence[1].length
      const marker = fence[2]
      const body: string[] = []
      let closed = false
      i++
      while (i < lines.length) {
        const l = lines[i]
        const t = l.trim()
        if (t.startsWith(marker) && t[0] === marker[0] && /^(`+|~+)$/.test(t) && t.length >= marker.length) {
          closed = true
          i++
          break
        }
        body.push(indent > 0 && l.startsWith(' '.repeat(indent)) ? l.slice(indent) : l)
        i++
      }
      blocks.push({ t: 'code', lang: fence[3].toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 24), text: body.join('\n'), closed, src: srcOf(start, i) })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      i++
      blocks.push({ t: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline((heading[2] ?? '').trim(), depth), src: line })
      continue
    }

    if (HR.test(line)) {
      i++
      blocks.push({ t: 'hr', src: line })
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i])
        if (m) inner.push(m[1])
        else if (lines[i].trim() && !startsBlock(lines[i])) inner.push(lines[i]) // lazy continuation
        else break
        i++
      }
      blocks.push({ t: 'quote', blocks: parseMarkdown(inner.join('\n'), depth + 1), src: srcOf(start, i) })
      continue
    }

    const first = LIST.exec(line)
    if (first && first[1].length <= 3) {
      const ordered = /\d/.test(first[2])
      const bullet = ordered ? first[2].slice(-1) : first[2]
      const items: ListItem[] = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i])
        if (!m || m[1].length > 3 || /\d/.test(m[2]) !== ordered || (ordered ? m[2].slice(-1) : m[2]) !== bullet) break
        // An empty bullet line that is really a rule ("---") was handled above; "* * *" too.
        const contentIndent = m[1].length + m[2].length + Math.min(Math.max(m[3].length, 1), 4)
        const body: string[] = [m[4]]
        i++
        while (i < lines.length) {
          const l = lines[i]
          if (!l.trim()) {
            // A blank line stays in the item only when indented content follows it.
            let k = i + 1
            while (k < lines.length && !lines[k].trim()) k++
            const next = lines[k]
            if (next !== undefined && next.length - next.trimStart().length >= contentIndent) {
              body.push('')
              i++
              continue
            }
            break
          }
          const ind = l.length - l.trimStart().length
          if (ind >= contentIndent) body.push(l.slice(contentIndent))
          else if (ind >= 2 && ind > m[1].length && LIST.test(l)) body.push(l.slice(Math.min(ind, contentIndent))) // a nested list indented less than the text
          else if (!startsBlock(l) && body[body.length - 1] !== '') body.push(l.trimStart()) // lazy continuation
          else break
          i++
        }
        let checked: boolean | null = null
        const task = /^\[([ xX])\](?: +|$)/.exec(body[0])
        if (task) {
          checked = task[1] !== ' '
          body[0] = body[0].slice(task[0].length)
        }
        items.push({ checked, blocks: parseMarkdown(body.join('\n'), depth + 1) })
        // Blank lines between items don't end the list.
        let k = i
        while (k < lines.length && !lines[k].trim()) k++
        if (k > i && k < lines.length && LIST.test(lines[k])) i = k
      }
      blocks.push({ t: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) || 1 : 1, items, src: srcOf(start, i) })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line)
      const sep = splitRow(lines[i + 1])
      if (head.length === sep.length && head.length > 0) {
        const align: Align[] = sep.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
        const rows: Inline[][][] = []
        i += 2
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitRow(lines[i])
          rows.push(head.map((_, c) => parseInline(cells[c] ?? '', depth)))
          i++
        }
        blocks.push({ t: 'table', align, head: head.map((c) => parseInline(c, depth)), rows, src: srcOf(start, i) })
        continue
      }
    }

    // Paragraph: until a blank line or the start of another block.
    i++
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      // A table that follows a paragraph line without a blank line in between.
      if (lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) break
      i++
    }
    const body = lines
      .slice(start, i)
      .map((l) => l.trim())
      .join('\n')
    blocks.push({ t: 'p', children: parseInline(body, depth), src: srcOf(start, i) })
  }
  return blocks
}
