// Pure chat logic (src/ui/chat/*, src/ui/chats.ts) and the Markdown renderer's safety.
// Imported by ui.test.ts (npm test runs everything); also runs alone: tsx tests/chat.test.ts
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CHAT_MAX_ITEMS, CHAT_MAX_OUTPUT_CHARS } from '../shared/chat.ts'
import type { ChatEvent, ChatItem } from '../shared/chat.ts'
import type { AgentOfficeBridge } from '../shared/ipc.ts'
import { countLines, parseAnsi, stripAnsi, tailLines } from '../src/ui/chat/ansi.ts'
import { clipDiff, parseDiff } from '../src/ui/chat/diff.ts'
import { PromptHistory } from '../src/ui/chat/history.ts'
import { inlineText, parseInline, parseMarkdown, safeHref } from '../src/ui/chat/markdown.ts'
import type { Block, Inline } from '../src/ui/chat/markdown.ts'
import { applyEvents, EMPTY_CHAT, hasOpenItem, setApprovalOutcome, startsTurn, windowTail } from '../src/ui/chat/state.ts'
import type { ChatState } from '../src/ui/chat/state.ts'
import { ChatManager } from '../src/ui/chats.ts'
import { Markdown } from '../src/ui/components/chat/Markdown.tsx'
import type { ProviderInfo, SessionInfo } from '../shared/sessions.ts'
import { composerState, groupSessions, loginHint, modeHints, modelPlaceholder, orderTargets, usageInfo } from '../src/ui/format.ts'

let pass = 0
const t = (name: string, fn: () => void | Promise<void>) => {
  const r = fn()
  const ok = () => {
    pass++
    console.log('ok -', name)
  }
  return r instanceof Promise ? r.then(ok) : ok()
}

const S = 's1'
const base = (id: string, turnId?: string) => ({ id, sessionId: S, agentId: S, ts: 1000, ...(turnId ? { turnId } : {}) })
const user = (id: string, text: string, turnId?: string, origin: 'human' | 'order' | 'steer' | 'system' = 'human'): ChatItem => ({ ...base(id, turnId), kind: 'user', text, origin })
const asst = (id: string, text = '', streaming = true, turnId?: string): ChatItem => ({ ...base(id, turnId), kind: 'assistant', text, streaming })
const cmd = (id: string, turnId?: string, over: Partial<Extract<ChatItem, { kind: 'command' }>> = {}): ChatItem => ({
  ...base(id, turnId),
  kind: 'command',
  command: 'npm test',
  intent: 'exec',
  output: '',
  outputTruncated: false,
  exitCode: null,
  status: 'running',
  ...over
})
const approval = (id: string, requestId: string, turnId?: string): ChatItem => ({ ...base(id, turnId), kind: 'approval', requestId, summary: 'Bash: npm test', detail: '{}', outcome: 'pending' })
const item = (i: ChatItem): ChatEvent => ({ type: 'item', item: i })
const delta = (itemId: string, d: string, field: 'text' | 'summary' | 'output' = 'text', index?: number): ChatEvent => ({ type: 'delta', sessionId: S, itemId, field, delta: d, ...(index === undefined ? {} : { index }) })
const turn = (turnId: string, status: 'started' | 'completed' | 'interrupted' | 'failed'): ChatEvent => ({ type: 'turn', sessionId: S, turnId, status })
const run = (events: ChatEvent[], from: ChatState = EMPTY_CHAT) => applyEvents(from, S, events)

// ---- reducer ------------------------------------------------------------------------------------

t('items are inserted in arrival order and replaced in place by id', () => {
  let s = run([item(user('u1', 'hi')), item(asst('a1')), item(cmd('c1'))])
  assert.deepEqual(s.order, ['u1', 'a1', 'c1'])
  const before = s.items.u1
  s = run([item(asst('a1', 'done', false))], s)
  assert.deepEqual(s.order, ['u1', 'a1', 'c1']) // no move, no duplicate
  assert.deepEqual(s.items.a1, asst('a1', 'done', false))
  assert.equal(s.items.u1, before) // untouched rows keep their identity
  // A user prompt arrives up to three times under one id (accepted, echo started, echo completed):
  // one row, the latest content, the time of the first event.
  s = run([item({ ...user('u1', 'hi (echo)'), ts: 5000 })], s)
  assert.deepEqual(s.order, ['u1', 'a1', 'c1'])
  assert.deepEqual(s.items.u1, user('u1', 'hi (echo)'))
})

