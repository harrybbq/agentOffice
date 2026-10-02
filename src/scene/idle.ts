// Who has had nothing to do for long enough to wander off to the theme's idle location (a lounge,
// a yard) and who is there now. Pure logic (no Phaser); the scene decides who is eligible.
//
// - Any real activity (not `idle`) restarts a character's clock and ends its rest.
// - An `idle` event never restarts the clock: an agent that keeps reporting "idle" still rests.

export class IdleClock {
  /** When each character last did something (or arrived). */
  private busyAt = new Map<string, number>()
  private resting = new Set<string>()

  constructor(
    /** Rest after this long without activity; <= 0 or not finite = never. */
    readonly afterMs: number
  ) {}

  get enabled(): boolean {
    return Number.isFinite(this.afterMs) && this.afterMs > 0
  }

  /** The character arrived or did something: its clock restarts and its rest (if any) is over. */
  touch(id: string, now: number): void {
    this.busyAt.set(id, now)
    this.resting.delete(id)
  }

  /** The character is known but has not done anything yet (keeps an existing clock). */
  track(id: string, now: number): void {
    if (!this.busyAt.has(id)) this.busyAt.set(id, now)
  }

  forget(id: string): void {
    this.busyAt.delete(id)
    this.resting.delete(id)
  }

  isResting(id: string): boolean {
    return this.resting.has(id)
  }

  /** The rest could not happen or was cut short (no such location, sent elsewhere). */
  endRest(id: string): void {
    this.resting.delete(id)
  }

  /**
   * Characters whose rest starts now: idle for afterMs, not resting yet and `eligible` (the scene
   * rules out the boss, anyone waiting, leaving or mid-action). They are marked as resting.
   */
  due(now: number, eligible: (id: string) => boolean): string[] {
    if (!this.enabled) return []
    const out: string[] = []
    for (const [id, at] of this.busyAt) {
      if (this.resting.has(id) || now - at < this.afterMs || !eligible(id)) continue
      this.resting.add(id)
      out.push(id)
    }
    return out
  }
}
