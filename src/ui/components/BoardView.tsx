// The office board: per project, what each team is doing, the files it changed, where two teams
// touched the same file, and the claims, notes and warnings on the board. The user can delete a
// claim or note and change the board settings. Everything agents can read is shown here.
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { BoardConflictMode, BoardFile, BoardStatus } from '../../../shared/board'
import { useApp, useAppState } from '../controller'
import {
  applyRemovals,
  BOARD_STATUS_LABEL,
  CONFLICT_MODES,
  EMPTY_BOARD,
  groupBoard,
  overlapSummary,
  relTime,
  splitPath,
  warningText
} from '../board'
import type { FileRow, ProjectGroup, RemoveKind, TeamRow } from '../board'
import { clock, sessionOrder } from '../format'
import { cx, useNow } from '../hooks'
import { IconArrowRight, IconBoard, IconMinus, IconOverlap, IconPencil, IconPlus, IconShield, IconTrash } from '../icons'
import { Swatch } from './Sidebar'

const FILE_KIND: Record<BoardFile['kind'], { label: string; icon: ReactNode }> = {
  create: { label: 'Created', icon: <IconPlus size={12} /> },
  edit: { label: 'Edited', icon: <IconPencil size={12} /> },
  delete: { label: 'Deleted', icon: <IconMinus size={12} /> }
}

const STATUS_DOT: Record<BoardStatus, string> = {
  idle: 'state-idle',
  busy: 'state-busy',
  waiting: 'state-waiting-permission',
  ended: 'state-exited'
}

interface Look {
  color?: string
  providerColor?: string
  providerLabel: string
}

function Age({ ts, now }: { ts: number; now: number }) {
  return (
    <time className="board-age" dateTime={new Date(ts).toISOString()} title={clock(ts)}>
      {relTime(ts, now)}
    </time>
  )
}

function Path({ path }: { path: string }) {
  const { dir, base } = splitPath(path)
  return (
    <span className="board-path" title={path}>
      {dir && <span className="board-path-dir">{dir}</span>}
      <span className="board-path-base">{base}</span>
    </span>
  )
}

function Team({ name, color }: { name: string; color?: string }) {
  return (
    <span className="board-who">
      <Swatch color={color} />
      <span>{name}</span>
    </span>
  )
}

