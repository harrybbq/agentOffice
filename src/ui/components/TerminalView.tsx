// The selected session's live terminal: header (title, folder, state, Interrupt / Stop), a banner
// when the session needs the terminal or has exited, and the xterm instance itself.
// Sessions with a chat surface are shown by ChatView instead; this view then holds no terminal.
import { useEffect, useRef } from 'react'
import { useApp, useAppState } from '../controller'
import { cx } from '../hooks'
import { IconAlert, IconPlus, IconTerminal } from '../icons'
import { SessionHeader } from './SessionHeader'

export function TerminalView({ hidden }: { hidden: boolean }) {
  const app = useApp()
  const selectedId = useAppState((s) => s.selectedId)
  const sessions = useAppState((s) => s.sessions)
  const teams = useAppState((s) => s.teams)
  const providers = useAppState((s) => s.providers)
  const overlay = useAppState((s) => s.settings?.overlay ?? false)
  const mount = useRef<HTMLDivElement>(null)

  const selected = sessions.find((s) => s.id === selectedId) ?? null
  // A chat session has no pty: never attach a terminal to it.
  const session = selected && selected.surface !== 'chat' ? selected : null
  const team = teams.find((t) => t.id === selectedId) ?? null
  const sessionId = session?.id ?? null

  useEffect(() => {
    mount.current?.append(app.terminals.root)
    return () => app.terminals.root.remove()
  }, [app])

  // Overlay mode hides the shell: don't hold a terminal attached that nobody can see.
  useEffect(() => {
    app.terminals.show(overlay ? null : sessionId)
  }, [app, sessionId, overlay])

  useEffect(() => {
    if (!hidden) app.terminals.scheduleFit(0)
  }, [app, hidden])

  return (
    <div className="termview" hidden={hidden}>
      {session && <SessionHeader session={session} onInterrupted={() => app.terminals.focus()} />}

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
