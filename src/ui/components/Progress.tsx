// Progress bars (shared/progress.ts): the bar itself, a session's bar in the sidebar row and in the
// terminal / chat header, the Inspect tab's "Progress" block, and the bar of a major task (an order
// that several teams work on) at the top of the world. What each one says is decided by the pure
// selectors in ui/progress.ts; a bar is determinate only when there is a real count behind it.
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { OrderProgress, SessionProgress } from '../../../shared/progress'
import { useApp, useAppState } from '../controller'
import { cx } from '../hooks'
import { IconCheck, IconChevron, IconClose, IconMegaphone } from '../icons'
import { barView, orderBars, orderView, rowBar, rowStateText, STEP_GLYPH, STEPS_COLLAPSED, stepWindow } from '../progress'
import type { BarView } from '../progress'

/** The bar. `color`: the team colour of a determinate fill (default: the accent). */
export function ProgressBar({ view, color, className, label }: { view: BarView; color?: string; className?: string; label?: string }) {
  const percent = Math.round(view.fraction * 100)
  const determinate = view.mode === 'determinate'
  return (
    <span
      className={cx('pbar', `is-${view.mode}`, `is-${view.tone}`, className)}
      role="progressbar"
      aria-label={label ?? 'Progress'}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? percent : undefined}
      aria-valuetext={view.tooltip}
      title={view.tooltip}
      style={color ? ({ '--pbar-color': color } as CSSProperties) : undefined}
    >
      <span className="pbar-fill" style={determinate ? { width: `${view.fraction * 100}%` } : undefined} />
    </span>
  )
}

/** A session's progress and whether it waits on the user right now. */
function useSessionBar(sessionId: string): { progress: SessionProgress | undefined; view: BarView | null } {
  const progress = useAppState((s) => s.progress[sessionId])
  const waiting = useAppState((s) => s.sessions.find((x) => x.id === sessionId)?.state === 'waiting-permission')
  return { progress, view: barView(progress, waiting) }
}

/** The thin bar under a session's row in the sidebar, with "3/7" at the right when there is a count. */
export function RowProgress({ sessionId, color }: { sessionId: string; color?: string }) {
  const { view } = useSessionBar(sessionId)
  if (!view) return null
  return (
    <span className="session-progress">
      <ProgressBar view={view} color={color} />
      {view.label && (
        <span className="session-progress-n" title={view.tooltip}>
          {view.label}
        </span>
      )}
    </span>
  )
}

/** In the terminal / chat header: the step in progress (or what the bar counts) over a tiny bar. */
export function HeaderProgress({ sessionId, color }: { sessionId: string; color?: string }) {
  const { view } = useSessionBar(sessionId)
  if (!view) return null
  const text = view.current ?? (view.mode === 'determinate' ? view.tooltip : '')
  return (
    <div className={cx('term-progress', `is-${view.tone}`)} title={view.current ? `${view.current}\n${view.tooltip}` : view.tooltip}>
      <span className="term-progress-line">
        <span className="term-progress-text">{text || 'Working'}</span>
        {view.label && <span className="term-progress-n">{view.label}</span>}
      </span>
      <ProgressBar view={view} color={color} />
    </div>
  )
}

/** The Inspect tab's block for a manager: the bar, the step in progress, the step list. */
export function InspectProgress({ sessionId, color }: { sessionId: string; color?: string }) {
  const { progress, view } = useSessionBar(sessionId)
  const [open, setOpen] = useState(false)
  if (!progress || !view) return null
  const steps = progress.steps ?? []
  const win = open ? { start: 0, end: steps.length, before: 0, after: 0 } : stepWindow(steps)
  const collapsible = steps.length > STEPS_COLLAPSED
  // The list holds at most PROGRESS_MAX_STEPS; the count is of them all.
  const unlisted = progress.kind === 'plan' ? Math.max(0, progress.total - steps.length) : 0

  return (
    <section className={cx('inspect-section inspect-progress', `is-${view.tone}`)} aria-label="Progress">
      <h3>
        Progress
        {view.label && <span className="group-count">{view.label}</span>}
      </h3>
      <ProgressBar view={view} color={color} className="pbar-lg" />
      <p className="inspect-progress-source">{view.tooltip}</p>
      {view.current && (
        <p className="inspect-progress-current">
          <span className="inspect-progress-now">{view.tone === 'stopped' ? 'Stopped at' : 'Now'}</span>
          {view.current}
        </p>
      )}
      {steps.length > 0 && (
        <>
          <ol className="progress-steps">
            {win.before > 0 && <li className="progress-steps-more">{win.before === 1 ? '1 earlier step' : `${win.before} earlier steps`}</li>}
            {steps.slice(win.start, win.end).map((s, i) => (
              <li key={`${win.start + i}-${s.text}`} className={cx('progress-step', `is-${s.status}`)}>
                <span className="progress-step-mark" role="img" aria-label={s.status === 'completed' ? 'Done' : s.status === 'in-progress' ? 'In progress' : 'To do'}>
                  {s.status === 'completed' ? <IconCheck size={12} /> : STEP_GLYPH[s.status]}
                </span>
                <span className="progress-step-text">{s.text}</span>
              </li>
            ))}
            {!open && win.after + unlisted > 0 && <li className="progress-steps-more">{win.after + unlisted === 1 ? '1 more step' : `${win.after + unlisted} more steps`}</li>}
            {open && unlisted > 0 && <li className="progress-steps-more">{unlisted === 1 ? '1 more step' : `${unlisted} more steps`} not listed</li>}
          </ol>
          {collapsible && (
            <button type="button" className={cx('card-toggle', open && 'is-open')} onClick={() => setOpen(!open)} aria-expanded={open}>
              <IconChevron size={12} />
              {open ? 'Show fewer' : `Show all ${steps.length} steps`}
            </button>
          )}
        </>
      )}
    </section>
  )
}

