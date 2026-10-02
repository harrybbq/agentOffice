// Account state of a provider that has its own sign-in (Codex, Antigravity): the login prompt and
// the usage meter. Used by the sidebar's provider header and the new-session dialog.
// Codex's login is started by the app (it opens the browser). Antigravity's cannot be: the provider
// says what to do (`loginHelp`), and the button looks again ("Check again").
import type { ProviderInfo } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { usageInfo } from '../format'
import { cx } from '../hooks'
import { IconAlert, IconLogin } from '../icons'

/** `text` with `code` spans for what is between backticks. */
function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))
}

/**
 * A provider whose sign-in happens outside the app: the instruction, and "Check again" (the main
 * process looks whether the CLI is signed in now; the provider list updates when it is).
 */
function ManualLogin({ provider, variant, help }: { provider: ProviderInfo; variant: 'sidebar' | 'dialog'; help: string }) {
  const app = useApp()
  const checking = useAppState((s) => s.loggingIn.has(provider.id))
  const checked = useAppState((s) => s.loginError?.provider === provider.id)
  return (
    <div className={cx('login', `login-${variant}`, 'login-manual')}>
      <p className="login-text">
        {variant === 'dialog' ? `${provider.label} is not signed in. ` : 'Not signed in. '}
        {withCode(help)}
      </p>
      <button type="button" className={cx('btn btn-sm', variant === 'dialog' && 'btn-primary')} disabled={checking} onClick={() => void app.login(provider.id)}>
        {checking && <span className="spinner" />}
        {checking ? 'Checking…' : 'Check again'}
      </button>
      {checked && !checking && (
        <p className="login-error" role="status">
          <IconAlert size={13} />
          Still not signed in.
        </p>
      )}
    </div>
  )
}

/** "Log in" → "Finish signing in in your browser…" until onProvidersChanged reports the account. */
export function LoginPrompt({ provider, variant }: { provider: ProviderInfo; variant: 'sidebar' | 'dialog' }) {
  const app = useApp()
  const waiting = useAppState((s) => s.loggingIn.has(provider.id))
  const error = useAppState((s) => (s.loginError?.provider === provider.id ? s.loginError.text : null))
  if (provider.loginHelp) return <ManualLogin provider={provider} variant={variant} help={provider.loginHelp} />
  return (
    <div className={cx('login', `login-${variant}`)}>
      {waiting ? (
        <p className="login-wait" role="status">
          <span className="spinner" />
          Finish signing in in your browser…
          <button type="button" className="link" onClick={() => app.cancelLogin(provider.id)} title="Stop waiting (you can log in again)">
            Cancel
          </button>
        </p>
      ) : (
        <>
          <p className="login-text">{variant === 'dialog' ? `Sign in to ${provider.label} before starting a session. It opens your browser.` : 'Not signed in'}</p>
          <button type="button" className={cx('btn btn-sm', variant === 'dialog' && 'btn-primary')} onClick={() => void app.login(provider.id)}>
            <IconLogin size={14} />
            Log in
          </button>
        </>
      )}
      {error && (
        <p className="login-error" role="alert">
          <IconAlert size={13} />
          {error}
        </p>
      )}
    </div>
  )
}

/** How much of the provider's rate-limit window is used. The tooltip has the reset date. */
export function UsageMeter({ usage }: { usage: ProviderInfo['usage'] }) {
  const u = usageInfo(usage)
  if (!u) return null
  return (
    <div className="usage" title={u.title} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.percent} aria-label="Usage limit used">
      <span className="usage-track">
        <span className={cx('usage-fill', `tone-${u.tone}`)} style={{ width: `${Math.max(u.percent, 2)}%` }} />
      </span>
      <span className="usage-label">{u.label} used</span>
    </div>
  )
}
