// Start an agent CLI in a folder. The renderer only picks a provider id and a folder; the main
// process resolves the executable.
import { useEffect, useRef, useState } from 'react'
import type { PermissionMode, ProviderId } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { cleanError, shortenPath } from '../format'
import { cx } from '../hooks'
import { IconAlert, IconClose, IconFolder } from '../icons'

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'default', label: 'Ask', hint: 'Asks before edits and commands' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'File edits run without asking' },
  { id: 'plan', label: 'Plan', hint: 'Plans first, changes nothing' }
]

export function NewSessionDialog() {
  const app = useApp()
  const providers = useAppState((s) => s.providers)
  const recent = useAppState((s) => s.recentFolders)
  const firstAvailable = providers.find((p) => p.available)?.id ?? null

  const [provider, setProvider] = useState<ProviderId | null>(firstAvailable)
  const [cwd, setCwd] = useState(recent[0] ?? '')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [title, setTitle] = useState('')
  const [model, setModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)

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
    if (!cwd.trim()) return setError('Pick the folder the agent should work in.')
    setBusy(true)
    setError(null)
    try {
      await app.startSession({
        provider,
        cwd: cwd.trim(),
        permissionMode: mode,
        title: title.trim() || undefined,
        model: model.trim() || undefined
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
                  onClick={() => setProvider(p.id)}
                >
                  <span className="provider-name">{p.label}</span>
                  <span className="provider-note">{p.available ? (p.version ?? 'Ready') : (p.reason ?? 'Not available')}</span>
                </button>
              ))}
              {providers.length === 0 && <p className="field-hint">No providers reported by the app.</p>}
            </div>
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
            <p className="field-hint">{MODES.find((m) => m.id === mode)?.hint}</p>
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
              <input id="ns-model" className="input" value={model} onChange={(ev) => setModel(ev.target.value)} placeholder="Provider default" maxLength={80} spellCheck={false} />
            </div>
          </div>

          {error && (
            <div className="form-error" role="alert">
              <IconAlert />
              <span>{error}</span>
            </div>
          )}

          <footer className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => app.closeDialog()}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !provider}>
              {busy ? 'Starting…' : 'Start session'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
