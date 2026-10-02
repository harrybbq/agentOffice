// Left sidebar: hosted sessions grouped by provider (asleep rows from the last run keep their
// place), then teams the app only observes, and the Recent list at the bottom.
import { useMemo } from 'react'
import type { SessionInfo, SessionState } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { groupSessions, loginHint, observedTeams, shortenPath, STATE_LABEL } from '../format'
import { cx, useNow } from '../hooks'
import { IconAlert, IconAsleep, IconPlus } from '../icons'
import { canWakeRow, interruptedTag, lastActiveLabel } from '../restore'
import { LoginPrompt, UsageMeter } from './ProviderAccount'
import { RowProgress } from './Progress'
import { RecentSection } from './Restore'

export function StateDot({ state }: { state: SessionState }) {
  // Asleep is not a colour of the dot: there is no process to have a state.
  if (state === 'asleep') {
    return (
      <span className="sleep-glyph" role="img" aria-label={STATE_LABEL.asleep} title={STATE_LABEL.asleep}>
        <IconAsleep size={14} />
      </span>
    )
  }
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
  const waking = useAppState((s) => s.waking)
  const now = useNow(30_000)

  const groups = useMemo(() => groupSessions(providers, sessions), [providers, sessions])
  const observed = useMemo(() => observedTeams(teams, sessions, everHosted), [teams, sessions, everHosted])
  const canStart = providers.some((p) => p.available)
  const labelOf = (id: string) => providers.find((p) => p.id === id)?.label ?? id
  let index = 0

  const row = (s: SessionInfo) => {
    const team = teams.find((t) => t.id === s.id)
    const asks = permissions.filter((p) => p.sessionId === s.id).length
    const n = ++index
    const asleep = s.state === 'asleep'
    const isWaking = asleep && waking.has(s.id)
    const canWake = canWakeRow(s)
    const active = asleep ? lastActiveLabel(s.lastActiveAt, now) : ''
    const tip = [
      s.title,
      s.cwd,
      asleep ? `Asleep${active ? ` · ${active}` : ''}` : STATE_LABEL[s.state],
      s.interruptedNote ? 'Agent Office closed while it was working' : '',
      asleep && canWake ? 'Double-click or Enter to wake' : '',
      n <= 9 ? `Ctrl+${n}` : ''
    ]
    return (
      <li key={s.id}>
        <button
          type="button"
          className={cx('session-row', selectedId === s.id && 'is-selected', s.state === 'exited' && 'is-exited', asleep && 'is-asleep')}
          onClick={() => app.select(s.id, { focusTerminal: true })}
          // An asleep row: double-click or Enter resumes its conversation (a click only shows it).
          onDoubleClick={asleep && canWake ? () => void app.wake(s.id) : undefined}
          onKeyDown={
            asleep && canWake
              ? (ev) => {
                  if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return
                  ev.preventDefault()
                  app.select(s.id, { focusTerminal: true })
                  void app.wake(s.id)
                }
              : undefined
          }
          title={tip.filter(Boolean).join('\n')}
          aria-current={selectedId === s.id ? 'true' : undefined}
        >
          <Swatch color={team?.color} />
          <span className="session-text">
            <span className="session-title">
              {s.title}
              {team && team.workers > 0 && <span className="session-workers">+{team.workers}</span>}
            </span>
            <span className="session-path">{shortenPath(s.cwd)}</span>
            {asleep && <span className="session-sleep">{isWaking ? 'Waking…' : `Asleep${active ? ` · ${active}` : ''}`}</span>}
            {s.interruptedNote && (
              <span className="session-interrupted">
                <IconAlert size={12} />
                {interruptedTag(s.interruptedNote)}
              </span>
            )}
            <RowProgress sessionId={s.id} color={team?.color} />
          </span>
          {asks > 0 && <span className="count-badge">{asks}</span>}
          {isWaking ? <span className="spinner" role="img" aria-label="Waking" /> : <StateDot state={s.state} />}
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
              {g.provider.available && g.provider.account?.loggedIn && g.provider.account.plan && (
                <span className="group-tag plan-tag" title={`Signed in · ${g.provider.account.plan} plan`}>
                  {g.provider.account.plan}
                </span>
              )}
              {/* A provider that reports no plan (Antigravity) still says that it is signed in. */}
              {g.provider.available && g.provider.account?.loggedIn && !g.provider.account.plan && (
                <span className="group-tag plan-tag" title="Signed in">
                  signed in
                </span>
              )}
            </h2>
            {!g.provider.available && <p className="group-note">{g.provider.reason ?? 'Not available'}</p>}
            {g.provider.available && loginHint(g.provider) && <LoginPrompt provider={g.provider} variant="sidebar" />}
            {g.provider.available && !loginHint(g.provider) && <UsageMeter usage={g.provider.usage} />}
            {g.provider.available && !loginHint(g.provider) && g.sessions.length === 0 && <p className="group-note">No sessions yet</p>}
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
                    title={`${t.name} · ${labelOf(t.provider)}\nRuns in its own terminal`}
                  >
                    <Swatch color={t.color} />
                    <span className="session-text">
                      <span className="session-title">
                        {t.name}
                        {t.workers > 0 && <span className="session-workers">+{t.workers}</span>}
                      </span>
                      <span className="session-path">{labelOf(t.provider)} · external</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <RecentSection />
    </aside>
  )
}
