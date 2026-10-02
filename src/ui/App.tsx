// The app shell: sessions | world + order bar | terminal panel, with a status bar underneath.
import { useEffect, useRef } from 'react'
import { useApp, useAppState } from './controller'
import { cx, useWindowWidth } from './hooks'
import { appChord, inTerminal, isTyping } from './keys'
import { NewSessionDialog } from './components/NewSessionDialog'
import { OrderBar } from './components/OrderBar'
import { Inbox } from './components/Inbox'
import { Panel, Splitter } from './components/Panel'
import { PreviewPane, usePreviewFootprint } from './components/PreviewPane'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { WorldView } from './components/WorldView'

/**
 * Below this window width the "auto" dock puts the terminal under the world. The default window
 * (1440 wide) docks right: an agent TUI needs height more than width, and a terminal of a dozen
 * rows makes it redraw into its own scrollback.
 */
const AUTO_DOCK_RIGHT_MIN = 1360

export function App() {
  const app = useApp()
  const dialog = useAppState((s) => s.dialog)
  const layout = useAppState((s) => s.layout)
  const overlay = useAppState((s) => s.settings?.overlay ?? false)
  // The preview pane (left of the office) takes its share of the window before the dock is chosen.
  const width = useWindowWidth() - usePreviewFootprint()
  const workspace = useRef<HTMLDivElement>(null)
  const dock = layout.dock === 'auto' ? (width >= AUTO_DOCK_RIGHT_MIN ? 'right' : 'bottom') : layout.dock
  // Docked right, the inbox sits above the terminal; otherwise it floats over the world.
  const inboxInSide = dock === 'right' && layout.panelOpen && !overlay

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const state = app.store.get()
      if (ev.key === 'Escape' && state.dialog) {
        ev.preventDefault()
        app.closeDialog()
        return
      }
      if (state.settings?.overlay) return
      const chord = appChord(ev)
      if (chord) {
        ev.preventDefault()
        if (chord.kind === 'new-session') app.openNewSession()
        else if (chord.kind === 'toggle-panel') app.togglePanel()
        else if (!state.dialog) app.selectByIndex(chord.index)
        return
      }
      if (state.dialog) return
      // Ctrl+K belongs to the terminal while it has focus (kill-line); elsewhere it is ours.
      const ctrlK = (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.code === 'KeyK' && !inTerminal(ev.target)
      const slash = ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !isTyping(ev.target)
      if (ctrlK || slash) {
        ev.preventDefault()
        app.focusOrderBar()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [app])

  return (
    <div className={cx('app', overlay && 'is-overlay')}>
      <div className="app-main">
        <Sidebar />
        {!overlay && <PreviewPane />}
        <div className={cx('workspace', `dock-${dock}`)} ref={workspace}>
          <div className="stage">
            <WorldView floatingInbox={!inboxInSide} />
            <OrderBar />
          </div>
          {layout.panelOpen && <Splitter dock={dock} workspace={workspace} />}
          <div
            className={cx('side', `side-${dock}`)}
            hidden={!layout.panelOpen}
            style={dock === 'right' ? { width: layout.sizeRight } : { height: layout.sizeBottom }}
          >
            {inboxInSide && <Inbox docked />}
            <Panel dock={dock} />
          </div>
        </div>
      </div>
      <StatusBar />
      {dialog === 'new-session' && !overlay && <NewSessionDialog />}
    </div>
  )
}
