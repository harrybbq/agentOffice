// Token usage of Claude Code sessions. Hooks carry no usage, so it is read from the session's
// transcript: every hook payload names it (`transcript_path`), and each assistant entry in that
// JSONL file has the `message.usage` the API reported.
//
// Rules:
// - Read-only, and only files under the user's `~/.claude/projects` (the path comes from a hook
//   payload, so it is checked: resolved, inside that folder also after following links, `.jsonl`).
// - Incremental: the byte offset per file is remembered and only appended bytes are read, in
//   chunks, with a cap per tick. The whole file is never loaded and a line is never kept unless it
//   is an assistant entry. A line that is not complete yet waits (as bytes) for its end.
// - Nothing but numbers (and the model id) leaves this module: no message text is kept or passed on.
// - The transcript format is internal to Claude Code and may change: anything unexpected is skipped,
//   and an agent whose transcript yields nothing simply has no tokens.
// - No timer of its own: a read is asked for by a hook (Stop, SubagentStop, PostToolUse) and runs
//   once, a little later (debounced), plus short follow-ups while a large file is being caught up.
//
// No Electron imports; the file system, the folder and the scheduler are injectable for the tests.
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { TokenUsage } from '../shared/inspector'

/** A read runs this long after the first hook that asked for it; hooks in between are absorbed. */
export const TRANSCRIPT_DEBOUNCE_MS = 2000
/** At most this many bytes are read per tick; the rest follows after TRANSCRIPT_CATCHUP_MS. */
export const TRANSCRIPT_TICK_BYTES = 4 * 1024 * 1024
export const TRANSCRIPT_CATCHUP_MS = 50
const CHUNK_BYTES = 256 * 1024
/** A single line longer than this is skipped (never buffered whole). */
export const TRANSCRIPT_MAX_LINE_BYTES = 8 * 1024 * 1024
/** Message ids remembered per file for the de-duplication (the same message spans a few adjacent lines). */
const MAX_SEEN_IDS = 2000
const MAX_TAILS = 300
const ASSISTANT_MARK = Buffer.from('"assistant"')
const NEWLINE = 0x0a

export interface TranscriptFs {
  openSync(path: string, flags: 'r'): number
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  fstatSync(fd: number): { size: number; isFile(): boolean }
  closeSync(fd: number): void
  realpathSync(path: string): string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/** `~/.claude/projects`: where Claude Code keeps its transcripts. */
export const defaultTranscriptRoot = (): string => join(homedir(), '.claude', 'projects')

/**
 * The path of a transcript, if it may be read: an absolute `.jsonl` path inside `root`. Returns the
 * resolved path, or null. (Links are checked again when the file is opened.)
 */
export function transcriptPath(path: unknown, root: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.includes('\0')) return null
  if (!isAbsolute(path) || !/\.jsonl$/i.test(path)) return null
  const full = resolve(path)
  const rel = relative(resolve(root), full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return full
}

/**
 * Where a subagent's transcript is, given the hook payload of its session: the payload's own
 * `agent_transcript_path` (SubagentStop), else `<session-id>/subagents/agent-<agentId>.jsonl` next
 * to the main transcript. Null when the pieces are not there.
 */
export function subagentTranscriptPath(transcript: unknown, agentId: unknown, given?: unknown): string | null {
  if (typeof given === 'string' && given.length > 0) return given
  if (typeof transcript !== 'string' || typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(agentId)) return null
  // A payload whose transcript is already the subagent's own file.
  if (new RegExp(`[\\\\/]agent-${agentId}\\.jsonl$`, 'i').test(transcript)) return transcript
  if (!/\.jsonl$/i.test(transcript)) return null
  return join(transcript.slice(0, -'.jsonl'.length), 'subagents', `agent-${agentId}.jsonl`)
}

interface MessageUsage {
  input: number
  output: number
  cached: number
  /** input + cached: the size of that request's context. */
  context: number
}

/** `message.usage` of one transcript line, or null when the line is not an assistant entry with usage. */
export function assistantUsage(line: unknown, main: boolean): { id: string; usage: MessageUsage; model: string } | null {
  if (!isRecord(line) || line.type !== 'assistant' || !isRecord(line.message)) return null
  // A subagent's entries live in its own file; a main transcript's count is the main thread's.
  if (main && line.isSidechain === true) return null
  const message = line.message
  if (!isRecord(message.usage)) return null
  const u = message.usage
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  const cached = num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
  // Placeholder entries (model "<synthetic>") report nothing.
  if (input + output + cached === 0) return null
  const id = typeof message.id === 'string' && message.id ? message.id.slice(0, 200) : typeof line.uuid === 'string' ? line.uuid.slice(0, 200) : ''
  if (!id) return null
  const model = typeof message.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/.test(message.model) ? message.model : ''
  return { id, usage: { input, output, cached, context: input + cached }, model }
}

/** One transcript file, read a piece at a time. */
export class TranscriptTail {
  private offset = 0
  /** The bytes of a line whose end has not been written yet. */
  private carry: Buffer[] = []
  private carryBytes = 0
  /** Inside a line that is too long to keep: drop bytes until its end. */
  private skipping = false
  private seen = new Map<string, MessageUsage>()
  private input = 0
  private output = 0
  private cached = 0
  private context = 0
  private messages = 0
  model = ''

