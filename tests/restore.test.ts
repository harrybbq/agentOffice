// "Remember where I left off" (shared/restore.ts), main-process side: the session store
// (electron/sessionStore.ts), the record lifecycle in the session manager, sleeping rows, wake,
// recent / reopen / forget, the restore modes, and the window position (electron/windowState.ts).
// The Claude part runs the whole stack over real HTTP with a fake pty; the Codex part runs against
// tests/fixtures/fake-codex-server.cjs. Imported by codex.test.ts (npm test runs everything).
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from '../shared/events.ts'
import { REASON_ASLEEP } from '../shared/orders.ts'
import { canWake, LAST_PROMPT_PREVIEW_CHARS, MAX_RECENT_SESSIONS, MAX_SAVED_PENDING, type RestoreMode, type SavedSession } from '../shared/restore.ts'
import type { PermissionRequestInfo, SessionInfo } from '../shared/sessions.ts'
import { createClaudeCodeHooksAdapter } from '../electron/adapters/claude-code-hooks.ts'
import { Board, boardStatus, DEFAULT_BOARD_SETTINGS } from '../electron/board.ts'
import { boardMcpRoute } from '../electron/boardMcp.ts'
import { folderProject } from '../electron/boardProject.ts'
import { claudeProvider } from '../electron/drivers/claude.ts'
import { codexProvider } from '../electron/drivers/codex.ts'
import type { CodexSpawnSpec } from '../electron/drivers/codexServer.ts'
import type { PtyHandlers, PtyHost, ScreenSnapshot } from '../electron/drivers/types.ts'
import { SessionTokens } from '../electron/ingest/auth.ts'
import { startIngestServer } from '../electron/ingest/server.ts'
import type { PtySpawnOptions } from '../electron/ptyProtocol.ts'
import { SessionInbox } from '../electron/sessionInbox.ts'
import {
  MAX_OPEN_SESSIONS,
  promptPreview,
  redactSecrets,
  sanitiseSaved,
  SessionStore,
  STORE_VERSION,
  type StoreFs
} from '../electron/sessionStore.ts'
import {
  CONVERSATION_GONE,
  MAX_LIVE_SESSIONS,
  NO_SAVED_CONVERSATION,
  parseRestoreSettingsPatch,
  SessionManager,
  STOP_BEFORE_FORGET
} from '../electron/sessions.ts'
import { clampToDisplays, displayKey, MAX_WINDOW_STATES, parseWindowStates, rememberWindow } from '../electron/windowState.ts'

let pass = 0
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn()
  pass++
  console.log('ok -', name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}
const tempDir = () => mkdtempSync(join(tmpdir(), 'agent-office-restore-'))
const readStore = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { version: number; selectedId?: string | null; sessions: SavedSession[] }

const record = (id: string, extra: Partial<SavedSession> = {}): SavedSession => ({
  id,
  provider: 'claude-code',
  cwd: tmpdir(),
  title: `Team ${id}`,
  titleIsCustom: false,
  permissionMode: 'default',
  providerSessionId: `conv-${id}`,
  startedAt: 1000,
  lastActiveAt: 2000,
  interrupted: false,
  pendingAtClose: [],
  status: 'open',
  ...extra
})

// ---- the store -------------------------------------------------------------------------------------

await t('store: round trip, selection, newest-first recent, a second load changes nothing', () => {
  const file = join(tempDir(), 'sessions.json')
  const a = new SessionStore({ file })
  a.load()
  assert.deepEqual(a.open(), [])
  assert.equal(a.selectedId, undefined)
  a.put(record('s-a', { startedAt: 30, model: 'claude-opus-5-5', lastPrompt: 'fix the tests', titleIsCustom: true, permissionMode: 'plan' }))
  a.put(record('s-b', { startedAt: 10, provider: 'codex', interrupted: true, interruptedAt: 1500, pendingAtClose: [{ question: 'Run a command?', toolName: 'Bash', askedAt: 5 }] }))
  a.put(record('s-old', { status: 'recent', lastActiveAt: 100 }))
  a.put(record('s-new', { status: 'recent', lastActiveAt: 900 }))
  a.setSelected('s-b')
  assert.ok(!existsSync(file)) // debounced: nothing on disk yet
  a.flush()

  const b = new SessionStore({ file })
  b.load()
  b.load() // idempotent
  assert.deepEqual(b.open().map((r) => r.id), ['s-b', 's-a']) // sidebar order: by start
  assert.deepEqual(b.recent().map((r) => r.id), ['s-new', 's-old'])
  assert.equal(b.selectedId, 's-b')
  assert.deepEqual(b.get('s-a'), a.get('s-a'))
  assert.deepEqual(b.get('s-b')?.pendingAtClose, [{ question: 'Run a command?', toolName: 'Bash', askedAt: 5 }])
  assert.equal(b.get('s-b')?.interruptedAt, 1500)
  assert.equal(readStore(file).version, STORE_VERSION)
  // A copy is handed out: changing it does not change the store.
  b.get('s-b')!.pendingAtClose.length = 0
  assert.equal(b.get('s-b')?.pendingAtClose.length, 1)
  // update: a key set to undefined is removed; unknown ids are refused.
  assert.equal(b.update('s-b', { interruptedAt: undefined, interrupted: false })?.interruptedAt, undefined)
  assert.equal(b.update('nope', { title: 'x' }), undefined)
  b.setSelected(null)
  assert.equal(b.remove('s-old'), true)
  assert.equal(b.remove('s-old'), false)
  b.flush()
  const c = new SessionStore({ file })
  c.load()
  assert.equal(c.selectedId, null) // "nothing selected" is remembered too
  assert.deepEqual(c.recent().map((r) => r.id), ['s-new'])
})

await t('store: atomic write (temp file, then rename), debounced, a failed write keeps the old file', () => {
  const dir = tempDir()
  const file = join(dir, 'sessions.json')
  const calls: string[] = []
  let failRename = false
  const fs: StoreFs = {
    existsSync: (p) => nodeFs.existsSync(p),
    readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
    writeFileSync: (p, data, o) => {
      calls.push(`write ${p === file ? 'TARGET' : p.endsWith('.tmp') ? 'tmp' : p}`)
      nodeFs.writeFileSync(p, data, o)
    },
    renameSync: (from, to) => {
      calls.push(`rename ${from.endsWith('.tmp') ? 'tmp' : from} -> ${to === file ? 'TARGET' : to}`)
      if (failRename) throw new Error('EPERM')
      nodeFs.renameSync(from, to)
    },
    mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
    rmSync: (p, o) => nodeFs.rmSync(p, o)
  }
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const problems: string[] = []
  const store = new SessionStore({
    file,
    fs,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    onProblem: (m) => void problems.push(m)
  })
  store.load()
  store.put(record('s-1'))
  store.put(record('s-2'))
  store.put(record('s-1', { title: 'renamed' }))
  // Three changes, one timer of ~500 ms, nothing written yet.
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 500)
  assert.deepEqual(calls, [])
  timers[0].fn()
  assert.deepEqual(calls, ['write tmp', 'rename tmp -> TARGET']) // never written in place
  assert.deepEqual(readdirSync(dir), ['sessions.json']) // no temp file left
  assert.equal(readStore(file).sessions.length, 2)
  // The same record again is not a change: no timer, no write.
  store.put(record('s-1', { title: 'renamed' }))
  assert.equal(timers.length, 1)
  store.flush()
  assert.equal(calls.length, 2)

  // A write that fails half-way leaves the old file intact and no temp file behind; the next flush tries again.
  const before = readFileSync(file, 'utf8')
  failRename = true
  store.put(record('s-3'))
  store.flush()
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.deepEqual(readdirSync(dir), ['sessions.json'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /could not be saved/)
  failRename = false
  store.flush()
  assert.equal(readStore(file).sessions.length, 3)
  // flush() cancels the pending timer (app quit: synchronous, once).
  assert.ok(timers.slice(1).every((x) => x.cancelled))
})

