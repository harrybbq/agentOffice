// The header above a session's terminal or chat: title, folder, state, mode / model chips and
// Interrupt / Stop (Stop asks once).
import { useEffect, useState } from 'react'
import type { SessionInfo } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { shortenPath, STATE_LABEL } from '../format'
import { cx } from '../hooks'
import { IconInterrupt, IconStop } from '../icons'
import { HeaderProgress } from './Progress'
import { StateDot, Swatch } from './Sidebar'

export function SessionHeader({ session, onInterrupted }: { session: SessionInfo; onInterrupted?: () => void }) {
  const app = useApp()
  const color = useAppState((s) => s.teams.find((t) => t.id === session.id)?.color)
  const [confirmStop, setConfirmStop] = useState(false)
  const running = session.state !== 'exited'
  const inTurn = session.state === 'busy' || session.state === 'waiting-permission'

  useEffect(() => setConfirmStop(false), [session.id])

  return (
    <header className="term-head">
      <Swatch color={color} />
      <div className="term-id">
        <span className="term-title">{session.title}</span>
        <span className="term-cwd" title={session.cwd}>
          {shortenPath(session.cwd, 3)}
        </span>
      </div>
      <span className={cx('state-chip', `state-chip-${session.state}`)}>
        <StateDot state={session.state} />
        {STATE_LABEL[session.state]}
      </span>
      <HeaderProgress sessionId={session.id} color={color} />
      <span className="term-meta">
        {session.permissionMode !== 'default' && (
          <span className="meta-chip" title="Permission mode">
            {session.permissionMode}
          </span>
        )}
        {session.model && (
          <span className="meta-chip" title="Model">
            {session.model}
          </span>
        )}
      </span>
      <div className="term-actions">
        {confirmStop ? (
          <>
            <span className="term-confirm">Stop this session?</span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              autoFocus
              onClick={() => {
                setConfirmStop(false)
                app.stop(session.id)
              }}
            >
              Stop
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmStop(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              // A terminal session can always take Esc; a chat session only has a turn to interrupt.
              disabled={session.surface === 'chat' ? !inTurn : !running}
              onClick={() => {
                app.interrupt(session.id)
                onInterrupted?.()
              }}
              title="Interrupt the running turn (Esc)"
            >
              <IconInterrupt />
              Interrupt
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!running} onClick={() => setConfirmStop(true)} title="Stop the session">
              <IconStop />
              Stop
            </button>
          </>
        )}
      </div>
    </header>
  )
}
