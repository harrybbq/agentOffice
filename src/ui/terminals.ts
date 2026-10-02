// One xterm.js instance per session, kept alive while the app runs so switching is instant.
// Not React: the terminal panel just mounts `root` and tells us which session to show.
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { AgentOfficeBridge } from '../../shared/ipc'
import { TERM_ACK_CHARS } from '../../shared/sessions'
import { cleanError, osc52Text, windowsPtyOption } from './format'
import type { WindowsPty } from './format'
import { appChord } from './keys'

export type UiTheme = 'dark' | 'light'

const MONO =
  "'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/** Terminal colours matching the shell (styles/tokens.css: --term-bg must equal `background`). */
export function terminalTheme(ui: UiTheme): ITheme {
  if (ui === 'light') {
    return {
      background: '#fbfbfd',
      foreground: '#24262e',
      cursor: '#24262e',
      cursorAccent: '#fbfbfd',
      selectionBackground: '#c9d2ff',
      black: '#24262e',
      red: '#c4352f',
      green: '#2c8a4f',
      yellow: '#a36a00',
      blue: '#3257d6',
      magenta: '#9b3fb5',
      cyan: '#12808f',
      white: '#8b8e99',
      brightBlack: '#6b6f7b',
      brightRed: '#dc4b44',
      brightGreen: '#36a35f',
      brightYellow: '#bb7d08',
      brightBlue: '#4a6cf0',
      brightMagenta: '#b257cc',
      brightCyan: '#1a98a8',
      brightWhite: '#3a3d47'
    }
  }
  return {
    background: '#111218',
    foreground: '#d7d9e2',
    cursor: '#d7d9e2',
    cursorAccent: '#111218',
    selectionBackground: '#3a4275',
    black: '#1b1d26',
    red: '#f0716b',
    green: '#62c98d',
    yellow: '#e8bc5e',
    blue: '#7e9bff',
    magenta: '#c58af9',
    cyan: '#5fc8d8',
    white: '#c3c6d1',
    brightBlack: '#6a6f82',
    brightRed: '#ff8f89',
    brightGreen: '#7fe0a6',
    brightYellow: '#f6d27d',
    brightBlue: '#9fb4ff',
    brightMagenta: '#d7a8ff',
    brightCyan: '#83dceb',
    brightWhite: '#f2f3f7'
  }
}

/** Larger writes are split so one big paste never exceeds the pty host's per-message limit. */
const WRITE_CHUNK_CHARS = 256 * 1024

interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  webgl: WebglAddon | null
  opened: boolean
  /** Snapshot written; streamed data may be rendered. */
  ready: boolean
  /** Bumped by every attach / detach, so a late snapshot of an older attachment is dropped. */
  gen: number
  /** A snapshot was written at least once (a later one replaces the screen). */
  shown: boolean
  queue: string[]
  unacked: number
  sent: { cols: number; rows: number } | null
}

export class TerminalManager {
  /** Mount this element inside the terminal panel. */
  readonly root: HTMLDivElement
  private entries = new Map<string, Entry>()
  private active: string | null = null
  private theme: UiTheme = 'dark'
  private fitTimer = 0
  /** focus() was asked before the terminal could be opened. */
  private focusWhenOpen = false
  private observer: ResizeObserver
  private windowsPty: WindowsPty | undefined
  /** The window is hidden (tray, minimised): terminals are detached until it is back. */
  private suspended = document.hidden

  constructor(private bridge: AgentOfficeBridge) {
    this.root = document.createElement('div')
    this.root.className = 'term-stack'
    bridge.terminal.onData((id, data) => this.onData(id, data))
    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(this.root)
    document.addEventListener('visibilitychange', () => this.onVisibility())
  }