await t('store: a corrupt file or an unknown version starts empty and keeps the file as sessions.json.bad', () => {
  for (const [content, why] of [
    ['{"version":1,"sessions":[{"id":"s-1"', /could not be read/],
    [JSON.stringify({ version: 99, sessions: [record('s-1')] }), /unknown version/],
    [JSON.stringify([record('s-1')]), /not a session list/],
    [JSON.stringify({ version: 1, sessions: 'nope' }), /not a session list/]
  ] as const) {
    const dir = tempDir()
    const file = join(dir, 'sessions.json')
    writeFileSync(file, content)
    writeFileSync(`${file}.bad`, 'an older bad file') // replaced
    const problems: string[] = []
    const store = new SessionStore({ file, onProblem: (m) => void problems.push(m) })
    store.load()
    assert.deepEqual(store.open(), [])
    assert.deepEqual(store.recent(), [])
    assert.match(problems[0], why)
    assert.equal(readFileSync(`${file}.bad`, 'utf8'), content)
    assert.ok(!existsSync(file))
    // The app goes on: the next save writes a good file.
    store.put(record('s-2'))
    store.flush()
    assert.deepEqual(readStore(file).sessions.map((r) => r.id), ['s-2'])
  }
  // Tolerant per record: bad rows are skipped, good ones kept, half-valid fields fall back.
  const file = join(tempDir(), 'sessions.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      selectedId: { evil: true },
      sessions: [
        null,
        { id: '../x', provider: 'claude-code', cwd: 'C:\\w' },
        { id: 's-ok', provider: 'bash', cwd: 'C:\\w' },
        { id: 's-nocwd', provider: 'codex' },
        { id: 's-good', provider: 'codex', cwd: 'C:\\w', title: 7, permissionMode: 'bypassPermissions', model: '--flag', providerSessionId: '../../etc', status: 'weird', startedAt: 'x', pendingAtClose: 'no' },
        { id: 's-good', provider: 'codex', cwd: 'C:\\other' } // a duplicate id: the first wins
      ]
    })
  )
  const store = new SessionStore({ file, now: () => 777 })
  store.load()
  assert.equal(store.selectedId, undefined)
  assert.deepEqual(store.open(), [
    { id: 's-good', provider: 'codex', cwd: 'C:\\w', title: 'Session', titleIsCustom: false, permissionMode: 'default', startedAt: 777, lastActiveAt: 777, interrupted: false, pendingAtClose: [], status: 'open' }
  ])
  assert.equal(canWake(store.open()[0]), false) // a conversation id that could be read as a flag or a path is dropped
})

await t(`store: at most ${MAX_OPEN_SESSIONS} open rows and ${MAX_RECENT_SESSIONS} recent ones; the oldest go first`, () => {
  const file = join(tempDir(), 'sessions.json')
  const store = new SessionStore({ file })
  store.load()
  for (let i = 0; i < MAX_OPEN_SESSIONS + 3; i++) store.put(record(`s-open-${i}`, { startedAt: i, lastActiveAt: 100 + i }))
  assert.equal(store.open().length, MAX_OPEN_SESSIONS)
  // The three that were active longest ago moved to Recent (never the one just saved).
  assert.deepEqual(store.recent().map((r) => r.id), ['s-open-2', 's-open-1', 's-open-0'])
  for (let i = 0; i < MAX_RECENT_SESSIONS + 5; i++) store.put(record(`s-rec-${i}`, { status: 'recent', lastActiveAt: 1000 + i }))
  const recent = store.recent()
  assert.equal(recent.length, MAX_RECENT_SESSIONS)
  assert.equal(recent[0].id, `s-rec-${MAX_RECENT_SESSIONS + 4}`)
  assert.ok(!recent.some((r) => r.id.startsWith('s-open-'))) // the oldest were dropped
  assert.equal(store.open().length, MAX_OPEN_SESSIONS)
  // A hand-edited file with too many open rows is brought back under the cap on load.
  const big = join(tempDir(), 'sessions.json')
  writeFileSync(big, JSON.stringify({ version: 1, sessions: Array.from({ length: 12 }, (_, i) => record(`s-${i}`, { lastActiveAt: i })) }))
  const loaded = new SessionStore({ file: big })
  loaded.load()
  assert.equal(loaded.open().length, MAX_OPEN_SESSIONS)
  assert.equal(loaded.recent().length, 4)
  // Pending questions are capped too.
  store.put(record('s-many', { status: 'recent', lastActiveAt: 99_999, pendingAtClose: Array.from({ length: 25 }, (_, i) => ({ question: `q${i}`, toolName: 'Bash', askedAt: i })) }))
  assert.equal(store.get('s-many')?.pendingAtClose.length, MAX_SAVED_PENDING)
})

await t('store: nothing but the listed fields is saved; previews are one short line with tokens blanked out', () => {
  const file = join(tempDir(), 'sessions.json')
  const store = new SessionStore({ file })
  store.load()
  const sneaky = {
    ...record('s-1'),
    token: 'AO-TOKEN-VALUE',
    env: { AO_TOKEN: 'AO-TOKEN-VALUE' },
    socketPath: '\\\\.\\pipe\\cc-msg-secret',
    inbox: { socketPath: '\\\\.\\pipe\\cc-msg-secret', token: 'inbox' },
    lastPrompt: `line one\r\nline two\twith a tab \u001b[31mand an escape\u0007 ${'x'.repeat(5000)}`,
    pendingAtClose: [{ question: 'Run the command: curl -H "Authorization: Bearer abcdef0123456789abcdef" https://example.com', toolName: 'Bash', askedAt: 1, detail: 'FULL-DETAIL', toolInput: { command: 'secret' } }]
  } as unknown as SavedSession
  store.put(sneaky)
  store.flush()
  const text = readFileSync(file, 'utf8')
  for (const leak of ['AO-TOKEN-VALUE', 'cc-msg-secret', 'socketPath', '"env"', '"token"', 'FULL-DETAIL', 'toolInput', 'abcdef0123456789abcdef']) assert.ok(!text.includes(leak), leak)
  const saved = store.get('s-1')!
  assert.deepEqual(Object.keys(saved).sort(), ['cwd', 'id', 'interrupted', 'lastActiveAt', 'lastPrompt', 'pendingAtClose', 'permissionMode', 'provider', 'providerSessionId', 'startedAt', 'status', 'title', 'titleIsCustom'])
  assert.deepEqual(Object.keys(saved.pendingAtClose[0]).sort(), ['askedAt', 'question', 'toolName'])
  assert.equal(saved.lastPrompt!.length, LAST_PROMPT_PREVIEW_CHARS)
  assert.ok(saved.lastPrompt!.startsWith('line one line two with a tab [31mand an escape xxxx'))
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(saved.lastPrompt!))
  assert.match(saved.pendingAtClose[0].question, /^Run the command: curl -H "Authorization: \[hidden\]/)

  // What counts as token-shaped.
  for (const secret of [
    'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789',
    'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
    'AKIAIOSFODNN7EXAMPLE',
    'a3f5c9e17b2d4f6a8c0e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a', // 64 hex: an Agent Office token
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    '\\\\.\\pipe\\cc-msg-1f2e3d',
    '0b6f4f0e-1111-4222-8333-444455556666'
  ]) {
    const out = promptPreview(`use ${secret} for this`)
    assert.ok(!out.includes(secret), secret)
    assert.match(out, /^use \[hidden\]/)
  }
  assert.equal(redactSecrets('API_KEY=hunter2hunter2 and password: "s3cret!"'), 'API_KEY=[hidden] and password: [hidden]')
  // Ordinary prompts survive.
  for (const plain of ['Fix the failing test in src/world/layout.ts and run npm test', `Run this exact command: node -e "console.log('ao-restore')"`, 'What is the author of this file?']) {
    assert.equal(promptPreview(plain), plain)
  }
  assert.equal(promptPreview(42), '')
  assert.equal(sanitiseSaved({ id: 's-1', provider: 'codex', cwd: 'C:\\w\u0000' }, 1), null)
})

