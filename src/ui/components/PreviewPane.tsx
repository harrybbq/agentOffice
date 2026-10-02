// The live preview pane, left of the office: the web app the selected session's team is building,
// in a sandboxed frame that only ever loads pages from this computer (shared/preview.ts).
// Collapsed it is a narrow rail. State: ../previewStore.ts; pure logic: ../preview.ts.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { PreviewBridge, PreviewInfo, PreviewSuggestion } from '../../../shared/preview'
import type { SessionInfo } from '../../../shared/sessions'
import { useApp, useAppState } from '../controller'
import { cx, useNow, useWindowWidth } from '../hooks'
import { IconClose, IconStop } from '../icons'
import {
  checkAddress,
  blockedNotice,
  clampPaneWidth,
  DEVICES,
  DOT_LABEL,
  dotState,
  fallbackText,
  fallbackTitle,
  frameLayout,
  PANE_DEFAULT,
  paneFootprint,
  scaleLabel,
  shortAddress,
  showsFallback,
  updatedLabel,
  type DeviceId
} from '../preview'
import { previewController, type PreviewController } from '../previewStore'
import { useStore } from '../store'
import '../styles/preview.css'

/** The sidebar's fixed width (styles/app.css): the pane shares the rest of the window. */
export const SIDEBAR_WIDTH = 236
/** No `load` from the frame after this long: offer the browser instead. */
const LOAD_TIMEOUT_MS = 12_000
/** While the empty state is on screen it looks for new addresses this often. */
const OPTIONS_EVERY_MS = 5000
const LOG_EVERY_MS = 1500
/**
 * What the previewed page may do. It runs in a frame of another origin than the app (so it cannot
 * reach the app), may run its scripts, submit its forms, show its dialogs and open links (which the
 * main process sends to the system browser). No `allow` attribute: no camera, clipboard, etc.
 */
const SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals'

// ---- icons (16px grid, stroke = currentColor, like ../icons.tsx) -----------------------------------

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}
const IconPreview = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M2 6h12M4.25 4.5h.01M6 4.5h.01" />
  </Svg>
)
const IconReload = () => (
  <Svg>
    <path d="M13 8a5 5 0 1 1-1.6-3.67" />
    <path d="M13 2.75v2.5h-2.5" />
  </Svg>
)
const IconExternal = () => (
  <Svg>
    <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
  </Svg>
)
const IconPin = () => (
  <Svg>
    <path d="M9.5 2.5 13.5 6.5 11 7.5 8.75 9.75 8.5 12.5 3.5 7.5 6.25 7.25 8.5 5z" />
    <path d="M6 10 2.75 13.25" />
  </Svg>
)

// ---- small hooks -----------------------------------------------------------------------------------

function useSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }] {
  const [size, setSize] = useState({ w: 0, h: 0 })
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }))
    }
    measure()
    observer.current = new ResizeObserver(measure)
    observer.current.observe(el)
  }, [])
  return [ref, size]
}

const isLive = (s: SessionInfo | null): boolean =>!!s && s.state !== 'asleep' && s.state !== 'exited'
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// ---- the pane --------------------------------------------------------------------------------------

