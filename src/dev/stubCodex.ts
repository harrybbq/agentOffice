// DEV / PREVIEW ONLY. The fake Codex side of the stub bridge (src/dev/stubBridge.ts): chat sessions
// that play a scripted turn with the event shapes and timings the real Codex app-server showed in
// docs/spikes-phase-b.md (token deltas ~20 ms apart, a commentary message before tool calls, command
// output in chunks, an approval that blocks the turn, a file change with a diff, a web search that
// only gets its query when it completes, a final Markdown answer). Nothing here talks to an agent.
import type { ChatEvent, ChatItem } from '../../shared/chat'
import type { AgentOfficeBridge } from '../../shared/ipc'
import type { Activity } from '../../shared/events'
import type { SessionInfo, SessionState } from '../../shared/sessions'
import { applyEvents, EMPTY_CHAT } from '../ui/chat/state'
import type { ChatState } from '../ui/chat/state'

export interface CodexHost {
  info(id: string): SessionInfo | undefined
  setState(id: string, state: SessionState): void
  /** A world event for the session's manager. */
  activity(id: string, activity: Activity, detail: string): void
  /** Adds a request to the CEO inbox; resolves through `settled`. Returns the request id. */
  requestPermission(id: string, tool: string, summary: string, detail: string): string
  /** Removes pending requests of a session (interrupt, exit). */
  dropPermissions(id: string): void
}

type Origin = Extract<ChatItem, { kind: 'user' }>['origin']
type How = 'allowed' | 'denied' | 'elsewhere'

interface Chat {
  state: ChatState
  attached: boolean
  /** Bumped to cancel the running script. */
  run: number
  turnId: string | null
  steers: { text: string; origin: Origin }[]
  history: boolean
  autoplay: boolean
}

const CANCELLED = Symbol('cancelled')
const E = '\x1b'

const DIFF_FORMAT = `--- a/src/ui/format.ts
+++ b/src/ui/format.ts
@@ -92,9 +92,14 @@ export interface ProviderGroup {
   sessions: SessionInfo[]
 }

-/** Sidebar groups: every known provider (even unavailable ones), sessions in start order. */
+/**
+ * Sidebar groups: every known provider (even unavailable ones). Within a group the session that
+ * was active most recently comes first; sessions that never did anything keep their start order.
+ */
 export function groupSessions(providers: readonly ProviderInfo[], sessions: readonly SessionInfo[]): ProviderGroup[] {
   const groups: ProviderGroup[] = providers.map((p) => ({ provider: p, sessions: [] }))
-  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt)
+  const sorted = [...sessions].sort(byRecentActivity)
   for (const s of sorted) {
     let g = groups.find((x) => x.provider.id === s.provider)
     if (!g) {
@@ -108,3 +113,10 @@ export function groupSessions(providers: readonly ProviderInfo[], sessions: read
   }
   return groups
 }
+
+/** Most recent activity first; ties (and sessions without activity) fall back to start order. */
+export function byRecentActivity(a: SessionInfo, b: SessionInfo): number {
+  const recent = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
+  return recent !== 0 ? recent : a.startedAt - b.startedAt
+}`

const NEW_TEST = `import assert from 'node:assert/strict'
import { byRecentActivity } from '../src/ui/format.ts'

const s = (id: string, startedAt: number, lastActiveAt?: number) => ({ id, startedAt, lastActiveAt })

// The session that spoke last is listed first.
assert.deepEqual(
  [s('a', 1, 10), s('b', 2, 30), s('c', 3)].sort(byRecentActivity as never).map((x) => x.id),
  ['b', 'a', 'c']
)
// Without any activity the start order is kept.
assert.deepEqual(
  [s('b', 2), s('a', 1)].sort(byRecentActivity as never).map((x) => x.id),
  ['a', 'b']
)
console.log('ok - sessions sort by recent activity')
`

