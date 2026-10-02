// The CEO's inbox: permission requests the app can answer (Allow / Deny), plus agents that are
// waiting on something only their own terminal can answer.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { PermissionRequestInfo } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import type { ResolvedPermission } from '../controller'
import { ago, stripToolPrefix, terminalOnlyWaiting } from '../format'
import { cx, useNow } from '../hooks'
import { IconBan, IconCheck, IconChevron, IconInbox, IconTerminal } from '../icons'
import { Swatch } from './Sidebar'

const OUTCOME_TEXT: Record<ResolvedPermission['outcome'], string> = {
  allowed: 'Allowed',
  denied: 'Denied',
  'resolved-elsewhere': 'Answered in the terminal',
  'unknown-request': 'No longer pending'
}

export function Inbox({ docked = false }: { docked?: boolean }) {
  const app = useApp()
  const permissions = useAppState((s) => s.permissions)
  const resolved = useAppState((s) => s.resolved)
  const deciding = useAppState((s) => s.deciding)
  const waiting = useAppState((s) => s.waiting)
  const sessions = useAppState((s) => s.sessions)
  const teams = useAppState((s) => s.teams)
  const providers = useAppState((s) => s.providers)
  const open = useAppState((s) => s.layout.inboxOpen)
  const overlay = useAppState((s) => s.settings?.overlay ?? false)
  const now = useNow(1000)

  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [denying, setDenying] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const others = useMemo(() => terminalOnlyWaiting(waiting, permissions, sessions), [waiting, permissions, sessions])
  const total = permissions.length + others.length
  const cur = Math.min(active, Math.max(0, permissions.length - 1))

  useEffect(() => {
    app.focusInbox = () => {
      app.setLayout({ inboxOpen: true })
      window.setTimeout(() => listRef.current?.focus(), 0)
    }
    return () => {
      app.focusInbox = () => undefined
    }
  }, [app])

  useEffect(() => {
    if (denying && !permissions.some((p) => p.id === denying)) setDenying(null)
  }, [denying, permissions])

  const colorOf = (sessionId: string) => teams.find((t) => t.id === sessionId)?.color
  const providerName = (id: string) => providers.find((p) => p.id === id)?.label ?? id
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allow = (p: PermissionRequestInfo) => void app.decide(p, { behavior: 'allow' })
  const startDeny = (p: PermissionRequestInfo) => {
    setReason('')
    setDenying(p.id)
  }
  const confirmDeny = (p: PermissionRequestInfo) => {
    const message = reason.trim()
    setDenying(null)
    void app.decide(p, message ? { behavior: 'deny', message } : { behavior: 'deny' })
    listRef.current?.focus()
  }

  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.target !== ev.currentTarget || ev.ctrlKey || ev.metaKey || ev.altKey) return
    const p = permissions[cur]
    const k = ev.key.toLowerCase()
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const next = Math.min(permissions.length - 1, Math.max(0, cur + (ev.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      listRef.current?.querySelector(`[data-card="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (!p) {
      return
    } else if (k === 'a') {
      ev.preventDefault()
      allow(p)
    } else if (k === 'd') {
      ev.preventDefault()
      startDeny(p)
    } else if (k === 'e' || ev.key === ' ') {
      ev.preventDefault()
      toggle(p.id)
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      app.select(p.sessionId, { focusTerminal: true })
    }
  }

  if (overlay) {
    // Overlay mode: the window is click-through, so only a badge.
    return total > 0 ? (
      <div className="overlay-badge" role="status">
        <IconInbox />
        {total} waiting on you
      </div>
    ) : null
  }

  return (
    <section className={cx('inbox', docked ? 'is-docked' : 'is-floating', open && 'is-open', total > 0 && 'has-items')} aria-label="CEO inbox">
      <button
        type="button"
        className="inbox-head"
        onClick={() => app.setLayout({ inboxOpen: !open })}
        aria-expanded={open}
        title={open ? 'Collapse the inbox' : 'Open the inbox'}
      >
        <IconInbox />
        <span className="inbox-title">CEO inbox</span>
        {total > 0 ? <span className="count-badge count-attn">{total}</span> : <span className="inbox-clear">Clear</span>}
        <span className={cx('inbox-chevron', open && 'is-open')}>
          <IconChevron />
        </span>
      </button>

      {open && (
        <div className="inbox-body" ref={listRef} tabIndex={0} onKeyDown={onKey} aria-label="Pending requests. A allows, D denies, arrows move.">
          {total === 0 && resolved.length === 0 && <p className="inbox-empty">Nothing is waiting on you.</p>}

          {permissions.map((p, i) => {
            const isOpen = expanded.has(p.id)
            const busy = deciding.has(p.id)
            return (
              <article
                key={p.id}
                data-card={i}
                className={cx('card', i === cur && 'is-active')}
                onClick={() => {
                  setActive(i)
                  app.select(p.sessionId)
                }}
              >
                <header className="card-head">
                  <Swatch color={colorOf(p.sessionId)} />
                  <span className="card-who">{p.displayName}</span>
                  <span className="card-provider">{providerName(p.provider)}</span>
                  <span className="card-age" title="Waiting for">
                    {ago(now - p.createdAt)}
                  </span>
                </header>
                <div className="card-summary">
                  <span className="tool-chip">{p.toolName}</span>
                  <span className="card-summary-text">{stripToolPrefix(p.summary, p.toolName)}</span>
                </div>
                {p.detail && (
                  <button
                    type="button"
                    className={cx('card-toggle', isOpen && 'is-open')}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      toggle(p.id)
                    }}
                    aria-expanded={isOpen}
                  >
                    <IconChevron size={12} />
                    {isOpen ? 'Hide details' : 'Details'}
                  </button>
                )}
                {isOpen && <pre className="card-detail">{p.detail}</pre>}

                {denying === p.id ? (
                  <form
                    className="card-deny"
                    onClick={(ev) => ev.stopPropagation()}
                    onSubmit={(ev) => {
                      ev.preventDefault()
                      confirmDeny(p)
                    }}
                  >
                    <input
                      className="input"
                      autoFocus
                      value={reason}
                      onChange={(ev) => setReason(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Escape') {
                          ev.stopPropagation()
                          setDenying(null)
                          listRef.current?.focus()
                        }
                      }}
                      placeholder="Reason (optional), Enter to deny"
                      aria-label="Reason for denying"
                      maxLength={500}
                    />
                    <button type="submit" className="btn btn-danger">
                      Deny
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setDenying(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="card-actions" onClick={(ev) => ev.stopPropagation()}>
                    <button type="button" className="btn btn-allow" disabled={busy} onClick={() => allow(p)}>
                      <IconCheck />
                      Allow
                      {i === cur && <kbd>A</kbd>}
                    </button>
                    <button type="button" className="btn btn-deny" disabled={busy} onClick={() => startDeny(p)}>
                      <IconBan />
                      Deny
                      {i === cur && <kbd>D</kbd>}
                    </button>
                  </div>
                )}
              </article>
            )
          })}

          {resolved.map((r) => (
            <div key={`r-${r.req.id}`} className={cx('card card-resolved', `outcome-${r.outcome}`)} role="status">
              <Swatch color={colorOf(r.req.sessionId)} />
              <span className="card-who">{r.req.displayName}</span>
              <span className="card-resolved-what">{r.req.summary}</span>
              <span className="card-outcome">{OUTCOME_TEXT[r.outcome]}</span>
            </div>
          ))}

          {others.length > 0 && (
            <>
              <h3 className="inbox-sub">Answer in the terminal</h3>
              {others.map((w) => (
                <button
                  type="button"
                  key={w.agentId}
                  className="card card-ext"
                  onClick={() => app.select(w.teamId, { focusTerminal: w.hosted })}
                  title={w.hosted ? 'Open its terminal' : 'This session runs outside Agent Office: answer in its own terminal'}
                >
                  <span className="card-head">
                    <Swatch color={colorOf(w.teamId)} />
                    <span className="card-who">{w.displayName}</span>
                    <span className="card-provider">{teams.find((t) => t.id === w.teamId)?.name ?? ''}</span>
                    <span className="card-age">{ago(now - w.since)}</span>
                  </span>
                  {w.detail && <span className="card-ext-detail">{w.detail}</span>}
                  <span className="card-ext-hint">
                    <IconTerminal size={12} />
                    {w.hosted ? 'Answer in its terminal' : 'Answer in its own terminal'}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  )
}
