// The centre of the app: the Phaser world plus what floats over it (PA banner, office-wide pill,
// the CEO inbox, a fit-view button).
import { useEffect, useRef } from 'react'
import { useApp, useAppState } from '../controller'
import { ago } from '../format'
import { useNow } from '../hooks'
import { IconFit, IconMegaphone } from '../icons'
import { Inbox } from './Inbox'

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
  const error = useAppState((s) => s.worldError)
  const banner = useAppState((s) => s.banner)
  const wideEndsAt = useAppState((s) => s.officeWideEndsAt)
  const empty = useAppState((s) => s.sessions.length === 0 && s.teams.length === 0)
  const overlay = useAppState((s) => s.settings?.overlay ?? false)

  useEffect(() => {
    if (host.current) app.world.mount(host.current)
    return () => app.world.unmount()
  }, [app])

  return (
    <div className="world">
      <div className="world-canvas" ref={host} />

      <div className="world-top">
        {banner && (
          <div key={banner.key} className="pa-banner" role="status">
            <IconMegaphone />
            <span>{banner.text}</span>
          </div>
        )}
        {wideEndsAt !== null && !overlay && <OfficeWidePill endsAt={wideEndsAt} />}
      </div>

      {!overlay && (
        <button type="button" className="world-tool icon-btn" onClick={() => app.world.fitAll()} title="Fit the whole office (or double-click the world)" aria-label="Fit the whole office">
          <IconFit />
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

      {error && (
        <div className="world-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
