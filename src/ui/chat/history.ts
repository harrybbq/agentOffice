// Prompt recall for the chat composer (Up / Down), per session and in memory only.
// Pure; covered by tests/chat.test.ts.

export class PromptHistory {
  private entries: string[] = []
  /** -1 = editing the draft; otherwise an index into `entries` (0 = oldest). */
  private cursor = -1
  private draft = ''

  constructor(private readonly cap = 50) {}

  get size(): number {
    return this.entries.length
  }

  /** Is an older prompt being shown (so Down has somewhere to go)? */
  get browsing(): boolean {
    return this.cursor >= 0
  }

  /** Remembers a sent prompt (not twice in a row) and leaves browse mode. */
  push(text: string): void {
    const t = text.trim()
    this.cursor = -1
    this.draft = ''
    if (!t || this.entries[this.entries.length - 1] === t) return
    this.entries.push(t)
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap)
  }

  /** The prompt before the one shown, or null at the oldest. `current` is kept as the draft. */
  prev(current: string): string | null {
    if (this.entries.length === 0) return null
    if (this.cursor < 0) {
      this.draft = current
      this.cursor = this.entries.length - 1
    } else if (this.cursor > 0) {
      this.cursor--
    } else {
      return null
    }
    return this.entries[this.cursor]
  }

  /** The newer prompt, then the draft that was being typed; null when not browsing. */
  next(): string | null {
    if (this.cursor < 0) return null
    if (this.cursor < this.entries.length - 1) return this.entries[++this.cursor]
    this.cursor = -1
    return this.draft
  }

  /** The user edited the text: the next Up starts from the newest prompt again. */
  reset(): void {
    this.cursor = -1
    this.draft = ''
  }
}
