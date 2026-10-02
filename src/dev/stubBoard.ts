// DEV / PREVIEW ONLY: the office board of the stub bridge (see ./stubBridge.ts). One team per fake
// session, with made-up files, claims, notes and a warning, all kept in memory.
//
// URL parameter: ?board=none (a bridge without a board, as an older main process: no Board tab).
// Console handle (window.__stub.board): note(text, sessionId?) · handover(text, to, sessionId?) ·
// touch(sessionId, path, kind?) · claim(sessionId, task, files?) · failNextRemove() · snapshot()
import type { BoardClaim, BoardFile, BoardNote, BoardSettings, BoardSnapshot, BoardStatus, BoardWarning } from '../../shared/board'
import type { AgentOfficeBridge } from '../../shared/ipc'
import type { SessionInfo, SessionState } from '../../shared/sessions'

const MIN = 60_000

const STATUS: Record<SessionState, BoardStatus> = {
  starting: 'idle',
  idle: 'idle',
  busy: 'busy',
  'waiting-permission': 'waiting',
  'needs-attention': 'waiting',
  asleep: 'ended',
  exited: 'ended'
}

export interface BoardStub {
  bridge: AgentOfficeBridge['board']
  /** Call when the sessions changed (a team was added, its state changed). */
  sync(): void
  /** The demo scenario: `main`, `codex` and `tests` share a repository, `other` works elsewhere. */
  seed(ids: { main: string; codex?: string; tests: string; other: string }): void
  handle: {
    note(text: string, sessionId?: string): void
    handover(text: string, to: string, sessionId?: string): void
    touch(sessionId: string, path: string, kind?: BoardFile['kind']): void
    claim(sessionId: string, task: string, files?: string[]): void
    failNextRemove(): void
    snapshot(): BoardSnapshot
  }
}

