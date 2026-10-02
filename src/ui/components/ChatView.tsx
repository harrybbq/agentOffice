// The selected session's conversation, for sessions with a chat surface (no terminal UI, e.g.
// Codex): the same header as the terminal, the message list, and the composer.
// The list renders a window of the newest items and grows when the user scrolls up; rows subscribe
// to their own item, so streaming re-renders one row per frame.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo } from '../../../shared/sessions'
import { awaitsApproval, startsTurn, windowTail } from '../chat/state'
import type { ChatSessionState, ChatUi } from '../chats'
import { CHAT_WINDOW } from '../chats'
import { useApp, useAppState } from '../controller'
import { clock } from '../format'
import { cx } from '../hooks'
import { IconAlert, IconArrowDown, IconChat } from '../icons'
import type { Store } from '../store'
import { useStore } from '../store'
import { Composer } from './chat/Composer'
import { ItemView } from './chat/items'
import { SessionHeader } from './SessionHeader'

/** Closer to the bottom than this counts as "at the bottom" (the list follows new output). */
const PIN_PX = 56
/** Scrolling this close to the top loads earlier items. */
const LOAD_PX = 240

function dayAndTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = clock(ts).slice(0, 5)
  return sameDay ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

const Row = memo(function Row({ store, id, prevId }: { store: Store<ChatSessionState>; id: string; prevId: string | undefined }) {
  const item = useStore(store, (s) => s.items[id])
  const sep = useStore(store, (s) => startsTurn(prevId ? s.items[prevId] : undefined, s.items[id]))
  const awaiting = useStore(store, (s) => awaitsApproval(s, id))
  if (!item) return null
  return (
    <>
      {sep && (
        <div className="chat-sep" role="separator">
          <span>{dayAndTime(item.ts)}</span>
        </div>
      )}
      <div className={cx('chat-row', `kind-${item.kind}`)} data-item={id}>
        <ItemView item={item} awaiting={awaiting} />
        <time className="chat-ts" dateTime={new Date(item.ts).toISOString()}>
          {clock(item.ts)}
        </time>
      </div>
    </>
  )
})

const SUGGESTIONS = ['Explain how this project is put together', 'Find and fix a bug in the tests', 'Review my uncommitted changes']

