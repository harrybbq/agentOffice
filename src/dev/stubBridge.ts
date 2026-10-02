// DEV / PREVIEW ONLY. A fake `window.agentOffice` for running the renderer in a plain browser
// (Vite dev URL or a static build) so the shell can be developed and screenshotted without
// Electron. Nothing here talks to a real agent. It is loaded only when the real bridge is missing
// (see src/main.tsx) and is code-split out of the main bundle.
//
// URL parameters: ?stub=demo (default: two sessions, permission requests, a simulated external
// team) | ?stub=empty (nothing running) · ?orders=off · ?overlay=1
// Console handle: window.__stub (permission(), exit(id, code), attention(id), resolveElsewhere(id)).
import { parseAgentEvent } from '../../shared/events'
import type { Activity, AgentEvent } from '../../shared/events'
import type { AgentOfficeBridge, RendererSettings } from '../../shared/ipc'
import { PROVIDER_TARGET_PREFIX, REASON_DISABLED, REASON_NO_SESSIONS } from '../../shared/orders'
import type { OrderResult } from '../../shared/orders'
import type {
  PermissionOutcome,
  PermissionRequestInfo,
  ProviderInfo,
  SessionInfo,
  SessionState,
  StartSessionRequest
} from '../../shared/sessions'
import { subagentId } from '../../shared/sessions'

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

