// The CEO's order bar, docked under the world: pick who hears it, type, Enter sends.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ORDER_MAX_CHARS } from '../../../shared/orders'
import { useApp, useAppState } from '../controller'
import { orderTargets } from '../format'
import { cx } from '../hooks'
import { IconClose, IconMegaphone, IconSend } from '../icons'

export function OrderBar() {
  const app = useApp()
  const providers = useAppState((s) => s.providers)
  const sessions = useAppState((s) => s.sessions)
  const teams = useAppState((s) => s.teams)
  const allowOrders = useAppState((s) => s.settings?.allowOrders ?? false)
  const feedback = useAppState((s) => s.orderFeedback)
  const sending = useAppState((s) => s.sending)

  const options = useMemo(() => orderTargets(providers, sessions, teams), [providers, sessions, teams])
  const [target, setTarget] = useState('all')
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const value = options.some((o) => o.value === target) ? target : 'all'

  useEffect(() => {
    app.focusOrderBar = () => input.current?.focus()
    return () => {
      app.focusOrderBar = () => undefined
    }
  }, [app])

  // Grow with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [text])

  const submit = async () => {
    const body = text.trim()
    if (!body || sending) return
    const res = await app.sendOrder(value, body)
    if (res.delivered.length > 0) setText('')
    input.current?.focus()
  }

  const providerOpts = options.filter((o) => o.group === 'provider')
  const sessionOpts = options.filter((o) => o.group === 'session')

  return (
    <form
      className="orderbar"
      autoComplete="off"
      onSubmit={(ev) => {
        ev.preventDefault()
        void submit()
      }}
    >
      {feedback && (
        <div key={feedback.key} className={cx('order-result', `is-${feedback.tone}`)} role="status">
          <span className="order-result-head">{feedback.headline}</span>
          {feedback.failures.map((f) => (
            <span key={f.reason} className="order-failure">
              {f.names.length > 0 && <strong>{f.names.join(', ')}: </strong>}
              {f.reason}
            </span>
          ))}
          <button type="button" className="icon-btn" onClick={() => app.dismissOrderFeedback()} aria-label="Dismiss">
            <IconClose size={12} />
          </button>
        </div>
      )}
      <div className="orderbar-row">
        <label className="order-target">
          <IconMegaphone />
          <span className="visually-hidden">Order target</span>
          <select value={value} onChange={(ev) => setTarget(ev.target.value)} title="Who hears the CEO">
            <option value="all">Everyone</option>
            {providerOpts.length > 0 && (
              <optgroup label="Providers">
                {providerOpts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            )}
            {sessionOpts.length > 0 && (
              <optgroup label="Sessions">
                {sessionOpts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <textarea
          ref={input}
          className="order-input"
          rows={1}
          value={text}
          maxLength={ORDER_MAX_CHARS}
          spellCheck={false}
          aria-label="Order"
          title="Enter sends, Shift+Enter adds a line"
          placeholder={
            allowOrders
              ? `Order for ${(options.find((o) => o.value === value)?.label ?? 'everyone').replace(/^(Everyone|All )/, (m) => m.toLowerCase())}…`
              : 'Orders are off (turn them on below, or in the status bar)'
          }
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
              ev.preventDefault()
              void submit()
            } else if (ev.key === 'Escape') {
              ev.currentTarget.blur()
            }
          }}
        />
        <kbd className="order-hint">Ctrl K</kbd>
        <button type="submit" className="btn btn-primary" disabled={sending || !text.trim()}>
          <IconSend />
          {sending ? 'Sending' : 'Send'}
        </button>
      </div>
      {!allowOrders && (
        <p className="order-off">
          Orders are off: the app only watches.
          <button type="button" className="link" onClick={() => void app.setAllowOrders(true)}>
            Turn on
          </button>
        </p>
      )}
    </form>
  )
}
