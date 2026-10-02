// The resizable panel next to (or under) the world: the session's Terminal (or Chat, for sessions
// without a terminal UI) and the Events tab.
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { DEFAULT_LAYOUT, useApp, useAppState } from '../controller'
import type { PanelTab } from '../controller'
import { clampSplit } from '../format'
import { cx } from '../hooks'
import { IconChat, IconClose, IconDockBottom, IconDockRight, IconList, IconTerminal } from '../icons'
import { ChatView } from './ChatView'
import { EventLog } from './EventLog'
import { TerminalView } from './TerminalView'

export const PANEL_MIN = { right: 360, bottom: 160 }
export const STAGE_MIN = { right: 300, bottom: 180 }

export function Splitter({ dock, workspace }: { dock: 'right' | 'bottom'; workspace: RefObject<HTMLDivElement | null> }) {
  const app = useApp()
  const key = dock === 'right' ? 'sizeRight' : 'sizeBottom'

  const sizeAt = (clientX: number, clientY: number): number | null => {
    const rect = workspace.current?.getBoundingClientRect()
    if (!rect) return null
    return dock === 'right'
      ? clampSplit(rect.right - clientX, rect.width, PANEL_MIN.right, STAGE_MIN.right)
      : clampSplit(rect.bottom - clientY, rect.height, PANEL_MIN.bottom, STAGE_MIN.bottom)
  }

  const onDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const el = ev.currentTarget
    el.setPointerCapture(ev.pointerId)
    document.body.classList.add(dock === 'right' ? 'resizing-x' : 'resizing-y')
    const move = (e: PointerEvent) => {
      const size = sizeAt(e.clientX, e.clientY)
      if (size !== null) app.setLayout({ [key]: size }, false)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing-x', 'resizing-y')
      app.setLayout({})
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div
      className={cx('splitter', `splitter-${dock}`)}
      role="separator"
      aria-orientation={dock === 'right' ? 'vertical' : 'horizontal'}
      aria-label="Resize the panel"
      tabIndex={0}
      onPointerDown={onDown}
      onDoubleClick={() => app.setLayout({ [key]: dock === 'right' ? DEFAULT_LAYOUT.sizeRight : DEFAULT_LAYOUT.sizeBottom })}
      onKeyDown={(ev) => {
        const grow = dock === 'right' ? 'ArrowLeft' : 'ArrowUp'
        const shrink = dock === 'right' ? 'ArrowRight' : 'ArrowDown'
        if (ev.key !== grow && ev.key !== shrink) return
        ev.preventDefault()
        const rect = workspace.current?.getBoundingClientRect()
        if (!rect) return
        const cur = app.store.get().layout[key]
        const total = dock === 'right' ? rect.width : rect.height
        app.setLayout({ [key]: clampSplit(cur + (ev.key === grow ? 24 : -24), total, PANEL_MIN[dock], STAGE_MIN[dock]) })
      }}
    />
  )
}

export function Panel({ dock }: { dock: 'right' | 'bottom' }) {
  const app = useApp()
  const layout = useAppState((s) => s.layout)
  const eventCount = useAppState((s) => s.eventCount)
  // The first tab keeps its stored id ('terminal'); only its label and content follow the session.
  const chat = useAppState((s) => s.sessions.find((x) => x.id === s.selectedId)?.surface === 'chat')

  const tab = (id: PanelTab, label: string, icon: ReactNode, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={layout.tab === id}
      className={cx('tab', layout.tab === id && 'is-active')}
      onClick={() => app.setLayout({ tab: id })}
    >
      {icon}
      {label}
      {extra}
    </button>
  )

  return (
    <section className="panel" aria-label={chat ? 'Chat and events' : 'Terminal and events'}>
      <header className="panel-head">
        <div className="tabs" role="tablist">
          {chat ? tab('terminal', 'Chat', <IconChat />) : tab('terminal', 'Terminal', <IconTerminal />)}
          {tab('events', 'Events', <IconList />, eventCount > 0 && <span className="tab-count">{eventCount > 999 ? '999+' : eventCount}</span>)}
        </div>
        <div className="panel-tools">
          <button
            type="button"
            className="icon-btn"
            onClick={() => app.setLayout({ dock: dock === 'right' ? 'bottom' : 'right' })}
            title={dock === 'right' ? 'Dock at the bottom' : 'Dock on the right'}
            aria-label={dock === 'right' ? 'Dock at the bottom' : 'Dock on the right'}
          >
            {dock === 'right' ? <IconDockBottom /> : <IconDockRight />}
          </button>
          <button type="button" className="icon-btn" onClick={() => app.togglePanel()} title="Hide the panel (Ctrl+`)" aria-label="Hide the panel">
            <IconClose />
          </button>
        </div>
      </header>
      <div className="panel-body">
        <TerminalView hidden={layout.tab !== 'terminal' || chat} />
        <ChatView hidden={layout.tab !== 'terminal' || !chat || !layout.panelOpen} />
        <EventLog hidden={layout.tab !== 'events' || !layout.panelOpen} />
      </div>
    </section>
  )
}