t('the item event at completion replaces what the deltas built, also past the output cap', () => {
  let s = run([item(cmd('c1')), delta('c1', 'partial', 'output')])
  // Over the cap the main process stops sending deltas and re-sends the whole item (tail kept).
  s = run([item(cmd('c1', undefined, { output: 'tail only', outputTruncated: true }))], s)
  assert.equal((s.items.c1 as { output: string }).output, 'tail only')
  s = run([item(cmd('c1', undefined, { output: 'final tail', outputTruncated: true, exitCode: 0, status: 'done' }))], s)
  assert.deepEqual([(s.items.c1 as { output: string }).output, (s.items.c1 as { status: string }).status], ['final tail', 'done'])
  assert.deepEqual(s.order, ['c1'])
})

t('deltas append to text, output and the indexed summary part', () => {
  let s = run([item(asst('a1')), delta('a1', 'Hel'), delta('a1', 'lo')])
  assert.equal((s.items.a1 as { text: string }).text, 'Hello')
  s = run([item(cmd('c1')), delta('c1', 'line 1\n', 'output'), delta('c1', 'line 2\n', 'output')], s)
  assert.equal((s.items.c1 as { output: string }).output, 'line 1\nline 2\n')
  const r: ChatItem = { ...base('r1'), kind: 'reasoning', summary: [], streaming: true }
  s = run([item(r), delta('r1', 'First', 'summary', 0), delta('r1', ' part', 'summary', 0), delta('r1', 'Second', 'summary', 1), delta('r1', '!', 'summary')], s)
  assert.deepEqual((s.items.r1 as { summary: string[] }).summary, ['First part', 'Second!']) // no index = the last part
  s = run([delta('r1', 'raw', 'text')], s)
  assert.equal((s.items.r1 as { text?: string }).text, 'raw')
})

t('deltas for unknown items, wrong fields and other sessions are ignored', () => {
  const s = run([item(asst('a1', 'x'))])
  assert.equal(run([delta('nope', 'zzz')], s), s)
  assert.equal(run([delta('a1', 'zzz', 'output')], s), s) // an assistant message has no output
  assert.equal(run([{ type: 'delta', sessionId: 'other', itemId: 'a1', field: 'text', delta: 'zzz' }], s), s)
  assert.equal(run([item({ ...asst('b1'), sessionId: 'other' })], s), s)
  assert.equal(run([], s), s)
})

t('a batch is applied on one copy and the final item event wins over deltas', () => {
  const s = run([item(asst('a1')), delta('a1', 'par'), delta('a1', 'tial'), item(asst('a1', 'the full text', false))])
  assert.deepEqual(s.items.a1, asst('a1', 'the full text', false))
})

t('reset replaces everything and marks the chat ready', () => {
  let s = run([item(user('u1', 'old')), turn('t1', 'started')])
  assert.equal(s.activeTurn, 't1')
  s = run([{ type: 'reset', sessionId: S, items: [user('u9', 'history'), asst('a9', 'answer', false), user('u9', 'history (dup)')] }], s)
  assert.deepEqual(s.order, ['u9', 'a9'])
  assert.equal((s.items.u9 as { text: string }).text, 'history (dup)')
  assert.equal(s.items.u1, undefined)
  assert.equal(s.status, 'ready')
  assert.equal(s.activeTurn, null)
  // A reset for another session does nothing.
  assert.equal(run([{ type: 'reset', sessionId: 'other', items: [] }], s), s)
  // Events after a reset in the same batch apply to the new list.
  s = run([{ type: 'reset', sessionId: S, items: [asst('a1', 'A')] }, delta('a1', 'B')], s)
  assert.equal((s.items.a1 as { text: string }).text, 'AB')
})

t('bounds: the oldest items are dropped past CHAT_MAX_ITEMS, output keeps its tail', () => {
  const many: ChatItem[] = Array.from({ length: CHAT_MAX_ITEMS + 5 }, (_, i) => user(`u${i}`, String(i)))
  let s = run([{ type: 'reset', sessionId: S, items: many }])
  assert.equal(s.order.length, CHAT_MAX_ITEMS)
  assert.equal(s.order[0], 'u5')
  assert.equal(Object.keys(s.items).length, CHAT_MAX_ITEMS)
  s = run([item(user('new', 'x'))], s)
  assert.equal(s.order.length, CHAT_MAX_ITEMS)
  assert.equal(s.order[0], 'u6')
  assert.equal(s.items.u5, undefined)
  assert.equal(s.order.at(-1), 'new')

  let c = run([item(cmd('c1')), delta('c1', 'a'.repeat(CHAT_MAX_OUTPUT_CHARS - 1), 'output'), delta('c1', 'XYZ', 'output')])
  const out = c.items.c1 as Extract<ChatItem, { kind: 'command' }>
  assert.equal(out.output.length, CHAT_MAX_OUTPUT_CHARS)
  assert.ok(out.output.endsWith('aXYZ'))
  assert.equal(out.outputTruncated, true)
  c = run([delta('c1', '', 'output')], c)
  assert.equal(c.items.c1, out) // an empty delta changes nothing
})