// ---- the window position -----------------------------------------------------------------------------

await t('window position: remembered per display layout, clamped to a display that exists', () => {
  const laptop = { x: 0, y: 0, width: 1920, height: 1040 }
  const external = { x: 1920, y: 0, width: 2560, height: 1400 }
  const min = { width: 1000, height: 650 }
  // Inside a display: unchanged.
  assert.deepEqual(clampToDisplays({ x: 100, y: 50, width: 1440, height: 900 }, [laptop, external], min), { x: 100, y: 50, width: 1440, height: 900 })
  assert.deepEqual(clampToDisplays({ x: 2000, y: 100, width: 1600, height: 1000 }, [laptop, external], min), { x: 2000, y: 100, width: 1600, height: 1000 })
  // Was on the external screen, which is gone: centred on the one that is left, never off-screen.
  assert.deepEqual(clampToDisplays({ x: 2500, y: 200, width: 1600, height: 1000 }, [laptop], min), { x: 160, y: 20, width: 1600, height: 1000 })
  // Half off the edge: pushed back in. Too big: shrunk to the work area.
  assert.deepEqual(clampToDisplays({ x: 1500, y: 600, width: 1200, height: 800 }, [laptop], min), { x: 720, y: 240, width: 1200, height: 800 })
  assert.deepEqual(clampToDisplays({ x: -50, y: -30, width: 3000, height: 2000 }, [laptop], min), { x: 0, y: 0, width: 1920, height: 1040 })
  // Never below the minimum size, unless the display itself is smaller.
  assert.deepEqual(clampToDisplays({ x: 10, y: 10, width: 300, height: 200 }, [laptop], min), { x: 10, y: 10, width: 1000, height: 650 })
  assert.deepEqual(clampToDisplays({ x: 10, y: 10, width: 300, height: 200 }, [{ x: 0, y: 0, width: 800, height: 600 }], min), { x: 0, y: 0, width: 800, height: 600 })
  assert.equal(clampToDisplays({ x: 0, y: 0, width: 10, height: 10 }, [], min), null)

  // The key names the layout, whatever order the displays come in.
  const one = displayKey([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }])
  const two = displayKey([{ bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }, { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }])
  assert.equal(one, '1920x1080@0,0')
  assert.equal(two, '1920x1080@0,0|2560x1440@1920,0')
  assert.equal(two, displayKey([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }]))

  let states = rememberWindow({}, one, { bounds: { x: 1, y: 2, width: 1200, height: 800 }, maximized: false })
  states = rememberWindow(states, two, { bounds: { x: 2000, y: 20, width: 1600, height: 1000 }, maximized: true })
  assert.deepEqual(states[one], { bounds: { x: 1, y: 2, width: 1200, height: 800 }, maximized: false })
  assert.equal(states[two].maximized, true)
  for (let i = 0; i < MAX_WINDOW_STATES + 2; i++) states = rememberWindow(states, `layout-${i}`, { bounds: { x: 0, y: 0, width: 1000, height: 700 }, maximized: false })
  assert.equal(Object.keys(states).length, MAX_WINDOW_STATES)
  assert.ok(!(one in states)) // the layouts used longest ago fall out
  // What config.json may hold.
  assert.deepEqual(parseWindowStates(JSON.parse(JSON.stringify(states))), states)
  assert.deepEqual(parseWindowStates({ a: { bounds: { x: 0, y: 0, width: 0, height: 10 } }, b: { bounds: { x: '1', y: 0, width: 5, height: 5 } }, c: 7, d: { bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: 'yes', extra: 1 } }), {
    d: { bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: false }
  })
  assert.deepEqual(parseWindowStates(null), {})
  assert.deepEqual(parseWindowStates([1, 2]), {})
})

await t('restore settings: only a known mode is a patch', () => {
  for (const mode of ['last', 'all', 'none']) assert.deepEqual(parseRestoreSettingsPatch({ mode }), { mode })
  assert.deepEqual(parseRestoreSettingsPatch({}), {})
  for (const bad of [null, 'all', 7, [], ['all'], { mode: 'some' }, { mode: true }, { mode: 'all', extra: 1 }, { enabled: true }]) {
    assert.equal(parseRestoreSettingsPatch(bad), null, JSON.stringify(bad))
  }
  assert.equal(boardStatus('asleep'), 'ended') // a sleeping session is never a live team on the board
})

// ---- the lifecycle, with a fake pty (Claude Code) ------------------------------------------------------

class FakePty implements PtyHost {
  spawned = new Map<string, { opts: PtySpawnOptions; handlers: PtyHandlers }>()
  order: string[] = []
  killed: string[] = []
  screen = 'screen'
  async spawn(id: string, opts: PtySpawnOptions, handlers: PtyHandlers): Promise<void> {
    this.spawned.set(id, { opts, handlers })
    this.order.push(id)
  }
  write(): void {}
  resize(): void {}
  kill(id: string): void {
    this.killed.push(id)
    setTimeout(() => this.exit(id, 1), 5)
  }
  dispose(): void {}
  async snapshot(id: string): Promise<ScreenSnapshot | null> {
    return this.spawned.has(id) ? { data: 'SNAP', cols: 120, rows: 40, text: this.screen } : null
  }
  detach(): void {}
  ack(): void {}
  exit(id: string, code: number | null): void {
    this.spawned.get(id)?.handlers.onExit(code)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

/** POST as Claude Code's http hooks do. The result promise stays open while a permission is held. */
function post(port: number, token: string, session: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const data = JSON.stringify(body)
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/hooks/claude-code',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-agent-office-token': token, 'x-agent-office-session': session }
  })
  const result = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    req.on('response', (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (text += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
  })
  req.end(data)
  return result
}

const GLOBAL = 'a3f5c9e17b2d4f6a8c0e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a'

