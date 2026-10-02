// The preview pane's own small store: what it remembers (open, width, device, pin) and what the
// main process says about each session's preview. Kept apart from the app controller on purpose:
// the pane is one self-contained feature. The pure logic lives in ./preview.ts.
import type { AgentOfficeBridge } from '../../shared/ipc'
import type { PreviewBlocked, PreviewBridge, PreviewInfo } from '../../shared/preview'
import { PANE_DEFAULT, paneReducer, parsePaneState, type PaneAction, type PaneState } from './preview'
import { Store } from './store'

const PANE_KEY = 'agentOffice.preview'

export interface PreviewState {
  pane: PaneState
  /** The preview of each session that has one. */
  infos: Readonly<Record<string, PreviewInfo>>
  /** When each session's page last changed (a reload hint, or it became reachable). */
  updatedAt: Readonly<Record<string, number>>
  /** Counts the updates per session: the status dot pulses when it changes. */
  pulses: Readonly<Record<string, number>>
  /** Sessions in whose output a web server address was seen while the pane was closed. */
  found: Readonly<Record<string, true>>
  /** The last time the page in the frame was stopped from leaving (`seq` makes each one new). */
  blocked: (PreviewBlocked & { seq: number }) | null
}

function readPane(): PaneState {
  try {
    const raw = localStorage.getItem(PANE_KEY)
    return raw ? parsePaneState(JSON.parse(raw)) : PANE_DEFAULT
  } catch {
    return PANE_DEFAULT
  }
}

export class PreviewController {
  readonly store: Store<PreviewState>
  /** Called when a session's output showed a new address (the empty state looks again). */
  private detectedListeners = new Set<(sessionId: string) => void>()

  constructor(readonly bridge: PreviewBridge | undefined) {
    this.store = new Store<PreviewState>({ pane: readPane(), infos: {}, updatedAt: {}, pulses: {}, found: {}, blocked: null })
    if (!bridge) return
    bridge.onChanged((info) => this.apply(info))
    bridge.onReload((id) => this.touch(id))
    bridge.onBlocked?.((b) => this.store.set((s) => ({ blocked: { ...b, seq: (s.blocked?.seq ?? 0) + 1 } })))
    bridge.onDetected((id) => {
      if (!this.store.get().pane.open) this.store.set((s) => ({ found: { ...s.found, [id]: true } }))
      for (const l of [...this.detectedListeners]) l(id)
    })
  }

  dispatch(action: PaneAction, persist = true): void {
    const next = paneReducer(this.store.get().pane, action)
    this.store.set({ pane: next, ...(next.open ? { found: {} } : {}) })
    if (persist) this.save()
  }

  save(): void {
    try {
      localStorage.setItem(PANE_KEY, JSON.stringify(this.store.get().pane))
    } catch {
      /* storage unavailable: the pane just starts closed next time */
    }
  }

  onDetected(cb: (sessionId: string) => void): () => void {
    this.detectedListeners.add(cb)
    return () => this.detectedListeners.delete(cb)
  }

  /** A PreviewInfo from the main process (an event, or the answer of a call). */
  apply(info: PreviewInfo): void {
    const before = this.store.get().infos[info.sessionId]
    if (info.status === 'stopped') {
      if (!before) return
      this.store.set((s) => {
        const infos = { ...s.infos }
        delete infos[info.sessionId]
        return { infos }
      })
      return
    }
    this.store.set((s) => ({ infos: { ...s.infos, [info.sessionId]: info } }))
    // It just became reachable: that is an update worth a pulse.
    if (info.status === 'ready' && before?.status !== 'ready') this.touch(info.sessionId)
  }

  /** The session has no preview (asked the main process): forget what we thought. */
  clear(sessionId: string): void {
    if (!this.store.get().infos[sessionId]) return
    this.store.set((s) => {
      const infos = { ...s.infos }
      delete infos[sessionId]
      return { infos }
    })
  }

  private touch(sessionId: string): void {
    this.store.set((s) => ({
      updatedAt: { ...s.updatedAt, [sessionId]: Date.now() },
      pulses: { ...s.pulses, [sessionId]: (s.pulses[sessionId] ?? 0) + 1 }
    }))
  }

  /** The session list changed: forget sessions that are gone (the main process ended their previews). */
  sessions(ids: readonly string[]): void {
    const s = this.store.get()
    const keep = <T,>(rec: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
      const gone = Object.keys(rec).filter((id) => !ids.includes(id))
      if (gone.length === 0) return rec
      const next = { ...rec }
      for (const id of gone) delete next[id]
      return next
    }
    this.store.set({ infos: keep(s.infos), updatedAt: keep(s.updatedAt), pulses: keep(s.pulses), found: keep(s.found) })
    const pane = paneReducer(s.pane, { type: 'sessions', ids })
    if (pane !== s.pane) {
      this.store.set({ pane })
      this.save()
    }
  }
}

const controllers = new WeakMap<AgentOfficeBridge, PreviewController>()

/** One controller per bridge (so: one per app). */
export function previewController(bridge: AgentOfficeBridge): PreviewController {
  let c = controllers.get(bridge)
  if (!c) controllers.set(bridge, (c = new PreviewController(bridge.preview)))
  return c
}
