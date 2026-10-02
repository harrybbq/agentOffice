// "Remember where I left off" (shared/restore.ts): the saved session records, in
// `<userData>/sessions.json`. One small record per hosted session; the file always says what would
// be lost if the app died right now. The session manager (sessions.ts) keeps the records current.
//
// Rules:
// - No secrets, ever: a record is rebuilt field by field from a fixed list (nothing is copied
//   through), and the only free text (the prompt preview and the pending questions) is shortened
//   to one line with anything token-shaped blanked out.
// - Atomic writes (temp file + rename), debounced; `flush()` writes synchronously (app quit).
// - A file that can't be read, or has another schema version, is kept as `sessions.json.bad` and
//   the app starts with an empty list.
//
// No Electron imports; the file system, the clock and the timer are injectable for the tests.
import * as nodeFs from 'node:fs'
import { dirname } from 'node:path'
import {
  LAST_PROMPT_PREVIEW_CHARS,
  MAX_RECENT_SESSIONS,
  MAX_SAVED_PENDING,
  type SavedPendingRequest,
  type SavedSession
} from '../shared/restore'
import type { PermissionMode, ProviderId } from '../shared/sessions'

export const STORE_VERSION = 1
/** At most this many records are `open` (the session limit); the least recently active become `recent`. */
export const MAX_OPEN_SESSIONS = 8
export const STORE_DEBOUNCE_MS = 500
const QUESTION_MAX = 240
const TITLE_MAX = 120
const HIDDEN = '[hidden]'

const PROVIDERS: readonly ProviderId[] = ['claude-code', 'codex', 'antigravity']
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** The same shapes the session manager accepts in a start request. */
const PROVIDER_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/

/** The part of `node:fs` the store uses. */
export interface StoreFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, options: { encoding: 'utf8'; mode?: number }): void
  renameSync(from: string, to: string): void
  mkdirSync(path: string, options: { recursive: true }): unknown
  rmSync(path: string, options: { force: true }): void
}

export interface SessionStoreOptions {
  /** `<userData>/sessions.json` */
  file: string
  fs?: StoreFs
  now?: () => number
  debounceMs?: number
  /** Runs `fn` after `ms`; returns a cancel function. Default: an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Told about a file that could not be read or written (default: console.error). */
  onProblem?: (message: string) => void
}

// ---- text that may be saved ------------------------------------------------------------------------

/**
 * Blanks out anything that looks like a credential: known key prefixes, bearer tokens, key=value
 * secrets, named pipes and long random-looking runs (hex, base64, UUIDs). Deliberately eager: a
 * preview that hides a harmless id is fine, a saved token is not.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\\\\[.?]\\pipe\\[^\s"'`]*/gi, HIDDEN)
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, HIDDEN)
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abeprs]|hf|npm|pypi|AKIA|ASIA|AIza|ya29)[-_.]?[A-Za-z0-9_.-]{12,}/g, HIDDEN)
    .replace(/\b((?:[A-Za-z0-9_]*(?:token|secret|password|passwd|pwd|api[-_]?key|apikey|authorization)[A-Za-z0-9_]*)\s*[=:]\s*)["']?[^\s"'`,;]{4,}["']?/gi, `$1${HIDDEN}`)
    .replace(/[A-Za-z0-9_+=-]{24,}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? HIDDEN : run))
}

const oneLine = (text: string): string =>
  text
    .slice(0, 20_000)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const cut = (line: string, max: number): string => (line.length > max ? `${line.slice(0, max - 1)}…` : line)

/** A name (title, tool): one line, no control characters, at most `max` characters. */
const savedName = (text: unknown, max: number): string => (typeof text === 'string' ? cut(oneLine(text), max) : '')

/** Free text (a prompt, a question): one line, no control characters, nothing token-shaped, at most `max` characters. */
export function savedText(text: unknown, max: number): string {
  return typeof text === 'string' ? cut(redactSecrets(oneLine(text)), max) : ''
}

/** The preview of a prompt as it is saved (SavedSession.lastPrompt). */
export const promptPreview = (text: unknown): string => savedText(text, LAST_PROMPT_PREVIEW_CHARS)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const time = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback)