/** One "run of the app" on a userData folder: store + manager + Claude driver + ingest server, with the office board. */
async function claudeApp(userData: string, opts: { mode?: RestoreMode; wakeWaitMs?: number } = {}) {
  const file = join(userData, 'sessions.json')
  const store = new SessionStore({ file, debounceMs: 20 })
  const port = await freePort()
  const tokens = new SessionTokens()
  const boardTokens = new SessionTokens()
  const inbox = new SessionInbox()
  const pty = new FakePty()
  const board = new Board({ settings: () => ({ ...DEFAULT_BOARD_SETTINGS }) })
  const world: AgentEvent[] = []
  const state = { allowOrders: true, mode: opts.mode ?? ('none' as RestoreMode), lists: 0 }
  let permissions: PermissionRequestInfo[] = []
  const manager = new SessionManager({
    pty,
    sink: { emit: (e) => void world.push(e) },
    providers: [
      claudeProvider({
        sessionsDir: join(userData, 'sessions'),
        hookScript: 'C:\\app\\hook\\claude-session-start.cjs',
        inbox,
        ingest: { baseUrl: () => `http://127.0.0.1:${port}`, tokens },
        findExecutable: () => process.execPath
      })
    ],
    allowOrders: () => state.allowOrders,
    worldTopLevel: () => [],
    onSessionsChanged: () => void state.lists++,
    onPermissionsChanged: (list) => (permissions = list),
    onTerminalData: () => {},
    board: { model: board, endpoint: { url: () => `http://127.0.0.1:${port}/mcp`, tokens: boardTokens }, resolveProject: async (cwd) => folderProject(cwd) },
    restore: {
      store,
      settings: () => ({ mode: state.mode }),
      saveSettings: (patch) => {
        if (patch.mode) state.mode = patch.mode
        return { mode: state.mode }
      },
      wakeWaitMs: opts.wakeWaitMs
    }
  })
  const server = await startIngestServer({
    port,
    getToken: () => GLOBAL,
    sink: { emit: (e) => void world.push(e) },
    sessionTokens: tokens,
    claudeHooks: createClaudeCodeHooksAdapter(manager),
    board: { route: boardMcpRoute(board), tokens: boardTokens }
  })
  const env = (id: string) => pty.spawned.get(id)!.opts.env
  const hook = (id: string, name: string, extra: Record<string, unknown> = {}, sid = 'conv-1') =>
    post(port, env(id).AO_TOKEN, id, { session_id: sid, cwd: 'C:\\work', hook_event_name: name, ...extra })
  return {
    file, store, port, pty, board, world, state, manager, server, inbox, env, hook,
    permissions: () => permissions,
    row: (id: string) => manager.list().find((s) => s.id === id),
    /** What is on disk right now (after the debounce). */
    saved: () => {
      store.flush()
      return readStore(file)
    },
    record: (id: string) => {
      store.flush()
      return readStore(file).sessions.find((r) => r.id === id)
    },
    /** The process is gone without a goodbye: nothing is flushed, nothing is stopped. */
    die: async () => {
      await sleep(60) // the debounce has passed, as it would have in any real crash a moment later
      await server.close()
    }
  }
}

const CONV = '0b6f4f0e-1111-4222-8333-444455556666'
const CONV2 = '7c1d2e3f-aaaa-4bbb-8ccc-ddddeeeeffff'
const PIPE = '\\\\.\\pipe\\cc-msg-4f2a91c7'
const INBOX_TOKEN = 'inbox-Zx81kQp0Lm3Nv7Rt2Yw5'
const API_KEY = 'sk-ant-api03-Q1w2E3r4T5y6U7i8O9p0AsDfGhJkLzXcVbNm'

await t('lifecycle: start -> prompt -> permission pending -> the app dies -> asleep row with the question -> wake resumes -> note gone on the first prompt', async () => {
  const userData = tempDir()
  const work = join(userData, 'work')
  mkdirSync(work)
  const a = await claudeApp(userData)

  // ---- a session with a conversation, a prompt and a pending permission request ----
  const info = await a.manager.start({ provider: 'claude-code', cwd: work, permissionMode: 'acceptEdits', model: 'claude-opus-5-5' })
  const id = info.id
  // Saved from the start, before the conversation id is known: such a record can't be woken.
  assert.equal(a.record(id)?.status, 'open')
  assert.equal(canWake(a.record(id)!), false)
  await a.hook(id, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5', _ao: { socket: PIPE, token: INBOX_TOKEN } }, CONV)
  assert.equal(a.row(id)?.state, 'idle')
  assert.ok(a.inbox.has(id)) // the inbox socket is registered (memory only)
  let rec = a.record(id)!
  assert.equal(rec.providerSessionId, CONV)
  assert.equal(rec.model, 'claude-opus-5-5')
  assert.equal(rec.title, 'Opus 5.5')
  assert.equal(rec.titleIsCustom, false)
  assert.equal(rec.interrupted, false)
  assert.equal(rec.lastPrompt, undefined)

  const prompt = `Use the key ${API_KEY} and run:\r\n  node -e "console.log('ao-restore')"\n${'and then some more text '.repeat(300)}`
  await a.hook(id, 'UserPromptSubmit', { prompt }, CONV)
  // A hand-back or a task notification is not the user's prompt.
  await a.hook(id, 'UserPromptSubmit', { prompt: '<task-notification>done</task-notification>' }, CONV)
  rec = a.record(id)!
  assert.equal(rec.interrupted, true) // busy
  assert.ok(rec.lastPrompt!.startsWith('Use the key [hidden] and run: node -e "console.log(\'ao-restore\')" and then some more text'))
  assert.equal(rec.lastPrompt!.length, LAST_PROMPT_PREVIEW_CHARS)
  assert.ok(rec.lastActiveAt >= rec.startedAt)

  const held = a.hook(id, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: `node -e "console.log('ao-restore')"` } }, CONV)
  held.catch(() => {}) // never answered: the app dies first
  await until(() => a.permissions().length === 1, 'the permission request')
  const question = a.permissions()[0].question
  assert.match(question, /ao-restore/)
  assert.equal(a.row(id)?.state, 'waiting-permission')
  rec = a.record(id)!
  assert.equal(rec.interrupted, true)
  assert.deepEqual(rec.pendingAtClose, [{ question, toolName: 'Bash', askedAt: a.permissions()[0].createdAt }])
  a.manager.setSelected(id)
  a.manager.setSelected('s-unknown') // not a session: ignored
  assert.equal(a.saved().selectedId, id)

  // ---- no secrets in the file: not the hook token, the board token, the inbox socket or its token, the global token, or a key typed in a prompt ----
  const boardToken = a.env(id).AO_BOARD_TOKEN
  assert.ok(boardToken && boardToken.length >= 32)
  const text = readFileSync(a.file, 'utf8')
  for (const [what, secret] of Object.entries({ hook: a.env(id).AO_TOKEN, board: boardToken, pipe: 'cc-msg-4f2a91c7', inbox: INBOX_TOKEN, global: GLOBAL, key: API_KEY, port: String(a.port) })) {
    assert.ok(!text.includes(secret), `the ${what} secret is in sessions.json`)
  }
  assert.ok(!/pipe|AO_|token|socket|env/i.test(text.replace(/"toolName"/g, '')), 'no field that could hold a secret')

  // ---- the app dies: no quit, no flush, nothing stopped ----
  await a.die()

  // ---- next launch, same userData: the row is back, asleep ----
  const b = await claudeApp(userData)
  assert.equal(b.pty.spawned.size, 0) // no process
  const rows = b.manager.list()
  assert.equal(rows.length, 1)
  const asleep = rows[0]
  assert.equal(asleep.id, id) // the same app id: the same team, colour and sidebar position
  assert.equal(asleep.state, 'asleep')
  assert.equal(asleep.wakeable, true)
  assert.equal(asleep.title, 'Opus 5.5')
  assert.equal(asleep.cwd, work)
  assert.equal(asleep.provider, 'claude-code')
  assert.equal(asleep.permissionMode, 'acceptEdits')
  assert.equal(asleep.model, 'claude-opus-5-5')
  assert.equal(asleep.surface, 'terminal')
  assert.equal(asleep.startedAt, info.startedAt)
  assert.equal(asleep.providerSessionId, CONV)
  assert.equal(asleep.canReceiveOrders, false)
  assert.equal(asleep.lastActiveAt, rec.lastActiveAt)
  assert.equal(asleep.lastPrompt, rec.lastPrompt) // "Your last prompt" on the wake screen
  assert.equal(asleep.waking, undefined)
  assert.deepEqual(asleep.interruptedNote, { closedAt: rec.lastActiveAt, pending: [{ question, toolName: 'Bash', askedAt: rec.pendingAtClose[0].askedAt }] })
  assert.equal(b.manager.getSelected(), id)
  assert.deepEqual(b.manager.listPermissions(), []) // the request itself died with the process

  // ---- a sleeping row is not a live session ----
  assert.deepEqual(await b.manager.sendOrder({ target: id, text: 'hello' }), { delivered: [], failed: [{ agentId: id, reason: REASON_ASLEEP }] })
  assert.deepEqual(await b.manager.sendOrder({ target: 'all', text: 'hello' }), { delivered: [], failed: [{ agentId: id, reason: REASON_ASLEEP }] })
  assert.deepEqual(await b.manager.sendOrder({ target: 'provider:claude-code', text: 'hello' }), { delivered: [], failed: [{ agentId: id, reason: REASON_ASLEEP }] })
  assert.equal(REASON_ASLEEP, 'asleep — wake it first')
  assert.deepEqual(b.manager.board().snapshot.branches, []) // not on the office board
  assert.deepEqual(b.world, []) // not in the world
  assert.equal(b.manager.hookTarget(id), undefined)
  assert.equal(b.manager.ownsProviderSession(CONV), false)
  await assert.rejects(b.manager.attach(id), /asleep — wake it first/)
  assert.throws(() => b.manager.interrupt(id), /asleep — wake it first/)
  // Its conversation is not offered a second time under "Resume previous…".
  // (Claude keeps no history the app lists, so the list is empty either way; the Codex test below checks the filter.)
  assert.deepEqual(await b.manager.history('claude-code', work), [])

  // ---- wake: twice at once, one process, resumed with the saved conversation id ----
  b.state.lists = 0
  const first = b.manager.wake(id)
  // In flight: the row says so (the renderer shows progress instead of the Wake button).
  assert.deepEqual([b.row(id)?.state, b.row(id)?.waking], ['asleep', true])
  const [w1, w2] = await Promise.all([first, b.manager.wake(id)])
  assert.equal(w1.waking, undefined)
  assert.equal(b.row(id)?.waking, undefined)
  assert.equal(b.row(id)?.lastPrompt, rec.lastPrompt)
  await until(() => b.state.lists > 0, 'sessionsChanged for the wake')
  assert.equal(b.pty.spawned.size, 1)
  assert.deepEqual(b.pty.order, [id])
  assert.equal(w1.id, id)
  assert.deepEqual(w1, w2)
  assert.equal(w1.state, 'starting')
  assert.equal(w1.startedAt, info.startedAt)
  const args = b.pty.spawned.get(id)!.opts.args
  assert.deepEqual(args.slice(args.indexOf('--resume')), ['--resume', CONV])
  assert.deepEqual(args.slice(0, 4), ['--settings', join(userData, 'sessions', `${id}.settings.json`), '--permission-mode', 'acceptEdits'])
  for (const flag of ['--append-system-prompt-file', '--mcp-config', '--model']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.equal(b.pty.spawned.get(id)!.opts.cwd, work)
  assert.notEqual(b.env(id).AO_TOKEN, a.env(id).AO_TOKEN) // fresh tokens
  // Awake already: a third wake changes nothing.
  assert.equal((await b.manager.wake(id)).id, id)
  assert.equal(b.pty.spawned.size, 1)
  assert.equal(b.manager.board().snapshot.branches.length, 1) // on the board now
  assert.equal(b.manager.list().length, 1)
  assert.deepEqual(b.row(id)?.interruptedNote?.pending.map((p) => p.question), [question]) // the note stays
  assert.equal(b.row(id)?.wakeable, undefined)

  // ---- a resumed Claude session may report a NEW conversation id: the record follows ----
  await b.hook(id, 'SessionStart', { source: 'resume', model: 'claude-opus-5-5' }, CONV2)
  assert.equal(b.row(id)?.state, 'idle')
  assert.equal(b.row(id)?.providerSessionId, CONV2)
  rec = b.record(id)!
  assert.equal(rec.providerSessionId, CONV2)
  assert.equal(rec.status, 'open')
  // Still noted as interrupted, with the same time: another crash now would show the same note again.
  assert.equal(rec.interrupted, true)
  assert.equal(rec.interruptedAt, asleep.interruptedNote!.closedAt)
  assert.equal(rec.pendingAtClose.length, 1)
  assert.equal(rec.lastPrompt?.startsWith('Use the key [hidden]'), true) // carried over
  assert.ok(b.row(id)?.interruptedNote)

  // ---- the first prompt after waking takes the note away ----
  b.state.lists = 0
  await b.hook(id, 'UserPromptSubmit', { prompt: 'what was the last command you tried to run?' }, CONV2)
  assert.equal(b.row(id)?.interruptedNote, undefined)
  await until(() => b.state.lists > 0, 'sessionsChanged after the note went away')
  await b.hook(id, 'Stop', {}, CONV2)
  rec = b.record(id)!
  assert.equal(rec.interrupted, false)
  assert.deepEqual(rec.pendingAtClose, [])
  assert.equal(rec.interruptedAt, undefined)
  assert.equal(rec.lastPrompt, 'what was the last command you tried to run?')

  // ---- a graceful quit: the sessions are killed, the records stay `open` ----
  b.manager.close()
  b.pty.exit(id, 0)
  await sleep(30)
  assert.equal(b.record(id)?.status, 'open')
  assert.equal(b.record(id)?.interrupted, false)
  await b.server.close()
  const c = await claudeApp(userData)
  assert.equal(c.row(id)?.state, 'asleep')
  assert.equal(c.row(id)?.interruptedNote, undefined) // it was idle: nothing was interrupted
  assert.equal(c.row(id)?.providerSessionId, CONV2)
  c.manager.close()
  await c.server.close()
})

