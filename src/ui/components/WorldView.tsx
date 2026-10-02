// The centre of the app: the Phaser world plus what floats over it (PA banner, office-wide pill,
// the CEO inbox, a fit-view button).
import { useEffect, useRef, useState } from 'react'
import { useApp, useAppState } from '../controller'
import { ago } from '../format'
import { cx, useNow } from '../hooks'
import { IconFit, IconMegaphone, IconTag } from '../icons'
import { Inbox } from './Inbox'
import { TaskProgress } from './Progress'
import { RestoreNotice } from './Restore'

/** The widest thing the top strip holds (.world-top > * in app.css). */
const TOP_STRIP_MAX = 680

function OfficeWidePill({ endsAt }: { endsAt: number }) {
  const app = useApp()
  const now = useNow(1000)
  return (
    <button type="button" className="wide-pill" onClick={() => app.endOfficeWide()} title="End office-wide mode (workers go back to their branches)">
      Office-wide task in progress · {ago(endsAt - now)} left · click to end
    </button>
  )
}

export function WorldView({ floatingInbox }: { floatingInbox: boolean }) {
  const app = useApp()
  const host = useRef<HTMLDivElement>(null)
  const tags = useRef<HTMLDivElement>(null)
  const error = useAppState((s) => s.worldError)
  const banner = useAppState((s) => s.banner)
  const wideEndsAt = useAppState((s) => s.officeWideEndsAt)
  const empty = useAppState((s) => s.sessions.length === 0 && s.teams.length === 0)
  // Restored rows have no team in the world until they are woken (they sent no events).
  const allAsleep = useAppState((s) => s.sessions.length > 0 && s.teams.length === 0 && s.sessions.every((x) => x.state === 'asleep'))
  const overlay = useAppState((s) => s.settings?.overlay ?? false)
  const inboxOpen = useAppState((s) => s.layout.inboxOpen)
  const labels = useAppState((s) => s.layout.labels)

  useEffect(() => {
    if (host.current) app.world.mount(host.current, tags.current)
    return () => app.world.unmount()
  }, [app])

  // The collapsed inbox floats in the top right corner. In a narrow world the top strip (banner,
  // order progress) would run under it: then the strip ends where the inbox begins.
  const world = useRef<HTMLDivElement>(null)
  const [clearRight, setClearRight] = useState(0)
  useEffect(() => {
    const el = world.current
    const pill = floatingInbox && !inboxOpen && !overlay ? el?.querySelector('.inbox.is-floating') : null
    if (!el || !pill) {
      setClearRight(0)
      return
    }
    const measure = () => {
      const reserve = Math.ceil(pill.getBoundingClientRect().width) + 20
      setClearRight(el.clientWidth < 2 * reserve + TOP_STRIP_MAX ? reserve : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(pill)
    return () => ro.disconnect()
  }, [floatingInbox, inboxOpen, overlay])

  return (
    <div className="world" ref={world}>
      <div className="world-canvas" ref={host} />
      {/* Station tags and the hover card: the scene positions them, pointer events pass through. */}
      <div className="world-tags" ref={tags} aria-hidden="true" />

      <div className={cx('world-top', floatingInbox && inboxOpen && !overlay && 'is-beside-inbox')} style={clearRight > 0 ? { right: clearRight } : undefined}>
        {!overlay && <RestoreNotice />}
        {banner && (
          <div key={banner.key} className="pa-banner" role="status">
            <IconMegaphone />
            <span>{banner.text}</span>
          </div>
        )}
        {wideEndsAt !== null && !overlay && <OfficeWidePill endsAt={wideEndsAt} />}
        {/* A major task: an order that several teams are working on. */}
        {!overlay && <TaskProgress />}
      </div>

      {!overlay && (
        <button type="button" className="world-tool icon-btn" onClick={() => app.world.fitAll()} title="Fit the whole office (or double-click the world)" aria-label="Fit the whole office">
          <IconFit />
        </button>
      )}
      {!overlay && (
        <button
          type="button"
          role="switch"
          aria-checked={labels}
          className={cx('world-tool world-tool-labels icon-btn', labels && 'is-on')}
          onClick={() => app.setLayout({ labels: !labels })}
          title={labels ? 'Labels: on. Click to hide the station labels.' : 'Labels: off. Click to show the station labels.'}
          aria-label={`Labels: ${labels ? 'on' : 'off'}`}
        >
          <IconTag />
        </button>
      )}

      {floatingInbox && <Inbox />}

      {empty && !overlay && !error && (
        <div className="world-empty">
          <p className="world-empty-title">The office is quiet</p>
          <p>
            Start a session and its team moves in.
            <button type="button" className="link" onClick={() => app.openNewSession()}>
              New session
            </button>
          </p>
        </div>
      )}

      {allAsleep && !overlay && !error && (
        <div className="world-empty">
          <p className="world-empty-title">Everyone is asleep</p>
          <p>Your sessions from last time are on the left. Wake one and its team moves back in.</p>
        </div>
      )}

      {error && (
        <div className="world-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