t('a turn that ends closes its open items, and only its own', () => {
  const start = [
    turn('t1', 'started'),
    item(user('u1', 'go', 't1')),
    item(asst('a1', 'working', true, 't1')),
    item(cmd('c1', 't1')),
    item(approval('p1', 'perm-1', 't1')),
    item(cmd('c0', 't0')), // an older turn's item, still marked running
    item(cmd('cdone', 't1', { status: 'failed', exitCode: 2 }))
  ]
  let s = run(start)
  assert.equal(s.activeTurn, 't1')
  assert.equal(hasOpenItem(s), true)
  s = run([turn('t1', 'interrupted')], s)
  assert.equal(s.activeTurn, null)
  assert.equal(s.turns.t1, 'interrupted')
  assert.equal((s.items.a1 as { streaming: boolean }).streaming, false)
  assert.equal((s.items.c1 as { status: string }).status, 'interrupted')
  assert.equal((s.items.p1 as { outcome: string }).outcome, 'resolved-elsewhere')
  assert.equal((s.items.c0 as { status: string }).status, 'running')
  assert.equal((s.items.cdone as { status: string }).status, 'failed') // already closed: untouched

  assert.equal((run([...start, turn('t1', 'failed')]).items.c1 as { status: string }).status, 'failed')
  assert.equal((run([...start, turn('t1', 'completed')]).items.c1 as { status: string }).status, 'done')
  // Another turn ending does not clear the active one.
  assert.equal(run([...start, turn('t0', 'completed')]).activeTurn, 't1')
})

t('approval outcome patch: pending cards only, by request id', () => {
  let s = run([item(approval('p1', 'perm-1')), item(approval('p2', 'perm-2'))])
  const same = setApprovalOutcome(s, 'perm-9', 'allowed')
  assert.equal(same, s)
  s = setApprovalOutcome(s, 'perm-1', 'allowed')
  assert.equal((s.items.p1 as { outcome: string }).outcome, 'allowed')
  assert.equal((s.items.p2 as { outcome: string }).outcome, 'pending')
  // "Answered elsewhere" (the request left the pending list) must not undo a known outcome.
  assert.equal(setApprovalOutcome(s, 'perm-1', 'resolved-elsewhere'), s)
  // The main process's own item event is the last word.
  s = run([item({ ...approval('p1', 'perm-1'), outcome: 'denied' } as ChatItem)], s)
  assert.equal((s.items.p1 as { outcome: string }).outcome, 'denied')
})

t('turn separators and the render window', () => {
  assert.equal(startsTurn(undefined, user('u1', 'a', 't1')), false)
  assert.equal(startsTurn(asst('a0', '', false, 't1'), user('u1', 'a', 't2')), true)
  assert.equal(startsTurn(user('u1', 'a', 't1'), asst('a1', '', false, 't1')), false)
  assert.equal(startsTurn(asst('a1', '', false, 't1'), user('u2', 'steer', 't1', 'steer')), false)
  // Providers without turn ids: a new prompt after an answer starts a group.
  assert.equal(startsTurn(asst('a1', '', false), user('u2', 'next')), true)
  assert.equal(startsTurn(user('u1', 'a'), user('u2', 'b')), false)
  assert.equal(startsTurn(asst('a1', '', false), user('u2', 'more', undefined, 'steer')), false)

  const order = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(windowTail(order, 2), { ids: ['d', 'e'], hidden: 3 })
  assert.equal(windowTail(order, 5).ids, order)
  assert.equal(windowTail(order, 50).hidden, 0)
})

// ---- manager (attach lifecycle, batching) -------------------------------------------------------