export function createBoardStub(sessions: () => SessionInfo[]): BoardStub {
  const cbs = new Set<(s: BoardSnapshot) => void>()
  const files = new Map<string, BoardFile[]>()
  let claims: BoardClaim[] = []
  let notes: BoardNote[] = []
  let warnings: BoardWarning[] = []
  let settings: BoardSettings = { enabled: true, conflictMode: 'block-once' }
  let counter = 0
  let failNext = false
  let timer = 0

  const projectOf = (s: SessionInfo) => s.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const labelOf = (s: SessionInfo) => s.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? s.cwd
  const find = (id?: string) => sessions().find((s) => s.id === id) ?? sessions().find((s) => s.state !== 'exited')

  const snapshot = (): BoardSnapshot => ({
    branches: sessions().map((s) => {
      const own = files.get(s.id) ?? []
      const task = claims.filter((c) => c.sessionId === s.id).sort((a, b) => b.ts - a.ts)[0]?.task ?? ''
      return {
        sessionId: s.id,
        team: s.title,
        provider: s.provider,
        project: projectOf(s),
        projectLabel: labelOf(s),
        status: STATUS[s.state],
        task,
        files: [...own].sort((a, b) => b.ts - a.ts),
        lastActiveTs: Math.max(s.startedAt, ...own.map((f) => f.ts))
      }
    }),
    claims: [...claims],
    notes: [...notes],
    warnings: [...warnings]
  })

  const sync = () => {
    if (timer) return
    timer = window.setTimeout(() => {
      timer = 0
      const snap = snapshot()
      cbs.forEach((cb) => cb(snap))
    }, 60)
  }

  const touch = (sessionId: string, path: string, kind: BoardFile['kind'] = 'edit', ts = Date.now()) => {
    files.set(sessionId, [{ path, kind, ts }, ...(files.get(sessionId) ?? []).filter((f) => f.path !== path)])
    sync()
  }
  const claim = (sessionId: string, task: string, claimFiles: string[] = [], ts = Date.now()) => {
    const s = find(sessionId)
    if (!s) return
    claims = [{ id: `claim-${++counter}`, project: projectOf(s), task, sessionId: s.id, team: s.title, ts, files: claimFiles }, ...claims]
    sync()
  }
  const post = (kind: BoardNote['kind'], text: string, sessionId?: string, to?: string, ts = Date.now()) => {
    const s = find(sessionId)
    if (!s) return
    notes = [{ id: `note-${++counter}`, project: projectOf(s), sessionId: s.id, team: s.title, ts, text, kind, ...(to ? { to } : {}) }, ...notes]
    sync()
  }

  const seed: BoardStub['seed'] = ({ main, codex, tests, other }) => {
    const now = Date.now()
    const title = (id: string) => sessions().find((s) => s.id === id)?.title ?? id
    const put = (id: string, list: [string, number, BoardFile['kind']?][]) =>
      files.set(id, list.map(([path, min, kind]) => ({ path, ts: now - min * MIN, kind: kind ?? 'edit' })))
    put(main, [
      ['src/ui/controller.ts', 2],
      ['shared/ipc.ts', 4],
      ['src/ui/store.ts', 9],
      ['src/ui/components/Panel.tsx', 12],
      ['src/ui/board.ts', 15, 'create'],
      ['src/ui/styles/app.css', 21],
      ['tests/ui.test.ts', 26],
      ['src/ui/legacyPanel.ts', 31, 'delete']
    ])
    put(tests, [
      ['tests/board.test.ts', 3, 'create'],
      ['src/ui/controller.ts', 17]
    ])
    put(other, [
      ['src/cart/checkout.ts', 7],
      ['package.json', 34]
    ])
    claim(main, 'Board panel: tab, team rows, overlap tags', ['src/ui/components/BoardView.tsx', 'src/ui/board.ts'], now - 14 * MIN)
    post('note', "Tab ids are persisted in the layout: 'board' was added, don't rename the others.", main, undefined, now - 5 * MIN)
    post('handover', 'The selector tests are written (tests/boardui.test.ts). The controller wiring is yours.', tests, title(main), now - 2 * MIN)
    if (codex) {
      put(codex, [
        ['shared/ipc.ts', 1],
        ['electron/board.ts', 6, 'create'],
        ['electron/main.ts', 11],
        ['electron/preload.ts', 14]
      ])
      claim(codex, 'Board model and IPC in the main process', ['electron/board.ts', 'shared/ipc.ts'], now - 18 * MIN)
      post('note', 'board.get() returns { snapshot, settings }; onChanged pushes the whole snapshot, coalesced.', codex, undefined, now - 9 * MIN)
      const c = find(codex)
      if (c) {
        warnings = [{ id: `warn-${++counter}`, project: projectOf(c), sessionId: codex, team: c.title, path: 'shared/ipc.ts', otherTeam: title(main), ts: now - 1 * MIN }]
      }
    }
    sync()
    // Something new after a moment: a note (the world shows it travelling to the HQ), then a hand-over.
    window.setTimeout(() => {
      post('note', 'The /mcp route is up: board_read answers from memory.', codex ?? main)
      touch(tests, 'tests/boardui.test.ts', 'create')
    }, 8000)
    window.setTimeout(() => post('handover', 'Conflict warnings are wired for Claude. Codex in acceptEdits still needs the after-the-fact note.', main, title(tests)), 15_000)
  }

  return {
    bridge: {
      get: async () => ({ snapshot: snapshot(), settings: { ...settings } }),
      remove: async (kind, id) => {
        await new Promise((r) => setTimeout(r, 200))
        if (failNext) {
          failNext = false
          throw new Error('stub: the board could not be changed')
        }
        const had = kind === 'claim' ? claims.some((c) => c.id === id) : notes.some((n) => n.id === id)
        if (kind === 'claim') claims = claims.filter((c) => c.id !== id)
        else notes = notes.filter((n) => n.id !== id)
        if (had) sync()
        return had
      },
      setSettings: async (patch) => {
        await new Promise((r) => setTimeout(r, 120))
        settings = { ...settings, ...patch }
        return { ...settings }
      },
      onChanged: (cb) => (cbs.add(cb), () => cbs.delete(cb))
    },
    sync,
    seed,
    handle: {
      note: (text, sessionId) => post('note', text, sessionId),
      handover: (text, to, sessionId) => post('handover', text, sessionId, to),
      touch: (sessionId, path, kind) => touch(sessionId, path, kind),
      claim: (sessionId, task, claimFiles) => claim(sessionId, task, claimFiles),
      failNextRemove: () => {
        failNext = true
      },
      snapshot
    }
  }
}
