import { useEffect, useState } from 'react'
import { useApp, useAppState } from '../controller'
import type { AppState } from '../controller'
import { overlapBadge } from '../board'
import { ago } from '../format'
import { cx, useNow } from '../hooks'
import { IconInbox, IconMegaphone, IconMoon, IconOverlap, IconPower, IconSun, IconTerminal } from '../icons'

const CONNECTION: Record<AppState['connection'], { label: string; tone: string; title: string }> = {
  connecting: { label: 'Connecting', tone: 'warn', title: 'Waiting for the app' },
  connected: { label: 'Connected', tone: 'ok', title: 'Connected to the Agent Office main process' },
  stub: { label: 'Preview (no Electron)', tone: 'warn', title: 'Running in a browser with a fake bridge: nothing here is real' },
  limited: { label: 'Connected · watch only', tone: 'warn', title: "This build's main process can't host sessions yet" }
}

export function StatusBar() {
  const app = useApp()
  const connection = useAppState((s) => s.connection)
  const eventCount = useAppState((s) => s.eventCount)
  const lastEventAt = useAppState((s) => s.lastEventAt)
  const sessions = useAppState((s) => s.sessions)
  const pending = useAppState((s) => s.permissions.length)
  const overlaps = useAppState((s) => s.boardOverlaps)
  const themeName = useAppState((s) => s.themeName)
  const layout = useAppState((s) => s.layout)
  const allowOrders = useAppState((s) => s.settings?.allowOrders ?? false)
  const hasSettings = useAppState((s) => s.settings !== null)
  const now = useNow(1000)
  const c = CONNECTION[connection]
  const running = sessions.filter((s) => s.state !== 'exited').length
  const [confirmQuit, setConfirmQuit] = useState(false)

  // The question goes away by itself, and with Esc.
  useEffect(() => {
    if (!confirmQuit) return
    const timer = window.setTimeout(() => setConfirmQuit(false), 8000)
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && setConfirmQuit(false)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [confirmQuit])

  return (
    <footer className="statusbar">
      <span className="status-item" title={c.title}>
        <span className={cx('status-dot', `tone-${c.tone}`)} />
        {c.label}
      </span>
      <span className="status-item">
        {running} {running === 1 ? 'session' : 'sessions'} running
      </span>
      <button type="button" className={cx('status-item status-btn', pending > 0 && 'is-attn')} onClick={() => app.focusInbox()} title="Open the CEO inbox">
        <IconInbox size={14} />
        {pending} pending
      </button>
      {overlaps > 0 && (
        <button
          type="button"
          className="status-item status-btn is-attn"
          onClick={() => app.openBoard()}
          title={`${overlaps} ${overlaps === 1 ? 'file was' : 'files were'} touched by more than one team. Open the office board.`}
        >
          <IconOverlap size={14} />
          {overlapBadge(overlaps)}
        </button>
      )}
      <span className="status-item">
        {eventCount} {eventCount === 1 ? 'event' : 'events'}{lastEventAt ? ` · last ${ago(now - lastEventAt)} ago` : ''}
      </span>
      <span className="status-spacer" />
      <span className="status-item status-keys">
        <kbd>Ctrl K</kbd> order
        <kbd>Ctrl 1-9</kbd> session
      </span>
      {hasSettings && (
        <button
          type="button"
          role="switch"
          aria-checked={allowOrders}
          className={cx('status-item status-btn status-orders', allowOrders ? 'is-on' : 'is-off')}
          onClick={() => void app.setAllowOrders(!allowOrders)}
          title={
            allowOrders
              ? 'CEO orders are on: the order bar can send prompts to your sessions. Click to turn them off (watch only).'
              : 'CEO orders are off: the order bar sends nothing. Click to turn them on.'
          }
        >
          <IconMegaphone size={14} />
          Orders: {allowOrders ? 'on' : 'off'}
        </button>
      )}
      {themeName && (
        <span className="status-item" title="World theme (tray menu → Theme)">
          {themeName} theme
        </span>
      )}
      <button
        type="button"
        className="status-item status-btn"
        onClick={() => app.setLayout({ uiTheme: layout.uiTheme === 'dark' ? 'light' : 'dark' })}
        title={layout.uiTheme === 'dark' ? 'Switch to the light interface' : 'Switch to the dark interface'}
        aria-label="Toggle light or dark interface"
      >
        {layout.uiTheme === 'dark' ? <IconMoon size={14} /> : <IconSun size={14} />}
        {layout.uiTheme === 'dark' ? 'Dark' : 'Light'}
      </button>
      <button
        type="button"
        className={cx('status-item status-btn', layout.panelOpen && 'is-on')}
        onClick={() => app.togglePanel()}
        title="Toggle the terminal panel (Ctrl+`)"
        aria-pressed={layout.panelOpen}
      >
        <IconTerminal size={14} />
        Panel
      </button>
      {app.canQuit &&
        (confirmQuit ? (
          <span className="status-item status-confirm" role="group" aria-label="Quit Agent Office?">
            {running > 0 ? `Quit and stop ${running} ${running === 1 ? 'session' : 'sessions'}?` : 'Quit Agent Office?'}
            <button type="button" className="btn btn-danger btn-sm" autoFocus onClick={() => app.quit()}>
              Quit
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmQuit(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="status-item status-btn"
            onClick={() => setConfirmQuit(true)}
            title="Quit Agent Office (closing the window only hides it to the tray)"
          >
            <IconPower size={14} />
            Quit
          </button>
        ))}
    </footer>
  )
}
