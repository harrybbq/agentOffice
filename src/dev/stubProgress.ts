// DEV / PREVIEW ONLY: the progress bars of the stub bridge (./stubBridge.ts). It runs the REAL
// tracker of the main process (electron/progress.ts: pure, no Electron, no Node), fed by the stub's
// fake sessions, so the preview shows what the app would: a plan-based bar, a helper-based one, an
// indeterminate one and an order across three teams.
//
// URL parameters: ?progress=none (a main process from before the progress bars) · ?progress=quiet
// (the bars follow the fake sessions, but no demo plan, helpers or order are played).
import { ProgressTracker } from '../../electron/progress'
import type { TurnEnd } from '../../electron/progress'
import type { AgentEvent } from '../../shared/events'
import type { AgentOfficeBridge } from '../../shared/ipc'
import type { ProgressSnapshot, ProgressStep } from '../../shared/progress'
import type { SessionInfo } from '../../shared/sessions'

/** The demo plan of the first team: a refactor in seven steps. */
export const DEMO_PLAN: readonly string[] = [
  'Read the session list code',
  'Sketch the shape of the store',
  'Move the list state into the store',
  'Update the sidebar to read from the store',
  'Update the order bar targets',
  'Run the type check and the tests',
  'Write the summary'
]

/** The demo plan with the first `done` steps completed and the next one in progress. */
export function demoSteps(done: number, plan: readonly string[] = DEMO_PLAN): ProgressStep[] {
  return plan.map((text, i) => ({ text, status: i < done ? 'completed' : i === done ? 'in-progress' : 'pending' }))
}

export interface ProgressStub {
  tracker: ProgressTracker
  /** `undefined` with ?progress=none. */
  bridge: AgentOfficeBridge['progress']
  /** Play the demo plan / helpers / order? */
  demo: boolean
  /** The fake sessions as they are now: titles and states follow, sessions that are gone are forgotten. */
  sync(list: readonly SessionInfo[]): void
  event(e: AgentEvent): void
  /** A fake turn starts with a real prompt. */
  prompt(sessionId: string): void
  /** A fake turn is over (call before the session goes idle). */
  turnEnd(sessionId: string, how?: TurnEnd): void
}

export function createProgressStub(mode: string | null): ProgressStub {
  const cbs = new Set<(s: ProgressSnapshot) => void>()
  const tracker = new ProgressTracker({ onChanged: (s) => cbs.forEach((cb) => cb(s)) })
  const known = new Set<string>()
  return {
    tracker,
    demo: mode !== 'none' && mode !== 'quiet',
    bridge:
      mode === 'none'
        ? undefined
        : {
            get: async () => tracker.snapshot(),
            onChanged: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
            dismissOrder: async (id) => tracker.dismissOrder(id)
          },
    sync(list) {
      const now = new Set(list.map((s) => s.id))
      for (const id of [...known]) {
        if (now.has(id)) continue
        known.delete(id)
        tracker.forget(id)
      }
      for (const s of list) {
        known.add(s.id)
        tracker.session(s.id, s.title)
        tracker.state(s.id, s.state)
      }
    },
    event: (e) => tracker.event(e),
    prompt: (id) => tracker.prompt(id),
    turnEnd: (id, how = 'completed') => tracker.signal(id, { kind: 'turn-end', how })
  }
}
