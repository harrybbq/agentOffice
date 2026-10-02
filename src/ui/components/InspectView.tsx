// The Inspect tab: what one agent is doing. Read-only: it never controls the agent (approvals stay
// in the CEO inbox). The details come from the main process (shared/inspector.ts), pushed about once
// a second while this tab is on screen; the wording comes from the world theme (its verbs and
// station names). Fields the main process does not send are simply left out.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDetails } from '../../../shared/inspector'
import { friendlyModelName } from '../../../shared/models'
import { StationRouter } from '../../theme/stations'
import { useApp, useAppState } from '../controller'
import { splitPath } from '../board'
import { ago, clock, riskBadge } from '../format'
import { cx, useNow } from '../hooks'
import { IconAlert, IconArrowRight, IconChat, IconCheck, IconChevron, IconCopy, IconInbox, IconInspect, IconTerminal, IconUsers } from '../icons'
import { clockShort, contextUse, countRows, facts, FILE_KIND, roleLine, stateChip } from '../inspect'
import type { Fact } from '../inspect'
import { QuestionText } from './Inbox'
import { InspectProgress } from './Progress'
import { Swatch } from './Sidebar'

function Portrait({ agentId, look, color, providerColor }: { agentId: string; look: string; color?: string; providerColor?: string }) {
  const app = useApp()
  const [src, setSrc] = useState<string | null>(null)

  // The character as the world draws it. Without one (not in the world, no WebGL snapshot) the team
  // swatch and the provider dot stand in.
  useEffect(() => {
    let alive = true
    setSrc(null)
    void app.world.portrait(agentId).then((url) => {
      if (alive) setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [app, agentId, look])

  return (
    <span className="inspect-portrait" style={color ? { borderColor: color } : undefined} aria-hidden="true">
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <span className="inspect-portrait-fallback">
          <Swatch color={color} />
          {providerColor && <span className="inspect-provider-dot" style={{ background: providerColor }} />}
        </span>
      )}
    </span>
  )
}

function FactCell({ fact, children }: { fact: Fact; children?: React.ReactNode }) {
  return (
    <div className={cx('fact', `fact-${fact.key}`)}>
      <dt>{fact.label}</dt>
      <dd className={cx(fact.missing && 'is-missing')} title={fact.title}>
        {fact.key === 'status' ? <QuestionText text={fact.value} /> : fact.value}
        {children}
      </dd>
    </div>
  )
}

/** The task: three lines, with the rest behind "Show all" when there is more. */
function Task({ fact }: { fact: Fact }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const text = useRef<HTMLElement>(null)

  // Only offer "Show all" when the three lines really cut something off (the panel can be wide).
  useEffect(() => {
    const el = text.current
    if (!el) return
    const check = () => {
      if (el.classList.contains('is-clamped')) setLong(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fact.value])

  return (
    <div className="fact fact-task">
      <dt>{fact.label}</dt>
      <dd ref={text} className={cx('fact-task-text', !open && 'is-clamped')}>
        {fact.value}
      </dd>
      {long && (
        <button type="button" className={cx('card-toggle', open && 'is-open')} onClick={() => setOpen(!open)} aria-expanded={open}>
          <IconChevron size={12} />
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

function Details({ d }: { d: AgentDetails }) {
  const app = useApp()
  const theme = useAppState((s) => s.theme)
  const teams = useAppState((s) => s.teams)
  const sessions = useAppState((s) => s.sessions)
  const providers = useAppState((s) => s.providers)
  const hasRequest = useAppState((s) => s.permissions.some((p) => p.agentId === d.agentId))
  const now = useNow(1000)
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  // The scene already reported a theme's bad rules: no second warning from here.
  const router = useMemo(() => (theme ? new StationRouter(theme, () => undefined) : null), [theme])
  if (!router || !theme) return null

  const teamId = d.sessionId ?? (d.role === 'manager' ? d.agentId : app.world.agents.rootOf({ agentId: d.agentId, parentId: d.parentId ?? null }))
  const team = teams.find((t) => t.id === teamId)
  const session = sessions.find((x) => x.id === (d.sessionId ?? teamId))
  const hosted = !!session && session.state !== 'asleep'
  const providerLabel = providers.find((p) => p.id === d.provider)?.label ?? d.provider
  const chip = stateChip(d.state)
  const list = facts(d, router)
  const task = list.find((f) => f.key === 'task')
  const context = contextUse(d.tokens)
  const counts = countRows(d.counts, router)
  const files = d.files ?? []
  const recent = d.recent ?? []
  const workers = d.workers ?? []
  const badge = d.waitingOn ? riskBadge(d.waitingOn.risk) : null

  const copy = (path: string) => {
    void navigator.clipboard?.writeText(path).then(
      () => {
        setCopied(path)
        window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(null), 1400)
      },
      () => undefined
    )
  }

  return (
    <div className="inspect-scroll">
      <header className="inspect-head">
        <Portrait agentId={d.agentId} look={`${d.provider}:${team?.color ?? ''}`} color={team?.color} providerColor={team?.providerColor} />
        <div className="inspect-id">
          <span className="inspect-name">{d.displayName}</span>
          <span className="inspect-role">{roleLine(d, team?.name ?? session?.title ?? null, { manager: theme.roles.manager.label, worker: theme.roles.worker.label })}</span>
          <span className="inspect-provider">
            {providerLabel}
            {d.model ? ` · ${friendlyModelName(d.model)}` : ''}
          </span>
        </div>
        <span className={cx('state-chip', `state-chip-${chip.tone}`)}>
          <span className={cx('state-dot', `state-${chip.tone}`)} aria-hidden="true" />
          {chip.label}
        </span>
      </header>

      {(d.role === 'worker' || hosted) && (
        <div className="inspect-links">
          {d.role === 'worker' && teamId !== d.agentId && (
            <button type="button" className="link" onClick={() => app.inspectAgent(teamId, { focusWorld: true })}>
              <IconUsers size={13} />
              {theme.roles.manager.label}: {team?.name ?? 'its manager'}
            </button>
          )}
          {hosted && session && (
            <button type="button" className="link" onClick={() => app.select(session.id, { focusTerminal: true, focusWorld: false, inspect: false })}>
              {session.surface === 'chat' ? <IconChat size={13} /> : <IconTerminal size={13} />}
              Open {session.surface === 'chat' ? 'chat' : 'terminal'}
            </button>
          )}
        </div>
      )}

      {d.waitingOn && (
        <section className={cx('inspect-waiting', badge && `risk-${badge.tone}`)} aria-label="Waiting on you">
          <div className="inspect-waiting-head">
            <IconInbox size={14} />
            Waiting on you
            {Number.isFinite(d.waitingOn.since) && <span className="inspect-waiting-age">{ago(now - d.waitingOn.since)}</span>}
          </div>
          <p className="inspect-waiting-question">
            <QuestionText text={d.waitingOn.question} />
          </p>
          <div className="inspect-waiting-foot">
            {badge && (
              <span className={cx('risk-badge', `is-${badge.tone}`)}>
                <IconAlert size={12} />
                {badge.text}
              </span>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => app.focusInbox(d.agentId)}
              title={hasRequest ? 'Show this request in the CEO inbox' : 'Open the CEO inbox'}
            >
              Go to request
              <IconArrowRight size={13} />
            </button>
          </div>
        </section>
      )}

      <dl className="facts">
        {task && <Task key={d.agentId} fact={task} />}
        {list
          .filter((f) => f.key !== 'task')
          .map((f) => (
            <FactCell key={f.key} fact={f}>
              {f.key === 'tokens' && context && (
                <span className="context-bar" role="img" aria-label={context.label} title={context.label}>
                  <span className={cx('context-fill', context.percent >= 85 && 'is-high')} style={{ width: `${context.percent}%` }} />
                </span>
              )}
            </FactCell>
          ))}
      </dl>

      {d.role === 'manager' && hosted && session && <InspectProgress key={session.id} sessionId={session.id} color={team?.color} />}

      {counts.length > 0 && (
        <section className="inspect-section">
          <h3>Activity</h3>
          <div className="count-bar" aria-hidden="true">
            {counts.map((c) => (
              <span key={c.activity} className={cx('count-seg', `seg-${c.activity}`)} style={{ flexGrow: c.count }} />
            ))}
          </div>
          <ul className="count-chips">
            {counts.map((c) => (
              <li key={c.activity} title={c.station ? `${c.station}: ${c.count} ${c.count === 1 ? 'time' : 'times'}` : undefined}>
                <span className={cx('count-dot', `seg-${c.activity}`)} aria-hidden="true" />
                <span className="count-verb">{c.station ?? c.verb}</span>
                <span className="count-n">{c.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section className="inspect-section">
          <h3>
            Files changed <span className="group-count">{files.length}</span>
          </h3>
          <ul className="inspect-files">
            {files.map((f) => {
              const { dir, base } = splitPath(f.path)
              const kind = FILE_KIND[f.kind] ?? FILE_KIND.edit
              const isCopied = copied === f.path
              return (
                <li key={f.path}>
                  <button type="button" className="file-row" onClick={() => copy(f.path)} title={`${kind.label} · click to copy the path\n${f.path}`}>
                    <span className={cx('file-glyph', `is-${f.kind}`)} aria-label={kind.label}>
                      {kind.glyph}
                    </span>
                    <span className="file-path">
                      {dir && <span className="file-dir">{dir}</span>}
                      <span className="file-base">{base}</span>
                    </span>
                    <span className="file-time">
                      {isCopied ? (
                        <>
                          <IconCheck size={12} /> Copied
                        </>
                      ) : (
                        <>
                          <IconCopy size={12} /> {clockShort(f.ts)}
                        </>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {d.role === 'manager' && workers.length > 0 && (
        <section className="inspect-section">
          <h3>
            {theme.roles.worker.label}s <span className="group-count">{workers.length}</span>
          </h3>
          <ul className="inspect-workers">
            {workers.map((w) => (
              <li key={w.agentId}>
                <button type="button" className={cx('worker-row', w.done && 'is-done')} onClick={() => app.inspectAgent(w.agentId, { focusWorld: !w.done })} title="Inspect this worker">
                  <span className={cx('state-dot', w.done ? 'state-exited' : w.activity === 'waiting' ? 'state-waiting-permission' : w.activity === 'idle' ? 'state-idle' : 'state-busy')} aria-hidden="true" />
                  <span className="worker-name">{w.displayName}</span>
                  {w.agentType && w.agentType !== w.displayName && <span className="worker-type">{w.agentType}</span>}
                  <span className="worker-activity">{w.done ? 'Done' : router.verb(w.activity)}</span>
                  <IconChevron size={12} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="inspect-section">
          <h3>Recent activity</h3>
          <ol className="inspect-recent">
            {recent.map((r, i) => (
              <li key={`${r.ts}-${i}`}>
                <time>{clock(r.ts)}</time>
                <span className={cx('recent-dot', `seg-${r.activity}`)} aria-hidden="true" />
                <span className="recent-phrase" title={r.detail || undefined}>
                  <QuestionText text={router.phrase(r.activity, r.detail)} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

export function InspectView({ hidden }: { hidden: boolean }) {
  const agentId = useAppState((s) => s.agentId)
  const details = useAppState((s) => s.agentDetails)
  const status = useAppState((s) => s.agentStatus)
  const title = useAppState((s) => s.sessions.find((x) => x.id === s.agentId)?.title ?? s.teams.find((t) => t.id === s.agentId)?.name ?? null)

  return (
    <div className="inspect" hidden={hidden}>
      {!hidden &&
        (details && details.agentId === agentId ? (
          <Details d={details} />
        ) : (
          <div className="panel-empty">
            <span className="panel-empty-icon">
              <IconInspect size={20} />
            </span>
            {!agentId || status === 'none' ? (
              <>
                <p className="panel-empty-title">Nobody selected</p>
                <p>Click anyone in the office to see what they're doing.</p>
              </>
            ) : status === 'loading' ? (
              <p>Looking up {title ?? 'this agent'}…</p>
            ) : (
              <>
                <p className="panel-empty-title">{title ?? 'This agent'} isn't in the office right now</p>
                <p>Click anyone in the office to see what they're doing.</p>
              </>
            )}
          </div>
        ))}
    </div>
  )
}
