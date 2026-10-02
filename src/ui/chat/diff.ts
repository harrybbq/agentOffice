// Unified diff -> rows for the diff viewer. Pure; covered by tests/chat.test.ts.

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo?: number
  newNo?: number
}

export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  removed: number
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/
const FILE_HEADER = /^(?:diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |Binary files )/

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * `change` tells how to read a diff that has no hunk headers: for an added file the provider may
 * send the raw file content (every line is an addition), for a deleted one the removed content.
 */
export function parseDiff(diff: string, change: 'add' | 'delete' | 'update' = 'update'): ParsedDiff {
  const out: ParsedDiff = { lines: [], added: 0, removed: 0 }
  if (!diff) return out
  const src = splitLines(diff)
  const hasHunks = src.some((l) => HUNK.test(l))

  if (!hasHunks && change !== 'update') {
    const kind = change === 'add' ? 'add' : 'del'
    // A raw "+line" listing without headers is still a diff body: drop the markers then.
    const marker = kind === 'add' ? '+' : '-'
    const marked = src.length > 0 && src.every((l) => l.startsWith(marker))
    src.forEach((l, i) => {
      const text = marked ? l.slice(1) : l
      out.lines.push(kind === 'add' ? { kind, text, newNo: i + 1 } : { kind, text, oldNo: i + 1 })
    })
    if (kind === 'add') out.added = src.length
    else out.removed = src.length
    return out
  }

  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    const h = HUNK.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[3])
      inHunk = true
      out.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (!inHunk && hasHunks) continue // file headers before the first hunk
    if (!hasHunks && FILE_HEADER.test(line)) continue
    if (hasHunks && (/^diff --git /.test(line) || (line.startsWith('--- ') && (src[i + 1] ?? '').startsWith('+++ ')))) {
      inHunk = false // the next file of a multi-file diff
      continue
    }
    const c = line[0]
    if (c === '+') {
      out.lines.push(hasHunks ? { kind: 'add', text: line.slice(1), newNo: newNo++ } : { kind: 'add', text: line.slice(1) })
      out.added++
    } else if (c === '-') {
      out.lines.push(hasHunks ? { kind: 'del', text: line.slice(1), oldNo: oldNo++ } : { kind: 'del', text: line.slice(1) })
      out.removed++
    } else {
      const text = c === ' ' ? line.slice(1) : line
      out.lines.push(hasHunks ? { kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ } : { kind: 'ctx', text })
    }
  }
  return out
}

/** The first `max` rows when the diff is longer than `max + slack` (so "show all" always reveals a useful amount). */
export function clipDiff(lines: readonly DiffLine[], max: number, slack = 8): { lines: readonly DiffLine[]; hidden: number } {
  if (lines.length <= max + slack) return { lines, hidden: 0 }
  return { lines: lines.slice(0, max), hidden: lines.length - max }
}