// ---- a major task: one order, several teams ------------------------------------------------------

/** A finished order says so for this long, then fades and goes. */
const FINISHED_SHOWN_MS = 6000
const FADE_MS = 500

function TaskBar({ order }: { order: OrderProgress }) {
  const app = useApp()
  const teams = useAppState((s) => s.teams)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>('shown')
  const view = orderView(order)
  const finished = order.finishedAt !== undefined

  // "All teams done" for a moment, then it fades and makes room.
  useEffect(() => {
    if (!finished) {
      setPhase('shown')
      return
    }
    const leave = window.setTimeout(() => setPhase('leaving'), FINISHED_SHOWN_MS)
    const go = window.setTimeout(() => setPhase('gone'), FINISHED_SHOWN_MS + FADE_MS)
    return () => {
      window.clearTimeout(leave)
      window.clearTimeout(go)
    }
  }, [finished])

  // Open, it stays until the user closes or dismisses it: they are reading it.
  if (phase === 'gone' && !open) return null
  const tone = !finished ? 'live' : view.allDone ? 'finished' : 'stopped'

  return (
    <section className={cx('task-bar', finished && 'is-finished', view.allDone && 'is-all-done', open && 'is-open', phase === 'leaving' && !open && 'is-leaving')} aria-label="Order in progress">
      <div className="task-head">
        <button type="button" className="task-toggle" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the teams' : 'Show each team'}>
          <IconChevron size={12} />
          {view.allDone ? <IconCheck size={14} /> : <IconMegaphone size={14} />}
          <span className="task-text">{order.text}</span>
          <span className="task-count">{view.label}</span>
        </button>
        <button type="button" className="icon-btn task-close" onClick={() => app.dismissOrder(order.id)} title="Dismiss" aria-label="Dismiss this order's progress">
          <IconClose size={12} />
        </button>
      </div>
      <ProgressBar view={{ mode: 'determinate', fraction: view.fraction, tone, label: '', tooltip: view.tooltip }} className="pbar-lg" label="Order progress" />
      {open && (
        <ul className="task-teams">
          {order.sessions.map((row) => {
            const bar = rowBar(row)
            const color = teams.find((t) => t.id === row.sessionId)?.color
            return (
              <li key={row.sessionId}>
                <button type="button" className={cx('task-team', `is-${row.state}`)} onClick={() => app.select(row.sessionId, { focusTerminal: false })} title={`${row.title}: ${rowStateText(row)}${bar ? `\n${bar.tooltip}` : ''}\nClick to select this team`}>
                  <span className={cx('swatch', !color && 'swatch-empty')} style={color ? { background: color } : undefined} aria-hidden="true" />
                  <span className="task-team-name">{row.title}</span>
                  {bar && <ProgressBar view={bar} color={color} />}
                  <span className="task-team-n">{bar?.label}</span>
                  <span className="task-team-state">{rowStateText(row)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** The bars of the orders that several teams are working on (top of the world). */
export function TaskProgress() {
  const orders = useAppState((s) => s.orders)
  const shown = orderBars(orders)
  if (shown.length === 0) return null
  return (
    <>
      {shown.map((o) => (
        <TaskBar key={o.id} order={o} />
      ))}
    </>
  )
}