  /** The real Windows build (RendererSettings.windowsBuild): xterm needs it to handle ConPTY output. */
  setWindowsBuild(build: number): void {
    const pty = windowsPtyOption(build)
    this.windowsPty = pty
    if (pty) for (const e of this.entries.values()) e.term.options.windowsPty = pty
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  setTheme(theme: UiTheme): void {
    this.theme = theme
    for (const e of this.entries.values()) e.term.options.theme = terminalTheme(theme)
  }

  /** Shows one session's terminal (creating and attaching it the first time), or none. */
  show(id: string | null): void {
    if (id === this.active && (id === null || this.entries.has(id))) return
    const prev = this.active ? this.entries.get(this.active) : undefined
    if (prev) {
      prev.el.hidden = true
      this.dropWebgl(prev)
    }
    this.active = id
    this.focusWhenOpen = false
    if (id === null) return
    const e = this.entries.get(id) ?? this.create(id)
    e.el.hidden = false
    this.scheduleFit(0)
  }

  focus(): void {
    const e = this.active ? this.entries.get(this.active) : undefined
    if (e?.opened) e.term.focus()
    else if (e) this.focusWhenOpen = true
  }

  /** Called when the panel becomes visible or changes size. */
  scheduleFit(delay = 60): void {
    window.clearTimeout(this.fitTimer)
    this.fitTimer = window.setTimeout(() => requestAnimationFrame(() => this.fitNow()), delay)
  }

  dispose(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id)
    if (this.active === id) this.active = null
    this.bridge.terminal.detach(id)
    this.dropWebgl(e)
    e.term.dispose()
    e.el.remove()
  }

