// Live, filterable stream of AgentEvents. Rows select the agent's session, and the agent itself
// for the inspector.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ACTIVITIES } from '../../../shared/events'
import type { Activity } from '../../../shared/events'
import { useApp, useAppState } from '../controller'
import { clock, filterLog } from '../format'
import { cx } from '../hooks'
import { IconSearch } from '../icons'
import { Swatch } from './Sidebar'

export function EventLog({ hidden }: { hidden: boolean }) {
  const app = useApp()
  const log = useAppState((s) => s.log)
  const teams = useAppState((s) => s.teams)
  const selectedId = useAppState((s) => s.selectedId)
  const [text, setText] = useState('')
  const [off, setOff] = useState<ReadonlySet<Activity>>(new Set())
  const [onlySelected, setOnlySelected] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const rows = useMemo(
    () =>
      hidden
        ? []
        : filterLog(log, {
            text,
            activities: off.size > 0 ? new Set(ACTIVITIES.filter((a) => !off.has(a))) : null,
            teamId: onlySelected ? selectedId : null
          }),
    [hidden, log, text, off, onlySelected, selectedId]
  )

  // Follow the tail unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [rows])

  const toggle = (a: Activity) =>
    setOff((prev) => {
      const next = new Set(prev)
      if (next.has(a)) next.delete(a)
      else next.add(a)
      return next
    })

  return (
    <div className="eventlog" hidden={hidden}>
      <div className="log-filters">
        <label className="log-search">
          <IconSearch size={14} />
          <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Filter events" aria-label="Filter events" spellCheck={false} />
        </label>
        <div className="log-chips" role="group" aria-label="Activities">
          {ACTIVITIES.map((a) => (
            <button key={a} type="button" className={cx('chip', `act-${a}`, off.has(a) && 'is-off')} aria-pressed={!off.has(a)} onClick={() => toggle(a)}>
              {a}
            </button>
          ))}
        </div>
        <label className="log-only" title="Only the selected session">
          <input type="checkbox" checked={onlySelected} onChange={(ev) => setOnlySelected(ev.target.checked)} />
          Selected only
        </label>
      </div>
      <div
        className="log-scroll"
        ref={scroller}
        onScroll={(ev) => {
          const el = ev.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {rows.length === 0 ? (
          <p className="log-empty">{log.length === 0 ? 'No events yet. They appear here as agents work.' : 'No events match the filter.'}</p>
        ) : (
          <table className="log-table">
            <tbody>
              {rows.map((l) => (
                <tr key={l.seq} className={cx(l.teamId === selectedId && 'is-selected')} onClick={() => {
                    app.select(l.teamId, { reveal: false, inspect: false })
                    app.inspectAgent(l.event.agentId)
                  }}
                >
                  <td className="log-time">{clock(l.event.ts)}</td>
                  <td className="log-agent">
                    <Swatch color={teams.find((t) => t.id === l.teamId)?.color} />
                    <span>{l.event.displayName}</span>
                  </td>
                  <td>
                    <span className={cx('chip chip-static', `act-${l.event.activity}`)}>{l.event.activity}</span>
                  </td>
                  <td className="log-detail" title={l.event.detail}>
                    {l.event.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