  constructor(
    readonly path: string,
    private readonly main: boolean,
    private readonly fs: TranscriptFs = nodeFs
  ) {}

  /** Bytes read so far (for the tests). */
  get position(): number {
    return this.offset
  }

  /** The sums so far, or undefined while no assistant entry with usage was seen. */
  usage(): TokenUsage | undefined {
    if (this.messages === 0) return undefined
    return { input: this.input, output: this.output, cached: this.cached, total: this.input + this.output + this.cached, contextUsed: this.context }
  }

  /**
   * Reads what was appended since the last call, at most `maxBytes`. `more`: the file has more than
   * that. `changed`: the sums moved. Never throws (a file that is not there yet reads as nothing).
   */
  read(maxBytes = TRANSCRIPT_TICK_BYTES): { changed: boolean; more: boolean } {
    let fd: number
    try {
      fd = this.fs.openSync(this.path, 'r')
    } catch {
      return { changed: false, more: false }
    }
    const before = `${this.input}/${this.output}/${this.cached}/${this.context}/${this.messages}`
    let more = false
    try {
      const stat = this.fs.fstatSync(fd)
      if (!stat.isFile()) return { changed: false, more: false }
      // Shorter than what was read: the file was replaced. Start over.
      if (stat.size < this.offset) this.reset()
      let budget = maxBytes
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, maxBytes)))
      while (this.offset < stat.size && budget > 0) {
        const want = Math.min(chunk.length, stat.size - this.offset, budget)
        const got = this.fs.readSync(fd, chunk, 0, want, this.offset)
        if (got <= 0) break
        this.offset += got
        budget -= got
        this.feed(chunk.subarray(0, got))
      }
      more = this.offset < stat.size
    } catch {
      // unreadable right now: the next hook tries again from the same offset
    } finally {
      try {
        this.fs.closeSync(fd)
      } catch {
        // already closed
      }
    }
    return { changed: before !== `${this.input}/${this.output}/${this.cached}/${this.context}/${this.messages}`, more }
  }

  private reset(): void {
    this.offset = 0
    this.carry = []
    this.carryBytes = 0
    this.skipping = false
    this.seen.clear()
    this.input = this.output = this.cached = this.context = this.messages = 0
  }

  private feed(bytes: Buffer): void {
    let start = 0
    for (;;) {
      const end = bytes.indexOf(NEWLINE, start)
      if (end < 0) break
      const piece = bytes.subarray(start, end)
      start = end + 1
      if (this.skipping) {
        this.skipping = false
        continue
      }
      if (this.carryBytes > 0) {
        this.carry.push(Buffer.from(piece))
        const line = Buffer.concat(this.carry)
        this.carry = []
        this.carryBytes = 0
        this.line(line)
      } else this.line(piece)
    }
    if (start >= bytes.length || this.skipping) return
    // The rest is the start of a line that is not finished: keep it as bytes (a character may be split).
    const rest = bytes.subarray(start)
    if (this.carryBytes + rest.length > TRANSCRIPT_MAX_LINE_BYTES) {
      this.carry = []
      this.carryBytes = 0
      this.skipping = true
      return
    }
    this.carry.push(Buffer.from(rest))
    this.carryBytes += rest.length
  }

  private line(bytes: Buffer): void {
    // Cheap filter first: tool results (whole files) are `user` lines and never parsed.
    if (bytes.length < 20 || !bytes.includes(ASSISTANT_MARK)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      return
    }
    const found = assistantUsage(parsed, this.main)
    if (!found) return
    const { id, usage, model } = found
    // The same message is written once per content block: count it once (its latest numbers).
    const earlier = this.seen.get(id)
    if (earlier) {
      this.input -= earlier.input
      this.output -= earlier.output
      this.cached -= earlier.cached
    } else {
      this.messages++
      if (this.seen.size >= MAX_SEEN_IDS) this.seen.delete(this.seen.keys().next().value as string)
    }
    this.seen.set(id, usage)
    this.input += usage.input
    this.output += usage.output
    this.cached += usage.cached
    this.context = usage.context
    if (model) this.model = model
  }
}