export function BoardView({ hidden }: { hidden: boolean }) {
  const app = useApp()
  const raw = useAppState((s) => s.board)
  const removing = useAppState((s) => s.boardRemoving)
  const settings = useAppState((s) => s.boardSettings)
  const providers = useAppState((s) => s.providers)
  const sessions = useAppState((s) => s.sessions)
  const teams = useAppState((s) => s.teams)
  const selectedId = useAppState((s) => s.selectedId)
  // The tick only re-renders; reading the clock here keeps ages right when a snapshot arrives between ticks.
  useNow(30_000)
  const now = Date.now()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const groups = useMemo(() => {
    if (hidden) return []
    const order = sessionOrder(providers, sessions).map((s) => s.id)
    return groupBoard(applyRemovals(raw ?? EMPTY_BOARD, removing), { order })
  }, [hidden, raw, removing, providers, sessions])

  const look = (sessionId: string, provider?: string): Look => {
    const t = teams.find((x) => x.id === sessionId)
    return {
      color: t?.color,
      providerColor: t?.providerColor,
      providerLabel: providers.find((p) => p.id === (provider ?? t?.provider))?.label ?? provider ?? ''
    }
  }
  const select = (sessionId: string) => app.select(sessionId, { reveal: false })
  const toggle = (sessionId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })

  const fileRow = (f: FileRow) => (
    <li key={f.path} className={cx('board-file', `kind-${f.kind}`, f.others.length > 0 && 'is-overlap')}>
      <span className="board-file-kind" role="img" aria-label={FILE_KIND[f.kind].label} title={FILE_KIND[f.kind].label}>
        {FILE_KIND[f.kind].icon}
      </span>
      <Path path={f.path} />
      {f.others.length > 0 && (
        <span className="overlap-tag">
          <IconOverlap size={12} />
          also edited by
          {f.others.map((o) => (
            <Team key={o.sessionId} name={o.team} color={look(o.sessionId).color} />
          ))}
        </span>
      )}
      <Age ts={f.ts} now={now} />
    </li>
  )

  const teamRow = (row: TeamRow) => {
    const b = row.branch
    const l = look(b.sessionId, b.provider)
    const open = expanded.has(b.sessionId)
    const files = open ? row.files : row.visible
    return (
      <li
        key={b.sessionId}
        className={cx('board-team', selectedId === b.sessionId && 'is-selected', b.status === 'ended' && 'is-ended', row.overlaps > 0 && 'has-overlap')}
        onClick={() => select(b.sessionId)}
      >
        <div className="board-team-head">
          <span className="board-ident">
            <Swatch color={l.color} />
            <span className="provider-dot" style={l.providerColor ? { background: l.providerColor } : undefined} title={l.providerLabel} role="img" aria-label={l.providerLabel} />
          </span>
          <button
            type="button"
            className="board-team-name"
            title={`${b.team} · ${l.providerLabel}\nShow this team in the office`}
            aria-current={selectedId === b.sessionId ? 'true' : undefined}
            onClick={(ev) => {
              ev.stopPropagation()
              select(b.sessionId)
            }}
          >
            {b.team}
          </button>
          <span className={cx('board-status', `status-${b.status}`)}>
            <span className={cx('state-dot', STATUS_DOT[b.status])} aria-hidden="true" />
            {BOARD_STATUS_LABEL[b.status]}
          </span>
          {b.task ? (
            <span className="board-task" title={`Claimed: ${b.task}`}>
              {b.task}
            </span>
          ) : (
            <span className="board-task is-none">no claim</span>
          )}
        </div>
        {row.files.length === 0 ? (
          <p className="board-nofiles">No files changed yet</p>
        ) : (
          <ul className="board-files">{files.map(fileRow)}</ul>
        )}
        {row.hidden > 0 && (
          <button
            type="button"
            className="board-more"
            aria-expanded={open}
            onClick={(ev) => {
              ev.stopPropagation()
              toggle(b.sessionId)
            }}
          >
            {open ? 'Show fewer' : `${row.hidden} more`}
          </button>
        )}
      </li>
    )
  }

  const remove = (kind: RemoveKind, id: string, what: string) => (
    <button
      type="button"
      className="icon-btn board-remove"
      title={`Remove this ${what} from the board`}
      aria-label={`Remove this ${what} from the board`}
      onClick={() => void app.removeBoardItem(kind, id)}
    >
      <IconTrash size={14} />
    </button>
  )

  const project = (g: ProjectGroup, showHead: boolean) => (
    <section key={g.project} className="board-project" aria-label={g.label}>
      {showHead && (
        <h2 className="board-project-head" title={g.project}>
          <span>{g.label}</span>
          <span className="group-count">
            {g.teams.length} {g.teams.length === 1 ? 'team' : 'teams'}
          </span>
        </h2>
      )}

      {g.overlaps.length > 0 && (
        <div className="board-overlaps" role="status">
          <p className="board-overlaps-head">
            <IconOverlap size={15} />
            {overlapSummary(g.overlaps.length)}
          </p>
          <ul>
            {g.overlaps.map((o) => (
              <li key={o.path}>
                <Path path={o.path} />
                <span className="board-overlap-teams">
                  {o.teams.map((t) => (
                    <Team key={t.sessionId} name={t.team} color={look(t.sessionId).color} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="board-cols">
        <div className="board-col">
          {g.teams.length > 0 && <ul className="board-teams">{g.teams.map(teamRow)}</ul>}
          {g.teams.length === 1 && <p className="board-hint">Only one team in this project, nothing to coordinate.</p>}
        </div>

        {(g.teams.length > 1 || g.claims.length + g.notes.length + g.warnings.length > 0) && (
          <div className="board-col">
            <h3 className="board-sub">
              Claims <span className="group-count">{g.claims.length || ''}</span>
            </h3>
            {g.claims.length === 0 ? (
              <p className="board-none">No team has claimed a task.</p>
            ) : (
              <ul className="board-list">
                {g.claims.map((c) => (
                  <li key={c.id} className="board-item">
                    <div className="board-item-main">
                      <p className="board-item-text">{c.task}</p>
                      <p className="board-item-meta">
                        <Team name={c.team} color={look(c.sessionId).color} />
                        <Age ts={c.ts} now={now} />
                        {c.files.length > 0 && (
                          <span className="board-item-files" title={c.files.join('\n')}>
                            {c.files.join(', ')}
                          </span>
                        )}
                      </p>
                    </div>
                    {remove('claim', c.id, 'claim')}
                  </li>
                ))}
              </ul>
            )}

            <h3 className="board-sub">
              Notes <span className="group-count">{g.notes.length || ''}</span>
            </h3>
            {g.notes.length === 0 ? (
              <p className="board-none">No notes.</p>
            ) : (
              <ul className="board-list">
                {g.notes.map((n) => (
                  <li key={n.id} className={cx('board-item', n.kind === 'handover' && 'is-handover')}>
                    <div className="board-item-main">
                      <p className="board-item-text">{n.text}</p>
                      <p className="board-item-meta">
                        <Team name={n.team} color={look(n.sessionId).color} />
                        {n.kind === 'handover' && (
                          <span className="handover-tag">
                            <IconArrowRight size={12} />
                            hand-over{n.to ? ` for ${n.to}` : ''}
                          </span>
                        )}
                        <Age ts={n.ts} now={now} />
                      </p>
                    </div>
                    {remove('note', n.id, 'note')}
                  </li>
                ))}
              </ul>
            )}

            {g.warnings.length > 0 && (
              <>
                <h3 className="board-sub">
                  Warnings <span className="group-count">{g.warnings.length}</span>
                </h3>
                <ul className="board-list">
                  {g.warnings.map((w) => (
                    <li key={w.id} className="board-item is-warning">
                      <IconShield size={14} />
                      <div className="board-item-main">
                        <p className="board-item-text">{warningText(w)}</p>
                        <p className="board-item-meta">
                          <Age ts={w.ts} now={now} />
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )

  const mode = CONFLICT_MODES.find((m) => m.value === settings?.conflictMode) ?? CONFLICT_MODES[0]

  return (
    <div className="board" hidden={hidden}>
      <div className="board-scroll">
        {settings && !settings.enabled && (
          <p className="board-off" role="status">
            The office board is off: teams are not told about each other. The files they change are still listed here.
          </p>
        )}
        {!hidden && groups.length === 0 ? (
          <div className="panel-empty">
            <div className="panel-empty-icon">
              <IconBoard size={20} />
            </div>
            <p className="panel-empty-title">Nothing on the board</p>
            <p>Start two sessions in the same repository and the board shows who is doing what.</p>
            <button type="button" className="btn" onClick={() => app.openNewSession()}>
              <IconPlus />
              New session
            </button>
          </div>
        ) : (
          groups.map((g) => project(g, groups.length > 1))
        )}
        {settings && (
          <footer className="board-settings">
            <div className="board-setting">
              <button
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                className={cx('switch', settings.enabled && 'is-on')}
                onClick={() => void app.setBoardSettings({ enabled: !settings.enabled })}
              >
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
                Office board: {settings.enabled ? 'on' : 'off'}
              </button>
              <p className="board-help">
                {settings.enabled
                  ? 'Teams in the same repository see each other’s status, changed files, claims and notes.'
                  : 'Teams work without knowing about each other.'}
              </p>
            </div>
            <div className={cx('board-setting', !settings.enabled && 'is-disabled')}>
              <label className="board-select">
                Same file, two teams
                <select
                  value={settings.conflictMode}
                  disabled={!settings.enabled}
                  onChange={(ev) => void app.setBoardSettings({ conflictMode: ev.target.value as BoardConflictMode })}
                >
                  {CONFLICT_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="board-help">{mode.help}</p>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}