function fakeBridge() {
  const cbs = new Set<(e: ChatEvent) => void>()
  const calls: string[] = []
  let resolveAttach: ((items: ChatItem[]) => void) | null = null
  let rejectAttach: ((err: Error) => void) | null = null
  let sendResult: Error | null = null
  const bridge = {
    chat: {
      attach: (id: string) => {
        calls.push(`attach ${id}`)
        return new Promise<ChatItem[]>((res, rej) => {
          resolveAttach = res
          rejectAttach = rej
        })
      },
      detach: (id: string) => void calls.push(`detach ${id}`),
      send: async (id: string, text: string) => {
        calls.push(`send ${id} ${text}`)
        if (sendResult) throw sendResult
      },
      onEvent: (cb: (e: ChatEvent) => void) => (cbs.add(cb), () => cbs.delete(cb))
    }
  } as unknown as AgentOfficeBridge
  return {
    bridge,
    calls,
    emit: (e: ChatEvent) => cbs.forEach((cb) => cb(e)),
    answer: (items: ChatItem[]) => resolveAttach?.(items),
    fail: (msg: string) => rejectAttach?.(new Error(msg)),
    failSend: (msg: string | null) => (sendResult = msg ? new Error(msg) : null)
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

await t('manager: attach once, queue early events behind the list, batch per frame', async () => {
  const f = fakeBridge()
  let scheduled: (() => void) | null = null
  let schedules = 0
  const chats = new ChatManager(f.bridge, (fn) => {
    schedules++
    scheduled = fn
    return () => (scheduled = null)
  })
  const store = chats.store(S)
  assert.equal(store.get().status, 'idle')
  f.emit(item(user('ignored', 'not attached yet')))
  chats.open(S)
  chats.open(S) // a second open while loading does not attach twice
  assert.deepEqual(f.calls, ['attach s1'])
  assert.equal(store.get().status, 'loading')
  f.emit(item(asst('a1', 'A')))
  f.emit(delta('a1', 'B'))
  f.answer([user('u1', 'history')])
  await tick()
  assert.equal(store.get().status, 'ready')
  assert.deepEqual(store.get().order, ['u1', 'a1'])
  assert.equal((store.get().items.a1 as { text: string }).text, 'AB')

  let renders = 0
  store.subscribe(() => renders++)
  for (const ch of 'streaming') f.emit(delta('a1', ch))
  assert.equal(schedules, 1) // nine deltas, one frame
  assert.equal(renders, 0)
  ;(scheduled as unknown as () => void)()
  assert.equal(renders, 1)
  assert.equal((store.get().items.a1 as { text: string }).text, 'ABstreaming')

  // A reset event (history rebuilt after a resume) replaces the list.
  f.emit({ type: 'reset', sessionId: S, items: [user('u7', 'rebuilt')] })
  chats.flush()
  assert.deepEqual(store.get().order, ['u7'])

  chats.dispose(S)
  assert.equal(chats.has(S), false)
  assert.equal(f.calls.at(-1), 'detach s1')
})

await t('manager: a failed attach can be retried; a late answer after dispose is dropped', async () => {
  const f = fakeBridge()
  const chats = new ChatManager(f.bridge, () => () => undefined)
  chats.open(S)
  f.fail("Error invoking remote method 'agent-office:chat:attach': Error: unknown session")
  await tick()
  assert.equal(chats.store(S).get().status, 'error')
  assert.equal(chats.store(S).get().error, 'unknown session')
  chats.open(S)
  assert.equal(f.calls.filter((c) => c.startsWith('attach')).length, 2)
  const old = chats.store(S)
  chats.dispose(S)
  f.answer([user('u1', 'late')])
  await tick()
  assert.equal(old.get().order.length, 0)
  chats.prune(new Set())
})

await t('manager: send keeps the error inline, remembers sent prompts, syncs approvals', async () => {
  const f = fakeBridge()
  const chats = new ChatManager(f.bridge, () => () => undefined)
  chats.open(S)
  f.answer([approval('p1', 'perm-1')])
  await tick()
  assert.equal(await chats.send(S, 'first prompt'), true)
  f.failSend('session has exited')
  assert.equal(await chats.send(S, 'second'), false)
  assert.equal(chats.store(S).get().sendError, 'session has exited')
  assert.equal(chats.store(S).get().sending, false)
  assert.equal(chats.ui(S).history.prev(''), 'first prompt') // the failed one is not history
  chats.resolveApproval('perm-1', 'allowed')
  assert.equal((chats.store(S).get().items.p1 as { outcome: string }).outcome, 'allowed')
})

// ---- markdown -----------------------------------------------------------------------------------

const kinds = (blocks: Block[]) => blocks.map((b) => b.t)
const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

t('markdown blocks: headings, paragraphs, lists, code, quotes, rules, tables', () => {
  const doc = [
    '# Title',
    '',
    'A paragraph with **bold**, *italic*, `code` and ~~gone~~.',
    'Second line.',
    '',
    '- one',
    '- two',
    '  - nested',
    '- [x] done',
    '- [ ] todo',
    '',
    '1. first',
    '2. second',
    '',
    '```ts',
    'const a = "<b>" // **not bold**',
    '```',
    '',
    '> quoted',
    '',
    '---',
    '',
    '| File | Lines |',
    '| :--- | ---: |',
    '| a.ts | 10 |',
    '| b\\|c | `x|y` |'
  ].join('\n')
  const blocks = parseMarkdown(doc)
  assert.deepEqual(kinds(blocks), ['heading', 'p', 'list', 'list', 'code', 'quote', 'hr', 'table'])
  const [h, p, ul, ol, code, , , table] = blocks
  assert.ok(h.t === 'heading' && h.level === 1 && inlineText(h.children) === 'Title')
  assert.ok(p.t === 'p')
  assert.deepEqual(
    (p as { children: Inline[] }).children.map((n) => n.t),
    ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'del', 'text', 'br', 'text']
  )
  assert.ok(ul.t === 'list' && !ul.ordered && ul.items.length === 4)
  if (ul.t === 'list') {
    assert.deepEqual(kinds(ul.items[1].blocks), ['p', 'list'])
    assert.deepEqual(
      ul.items.map((i) => i.checked),
      [null, null, true, false]
    )
  }
  assert.ok(ol.t === 'list' && ol.ordered && ol.start === 1 && ol.items.length === 2)
  assert.ok(code.t === 'code' && code.lang === 'ts' && code.closed && code.text === 'const a = "<b>" // **not bold**')
  if (table.t === 'table') {
    assert.deepEqual(table.align, ['left', 'right'])
    assert.deepEqual(table.head.map(inlineText), ['File', 'Lines'])
    assert.deepEqual(
      table.rows.map((r) => r.map(inlineText)),
      [
        ['a.ts', '10'],
        ['b|c', 'x|y']
      ]
    )
  } else assert.fail('table expected')
})

t('markdown tolerates half-written input (streaming)', () => {
  const open = parseMarkdown('Here:\n\n```js\nconst x = 1')
  assert.deepEqual(kinds(open), ['p', 'code'])
  assert.ok(open[1].t === 'code' && !open[1].closed && open[1].text === 'const x = 1')
  assert.equal(inlineText(parseInline('an **unclosed bold and a `tick')), 'an **unclosed bold and a `tick')
  assert.equal(inlineText(parseInline('[label](https://exa')), '[label](https://exa')
  assert.deepEqual(kinds(parseMarkdown('| a | b |\n| --- |')), ['p']) // a table whose separator is not complete yet
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n\n  \n'), [])
  // Identifiers keep their underscores and stars in the middle of words don't pair up oddly.
  assert.equal(inlineText(parseInline('snake_case_name and 2 * 3 * 4')), 'snake_case_name and 2 * 3 * 4')
  assert.deepEqual(
    parseInline('snake_case_name and 2 * 3 * 4').map((n) => n.t),
    ['text']
  )
  // Pathological nesting ends as text instead of blowing the stack.
  assert.ok(parseMarkdown('> '.repeat(500) + 'deep').length > 0)
  assert.ok(parseInline('*'.repeat(5000)).length > 0)
  // Equal source gives equal `src` (the renderer skips blocks whose source did not change).
  const a = parseMarkdown('one\n\ntwo')
  const b = parseMarkdown('one\n\ntwo and more')
  assert.equal(a[0].src, b[0].src)
  assert.notEqual(a[1].src, b[1].src)
})

t('links: only absolute http(s) URLs become links', () => {
  assert.equal(safeHref('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c')
  assert.equal(safeHref('HTTP://Example.com'), 'http://example.com/')
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32/cmd.exe',
    'vbscript:x',
    'ms-settings:x',
    '//example.com',
    '/relative',
    'example.com',
    'https://',
    'https://user:pw@example.com/',
    'https://exa mple.com',
    'java\tscript:alert(1)',
    'https://example.com/\njavascript:alert(1)',
    ''
  ]) {
    assert.equal(safeHref(bad), null, bad)
  }
  const links = (src: string) => parseInline(src).filter((n): n is Extract<Inline, { t: 'link' }> => n.t === 'link')
  assert.deepEqual(
    links('[docs](https://example.com/docs "title")').map((l) => l.href),
    ['https://example.com/docs']
  )
  assert.equal(links('[click](javascript:alert(1))').length, 0)
  assert.equal(inlineText(parseInline('[click](javascript:alert(1))')), '[click](javascript:alert(1))')
  assert.equal(links('[x](data:text/html;base64,AAAA)').length, 0)
  assert.equal(links('![img](https://example.com/a.png)')[0].href, 'https://example.com/a.png')
  assert.deepEqual(
    links('see https://example.com/a_(b). And <https://example.org>!').map((l) => l.href),
    ['https://example.com/a_(b)', 'https://example.org/']
  )
  assert.equal(links('<javascript:alert(1)>').length, 0)
  assert.equal(links('[a [b](https://in.example) c](https://out.example)').length, 1) // no link inside a link
})

