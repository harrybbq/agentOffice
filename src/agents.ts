// Scene-independent record of live agents: survives game recreation (theme / overlay change)
// and feeds the inbox's waiting list.
import type { AgentEvent } from '../shared/events'

export interface WaitingInfo {
  agentId: string
  /** Top-level session (team) this agent belongs to. */
  teamId: string
  displayName: string
  detail: string
  since: number
}

export class AgentStore {
  eventCount = 0
  lastEventAt: number | null = null
  /** Last event per live agent, in first-seen order. */
  private live = new Map<string, AgentEvent>()
  private waitingMap = new Map<string, WaitingInfo>()

  apply(e: AgentEvent): void {
    this.eventCount++
    this.lastEventAt = Date.now()
    if (e.activity === 'waiting') {
      const prev = this.waitingMap.get(e.agentId)
      this.waitingMap.set(e.agentId, {
        agentId: e.agentId,
        teamId: this.rootOf(e),
        displayName: e.displayName,
        detail: e.detail,
        since: prev?.since ?? Date.now()
      })
    } else {
      this.waitingMap.delete(e.agentId)
    }
    if (e.activity === 'done') {
      this.drop(e.agentId, e.parentId === null)
    } else {
      this.live.set(e.agentId, e)
    }
  }

  get waiting(): WaitingInfo[] {
    return [...this.waitingMap.values()].sort((a, b) => a.since - b.since)
  }

  /** Events that rebuild the current roster in a fresh scene. */
  replay(): AgentEvent[] {
    return [...this.live.values()]
  }

  /** Follows parentIds through live agents to the top-level session. */
  rootOf(e: Pick<AgentEvent, 'agentId' | 'parentId'>): string {
    let id = e.agentId
    let parent = e.parentId
    for (let guard = 0; parent && guard < 32; guard++) {
      id = parent
      parent = this.live.get(parent)?.parentId ?? null
    }
    return id
  }

  private drop(id: string, cascade: boolean): void {
    this.live.delete(id)
    this.waitingMap.delete(id)
    if (!cascade) return
    // A session ending takes its whole subagent tree with it.
    for (const e of [...this.live.values()]) {
      if (e.parentId === id) this.drop(e.agentId, true)
    }
  }
}
