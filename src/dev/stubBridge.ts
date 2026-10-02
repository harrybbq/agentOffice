// DEV / PREVIEW ONLY. A fake `window.agentOffice` for running the renderer in a plain browser
// (Vite dev URL or a static build) so the shell can be developed and screenshotted without
// Electron. Nothing here talks to a real agent. It is loaded only when the real bridge is missing
// (see src/main.tsx) and is code-split out of the main bundle.
//
// URL parameters: ?stub=demo (default: three Claude sessions, a Codex chat session, permission
// requests, a simulated external team, an office board) | ?stub=empty (nothing running, an empty
// board) · ?orders=off · ?overlay=1 · ?board=none (no office board, as an older main process)
// · ?codex=loggedout (Codex needs a sign-in; "Log in" succeeds after a few seconds)
// · ?play=0 (the Codex session does not start its scripted turn by itself) · ?speed=0.5 (script speed)
// · ?restore=none (nothing saved from an earlier run: no asleep rows, no Recent list) · ?restore=demo
//   with ?stub=empty (only the restored rows, as right after a restart) · ?restore=old (a bridge
//   without restore, as an older main process)
// Console handle: window.__stub (permission(), exit(id, code), attention(id), resolveElsewhere(id),
// codex.play(id) / codex.fill(id, n) / codex.failNextSend(), codexId(), logout(), board.note(text),
// restore.failNextWake() / failNextForget() / failNextReopen() / selected() / settings() ...).
// The Codex side (chat sessions, the scripted turn) lives in ./stubCodex.ts, the office board in
// ./stubBoard.ts.
import { permissionAction, plainPermission } from '../../shared/permissionText'
import { parseAgentEvent } from '../../shared/events'
import type { Activity, AgentEvent } from '../../shared/events'
import type { AgentOfficeBridge, RendererSettings } from '../../shared/ipc'
import { PROVIDER_TARGET_PREFIX, REASON_DISABLED, REASON_NO_SESSIONS } from '../../shared/orders'
import type { OrderResult } from '../../shared/orders'
import type { RestoreSettings, SavedSession } from '../../shared/restore'
import type {
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderInfo,
  SessionInfo,
  SessionState,
  StartSessionRequest
} from '../../shared/sessions'
import { subagentId } from '../../shared/sessions'
import { createBoardStub } from './stubBoard'
import { createCodexStub } from './stubCodex'