function sanitisePending(raw: unknown, now: number): SavedPendingRequest[] {
  if (!Array.isArray(raw)) return []
  const out: SavedPendingRequest[] = []
  for (const item of raw) {
    if (out.length >= MAX_SAVED_PENDING) break
    if (!isRecord(item)) continue
    const question = savedText(item.question, QUESTION_MAX)
    if (!question) continue
    out.push({ question, toolName: savedName(item.toolName, 100) || 'tool', askedAt: time(item.askedAt, now) })
  }
  return out
}

/**
 * A record as it may be saved: every field checked and rebuilt, nothing else carried over. Null if
 * it isn't a usable record (no id, unknown provider, no folder).
 */
export function sanitiseSaved(raw: unknown, now: number): SavedSession | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
  if (typeof raw.provider !== 'string' || !PROVIDERS.includes(raw.provider as ProviderId)) return null
  if (typeof raw.cwd !== 'string' || raw.cwd.length === 0 || raw.cwd.length > 1024 || /[\u0000-\u001f]/.test(raw.cwd)) return null
  const startedAt = time(raw.startedAt, now)
  const rec: SavedSession = {
    id: raw.id,
    provider: raw.provider as ProviderId,
    cwd: raw.cwd,
    title: savedName(raw.title, TITLE_MAX) || 'Session',
    titleIsCustom: raw.titleIsCustom === true,
    permissionMode: MODES.includes(raw.permissionMode as PermissionMode) ? (raw.permissionMode as PermissionMode) : 'default',
    startedAt,
    lastActiveAt: time(raw.lastActiveAt, startedAt),
    interrupted: raw.interrupted === true,
    pendingAtClose: sanitisePending(raw.pendingAtClose, now),
    status: raw.status === 'recent' ? 'recent' : 'open'
  }
  if (typeof raw.model === 'string' && MODEL_RE.test(raw.model)) rec.model = raw.model
  if (typeof raw.providerSessionId === 'string' && PROVIDER_SESSION_RE.test(raw.providerSessionId)) rec.providerSessionId = raw.providerSessionId
  const lastPrompt = promptPreview(raw.lastPrompt)
  if (lastPrompt) rec.lastPrompt = lastPrompt
  if (typeof raw.interruptedAt === 'number' && Number.isFinite(raw.interruptedAt) && raw.interruptedAt >= 0) rec.interruptedAt = Math.floor(raw.interruptedAt)
  return rec
}

// ---- the store -------------------------------------------------------------------------------------

interface StoreFile {
  version: number
  selectedId?: string | null
  sessions: SavedSession[]
}

export class SessionStore {
  private readonly file: string
  private readonly fs: StoreFs
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly problem: (message: string) => void
  /** In insertion order (the order the sessions were first saved). */
  private records = new Map<string, SavedSession>()
  /** `undefined` = the renderer never reported a selection; `null` = nothing was selected. */
  private selected: string | null | undefined
  private loaded = false
  private dirty = false
  private cancelWrite: (() => void) | null = null
  private writeSeq = 0

