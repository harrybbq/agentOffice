import { useApp, useAppState } from '../controller'
import type { AppState } from '../controller'
import { ago } from '../format'
import { cx, useNow } from '../hooks'
import { IconInbox, IconMoon, IconSun, IconTerminal } from '../icons'

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
  const themeName = useAppState((s) => s.themeName)
  const layout = useAppState((s) => s.layout)
  const now = useNow(1000)
  const c = CONNECTION[connection]
  const running = sessions.filter((s) => s.state !== 'exited').length

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
      <span className="status-item">
        {eventCount} events{lastEventAt ? ` · last ${ago(now - lastEventAt)} ago` : ''}
      </span>
      <span className="status-spacer" />
      <span className="status-item status-keys">
        <kbd>Ctrl K</kbd> order
        <kbd>Ctrl 1-9</kbd> session
      </span>
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
    </footer>
  )
}
