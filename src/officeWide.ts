// Office-wide CEO order state. Lives at the renderer level (not in the scene) so theme/overlay
// rebuilds keep it. Pure logic (no DOM, no Phaser).
//
// Starts when an order to the whole office is delivered to at least one session (or via the dev
// flag). Ends when every team that received it has reported `idle` or `done` for its manager, after
// the timeout, or when the user ends it.
import type { AgentEvent } from '../shared/events'

export const DEFAULT_OFFICE_WIDE_MS = 10 * 60_000

export class OfficeWide {
  active = false
  /** Teams still working on the order; null = no tracking (dev flag): only timeout / manual end. */
  private pending: Set<string> | null = null
  private until = 0

  constructor(public timeoutMs = DEFAULT_OFFICE_WIDE_MS) {}

  start(teams: string[] | null, now = Date.now()): void {
    this.active = true
    this.pending = teams ? new Set(teams) : null
    this.until = now + this.timeoutMs
  }

  /** Feeds every incoming event; returns true if this event ended the mode. */
  observe(e: AgentEvent): boolean {
    if (!this.active || !this.pending || e.parentId !== null) return false
    if (e.activity !== 'idle' && e.activity !== 'done') return false
    if (!this.pending.delete(e.agentId)) return false
    if (this.pending.size > 0) return false
    this.end()
    return true
  }

  /** Returns true if the timeout just ended the mode. */
  check(now = Date.now()): boolean {
    if (!this.active || now < this.until) return false
    this.end()
    return true
  }

  remainingMs(now = Date.now()): number {
    return this.active ? Math.max(0, this.until - now) : 0
  }

  /** Teams that haven't reported back yet (null when untracked). */
  get waitingOn(): string[] | null {
    return this.pending ? [...this.pending] : null
  }

  end(): void {
    this.active = false
    this.pending = null
    this.until = 0
  }
}