await t('the note: dismissed by the user (asleep or awake), survives a second restart until then; a running subagent counts as interrupted', async () => {
  const userData = tempDir()
  const a = await claudeApp(userData)
  const { id } = await a.manager.start({ provider: 'claude-code', cwd: userData, title: 'Docs' })
  await a.hook(id, 'SessionStart', { source: 'startup' })
  // The main thread is idle, but a background subagent is still running: closing now loses its work.
  await a.hook(id, 'UserPromptSubmit', { prompt: 'research this in the background' })
  await a.hook(id, 'SubagentStart', { agent_id: 'a7dbf87f777914f47', agent_type: 'Explore' })
  await a.hook(id, 'Stop')
  assert.equal(a.row(id)?.state, 'idle')
  assert.equal(a.record(id)?.interrupted, true)
  await a.die()

  const b = await claudeApp(userData)
  const note = b.row(id)?.interruptedNote
  assert.deepEqual(note?.pending, [])
  assert.equal(b.row(id)?.title, 'Docs')
  await b.manager.wake(id)
  assert.deepEqual(b.pty.spawned.get(id)!.opts.args.slice(-2), ['--resume', 'conv-1'])
  await b.hook(id, 'SessionStart', { source: 'resume' })
  assert.deepEqual(b.row(id)?.interruptedNote, note)
  await b.die() // again, before the user saw it

  const c = await claudeApp(userData)
  assert.deepEqual(c.row(id)?.interruptedNote, note) // the same note, the same time
  c.manager.dismissInterrupted(id) // while asleep
  assert.equal(c.row(id)?.interruptedNote, undefined)
  assert.equal(c.record(id)?.interrupted, false)
  assert.equal(c.record(id)?.interruptedAt, undefined)
  c.manager.dismissInterrupted(id) // twice is fine
  c.manager.dismissInterrupted('s-nope')
  c.manager.dismissInterrupted(null)
  await c.die()

  // Dismissed while awake.
  const d = await claudeApp(userData)
  assert.equal(d.row(id)?.interruptedNote, undefined)
  await d.manager.wake(id)
  await d.hook(id, 'SessionStart', { source: 'resume' })
  await d.hook(id, 'UserPromptSubmit', { prompt: 'go on' })
  await d.die() // busy
  const e = await claudeApp(userData)
  assert.ok(e.row(id)?.interruptedNote)
  await e.manager.wake(id)
  assert.ok(e.row(id)?.interruptedNote)
  e.manager.dismissInterrupted(id)
  assert.equal(e.row(id)?.interruptedNote, undefined)
  assert.equal(e.record(id)?.interruptedAt, undefined)
  e.manager.close()
  await e.server.close()
})