export function PreviewPane() {
  const app = useApp()
  const pv = previewController(app.bridge)
  const bridge = pv.bridge
  const pane = useStore(pv.store, (s) => s.pane)
  const selectedId = useAppState((s) => s.selectedId)
  const sessions = useAppState((s) => s.sessions)
  const total = useWindowWidth() - SIDEBAR_WIDTH
  // A remembered pin of a session that no longer exists does not count.
  const pinned = pane.pinned !== null && sessions.some((x) => x.id === pane.pinned) ? pane.pinned : null
  const shownId = pinned ?? selectedId
  const session = sessions.find((x) => x.id === shownId) ?? null
  const live = isLive(session)
  const info = useStore(pv.store, (s) => (shownId ? (s.infos[shownId] ?? null) : null))
  const found = useStore(pv.store, (s) => (shownId ? !!s.found[shownId] : false))
  const pulse = useStore(pv.store, (s) => (shownId ? (s.pulses[shownId] ?? 0) : 0))
  const updatedAt = useStore(pv.store, (s) => (shownId ? s.updatedAt[shownId] : undefined))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Bumped to load the frame again (Reload, or the server came back). */
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (sessions.length > 0) pv.sessions(sessions.map((s) => s.id))
  }, [pv, sessions])

  // After a reload of the window the store is empty: ask what the session's preview is.
  useEffect(() => {
    if (!bridge || !shownId || !live) return
    let stale = false
    bridge
      .get(shownId)
      .then((i) => {
        if (stale) return
        if (i) pv.apply(i)
        else pv.clear(shownId)
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [bridge, pv, shownId, live])

  useEffect(() => {
    setError(null)
    setNotice(null)
  }, [shownId])

  // The page tried to leave for a web site: the main process stopped it (and opened a link in the
  // browser). Put the frame back on its page, unless it does that again right away.
  const blocked = useStore(pv.store, (s) => s.blocked)
  const lastBlocked = useRef(0)
  useEffect(() => {
    if (!blocked) return
    const now = Date.now()
    const n = blockedNotice(blocked, now - lastBlocked.current)
    lastBlocked.current = now
    setNotice(n.text)
    if (!n.restore) return
    setNonce((x) => x + 1)
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [blocked])

  // The server was down and is back: load the page again by itself.
  const status = info?.status
  const lastStatus = useRef(status)
  useEffect(() => {
    if (lastStatus.current === 'unreachable' && status === 'ready') setNonce((n) => n + 1)
    lastStatus.current = status
  }, [status])

  /** Runs one of the bridge's calls for the shown session; a failure becomes the pane's error line. */
  const act = useCallback(
    async (fn: (b: PreviewBridge, id: string) => Promise<PreviewInfo | void>): Promise<boolean> => {
      if (!bridge || !shownId) return false
      setBusy(true)
      setError(null)
      try {
        const out = await fn(bridge, shownId)
        if (out) pv.apply(out)
        return true
      } catch (err) {
        setError(message(err))
        return false
      } finally {
        setBusy(false)
      }
    },
    [bridge, pv, shownId]
  )

  const openAddress = useCallback(
    async (typed: string): Promise<boolean> => {
      const checked = checkAddress(typed)
      setNotice(null)
      if (!checked.ok) {
        setError(checked.error)
        return false
      }
      const ok = await act((b, id) => b.open(id, checked.url))
      if (ok) setNonce((n) => n + 1)
      return ok
    },
    [act]
  )

  if (!bridge) return null

  const dot = dotState(info)
  if (!pane.open) {
    const hint = dot === 'none' && found ? 'A web server was found in this session. Open the preview' : 'Show the preview pane'
    return (
      <aside className="preview-rail" aria-label="Preview (collapsed)">
        <button type="button" className="preview-rail-btn" onClick={() => pv.dispatch({ type: 'open' })} title={hint} aria-label={hint} aria-expanded={false}>
          <IconPreview />
          <span className={cx('preview-dot', `is-${dot}`, dot === 'none' && found && 'is-found')} aria-hidden="true" />
          <span className="preview-rail-label">Preview</span>
        </button>
      </aside>
    )
  }

  const width = clampPaneWidth(pane.width, total)
  const current = info ? info.currentUrl || info.url : ''
  const openExternal = (url: string): void => {
    if (app.bridge.openExternal) void app.bridge.openExternal(url)
    else window.open(url, '_blank', 'noopener')
  }

  return (
    <>
      <aside className="preview" style={{ width }} aria-label="Preview">
        <header className="preview-head">
          <div className="preview-title">
            <span key={pulse} className={cx('preview-dot', `is-${dot}`, pulse > 0 && 'is-pulse')} role="img" aria-label={DOT_LABEL[dot]} title={DOT_LABEL[dot]} />
            <span className="preview-name" title={info?.title ?? undefined}>
              {session ? session.title : 'Preview'}
              {info?.title && <span className="preview-page"> · {info.title}</span>}
            </span>
            <UpdatedLabel at={dot === 'live' ? updatedAt : undefined} />
          </div>
          <div className="preview-tools">
            {session && (
              <button
                type="button"
                className={cx('icon-btn', pinned && 'is-on')}
                aria-pressed={!!pinned}
                onClick={() => pv.dispatch({ type: 'pin', sessionId: pinned ? null : session.id })}
                title={pinned ? 'Unpin: follow the selected session again' : 'Pin: keep showing this session while you select others'}
                aria-label={pinned ? 'Unpin the preview' : 'Pin the preview to this session'}
              >
                <IconPin />
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => pv.dispatch({ type: 'close' })} title="Hide the preview" aria-label="Hide the preview">
              <IconClose />
            </button>
          </div>
        </header>

        <AddressBar
          key={shownId ?? 'none'}
          url={current}
          disabled={!live || busy}
          hasPreview={!!info}
          canReload={!!info?.url}
          onOpen={openAddress}
          onReload={() => {
            setNotice(null)
            setNonce((n) => n + 1)
          }}
          onExternal={() => current && openExternal(current)}
          onStop={() => void act((b, id) => b.stop(id))}
        />

        {info && (
          <div className="preview-devices" role="group" aria-label="Width of the page">
            {DEVICES.map((d) => (
              <button
                key={d.id}
                type="button"
                className={cx('preview-device', pane.device === d.id && 'is-active')}
                aria-pressed={pane.device === d.id}
                onClick={() => pv.dispatch({ type: 'device', device: d.id })}
                title={d.width ? `${d.label}: ${d.width} px wide` : 'As wide as the pane'}
              >
                {d.label}
                {d.width && <span className="preview-device-px">{d.width}</span>}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="preview-error" role="alert">
            <span>{error}</span>
            <button type="button" className="icon-btn" onClick={() => setError(null)} aria-label="Dismiss">
              <IconClose />
            </button>
          </div>
        )}

        {notice && !error && (
          <div className="preview-notice" role="status">
            <span>{notice}</span>
            <button type="button" className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
              <IconClose />
            </button>
          </div>
        )}

        <div className="preview-body">
          {!session ? (
            <Quiet title="No session selected" text="Select a session and the web app its team is building shows here." />
          ) : !live ? (
            <Quiet title="This session is not running" text={session.state === 'asleep' ? 'Wake it and its preview can come back.' : 'Start a session to preview what its team builds.'} />
          ) : info ? (
            <Frame key={session.id} info={info} nonce={nonce} device={pane.device} demoDoc={bridge.demoDoc?.(session.id) ?? null} onExternal={openExternal} onRetry={() => void openAddress(current)} />
          ) : (
            <EmptyState key={session.id} sessionId={session.id} bridge={bridge} pv={pv} busy={busy} act={act} onOpen={openAddress} />
          )}
        </div>

        {info?.script && session && <ScriptLog key={session.id + info.script} sessionId={session.id} bridge={bridge} info={info} />}
      </aside>
      <PaneSplitter pv={pv} total={total} width={width} />
    </>
  )
}

/** How much window width the pane takes right now (App.tsx: where the terminal panel docks). */
export function usePreviewFootprint(): number {
  const app = useApp()
  const pv = previewController(app.bridge)
  const pane = useStore(pv.store, (s) => s.pane)
  const total = useWindowWidth() - SIDEBAR_WIDTH
  const overlay = useAppState((s) => s.settings?.overlay ?? false)
  if (!pv.bridge || overlay) return 0
  return paneFootprint(pane, total)
}

function UpdatedLabel({ at }: { at: number | undefined }) {
  const now = useNow(1000)
  const text = updatedLabel(at, now)
  return text ? <span className="preview-updated">{text}</span> : null
}

function Quiet({ title, text }: { title: string; text: string }) {
  return (
    <div className="preview-quiet">
      <p className="preview-quiet-title">{title}</p>
      <p>{text}</p>
    </div>
  )
}

// ---- address bar -----------------------------------------------------------------------------------

function AddressBar(props: {
  url: string
  disabled: boolean
  hasPreview: boolean
  canReload: boolean
  onOpen: (typed: string) => Promise<boolean>
  onReload: () => void
  onExternal: () => void
  onStop: () => void
}) {
  const [draft, setDraft] = useState(props.url)
  const focused = useRef(false)
  // The frame went somewhere else (or another preview opened): show that, unless the user is typing.
  useEffect(() => {
    if (!focused.current) setDraft(props.url)
  }, [props.url])

  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    void props.onOpen(draft)
  }
  return (
    <form className="preview-address" onSubmit={submit}>
      <input
        className="input input-mono preview-address-input"
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        onFocus={(ev) => {
          focused.current = true
          ev.target.select()
        }}
        onBlur={() => {
          focused.current = false
        }}
        onKeyDown={(ev) => {
          if (ev.key === 'Escape') {
            setDraft(props.url)
            ev.currentTarget.blur()
          }
        }}
        placeholder="http://localhost:5173"
        aria-label="Address of the page to preview (this computer only)"
        spellCheck={false}
        autoComplete="off"
        disabled={props.disabled}
      />
      <button type="button" className="icon-btn" onClick={props.onReload} disabled={!props.canReload} title="Reload the page" aria-label="Reload the page">
        <IconReload />
      </button>
      <button type="button" className="icon-btn" onClick={props.onExternal} disabled={!props.canReload} title="Open in my browser" aria-label="Open in my browser">
        <IconExternal />
      </button>
      <button type="button" className="icon-btn" onClick={props.onStop} disabled={!props.hasPreview} title="Stop the preview (the session keeps running)" aria-label="Stop the preview">
        <IconStop />
      </button>
    </form>
  )
}

// ---- the frame -------------------------------------------------------------------------------------

function Frame(props: { info: PreviewInfo; nonce: number; device: DeviceId; demoDoc: string | null; onExternal: (url: string) => void; onRetry: () => void }) {
  const { info, nonce, demoDoc } = props
  const [stageRef, size] = useSize()
  const [timedOut, setTimedOut] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // The page the frame was sent to. Following links inside the frame must not send it there again
  // (info.currentUrl changes then, info.url does not); Reload stays on the page the frame is on now.
  const [nav, setNav] = useState({ nonce, base: info.url, url: info.url })
  if (nav.nonce !== nonce) setNav({ nonce, base: info.url, url: info.currentUrl || info.url })
  else if (nav.base !== info.url) setNav({ nonce, base: info.url, url: info.url })
  const target = nav.url

  const frameKey = `${nonce}|${target}`
  useEffect(() => {
    setLoaded(false)
    setTimedOut(false)
    if (!target || demoDoc !== null) return
    const timer = window.setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [frameKey, target, demoDoc])

  const device = DEVICES.find((d) => d.id === props.device) ?? DEVICES[0]!
  const layout = frameLayout(size.w, size.h, device.width)
  const fallback = showsFallback(info, timedOut && !loaded)
  const starting = !info.url
  const label = scaleLabel(layout.scale)

  return (
    <div className={cx('preview-stage', device.width !== null && 'is-device')} ref={stageRef}>
      {target && size.w > 0 && (
        <iframe
          key={frameKey}
          className="preview-frame"
          title={info.title ? `Preview: ${info.title}` : 'Preview of the web app'}
          {...(demoDoc !== null ? { srcDoc: demoDoc, sandbox: '' } : { src: target, sandbox: SANDBOX })}
          referrerPolicy="no-referrer"
          style={{ width: layout.width, height: layout.height, left: layout.left, transform: layout.scale === 1 ? undefined : `scale(${layout.scale})` }}
          onLoad={() => {
            setLoaded(true)
            setTimedOut(false)
          }}
          onError={() => setTimedOut(true)}
        />
      )}
      {label && <span className="preview-scale">{label}</span>}
      {fallback && (
        <div className="preview-fallback" role="status">
          {starting && info.status === 'starting' && <span className="preview-spinner" aria-hidden="true" />}
          <p className="preview-quiet-title">{fallbackTitle(info)}</p>
          <p>{fallbackText(info, timedOut && !loaded)}</p>
          {!starting && (
            <div className="preview-fallback-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => props.onExternal(info.currentUrl || info.url)}>
                <IconExternal />
                Open in my browser
              </button>
              <button type="button" className="btn btn-sm" onClick={props.onRetry}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---- empty state -----------------------------------------------------------------------------------

interface Options {
  suggestions: PreviewSuggestion[]
  entries: string[]
  scripts: string[]
}

function EmptyState(props: {
  sessionId: string
  bridge: PreviewBridge
  pv: PreviewController
  busy: boolean
  act: (fn: (b: PreviewBridge, id: string) => Promise<PreviewInfo | void>) => Promise<boolean>
  onOpen: (typed: string) => Promise<boolean>
}) {
  const { sessionId, bridge, pv, busy, act } = props
  const [options, setOptions] = useState<Options | null>(null)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    let stale = false
    const load = (): void => {
      const safe = <T,>(p: Promise<T[]>): Promise<T[]> => p.catch(() => [])
      void Promise.all([safe(bridge.suggestions(sessionId)), safe(bridge.staticEntries(sessionId)), safe(bridge.scripts(sessionId))]).then(([suggestions, entries, scripts]) => {
        if (!stale) setOptions({ suggestions, entries, scripts })
      })
    }
    load()
    const timer = window.setInterval(load, OPTIONS_EVERY_MS)
    const off = pv.onDetected((id) => {
      if (id === sessionId) load()
    })
    return () => {
      stale = true
      window.clearInterval(timer)
      off()
    }
  }, [bridge, pv, sessionId])

  const nothing = options !== null && options.suggestions.length === 0 && options.entries.length === 0 && options.scripts.length === 0

  return (
    <div className="preview-empty">
      <h3 className="preview-empty-title">See what this team is building</h3>
      {options === null && <p className="preview-empty-hint">Looking for a web app in this session…</p>}

      {options?.suggestions.map((s) => (
        <div className="preview-option is-found" key={s.url}>
          <div className="preview-option-text">
            <span className="preview-option-title">
              Found <code>{shortAddress(s.url)}</code>
            </span>
            <span className="preview-option-note">A server is running at this address (seen in the {s.source}).</span>
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void props.onOpen(s.url)}>
            Open
          </button>
        </div>
      ))}

      {options?.entries.map((entry) => (
        <div className="preview-option" key={entry}>
          <div className="preview-option-text">
            <span className="preview-option-title">{entry === 'index.html' ? 'Serve this folder' : `Serve ${entry}`}</span>
            <span className="preview-option-note">Shows {entry === 'index.html' ? 'its index.html' : 'that page'} and reloads it whenever a file changes.</span>
          </div>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act((b, id) => b.serveFolder(id, entry))}>
            Serve
          </button>
        </div>
      ))}

      {options && options.scripts.length > 0 && (
        <div className="preview-option is-stack">
          <div className="preview-option-text">
            <span className="preview-option-title">Run a script</span>
            <span className="preview-option-note">The app runs it in this session's folder and shows the address it prints.</span>
          </div>
          <div className="preview-scripts">
            {options.scripts.map((name) => (
              <button type="button" className="btn btn-sm preview-script" key={name} disabled={busy} onClick={() => void act((b, id) => b.run(id, name))} title={`Run "npm run ${name}" in this folder`}>
                npm run {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {nothing && <p className="preview-empty-hint">When a team starts a web server, its address appears here.</p>}

      <form
        className="preview-option is-stack"
        onSubmit={(ev) => {
          ev.preventDefault()
          void props.onOpen(typed)
        }}
      >
        <label className="preview-option-title" htmlFor="preview-typed">
          {nothing ? 'Type an address' : 'Or type an address'}
        </label>
        <div className="preview-typed">
          <input
            id="preview-typed"
            className="input input-mono"
            value={typed}
            onChange={(ev) => setTyped(ev.target.value)}
            placeholder="http://localhost:5173"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
          <button type="submit" className="btn btn-sm" disabled={busy || typed.trim().length === 0}>
            Open
          </button>
        </div>
        <span className="preview-option-note">Only pages on this computer (localhost or 127.0.0.1).</span>
      </form>
    </div>
  )
}

// ---- preview log -----------------------------------------------------------------------------------

function ScriptLog({ sessionId, bridge, info }: { sessionId: string; bridge: PreviewBridge; info: PreviewInfo }) {
  // Open by itself while there is no page to look at.
  const [open, setOpen] = useState(!info.url)
  const [text, setText] = useState('')
  const box = useRef<HTMLPreElement>(null)
  const noPage = !info.url
  // ...and out of the way once the page is there.
  useEffect(() => setOpen(noPage), [noPage])
  useEffect(() => {
    if (!open) return
    let stale = false
    const load = (): void => {
      bridge
        .log(sessionId)
        .then((t) => {
          if (!stale) setText(t)
        })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, LOG_EVERY_MS)
    return () => {
      stale = true
      window.clearInterval(timer)
    }
  }, [bridge, sessionId, open])
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [text])

  return (
    <details className="preview-log" open={open} onToggle={(ev) => setOpen(ev.currentTarget.open)}>
      <summary>
        Preview log <span className="preview-log-cmd">npm run {info.script}</span>
      </summary>
      <pre ref={box} tabIndex={0}>
        {text || 'No output yet.'}
      </pre>
    </details>
  )
}

// ---- splitter --------------------------------------------------------------------------------------

function PaneSplitter({ pv, total, width }: { pv: PreviewController; total: number; width: number }) {
  const onDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const el = ev.currentTarget
    el.setPointerCapture(ev.pointerId)
    document.body.classList.add('resizing-x')
    const move = (e: PointerEvent) => pv.dispatch({ type: 'resize', width: e.clientX - SIDEBAR_WIDTH, total }, false)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing-x')
      pv.save()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <div
      className="splitter splitter-right splitter-preview"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the preview"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onDown}
      onDoubleClick={() => pv.dispatch({ type: 'resize', width: PANE_DEFAULT.width, total })}
      onKeyDown={(ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
        ev.preventDefault()
        pv.dispatch({ type: 'resize', width: width + (ev.key === 'ArrowRight' ? 24 : -24), total })
      }}
    />
  )
}
