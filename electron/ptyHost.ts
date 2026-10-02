// PTY host: runs in an Electron utilityProcess and owns every node-pty instance, so a native crash
// or a flood of output never takes the main process down. Protocol: electron/ptyProtocol.ts.
//
// Per terminal it keeps a headless xterm mirror of the screen, which gives:
// - a serialized snapshot for a renderer that attaches late or reloads,
// - the terminal title (OSC 0/2), which the Claude driver reads as a busy/idle hint,
// - answers to terminal queries (DA, DSR, ...) while no real xterm is attached to give them.
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import type { IPty } from 'node-pty'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize'
import { TERM_HIGH_WATERMARK_CHARS, TERM_LOW_WATERMARK_CHARS } from '../shared/sessions'
import { ExtraModes } from './ptyModes'
import {
  clampCols,
  clampRows,
  PTY_BATCH_CHARS,
  PTY_BATCH_MS,
  PTY_MAX_WRITE_CHARS,
  PTY_SCROLLBACK,
  windowsBuildNumber,
  type FromHost,
  type ToHost
} from './ptyProtocol'

// CommonJS packages with native / UMD builds: load them the way Node resolves them at runtime.
const require = createRequire(import.meta.url)
const nodePty = require('node-pty') as typeof import('node-pty')
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')
const { Unicode11Addon } = require('@xterm/addon-unicode11') as typeof import('@xterm/addon-unicode11')

const port = process.parentPort
const post = (m: FromHost): void => port.postMessage(m)

interface Term {
  id: string
  pty: IPty
  mirror: HeadlessTerminal
  serializer: SerializeAddonType
  /** Modes the serializer doesn't restore (mouse encoding, hidden cursor). */
  modes: ExtraModes
  /** Output not sent yet. */
  batch: string
  timer: NodeJS.Timeout | null
  /** A renderer is attached: stream `data` and apply flow control. */
  viewer: boolean
  /** Chars sent to the viewer and not acked yet. */
  unacked: number
  paused: boolean
  /** A snapshot is being taken: keep output back so it arrives after the snapshot. */
  holding: boolean
  title: string
  exited: boolean
}

const terms = new Map<string, Term>()


function spawn(m: Extract<ToHost, { t: 'spawn' }>): void {
  if (terms.has(m.id)) return post({ t: 'spawn-error', id: m.id, message: 'terminal id already in use' })
  const cols = clampCols(m.cols)
  const rows = clampRows(m.rows)
  let pty: IPty
  try {
    pty = nodePty.spawn(m.file, m.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: m.cwd,
      env: m.env,
      // System ConPTY. The bundled conpty.dll waits ~2 s for a device-attributes reply (spike 1).
      useConptyDll: false
    })
  } catch (err) {
    return post({ t: 'spawn-error', id: m.id, message: err instanceof Error ? err.message : 'spawn failed' })
  }
  const mirror = new Terminal({
    cols,
    rows,
    scrollback: PTY_SCROLLBACK,
    allowProposedApi: true,
    ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const, buildNumber: windowsBuildNumber(process.platform, release()) } } : {})
  })
  const serializer = new SerializeAddon()
  // The addon is typed against @xterm/xterm; the headless terminal has the same addon API.
  mirror.loadAddon(serializer as unknown as Parameters<HeadlessTerminal['loadAddon']>[0])
  // Same character widths as the renderer's xterm (ui/terminals.ts), or emoji and other wide
  // characters would sit in different columns in a snapshot than on the live screen.
  mirror.loadAddon(new Unicode11Addon() as unknown as Parameters<HeadlessTerminal['loadAddon']>[0])
  mirror.unicode.activeVersion = '11'
  const modes = new ExtraModes()
  mirror.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    modes.decPrivate(params, true)
    return false // not handled: xterm applies the mode as usual
  })
  mirror.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    modes.decPrivate(params, false)
    return false
  })
  mirror.parser.registerEscHandler({ final: 'c' }, () => {
    modes.reset()
    return false
  })
  const term: Term = {
    id: m.id,
    pty,
    mirror,
    serializer,
    modes,
    batch: '',
    timer: null,
    viewer: false,
    unacked: 0,
    paused: false,
    holding: false,
    title: '',
    exited: false
  }
  terms.set(m.id, term)

  mirror.onTitleChange((title) => {
    if (title === term.title) return
    term.title = title
    post({ t: 'title', id: term.id, title: title.slice(0, 300) })
  })
  // Query replies. With a viewer attached, its xterm answers (through `write`), so stay quiet.
  mirror.onData((reply) => {
    if (!term.viewer && !term.exited) pty.write(reply)
  })
  pty.onData((data) => {
    mirror.write(data)
    if (!term.viewer) return
    term.batch += data
    if (term.batch.length >= PTY_BATCH_CHARS) flush(term)
    else if (!term.timer) term.timer = setTimeout(() => flush(term), PTY_BATCH_MS)
  })
  pty.onExit(({ exitCode }) => {
    term.exited = true
    flush(term)
    post({ t: 'exit', id: term.id, exitCode: typeof exitCode === 'number' ? exitCode : null })
  })
  post({ t: 'spawned', id: m.id })
}

