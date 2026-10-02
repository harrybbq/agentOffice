// "Remember where I left off" (shared/restore.ts): the wake screen of an asleep row, the "where you
// left off" note of a session that was interrupted by the app closing, the launch summary, the
// sidebar's Recent list and the "when the app opens" setting.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { canWake } from '../../../shared/restore'
import type { RestoreMode, SavedSession } from '../../../shared/restore'
import type { ProviderId, SessionInfo } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { questionParts, shortenPath } from '../format'
import { cx, useNow } from '../hooks'
import { IconAlert, IconAsleep, IconChevron, IconClock, IconClose, IconPlay, IconTrash } from '../icons'
import {
  canContinue,
  canWakeRow,
  endedLabel,
  interruptedHeadline,
  lastActiveLabel,
  pendingPreview,
  RESTORE_MODES,
  restoreModeShort,
  visibleRecent
} from '../restore'

const PROVIDER_MARK: Record<ProviderId, string> = { 'claude-code': 'CC', codex: 'CX', antigravity: 'AG' }

/** A provider's two-letter mark in its colour (the same tints the world gives its characters). */
export function ProviderMark({ provider, label }: { provider: ProviderId; label?: string }) {
  return (
    <span className={cx('provider-mark', `provider-${provider}`)} role="img" aria-label={label ?? provider} title={label ?? provider}>
      {PROVIDER_MARK[provider] ?? provider.slice(0, 2).toUpperCase()}
    </span>
  )
}

function Question({ text }: { text: string }) {
  return <>{questionParts(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : p.text))}</>
}

/**
 * The "where you left off" note: the app closed while this session was working. The requests that
 * were waiting then died with the process, so they are listed as lost, never as still waiting.
 */