  constructor(opts: SessionStoreOptions) {
    this.file = opts.file
    this.fs = opts.fs ?? (nodeFs as unknown as StoreFs)
    this.now = opts.now ?? Date.now
    this.debounceMs = opts.debounceMs ?? STORE_DEBOUNCE_MS
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return () => clearTimeout(t)
      })
    this.problem = opts.onProblem ?? ((m) => console.error(`[agent-office] ${m}`))
  }

  /** Reads the file once. Never throws: a file that can't be used is set aside and the list starts empty. */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.fs.existsSync(this.file)) return
    let raw: unknown
    try {
      raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      return this.setAside(`sessions.json could not be read (${err instanceof Error ? err.message : 'error'})`)
    }
    if (!isRecord(raw) || raw.version !== STORE_VERSION || !Array.isArray(raw.sessions)) {
      return this.setAside(isRecord(raw) && raw.version !== STORE_VERSION ? `sessions.json has an unknown version (${String(raw.version).slice(0, 20)})` : 'sessions.json is not a session list')
    }
    const now = this.now()
    for (const item of raw.sessions) {
      const rec = sanitiseSaved(item, now)
      if (rec && !this.records.has(rec.id)) this.records.set(rec.id, rec)
    }
    if (raw.selectedId === null) this.selected = null
    else if (typeof raw.selectedId === 'string' && ID_RE.test(raw.selectedId)) this.selected = raw.selectedId
    // A file edited by hand (or by an older build) may break the caps or carry fields that are not saved.
    this.enforceCaps()
    if (JSON.stringify(raw) !== JSON.stringify(this.snapshot())) this.touch()
  }

  private setAside(why: string): void {
    this.problem(`${why}; starting with no saved sessions (the file is kept as ${this.file}.bad)`)
    try {
      this.fs.rmSync(`${this.file}.bad`, { force: true })
      this.fs.renameSync(this.file, `${this.file}.bad`)
    } catch {
      // It will be overwritten by the next save; nothing else can be done.
    }
  }

  // ---- reading ----

  get(id: string): SavedSession | undefined {
    const rec = this.records.get(id)
    return rec ? copy(rec) : undefined
  }

  /** The sessions that were in the sidebar, oldest first (their order there). */
  open(): SavedSession[] {
    return [...this.records.values()]
      .filter((r) => r.status === 'open')
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(copy)
  }

  /** Sessions that ended earlier, newest first. */
  recent(): SavedSession[] {
    return [...this.records.values()]
      .filter((r) => r.status === 'recent')
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(copy)
  }

  /** `undefined` until a selection was ever reported. */
  get selectedId(): string | null | undefined {
    return this.selected
  }

  // ---- writing ----

  /** Adds or replaces a record. Returns false if it is not a usable record. */
  put(record: SavedSession): boolean {
    const rec = sanitiseSaved(record, this.now())
    if (!rec) return false
    const prev = this.records.get(rec.id)
    if (prev && JSON.stringify(prev) === JSON.stringify(rec)) return true
    this.records.set(rec.id, rec)
    this.enforceCaps(rec.id)
    this.touch()
    return true
  }

  /** Changes fields of a record (a key set to `undefined` is removed). Returns the new record, if it exists. */
  update(id: string, patch: Partial<SavedSession>): SavedSession | undefined {
    const prev = this.records.get(id)
    if (!prev) return undefined
    this.put({ ...prev, ...patch, id })
    return this.get(id)
  }

  remove(id: string): boolean {
    if (!this.records.delete(id)) return false
    this.touch()
    return true
  }

  setSelected(id: string | null): void {
    const next = id === null ? null : ID_RE.test(id) ? id : undefined
    if (next === undefined || next === this.selected) return
    this.selected = next
    this.touch()
  }

  /** Open rows over the limit become recent (never `keep`); recent rows over theirs are dropped, oldest first. */
  private enforceCaps(keep?: string): void {
    const byAge = (a: SavedSession, b: SavedSession): number => a.lastActiveAt - b.lastActiveAt
    const open = [...this.records.values()].filter((r) => r.status === 'open').sort(byAge)
    for (const r of open.filter((o) => o.id !== keep).slice(0, Math.max(0, open.length - MAX_OPEN_SESSIONS))) {
      this.records.set(r.id, { ...r, status: 'recent' })
    }
    const recent = [...this.records.values()].filter((r) => r.status === 'recent').sort(byAge)
    for (const r of recent.slice(0, Math.max(0, recent.length - MAX_RECENT_SESSIONS))) this.records.delete(r.id)
  }

  // ---- the file ----

  private snapshot(): StoreFile {
    const file: StoreFile = { version: STORE_VERSION, sessions: [...this.records.values()].map(copy) }
    if (this.selected !== undefined) file.selectedId = this.selected
    return file
  }

  private touch(): void {
    this.dirty = true
    if (this.cancelWrite) return
    this.cancelWrite = this.schedule(() => {
      this.cancelWrite = null
      this.flush()
    }, this.debounceMs)
  }

  /** Writes now if anything changed (synchronous: usable while the app quits). Never throws. */
  flush(): void {
    this.cancelWrite?.()
    this.cancelWrite = null
    if (!this.dirty) return
    const tmp = `${this.file}.${process.pid}.${++this.writeSeq}.tmp`
    try {
      this.fs.mkdirSync(dirname(this.file), { recursive: true })
      // mode is honoured on POSIX; on Windows the file sits in the per-user profile.
      this.fs.writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      this.fs.renameSync(tmp, this.file)
      this.dirty = false
    } catch (err) {
      this.problem(`sessions.json could not be saved (${err instanceof Error ? err.message : 'error'})`)
      try {
        this.fs.rmSync(tmp, { force: true })
      } catch {
        // nothing to clean up
      }
    }
  }
}

function copy(rec: SavedSession): SavedSession {
  return { ...rec, pendingAtClose: rec.pendingAtClose.map((p) => ({ ...p })) }
}