await t('stop -> recent -> reopen; forget; a sleeping row that is stopped stays in Recent', async () => {
  const userData = tempDir()
  const a = await claudeApp(userData)
  const one = (await a.manager.start({ provider: 'claude-code', cwd: userData, title: 'One' })).id
  const two = (await a.manager.start({ provider: 'claude-code', cwd: userData, title: 'Two' })).id
  const never = (await a.manager.start({ provider: 'claude-code', cwd: userData, title: 'Never ready' })).id
  await a.hook(one, 'SessionStart', {}, 'conv-one')
  await a.hook(two, 'SessionStart', {}, 'conv-two')
  await a.hook(one, 'UserPromptSubmit', { prompt: 'first job' }, 'conv-one')
  assert.deepEqual(a.manager.recent(), [])

  // The user stops a session: its record moves to Recent, nothing pending, not interrupted.
  await a.manager.stop(one)
  assert.equal(a.row(one)?.state, 'exited')
  let recent = a.manager.recent()
  assert.deepEqual(recent.map((r) => [r.id, r.status, r.title, r.lastPrompt, r.interrupted, r.providerSessionId]), [[one, 'recent', 'One', 'first job', false, 'conv-one']])
  // One that never got as far as a conversation leaves nothing behind.
  await a.manager.stop(never)
  assert.equal(a.record(never), undefined)
  // A running session can't be forgotten.
  assert.throws(() => a.manager.forget(two), new RegExp(STOP_BEFORE_FORGET))
  assert.equal(STOP_BEFORE_FORGET, 'Stop the session before forgetting it')
  // It exits by itself: Recent as well, newest first.
  a.pty.exit(two, 0)
  await until(() => a.manager.recent().length === 2, 'two recent records')
  assert.deepEqual(a.manager.recent().map((r) => r.id), [two, one])

  // Reopen: a live session again, the same id, resumed; the record is `open` again.
  a.pty.spawned.delete(one)
  const again = await a.manager.reopen(one)
  assert.equal(again.id, one)
  assert.equal(again.state, 'starting')
  assert.equal(again.title, 'One')
  assert.deepEqual(a.pty.spawned.get(one)!.opts.args.slice(-2), ['--resume', 'conv-one'])
  assert.equal(a.record(one)?.status, 'open')
  assert.deepEqual(a.manager.recent().map((r) => r.id), [two])
  assert.equal(a.manager.list().filter((s) => s.id === one).length, 1) // its ended row was replaced, not doubled
  // A second click on the same entry does not start it twice.
  assert.equal((await a.manager.reopen(one)).id, one)
  await assert.rejects(a.manager.reopen('s-nope'), /no longer in the recent list/)
  await assert.rejects(a.manager.reopen(null), /unknown session/)

  // Forget: the recent entry is gone (and its ended row with it); the provider's history is not ours to touch.
  a.manager.forget(two)
  assert.deepEqual(a.manager.recent(), [])
  assert.equal(a.row(two), undefined)
  assert.equal(a.record(two), undefined)
  a.manager.forget(two) // already gone: fine
  assert.throws(() => a.manager.forget(7), /unknown session/)
  await a.hook(one, 'SessionStart', {}, 'conv-one')
  await a.die()

  // Next launch: `one` is asleep. Stopping a sleeping row takes it out of the sidebar and into Recent.
  const b = await claudeApp(userData)
  assert.deepEqual(b.manager.list().map((s) => [s.id, s.state]), [[one, 'asleep']])
  b.state.lists = 0
  await b.manager.stop(one)
  assert.deepEqual(b.manager.list(), [])
  assert.deepEqual(b.manager.recent().map((r) => r.id), [one])
  await until(() => b.state.lists > 0, 'sessionsChanged after stopping a sleeping row')
  assert.equal(b.pty.spawned.size, 0)
  // Reopen it from Recent, then stop it for real, then forget it.
  await b.manager.reopen(one)
  assert.equal(b.row(one)?.state, 'starting')
  await b.manager.stop(one)
  b.manager.forget(one) // its ended row is still on show: gone at once
  assert.deepEqual(b.manager.list(), [])
  assert.deepEqual(b.saved().sessions, [])
  await b.die()

  // Forget a sleeping row directly.
  const c = await claudeApp(userData)
  c.store.put(record('s-sleeper', { cwd: userData }))
  await c.die()
  const d = await claudeApp(userData)
  assert.equal(d.row('s-sleeper')?.state, 'asleep')
  d.manager.forget('s-sleeper')
  assert.deepEqual(d.manager.list(), [])
  assert.deepEqual(d.manager.recent(), [])
  d.manager.close()
  await d.server.close()
})

await t('restore modes: last (the selected session), all (one at a time), none; settings are validated', async () => {
  const seed = (selected: string | null | undefined) => {
    const userData = tempDir()
    const store = new SessionStore({ file: join(userData, 'sessions.json') })
    store.load()
    store.put(record('s-a', { cwd: userData, startedAt: 1, lastActiveAt: 50 }))
    store.put(record('s-b', { cwd: userData, startedAt: 2, lastActiveAt: 90 }))
    store.put(record('s-c', { cwd: userData, startedAt: 3, lastActiveAt: 70 }))
    store.put(record('s-noconv', { cwd: userData, startedAt: 4, lastActiveAt: 99, providerSessionId: undefined }))
    if (selected !== undefined) store.setSelected(selected)
    store.flush()
    return userData
  }

  // none: everything stays asleep.
  const none = await claudeApp(seed('s-c'), { mode: 'none' })
  await none.manager.restoreOnLaunch()
  assert.deepEqual(none.pty.order, [])
  assert.deepEqual(none.manager.list().map((s) => [s.id, s.state, s.wakeable]), [['s-a', 'asleep', true], ['s-b', 'asleep', true], ['s-c', 'asleep', true], ['s-noconv', 'asleep', false]])
  assert.deepEqual(none.manager.getRestoreSettings(), { mode: 'none' })
  assert.deepEqual(none.manager.setRestoreSettings({ mode: 'all' }), { mode: 'all' })
  assert.deepEqual(none.manager.getRestoreSettings(), { mode: 'all' })
  assert.throws(() => none.manager.setRestoreSettings({ mode: 'everything' }), /invalid restore settings/)
  assert.throws(() => none.manager.setRestoreSettings('all'), /invalid restore settings/)
  // A row without a saved conversation can't be woken.
  await assert.rejects(none.manager.wake('s-noconv'), new RegExp(NO_SAVED_CONVERSATION))
  assert.equal(NO_SAVED_CONVERSATION, 'This session has no saved conversation to resume')
  await assert.rejects(none.manager.wake('s-nope'), /unknown session/)
  await assert.rejects(none.manager.wake({ id: 's-a' }), /unknown session/)
  none.manager.close()
  await none.server.close()

  // last: only the session that was selected.
  const last = await claudeApp(seed('s-c'), { mode: 'last' })
  assert.equal(last.manager.getSelected(), 's-c')
  // The renderer reports "nothing selected" while it boots: the launch selection still decides.
  last.manager.setSelected(null)
  await last.manager.restoreOnLaunch()
  assert.deepEqual(last.pty.order, ['s-c'])
  assert.deepEqual(last.manager.list().map((s) => s.state), ['asleep', 'asleep', 'starting', 'asleep'])
  assert.deepEqual(last.manager.list().map((s) => s.id), ['s-a', 's-b', 's-c', 's-noconv']) // the sidebar order did not change
  await last.manager.restoreOnLaunch() // once per launch
  assert.deepEqual(last.pty.order, ['s-c'])
  last.manager.close()
  await last.server.close()

  // last, but nothing was selected when the app closed: nothing is woken.
  const nothing = await claudeApp(seed(null), { mode: 'last' })
  await nothing.manager.restoreOnLaunch()
  assert.deepEqual(nothing.pty.order, [])
  assert.equal(nothing.manager.getSelected(), null)
  nothing.manager.close()
  await nothing.server.close()

  // last, and the selection was never reported (an older build): the most recently active one that can be woken.
  const unknown = await claudeApp(seed(undefined), { mode: 'last' })
  await unknown.manager.restoreOnLaunch()
  assert.deepEqual(unknown.pty.order, ['s-b'])
  unknown.manager.close()
  await unknown.server.close()

  // last, but the selected row has no conversation: nothing is woken.
  const dead = await claudeApp(seed('s-noconv'), { mode: 'last' })
  await dead.manager.restoreOnLaunch()
  assert.deepEqual(dead.pty.order, [])
  dead.manager.close()
  await dead.server.close()

  // all: one at a time, each waiting until the one before is ready (or for the time limit).
  const all = await claudeApp(seed('s-b'), { mode: 'all', wakeWaitMs: 400 })
  const done = all.manager.restoreOnLaunch()
  await until(() => all.pty.order.length === 1, 'the first wake')
  await sleep(120)
  assert.deepEqual(all.pty.order, ['s-a']) // the second waits for the first
  await all.hook('s-a', 'SessionStart', {}, 'conv-s-a')
  await until(() => all.pty.order.length === 2, 'the second wake, as soon as the first is ready', 300)
  // The second never reports (a folder-trust dialog, say): the third follows after the time limit.
  const waited = Date.now()
  await until(() => all.pty.order.length === 3, 'the third wake, after the time limit', 2000)
  assert.ok(Date.now() - waited >= 250, 'the third did not wait')
  await all.hook('s-c', 'SessionStart', {}, 'conv-s-c')
  await done
  assert.deepEqual(all.pty.order, ['s-a', 's-b', 's-c'])
  assert.deepEqual(all.manager.list().map((s) => s.state), ['idle', 'starting', 'idle', 'asleep'])
  all.manager.close()
  await all.server.close()
})