const TEST_OUTPUT = [
  `\r\n> agent-office@0.1.0 test\r\n> tsx tests/roster.test.ts\r\n\r\n`,
  `${E}[32mok${E}[0m - roster keeps one desk per agent\r\n${E}[32mok${E}[0m - a worker walks to the nearest free station\r\n${E}[32mok${E}[0m - the queue compacts when an agent leaves\r\n`,
  `${E}[32mok${E}[0m - corridors connect every branch to the HQ\r\n${E}[32mok${E}[0m - pathfinding avoids occupied tiles\r\n`,
  `${E}[32mok${E}[0m - hooks map to activities ${E}[2m(41 cases)${E}[0m\r\n${E}[32mok${E}[0m - hosted sessions: start, stop, interrupt\r\n${E}[32mok${E}[0m - permission requests time out\r\n`,
  `${E}[32mok${E}[0m - ui: groups, order targets, log filters\r\n${E}[32mok${E}[0m - chat: reducer, markdown, diff, ansi\r\n${E}[32mok${E}[0m - ${E}[1msessions sort by recent activity${E}[0m\r\n`,
  `\r\n${E}[1m${E}[32m212 tests passed${E}[0m ${E}[2m(3.4 s)${E}[0m\r\n`
]

const FINAL_ANSWER = (steers: string[]) => `## Sessions now sort by recent activity

The sidebar lists the session that was active most recently first. Sessions that have not done anything yet keep their start order, so a freshly started one doesn't jump around.

### What changed

- **\`src/ui/format.ts\`**: \`groupSessions\` sorts with the new \`byRecentActivity\` comparator.
- **\`tests/recent.test.ts\`**: two cases, one for the new order and one for the fallback.
- No change to \`Ctrl+1…9\`: the shortcuts follow whatever the sidebar shows.

\`\`\`ts
export function byRecentActivity(a: SessionInfo, b: SessionInfo): number {
  const recent = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
  return recent !== 0 ? recent : a.startedAt - b.startedAt
}
\`\`\`

### Checks

| Check | Result | Time |
| :--- | :--- | ---: |
| \`npm test\` | 212 passed | 3.4 s |
| \`npx tsc --noEmit\` | clean | 6.1 s |
| New cases | 2 added | |

One thing to decide: \`lastActiveAt\` is read from \`SessionInfo\`, which the main process does not fill in yet. Until it does, the order is the same as before. The sorting approach follows the [Array.prototype.sort notes on MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort).${
  steers.length > 0 ? `\n\n> You added mid-turn: “${steers.join('”, “')}”. Done as part of this change.` : ''
}`

