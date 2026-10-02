// The selected session's live terminal: header (title, folder, state, Interrupt / Stop), a banner
// when the session needs the terminal or has exited, and the xterm instance itself.
import { useEffect, useRef, useState } from 'react'
import { useApp, useAppState } from '../controller'
import { shortenPath, STATE_LABEL } from '../format'
import { cx } from '../hooks'
import { IconAlert, IconInterrupt, IconPlus, IconStop, IconTerminal } from '../icons'
import { StateDot, Swatch } from './Sidebar'

export function TerminalView({ hidden }: { hidden: boolean }) {
  const app = useApp()
  const selectedId = useAppState((s) => s.selectedId)
  const sessions = useAppState((s) => s.sessions)
  const teams = useAppState((s) => s.teams)
  const providers = useAppState((s) => s.providers)
  const overlay = useAppState((s) => s.settings?.overlay ?? false)
  const mount = useRef<HTMLDivElement>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  const session = sessions.find((s) => s.id === selectedId) ?? null
  const team = teams.find((t) => t.id === selectedId) ?? null
  const sessionId = session?.id ?? null

  useEffect(() => {
    mount.current?.append(app.terminals.root)
    return () => app.terminals.root.remove()
  }, [app])

  // Overlay mode hides the shell: don't hold a terminal attached that nobody can see.
  useEffect(() => {
    app.terminals.show(overlay ? null : sessionId)
    setConfirmStop(false)
  }, [app, sessionId, overlay])

  useEffect(() => {
    if (!hidden) app.terminals.scheduleFit(0)
  }, [app, hidden])

  const running = session && session.state !== 'exited'

  return (
    <div className="termview" hidden={hidden}>
      {session && (
        <header className="term-head">
          <Swatch color={team?.color} />
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
                  disabled={!running}
                  onClick={() => {
                    app.interrupt(session.id)
                    app.terminals.focus()
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
      )}

      {session?.state === 'needs-attention' && (
        <div className="term-banner is-warn" role="status">
          <IconAlert />
          <span>
            <strong>{providers.find((p) => p.id === session.provider)?.label ?? 'The agent'} is asking something here.</strong> Answer in the
            terminal below.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => app.terminals.focus()}>
            Focus terminal
          </button>
        </div>
      )}
      {session?.state === 'exited' && (
        <div className="term-banner" role="status">
          <span>
            <strong>Session ended</strong>
            {session.exitCode === null || session.exitCode === undefined ? '.' : ` with exit code ${session.exitCode}.`} The output below is kept
            until you remove it.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => app.removeSession(session.id)}>
            Remove from list
          </button>
        </div>
      )}

      <div className={cx('term-mount', !session && 'is-hidden')} ref={mount} />

      {!session && (
        <div className="panel-empty">
          <span className="panel-empty-icon">
            <IconTerminal size={22} />
          </span>
          {team ? (
            <>
              <p className="panel-empty-title">{team.name} runs outside Agent Office</p>
              <p>Its terminal isn't hosted here. The app shows its activity, but you answer it where it was started.</p>
            </>
          ) : sessions.length > 0 ? (
            <>
              <p className="panel-empty-title">No session selected</p>
              <p>
                Pick a session on the left, or press <kbd>Ctrl</kbd> <kbd>1</kbd>.
              </p>
            </>
          ) : (
            <>
              <p className="panel-empty-title">No sessions yet</p>
              <p>Start an agent in a folder and its terminal appears here.</p>
              <button type="button" className="btn btn-primary" onClick={() => app.openNewSession()}>
                <IconPlus />
                New session
                <kbd>Ctrl N</kbd>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