await t(`sleeping rows do not count as running sessions; the sidebar keeps at most ${MAX_LIVE_SESSIONS} rows`, async () => {
  const userData = tempDir()
  const store = new SessionStore({ file: join(userData, 'sessions.json') })
  store.load()
  for (let i = 0; i < MAX_LIVE_SESSIONS; i++) store.put(record(`s-old-${i}`, { cwd: userData, startedAt: i, lastActiveAt: 100 + i, interrupted: i === 0 }))
  store.flush()
  const a = await claudeApp(userData)
  assert.equal(a.manager.list().length, MAX_LIVE_SESSIONS)
  // Eight sleeping rows, and still room to start: the one that was active longest ago moves to Recent.
  const fresh = await a.manager.start({ provider: 'claude-code', cwd: userData })
  const rows = a.manager.list()
  assert.equal(rows.length, MAX_LIVE_SESSIONS)
  assert.ok(!rows.some((s) => s.id === 's-old-0'))
  assert.equal(rows[rows.length - 1].id, fresh.id)
  assert.deepEqual(a.manager.recent().map((r) => r.id), ['s-old-0'])
  assert.equal(a.manager.recent()[0].interrupted, true) // it keeps its note for a reopen
  // Reopening it makes room again, and brings the note back.
  const back = await a.manager.reopen('s-old-0')
  assert.ok(back.interruptedNote)
  assert.equal(a.manager.list().length, MAX_LIVE_SESSIONS)
  assert.deepEqual(a.manager.recent().map((r) => r.id), ['s-old-1'])
  // The limit on RUNNING sessions is unchanged: two run, six more may be woken, the next is refused and stays asleep.
  for (let i = 2; i < MAX_LIVE_SESSIONS; i++) await a.manager.wake(`s-old-${i}`)
  assert.equal(a.pty.spawned.size, MAX_LIVE_SESSIONS)
  await assert.rejects(a.manager.start({ provider: 'claude-code', cwd: userData }), /too many sessions/)
  await assert.rejects(a.manager.reopen('s-old-1'), /too many sessions/)
  assert.deepEqual(a.manager.recent().map((r) => r.id), ['s-old-1']) // still in Recent
  assert.equal(a.manager.list().length, MAX_LIVE_SESSIONS)
  a.manager.close()
  await a.server.close()

  // A wake that can't start leaves the row asleep, exactly as it was.
  const gone = tempDir()
  const s2 = new SessionStore({ file: join(gone, 'sessions.json') })
  s2.load()
  s2.put(record('s-nofolder', { cwd: join(gone, 'deleted-folder'), interrupted: true }))
  s2.flush()
  const b = await claudeApp(gone)
  await assert.rejects(b.manager.wake('s-nofolder'), /that folder does not exist/)
  assert.equal(b.row('s-nofolder')?.state, 'asleep')
  assert.ok(b.row('s-nofolder')?.interruptedNote)
  assert.equal(b.record('s-nofolder')?.status, 'open')
  b.manager.close()
  await b.server.close()
})

await t('a conversation that no longer exists (Claude): the session ends with a notice and can never be woken again', async () => {
  const userData = tempDir()
  const store = new SessionStore({ file: join(userData, 'sessions.json') })
  store.load()
  store.put(record('s-lost', { cwd: userData, interrupted: true }))
  store.put(record('s-crash', { cwd: userData, startedAt: 2000 }))
  store.flush()
  const a = await claudeApp(userData)
  // `claude --resume <id>` starts, prints that there is no such conversation and exits.
  await a.manager.wake('s-lost')
  a.pty.screen = 'No conversation found with session ID: conv-s-lost'
  a.pty.exit('s-lost', 1)
  await until(() => !!a.row('s-lost')?.notice, 'the notice')
  const row = a.row('s-lost')!
  assert.equal(row.state, 'exited')
  assert.equal(row.notice, CONVERSATION_GONE)
  assert.equal(CONVERSATION_GONE, 'The saved conversation no longer exists, so this session could not be resumed')
  assert.equal(row.interruptedNote, undefined)
  const rec = a.record('s-lost')!
  assert.equal(rec.status, 'recent')
  assert.equal(canWake(rec), false)
  assert.equal(rec.interrupted, false)
  await assert.rejects(a.manager.reopen('s-lost'), new RegExp(NO_SAVED_CONVERSATION))
  await assert.rejects(a.manager.wake('s-lost'), /unknown session/)
  // Any other early exit (the CLI crashed, the user closed the trust dialog) keeps the conversation: it can be reopened.
  await a.manager.wake('s-crash')
  a.pty.screen = 'Something else went wrong'
  a.pty.exit('s-crash', 1)
  await sleep(50)
  assert.equal(a.row('s-crash')?.state, 'exited')
  assert.equal(a.row('s-crash')?.notice, undefined)
  assert.equal(canWake(a.record('s-crash')!), true)
  assert.equal(a.record('s-crash')?.status, 'recent')
  a.manager.close()
  await a.server.close()
})

// ---- Codex (the fake app-server) ---------------------------------------------------------------------

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-server.cjs', import.meta.url))
class NoPty implements PtyHost {
  async spawn(): Promise<void> {}
  write(): void {}
  resize(): void {}
  kill(): void {}
  dispose(): void {}
  async snapshot(): Promise<null> {
    return null
  }
  detach(): void {}
  ack(): void {}
}

