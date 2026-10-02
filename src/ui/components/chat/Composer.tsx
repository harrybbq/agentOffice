// The chat box under the message list: Enter sends, Shift+Enter adds a line, Up recalls earlier
// prompts. While a turn runs the prompt is added to that turn ("steer") and Interrupt sits next to
// the send button.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CHAT_MAX_PROMPT_CHARS } from '../../../../shared/chat'
import type { SessionInfo } from '../../../../shared/sessions'
import { useApp } from '../../controller'
import { composerState } from '../../format'
import { cx } from '../../hooks'
import { IconAlert, IconClose, IconInterrupt, IconSend } from '../../icons'
import { useStore } from '../../store'

const LINE = 20
const MAX_LINES = 8

export function Composer({ session, providerLabel }: { session: SessionInfo; providerLabel: string }) {
  const app = useApp()
  const id = session.id
  const store = app.chats.store(id)
  const ui = app.chats.ui(id)
  const sending = useStore(store, (s) => s.sending)
  const sendError = useStore(store, (s) => s.sendError)
  const [text, setTextState] = useState(ui.draft)
  const input = useRef<HTMLTextAreaElement>(null)
  /** Focus was asked while the box was disabled (a session that is still starting). */
  const wantFocus = useRef(false)
  const mode = composerState(session.state, providerLabel)
  const canSend = mode.enabled && !sending && text.trim().length > 0

  const setText = (next: string) => {
    ui.draft = next
    setTextState(next)
  }

  // Shortcuts (Ctrl+1..9, a new session, the empty state's suggestions) put the caret here.
  useEffect(() => {
    app.focusChat = (draft?: string) => {
      if (typeof draft === 'string') setText(draft)
      wantFocus.current = !!input.current?.disabled
      input.current?.focus()
    }
    return () => {
      app.focusChat = () => undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, id])

  useEffect(() => {
    if (!mode.enabled || !wantFocus.current) return
    wantFocus.current = false
    input.current?.focus()
  }, [mode.enabled])

  // Grow with the text, up to MAX_LINES; then the box scrolls.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, LINE * MAX_LINES)}px`
  }, [text])

  const submit = async () => {
    const body = text.trim()
    if (!body || !mode.enabled || sending) return
    const ok = await app.chats.send(id, body.slice(0, CHAT_MAX_PROMPT_CHARS))
    // Keep the text when it was refused: the user fixes the cause and sends again.
    if (ok && ui.draft.trim() === body) setText('')
    input.current?.focus()
  }

  const recall = (value: string | null): boolean => {
    if (value === null) return false
    setText(value)
    // Caret to the end, after React wrote the value.
    requestAnimationFrame(() => {
      const el = input.current
      if (el) el.selectionStart = el.selectionEnd = el.value.length
    })
    return true
  }

  const placeholder = !mode.enabled
    ? (mode.reason ?? '')
    : mode.steer
      ? `Add to the running turn: ${providerLabel} reads it after its current step`
      : `Ask ${providerLabel} to…`

  return (
    <form
      className={cx('composer', !mode.enabled && 'is-disabled', mode.steer && 'is-steer')}
      autoComplete="off"
      onSubmit={(ev) => {
        ev.preventDefault()
        void submit()
      }}
    >
      {sendError && (
        <div className="composer-error" role="alert">
          <IconAlert size={14} />
          <span>{sendError}</span>
          <button type="button" className="icon-btn" onClick={() => app.chats.clearSendError(id)} aria-label="Dismiss">
            <IconClose size={12} />
          </button>
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          value={text}
          disabled={!mode.enabled}
          maxLength={CHAT_MAX_PROMPT_CHARS}
          spellCheck={false}
          aria-label={mode.steer ? 'Add to the running turn' : `Message ${providerLabel}`}
          placeholder={placeholder}
          onChange={(ev) => {
            ui.history.reset()
            setText(ev.target.value)
            if (sendError) app.chats.clearSendError(id)
          }}
          onKeyDown={(ev) => {
            if (ev.nativeEvent.isComposing) return
            const el = ev.currentTarget
            const plain = !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey
            if (ev.key === 'Enter' && plain) {
              ev.preventDefault()
              void submit()
            } else if (ev.key === 'ArrowUp' && plain) {
              // Only from the first line with nothing selected, so editing a multi-line prompt keeps working.
              const atStart = el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes('\n')
              if (atStart && (el.value === '' || ui.history.browsing || el.selectionStart === 0) && recall(ui.history.prev(el.value))) ev.preventDefault()
            } else if (ev.key === 'ArrowDown' && plain && ui.history.browsing) {
              const atEnd = el.selectionStart === el.selectionEnd && !el.value.slice(el.selectionEnd).includes('\n')
              if (atEnd && recall(ui.history.next())) ev.preventDefault()
            } else if (ev.key === 'Escape') {
              if (mode.steer && !el.value) app.interrupt(id)
              else el.blur()
            }
          }}
        />
        <div className="composer-foot">
          <span className="composer-hint">
            {!mode.enabled ? null : mode.steer ? (
              <>
                <span className="spinner" />
                {session.state === 'waiting-permission' ? 'Waiting for your approval' : 'Working'} · <kbd>Enter</kbd> adds to this turn
              </>
            ) : (
              <>
                <kbd>Enter</kbd> send <kbd>Shift Enter</kbd> new line <kbd>↑</kbd> history
              </>
            )}
          </span>
          {mode.steer && (
            <button type="button" className="btn btn-sm" onClick={() => app.interrupt(id)} title="Interrupt the running turn (Esc in the empty box)">
              <IconInterrupt />
              Interrupt
            </button>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend}>
            <IconSend />
            {sending ? 'Sending…' : mode.steer ? 'Add to turn' : 'Send'}
          </button>
        </div>
      </div>
    </form>
  )
}