  /** Drops terminals whose session no longer exists. */
  prune(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!liveIds.has(id)) this.dispose(id)
  }

  private create(id: string): Entry {
    const el = document.createElement('div')
    el.className = 'term-host'
    this.root.append(el)
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(this.theme),
      macOptionIsMeta: true,
      ...(this.windowsPty ? { windowsPty: this.windowsPty } : {})
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    const e: Entry = { id, term, fit, el, webgl: null, opened: false, ready: false, gen: 0, shown: false, queue: [], unacked: 0, sent: null }
    this.entries.set(id, e)

    // Everything xterm emits goes to the pty: keystrokes, pastes, mouse reports and the replies
    // to terminal queries (once attached, this xterm is the only thing answering them).
    term.onData((data) => this.send(id, data))
    term.onBinary((data) => this.send(id, data))
    term.onResize(() => this.sendSize(e))
    term.attachCustomKeyEventHandler((ev) => this.keyFilter(e, ev))

    // Right-click: copy the selection, or paste when there is none (Electron has no context menu).
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      if (term.hasSelection()) this.copySelection(e)
      // A TUI that tracks the mouse gets the click itself. Claude Code's fullscreen UI pastes on
      // right-click on its own, so pasting here as well would insert the text twice.
      else if (term.modes.mouseTrackingMode === 'none') this.pasteClipboard(e)
    })
    // OSC 52: a fullscreen TUI that handles the mouse itself copies its own selection this way.
    // Write only: a request to read the clipboard is never answered.
    term.parser.registerOscHandler(52, (data) => {
      const text = osc52Text(data)
      if (text) void navigator.clipboard?.writeText(text).catch((err: unknown) => console.warn('[agent-office] copy failed', err))
      return true
    })

    if (!this.suspended) this.attach(e)
    return e
  }

  /**
   * Asks for the screen (scrollback included) and for the output that follows it. On a re-attach
   * the snapshot replaces what the terminal showed.
   */
  private attach(e: Entry): void {
    const { id, term } = e
    const gen = ++e.gen
    e.ready = false
    e.queue = []
    e.unacked = 0
    const current = (): boolean => this.entries.get(id) === e && e.gen === gen
    this.bridge.terminal
      .attach(id)
      .then((snap) => {
        if (!current()) return
        if (e.shown) term.reset()
        if (snap.cols > 1 && snap.rows > 1 && (snap.cols !== term.cols || snap.rows !== term.rows)) {
          e.sent = { cols: snap.cols, rows: snap.rows }
          term.resize(snap.cols, snap.rows)
        }
        if (snap.data) term.write(snap.data)
        e.shown = true
        e.ready = true
        for (const chunk of e.queue.splice(0)) this.write(e, chunk)
        if (this.active === id) this.scheduleFit(0)
      })
      .catch((err: unknown) => {
        if (!current()) return
        e.ready = true
        e.queue = []
        // A terminal that was showing something keeps it (its session is gone from the app).
        if (!e.shown) term.write(`\x1b[2m[terminal unavailable: ${cleanError(err)}]\x1b[0m\r\n`)
      })
  }

  /**
   * A hidden window (tray, minimised) gets its timers throttled, so xterm would render and ack
   * output late and the pty host would pause the agent. Hidden terminals are detached instead: the
   * pty host keeps the screen, and showing the window attaches again with a fresh snapshot.
   */
  private onVisibility(): void {
    const hidden = document.hidden
    if (hidden === this.suspended) return
    this.suspended = hidden
    for (const e of this.entries.values()) {
      if (hidden) {
        e.gen++
        e.ready = false
        e.queue = []
        e.unacked = 0
        this.bridge.terminal.detach(e.id)
      } else {
        this.attach(e)
      }
    }
  }

  private copySelection(e: Entry): void {
    const text = e.term.getSelection()
    if (!text) return
    void navigator.clipboard?.writeText(text).catch((err: unknown) => console.warn('[agent-office] copy failed', err))
    e.term.clearSelection()
  }

  private pasteClipboard(e: Entry): void {
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        // xterm brackets the paste when the agent's TUI asked for it.
        if (text && this.entries.get(e.id) === e) e.term.paste(text)
        e.term.focus()
      })
      .catch((err: unknown) => console.warn('[agent-office] paste failed', err))
  }

  private send(id: string, data: string): void {
    for (let i = 0; i < data.length; i += WRITE_CHUNK_CHARS) {
      this.bridge.terminal.write(id, data.slice(i, i + WRITE_CHUNK_CHARS))
    }
  }

  private onData(id: string, data: string): void {
    const e = this.entries.get(id)
    if (!e) return
    if (!e.ready) e.queue.push(data)
    else this.write(e, data)
  }

  /** Renders a chunk and acks it once xterm has processed it (flow control with the pty host). */
  private write(e: Entry, data: string): void {
    e.term.write(data, () => {
      e.unacked += data.length
      if (e.unacked >= TERM_ACK_CHARS) {
        this.bridge.terminal.ack(e.id, e.unacked)
        e.unacked = 0
      }
    })
  }

  private fitNow(): void {
    const e = this.active ? this.entries.get(this.active) : undefined
    if (!e || e.el.hidden || !this.root.isConnected) return
    // Hidden panels measure as 0 and would produce NaN sizes.
    if (e.el.clientWidth < 40 || e.el.clientHeight < 30) return
    if (!e.opened) {
      e.term.open(e.el)
      e.opened = true
      if (this.focusWhenOpen) e.term.focus()
      this.focusWhenOpen = false
    }
    this.ensureWebgl(e)
    const dims = e.fit.proposeDimensions()
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
    const cols = Math.max(20, dims.cols)
    const rows = Math.max(5, dims.rows)
    if (cols !== e.term.cols || rows !== e.term.rows) e.term.resize(cols, rows)
    else this.sendSize(e)
    // Repaint: a canvas that was hidden or resized mid-write can otherwise stay blank.
    e.term.refresh(0, e.term.rows - 1)
  }

  private sendSize(e: Entry): void {
    const { cols, rows } = e.term
    if (!e.ready || (e.sent && e.sent.cols === cols && e.sent.rows === rows)) return
    e.sent = { cols, rows }
    this.bridge.terminal.resize(e.id, cols, rows)
  }

  /** WebGL only for the visible terminal (browsers cap contexts; Phaser holds one too). */
  private ensureWebgl(e: Entry): void {
    if (e.webgl || !e.opened) return
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => this.dropWebgl(e)) // xterm falls back to its DOM renderer
      e.term.loadAddon(gl)
      e.webgl = gl
    } catch {
      e.webgl = null
    }
  }

  private dropWebgl(e: Entry): void {
    const gl = e.webgl
    e.webgl = null
    try {
      gl?.dispose()
    } catch {
      /* already gone */
    }
  }

  /** false = xterm ignores the key (the app or the browser handles it). */
  private keyFilter(e: Entry, ev: KeyboardEvent): boolean {
    if (appChord(ev)) return false
    const mod = (ev.ctrlKey || ev.metaKey) && !ev.altKey
    if (mod && ev.code === 'KeyC' && (ev.shiftKey || e.term.hasSelection())) {
      if (ev.type === 'keydown') {
        this.copySelection(e)
        ev.preventDefault()
      }
      return false
    }
    // Let the browser paste: xterm's paste handler then sends it (bracketed when the app asks).
    if (mod && ev.code === 'KeyV') return false
    // Shift+Enter inserts a newline in agent CLIs (the sequence terminal setups map it to).
    if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (ev.type === 'keydown') {
        this.send(e.id, '\x1b\r')
        ev.preventDefault()
      }
      return false
    }
    return true
  }
}