export function InterruptedNote({ session }: { session: SessionInfo }) {
  const app = useApp()
  const note = session.interruptedNote
  const now = useNow(30_000)
  const [sending, setSending] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const pending = useMemo(() => pendingPreview(note?.pending), [note])

  useEffect(() => setHint(null), [session.id, session.state])

  if (!note) return null
  const asleep = session.state === 'asleep'
  const ready = canContinue(session)

  const tell = async () => {
    if (sending) return
    setSending(true)
    setHint(null)
    const ok = await app.tellContinue(session.id)
    setSending(false)
    if (!ok && session.surface === 'chat') setHint('Send or clear what is in the message box first.')
  }

  return (
    <div className="left-off" role="status" aria-label="Where you left off">
      <IconAlert />
      <div className="left-off-body">
        <p className="left-off-head">{interruptedHeadline(note.closedAt, now)}</p>
        {pending.shown.length > 0 && (
          <>
            <p>These requests were waiting and were lost — ask again if you still need them:</p>
            <ul className="left-off-list">
              {pending.shown.map((q, i) => (
                <li key={i}>
                  <Question text={q} />
                </li>
              ))}
              {pending.more > 0 && <li className="is-more">{pending.more} more</li>}
            </ul>
          </>
        )}
        {hint && <p className="left-off-hint">{hint}</p>}
      </div>
      <div className="left-off-actions">
        {!asleep && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!ready || sending}
            onClick={() => void tell()}
            title={
              ready
                ? session.surface === 'chat'
                  ? 'Sends a "continue where you left off" message'
                  : 'Types a "continue where you left off" message into the terminal'
                : 'Available when the session is waiting for a prompt'
            }
          >
            {sending ? 'Sending…' : 'Tell it to continue'}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void app.dismissInterrupted(session.id)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

/** The panel of an asleep row: what it was, and one big button to resume its conversation. */
export function WakeView({ session, hidden }: { session: SessionInfo; hidden: boolean }) {
  const app = useApp()
  // Woken from here (the button), or by the main process (the automatic wake at launch).
  const waking = useAppState((s) => s.waking.has(session.id)) || session.waking === true
  const error = useAppState((s) => s.wakeErrors[session.id] ?? null)
  const provider = useAppState((s) => s.providers.find((p) => p.id === session.provider))
  const now = useNow(30_000)
  const wakeBtn = useRef<HTMLButtonElement>(null)
  const removeBtn = useRef<HTMLButtonElement>(null)
  const label = provider?.label ?? session.provider
  const wakeable = canWakeRow(session)
  const lastPrompt = session.lastPrompt
  const active = lastActiveLabel(session.lastActiveAt, now)

  useEffect(() => {
    app.focusWake = () => (wakeBtn.current ?? removeBtn.current)?.focus()
    return () => {
      app.focusWake = () => undefined
    }
  }, [app, session.id])

  return (
    <div className="wakeview" hidden={hidden}>
      <InterruptedNote session={session} />
      <div className="wake-scroll">
        <div className={cx('wake-card', waking && 'is-waking')}>
          <span className="wake-icon">
            <IconAsleep size={24} />
          </span>
          <h2 className="wake-title">{session.title}</h2>
          <p className="wake-sub">
            <ProviderMark provider={session.provider} label={label} />
            {label} · asleep{active ? ` · ${active}` : ''}
          </p>
          <p className="wake-cwd" title={session.cwd}>
            {session.cwd}
          </p>
          {(session.permissionMode !== 'default' || session.model) && (
            <p className="wake-chips">
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
            </p>
          )}
          {typeof lastPrompt === 'string' && lastPrompt.trim() && (
            <div className="wake-prompt">
              <span className="wake-prompt-label">Your last prompt</span>
              <p>{lastPrompt.trim()}</p>
            </div>
          )}

          {wakeable ? (
            <>
              <button type="button" className="btn btn-primary wake-btn" ref={wakeBtn} disabled={waking} onClick={() => void app.wake(session.id)}>
                {waking ? <span className="spinner" /> : <IconPlay />}
                <span className="wake-btn-text">
                  <strong>{waking ? 'Waking…' : 'Wake'}</strong>
                  <span>{waking ? `Starting ${label} and resuming the conversation` : 'Resume this conversation'}</span>
                </span>
              </button>
              {waking && <div className="wake-progress" role="progressbar" aria-label="Waking the session" />}
            </>
          ) : (
            <div className="wake-none">
              <p className="wake-none-title">No saved conversation to resume</p>
              <p>
                This session closed before {label} saved a conversation, so there is nothing to continue. Remove it, and start a new session in the folder if
                you still need it.
              </p>
            </div>
          )}

          {error && (
            <div className="form-error" role="alert">
              <IconAlert />
              <span>{error}</span>
            </div>
          )}

          <button
            type="button"
            className={cx('btn btn-sm', wakeable && 'btn-ghost')}
            ref={removeBtn}
            disabled={waking}
            onClick={() => app.removeSession(session.id)}
            title="Take it out of the list. It stays under Recent, from where it can be reopened."
          >
            Remove
          </button>
          <p className="wake-foot">
            {wakeable
              ? 'Asleep sessions use no memory. Removing one keeps it under Recent.'
              : 'Removing keeps its record under Recent until you forget it there.'}
          </p>
        </div>
      </div>
    </div>
  )
}

/** The one-time launch summary: "3 sessions restored · 2 were interrupted · 2 requests were lost". */
export function RestoreNotice() {
  const app = useApp()
  const notice = useAppState((s) => s.restoreNotice)
  // Nothing left to point at once every note was dismissed (or its session removed).
  const anyNote = useAppState((s) => s.sessions.some((x) => x.interruptedNote))

  // A summary, not a to-do: it goes away by itself. The rows keep their "Interrupted" marker.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => app.dismissRestoreNotice(), 60_000)
    return () => window.clearTimeout(timer)
  }, [app, notice])

  if (!notice || !anyNote) return null
  // "3 sessions restored" leads; what was interrupted and lost follows.
  const cut = notice.text.indexOf(' · ')
  const lead = cut < 0 ? notice.text : notice.text.slice(0, cut)
  const rest = cut < 0 ? '' : notice.text.slice(cut)
  return (
    <div className="restore-notice" role="status">
      <button type="button" className="restore-notice-main" onClick={() => app.openRestoreNotice()} title="Show the first interrupted session">
        <IconClock />
        <span>
          <strong>{lead}</strong>
          {rest}
        </span>
        <span className="restore-notice-go">Show</span>
      </button>
      <button type="button" className="icon-btn" onClick={() => app.dismissRestoreNotice()} aria-label="Dismiss" title="Dismiss">
        <IconClose size={12} />
      </button>
    </div>
  )
}

