// The state of one hosted session (SessionState in shared/sessions.ts), derived from hooks, the
// pending permission count, the terminal title and process exit. Pure apart from the injected
// scheduler, so the tests can drive time by hand.
//
// starting ──4 s without SessionStart──▶ needs-attention   (folder trust / login: the user answers
//    │                                         │             in the terminal pane)
//    └────────────── SessionStart ─────────────┴──▶ idle
// idle ──UserPromptSubmit / PreToolUse──▶ busy ──Stop──▶ idle
// busy ◀──▶ waiting-permission (while a permission request is pending)
// busy ──title shows the idle glyph for a while──▶ idle   (Stop doesn't fire after Esc / Ctrl+C)
// anything ──process exit──▶ exited
import type { SessionState } from '../../shared/sessions'

export const START_ATTENTION_MS = 4000
export const TITLE_IDLE_DEBOUNCE_MS = 2500

/** What the terminal title says: Claude Code shows `✳` when waiting for input, a spinner when working. */
export type TitleHint = 'idle' | 'busy'

/** Runs `fn` after `ms`; returns a cancel function. */
export type Scheduler = (fn: () => void, ms: number) => () => void

const realScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export function titleHint(title: string): TitleHint | null {
  const first = [...title.trimStart()][0] ?? ''
  if (first === '✳') return 'idle'
  // ◐ ◑ were observed; the other quarter circles and braille spinners are the usual alternatives.
  if (/^[◐◑◒◓⠀-⣿]$/u.test(first)) return 'busy'
  return null
}

export class SessionStateMachine {
  private current: SessionState = 'starting'
  private pending = 0
  private hint: TitleHint | null = null
  private cancelAttention: (() => void) | null = null
  private cancelIdle: (() => void) | null = null

  constructor(
    private onChange: (state: SessionState, previous: SessionState) => void,
    private schedule: Scheduler = realScheduler
  ) {
    this.cancelAttention = this.schedule(() => {
      this.cancelAttention = null
      if (this.current === 'starting') this.set('needs-attention')
    }, START_ATTENTION_MS)
  }

  get state(): SessionState {
    return this.current
  }

  /** The SessionStart hook arrived: the CLI is past its start-up dialogs and takes input. */
  ready(): void {
    this.stopAttention()
    if (this.current === 'starting' || this.current === 'needs-attention') this.set('idle')
  }

  /** A turn is running: UserPromptSubmit, PreToolUse or PostToolUse. */
  activity(): void {
    this.stopAttention()
    this.set(this.pending > 0 ? 'waiting-permission' : 'busy')
    this.armIdle()
  }

  /** Stop hook: the turn is over. */
  turnEnded(): void {
    this.stopAttention()
    this.pending = 0
    this.set('idle')
  }

  /** Number of permission requests pending for this session. */
  permissions(count: number): void {
    this.pending = Math.max(0, count)
    if (this.current === 'exited') return
    if (this.pending > 0) {
      this.stopAttention()
      this.set('waiting-permission')
    } else if (this.current === 'waiting-permission') {
      // Allowed, denied, or dismissed in the terminal. The turn goes on unless the title says
      // otherwise for a while (Esc on the dialog ends the turn without a Stop hook).
      this.set('busy')
      this.armIdle()
    }
  }

  /** The terminal title changed. Only `busy` listens to it, and only after a debounce. */
  title(hint: TitleHint | null): void {
    if (hint === null) return
    this.hint = hint
    this.armIdle()
  }

  exited(): void {
    this.stopAttention()
    this.stopIdle()
    this.set('exited')
  }

  dispose(): void {
    this.stopAttention()
    this.stopIdle()
  }

  private set(next: SessionState): void {
    const prev = this.current
    if (prev === next || prev === 'exited') return
    this.current = next
    if (next !== 'busy') this.stopIdle()
    this.onChange(next, prev)
  }

  /** (Re)starts the "title says idle while we think busy" timer; any sign of work restarts it. */
  private armIdle(): void {
    this.stopIdle()
    if (this.current !== 'busy' || this.hint !== 'idle') return
    this.cancelIdle = this.schedule(() => {
      this.cancelIdle = null
      if (this.current === 'busy' && this.hint === 'idle') this.set('idle')
    }, TITLE_IDLE_DEBOUNCE_MS)
  }

  private stopIdle(): void {
    this.cancelIdle?.()
    this.cancelIdle = null
  }

  private stopAttention(): void {
    this.cancelAttention?.()
    this.cancelAttention = null
  }
}
