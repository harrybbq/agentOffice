// Start an agent CLI in a folder. The renderer only picks a provider id and a folder; the main
// process resolves the executable.
import { useEffect, useRef, useState } from 'react'
import type { PermissionMode, ProviderId, SessionHistoryEntry } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { canResume, cleanError, loginHint, modeHints, modelHint, modelPlaceholder, shortenPath, whenAgo } from '../format'
import { cx } from '../hooks'
import { IconAlert, IconChevron, IconClose, IconFolder } from '../icons'
import { LoginPrompt, UsageMeter } from './ProviderAccount'

/** What each mode means differs per provider: the help line comes from format.modeHints. */
const MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Ask' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan' }
]

type History = { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; items: SessionHistoryEntry[] }

/**
 * "Resume previous…": the provider's earlier conversations in the chosen folder. Picking one makes
 * the new session continue it (its history is loaded into the chat); "Start a new conversation"
 * takes the choice back. The list is asked for when the disclosure opens and when the folder changes.
 */
function ResumePicker({ provider, cwd, value, onChange }: { provider: ProviderId; cwd: string; value: string | null; onChange: (id: string | null) => void }) {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<History>({ status: 'loading' })
  const folder = cwd.trim()

  useEffect(() => {
    if (!open) return
    // Another folder, another list: what was picked is no longer on offer.
    onChange(null)
    if (!folder) return setHistory({ status: 'ready', items: [] })
    let stale = false
    setHistory({ status: 'loading' })
    // Typing a path: wait until it stops changing.
    const timer = window.setTimeout(() => {
      app.history(provider, folder).then(
        (items) => !stale && setHistory({ status: 'ready', items }),
        (err: unknown) => !stale && setHistory({ status: 'error', text: cleanError(err) })
      )
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, open, provider, folder])

  return (
    <div className="resume">
      <button
        type="button"
        className={cx('card-toggle', open && 'is-open')}
        aria-expanded={open}
        onClick={() => {
          if (open) onChange(null)
          setOpen(!open)
        }}
      >
        <IconChevron size={12} />
        Resume previous…
      </button>
      {open && (
        <div className="resume-list" role="radiogroup" aria-label="Conversation to resume">
          {history.status === 'loading' && (
            <p className="field-hint resume-note" role="status">
              <span className="spinner" /> Looking for earlier conversations…
            </p>
          )}
          {history.status === 'error' && (
            <p className="field-hint resume-note is-error" role="alert">
              {history.text}
            </p>
          )}
          {history.status === 'ready' && history.items.length === 0 && (
            <p className="field-hint resume-note">{folder ? 'No earlier conversations in this folder.' : 'Choose a folder first.'}</p>
          )}
          {history.status === 'ready' && history.items.length > 0 && (
            <>
              <button type="button" role="radio" aria-checked={value === null} className={cx('resume-row', value === null && 'is-selected')} onClick={() => onChange(null)}>
                <span className="resume-preview is-new">Start a new conversation</span>
              </button>
              {history.items.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  role="radio"
                  aria-checked={value === h.id}
                  className={cx('resume-row', value === h.id && 'is-selected')}
                  onClick={() => onChange(h.id)}
                  title={h.preview || h.id}
                >
                  <span className={cx('resume-preview', !h.preview && 'is-blank')}>{h.preview || 'No prompt recorded'}</span>
                  <span className="resume-meta">
                    {h.model && <span className="resume-model">{h.model}</span>}
                    <time dateTime={new Date(h.updatedAt).toISOString()} title={new Date(h.updatedAt).toLocaleString()}>
                      {whenAgo(h.updatedAt)}
                    </time>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function NewSessionDialog() {
  const app = useApp()
  const providers = useAppState((s) => s.providers)
  const recent = useAppState((s) => s.recentFolders)
  // Sessions that ended earlier are reopened from the sidebar, not started again here.
  const reopenable = useAppState((s) => s.recent.items.length - s.recent.forgetting.size)
  // A provider that is ready to go comes first; one that still needs a sign-in is the fallback.
  const firstAvailable = (providers.find((p) => p.available && !loginHint(p)) ?? providers.find((p) => p.available))?.id ?? null

  const [provider, setProvider] = useState<ProviderId | null>(firstAvailable)
  const [cwd, setCwd] = useState(recent[0] ?? '')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [title, setTitle] = useState('')
  const [model, setModel] = useState('')
  const [resume, setResume] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const chosen = providers.find((p) => p.id === provider)
  const needsLogin = loginHint(chosen)

  useEffect(() => {
    if (!provider && firstAvailable) setProvider(firstAvailable)
  }, [provider, firstAvailable])

  // Keep Tab inside the dialog.
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Tab') return
      const items = [...el.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter((x) => !x.hasAttribute('disabled'))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault()
        last.focus()
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [])

  const browse = async () => {
    try {
      const picked = await app.pickFolder()
      if (picked) {
        setCwd(picked)
        setError(null)
      }
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const start = async () => {
    if (busy) return
    if (!provider) return setError('No provider is available.')
    if (needsLogin) return setError(`Sign in to ${chosen?.label ?? 'the provider'} first.`)
    if (!cwd.trim()) return setError('Pick the folder the agent should work in.')
    setBusy(true)
    setError(null)
    try {
      await app.startSession({
        provider,
        cwd: cwd.trim(),
        permissionMode: mode,
        title: title.trim() || undefined,
        model: model.trim() || undefined,
        resume: (canResume(provider) && resume) || undefined
      })
    } catch (err) {
      setError(cleanError(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && app.closeDialog()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" ref={dialog}>
        <header className="modal-head">
          <h1 id="new-session-title">New session</h1>
          <button type="button" className="icon-btn" onClick={() => app.closeDialog()} aria-label="Close" title="Close (Esc)">
            <IconClose />
          </button>
        </header>

        <form
          className="modal-body"
          onSubmit={(ev) => {
            ev.preventDefault()
            void start()
          }}
        >
          <fieldset className="field">
            <legend>Agent</legend>
            <div className="provider-grid">
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={cx('provider-card', provider === p.id && 'is-selected')}
                  disabled={!p.available}
                  aria-pressed={provider === p.id}
                  onClick={() => {
                    setProvider(p.id)
                    setError(null)
                  }}
                >
                  <span className="provider-name">{p.label}</span>
                  <span className={cx('provider-note', p.available && loginHint(p) && 'is-warn')}>
                    {!p.available
                      ? (p.reason ?? 'Not available')
                      : loginHint(p)
                        ? 'Sign in required'
                        : [p.version, p.account?.plan && `${p.account.plan} plan`].filter(Boolean).join(' · ') || 'Ready'}
                  </span>
                </button>
              ))}
              {providers.length === 0 && <p className="field-hint">No providers reported by the app.</p>}
            </div>
            {chosen && needsLogin && <LoginPrompt provider={chosen} variant="dialog" />}
          </fieldset>

          <div className="field">
            <label htmlFor="ns-folder">Folder</label>
            <div className="folder-row">
              <span className="input-icon">
                <IconFolder />
              </span>
              <input
                id="ns-folder"
                className="input input-mono"
                value={cwd}
                onChange={(ev) => setCwd(ev.target.value)}
                placeholder="Choose the folder the agent works in"
                spellCheck={false}
                autoFocus
              />
              <button type="button" className="btn" onClick={() => void browse()}>
                Browse…
              </button>
            </div>
            {recent.length > 0 && (
              <div className="recent">
                <span className="field-hint">Recent</span>
                {recent.slice(0, 5).map((r) => (
                  <button key={r} type="button" className={cx('recent-chip', r === cwd && 'is-selected')} onClick={() => setCwd(r)} title={r}>
                    {shortenPath(r)}
                  </button>
                ))}
              </div>
            )}
            {provider && canResume(provider) && !needsLogin && <ResumePicker key={provider} provider={provider} cwd={cwd} value={resume} onChange={setResume} />}
          </div>

          <fieldset className="field">
            <legend>Permission mode</legend>
            <div className="segmented" role="radiogroup">
              {MODES.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={cx('segment', mode === m.id && 'is-selected')} onClick={() => setMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="field-hint">{modeHints(provider)[mode]}</p>
          </fieldset>

          <div className="field-pair">
            <div className="field">
              <label htmlFor="ns-title">
                Title <span className="optional">optional</span>
              </label>
              <input id="ns-title" className="input" value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="Defaults to the model name" maxLength={60} />
            </div>
            <div className="field">
              <label htmlFor="ns-model">
                Model <span className="optional">optional</span>
              </label>
              <input id="ns-model" className="input" value={model} onChange={(ev) => setModel(ev.target.value)} placeholder={modelPlaceholder(provider)} maxLength={80} spellCheck={false} />
            </div>
          </div>
          {modelHint(provider) && (
            <div className="field quota-note">
              <p className="field-hint">{modelHint(provider)}</p>
              {chosen && !needsLogin && <UsageMeter usage={chosen.usage} />}
            </div>
          )}

          {error && (
            <div className="form-error" role="alert">
              <IconAlert />
              <span>{error}</span>
            </div>
          )}

          <footer className="modal-foot">
            {reopenable > 0 && (
              <button
                type="button"
                className="link modal-foot-aside"
                onClick={() => {
                  app.closeDialog()
                  app.setLayout({ recentOpen: true })
                }}
                title="Sessions that ended earlier are listed under Recent in the sidebar"
              >
                Reopen a recent session…
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => app.closeDialog()}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !provider || needsLogin}>
              {busy ? 'Starting…' : canResume(provider) && resume ? 'Resume session' : 'Start session'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
