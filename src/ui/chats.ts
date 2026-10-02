// Chat state per session (sessions with surface 'chat'), kept outside React like the terminals so
// switching sessions is instant. One Store per session: rows subscribe to their own item, the list
// to the id order. ChatEvents are queued and applied once per animation frame, so a stream of
// token deltas costs one state replacement per frame.
import type { AgentOfficeBridge } from '../../shared/ipc'
import type { ChatEvent } from '../../shared/chat'
import { applyEvents, EMPTY_CHAT, setApprovalOutcome } from './chat/state'
import type { ApprovalOutcome, ChatState } from './chat/state'
import { PromptHistory } from './chat/history'
import { cleanError } from './format'
import { Store } from './store'

export interface ChatSessionState extends ChatState {
  /** chat.send is in flight. */
  sending: boolean
  sendError: string | null
}

/** View state that survives switching sessions but is not rendered from a store. */
export interface ChatUi {
  history: PromptHistory
  draft: string
  /** Following the tail. */
  pinned: boolean
  scrollTop: number
  /** How many items the list renders (grows when the user scrolls up). */
  limit: number
}

export const CHAT_WINDOW = 160

interface Entry {
  id: string
  store: Store<ChatSessionState>
  ui: ChatUi
  /** Bumped by every attach / dispose, so a late attach answer of an older attachment is dropped. */
  gen: number
  /** The attach answer arrived: events may be applied. Until then they wait in `early`. */
  ready: boolean
  early: ChatEvent[]
  pending: ChatEvent[]
}

/** Runs `fn` soon, once. Returns a cancel function. */
export type Scheduler = (fn: () => void) => () => void

/** Next frame; a timer as well, because a hidden window gets no animation frames. */
const frameScheduler: Scheduler = (fn) => {
  let done = false
  const run = () => {
    if (done) return
    done = true
    cancelAnimationFrame(raf)
    clearTimeout(timer)
    fn()
  }
  const raf = requestAnimationFrame(run)
  const timer = setTimeout(run, 250)
  return () => {
    done = true
    cancelAnimationFrame(raf)
    clearTimeout(timer)
  }
}

export class ChatManager {
  private entries = new Map<string, Entry>()
  private cancelFlush: (() => void) | null = null

  constructor(
    private bridge: AgentOfficeBridge,
    private schedule: Scheduler = frameScheduler
  ) {
    bridge.chat.onEvent((ev) => this.onEvent(ev))
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** The session's store (created empty; call open() to attach). */
  store(id: string): Store<ChatSessionState> {
    return this.entry(id).store
  }

  ui(id: string): ChatUi {
    return this.entry(id).ui
  }

  /** Attaches the first time the session is shown, and again after a failed attach. */
  open(id: string): void {
    const e = this.entry(id)
    const status = e.store.get().status
    if (status === 'idle' || status === 'error') this.attach(e)
  }

  /** Asks for the list again (the Retry button). */
  reload(id: string): void {
    const e = this.entries.get(id)
    if (e) this.attach(e)
  }

  dispose(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    e.gen++
    this.entries.delete(id)
    if (e.store.get().status !== 'idle') this.bridge.chat.detach(id)
  }

  /** Drops the chats of sessions that no longer exist. */
  prune(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!liveIds.has(id)) this.dispose(id)
  }

  /** Resolves true when the prompt was accepted. A failure is kept in the store (shown inline). */
  async send(id: string, text: string): Promise<boolean> {
    const e = this.entry(id)
    if (e.store.get().sending) return false
    e.store.set({ sending: true, sendError: null })
    try {
      await this.bridge.chat.send(id, text)
      e.ui.history.push(text)
      e.store.set({ sending: false })
      return true
    } catch (err) {
      e.store.set({ sending: false, sendError: cleanError(err) })
      return false
    }
  }

  clearSendError(id: string): void {
    this.entries.get(id)?.store.set({ sendError: null })
  }

  /**
   * A permission request was answered (here, in the inbox, or somewhere else): its approval card
   * shows the outcome at once. The main process's own `item` event for the card overrides this.
   */
  resolveApproval(requestId: string, outcome: ApprovalOutcome): void {
    for (const e of this.entries.values()) {
      this.flushEntry(e)
      const next = setApprovalOutcome(e.store.get(), requestId, outcome)
      if (next !== e.store.get()) e.store.set(next)
    }
  }

  /** Applies everything that is queued, now (tests; also before reading the state synchronously). */
  flush(): void {
    this.cancelFlush?.()
    this.cancelFlush = null
    for (const e of this.entries.values()) this.flushEntry(e)
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id)
    if (!e) {
      e = {
        id,
        store: new Store<ChatSessionState>({ ...EMPTY_CHAT, sending: false, sendError: null }),
        ui: { history: new PromptHistory(), draft: '', pinned: true, scrollTop: 0, limit: CHAT_WINDOW },
        gen: 0,
        ready: false,
        early: [],
        pending: []
      }
      this.entries.set(id, e)
    }
    return e
  }

  private attach(e: Entry): void {
    const gen = ++e.gen
    e.ready = false
    e.early = []
    e.pending = []
    e.store.set({ status: 'loading', error: null })
    this.bridge.chat
      .attach(e.id)
      .then((items) => {
        if (this.entries.get(e.id) !== e || e.gen !== gen) return
        // Events that arrived while the answer was in flight are newer than the list.
        const early = e.early
        e.early = []
        e.ready = true
        e.store.set(applyEvents(e.store.get(), e.id, [{ type: 'reset', sessionId: e.id, items: Array.isArray(items) ? items : [] }, ...early]))
      })
      .catch((err: unknown) => {
        if (this.entries.get(e.id) !== e || e.gen !== gen) return
        e.early = []
        e.store.set({ status: 'error', error: cleanError(err) })
      })
  }

  private onEvent(ev: ChatEvent): void {
    if (!ev || typeof ev !== 'object') return
    const sessionId = ev.type === 'item' ? ev.item?.sessionId : ev.sessionId
    const e = sessionId ? this.entries.get(sessionId) : undefined
    if (!e) return
    if (!e.ready) {
      if (e.store.get().status === 'loading') e.early.push(ev)
      return
    }
    e.pending.push(ev)
    this.cancelFlush ??= this.schedule(() => {
      this.cancelFlush = null
      for (const x of this.entries.values()) this.flushEntry(x)
    })
  }

  private flushEntry(e: Entry): void {
    if (e.pending.length === 0) return
    const events = e.pending
    e.pending = []
    const cur = e.store.get()
    const next = applyEvents(cur, e.id, events)
    if (next !== cur) e.store.set(next)
  }
}