export function createCodexStub(host: CodexHost, opts: { speed: number }) {
  const cbs = new Set<(e: ChatEvent) => void>()
  const chats = new Map<string, Chat>()
  const waiters = new Map<string, (how: How) => void>()
  let seq = 0
  let failNext: string | null = null
  const settings = { speed: opts.speed }

  const send = (id: string, ev: ChatEvent) => {
    const c = chats.get(id)
    if (!c) return
    c.state = applyEvents(c.state, id, [ev])
    if (c.attached) cbs.forEach((cb) => cb(ev))
  }
  const base = (id: string, c: Chat, itemId = `item-${++seq}`) => ({ id: itemId, sessionId: id, agentId: id, ts: Date.now(), ...(c.turnId ? { turnId: c.turnId } : {}) })
  const put = (id: string, item: ChatItem) => send(id, { type: 'item', item })
  const patch = <K extends ChatItem['kind']>(id: string, itemId: string, over: Partial<Extract<ChatItem, { kind: K }>>) => {
    const cur = chats.get(id)?.state.items[itemId]
    if (cur) put(id, { ...cur, ...over } as ChatItem)
  }

  /** Runs `script`; a newer run (interrupt, exit) cancels it at its next wait. */
  const play = (id: string, script: (wait: (ms: number) => Promise<void>, c: Chat) => Promise<void>) => {
    const c = chats.get(id)
    if (!c) return
    const run = ++c.run
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        window.setTimeout(() => (c.run === run && host.info(id)?.state !== 'exited' ? resolve() : reject(CANCELLED)), ms * settings.speed)
      })
    script(wait, c).catch((err: unknown) => {
      if (err !== CANCELLED) console.error('[stub] codex script failed', err)
    })
  }

  /** An assistant message, token by token (about 20 ms apart, like the real thing). */
  const say = async (id: string, c: Chat, wait: (ms: number) => Promise<void>, text: string, phase: 'commentary' | 'final') => {
    const item: ChatItem = { ...base(id, c, `msg_${++seq}`), kind: 'assistant', text: '', streaming: true, phase }
    put(id, item)
    await wait(120)
    for (const token of text.match(/\s*\S+|\s+$/g) ?? []) {
      send(id, { type: 'delta', sessionId: id, itemId: item.id, field: 'text', delta: token })
      await wait(token.includes('\n') ? 34 : 18)
    }
    put(id, { ...item, text, streaming: false })
  }

  /** A steer becomes a second user item of the same turn once the running step has finished. */
  const absorbSteers = (id: string, c: Chat, seen: string[]) => {
    for (const s of c.steers.splice(0)) {
      put(id, { ...base(id, c), kind: 'user', text: s.text, origin: s.origin === 'order' ? 'order' : 'steer' })
      seen.push(s.text)
    }
  }

  const turn = (id: string, prompt: string, origin: Origin) =>
    play(id, async (wait, c) => {
      const info = host.info(id)
      const cwd = info?.cwd ?? ''
      const steered: string[] = []
      c.turnId = `turn-${++seq}`
      const turnId = c.turnId
      host.setState(id, 'busy')
      host.activity(id, 'read', 'src/ui/format.ts')
      send(id, { type: 'turn', sessionId: id, turnId, status: 'started' })
      put(id, { ...base(id, c), kind: 'user', text: prompt, origin })
      await wait(500)

      const think: ChatItem = { ...base(id, c, `rs_${++seq}`), kind: 'reasoning', summary: [], streaming: true }
      put(id, think)
      for (const token of '**Finding the sort** The sidebar order comes from one helper, so the change is small. I should run the tests before and after.'.match(/\s*\S+/g) ?? []) {
        send(id, { type: 'delta', sessionId: id, itemId: think.id, field: 'summary', index: 0, delta: token })
        await wait(16)
      }
      patch<'reasoning'>(id, think.id, { streaming: false })

      await say(id, c, wait, "I'll find where the session list is ordered, change the sort, and run the tests.", 'commentary')

      const plan: ChatItem = {
        ...base(id, c, `plan-${turnId}`),
        kind: 'plan',
        explanation: 'Small change in one helper, then a test for it.',
        steps: [
          { text: 'Find where the sidebar orders sessions', status: 'in-progress' },
          { text: 'Sort by most recent activity', status: 'pending' },
          { text: 'Add a test and run the suite', status: 'pending' }
        ]
      }
      put(id, plan)
      await wait(300)

      // A quick read-only command: output arrives in one chunk.
      const rg: ChatItem = { ...base(id, c, `exec-${++seq}`), kind: 'command', command: 'rg -n "sort\\(" src/ui/format.ts', cwd, intent: 'search', output: '', outputTruncated: false, exitCode: null, status: 'running' }
      put(id, rg)
      await wait(450)
      send(id, { type: 'delta', sessionId: id, itemId: rg.id, field: 'output', delta: '95:  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt)\r\n' })
      await wait(120)
      patch<'command'>(id, rg.id, { output: '95:  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt)\r\n', exitCode: 0, durationMs: 412, status: 'done' })
      absorbSteers(id, c, steered)
      put(id, { ...plan, steps: [{ ...plan.steps[0], status: 'completed' }, { ...plan.steps[1], status: 'in-progress' }, plan.steps[2]] })

      await say(id, c, wait, 'Found it: `groupSessions` in `src/ui/format.ts`. I need to edit that file and add a test.', 'commentary')

      // The edit needs approval: the turn blocks until the CEO answers (here or in the inbox).
      const changes: Extract<ChatItem, { kind: 'file-change' }>['changes'] = [
        { path: 'src/ui/format.ts', change: 'update', diff: DIFF_FORMAT },
        { path: 'tests/recent.test.ts', change: 'add', diff: NEW_TEST }
      ]
      const fc: ChatItem = { ...base(id, c, `exec-${++seq}`), kind: 'file-change', changes, status: 'running' }
      put(id, fc)
      host.activity(id, 'waiting', 'Edit: src/ui/format.ts')
      const summary = 'Edit: src/ui/format.ts, tests/recent.test.ts'
      const detail = JSON.stringify({ files: changes.map((x) => ({ path: x.path, change: x.change })), reason: 'Sort sessions by recent activity' }, null, 2)
      const requestId = host.requestPermission(id, 'Edit', summary, detail)
      const approval: ChatItem = { ...base(id, c, `approval-${requestId}`), kind: 'approval', requestId, subjectId: fc.id, summary, detail, outcome: 'pending' }
      put(id, approval)
      const how = await new Promise<How>((resolve) => waiters.set(requestId, resolve))
      waiters.delete(requestId)
      if (c.run === 0 || c.turnId !== turnId) throw CANCELLED
      patch<'approval'>(id, approval.id, { outcome: how === 'elsewhere' ? 'resolved-elsewhere' : how })
      host.setState(id, 'busy')

      if (how === 'denied') {
        patch<'file-change'>(id, fc.id, { status: 'declined' })
        put(id, { ...plan, steps: [{ ...plan.steps[0], status: 'completed' }, plan.steps[1], plan.steps[2]] })
        await wait(400)
        absorbSteers(id, c, steered)
        await say(id, c, wait, "Understood, I won't change the files. The sort lives in `groupSessions` (`src/ui/format.ts`, line 95) if you want to make the change yourself.", 'final')
      } else {
        host.activity(id, 'write', 'src/ui/format.ts')
        await wait(500)
        patch<'file-change'>(id, fc.id, { status: 'done' })
        put(id, { ...plan, steps: [{ ...plan.steps[0], status: 'completed' }, { ...plan.steps[1], status: 'completed' }, { ...plan.steps[2], status: 'in-progress' }] })
        absorbSteers(id, c, steered)

        // The test run: output streams in chunks (not lines), with colours and "\r\n" line ends.
        host.activity(id, 'exec', 'npm test')
        const test: ChatItem = { ...base(id, c, `exec-${++seq}`), kind: 'command', command: 'npm test', cwd, intent: 'exec', output: '', outputTruncated: false, exitCode: null, status: 'running' }
        put(id, test)
        for (const chunk of TEST_OUTPUT) {
          await wait(520)
          send(id, { type: 'delta', sessionId: id, itemId: test.id, field: 'output', delta: chunk })
        }
        await wait(250)
        patch<'command'>(id, test.id, { output: TEST_OUTPUT.join(''), exitCode: 0, durationMs: 3412, status: 'done' })
        absorbSteers(id, c, steered)

        // A web search arrives empty and gets its query only when it completes.
        host.activity(id, 'web', 'developer.mozilla.org')
        const web: ChatItem = { ...base(id, c, `exec-${++seq}`), kind: 'web', action: 'search', status: 'running' }
        put(id, web)
        await wait(1600)
        patch<'web'>(id, web.id, { query: 'Array.prototype.sort stable comparator', status: 'done' })
        put(id, { ...plan, steps: plan.steps.map((s) => ({ ...s, status: 'completed' as const })) })
        absorbSteers(id, c, steered)
        await wait(300)
        await say(id, c, wait, FINAL_ANSWER(steered), 'final')
      }

      send(id, { type: 'turn', sessionId: id, turnId, status: 'completed' })
      c.turnId = null
      host.activity(id, 'idle', '')
      host.setState(id, 'idle')
      // Anything sent in the very last moment starts the next turn.
      const late = c.steers.shift()
      if (late) turn(id, late.text, late.origin)
    })

  const interrupt = (id: string) => {
    const c = chats.get(id)
    if (!c || !c.turnId) return
    const turnId = c.turnId
    c.run++
    c.turnId = null
    c.steers = []
    host.dropPermissions(id)
    // No item/completed arrives for what was running: the turn event closes the open items.
    send(id, { type: 'turn', sessionId: id, turnId, status: 'interrupted' })
    put(id, { id: `item-${++seq}`, sessionId: id, agentId: id, turnId, ts: Date.now(), kind: 'notice', level: 'info', text: 'Turn interrupted' })
    host.activity(id, 'idle', '')
    host.setState(id, 'idle')
  }

  const deliver = async (id: string, text: string, origin: Origin): Promise<void> => {
    const c = chats.get(id)
    const info = host.info(id)
    if (!c || !info) throw new Error('unknown session')
    if (info.state === 'exited') throw new Error('The session has ended')
    if (failNext) {
      const msg = failNext
      failNext = null
      throw new Error(msg)
    }
    if (c.turnId) c.steers.push({ text, origin })
    else turn(id, text, origin)
  }

  const chat: AgentOfficeBridge['chat'] = {
    attach: async (id) => {
      const c = chats.get(id)
      if (!c) throw new Error('unknown session')
      // A resumed session reads its history from disk first.
      await new Promise((r) => setTimeout(r, c.history ? 700 * settings.speed : 60))
      c.attached = true
      const items = c.state.order.map((x) => c.state.items[x])
      if (c.autoplay) {
        c.autoplay = false
        window.setTimeout(() => {
          if (!c.turnId && host.info(id)?.state === 'idle') turn(id, 'Sort the session list by most recent activity, and make sure the tests still pass.', 'human')
        }, 900 * settings.speed)
      }
      return items
    },
    detach: (id) => {
      const c = chats.get(id)
      if (c) c.attached = false
    },
    send: async (id, text) => {
      await new Promise((r) => setTimeout(r, 180))
      await deliver(id, text, 'human')
    },
    onEvent: (cb) => (cbs.add(cb), () => cbs.delete(cb))
  }

  return {
    chat,
    settings,
    has: (id: string) => chats.has(id),
    /** Registers a chat session. `history`: it was resumed and has an earlier exchange. */
    add: (id: string, o: { history?: boolean; autoplay?: boolean } = {}) => {
      const c: Chat = { state: { ...EMPTY_CHAT, status: 'ready' }, attached: false, run: 1, turnId: null, steers: [], history: !!o.history, autoplay: !!o.autoplay }
      chats.set(id, c)
      if (o.history) {
        const ts = Date.now() - 42 * 60_000
        const old = { sessionId: id, agentId: id, turnId: 'turn-0' }
        c.state = applyEvents(c.state, id, [
          { type: 'item', item: { ...old, id: 'h1', ts, kind: 'user', text: 'What does the sidebar show, in one paragraph?', origin: 'human' } },
          {
            type: 'item',
            item: {
              ...old,
              id: 'h2',
              ts: ts + 4000,
              kind: 'command',
              command: 'Get-Content src/ui/components/Sidebar.tsx',
              cwd: host.info(id)?.cwd,
              intent: 'read',
              output: Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(3)}  // …`).join('\n'),
              outputTruncated: false,
              exitCode: 0,
              durationMs: 96,
              status: 'done'
            }
          },
          {
            type: 'item',
            item: {
              ...old,
              id: 'h3',
              ts: ts + 9000,
              kind: 'assistant',
              phase: 'final',
              streaming: false,
              text: 'The sidebar lists the sessions the app hosts, **grouped by provider** and in the order they were started, followed by an *Observed* group for agents that run outside the app. Each row shows the team colour, the title, the folder and a state dot; `Ctrl+1…9` selects them in that order.'
            }
          },
          { type: 'turn', sessionId: id, turnId: 'turn-0', status: 'completed' }
        ])
      }
    },
    play: (id: string, prompt = 'Sort the session list by most recent activity, and make sure the tests still pass.') => {
      if (!chats.get(id)?.turnId) turn(id, prompt, 'human')
    },
    deliver,
    interrupt,
    busy: (id: string) => !!chats.get(id)?.turnId,
    /** A permission request of a chat session was answered. */
    settled: (requestId: string, how: How) => waiters.get(requestId)?.(how),
    exited: (id: string) => {
      const c = chats.get(id)
      if (!c) return
      const turnId = c.turnId
      c.run++
      c.turnId = null
      if (turnId) send(id, { type: 'turn', sessionId: id, turnId, status: 'interrupted' })
    },
    remove: (id: string) => chats.delete(id),
    failNextSend: (message = 'Codex is not signed in. Log in and try again.') => {
      failNext = message
    },
    /** Replaces the list with one of every item kind and status (renderer check) and sends a `reset`. */
    gallery: (id: string) => {
      const c = chats.get(id)
      if (!c) return
      let n = 0
      const t0 = Date.now() - 20 * 60_000
      const b = (turnId: string) => ({ id: `g-${++n}`, sessionId: id, agentId: id, turnId, ts: t0 + n * 20_000 })
      const cmd = (turnId: string, command: string, over: Partial<Extract<ChatItem, { kind: 'command' }>>): ChatItem => ({
        ...b(turnId),
        kind: 'command',
        command,
        cwd: host.info(id)?.cwd,
        intent: 'exec',
        output: '',
        outputTruncated: false,
        exitCode: 0,
        durationMs: 1200,
        status: 'done',
        ...over
      })
      const items: ChatItem[] = [
        { ...b('g1'), kind: 'user', text: 'Reconnect the build, then tell everyone what changed.', origin: 'order' },
        { ...b('g1'), kind: 'user', text: 'Task notification: the nightly build finished with 2 warnings.', origin: 'system' },
        { ...b('g1'), kind: 'reasoning', summary: ['**Checking the build** The warnings come from the bundler config.', '**Plan** Fix the config, then rerun.'], text: 'raw reasoning text, when the provider exposes it', streaming: false },
        { ...b('g1'), kind: 'assistant', phase: 'commentary', streaming: false, text: 'I will look at the files first.' },
        cmd('g1', 'Get-Content electron.vite.config.ts', { intent: 'read', output: 'export default defineConfig({ /* … */ })\n', durationMs: 84 }),
        cmd('g1', 'Get-ChildItem src -Recurse -Filter *.tsx', { intent: 'list', output: Array.from({ length: 30 }, (_, i) => `src/ui/components/File${i}.tsx`).join('\n'), durationMs: 140 }),
        cmd('g1', 'npx tsc --noEmit -p tsconfig.json', {
          output: `src/ui/a.ts(12,7): ${E}[31merror${E}[0m TS2741: Property 'surface' is missing in type '{ id: string }'.\r\n${E}[33mwarning${E}[0m: 1 file skipped\r\nFound 1 error.\r\n`,
          exitCode: 2,
          durationMs: 6100,
          status: 'failed'
        }),
        cmd('g1', 'powershell.exe -NoProfile -Command "Remove-Item -Recurse -Force node_modules; npm ci --no-audit --no-fund --prefer-offline --loglevel=error"', { exitCode: null, durationMs: undefined, status: 'declined' }),
        cmd('g1', 'npm run build', { output: 'vite v7.3.6 building for production...\n', exitCode: null, durationMs: 6818, status: 'interrupted', outputTruncated: true }),
        { ...b('g1'), kind: 'tool', server: 'codex_apps', tool: 'search_docs', input: JSON.stringify({ query: 'electron-vite renderer build', limit: 5 }, null, 2), result: '3 results\n1. Renderer options – electron-vite\n2. Build for production\n3. Troubleshooting', status: 'done' },
        { ...b('g1'), kind: 'tool', tool: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.ts', error: 'patch did not apply: context not found at line 12', status: 'failed' },
        { ...b('g1'), kind: 'tool', server: 'node_repl', tool: 'run', input: 'await build()', progress: 'bundling 214 modules', status: 'running' },
        { ...b('g1'), kind: 'web', action: 'open', url: 'https://electron-vite.org/guide/build', status: 'done' },
        { ...b('g1'), kind: 'web', action: 'find', query: 'rollupOptions', url: 'https://electron-vite.org/config/', status: 'failed' },
        { ...b('g1'), kind: 'web', action: 'search', status: 'running' },
        { ...b('g1'), kind: 'subagent', childAgentId: `${id}:w1`, action: 'spawn', name: 'Explorer', prompt: 'Map every import of the bundler config', status: 'running' },
        { ...b('g1'), kind: 'subagent', childAgentId: `${id}:w1`, action: 'close', name: 'Explorer', status: 'done' },
        {
          ...b('g1'),
          kind: 'file-change',
          status: 'declined',
          changes: [
            { path: 'docs/old-notes.md', change: 'delete', diff: '# Old notes\n\nNothing here is current.\n' },
            { path: 'src/ui/hooks.ts', change: 'update', movedTo: 'src/ui/useHooks.ts', diff: '' }
          ]
        },
        { ...b('g1'), kind: 'approval', requestId: 'gone-1', summary: 'Bash: Remove-Item -Recurse -Force node_modules', detail: '{\n  "command": "Remove-Item -Recurse -Force node_modules"\n}', outcome: 'denied' },
        { ...b('g1'), kind: 'approval', requestId: 'gone-2', summary: 'Bash: npm run build', detail: '', outcome: 'resolved-elsewhere' },
        { ...b('g1'), kind: 'notice', level: 'info', text: 'Context compacted' },
        { ...b('g1'), kind: 'notice', level: 'warning', text: 'Reconnecting 2/5…' },
        { ...b('g1'), kind: 'notice', level: 'error', text: 'Usage limit reached. The limit resets on 21 Oct.' },
        {
          ...b('g1'),
          kind: 'assistant',
          phase: 'final',
          streaming: false,
          text: '# H1 title\n## H2 title\n### H3 title\n#### H4 title\n\nA paragraph with **bold**, *italic*, ~~struck~~, `code`, a [link](https://example.com/docs) and a bare URL https://example.org/path.\nA second line after a single newline.\n\n> A quote\n> over two lines, with `code`.\n\n1. First\n2. Second\n   - nested bullet\n   - another\n3. Third\n\n- [x] done task\n- [ ] open task\n\n---\n\n```\nplain fence, no language\n```\n\n<script>alert("not html")</script> and <b>tags</b> stay text.'
        }
      ]
      send(id, { type: 'reset', sessionId: id, items })
    },
    /** Replaces the list with `n` mixed items (long-session check) and sends a `reset`. */
    fill: (id: string, n = 2000) => {
      const c = chats.get(id)
      if (!c) return
      const t0 = Date.now() - n * 30_000
      const items: ChatItem[] = []
      for (let i = 0; i < n; i++) {
        const turnId = `fill-${Math.floor(i / 5)}`
        const b = { id: `fill-${i}`, sessionId: id, agentId: id, turnId, ts: t0 + i * 30_000 }
        const k = i % 5
        if (k === 0) items.push({ ...b, kind: 'user', text: `Prompt ${i / 5 + 1}: check module ${i}`, origin: 'human' })
        else if (k === 1) items.push({ ...b, kind: 'assistant', phase: 'commentary', streaming: false, text: `Looking at module ${i}.` })
        else if (k === 2) items.push({ ...b, kind: 'command', command: `npm test -- module-${i}`, intent: 'exec', output: `ok - module ${i}\n`.repeat(3), outputTruncated: false, exitCode: 0, durationMs: 900 + i, status: 'done' })
        else if (k === 3) items.push({ ...b, kind: 'web', action: 'search', query: `module ${i} changelog`, status: 'done' })
        else items.push({ ...b, kind: 'assistant', phase: 'final', streaming: false, text: `Module ${i} is fine.\n\n- checked \`a${i}.ts\`\n- **no** changes needed` })
      }
      const ev: ChatEvent = { type: 'reset', sessionId: id, items }
      send(id, ev)
    }
  }
}

export type CodexStub = ReturnType<typeof createCodexStub>
