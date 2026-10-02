// Main-process side of the pty host: forks electron/ptyHost.ts as a utilityProcess on first use and
// speaks electron/ptyProtocol.ts with it. The only file besides main.ts / sessionsIpc.ts that needs
// Electron for hosted sessions.
import { utilityProcess, type UtilityProcess } from 'electron'
import type { PtyHandlers, PtyHost, ScreenSnapshot } from './drivers/types'
import { clampCols, clampRows, PTY_MAX_WRITE_CHARS, type FromHost, type PtySpawnOptions, type ToHost } from './ptyProtocol'

const SNAPSHOT_TIMEOUT_MS = 5000
const SPAWN_TIMEOUT_MS = 15_000

interface Entry {
  handlers: PtyHandlers
  spawned: { resolve: () => void; reject: (err: Error) => void } | null
  exited: boolean
}

export class PtyHostClient implements PtyHost {
  private child: UtilityProcess | null = null
  private ready: Promise<void> | null = null
  private entries = new Map<string, Entry>()
  private snapshots = new Map<number, (s: ScreenSnapshot | null) => void>()
  private reqSeq = 0
  private closing = false

  /**
   * @param hostPath absolute path of the built ptyHost.js
   * @param onData   batched terminal output of attached terminals
   */
  constructor(
    private readonly hostPath: string,
    private readonly onData: (id: string, data: string) => void
  ) {}

  private ensure(): Promise<void> {
    if (this.ready) return this.ready
    if (this.closing) return Promise.reject(new Error('the app is shutting down'))
    const child = utilityProcess.fork(this.hostPath, [], { serviceName: 'Agent Office terminals', stdio: 'inherit' })
    this.child = child
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the terminal host did not start')), SPAWN_TIMEOUT_MS)
      const onReady = (m: FromHost) => {
        if (m?.t !== 'ready') return
        clearTimeout(timer)
        child.off('message', onReady)
        resolve()
      }
      child.on('message', onReady)
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('the terminal host exited'))
      })
    })
    this.ready.catch(() => {})
    child.on('message', (m: FromHost) => this.onMessage(m))
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.ready = null
      if (!this.closing) console.error(`[agent-office] terminal host exited (code ${code}); its sessions are gone`)
      // Every terminal it owned is dead.
      for (const [id, e] of [...this.entries]) this.finish(id, e, null)
      for (const done of [...this.snapshots.values()]) done(null)
      this.snapshots.clear()
    })
    return this.ready
  }

  private send(m: ToHost): void {
    this.child?.postMessage(m)
  }

  private finish(id: string, e: Entry, exitCode: number | null): void {
    if (e.exited) return
    e.exited = true
    if (e.spawned) {
      e.spawned.reject(new Error('the process exited before it started'))
      e.spawned = null
      this.entries.delete(id)
      return
    }
    e.handlers.onExit(exitCode)
  }

  private onMessage(m: FromHost): void {
    if (!m || typeof m !== 'object') return
    switch (m.t) {
      case 'data':
        this.onData(m.id, m.data)
        break
      case 'title':
        this.entries.get(m.id)?.handlers.onTitle?.(m.title)
        break
      case 'spawned': {
        const e = this.entries.get(m.id)
        e?.spawned?.resolve()
        if (e) e.spawned = null
        break
      }
      case 'spawn-error': {
        const e = this.entries.get(m.id)
        this.entries.delete(m.id)
        e?.spawned?.reject(new Error(`could not start the process: ${m.message}`))
        break
      }
      case 'exit': {
        const e = this.entries.get(m.id)
        if (e) this.finish(m.id, e, m.exitCode)
        break
      }
      case 'snapshot': {
        const done = this.snapshots.get(m.reqId)
        this.snapshots.delete(m.reqId)
        done?.(m.snapshot)
        break
      }
      default:
        break
    }
  }

  async spawn(id: string, opts: PtySpawnOptions, handlers: PtyHandlers): Promise<void> {
    await this.ensure()
    if (this.entries.has(id)) throw new Error('terminal id already in use')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.entries.delete(id)
        reject(new Error('the process did not start in time'))
      }, SPAWN_TIMEOUT_MS)
      this.entries.set(id, {
        handlers,
        exited: false,
        spawned: {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          }
        }
      })
      this.send({ t: 'spawn', id, ...opts })
    })
  }

  private live(id: string): boolean {
    const e = this.entries.get(id)
    return !!e && !e.exited
  }

  write(id: string, data: string): void {
    if (this.live(id) && data.length > 0 && data.length <= PTY_MAX_WRITE_CHARS) this.send({ t: 'write', id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    if (this.entries.has(id)) this.send({ t: 'resize', id, cols: clampCols(cols), rows: clampRows(rows) })
  }

  kill(id: string): void {
    if (this.live(id)) this.send({ t: 'kill', id })
  }

  dispose(id: string): void {
    if (!this.entries.delete(id)) return
    this.send({ t: 'dispose', id })
  }

  snapshot(id: string, attach: boolean): Promise<ScreenSnapshot | null> {
    if (!this.child || !this.entries.has(id)) return Promise.resolve(null)
    const reqId = ++this.reqSeq
    return new Promise<ScreenSnapshot | null>((resolve) => {
      const timer = setTimeout(() => {
        this.snapshots.delete(reqId)
        resolve(null)
      }, SNAPSHOT_TIMEOUT_MS)
      this.snapshots.set(reqId, (s) => {
        clearTimeout(timer)
        resolve(s)
      })
      this.send({ t: 'snapshot', id, reqId, attach })
    })
  }

  detach(id: string): void {
    if (this.entries.has(id)) this.send({ t: 'detach', id })
  }

  ack(id: string, chars: number): void {
    if (this.live(id)) this.send({ t: 'ack', id, chars })
  }

  /** Kills every terminal and the host. Resolves when the host is gone (or after a short wait). */
  shutdown(): Promise<void> {
    this.closing = true
    const child = this.child
    if (!child) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.postMessage({ t: 'shutdown' } satisfies ToHost)
    })
  }
}