function codexApp(userData: string, mode: RestoreMode = 'none') {
  const file = join(userData, 'sessions.json')
  const store = new SessionStore({ file, debounceMs: 20 })
  const codex = codexProvider({
    openExternal: async () => {},
    server: { resolveSpawn: (): CodexSpawnSpec => ({ file: process.execPath, args: [FAKE], env: { ...(process.env as Record<string, string>) } }), backoffMs: [50, 100] },
    findExecutable: () => process.execPath,
    version: async () => '0.160.0'
  })
  let permissions: PermissionRequestInfo[] = []
  let sessions: SessionInfo[] = []
  const manager = new SessionManager({
    pty: new NoPty(),
    sink: { emit: () => {} },
    providers: [codex],
    allowOrders: () => true,
    worldTopLevel: () => [],
    onSessionsChanged: (list) => (sessions = list),
    onPermissionsChanged: (list) => (permissions = list),
    onTerminalData: () => {},
    restore: { store, settings: () => ({ mode }) }
  })
  const received = async () => ((await codex.server.request('fake/log')) as { received: { method: string; params?: Record<string, unknown> }[] }).received
  return {
    file, store, codex, manager, received,
    permissions: () => permissions,
    sessions: () => sessions,
    row: (id: string) => manager.list().find((s) => s.id === id),
    record: (id: string) => {
      store.flush()
      return readStore(file).sessions.find((r) => r.id === id)
    },
    /** The app is gone without a goodbye; only the test's own child process is cleaned up. */
    die: async () => {
      await sleep(60)
      codex.server.killSync()
    }
  }
}

await t('Codex: prompt -> approval pending -> the app dies -> asleep -> wake resumes the thread with policy and sandbox -> note gone on the first prompt', async () => {
  const userData = tempDir()
  const a = codexApp(userData)
  const info = await a.manager.start({ provider: 'codex', cwd: userData, permissionMode: 'acceptEdits', title: 'Backend' })
  const id = info.id
  const thread = info.providerSessionId!
  assert.ok(thread)
  let rec = a.record(id)!
  assert.deepEqual([rec.status, rec.providerSessionId, rec.title, rec.titleIsCustom, rec.interrupted], ['open', thread, 'Backend', true, false])
  await a.manager.chatSend(id, 'please approve this command')
  await until(() => a.permissions().length === 1, 'the approval request')
  const question = a.permissions()[0].question
  rec = a.record(id)!
  assert.equal(rec.lastPrompt, 'please approve this command')
  assert.equal(rec.interrupted, true)
  assert.deepEqual(rec.pendingAtClose.map((p) => p.question), [question])
  assert.match(question, /ao-fake/) // the plain question names the command; the card's detail is not saved
  assert.ok(!readFileSync(a.file, 'utf8').includes('commandActions'))
  await a.die()

  const b = codexApp(userData, 'last')
  const asleep = b.row(id)!
  assert.deepEqual([asleep.state, asleep.wakeable, asleep.surface, asleep.title, asleep.permissionMode, asleep.canReceiveOrders], ['asleep', true, 'chat', 'Backend', 'acceptEdits', false])
  assert.deepEqual(asleep.interruptedNote?.pending.map((p) => p.question), [question])
  assert.throws(() => b.manager.chatAttach(id), /asleep — wake it first/)
  await assert.rejects(b.manager.chatSend(id, 'hello'), /asleep — wake it first/)
  assert.deepEqual(await b.manager.sendOrder({ target: 'provider:codex', text: 'hello' }), { delivered: [], failed: [{ agentId: id, reason: REASON_ASLEEP }] })
  // Its thread is not offered again under "Resume previous…".
  assert.ok(!(await b.manager.history('codex', userData)).some((h) => h.id === thread))

  // Restore mode 'last' with no selection ever reported: the most recently active session is woken.
  await b.manager.restoreOnLaunch()
  const awake = b.row(id)!
  assert.equal(awake.state, 'idle')
  assert.equal(awake.providerSessionId, thread)
  assert.equal(awake.startedAt, info.startedAt)
  assert.ok(awake.interruptedNote)
  const resume = (await b.received()).filter((m) => m.method === 'thread/resume')
  assert.equal(resume.length, 1)
  // Resume restores neither: both are sent again (docs/spikes-phase-b.md).
  assert.equal(resume[0].params?.threadId, thread)
  assert.equal(resume[0].params?.approvalPolicy, 'on-request')
  assert.equal(resume[0].params?.sandbox, 'workspace-write')
  assert.equal(resume[0].params?.cwd, userData)
  assert.ok(!(await b.received()).some((m) => m.method === 'thread/start'))
  assert.deepEqual(b.manager.chatAttach(id).filter((i) => i.kind === 'user'), []) // the fake has no history for it; the real server replays it
  // The first prompt after waking: the note goes.
  await b.manager.chatSend(id, 'what were you doing?')
  assert.equal(b.row(id)?.interruptedNote, undefined)
  await until(() => b.row(id)?.state === 'idle', 'the turn to end')
  await until(() => b.record(id)?.interrupted === false, 'the record to follow')
  assert.equal(b.record(id)?.lastPrompt, 'what were you doing?')
  assert.deepEqual(b.record(id)?.pendingAtClose, [])

  // A graceful quit drops the thread and stops the app-server; the record stays open.
  await b.manager.shutdown()
  assert.equal(b.record(id)?.status, 'open')
})

await t('a conversation that no longer exists (Codex): wake rejects, the row ends with the notice, the record can never be woken again', async () => {
  const userData = tempDir()
  const store = new SessionStore({ file: join(userData, 'sessions.json') })
  store.load()
  store.put(record('s-lost', { provider: 'codex', cwd: userData, providerSessionId: 'thr-missing', interrupted: true }))
  store.put(record('s-rec', { provider: 'codex', cwd: userData, providerSessionId: 'thr-missing', status: 'recent' }))
  store.flush()
  const a = codexApp(userData)
  await assert.rejects(a.manager.wake('s-lost'), new RegExp(CONVERSATION_GONE))
  const row = a.row('s-lost')!
  assert.equal(row.state, 'exited')
  assert.equal(row.notice, CONVERSATION_GONE)
  assert.equal(row.providerSessionId, undefined)
  assert.equal(row.interruptedNote, undefined)
  assert.equal(row.wakeable, undefined)
  assert.equal(row.waking, undefined)
  await until(() => a.sessions().some((s) => s.id === 's-lost' && s.state === 'exited' && !s.waking), 'sessionsChanged with the ended row')
  // It never had a process: attaching says why, in plain words.
  assert.throws(() => a.manager.chatAttach('s-lost'), new RegExp(CONVERSATION_GONE))
  await assert.rejects(a.manager.attach('s-lost'), new RegExp(CONVERSATION_GONE))
  const rec = a.record('s-lost')!
  assert.equal(canWake(rec), false)
  assert.equal(rec.status, 'recent')
  await assert.rejects(a.manager.wake('s-lost'), /unknown session/)
  await assert.rejects(a.manager.reopen('s-lost'), new RegExp(NO_SAVED_CONVERSATION))
  // The same from the recent list.
  await assert.rejects(a.manager.reopen('s-rec'), new RegExp(CONVERSATION_GONE))
  assert.equal(canWake(a.record('s-rec')!), false)
  assert.equal(a.record('s-rec')?.status, 'recent')
  // Dismissing the ended row (Stop) takes it off the list; the dead record stays in Recent until it is forgotten.
  await a.manager.stop('s-lost')
  assert.equal(a.row('s-lost'), undefined)
  assert.ok(a.manager.recent().some((r) => r.id === 's-lost'))
  a.manager.forget('s-lost')
  a.manager.forget('s-rec')
  assert.deepEqual(a.manager.recent(), [])
  await a.manager.shutdown()
})

console.log(`\n${pass} restore tests passed`)