t('rendered markdown never contains model-supplied markup', () => {
  const evil = [
    '<script>alert(1)</script>',
    '',
    '<img src=x onerror=alert(1)> and <b>bold?</b>',
    '',
    '[x](javascript:alert(1)) [y](https://ok.example/"onmouseover="alert(1))',
    '',
    '```html',
    '<iframe src="https://evil.example"></iframe>',
    '```',
    '',
    '| <i>h</i> |',
    '| --- |',
    '| <svg onload=alert(1)> |',
    '',
    '- <a href="javascript:alert(1)">item</a>'
  ].join('\n')
  const out = html(evil)
  // The only tags in the output are the renderer's own.
  const tags = new Set([...out.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()))
  for (const tag of tags) assert.ok(['div', 'p', 'a', 'span', 'pre', 'code', 'button', 'svg', 'rect', 'path', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'li'].includes(tag), `unexpected <${tag}> in ${out}`)
  assert.ok(!/<script|<img|<iframe|<b>|<i>/i.test(out), out)
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(out.includes('&lt;iframe'))
  assert.ok(out.includes('&lt;svg onload=alert(1)&gt;'))
  // Every href in the output is http(s); no attribute was smuggled in through a URL.
  const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
  assert.ok(hrefs.length >= 1)
  for (const h of hrefs) assert.ok(/^https?:\/\//.test(h), h)
  assert.ok(!/<[^>]*\son[a-z]+=/i.test(out), out)
  // And the ordinary case renders real elements.
  const ok = html('## Hi\n\n**b** `c`\n\n- [x] t\n\n```js\n1\n```')
  for (const tag of ['<h4', '<strong>b</strong>', '<code class="md-code">c</code>', '<ul>', '<pre>']) assert.ok(ok.includes(tag), `${tag} in ${ok}`)
})

// ---- diff ---------------------------------------------------------------------------------------

t('unified diffs become numbered rows', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,4 +10,5 @@ export function a() {',
    ' const x = 1',
    '-const ready = false',
    '+const ready = await probe()',
    '+const again = true',
    ' return x',
    '\\ No newline at end of file',
    '@@ -40 +41 @@',
    '-old',
    '+new'
  ].join('\r\n')
  const d = parseDiff(diff)
  assert.equal(d.added, 3)
  assert.equal(d.removed, 2)
  assert.deepEqual(
    d.lines.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null, l.text]),
    [
      ['hunk', null, null, '@@ -10,4 +10,5 @@ export function a() {'],
      ['ctx', 10, 10, 'const x = 1'],
      ['del', 11, null, 'const ready = false'],
      ['add', null, 11, 'const ready = await probe()'],
      ['add', null, 12, 'const again = true'],
      ['ctx', 12, 13, 'return x'],
      ['hunk', null, null, '@@ -40 +41 @@'],
      ['del', 40, null, 'old'],
      ['add', null, 41, 'new']
    ]
  )
  // A second file in the same diff: its headers are not changes.
  const two = parseDiff(['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-c', '+d'].join('\n'))
  assert.deepEqual([two.added, two.removed, two.lines.length], [2, 2, 6])
})