function MessageList({ session, store, ui, providerLabel }: { session: SessionInfo; store: Store<ChatSessionState>; ui: ChatUi; providerLabel: string }) {
  const app = useApp()
  const order = useStore(store, (s) => s.order)
  const status = useStore(store, (s) => s.status)
  const error = useStore(store, (s) => s.error)
  const [limit, setLimit] = useState(ui.limit)
  const [away, setAway] = useState(!ui.pinned)
  const [seen, setSeen] = useState(order.length)
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const pinned = useRef(ui.pinned)
  /** scrollHeight and scrollTop just before earlier items were added above. */
  const before = useRef<{ height: number; top: number } | null>(null)
  const { ids, hidden } = useMemo(() => windowTail(order, limit), [order, limit])

  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Back where the user left this session; a new session starts at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (ui.pinned) toBottom()
    else el.scrollTop = ui.scrollTop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the tail: any change of the content's or the viewport's height (a token, a new row, a
  // card folding, the composer growing) keeps the bottom in view while the user is at the bottom.
  useEffect(() => {
    const el = scroller.current
    const col = column.current
    if (!el || !col) return
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom()
    })
    ro.observe(el)
    ro.observe(col)
    return () => ro.disconnect()
  }, [])

  // Earlier items were added above: keep what the user was looking at in place.
  useLayoutEffect(() => {
    const el = scroller.current
    const b = before.current
    before.current = null
    if (el && b) el.scrollTop = b.top + (el.scrollHeight - b.height)
  }, [limit])

  useEffect(() => {
    if (pinned.current) setSeen(order.length)
  }, [order.length])

  const onScroll = () => {
    const el = scroller.current
    if (!el || el.clientHeight === 0) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_PX
    pinned.current = ui.pinned = atBottom
    ui.scrollTop = el.scrollTop
    if (atBottom === away) setAway(!atBottom)
    if (atBottom) {
      setSeen(order.length)
      // Back at the bottom: the window shrinks again on the next visit, not under the user's eyes.
      ui.limit = CHAT_WINDOW
    } else if (el.scrollTop < LOAD_PX && hidden > 0 && !before.current) {
      before.current = { height: el.scrollHeight, top: el.scrollTop }
      ui.limit = limit + CHAT_WINDOW
      setLimit(ui.limit)
    }
  }

  const jump = () => {
    pinned.current = ui.pinned = true
    setAway(false)
    setSeen(order.length)
    toBottom()
  }

  const fresh = order.length - seen
  const empty = order.length === 0

  return (
    <div className="chat-body">
      <div className="chat-scroll" ref={scroller} onScroll={onScroll} tabIndex={-1}>
        <div className={cx('chat-col', empty && 'is-empty')} ref={column}>
          {empty && status === 'loading' && (
            <div className="chat-loading" role="status" aria-label="Loading the conversation">
              <span className="skel skel-right" />
              <span className="skel" />
              <span className="skel skel-short" />
              <span className="skel skel-card" />
              <p>Loading the conversation…</p>
            </div>
          )}
          {empty && status === 'error' && (
            <div className="panel-empty">
              <span className="panel-empty-icon is-warn">
                <IconAlert size={22} />
              </span>
              <p className="panel-empty-title">Couldn't load this conversation</p>
              <p>{error}</p>
              <button type="button" className="btn" onClick={() => app.chats.reload(session.id)}>
                Try again
              </button>
            </div>
          )}
          {empty && (status === 'ready' || status === 'idle') && (
            <div className="panel-empty chat-empty">
              <span className="panel-empty-icon">
                <IconChat size={22} />
              </span>
              {session.state === 'exited' ? (
                <>
                  <p className="panel-empty-title">Nothing was said in this session</p>
                  <p>It ended before the first prompt.</p>
                </>
              ) : (
                <>
                  <p className="panel-empty-title">Ask {providerLabel} to…</p>
                  <p>
                    It works in <code className="md-code">{session.cwd}</code>. Commands, file changes and approvals show up here as it goes.
                  </p>
                  {session.state === 'idle' && (
                    <div className="chat-suggestions">
                      {SUGGESTIONS.map((s) => (
                        <button key={s} type="button" className="recent-chip" onClick={() => app.focusChat(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {hidden > 0 && (
            <button
              type="button"
              className="chat-earlier"
              onClick={() => {
                const el = scroller.current
                if (el) before.current = { height: el.scrollHeight, top: el.scrollTop }
                ui.limit = limit + CHAT_WINDOW
                setLimit(ui.limit)
              }}
            >
              Show earlier messages ({hidden})
            </button>
          )}
          {ids.map((id, i) => (
            <Row key={id} store={store} id={id} prevId={i > 0 ? ids[i - 1] : order[hidden - 1]} />
          ))}
          {!empty && status === 'error' && (
            <div className="notice is-warning" role="status">
              <IconAlert size={14} />
              <span>Live updates stopped: {error}</span>
              <button type="button" className="btn btn-sm" onClick={() => app.chats.reload(session.id)}>
                Reconnect
              </button>
            </div>
          )}
        </div>
      </div>
      {away && !empty && (
        <button type="button" className={cx('chat-jump', fresh > 0 && 'has-new')} onClick={jump}>
          <IconArrowDown size={13} />
          {fresh > 0 ? `${fresh} new · Jump to latest` : 'Jump to latest'}
        </button>
      )}
    </div>
  )
}

export function ChatView({ hidden }: { hidden: boolean }) {
  const app = useApp()
  const selectedId = useAppState((s) => s.selectedId)
  const sessions = useAppState((s) => s.sessions)
  const providers = useAppState((s) => s.providers)
  const overlay = useAppState((s) => s.settings?.overlay ?? false)
  const selected = sessions.find((s) => s.id === selectedId) ?? null
  const session = selected && selected.surface === 'chat' ? selected : null
  const sessionId = session?.id ?? null
  const providerLabel = providers.find((p) => p.id === session?.provider)?.label ?? 'the agent'

  // First time a chat session is shown: ask for its items (and for the events that follow).
  useEffect(() => {
    if (sessionId && !overlay) app.chats.open(sessionId)
  }, [app, sessionId, overlay])

  if (!session) return <div className="chatview" hidden />

  return (
    <div className="chatview" hidden={hidden}>
      <SessionHeader session={session} onInterrupted={() => app.focusChat()} />
      {session.state === 'needs-attention' && (
        <div className="term-banner is-warn" role="status">
          <IconAlert />
          {providers.find((p) => p.id === session.provider)?.account?.loggedIn === false ? (
            <>
              <span>
                <strong>You are signed out of {providerLabel}.</strong> Log in to keep working in this session.
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void app.login(session.provider)}>
                Log in
              </button>
            </>
          ) : (
            <span>
              <strong>{providerLabel} needs your attention.</strong> It can't take prompts right now; the latest notice in the conversation says why.
            </span>
          )}
        </div>
      )}
      {session.state === 'exited' && (
        <div className="term-banner" role="status">
          <span>
            <strong>Session ended</strong>
            {session.exitCode === null || session.exitCode === undefined ? '.' : ` with exit code ${session.exitCode}.`} The conversation below is
            kept until you remove it.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => app.removeSession(session.id)}>
            Remove from list
          </button>
        </div>
      )}
      {/* Keyed by session: the list and the composer start from that session's own saved view. */}
      <MessageList key={`l-${session.id}`} session={session} store={app.chats.store(session.id)} ui={app.chats.ui(session.id)} providerLabel={providerLabel} />
      <Composer key={`c-${session.id}`} session={session} providerLabel={providerLabel} />
    </div>
  )
}
