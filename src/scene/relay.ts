// Memo relay bookkeeping: only managers go to the CEO's reception. Pure logic (no Phaser).
//
// - A waiting worker carries its memo to its manager's office ('manager') and waits there. Once it
//   has arrived (delivered), the team's manager takes the memo(s) to the HQ inbox.
// - A waiting manager ('self') goes to the HQ inbox itself.
// - During an office-wide order a worker may take its memo straight to the HQ ('hq'); that memo
//   doesn't need the manager.
// The manager stays at the HQ while any relayed memo of its team (or its own) is open, then goes
// home. Its own non-waiting events meanwhile are collapsed to the latest and applied afterwards.

export type MemoRoute = 'self' | 'manager' | 'hq'

interface Memo {
  teamId: string
  route: MemoRoute
  /** Has reached the manager's office (always true for 'self' and 'hq'). */
  delivered: boolean
}

export type RelayStep = 'start' | 'stop' | 'update' | null

export class RelayBook<D = unknown> {
  private memos = new Map<string, Memo>()
  private relaying = new Set<string>()
  private deferred = new Map<string, D>()

  /** Records (or re-routes) an open memo. 'self' and 'hq' memos count as delivered at once. */
  open(agentId: string, teamId: string, route: MemoRoute): void {
    this.memos.set(agentId, { teamId, route, delivered: route !== 'manager' })
  }

  /** The worker reached the manager's office with its memo. */
  deliver(agentId: string): void {
    const m = this.memos.get(agentId)
    if (m) m.delivered = true
  }

  /** The agent is no longer waiting (or left). */
  close(agentId: string): void {
    this.memos.delete(agentId)
  }

  route(agentId: string): MemoRoute | null {
    return this.memos.get(agentId)?.route ?? null
  }

  isOpen(agentId: string): boolean {
    return this.memos.has(agentId)
  }

  /** Every open memo of a team, any route (the HUD lists each). */
  waitingIn(teamId: string): string[] {
    return [...this.memos].filter(([, m]) => m.teamId === teamId).map(([id]) => id)
  }

  /** Memos the team's manager has to carry to the HQ (delivered worker memos + its own). */
  relayCount(teamId: string): number {
    let n = 0
    for (const m of this.memos.values()) {
      if (m.teamId === teamId && m.delivered && m.route !== 'hq') n++
    }
    return n
  }

  /** Delivered worker memos only (the manager's own memo excluded). */
  workerMemos(teamId: string): number {
    let n = 0
    for (const m of this.memos.values()) if (m.teamId === teamId && m.delivered && m.route === 'manager') n++
    return n
  }

  isRelaying(teamId: string): boolean {
    return this.relaying.has(teamId)
  }

  /**
   * What the team's manager should do now. `managerPresent` = on the roster, has a character and
   * isn't leaving. 'start' = walk to the HQ inbox; 'stop' = go home (then apply anything deferred);
   * 'update' = still relaying (badge count may have changed); null = nothing to do.
   */
  step(teamId: string, managerPresent: boolean): RelayStep {
    const need = managerPresent && this.relayCount(teamId) > 0
    const was = this.relaying.has(teamId)
    if (need && !was) {
      this.relaying.add(teamId)
      return 'start'
    }
    if (!need && was) {
      this.relaying.delete(teamId)
      return 'stop'
    }
    return need ? 'update' : null
  }

  /**
   * A non-waiting event for the manager arrived. Its own memo closes. If it is still relaying for its
   * workers, the event is deferred (keeping only the latest) and true is returned.
   */
  deferManagerEvent(teamId: string, event: D): boolean {
    this.close(teamId)
    if (!this.relaying.has(teamId) || this.workerMemos(teamId) === 0) return false
    this.deferred.set(teamId, event)
    return true
  }

  /** Defers an item for the manager (e.g. what it had queued when the relay started). */
  setDeferred(teamId: string, item: D): void {
    this.deferred.set(teamId, item)
  }

  /** The latest deferred manager event, removed. */
  takeDeferred(teamId: string): D | undefined {
    const d = this.deferred.get(teamId)
    this.deferred.delete(teamId)
    return d
  }

  /** The team is gone (manager left): forget everything about it. */
  dropTeam(teamId: string): void {
    this.relaying.delete(teamId)
    this.deferred.delete(teamId)
    for (const [id, m] of this.memos) if (m.teamId === teamId) this.memos.delete(id)
  }
}