const PROVIDERS: ProviderInfo[] = [
  { id: 'claude-code', label: 'Claude Code', available: true, version: '2.1.284 (stub)' },
  { id: 'codex', label: 'Codex', available: false, reason: 'Driver coming in phase B' },
  { id: 'antigravity', label: 'Antigravity', available: false, reason: 'Not installed' }
]

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

  const eventCbs = new Set<(e: AgentEvent) => void>()
  const sessionCbs = new Set<(s: SessionInfo[]) => void>()
  const permCbs = new Set<(p: PermissionRequestInfo[]) => void>()
  const dataCbs = new Set<(id: string, data: string) => void>()
  const sessions = new Map<string, FakeSession>()
  let pending: PermissionRequestInfo[] = []
  let counter = 0

  const emit = (input: Partial<AgentEvent> & { agentId: string; activity: Activity }) => {
    const e = parseAgentEvent({ provider: 'claude-code', ts: Date.now(), ...input })
    if (e) eventCbs.forEach((cb) => cb(e))
  }
  const pushSessions = () => {
    const list = [...sessions.values()].map((s) => ({ ...s.info }))
    sessionCbs.forEach((cb) => cb(list))
  }
  const pushPerms = () => {
    const list = [...pending]
    permCbs.forEach((cb) => cb(list))
  }
  const setState = (s: FakeSession, state: SessionState) => {
    if (s.info.state === 'exited') return
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
        canReceiveOrders: false
      },
      buffer: '',
      attached: false,
      line: '',
      workers: [],
      timers: []
    }
    sessions.set(id, s)
    emit({ agentId: id, parentId: null, displayName: s.info.title, activity: 'idle', detail: '' })
    return s
  }

  const addWorker = (s: FakeSession, name: string, activity: Activity, detail: string): string => {
    const id = subagentId(s.info.id, `w${s.workers.length + 1}`)
    s.workers.push(id)
    emit({ agentId: id, parentId: s.info.id, displayName: name, activity, detail })
    return id
  }

  const requestPermission = (s: FakeSession, agentId: string, displayName: string, tool: string, summary: string, detail: string) => {
    const req: PermissionRequestInfo = {
      id: `perm-${++counter}`,
      sessionId: s.info.id,
      agentId,
      displayName,
      provider: s.info.provider,
      toolName: tool,
      summary,
      detail,
      createdAt: Date.now()
    }
    pending = [...pending, req]
    emit({ agentId, parentId: agentId === s.info.id ? null : s.info.id, displayName, activity: 'waiting', detail: summary })
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
        displayName: req.displayName,
        activity: how === 'denied' ? 'idle' : 'exec',
        detail: req.summary
      })
      if (!pending.some((p) => p.sessionId === s.info.id)) setState(s, 'busy')
    }
    pushPerms()
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
    emit({ agentId: id, parentId: null, displayName: s.info.title, activity: 'done', detail: '' })
    pushSessions()
  }

  // ---- demo scenario -----------------------------------------------------------------------
  if (mode === 'demo') {
    window.setTimeout(() => {
      const a = create({ provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\agent-office', title: 'agent-office' }, 'busy')
      const b = create(
        { provider: 'claude-code', cwd: 'C:\\Users\\Harry\\source\\repos\\storefront', permissionMode: 'acceptEdits', model: 'opus' },
        'idle'
      )
      a.info.canReceiveOrders = b.info.canReceiveOrders = true
      welcome(a)
      welcome(b)
      out(a, `refactor the session list into a store\r\n\r\n${fg(42, '●')} I'll split this across two subagents.\r\n`)
      emit({ agentId: a.info.id, parentId: null, displayName: 'agent-office', activity: 'write', detail: 'src/ui/store.ts' })
      const w1 = addWorker(a, 'Explore', 'read', 'src/scene/roster.ts')
      addWorker(a, 'Tests', 'exec', 'npm test')
      addWorker(b, 'Docs', 'web', 'vite.dev/guide')
      pushSessions()

      // A simulated external team the app can't answer (shows as "answer in its own terminal").
      emit({ agentId: 'ext-sim', parentId: null, provider: 'simulate', displayName: 'Sim: docs site', activity: 'write', detail: 'docs/index.md' })
      emit({ agentId: 'ext-sim:1', parentId: 'ext-sim', provider: 'simulate', displayName: 'Linker', activity: 'read', detail: 'docs/links.md' })
      window.setTimeout(
        () => emit({ agentId: 'ext-sim:1', parentId: 'ext-sim', provider: 'simulate', displayName: 'Linker', activity: 'waiting', detail: 'WebFetch: example.com' }),
        6000
      )

      later(a, 2500, () =>
        requestPermission(a, a.info.id, 'agent-office', 'Bash', 'Bash: npm test -- --runInBand', JSON.stringify({ command: 'npm test -- --runInBand', description: 'Run the test suite', timeout: 120000 }, null, 2))
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

      // Keep the office moving a little.
      const acts: [Activity, string][] = [
        ['read', 'src/world/layout.ts'],
        ['write', 'src/ui/components/Sidebar.tsx'],
        ['exec', 'npx tsc --noEmit'],
        ['web', 'xtermjs.org/docs'],
        ['read', 'shared/sessions.ts']
      ]
      window.setInterval(() => {
        const live = [...sessions.values()].filter((s) => s.info.state !== 'exited' && s.workers.length > 0)
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
    emit
  }
  ;(window as unknown as Record<string, unknown>).__stub = stubHandle
  // Kept from the old dev bridge: __agentOfficeEmit({ agentId: 'a', activity: 'read', ... })
  ;(window as unknown as Record<string, unknown>).__agentOfficeEmit = (e: Partial<AgentEvent> & { agentId: string; activity: Activity }) =>
    emit({ provider: 'simulate', ...e })

  return {
    onEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onSettings: () => () => undefined,
    getSettings: async () => settings,
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
          ? all.filter((s) => s.info.state !== 'exited')
          : req.target.startsWith(PROVIDER_TARGET_PREFIX)
            ? all.filter((s) => s.info.provider === req.target.slice(PROVIDER_TARGET_PREFIX.length) && s.info.state !== 'exited')
            : all.filter((s) => s.info.id === req.target)
      const res: OrderResult = { delivered: [], failed: [] }
      for (const s of targets) {
        if (!s.info.canReceiveOrders) {
          res.failed.push({ agentId: s.info.id, reason: s.info.state === 'exited' ? 'session has exited' : 'busy with a permission request' })
          continue
        }
        res.delivered.push(s.info.id)
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
      list: async () => [...sessions.values()].map((s) => ({ ...s.info })),
      start: async (req) => {
        await new Promise((r) => setTimeout(r, 300))
        const p = PROVIDERS.find((x) => x.id === req.provider)
        if (!p?.available) throw new Error(`${p?.label ?? req.provider} is not available: ${p?.reason ?? 'unknown provider'}`)
        if (!req.cwd.trim()) throw new Error('Pick a folder first')
        if (/missing|nope/i.test(req.cwd)) throw new Error(`Folder not found: ${req.cwd}`)
        const s = create(req)
        pushSessions()
        const untrusted = /untrusted/i.test(req.cwd)
        later(s, 900, () => {
          if (untrusted) stubHandle.attention(s.info.id)
          else {
            setState(s, 'idle')
            welcome(s)
          }
        })
        return { ...s.info }
      },
      stop: async (id) => {
        window.setTimeout(() => exit(id, 0), 400)
      },
      interrupt: async (id) => {
        const s = sessions.get(id)
        if (!s || s.info.state === 'exited') return
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
      onChanged: (cb) => (sessionCbs.add(cb), () => sessionCbs.delete(cb))
    },

    terminal: {
      attach: async (id) => {
        const s = sessions.get(id)
        if (!s) throw new Error('unknown session')
        s.attached = true
        return { data: s.buffer, cols: 80, rows: 24 }
      },
      detach: (id) => {
        const s = sessions.get(id)
        if (s) s.attached = false
      },
      write: (id, data) => {
        const s = sessions.get(id)
        if (s) input(s, data)
      },
      resize: () => undefined,
      ack: () => undefined,
      onData: (cb) => (dataCbs.add(cb), () => dataCbs.delete(cb))
    },

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