const ESC = '\x1b'
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`
const fg = (n: number, s: string) => `${ESC}[38;5;${n}m${s}${ESC}[0m`
const PROMPT = `${fg(245, '>')} `

interface FakeSession {
  info: SessionInfo
  buffer: string
  attached: boolean
  line: string
  workers: string[]
  timers: number[]
}

const DAY = 86_400_000

/** The repo's bundled themes, loaded lazily (this module is only ever loaded without Electron). */
const THEME_FILES = import.meta.glob<{ default: any }>('../../themes/*/*.json')

const SAMPLE_FILES = ['src/ui/App.tsx', 'shared/ipc.ts', 'electron/main.ts', 'README.md', 'src/scene/OfficeScene.ts']

export function createStubBridge(): AgentOfficeBridge {
  const params = new URLSearchParams(location.search)
  const mode = params.get('stub') === 'empty' ? 'empty' : 'demo'
  const settings: RendererSettings = {
    theme: 'office',
    overlay: params.get('overlay') === '1',
    allowOrders: params.get('orders') !== 'off',
    officeWideTimeoutMs: 10 * 60_000,
    windowsBuild: 0
  }

  const settingsCbs = new Set<(s: RendererSettings) => void>()
  const loggedOut = params.get('codex') === 'loggedout'
  let PROVIDERS: ProviderInfo[] = [
    { id: 'claude-code', label: 'Claude Code', available: true, version: '2.1.284 (stub)' },
    {
      id: 'codex',
      label: 'Codex',
      available: true,
      version: '0.160.0 (stub)',
      account: loggedOut ? { loggedIn: false } : { loggedIn: true, plan: 'free' },
      usage: loggedOut ? undefined : { usedPercent: 12, resetsAt: Date.now() + 19 * DAY, windowMinutes: 43200 }
    },
    { id: 'antigravity', label: 'Antigravity', available: false, reason: 'Not installed' }
  ]
  const providerCbs = new Set<(p: ProviderInfo[]) => void>()
  const setCodexAccount = (loggedIn: boolean) => {
    PROVIDERS = PROVIDERS.map((p) =>
      p.id !== 'codex'
        ? p
        : loggedIn
          ? { ...p, account: { loggedIn: true, plan: 'free' }, usage: { usedPercent: 12, resetsAt: Date.now() + 19 * DAY, windowMinutes: 43200 } }
          : { ...p, account: { loggedIn: false }, usage: undefined }
    )
    providerCbs.forEach((cb) => cb(PROVIDERS))
  }

  const eventCbs = new Set<(e: AgentEvent) => void>()
  const sessionCbs = new Set<(s: SessionInfo[]) => void>()
  const permCbs = new Set<(p: PermissionRequestInfo[]) => void>()
  const dataCbs = new Set<(id: string, data: string) => void>()
  const sessions = new Map<string, FakeSession>()
  let pending: PermissionRequestInfo[] = []
  let counter = 0
  // An asleep row has no team: it is not on the office board.
  const board = createBoardStub(() => [...sessions.values()].map((s) => s.info).filter((i) => i.state !== 'asleep'))

  const emit = (input: Partial<AgentEvent> & { agentId: string; activity: Activity }) => {
    const e = parseAgentEvent({ provider: 'claude-code', ts: Date.now(), ...input })
    if (e) eventCbs.forEach((cb) => cb(e))
  }
  const pushSessions = () => {
    const list = [...sessions.values()].map((s) => ({ ...s.info }))
    sessionCbs.forEach((cb) => cb(list))
    board.sync()
  }
  const pushPerms = () => {
    const list = [...pending]
    permCbs.forEach((cb) => cb(list))
  }
  const setState = (s: FakeSession, state: SessionState) => {
    if (s.info.state === 'exited' || !sessions.has(s.info.id)) return
    s.info.state = state
    s.info.canReceiveOrders = state === 'idle' || state === 'busy'
    pushSessions()
  }
  const out = (s: FakeSession, data: string) => {
    s.buffer = (s.buffer + data).slice(-200_000)
    if (s.attached) dataCbs.forEach((cb) => cb(s.info.id, data))
  }
  const later = (s: FakeSession, ms: number, fn: () => void) => {
    s.timers.push(window.setTimeout(() => s.info.state !== 'exited' && fn(), ms))
  }

  const speed = Number(params.get('speed'))
  const codex = createCodexStub(
    {
      info: (id) => sessions.get(id)?.info,
      setState: (id, state) => {
        const s = sessions.get(id)
        if (s) setState(s, state)
      },
      activity: (id, activity, detail) => {
        const s = sessions.get(id)
        if (s) emit({ agentId: id, parentId: null, provider: 'codex', displayName: s.info.title, activity, detail })
      },
      permission: (requestId) => pending.find((p) => p.id === requestId),
      requestPermission: (id, tool, summary, detail) => {
        const s = sessions.get(id)!
        return requestPermission(s, id, s.info.title, tool, summary, detail).id
      },
      dropPermissions: (id) => {
        for (const p of pending.filter((x) => x.sessionId === id)) settle(p.id, 'elsewhere')
      }
    },
    { speed: Number.isFinite(speed) && speed > 0 ? speed : 1 }
  )

  const welcome = (s: FakeSession) => {
    out(
      s,
      [
        '',
        ` ${fg(208, '✻')} ${bold('Welcome to Claude Code')} ${dim('(stub terminal, no real agent)')}`,
        '',
        `   ${dim('/help for help, /status for your current setup')}`,
        `   ${dim('cwd:')} ${s.info.cwd}`,
        `   ${dim('mode:')} ${s.info.permissionMode}${s.info.model ? `   ${dim('model:')} ${s.info.model}` : ''}`,
        '',
        ` ${fg(42, '●')} ANSI check: ${fg(203, 'red')} ${fg(42, 'green')} ${fg(221, 'yellow')} ${fg(75, 'blue')} ${fg(177, 'magenta')} ${fg(80, 'cyan')} ${bold('bold')} ${dim('dim')} ${ESC}[4munderline${ESC}[0m ${ESC}[7m inverse ${ESC}[0m`,
        '',
        ''
      ].join('\r\n') + PROMPT
    )
  }

  /** A canned turn: a few tool calls as events, some coloured output, then idle again. */
  const fakeTurn = (s: FakeSession, prompt: string) => {
    const id = s.info.id
    const name = s.info.title
    setState(s, 'busy')
    const file = SAMPLE_FILES[Math.floor(Math.random() * SAMPLE_FILES.length)]
    out(s, `\r\n\r\n${fg(42, '●')} Looking into ${bold(JSON.stringify(prompt.slice(0, 60)))}\r\n`)
    emit({ agentId: id, parentId: null, displayName: name, activity: 'read', detail: file })
    later(s, 700, () => {
      out(s, `\r\n${fg(42, '●')} ${bold('Read')}(${file})\r\n  ${dim('⎿')}  Read ${80 + Math.floor(Math.random() * 300)} lines\r\n`)
    })
    later(s, 1500, () => {
      emit({ agentId: id, parentId: null, displayName: name, activity: 'write', detail: file })
      out(
        s,
        `\r\n${fg(42, '●')} ${bold('Update')}(${file})\r\n  ${dim('⎿')}  Updated with ${fg(42, '3 additions')} and ${fg(203, '1 removal')}\r\n` +
          `     ${fg(203, '-  const ready = false')}\r\n     ${fg(42, '+  const ready = await probe()')}\r\n`
      )
    })
    later(s, 2600, () => {
      emit({ agentId: id, parentId: null, displayName: name, activity: 'idle', detail: '' })
      out(s, `\r\n${fg(42, '●')} Done. ${dim('(stub reply)')}\r\n\r\n${PROMPT}`)
      setState(s, 'idle')
    })
  }

  const input = (s: FakeSession, data: string) => {
    if (s.info.state === 'exited') return
    if (s.info.state === 'needs-attention') {
      // The folder-trust question: any Enter accepts in the stub.
      if (data.includes('\r')) {
        out(s, `\r\n ${fg(42, '✔')} Trusted.\r\n`)
        setState(s, 'idle')
        welcome(s)
      }
      return
    }
    for (const ch of data) {
      if (ch === '\r') {
        const line = s.line.trim()
        s.line = ''
        if (line) fakeTurn(s, line)
        else out(s, `\r\n${PROMPT}`)
      } else if (ch === '\x7f' || ch === '\b') {
        if (s.line.length > 0) {
          s.line = s.line.slice(0, -1)
          out(s, '\b \b')
        }
      } else if (ch === '\x03' || ch === ESC) {
        s.line = ''
        out(s, `${dim('^C')}\r\n${PROMPT}`)
        return
      } else if (ch >= ' ') {
        s.line += ch
        out(s, ch)
      }
    }
  }

  const create = (req: StartSessionRequest, state: SessionState = 'starting'): FakeSession => {
    const id = `stub-${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const folder = req.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? req.cwd
    const s: FakeSession = {
      info: {
        id,
        provider: req.provider,
        cwd: req.cwd,
        title: req.title?.trim() || folder,
        state,
        startedAt: Date.now() + counter,
        permissionMode: req.permissionMode ?? 'default',
        model: req.model,
        surface: req.provider === 'codex' ? 'chat' : 'terminal',
        canReceiveOrders: false
      },
      buffer: '',
      attached: false,
      line: '',
      workers: [],
      timers: []
    }
    sessions.set(id, s)
    emit({ agentId: id, parentId: null, provider: req.provider, displayName: s.info.title, activity: 'idle', detail: '' })
    return s
  }

  const addWorker = (s: FakeSession, name: string, activity: Activity, detail: string): string => {
    const id = subagentId(s.info.id, `w${s.workers.length + 1}`)
    s.workers.push(id)
    emit({ agentId: id, parentId: s.info.id, displayName: name, activity, detail })
    return id
  }

  const requestPermission = (s: FakeSession, agentId: string, displayName: string, tool: string, summary: string, detail: string) => {
    // The same sentence the main process would make of it.
    const what = summary.slice(summary.indexOf(':') + 1).trim()
    const input = /^(bash|command|powershell)$/i.test(tool) ? { command: what } : { file_path: what.split(',')[0].trim(), more: what.split(',').length - 1 }
    const who = agentId === s.info.id ? displayName : `${displayName} (${s.info.title}'s team)`
    const plain = plainPermission({ who, tool, input, cwd: s.info.cwd })
    const req: PermissionRequestInfo = {
      id: `perm-${++counter}`,
      sessionId: s.info.id,
      agentId,
      displayName,
      provider: s.info.provider,
      toolName: tool,
      summary,
      detail,
      ...plain,
      createdAt: Date.now()
    }
    pending = [...pending, req]
    emit({ agentId, parentId: agentId === s.info.id ? null : s.info.id, provider: s.info.provider, displayName, activity: 'waiting', detail: permissionAction(plain.question) })
    out(
      s,
      `\r\n${fg(221, '╭─')} ${bold(tool)} ${dim('needs permission')}\r\n${fg(221, '│')}  ${summary}\r\n${fg(221, '│')}  Do you want to proceed?\r\n${fg(221, '│')}  ${fg(75, '❯ 1. Yes')}   2. Yes, and don't ask again   3. No\r\n${fg(221, '╰─')}\r\n`
    )
    setState(s, 'waiting-permission')
    pushPerms()
    return req
  }

  const settle = (id: string, how: 'allowed' | 'denied' | 'elsewhere', message?: string): PermissionOutcome => {
    const req = pending.find((p) => p.id === id)
    if (!req) return 'unknown-request'
    pending = pending.filter((p) => p.id !== id)
    const s = sessions.get(req.sessionId)
    if (s) {
      const text =
        how === 'allowed'
          ? fg(42, 'Allowed from the CEO desk')
          : how === 'denied'
            ? fg(203, `Denied from the CEO desk${message ? `: ${message}` : ''}`)
            : dim('Answered here in the terminal')
      out(s, `  ${dim('⎿')}  ${text}\r\n`)
      emit({
        agentId: req.agentId,
        parentId: req.agentId === s.info.id ? null : s.info.id,
        provider: s.info.provider,
        displayName: req.displayName,
        activity: how === 'denied' ? 'idle' : 'exec',
        detail: req.summary
      })
      if (!pending.some((p) => p.sessionId === s.info.id)) setState(s, 'busy')
    }
    pushPerms()
    codex.settled(id, how)
    return how === 'elsewhere' ? 'resolved-elsewhere' : how
  }

  const exit = (id: string, code: number | null = 0) => {
    const s = sessions.get(id)
    if (!s || s.info.state === 'exited') return
    s.timers.forEach((t) => window.clearTimeout(t))
    for (const p of pending.filter((x) => x.sessionId === id)) settle(p.id, 'elsewhere')
    out(s, `\r\n${dim(`[process exited with code ${code}]`)}\r\n`)
    s.info.state = 'exited'
    s.info.exitCode = code
    s.info.canReceiveOrders = false
    codex.exited(id)
    emit({ agentId: id, parentId: null, provider: s.info.provider, displayName: s.info.title, activity: 'done', detail: '' })
    pushSessions()
  }

  // ---- restore: what an earlier run left behind ---------------------------------------------
  const HOUR = 3_600_000
  const restoreParam = params.get('restore') ?? (mode === 'demo' ? 'demo' : 'none')
  const restoreSettings: RestoreSettings = { mode: 'last' }
  let recent: SavedSession[] = []
  let selectedSaved: string | null = null
  let failWake: string | null = null
  let failForget: string | null = null
  let failReopen: string | null = null
  /** The prompt preview of each restored row (SavedSession.lastPrompt). */
  const lastPrompts = new Map<string, string>()

  const saved = (o: Partial<SavedSession> & Pick<SavedSession, 'id' | 'provider' | 'cwd' | 'title' | 'lastActiveAt'>): SavedSession => ({
    titleIsCustom: false,
    permissionMode: 'default',
    providerSessionId: `conv-${o.id}`,
    startedAt: o.lastActiveAt - HOUR,
    interrupted: false,
    pendingAtClose: [],
    status: 'recent',
    ...o
  })

  /** A row saved by the last run: no process, no team in the world, no events. */
  const sleeper = (o: Partial<SessionInfo> & Pick<SessionInfo, 'id' | 'provider' | 'cwd' | 'title'>, lastPrompt?: string): FakeSession => {
    const s: FakeSession = {
      info: {
        state: 'asleep',
        startedAt: Date.now() - 26 * HOUR,
        permissionMode: 'default',
        surface: o.provider === 'codex' ? 'chat' : 'terminal',
        canReceiveOrders: false,
        wakeable: true,
        ...o
      },
      buffer: '',
      attached: false,
      line: '',
      workers: [],
      timers: []
    }
    if (lastPrompt) {
      lastPrompts.set(o.id, lastPrompt)
      // Not in SessionInfo (yet): the wake screen shows it when the main process sends it along.
      ;(s.info as SessionInfo & { lastPrompt?: string }).lastPrompt = lastPrompt
    }
    sessions.set(o.id, s)
    return s
  }

  /** A row leaves the sidebar for the Recent list (it was stopped while asleep, or removed after it exited). */
  const toRecent = (s: FakeSession) => {
    const i = s.info
    recent = [
      saved({
        id: i.id,
        provider: i.provider,
        cwd: i.cwd,
        title: i.title,
        permissionMode: i.permissionMode,
        model: i.model,
        providerSessionId: i.wakeable === false ? undefined : `conv-${i.id}`,
        startedAt: i.startedAt,
        lastActiveAt: i.lastActiveAt ?? Date.now(),
        lastPrompt: lastPrompts.get(i.id)
      }),
      ...recent.filter((r) => r.id !== i.id)
    ]
  }

  /** The screen a resumed Claude Code session comes back with. */
  const resumed = (s: FakeSession) => {
    const prompt = lastPrompts.get(s.info.id)
    out(
      s,
      [
        '',
        ` ${fg(208, '✻')} ${bold('Claude Code')} ${dim('(stub terminal) · conversation resumed')}`,
        `   ${dim('cwd:')} ${s.info.cwd}`,
        '',
        ...(prompt ? [`${PROMPT}${prompt}`, '', `${fg(42, '●')} I'll start with the schema, then move the callers over.`, `${fg(42, '●')} ${bold('Update')}(db/schema.sql)`, `  ${dim('⎿')}  Updated with ${fg(42, '14 additions')}`, `  ${dim('⎿')}  ${fg(203, 'Interrupted')} ${dim('· the session was closed')}`, ''] : []),
        ''
      ].join('\r\n') + PROMPT
    )
  }

  /** asleep / recent -> starting -> idle, with the terminal or chat the session had. */
  const bringBack = (s: FakeSession) => {
    const id = s.info.id
    s.info.state = 'starting'
    delete s.info.wakeable
    s.info.lastActiveAt = Date.now()
    sessions.set(id, s)
    emit({ agentId: id, parentId: null, provider: s.info.provider, displayName: s.info.title, activity: 'idle', detail: '' })
    if (s.info.surface === 'chat') codex.add(id, { history: true, autoplay: false })
    pushSessions()
    later(s, 1100, () => {
      if (s.info.surface !== 'chat') resumed(s)
      setState(s, 'idle')
    })
  }

  if (restoreParam !== 'none' && restoreParam !== 'old') {
    const now = Date.now()
    sleeper(
      {
        id: 'saved-claude-1',
        provider: 'claude-code',
        cwd: 'C:\\Users\\Harry\\source\\repos\\storefront',
        title: 'checkout-migration',
        model: 'opus',
        startedAt: now - 27 * HOUR,
        lastActiveAt: now - 2 * HOUR - 8 * 60_000,
        interruptedNote: {
          closedAt: now - 2 * HOUR,
          pending: [
            { question: 'checkout-migration wants to run the database migration (`npm run db:migrate`).', toolName: 'Bash', askedAt: now - 2 * HOUR - 4 * 60_000 },
            { question: 'checkout-migration wants to edit `src/checkout/payment.ts`.', toolName: 'Edit', askedAt: now - 2 * HOUR - 60_000 }
          ]
        }
      },
      'Move the checkout tables to the new schema and update every caller; run the migration when the tests pass.'
    )
    sleeper(
      { id: 'saved-claude-2', provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\scratch', title: 'scratch', startedAt: now - 26 * HOUR, lastActiveAt: now - 5 * HOUR, wakeable: false }
    )
    sleeper(
      { id: 'saved-codex-1', provider: 'codex', cwd: 'C:\\Users\\Harry\\source\\repos\\agent-office', title: 'gpt-6-luna', model: 'gpt-6-luna', startedAt: now - 25 * HOUR, lastActiveAt: now - 3 * HOUR },
      'What does the sidebar show, in one paragraph?'
    )
    selectedSaved = 'saved-claude-1'
    recent = [
      saved({ id: 'recent-1', provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\agent-office', title: 'theme-loader', model: 'sonnet', lastActiveAt: now - 3 * HOUR, lastPrompt: 'Make the theme loader report a missing tileset instead of failing silently' }),
      saved({ id: 'recent-2', provider: 'codex', cwd: 'C:\\Users\\Harry\\source\\repos\\storefront', title: 'gpt-6-luna', model: 'gpt-6-luna', lastActiveAt: now - 20 * HOUR, lastPrompt: 'Review my uncommitted changes and list anything risky before I push' }),
      saved({ id: 'recent-3', provider: 'claude-code', cwd: 'D:\\work\\api-server', title: 'rate-limits', permissionMode: 'plan', lastActiveAt: now - 3 * 24 * HOUR, lastPrompt: 'Plan how to add per-key rate limits to the public API without breaking existing clients, and say which tables change' }),
      saved({ id: 'recent-4', provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\notes', title: 'notes', providerSessionId: undefined, lastActiveAt: now - 12 * 24 * HOUR })
    ]
  }

  const restoreApi: Pick<
    AgentOfficeBridge['sessions'],
    'wake' | 'recent' | 'reopen' | 'forget' | 'dismissInterrupted' | 'getRestoreSettings' | 'setRestoreSettings' | 'setSelected' | 'getSelected'
  > = {
    wake: async (id) => {
      const s = sessions.get(id)
      if (!s) throw new Error('This session is no longer in the list')
      if (s.info.state !== 'asleep') return { ...s.info }
      await new Promise((r) => setTimeout(r, 1400))
      if (s.info.wakeable === false) throw new Error('No saved conversation to resume')
      if (failWake) {
        const msg = failWake
        failWake = null
        // The wrapper Electron puts around a rejected invoke: the shell strips it.
        throw new Error(`Error invoking remote method 'agent-office:sessions:wake': Error: ${msg}`)
      }
      if (!sessions.has(id)) throw new Error('This session is no longer in the list')
      bringBack(s)
      return { ...s.info }
    },
    recent: async () => {
      await new Promise((r) => setTimeout(r, 120))
      return [...recent].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map((r) => ({ ...r }))
    },
    reopen: async (id) => {
      await new Promise((r) => setTimeout(r, 700))
      const r = recent.find((x) => x.id === id)
      if (!r) throw new Error('This session is no longer in the Recent list')
      if (!r.providerSessionId) throw new Error('No saved conversation to resume')
      if (failReopen) {
        const msg = failReopen
        failReopen = null
        throw new Error(msg)
      }
      recent = recent.filter((x) => x.id !== id)
      if (r.lastPrompt) lastPrompts.set(id, r.lastPrompt)
      const s: FakeSession = {
        info: {
          id,
          provider: r.provider,
          cwd: r.cwd,
          title: r.title,
          state: 'starting',
          startedAt: Date.now() + ++counter,
          permissionMode: r.permissionMode,
          model: r.model,
          surface: r.provider === 'codex' ? 'chat' : 'terminal',
          canReceiveOrders: false
        },
        buffer: '',
        attached: false,
        line: '',
        workers: [],
        timers: []
      }
      bringBack(s)
      return { ...s.info }
    },
    forget: async (id) => {
      await new Promise((r) => setTimeout(r, 250))
      if (failForget) {
        const msg = failForget
        failForget = null
        throw new Error(msg)
      }
      recent = recent.filter((x) => x.id !== id)
      const s = sessions.get(id)
      if (s && (s.info.state === 'asleep' || s.info.state === 'exited')) {
        sessions.delete(id)
        pushSessions()
      }
    },
    dismissInterrupted: async (id) => {
      const s = sessions.get(id)
      if (!s?.info.interruptedNote) return
      delete s.info.interruptedNote
      pushSessions()
    },
    getRestoreSettings: async () => ({ ...restoreSettings }),
    setRestoreSettings: async (patch) => {
      if (patch.mode !== undefined && !['last', 'all', 'none'].includes(patch.mode)) throw new Error('invalid mode')
      Object.assign(restoreSettings, patch)
      return { ...restoreSettings }
    },
    setSelected: (id) => {
      selectedSaved = id
    },
    getSelected: async () => (selectedSaved && sessions.has(selectedSaved) ? selectedSaved : null)
  }

  // ---- demo scenario -----------------------------------------------------------------------
  if (mode === 'demo') {
    window.setTimeout(() => {
      const a = create({ provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\agent-office', title: 'frontend' }, 'busy')
      const b = create(
        { provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\storefront', permissionMode: 'acceptEdits', model: 'opus' },
        'idle'
      )
      // A third team in the first repository: the office board has something to coordinate.
      const d = create({ provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\agent-office', title: 'test-suite' }, 'idle')
      a.info.canReceiveOrders = b.info.canReceiveOrders = d.info.canReceiveOrders = true
      welcome(a)
      welcome(b)
      welcome(d)
      let codexId: string | undefined
      out(a, `refactor the session list into a store\r\n\r\n${fg(42, '●')} I'll split this across two subagents.\r\n`)
      emit({ agentId: a.info.id, parentId: null, displayName: a.info.title, activity: 'write', detail: 'src/ui/store.ts' })
      const w1 = addWorker(a, 'Explore', 'read', 'src/scene/roster.ts')
      addWorker(a, 'Tests', 'exec', 'npm test')
      addWorker(b, 'Docs', 'web', 'vite.dev/guide')
      if (!loggedOut) {
        // A resumed Codex session: it has an earlier exchange, and plays its scripted turn the
        // first time its chat is opened (unless ?play=0).
        const c = create({ provider: 'codex', cwd: 'C:\\Users\\Harry\\source\\repos\\agent-office', title: 'gpt-6-luna', model: 'gpt-6-luna' }, 'idle')
        c.info.canReceiveOrders = true
        codex.add(c.info.id, { history: true, autoplay: params.get('play') !== '0' })
        codexId = c.info.id
      }
      board.seed({ main: a.info.id, codex: codexId, tests: d.info.id, other: b.info.id })
      pushSessions()

      // A simulated external team the app can't answer (shows as "answer in its own terminal").
      emit({ agentId: 'ext-sim', parentId: null, provider: 'simulate', displayName: 'Sim: docs site', activity: 'write', detail: 'docs/index.md' })
      emit({ agentId: 'ext-sim:1', parentId: 'ext-sim', provider: 'simulate', displayName: 'Linker', activity: 'read', detail: 'docs/links.md' })
      window.setTimeout(
        () => emit({ agentId: 'ext-sim:1', parentId: 'ext-sim', provider: 'simulate', displayName: 'Linker', activity: 'waiting', detail: 'WebFetch: example.com' }),
        6000
      )

      later(a, 2500, () =>
        requestPermission(a, a.info.id, a.info.title, 'Bash', 'Bash: npm test -- --runInBand', JSON.stringify({ command: 'npm test -- --runInBand', description: 'Run the test suite', timeout: 120000 }, null, 2))
      )
      later(a, 4500, () =>
        requestPermission(
          a,
          w1,
          'Explore',
          'Edit',
          'Edit: src/ui/app.ts',
          JSON.stringify(
            {
              file_path: 'C:\\Users\\Harry\\source\\repos\\agent-office\\src\\ui\\app.ts',
              old_string: "const DEFAULT_LAYOUT: Layout = { panelOpen: true, dock: 'auto' }",
              new_string: "const DEFAULT_LAYOUT: Layout = { panelOpen: true, dock: 'right' }",
              replace_all: false
            },
            null,
            2
          )
        )
      )

      // ?risk=1: one request to be careful with and one dangerous one, next to the routine ones.
      if (params.get('risk') === '1') {
        later(b, 3200, () => requestPermission(b, b.info.id, b.info.title, 'Bash', 'Bash: npm install left-pad', JSON.stringify({ command: 'npm install left-pad' }, null, 2)))
        later(b, 3800, () => requestPermission(b, b.info.id, b.info.title, 'Bash', 'Bash: rm -rf dist build', JSON.stringify({ command: 'rm -rf dist build', description: 'Clean the build output' }, null, 2)))
      }

      // Keep the office moving a little.
      const acts: [Activity, string][] = [
        ['read', 'src/world/layout.ts'],
        ['write', 'src/ui/components/Sidebar.tsx'],
        ['exec', 'npx tsc --noEmit'],
        ['web', 'xtermjs.org/docs'],
        ['read', 'shared/sessions.ts']
      ]
      window.setInterval(() => {
        const live = [...sessions.values()].filter((s) => s.info.state !== 'exited' && s.workers.length > 0 && s.info.surface === 'terminal')
        const s = live[Math.floor(Math.random() * live.length)]
        if (!s) return
        const w = s.workers[Math.floor(Math.random() * s.workers.length)]
        if (pending.some((p) => p.agentId === w)) return
        const [activity, detail] = acts[Math.floor(Math.random() * acts.length)]
        emit({ agentId: w, parentId: s.info.id, displayName: w.endsWith('w1') ? (s === a ? 'Explore' : 'Docs') : 'Tests', activity, detail })
      }, 3200)
    }, 600)
  }

  const stubHandle = {
    sessions: () => [...sessions.values()].map((s) => s.info),
    pending: () => pending,
    permission: (sessionId?: string) => {
      const s = (sessionId && sessions.get(sessionId)) || [...sessions.values()].find((x) => x.info.state !== 'exited')
      if (!s) return null
      return requestPermission(s, s.info.id, s.info.title, 'Bash', 'Bash: git push origin main', JSON.stringify({ command: 'git push origin main' }, null, 2))
    },
    resolveElsewhere: (id?: string) => settle(id ?? pending[0]?.id ?? '', 'elsewhere'),
    exit,
    attention: (id: string) => {
      const s = sessions.get(id)
      if (!s) return
      out(s, `\r\n${bold('Quick safety check:')} Is this a project you created or one you trust?\r\n  ${fg(75, '❯ No, exit')}\r\n    Yes, I trust this folder\r\n`)
      setState(s, 'needs-attention')
    },
    emit,
    codex,
    codexId: () => [...sessions.values()].find((s) => s.info.surface === 'chat' && s.info.state !== 'exited')?.info.id ?? null,
    board: board.handle,
    logout: () => setCodexAccount(false),
    restore: {
      failNextWake: (message = 'The conversation could not be resumed: its saved session file no longer exists') => {
        failWake = message
      },
      failNextForget: (message = 'The saved sessions file could not be written') => {
        failForget = message
      },
      failNextReopen: (message = 'Codex is not signed in. Log in and try again.') => {
        failReopen = message
      },
      selected: () => selectedSaved,
      settings: () => ({ ...restoreSettings }),
      recent: () => recent
    }
  }
  ;(window as unknown as Record<string, unknown>).__stub = stubHandle
  // Kept from the old dev bridge: __agentOfficeEmit({ agentId: 'a', activity: 'read', ... })
  ;(window as unknown as Record<string, unknown>).__agentOfficeEmit = (e: Partial<AgentEvent> & { agentId: string; activity: Activity }) =>
    emit({ provider: 'simulate', ...e })

  return {
    onEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onSettings: (cb) => (settingsCbs.add(cb), () => settingsCbs.delete(cb)),
    getSettings: async () => ({ ...settings }),
    setAllowOrders: async (value) => {
      if (typeof value !== 'boolean') throw new Error('invalid value: expected true or false')
      settings.allowOrders = value
      settingsCbs.forEach((cb) => cb({ ...settings }))
      return { ...settings }
    },
    quit: async () => {
      document.body.innerHTML = '<p style="margin:40px;font:14px sans-serif;color:#888">Agent Office has quit (preview).</p>'
    },
    listThemes: async () => [{ name: 'office', displayName: 'Office' }],
    loadTheme: async (name) => {
      const baseUrl = `/themes/${encodeURIComponent(name)}/`
      const get = async (path: string) => {
        // Bundled themes come through the module graph, so no /themes route is needed.
        const bundled = THEME_FILES[`../../themes/${name}/${path}`]
        if (bundled) return (await bundled()).default
        const r = await fetch(baseUrl + path)
        if (!r.ok) throw new Error(`${r.status} for ${baseUrl + path}`)
        return r.json()
      }
      try {
        const manifest = await get('theme.json')
        const [hq, branch] = await Promise.all([get(manifest.hq), get(manifest.branch)])
        return { manifest, hq, branch, baseUrl }
      } catch (err) {
        throw new Error(
          `Not running inside Electron and the theme couldn't be fetched (${String(err)}). Start the app with "npm run dev".`
        )
      }
    },
    sendOrder: async (req): Promise<OrderResult> => {
      await new Promise((r) => setTimeout(r, 350))
      if (!settings.allowOrders) return { delivered: [], failed: [{ agentId: req.target, reason: REASON_DISABLED }] }
      const all = [...sessions.values()]
      const targets =
        req.target === 'all'
          ? all.filter((s) => s.info.state !== 'exited' && s.info.state !== 'asleep')
          : req.target.startsWith(PROVIDER_TARGET_PREFIX)
            ? all.filter((s) => s.info.provider === req.target.slice(PROVIDER_TARGET_PREFIX.length) && s.info.state !== 'exited' && s.info.state !== 'asleep')
            : all.filter((s) => s.info.id === req.target)
      const res: OrderResult = { delivered: [], failed: [] }
      for (const s of targets) {
        if (!s.info.canReceiveOrders) {
          res.failed.push({ agentId: s.info.id, reason: s.info.state === 'exited' ? 'session has exited' : 'busy with a permission request' })
          continue
        }
        res.delivered.push(s.info.id)
        if (s.info.surface === 'chat') {
          void codex.deliver(s.info.id, req.text, 'order')
          continue
        }
        out(s, `${req.text.replace(/\n/g, ' ')}`)
        fakeTurn(s, req.text)
      }
      if (req.target === 'all' || req.target === `${PROVIDER_TARGET_PREFIX}simulate`) {
        res.failed.push({ agentId: 'ext-sim', reason: 'not hosted by Agent Office' })
      } else if (targets.length === 0) {
        res.failed.push({ agentId: req.target, reason: sessions.size === 0 ? REASON_NO_SESSIONS : 'not hosted by Agent Office' })
      }
      if (mode === 'empty' && req.target === 'all' && res.delivered.length === 0) {
        return { delivered: [], failed: [{ agentId: 'all', reason: REASON_NO_SESSIONS }] }
      }
      return res
    },

    sessions: {
      providers: async () => PROVIDERS,
      onProvidersChanged: (cb) => (providerCbs.add(cb), () => providerCbs.delete(cb)),
      login: async (provider) => {
        await new Promise((r) => setTimeout(r, 250))
        if (provider !== 'codex') throw new Error('This provider has no sign-in of its own')
        // The real flow opens the system browser; here it just succeeds after a moment.
        window.setTimeout(() => setCodexAccount(true), 3500)
      },
      list: async () => [...sessions.values()].map((s) => ({ ...s.info })),
      start: async (req) => {
        await new Promise((r) => setTimeout(r, 300))
        const p = PROVIDERS.find((x) => x.id === req.provider)
        if (!p?.available) throw new Error(`${p?.label ?? req.provider} is not available: ${p?.reason ?? 'unknown provider'}`)
        if (p.account?.loggedIn === false) throw new Error(`${p.label} is not signed in. Log in first.`)
        if (!req.cwd.trim()) throw new Error('Pick a folder first')
        if (/missing|nope/i.test(req.cwd)) throw new Error(`Folder not found: ${req.cwd}`)
        const s = create(req.provider === 'codex' && !req.title?.trim() ? { ...req, title: req.model?.trim() || 'gpt-6-luna', model: req.model?.trim() || 'gpt-6-luna' } : req)
        if (s.info.surface === 'chat') codex.add(s.info.id, req.resume ? { history: true, autoplay: false } : undefined)
        pushSessions()
        // Only the terminal stub has a folder-trust question.
        const untrusted = s.info.surface === 'terminal' && /untrusted/i.test(req.cwd)
        later(s, 900, () => {
          if (untrusted) stubHandle.attention(s.info.id)
          else if (s.info.surface === 'chat') setState(s, 'idle')
          else {
            setState(s, 'idle')
            welcome(s)
          }
        })
        return { ...s.info }
      },
      stop: async (id) => {
        const s = sessions.get(id)
        // No process behind it: the row leaves the list and its record moves to Recent.
        if (s && (s.info.state === 'asleep' || s.info.state === 'exited')) {
          await new Promise((r) => setTimeout(r, 150))
          sessions.delete(id)
          if (restoreParam !== 'old') toRecent(s)
          pushSessions()
          return
        }
        window.setTimeout(() => exit(id, 0), 400)
      },
      interrupt: async (id) => {
        const s = sessions.get(id)
        if (!s || s.info.state === 'exited' || s.info.state === 'asleep') return
        if (s.info.surface === 'chat') return codex.interrupt(id)
        s.timers.forEach((t) => window.clearTimeout(t))
        s.timers = []
        for (const p of pending.filter((x) => x.sessionId === id)) settle(p.id, 'elsewhere')
        out(s, `\r\n  ${dim('⎿')}  ${fg(203, 'Interrupted')} ${dim('· What should Claude do instead?')}\r\n\r\n${PROMPT}`)
        emit({ agentId: id, parentId: null, displayName: s.info.title, activity: 'idle', detail: '' })
        setState(s, 'idle')
      },
      pickFolder: async () => {
        const samples = ['C:\\Users\\Harry\\source\\repos\\new-project', 'C:\\Users\\Harry\\source\\repos\\untrusted-demo', 'D:\\work\\api-server']
        return samples[counter % samples.length]
      },
      history: async (provider, cwd) => {
        await new Promise((r) => setTimeout(r, 350))
        if (provider !== 'codex' || /empty|new-project/i.test(cwd)) return []
        if (/broken/i.test(cwd)) throw new Error('Codex could not list the earlier conversations: the Codex app-server is not running')
        const now = Date.now()
        return [
          { id: 'thr-old', preview: 'Create a file hello.txt containing the word hi', updatedAt: now - 12 * 60_000, model: 'gpt-6-luna' },
          { id: 'thr-older', preview: 'Explain how this project is put together, then list the three riskiest modules and say why each one is risky', updatedAt: now - 26 * 3_600_000, model: 'gpt-6.1-sol' },
          { id: 'thr-oldest', preview: '', updatedAt: now - 40 * 86_400_000 }
        ]
      },
      onChanged: (cb) => (sessionCbs.add(cb), () => sessionCbs.delete(cb)),
      // ?restore=old: a main process from before sessions were saved.
      ...(restoreParam === 'old' ? ({} as typeof restoreApi) : restoreApi)
    },

    terminal: {
      attach: async (id) => {
        const s = sessions.get(id)
        if (!s) throw new Error('unknown session')
        if (s.info.state === 'asleep') throw new Error('this session is asleep: it has no terminal until it is woken')
        if (s.info.surface === 'chat') throw new Error('this session has no terminal')
        s.attached = true
        return { data: s.buffer, cols: 80, rows: 24 }
      },
      detach: (id) => {
        const s = sessions.get(id)
        if (s) s.attached = false
      },
      write: (id, data) => {
        const s = sessions.get(id)
        if (s && s.info.state !== 'asleep') input(s, data)
      },
      resize: () => undefined,
      ack: () => undefined,
      onData: (cb) => (dataCbs.add(cb), () => dataCbs.delete(cb))
    },

    chat: codex.chat,

    // ?board=none: a main process from before the office board.
    board: params.get('board') === 'none' ? (undefined as unknown as AgentOfficeBridge['board']) : board.bridge,

    permissions: {
      list: async () => [...pending],
      decide: async (id, decision) => {
        await new Promise((r) => setTimeout(r, 150))
        return settle(id, decision.behavior === 'allow' ? 'allowed' : 'denied', decision.behavior === 'deny' ? decision.message : undefined)
      },
      onChanged: (cb) => (permCbs.add(cb), () => permCbs.delete(cb))
    }
  }
}