function flush(term: Term): void {
  if (term.timer) {
    clearTimeout(term.timer)
    term.timer = null
  }
  if (term.holding || term.batch.length === 0) return
  const data = term.batch
  term.batch = ''
  if (!term.viewer) return
  post({ t: 'data', id: term.id, data })
  term.unacked += data.length
  if (!term.paused && term.unacked > TERM_HIGH_WATERMARK_CHARS && !term.exited) {
    term.paused = true
    term.pty.pause()
  }
}

function resume(term: Term): void {
  if (!term.paused) return
  term.paused = false
  if (!term.exited) term.pty.resume()
}

function ack(term: Term, chars: number): void {
  if (!Number.isFinite(chars) || chars <= 0) return
  term.unacked = Math.max(0, term.unacked - chars)
  if (term.unacked < TERM_LOW_WATERMARK_CHARS) resume(term)
}

function detach(term: Term): void {
  term.viewer = false
  term.batch = ''
  term.unacked = 0
  resume(term)
}

function screenText(term: Term): string {
  const b = term.mirror.buffer.active
  const lines: string[] = []
  for (let i = 0; i < term.mirror.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function snapshot(m: Extract<ToHost, { t: 'snapshot' }>): void {
  const term = terms.get(m.id)
  if (!term) return post({ t: 'snapshot', id: m.id, reqId: m.reqId, snapshot: null })
  // Everything sent so far is in the mirror already; hold new output until the snapshot is out, so
  // the viewer gets "snapshot, then exactly the output that came after it".
  flush(term)
  term.holding = true
  term.mirror.write('', () => {
    let data = ''
    try {
      data = term.serializer.serialize({ scrollback: PTY_SCROLLBACK }) + term.modes.serialize()
    } catch (err) {
      console.error('[pty-host] serialize failed:', err instanceof Error ? err.message : err)
    }
    post({
      t: 'snapshot',
      id: m.id,
      reqId: m.reqId,
      snapshot: { data, cols: term.mirror.cols, rows: term.mirror.rows, text: screenText(term) }
    })
    term.holding = false
    if (m.attach) {
      // Output that arrived while serializing was parsed after the marker, so it is not in the
      // snapshot. It was only batched if a viewer was attached already, which is the re-attach case.
      term.viewer = true
      term.unacked = 0
      resume(term)
    }
    flush(term)
  })
}

/** Kills the process and everything it started. */
function killTree(term: Term): void {
  if (term.exited) return
  const pid = term.pty.pid // reads 0 right after spawn in a utility process: read it late
  const closePty = () => {
    try {
      term.pty.kill()
    } catch {
      // already gone
    }
  }
  if (process.platform === 'win32') {
    if (pid > 0) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => closePty())
    else closePty()
  } else {
    try {
      term.pty.kill('SIGHUP')
    } catch {
      // already gone
    }
    setTimeout(() => {
      if (term.exited) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        closePty()
      }
    }, 1500).unref()
  }
}

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  const live = [...terms.values()].filter((t) => !t.exited)
  for (const term of live) killTree(term)
  // Leave as soon as every process is gone (their `exit` reaches main first), or after a moment.
  const started = Date.now()
  const check = setInterval(() => {
    if (live.every((t) => t.exited) || Date.now() - started > 2500) {
      clearInterval(check)
      setTimeout(() => process.exit(0), 20)
    }
  }, 50)
}

port.on('message', (e: { data: unknown }) => {
  const m = e.data as ToHost
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return
  if (m.t === 'shutdown') return shutdown()
  if (m.t === 'spawn') return spawn(m)
  if (m.t === 'snapshot') return snapshot(m)
  const term = terms.get(m.id)
  if (!term) return
  switch (m.t) {
    case 'write':
      if (!term.exited && typeof m.data === 'string' && m.data.length <= PTY_MAX_WRITE_CHARS) term.pty.write(m.data)
      break
    case 'resize': {
      const cols = clampCols(m.cols)
      const rows = clampRows(m.rows)
      if (cols === term.mirror.cols && rows === term.mirror.rows) break
      term.mirror.resize(cols, rows)
      if (!term.exited) {
        try {
          term.pty.resize(cols, rows)
        } catch {
          // the process is exiting
        }
      }
      break
    }
    case 'kill':
      killTree(term)
      break
    case 'ack':
      ack(term, m.chars)
      break
    case 'detach':
      detach(term)
      break
    case 'dispose':
      if (!term.exited) killTree(term)
      if (term.timer) clearTimeout(term.timer)
      term.mirror.dispose()
      terms.delete(m.id)
      break
  }
})

// If the main process dies without saying goodbye, don't leave agents running headless.
const parentPid = process.ppid
setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    shutdown()
  }
}, 2000).unref()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

post({ t: 'ready' })
