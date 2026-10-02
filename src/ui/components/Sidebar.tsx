// Left sidebar: hosted sessions grouped by provider, then teams the app only observes.
import { useMemo } from 'react'
import type { SessionInfo, SessionState } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { groupSessions, observedTeams, shortenPath, STATE_LABEL } from '../format'
import { cx } from '../hooks'
import { IconPlus } from '../icons'

export function StateDot({ state }: { state: SessionState }) {
  return <span className={cx('state-dot', `state-${state}`)} role="img" aria-label={STATE_LABEL[state]} title={STATE_LABEL[state]} />
}

export function Swatch({ color }: { color?: string }) {
  return <span className={cx('swatch', !color && 'swatch-empty')} style={color ? { background: color } : undefined} aria-hidden="true" />
}

export function Sidebar() {
  const app = useApp()
  const providers = useAppState((s) => s.providers)
  const sessions = useAppState((s) => s.sessions)
  const teams = useAppState((s) => s.teams)
  const permissions = useAppState((s) => s.permissions)
  const selectedId = useAppState((s) => s.selectedId)
  const everHosted = useAppState((s) => s.everHosted)

  const groups = useMemo(() => groupSessions(providers, sessions), [providers, sessions])
  const observed = useMemo(() => observedTeams(teams, sessions, everHosted), [teams, sessions, everHosted])
  const canStart = providers.some((p) => p.available)
  let index = 0

  const row = (s: SessionInfo) => {
    const team = teams.find((t) => t.id === s.id)
    const asks = permissions.filter((p) => p.sessionId === s.id).length
    const n = ++index
    return (
      <li key={s.id}>
        <button
          type="button"
          className={cx('session-row', selectedId === s.id && 'is-selected', s.state === 'exited' && 'is-exited')}
          onClick={() => app.select(s.id, { focusTerminal: true })}
          title={`${s.title}\n${s.cwd}\n${STATE_LABEL[s.state]}${n <= 9 ? `\nCtrl+${n}` : ''}`}
          aria-current={selectedId === s.id ? 'true' : undefined}
        >
          <Swatch color={team?.color} />
          <span className="session-text">
            <span className="session-title">
              {s.title}
              {team && team.workers > 0 && <span className="session-workers">+{team.workers}</span>}
            </span>
            <span className="session-path">{shortenPath(s.cwd)}</span>
          </span>
          {asks > 0 && <span className="count-badge">{asks}</span>}
          <StateDot state={s.state} />
        </button>
      </li>
    )
  }

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Agent Office
        </div>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => app.openNewSession()}
          disabled={providers.length > 0 && !canStart}
        >
          <IconPlus />
          New session
          <kbd>Ctrl N</kbd>
        </button>
      </div>

      <div className="sidebar-scroll">
        {groups.map((g) => (
          <section key={g.provider.id} className={cx('group', !g.provider.available && 'is-disabled')}>
            <h2 className="group-head">
              <span>{g.provider.label}</span>
              {g.provider.available ? (
                g.sessions.length > 0 && <span className="group-count">{g.sessions.length}</span>
              ) : (
                <span className="group-tag">Unavailable</span>
              )}
            </h2>
            {!g.provider.available && <p className="group-note">{g.provider.reason ?? 'Not available'}</p>}
            {g.provider.available && g.sessions.length === 0 && <p className="group-note">No sessions yet</p>}
            {g.sessions.length > 0 && <ul className="session-list">{g.sessions.map(row)}</ul>}
          </section>
        ))}

        {observed.length > 0 && (
          <section className="group">
            <h2 className="group-head" title="Sessions running outside Agent Office. They report events here, but the app can't type into them.">
              <span>Observed</span>
              <span className="group-count">{observed.length}</span>
            </h2>
            <ul className="session-list">
              {observed.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={cx('session-row', selectedId === t.id && 'is-selected', !t.live && 'is-exited')}
                    onClick={() => app.select(t.id)}
                    title={`${t.name} · ${t.provider}\nRuns in its own terminal`}
                  >
                    <Swatch color={t.color} />
                    <span className="session-text">
                      <span className="session-title">
                        {t.name}
                        {t.workers > 0 && <span className="session-workers">+{t.workers}</span>}
                      </span>
                      <span className="session-path">{t.provider} · external</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  )
}