function RecentItem({ entry, now }: { entry: SavedSession; now: number }) {
  const app = useApp()
  const label = useAppState((s) => s.providers.find((p) => p.id === entry.provider)?.label ?? entry.provider)
  const reopening = useAppState((s) => s.reopening.has(entry.id))
  const error = useAppState((s) => (s.recentActionError?.id === entry.id ? s.recentActionError.text : null))
  const [confirm, setConfirm] = useState(false)
  const resumable = canWake(entry)
  const ended = endedLabel(entry.lastActiveAt, now)

  return (
    <li className={cx('recent-item', reopening && 'is-busy')}>
      <div className="recent-top">
        <ProviderMark provider={entry.provider} label={label} />
        <span className="recent-title" title={`${entry.title}\n${entry.cwd}`}>
          {entry.title}
        </span>
        {ended && (
          <time className="recent-when" dateTime={new Date(entry.lastActiveAt).toISOString()} title={new Date(entry.lastActiveAt).toLocaleString()}>
            {ended}
          </time>
        )}
      </div>
      <span className="session-path" title={entry.cwd}>
        {shortenPath(entry.cwd)}
      </span>
      {entry.lastPrompt?.trim() ? (
        <p className="recent-prompt" title={entry.lastPrompt}>
          {entry.lastPrompt.trim()}
        </p>
      ) : (
        <p className="recent-prompt is-blank">No prompt recorded</p>
      )}
      {confirm ? (
        <div className="recent-actions" role="group" aria-label="Forget this session?">
          <span className="recent-confirm">Forget it?</span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            autoFocus
            onClick={() => {
              setConfirm(false)
              void app.forgetRecent(entry.id)
            }}
          >
            Forget
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="recent-actions">
          {resumable ? (
            <button type="button" className="btn btn-sm" disabled={reopening} onClick={() => void app.reopenRecent(entry.id)} title={`Resume this conversation in ${shortenPath(entry.cwd)}`}>
              {reopening ? <span className="spinner" /> : <IconPlay size={13} />}
              {reopening ? 'Reopening…' : 'Reopen'}
            </button>
          ) : (
            <span className="recent-confirm is-muted">No saved conversation to resume</span>
          )}
          <button
            type="button"
            className="icon-btn recent-forget"
            disabled={reopening}
            onClick={() => setConfirm(true)}
            aria-label={`Forget ${entry.title}`}
            title={`Forget: remove it from this list. ${label}'s own history is not touched.`}
          >
            <IconTrash size={14} />
          </button>
        </div>
      )}
      {error && (
        <p className="recent-error" role="alert">
          <IconAlert size={13} />
          <span>{error}</span>
          <button type="button" className="icon-btn" onClick={() => app.clearRecentError()} aria-label="Dismiss">
            <IconClose size={11} />
          </button>
        </p>
      )}
    </li>
  )
}

/** The sidebar's footer: sessions that ended earlier, collapsed until asked for. */
export function RecentSection() {
  const app = useApp()
  const recent = useAppState((s) => s.recent)
  const status = useAppState((s) => s.recentStatus)
  const loadError = useAppState((s) => s.recentError)
  const open = useAppState((s) => s.layout.recentOpen)
  const now = useNow(30_000)
  const items = useMemo(() => visibleRecent(recent), [recent])

  // Opening the section asks again: sessions that ended since are in it.
  useEffect(() => {
    if (open) void app.refreshRecent()
  }, [app, open])

  if (!app.hasRestore) return null
  // Nothing ever ended: no empty section in the way.
  if (items.length === 0 && status !== 'error') return null

  return (
    <section className={cx('sidebar-recent', open && 'is-open')} aria-label="Recent sessions">
      <button type="button" className="recent-toggle" aria-expanded={open} onClick={() => app.setLayout({ recentOpen: !open })}>
        <IconChevron size={12} />
        <span>Recent</span>
        <span className="group-count">{items.length}</span>
        <span className="recent-toggle-hint">{open ? 'Hide' : 'Reopen a session…'}</span>
      </button>
      {open && (
        <>
          {status === 'error' && (
            <p className="recent-error" role="alert">
              <IconAlert size={13} />
              <span>{loadError}</span>
              <button type="button" className="link" onClick={() => void app.refreshRecent()}>
                Try again
              </button>
            </p>
          )}
          <ul className="recent-list">
            {items.map((x) => (
              <RecentItem key={x.id} entry={x} now={now} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** Status bar: what happens to the saved sessions when the app opens. */
export function RestoreSetting() {
  const app = useApp()
  const settings = useAppState((s) => s.restoreSettings)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // The status bar clips its children, so the popover is placed on the viewport.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = button.current?.getBoundingClientRect()
      if (!r) return
      const width = 300
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), bottom: window.innerHeight - r.top + 6 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!app.hasRestore || !settings) return null

  const pick = (mode: RestoreMode) => {
    void app.setRestoreSettings({ mode })
  }

  return (
    <>
      <button
        type="button"
        ref={button}
        className={cx('status-item status-btn', open && 'is-on')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="What happens to your sessions when Agent Office opens"
      >
        <IconAsleep size={14} />
        On open: {restoreModeShort(settings.mode)}
      </button>
      {open && pos && (
        <div className="restore-pop" ref={pop} role="dialog" aria-label="When the app opens" style={{ left: pos.left, bottom: pos.bottom }}>
          <p className="restore-pop-title">When the app opens</p>
          <div className="restore-pop-modes" role="radiogroup" aria-label="When the app opens">
            {RESTORE_MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={settings.mode === m.id} className={cx('restore-mode', settings.mode === m.id && 'is-selected')} onClick={() => pick(m.id)}>
                <span className="restore-radio" aria-hidden="true" />
                {m.label}
              </button>
            ))}
          </div>
          <p className="restore-pop-help">Your sessions always come back in the list; the others stay asleep until you wake them. Waking all uses more memory.</p>
        </div>
      )}
    </>
  )
}