t('raw content for an added or deleted file; headerless +/- bodies; clipping', () => {
  const add = parseDiff('line one\n\n+ plus sign in content\n', 'add')
  assert.deepEqual(
    add.lines.map((l) => [l.kind, l.newNo, l.text]),
    [
      ['add', 1, 'line one'],
      ['add', 2, ''],
      ['add', 3, '+ plus sign in content']
    ]
  )
  assert.equal(add.added, 3)
  assert.deepEqual(
    parseDiff('+a\n+b', 'add').lines.map((l) => l.text),
    ['a', 'b']
  ) // "+"-prefixed body: markers dropped
  const del = parseDiff('gone', 'delete')
  assert.deepEqual([del.removed, del.lines[0].kind, del.lines[0].oldNo], [1, 'del', 1])
  // An added file that comes as a real hunk (what the Codex driver sends) is parsed as one.
  const hunked = parseDiff('@@ -0,0 +1,2 @@\n+a\n+b', 'add')
  assert.deepEqual(
    hunked.lines.map((l) => [l.kind, l.newNo ?? null, l.text]),
    [
      ['hunk', null, '@@ -0,0 +1,2 @@'],
      ['add', 1, 'a'],
      ['add', 2, 'b']
    ]
  )
  assert.equal(hunked.added, 2)
  assert.deepEqual(
    parseDiff('@@ -1,2 +0,0 @@\n-a\n-b', 'delete').lines.map((l) => [l.kind, l.oldNo ?? null]),
    [
      ['hunk', null],
      ['del', 1],
      ['del', 2]
    ]
  )
  const bare = parseDiff('--- a/f\n+++ b/f\n-x\n+y\n z', 'update')
  assert.deepEqual(
    bare.lines.map((l) => l.kind),
    ['del', 'add', 'ctx']
  )
  assert.equal(bare.lines[0].oldNo, undefined)
  assert.deepEqual(parseDiff(''), { lines: [], added: 0, removed: 0 })

  const long = parseDiff(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'), 'add').lines
  assert.deepEqual([clipDiff(long, 40).lines.length, clipDiff(long, 40).hidden], [40, 60])
  assert.equal(clipDiff(long.slice(0, 45), 40).hidden, 0) // not worth hiding five lines
})

// ---- ansi ---------------------------------------------------------------------------------------

t('ansi: escapes are stripped; SGR colours survive as spans', () => {
  const E = '\x1b'
  assert.equal(stripAnsi(`${E}[1m${E}[38;5;42mPASS${E}[0m tests/a.test.ts ${E}[2m(3 ms)${E}[22m`), 'PASS tests/a.test.ts (3 ms)')
  assert.equal(stripAnsi(`${E}]0;window title\x07hi${E}[2K${E}[1G${E}[?25l!`), 'hi!')
  assert.equal(stripAnsi(`${E}]8;;https://example.com${E}\\link${E}]8;;${E}\\`), 'link')
  assert.equal(stripAnsi('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(stripAnsi('10%\r50%\r100%\nnext'), '100%\nnext') // a progress line shows its last state
  assert.equal(stripAnsi('50%\r'), '50%')
  assert.equal(stripAnsi('bell\x07 and null\x00 and tab\t'), 'bell and null and tab\t')
  assert.ok(!stripAnsi(`truncated ${E}[`).includes(E)) // half an escape at a chunk end leaves no control char

  const spans = parseAnsi(`plain ${E}[31mred ${E}[1mbold${E}[0m ${E}[92mok${E}[39m ${E}[38;5;208mo${E}[38;2;1;2;3mt${E}[0m${E}[2;3;4mx`)
  assert.deepEqual(spans, [
    { text: 'plain ' },
    { text: 'red ', fg: 1 },
    { text: 'bold', fg: 1, bold: true },
    { text: ' ' },
    { text: 'ok', fg: 10 },
    { text: ' ' },
    { text: 'o', fg: 'rgb(255,135,0)' },
    { text: 't', fg: 'rgb(1,2,3)' },
    { text: 'x', dim: true, italic: true, underline: true }
  ])
  const messy = `${E}[32m✓${E}[0m a\r\n${E}[48;5;22m${E}[?25hb${E}[K\r\n`
  assert.equal(
    parseAnsi(messy)
      .map((s) => s.text)
      .join(''),
    stripAnsi(messy)
  )
  assert.deepEqual(parseAnsi('no escapes'), [{ text: 'no escapes' }])
  assert.deepEqual(parseAnsi(''), [])

  assert.deepEqual(tailLines('a\nb\nc\nd\n', 2), { text: 'c\nd\n', cut: 2 })
  assert.deepEqual(tailLines('a\nb', 5), { text: 'a\nb', cut: 0 })
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines('a\nb\nc'), 3)
  assert.equal(countLines(''), 0)
})

// ---- composer -----------------------------------------------------------------------------------

t('composer history: Up walks back, Down returns to the draft', () => {
  const h = new PromptHistory(3)
  assert.equal(h.prev('draft'), null) // nothing sent yet
  h.push('one')
  h.push('two')
  h.push('two') // not twice in a row
  h.push('  ')
  assert.equal(h.size, 2)
  assert.equal(h.prev('my draft'), 'two')
  assert.equal(h.browsing, true)
  assert.equal(h.prev('two'), 'one')
  assert.equal(h.prev('one'), null) // at the oldest
  assert.equal(h.next(), 'two')
  assert.equal(h.next(), 'my draft')
  assert.equal(h.browsing, false)
  assert.equal(h.next(), null)
  h.prev('x')
  h.reset()
  assert.equal(h.prev('y'), 'two') // editing restarts from the newest
  h.push('three')
  h.push('four')
  assert.equal(h.size, 3) // capped
  assert.equal(h.prev(''), 'four')
  assert.equal(h.prev(''), 'three')
  assert.equal(h.prev(''), 'two')
  assert.equal(h.prev(''), null)
})

t('composer state follows the session state', () => {
  assert.deepEqual(composerState('idle', 'Codex'), { enabled: true, steer: false, reason: null })
  assert.deepEqual(composerState('busy', 'Codex'), { enabled: true, steer: true, reason: null })
  assert.equal(composerState('waiting-permission', 'Codex').steer, true)
  for (const state of ['exited', 'needs-attention', 'starting'] as const) {
    const c = composerState(state, 'Codex')
    assert.equal(c.enabled, false)
    assert.ok(c.reason && c.reason.length > 0)
  }
  assert.ok(composerState('needs-attention', 'Codex').reason!.includes('Codex'))
})

// ---- provider helpers ---------------------------------------------------------------------------

t('provider account helpers: login hint, usage, mode help, model placeholder', () => {
  assert.equal(loginHint({ id: 'codex', label: 'Codex', available: true, account: { loggedIn: false } }), true)
  assert.equal(loginHint({ id: 'codex', label: 'Codex', available: true, account: { loggedIn: true, plan: 'free' } }), false)
  assert.equal(loginHint({ id: 'claude-code', label: 'Claude Code', available: true }), false)

  assert.equal(usageInfo(undefined), null)
  const now = Date.UTC(2026, 9, 2, 12, 0)
  const u = usageInfo({ usedPercent: 12.4, resetsAt: now + 3 * 86_400_000, windowMinutes: 43200 }, now)!
  assert.deepEqual([u.percent, u.label, u.tone], [12, '12%', 'ok'])
  assert.ok(u.title.includes('12% of the 30-day limit used') && u.title.includes('Resets'), u.title)
  assert.equal(usageInfo({ usedPercent: 81 })!.tone, 'warn')
  assert.equal(usageInfo({ usedPercent: 250 })!.percent, 100)
  assert.equal(usageInfo({ usedPercent: 250 })!.tone, 'danger')
  assert.equal(usageInfo({ usedPercent: Number.NaN }), null)
  assert.ok(usageInfo({ usedPercent: 5, windowMinutes: 300 })!.title.includes('5-hour'))

  assert.ok(modeHints('codex').default.toLowerCase().includes('ask before every command'))
  assert.ok(modeHints('codex').acceptEdits.toLowerCase().includes('sandbox'))
  assert.ok(modeHints('codex').plan.toLowerCase().includes('read-only'))
  assert.notEqual(modeHints('claude-code').default, modeHints('codex').default)
  assert.notEqual(modelPlaceholder('codex'), modelPlaceholder('claude-code'))
})

t('Codex sessions get their own sidebar group and an "All Codex" order target', () => {
  const providers: ProviderInfo[] = [
    { id: 'claude-code', label: 'Claude Code', available: true },
    { id: 'codex', label: 'Codex', available: true, account: { loggedIn: true, plan: 'free' } }
  ]
  const s = (id: string, provider: 'claude-code' | 'codex', state: SessionInfo['state'] = 'idle'): SessionInfo => ({
    id,
    provider,
    cwd: `C:\\src\\${id}`,
    title: id,
    state,
    startedAt: 1,
    permissionMode: 'default',
    surface: provider === 'codex' ? 'chat' : 'terminal',
    canReceiveOrders: true
  })
  const sessions = [s('a', 'claude-code'), s('x', 'codex'), s('y', 'codex', 'exited')]
  assert.deepEqual(
    groupSessions(providers, sessions).map((g) => [g.provider.label, g.sessions.map((x) => x.id)]),
    [
      ['Claude Code', ['a']],
      ['Codex', ['x', 'y']]
    ]
  )
  const targets = orderTargets(providers, sessions, [])
  assert.deepEqual(
    targets.filter((o) => o.group === 'provider').map((o) => [o.label, o.ids]),
    [
      ['All Claude Code', ['a']],
      ['All Codex', ['x']]
    ]
  )
  // No live Codex session, no Codex target.
  assert.ok(!orderTargets(providers, [s('a', 'claude-code'), s('y', 'codex', 'exited')], []).some((o) => o.label === 'All Codex'))
})

console.log(`\n${pass} chat tests passed`)
