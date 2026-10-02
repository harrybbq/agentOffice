// The preview of each hosted session: which address its pane shows, the app's own static server or
// `npm run` script behind it, the addresses seen in the session's output, and the hints that files
// changed. The IPC handlers (ipc.ts) call this; it validates every argument itself.
// No Electron imports: tests build one with fakes.
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { parsePreviewUrl, samePreviewServer, type PreviewInfo, type PreviewSuggestion } from '../../shared/preview'
import { extractAddresses, StreamScanner } from './detect'
import { probeHttp, probePort, type ProbeResult } from './probe'
import { devScripts, isSafeScriptName, Runner, type RunnerSpawn } from './runner'
import { isServableSegment, isWatchedPath, resolveInFolder, startStaticServer, WATCH_DEBOUNCE_MS, WATCH_IGNORED, type StaticServer } from './staticServer'

export const MAX_CANDIDATES = 12
export const VERIFY_EVERY_MS = 5000
/** A candidate that answered (or not) this recently is not asked again. */
const PROBE_CACHE_MS = 2000
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024
/** Where a page that can be served as it is usually lives. */
const STATIC_ENTRIES: readonly string[] = ['index.html', 'public/index.html', 'dist/index.html', 'build/index.html', 'docs/index.html', 'www/index.html', 'site/index.html']
/** How long a script's address is asked for after it was printed (some servers print it first). */
const ADOPT_TRIES = 40
const ADOPT_WAIT_MS = 500
const SLOW_START_MS = 20_000

export const UNKNOWN_SESSION = 'That session is not running.'
export const SELF_ADDRESS = 'That address is Agent Office itself.'
export const UNKNOWN_SCRIPT = "That script is not in this folder's package.json."
export const NO_PAGE = 'There is no such page in this folder.'

/** A live hosted session, as far as the preview cares. */
export interface PreviewSession {
  id: string
  cwd: string
}

export interface PreviewManagerOptions {
  /** The live hosted session with that id (not asleep, not exited), or undefined. */
  session(id: string): PreviewSession | undefined
  onChanged(info: PreviewInfo): void
  onReload(sessionId: string): void
  onDetected(sessionId: string): void
  /** Ports on this machine that are the app itself (ingest server, dev renderer): never previewed. */
  selfPorts?: () => number[]
  /** Tests. */
  probeHttp?: (url: string) => Promise<ProbeResult>
  probePort?: (url: string) => Promise<boolean>
  spawn?: RunnerSpawn
  verifyEveryMs?: number
  adoptWaitMs?: number
}

interface Candidate {
  source: string
  seenAt: number
  checkedAt?: number
  reachable?: boolean
}

