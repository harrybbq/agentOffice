// The chat model of one session, as the renderer holds it: a pure reducer over ChatEvents
// (shared/chat.ts). No DOM, no React. Covered by tests/chat.test.ts.
import { CHAT_MAX_ITEMS, CHAT_MAX_OUTPUT_CHARS } from '../../../shared/chat'
import type { ChatEvent, ChatItem, ChatItemStatus } from '../../../shared/chat'

export type TurnStatus = 'started' | 'completed' | 'interrupted' | 'failed'
export type ApprovalOutcome = Extract<ChatItem, { kind: 'approval' }>['outcome']

export interface ChatState {
  /** idle = never attached; loading = attach in flight; ready = items are current. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Item ids in arrival order. */
  order: readonly string[]
  items: Readonly<Record<string, ChatItem>>
  turns: Readonly<Record<string, TurnStatus>>
  /** The turn that is running, from `turn` events. */
  activeTurn: string | null
}

export const EMPTY_CHAT: ChatState = { status: 'idle', error: null, order: [], items: {}, turns: {}, activeTurn: null }

/** Keeps the tail: live output matters most at its end. */
function capTail(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(text.length - max), cut: true } : { text, cut: false }
}

function isOpen(item: ChatItem): boolean {
  switch (item.kind) {
    case 'assistant':
    case 'reasoning':
      return item.streaming
    case 'command':
    case 'file-change':
    case 'web':
    case 'tool':
    case 'subagent':
      return item.status === 'running'
    case 'approval':
      return item.outcome === 'pending'
    default:
      return false
  }
}

/** An item of a turn that ended: nothing in it may keep spinning. */
function closeItem(item: ChatItem, how: Exclude<TurnStatus, 'started'>): ChatItem {
  const status: ChatItemStatus = how === 'completed' ? 'done' : how
  switch (item.kind) {
    case 'assistant':
    case 'reasoning':
      return { ...item, streaming: false }
    case 'command':
    case 'file-change':
    case 'web':
    case 'tool':
    case 'subagent':
      return { ...item, status }
    case 'approval':
      return { ...item, outcome: 'resolved-elsewhere' }
    default:
      return item
  }
}

function applyDelta(item: ChatItem, ev: Extract<ChatEvent, { type: 'delta' }>): ChatItem {
  if (!ev.delta) return item
  if (ev.field === 'text' && (item.kind === 'assistant' || item.kind === 'reasoning')) {
    return { ...item, text: (item.text ?? '') + ev.delta }
  }
  if (ev.field === 'summary' && item.kind === 'reasoning') {
    const index = Math.max(0, Math.min(ev.index ?? Math.max(0, item.summary.length - 1), 256))
    const summary = item.summary.slice()
    while (summary.length <= index) summary.push('')
    summary[index] += ev.delta
    return { ...item, summary }
  }
  if (ev.field === 'output' && item.kind === 'command') {
    const { text, cut } = capTail(item.output + ev.delta, CHAT_MAX_OUTPUT_CHARS)
    return { ...item, output: text, outputTruncated: item.outputTruncated || cut }
  }
  return item
}

function fromList(list: readonly ChatItem[], sessionId: string): Pick<ChatState, 'order' | 'items'> {
  const items: Record<string, ChatItem> = {}
  const order: string[] = []
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || item.sessionId !== sessionId) continue
    if (!(item.id in items)) order.push(item.id)
    items[item.id] = item
  }
  const drop = order.length - CHAT_MAX_ITEMS
  if (drop > 0) for (const id of order.splice(0, drop)) delete items[id]
  return { order, items }
}

/**
 * Applies a batch of events for ONE session (events of other sessions are ignored). The batch is
 * applied on one copy, so a frame's worth of token deltas costs a single state replacement.
 * Items that did not change keep their identity: rows subscribed to them don't re-render.
 */
