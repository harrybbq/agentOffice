// Event bus: adapters emit here; events go to the renderer over IPC.
// Until the renderer has loaded, nothing is sent. On every (re)load the renderer gets a snapshot of
// the last event per agent, so a reload (or overlay window recreation) restores the characters.
import type { WebContents } from 'electron'
import type { AgentEvent } from '../shared/events'
import { IPC } from '../shared/ipc'
import type { EventSink } from './adapters/types'

const DONE_TTL_MS = 30_000
const MAX_AGENTS = 500

export class EventBus implements EventSink {
  /** Last event per agentId, in insertion order (oldest activity first). */
  private snapshot = new Map<string, { event: AgentEvent; seenAt: number }>()
  private target: WebContents | null = null
  private ready = false
  private detach: (() => void) | null = null

  emit(e: AgentEvent): void {
    this.snapshot.delete(e.agentId)
    this.snapshot.set(e.agentId, { event: e, seenAt: Date.now() })
    if (this.snapshot.size > MAX_AGENTS) {
      const oldest = this.snapshot.keys().next().value
      if (oldest !== undefined) this.snapshot.delete(oldest)
    }
    // While not ready, the snapshot doubles as the buffer: it is flushed on did-finish-load.
    if (this.ready) this.send(e)
  }

  /** Live top-level sessions with their provider (order targets). */
  topLevel(): { id: string; provider: string }[] {
    const out: { id: string; provider: string }[] = []
    for (const { event } of this.snapshot.values()) {
      if (event.parentId === null && event.activity !== 'done') out.push({ id: event.agentId, provider: event.provider })
    }
    return out
  }

  /** Point the bus at a (new) window's webContents. */
  attach(wc: WebContents): void {
    this.detach?.()
    this.target = wc
    this.ready = false
    const onLoad = () => {
      this.ready = true
      this.replay()
    }
    // A reload or navigation starting means the renderer loses its state; hold events until it's back.
    const onStart = () => {
      this.ready = false
    }
    const onGone = () => {
      if (this.target === wc) {
        this.target = null
        this.ready = false
      }
    }
    wc.on('did-finish-load', onLoad)
    wc.on('did-start-loading', onStart)
    wc.on('render-process-gone', onStart)
    wc.once('destroyed', onGone)
    this.detach = () => {
      if (wc.isDestroyed()) return
      wc.off('did-finish-load', onLoad)
      wc.off('did-start-loading', onStart)
      wc.off('render-process-gone', onStart)
      wc.off('destroyed', onGone)
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, { event, seenAt }] of this.snapshot) {
      if (event.activity === 'done' && now - seenAt > DONE_TTL_MS) this.snapshot.delete(id)
    }
  }

  private replay(): void {
    this.prune()
    // Oldest first, but always send a parent before its children so the renderer never sees an
    // orphan whose manager hasn't spawned yet.
    const events = [...this.snapshot.values()].map((v) => v.event).sort((a, b) => a.ts - b.ts)
    const sent = new Set<string>()
    const visit = (e: AgentEvent, depth: number) => {
      if (sent.has(e.agentId)) return
      const parent = e.parentId ? this.snapshot.get(e.parentId)?.event : undefined
      if (parent && depth < 32) visit(parent, depth + 1)
      if (sent.has(e.agentId)) return
      sent.add(e.agentId)
      this.send(e)
    }
    for (const e of events) visit(e, 0)
  }

  private send(e: AgentEvent): void {
    const wc = this.target
    if (!wc || wc.isDestroyed()) return
    wc.send(IPC.event, e)
  }
}
