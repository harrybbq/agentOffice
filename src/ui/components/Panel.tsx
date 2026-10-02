// The resizable panel next to (or under) the world: the session's Terminal (or Chat, for sessions
// without a terminal UI), the agent inspector, the Events tab and the office Board (the last two
// tabs only when the main process has them).
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { DEFAULT_LAYOUT, useApp, useAppState } from '../controller'
import type { PanelTab } from '../controller'
import { clampSplit } from '../format'
import { cx } from '../hooks'
import { overlapBadge } from '../board'
import { IconBoard, IconChat, IconClose, IconDockBottom, IconDockRight, IconInspect, IconList, IconTerminal } from '../icons'
import { panelContent } from '../restore'
import { BoardView } from './BoardView'
import { ChatView } from './ChatView'
import { EventLog } from './EventLog'
import { InspectView } from './InspectView'
import { WakeView } from './Restore'
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
  const selected = useAppState((s) => s.sessions.find((x) => x.id === s.selectedId) ?? null)
  const chat = selected?.surface === 'chat'
  // An asleep row has no terminal or chat to show: its wake screen takes the first tab.
  const content = panelContent(selected)
  const overlaps = useAppState((s) => s.boardOverlaps)
  // A stored 'board' tab with a main process that has no board falls back to the first tab.
  // The same for 'inspect' and a main process that keeps no agent details.
  const current: PanelTab = (layout.tab === 'board' && !app.hasBoard) || (layout.tab === 'inspect' && !app.hasInspector) ? 'terminal' : layout.tab

  const tab = (id: PanelTab, label: string, icon: ReactNode, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={current === id}
      className={cx('tab', current === id && 'is-active')}
      onClick={() => app.setLayout({ tab: id })}
    >
      {icon}
      {label}
      {extra}
    </button>
  )

  return (
    <section className="panel" aria-label={chat ? 'Chat, inspector, events and board' : 'Terminal, inspector, events and board'}>
      <header className="panel-head">
        <div className="tabs" role="tablist">
          {chat ? tab('terminal', 'Chat', <IconChat />) : tab('terminal', 'Terminal', <IconTerminal />)}
          {app.hasInspector && tab('inspect', 'Inspect', <IconInspect />)}
          {tab('events', 'Events', <IconList />, eventCount > 0 && <span className="tab-count">{eventCount > 999 ? '999+' : eventCount}</span>)}
          {app.hasBoard &&
            tab(
              'board',
              'Board',
              <IconBoard />,
              overlaps > 0 && (
                <span className="tab-count is-warn" title={`${overlapBadge(overlaps)}: files touched by more than one team`}>
                  {overlaps}
                  <span className="visually-hidden"> {overlaps === 1 ? 'overlap' : 'overlaps'}</span>
                </span>
              )
            )}
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
        <TerminalView hidden={current !== 'terminal' || content === 'chat' || content === 'wake'} />
        <ChatView hidden={current !== 'terminal' || content !== 'chat' || !layout.panelOpen} />
        {content === 'wake' && selected && <WakeView key={selected.id} session={selected} hidden={current !== 'terminal' || !layout.panelOpen} />}
        {app.hasInspector && <InspectView hidden={current !== 'inspect' || !layout.panelOpen} />}
        <EventLog hidden={current !== 'events' || !layout.panelOpen} />
        {app.hasBoard && <BoardView hidden={current !== 'board' || !layout.panelOpen} />}
      </div>
    </section>
  )
}