export interface ClaudeTranscriptsOptions {
  /** Told the usage of an agent whenever a read moved it. */
  onUsage(agentId: string, usage: TokenUsage, model?: string): void
  /** Only files inside this folder are read. Default: `~/.claude/projects`. */
  root?: string
  fs?: TranscriptFs
  /** Runs `fn` after `ms`; returns a cancel function. Default: an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void
  debounceMs?: number
  tickBytes?: number
}

interface Watched {
  tail: TranscriptTail
  /** Sums of the files this agent had before (a `/clear` starts a new transcript). */
  base: { input: number; output: number; cached: number }
  cancel: (() => void) | null
}

/** What the Claude hook observer needs: "this agent's transcript may have grown". */
export interface TranscriptPoker {
  poke(agentId: string, path: unknown, main?: boolean): void
}

/** The transcripts of the Claude agents in the world, read when a hook says there is news. */
export class ClaudeTranscripts implements TranscriptPoker {
  private readonly root: string
  private readonly fs: TranscriptFs
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly debounceMs: number
  private readonly tickBytes: number
  private watched = new Map<string, Watched>()
  private realRoot: string | null = null

  constructor(private readonly opts: ClaudeTranscriptsOptions) {
    this.root = resolve(opts.root ?? defaultTranscriptRoot())
    this.fs = opts.fs ?? nodeFs
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
    this.debounceMs = Math.max(0, opts.debounceMs ?? TRANSCRIPT_DEBOUNCE_MS)
    this.tickBytes = opts.tickBytes ?? TRANSCRIPT_TICK_BYTES
  }

  /**
   * A hook of this agent arrived: read its transcript a little later. Several hooks within the
   * debounce time make one read. A path outside the transcripts folder is ignored.
   */
  poke(agentId: string, path: unknown, main = true): void {
    const file = transcriptPath(path, this.root)
    if (!file || !agentId) return
    let w = this.watched.get(agentId)
    if (!w || w.tail.path !== file) {
      const base = w ? this.sums(w) : { input: 0, output: 0, cached: 0 }
      w?.cancel?.()
      w = { tail: new TranscriptTail(file, main, this.fs), base, cancel: null }
      // Most recently used last; the oldest goes when there are too many.
      this.watched.delete(agentId)
      this.watched.set(agentId, w)
      if (this.watched.size > MAX_TAILS) {
        const oldest = this.watched.keys().next().value as string
        this.watched.get(oldest)?.cancel?.()
        this.watched.delete(oldest)
      }
    }
    if (w.cancel) return
    this.arm(agentId, w, this.debounceMs)
  }

  /** Reads now what is pending for this agent (the tests, and a session that is ending). */
  flush(agentId: string): void {
    const w = this.watched.get(agentId)
    if (!w) return
    w.cancel?.()
    w.cancel = null
    this.run(agentId, w)
  }

  /** Stops everything (app quit). */
  close(): void {
    for (const w of this.watched.values()) w.cancel?.()
    this.watched.clear()
  }

  private arm(agentId: string, w: Watched, ms: number): void {
    w.cancel = this.schedule(() => {
      w.cancel = null
      if (this.watched.get(agentId) === w) this.run(agentId, w)
    }, ms)
  }

  private sums(w: Watched): { input: number; output: number; cached: number } {
    const u = w.tail.usage()
    return { input: w.base.input + (u?.input ?? 0), output: w.base.output + (u?.output ?? 0), cached: w.base.cached + (u?.cached ?? 0) }
  }

  private run(agentId: string, w: Watched): void {
    if (!this.inside(w.tail.path)) return
    const { changed, more } = w.tail.read(this.tickBytes)
    // A large transcript (a resumed session) is caught up over a few short ticks.
    if (more && !w.cancel) this.arm(agentId, w, TRANSCRIPT_CATCHUP_MS)
    const usage = w.tail.usage()
    if (!changed || !usage) return
    const s = this.sums(w)
    try {
      this.opts.onUsage(agentId, { input: s.input, output: s.output, cached: s.cached, total: s.input + s.output + s.cached, contextUsed: usage.contextUsed }, w.tail.model || undefined)
    } catch {
      // the inspector is a convenience
    }
  }

  /** The file as it really is on disk (links followed) must be inside the transcripts folder too. */
  private inside(file: string): boolean {
    try {
      this.realRoot ??= this.fs.realpathSync(this.root)
      const rel = relative(this.realRoot, this.fs.realpathSync(file))
      return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
    } catch {
      return false // not there (yet), or not readable
    }
  }
}