interface Entry {
  sessionId: string
  scanner: StreamScanner
  candidates: Map<string, Candidate>
  info: PreviewInfo | null
  server?: StaticServer
  runner?: Runner
  runnerScanner?: StreamScanner
  watcher?: FSWatcher
  watchTimer?: NodeJS.Timeout
  verifyTimer?: NodeJS.Timeout
  slowTimer?: NodeJS.Timeout
  /** Bumped whenever the preview is replaced or stopped: late answers of the old one are dropped. */
  gen: number
  detectedQueued: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class PreviewManager {
  private entries = new Map<string, Entry>()
  /** Newest file timestamp the office board showed per session, as of the last snapshot. */
  private boardTs = new Map<string, number>()
  private closed = false
  private readonly http: (url: string) => Promise<ProbeResult>
  private readonly port: (url: string) => Promise<boolean>

  constructor(private readonly opts: PreviewManagerOptions) {
    this.http = opts.probeHttp ?? probeHttp
    this.port = opts.probePort ?? probePort
  }

  // ---- lookups ----

  private entry(sessionId: string): Entry {
    let e = this.entries.get(sessionId)
    if (!e) {
      e = { sessionId, scanner: new StreamScanner(), candidates: new Map(), info: null, gen: 0, detectedQueued: false }
      this.entries.set(sessionId, e)
    }
    return e
  }

  /** The live session behind an id from the renderer. Throws a readable message otherwise. */
  private live(id: unknown): PreviewSession {
    const s = typeof id === 'string' && id.length > 0 && id.length <= 64 ? this.opts.session(id) : undefined
    if (!s || this.closed) throw new Error(UNKNOWN_SESSION)
    return s
  }

  private isSelf(port: number): boolean {
    return (this.opts.selfPorts?.() ?? []).includes(port)
  }

  private emit(e: Entry): PreviewInfo {
    const info = { ...e.info! }
    this.opts.onChanged(info)
    return info
  }

  private patch(e: Entry, gen: number, patch: Partial<PreviewInfo>): void {
    if (e.gen !== gen || !e.info) return
    const next = { ...e.info, ...patch }
    for (const k of Object.keys(next) as (keyof PreviewInfo)[]) if (next[k] === undefined) delete next[k]
    if (JSON.stringify(next) === JSON.stringify(e.info)) return
    e.info = next
    this.emit(e)
  }

  // ---- what the sessions feed in ----

  /** Addresses a terminal session printed (found by the pty host). */
  observeAddresses(sessionId: string, urls: readonly unknown[], source: string): void {
    if (this.closed || typeof sessionId !== 'string' || !Array.isArray(urls)) return
    const e = this.entry(sessionId)
    this.addCandidates(e, urls.filter((u): u is string => typeof u === 'string').slice(0, MAX_CANDIDATES), source)
  }

  /** A chat event of a chat-based session: command output, finished answers. */
  observeChat(ev: ChatEvent): void {
    if (this.closed) return
    if (ev.type === 'delta') {
      if (ev.field !== 'output') return
      const e = this.entry(ev.sessionId)
      this.addCandidates(e, e.scanner.push(ev.delta), 'command output')
      return
    }
    if (ev.type !== 'item') return
    const item = ev.item
    if (item.kind === 'command' && item.status !== 'running') this.addCandidates(this.entry(item.sessionId), extractAddresses(item.output.slice(-16_000)), 'command output')
    else if (item.kind === 'tool' && item.result) this.addCandidates(this.entry(item.sessionId), extractAddresses(item.result.slice(-16_000)), 'tool result')
    else if (item.kind === 'assistant' && !item.streaming) this.addCandidates(this.entry(item.sessionId), extractAddresses(item.text.slice(-16_000)), 'chat')
  }

  private addCandidates(e: Entry, urls: readonly string[], source: string): boolean {
    let fresh = false
    for (const raw of urls) {
      const parsed = parsePreviewUrl(raw, { anyHost: true })
      if (!parsed.ok || this.isSelf(parsed.port)) continue
      const had = e.candidates.get(parsed.url)
      // Seen again: it moves to the front, and is asked again.
      e.candidates.delete(parsed.url)
      e.candidates.set(parsed.url, { source: had?.source ?? source, seenAt: Date.now() })
      if (!had) fresh = true
    }
    while (e.candidates.size > MAX_CANDIDATES) e.candidates.delete(e.candidates.keys().next().value!)
    if (fresh && !e.detectedQueued) {
      e.detectedQueued = true
      setImmediate(() => {
        e.detectedQueued = false
        if (!this.closed && this.entries.get(e.sessionId) === e) this.opts.onDetected(e.sessionId)
      })
    }
    return fresh
  }

  /** The session list changed: previews of sessions that are gone end with them. */
  sessionsChanged(liveIds: ReadonlySet<string>): void {
    for (const [id, e] of [...this.entries]) {
      if (liveIds.has(id)) continue
      this.entries.delete(id)
      void this.end(e, true)
    }
  }

  /** The office board changed: a session that touched a file since last time gets a reload hint. */
  boardChanged(snapshot: { branches: ReadonlyArray<{ sessionId: string; files: ReadonlyArray<{ ts: number }> }> }): void {
    if (this.closed) return
    const seen = new Map<string, number>()
    for (const b of snapshot.branches) {
      const newest = b.files.reduce((max, f) => Math.max(max, f.ts), 0)
      seen.set(b.sessionId, newest)
      const before = this.boardTs.get(b.sessionId)
      const e = this.entries.get(b.sessionId)
      // The first snapshot with a session is not news.
      if (e && before !== undefined && newest > before) this.filesChanged(e)
    }
    this.boardTs = seen
  }

  /** Files of the session's folder changed: reload the app's own pages, tell the pane. Debounced. */
  private filesChanged(e: Entry): void {
    if (!e.info || e.watchTimer) return
    e.watchTimer = setTimeout(() => {
      delete e.watchTimer
      if (!e.info || this.closed) return
      e.server?.reload()
      this.opts.onReload(e.sessionId)
    }, WATCH_DEBOUNCE_MS)
    e.watchTimer.unref?.()
  }

  // ---- what the frame reports (main window) ----

  /** The frame went to another page of the same server. */
  frameNavigated(url: string): void {
    const parsed = parsePreviewUrl(url)
    if (!parsed.ok) return
    for (const e of this.entries.values()) {
      if (e.info && e.info.url && samePreviewServer(e.info.url, parsed.url)) this.patch(e, e.gen, { currentUrl: parsed.url === e.info.url ? undefined : parsed.url })
    }
  }

  /** The frame could not load a page. `blocked`: the page refused to be framed. */
  frameFailed(url: string, blocked: boolean): void {
    for (const e of this.entries.values()) {
      if (!e.info || !e.info.url || !samePreviewServer(e.info.url, url)) continue
      if (blocked) this.patch(e, e.gen, { framable: false })
      else void this.verify(e, e.gen)
    }
  }

  // ---- the renderer's calls ----

  get(id: unknown): PreviewInfo | null {
    const info = typeof id === 'string' ? this.entries.get(id)?.info : null
    return info ? { ...info } : null
  }

  async suggestions(id: unknown): Promise<PreviewSuggestion[]> {
    const s = this.live(id)
    const e = this.entry(s.id)
    this.addCandidates(e, e.scanner.flush(), 'command output')
    const now = Date.now()
    await Promise.all(
      [...e.candidates].map(async ([url, c]) => {
        if (c.checkedAt !== undefined && now - c.checkedAt < PROBE_CACHE_MS) return
        c.reachable = (await this.http(url)).reachable
        c.checkedAt = Date.now()
      })
    )
    return [...e.candidates]
      .filter(([, c]) => c.reachable)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .map(([url, c]) => ({ url, source: c.source }))
  }

  async open(id: unknown, raw: unknown): Promise<PreviewInfo> {
    const s = this.live(id)
    const parsed = parsePreviewUrl(raw)
    if (!parsed.ok) throw new Error(parsed.error)
    if (this.isSelf(parsed.port)) throw new Error(SELF_ADDRESS)
    const e = this.entry(s.id)
    const url = parsed.url
    // Another page of what is already shown (the app's own server, a running script): same preview.
    if (e.info && e.info.url && samePreviewServer(e.info.url, url)) {
      const gen = e.gen
      this.patch(e, gen, { url, currentUrl: undefined })
      await this.verify(e, gen, true)
      return this.get(s.id) ?? this.fail()
    }
    await this.end(e, false)
    const gen = ++e.gen
    const cand = e.candidates.get(url) ?? [...e.candidates].find(([c]) => samePreviewServer(c, url))?.[1]
    e.info = { sessionId: s.id, url, kind: cand ? 'dev-server' : 'manual', status: 'starting', ...(cand ? { detectedFrom: cand.source } : {}) }
    this.emit(e)
    this.watch(e, s.cwd, [])
    this.startVerifying(e)
    await this.verify(e, gen, true)
    return this.get(s.id) ?? this.fail()
  }

  private fail(): never {
    throw new Error('The preview was stopped.')
  }

  /** The servable segments of a relative page path, or null. */
  private entrySegments(entry: unknown): string[] | null {
    if (entry === undefined || entry === null || entry === '') return ['index.html']
    if (typeof entry !== 'string' || entry.length > 512) return null
    const segs = entry.split(/[\\/]/).filter((x) => x.length > 0)
    return segs.length > 0 && segs.length <= 32 && segs.every(isServableSegment) ? segs : null
  }

  async staticEntries(id: unknown): Promise<string[]> {
    const s = this.live(id)
    let root: string
    try {
      root = await fsp.realpath(s.cwd)
    } catch {
      return []
    }
    const out: string[] = []
    for (const entry of STATIC_ENTRIES) {
      const found = await resolveInFolder(root, entry.split('/'))
      if (found && !found.isDirectory) out.push(entry)
    }
    return out
  }

  async serveFolder(id: unknown, relativeEntry?: unknown): Promise<PreviewInfo> {
    const s = this.live(id)
    const segs = this.entrySegments(relativeEntry)
    if (!segs) throw new Error(NO_PAGE)
    let root: string
    try {
      root = await fsp.realpath(s.cwd)
    } catch {
      throw new Error('The session folder no longer exists.')
    }
    let found = await resolveInFolder(root, segs)
    if (found?.isDirectory) {
      segs.push('index.html')
      found = await resolveInFolder(root, segs)
    }
    if (!found || found.isDirectory) throw new Error(NO_PAGE)
    const e = this.entry(s.id)
    await this.end(e, false)
    const gen = ++e.gen
    const server = await startStaticServer({ root })
    if (e.gen !== gen || this.closed || !this.opts.session(s.id)) {
      await server.close()
      return this.fail()
    }
    e.server = server
    // ".../index.html" is shown as its folder, like a web server does.
    const shown = segs[segs.length - 1] === 'index.html' ? segs.slice(0, -1) : segs
    const url = `${server.origin}/${shown.map(encodeURIComponent).join('/')}${shown.length > 0 && shown.length < segs.length ? '/' : ''}`
    e.info = { sessionId: s.id, url, kind: 'static', status: 'ready', detectedFrom: 'this folder' }
    this.emit(e)
    // A page that lives in build output ("dist/index.html") reloads when that output changes.
    this.watch(e, root, segs.length > 1 && WATCH_IGNORED.includes(segs[0]!) ? [segs[0]!] : [])
    const probe = await this.http(url)
    this.patch(e, gen, { title: probe.title })
    return this.get(s.id) ?? this.fail()
  }

  async scripts(id: unknown): Promise<string[]> {
    const s = this.live(id)
    try {
      const file = join(s.cwd, 'package.json')
      if ((await fsp.stat(file)).size > PACKAGE_JSON_MAX_BYTES) return []
      return devScripts(await fsp.readFile(file, 'utf8'))
    } catch {
      return []
    }
  }

  async run(id: unknown, scriptName: unknown): Promise<PreviewInfo> {
    const s = this.live(id)
    // The name must be one this folder's package.json has right now; nothing else is ever run.
    if (!isSafeScriptName(scriptName) || !(await this.scripts(s.id)).includes(scriptName)) throw new Error(UNKNOWN_SCRIPT)
    const e = this.entry(s.id)
    if (e.runner?.running) throw new Error('A script is already running for this session. Stop the preview first.')
    await this.end(e, false)
    const gen = ++e.gen
    const source = `npm run ${scriptName}`
    const scanner = new StreamScanner()
    let adopting = false
    const adopt = (urls: string[]): void => {
      if (urls.length === 0) return
      this.addCandidates(e, urls, source)
      if (adopting || e.gen !== gen || !e.info || e.info.url) return
      adopting = true
      void this.adopt(e, gen, urls).finally(() => (adopting = false))
    }
    const runner = new Runner({
      cwd: s.cwd,
      script: scriptName,
      spawn: this.opts.spawn,
      onOutput: (text) => adopt(scanner.push(text)),
      onExit: (code) => {
        if (e.slowTimer) clearTimeout(e.slowTimer)
        this.patch(e, gen, { status: 'unreachable', note: `The script ended${code === null ? '' : ` (code ${code})`}. Its output is in the preview log.` })
      }
    })
    e.runner = runner
    e.runnerScanner = scanner
    e.info = { sessionId: s.id, url: '', kind: 'dev-server', status: 'starting', script: scriptName, detectedFrom: source }
    try {
      runner.start()
    } catch (err) {
      e.info = null
      delete e.runner
      throw err
    }
    this.emit(e)
    this.watch(e, s.cwd, [])
    this.startVerifying(e)
    // Some servers end their address line without a newline: look again once the output pauses.
    e.slowTimer = setTimeout(() => {
      adopt(scanner.flush())
      if (e.gen === gen && e.info && !e.info.url && runner.running) this.patch(e, gen, { note: 'The script is running but has not printed an address yet. Its output is in the preview log.' })
    }, this.opts.adoptWaitMs !== undefined ? this.opts.adoptWaitMs * 4 : SLOW_START_MS)
    e.slowTimer.unref?.()
    return this.get(s.id) ?? this.fail()
  }

  /** The script printed addresses: the first that answers becomes the preview. */
  private async adopt(e: Entry, gen: number, urls: readonly string[]): Promise<void> {
    const wait = this.opts.adoptWaitMs ?? ADOPT_WAIT_MS
    for (let i = 0; i < ADOPT_TRIES; i++) {
      for (const raw of urls) {
        const parsed = parsePreviewUrl(raw, { anyHost: true })
        if (!parsed.ok || this.isSelf(parsed.port)) continue
        if (e.gen !== gen || !e.info || e.info.url) return
        const probe = await this.http(parsed.url)
        if (!probe.reachable) continue
        if (e.slowTimer) clearTimeout(e.slowTimer)
        return this.patch(e, gen, { url: parsed.url, status: 'ready', title: probe.title, framable: probe.framable === false ? false : undefined, note: undefined })
      }
      if (e.gen !== gen || !e.runner?.running) return
      await sleep(wait)
    }
  }

  log(id: unknown): string {
    return typeof id === 'string' ? (this.entries.get(id)?.runner?.log() ?? '') : ''
  }

  /** Ends the preview of a session (the session itself is untouched). */
  async stop(id: unknown): Promise<void> {
    const e = typeof id === 'string' ? this.entries.get(id) : undefined
    if (e) await this.end(e, true)
  }

  // ---- internals ----

  private startVerifying(e: Entry): void {
    if (e.verifyTimer) clearInterval(e.verifyTimer)
    e.verifyTimer = setInterval(() => void this.verify(e, e.gen), this.opts.verifyEveryMs ?? VERIFY_EVERY_MS)
    e.verifyTimer.unref?.()
  }

  /**
   * Does the shown address still answer? `full`: ask for the page (title, may it be framed);
   * otherwise only whether the port is open, and the page only when it came back.
   */
  private async verify(e: Entry, gen: number, full = false): Promise<void> {
    const info = e.info
    if (e.gen !== gen || !info || !info.url || info.kind === 'static') return
    // A script that has ended keeps its "ended" note; nothing to ask.
    if (e.runner && !e.runner.running && info.script) return
    const url = info.url
    if (!full && info.status === 'ready') {
      if (await this.port(url)) return
      return this.patch(e, gen, { status: 'unreachable', note: 'Nothing answers at this address any more.' })
    }
    if (!full && !(await this.port(url))) return this.patch(e, gen, { status: 'unreachable', note: info.note ?? 'Nothing answers at this address.' })
    const probe = await this.http(url)
    if (e.info?.url !== url) return
    if (probe.reachable) this.patch(e, gen, { status: 'ready', title: probe.title, framable: probe.framable === false ? false : undefined, note: undefined })
    else this.patch(e, gen, { status: 'unreachable', note: 'Nothing answers at this address.' })
  }

  private watch(e: Entry, folder: string, keep: readonly string[]): void {
    this.unwatch(e)
    try {
      const w = watch(folder, { recursive: true, persistent: false }, (_event, filename) => {
        if (typeof filename === 'string' && isWatchedPath(filename, keep)) this.filesChanged(e)
      })
      w.on('error', () => this.unwatch(e))
      e.watcher = w
    } catch {
      // The folder cannot be watched (gone, or a file system without change events): no live hints.
    }
  }

  private unwatch(e: Entry): void {
    try {
      e.watcher?.close()
    } catch {
      /* already closed */
    }
    delete e.watcher
    if (e.watchTimer) clearTimeout(e.watchTimer)
    delete e.watchTimer
  }

  /** Stops whatever is behind the entry's preview. `announce`: tell the renderer it is over. */
  private async end(e: Entry, announce: boolean): Promise<void> {
    e.gen++
    const info = e.info
    e.info = null
    this.unwatch(e)
    if (e.verifyTimer) clearInterval(e.verifyTimer)
    delete e.verifyTimer
    if (e.slowTimer) clearTimeout(e.slowTimer)
    delete e.slowTimer
    const server = e.server
    const runner = e.runner
    delete e.server
    delete e.runner
    delete e.runnerScanner
    if (info && announce) this.opts.onChanged({ ...info, status: 'stopped' })
    await Promise.all([server?.close(), runner?.stop()])
  }

  /** Previews that are running (tests, diagnostics). */
  active(): PreviewInfo[] {
    return [...this.entries.values()].filter((e) => e.info).map((e) => ({ ...e.info! }))
  }

  /** App quit: stops every server and script. */
  async shutdown(): Promise<void> {
    this.closed = true
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(all.map((e) => this.end(e, false)))
  }

  /** Last resort for `process.on('exit')`: scripts must not outlive the app. */
  killSync(): void {
    for (const e of this.entries.values()) e.runner?.killSync()
  }
}