export function applyEvents<T extends ChatState>(state: T, sessionId: string, events: readonly ChatEvent[]): T {
  if (events.length === 0) return state
  let items: Record<string, ChatItem> | null = null
  let order: string[] | null = null
  let turns: Record<string, TurnStatus> | null = null
  let activeTurn = state.activeTurn
  let status = state.status
  let error = state.error
  const getItems = () => (items ??= { ...state.items })
  const getOrder = () => (order ??= state.order.slice())
  const curItems = () => items ?? state.items

  for (const ev of events) {
    if (ev.type === 'reset') {
      if (ev.sessionId !== sessionId) continue
      const next = fromList(ev.items, sessionId)
      items = next.items as Record<string, ChatItem>
      order = next.order as string[]
      turns = {}
      activeTurn = null
      status = 'ready'
      error = null
    } else if (ev.type === 'item') {
      const item = ev.item
      if (!item || item.sessionId !== sessionId || typeof item.id !== 'string') continue
      const prev = curItems()[item.id]
      const known = prev !== undefined
      // A replacement keeps its place in the list and the time of the item's first event.
      getItems()[item.id] = known && prev.ts !== item.ts ? { ...item, ts: prev.ts } : item
      if (!known) {
        const o = getOrder()
        o.push(item.id)
        const drop = o.length - CHAT_MAX_ITEMS
        if (drop > 0) for (const id of o.splice(0, drop)) delete getItems()[id]
      }
    } else if (ev.type === 'delta') {
      if (ev.sessionId !== sessionId) continue
      const cur = curItems()[ev.itemId]
      if (!cur) continue // a delta for an item that was never announced, or one already dropped
      const next = applyDelta(cur, ev)
      if (next !== cur) getItems()[ev.itemId] = next
    } else if (ev.type === 'turn') {
      if (ev.sessionId !== sessionId) continue
      turns ??= { ...state.turns }
      turns[ev.turnId] = ev.status
      if (ev.status === 'started') {
        activeTurn = ev.turnId
        continue
      }
      if (activeTurn === ev.turnId) activeTurn = null
      const how = ev.status
      const cur = curItems()
      for (const id of order ?? state.order) {
        const item = cur[id]
        if (item && item.turnId === ev.turnId && isOpen(item)) getItems()[id] = closeItem(item, how)
      }
    }
  }

  if (!items && !order && !turns && activeTurn === state.activeTurn && status === state.status) return state
  return {
    ...state,
    status,
    error,
    items: items ?? state.items,
    order: order ?? state.order,
    turns: turns ?? state.turns,
    activeTurn
  }
}

/** Patches the approval card(s) of one permission request, e.g. right after Allow was clicked. */
export function setApprovalOutcome<T extends ChatState>(state: T, requestId: string, outcome: ApprovalOutcome, onlyPending = true): T {
  let items: Record<string, ChatItem> | null = null
  for (const id of state.order) {
    const item = state.items[id]
    if (!item || item.kind !== 'approval' || item.requestId !== requestId) continue
    if (item.outcome === outcome || (onlyPending && item.outcome !== 'pending')) continue
    items ??= { ...state.items }
    items[id] = { ...item, outcome }
  }
  return items ? { ...state, items } : state
}

/**
 * Is this command / file change held back by a permission request that is still pending? (It has
 * not started yet, whatever its `running` status says: the provider announces it before it asks.)
 */
export function awaitsApproval(state: ChatState, id: string): boolean {
  const item = state.items[id]
  if (!item || (item.kind !== 'command' && item.kind !== 'file-change') || item.status !== 'running') return false
  // The request follows its subject closely: look at the newest items only.
  for (let i = state.order.length - 1; i >= 0 && i >= state.order.length - 60; i--) {
    const x = state.items[state.order[i]]
    if (x && x.kind === 'approval' && x.subjectId === id && x.outcome === 'pending') return true
  }
  return false
}

/** Does `item` open a new group in the list (a separator goes above it)? */
export function startsTurn(prev: ChatItem | undefined, item: ChatItem | undefined): boolean {
  if (!prev || !item) return false
  if (item.turnId !== undefined || prev.turnId !== undefined) return item.turnId !== prev.turnId
  // Providers without turns: a prompt from the user opens the next exchange.
  return item.kind === 'user' && item.origin !== 'steer' && prev.kind !== 'user'
}

/** The last `limit` ids, and how many are hidden above them. */
export function windowTail(order: readonly string[], limit: number): { ids: readonly string[]; hidden: number } {
  const hidden = Math.max(0, order.length - Math.max(1, limit))
  return { ids: hidden > 0 ? order.slice(hidden) : order, hidden }
}

/** Is anything still producing output (drives the "working" line and the tail follow)? */
export function hasOpenItem(state: ChatState): boolean {
  for (let i = state.order.length - 1; i >= 0 && i >= state.order.length - 40; i--) {
    const item = state.items[state.order[i]]
    if (item && item.kind !== 'approval' && isOpen(item)) return true
  }
  return false
}
