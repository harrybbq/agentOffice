// Messages between the main process and the pty host (electron/ptyHost.ts, a utilityProcess).
// Plain structured-clone data over `process.parentPort`.

export interface PtySpawnOptions {
  /** Absolute path of the executable. Chosen by the main process from a fixed table, never by the renderer. */
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type ToHost =
  | ({ t: 'spawn'; id: string } & PtySpawnOptions)
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  /** Kill the whole process tree. */
  | { t: 'kill'; id: string }
  /** The viewer rendered this many chars (flow control). */
  | { t: 'ack'; id: string; chars: number }
  /** Reply with the screen. `attach` also starts streaming `data` to the viewer. */
  | { t: 'snapshot'; id: string; reqId: number; attach: boolean }
  /** Stop streaming `data`. */
  | { t: 'detach'; id: string }
  /** Forget an exited terminal (frees its screen mirror). */
  | { t: 'dispose'; id: string }
  /** Kill everything and exit. */
  | { t: 'shutdown' }

export type FromHost =
  | { t: 'ready' }
  | { t: 'spawned'; id: string }
  | { t: 'spawn-error'; id: string; message: string }
  /** Batched output. Only sent while a viewer is attached. */
  | { t: 'data'; id: string; data: string }
  /** The terminal title (OSC 0/2) changed. */
  | { t: 'title'; id: string; title: string }
  | { t: 'exit'; id: string; exitCode: number | null }
  | {
      t: 'snapshot'
      id: string
      reqId: number
      /** null when the terminal doesn't exist. */
      snapshot: { data: string; cols: number; rows: number; text: string } | null
    }

export const PTY_BATCH_MS = 12
export const PTY_BATCH_CHARS = 64 * 1024
export const PTY_MAX_WRITE_CHARS = 1024 * 1024
export const PTY_SCROLLBACK = 5000

/** The Windows build number from `os.release()` ("10.0.26200" -> 26200); 0 elsewhere or when unknown. */
export function windowsBuildNumber(platform: string, osRelease: string): number {
  if (platform !== 'win32') return 0
  const build = Number(osRelease.split('.')[2])
  return Number.isInteger(build) && build > 0 ? build : 0
}

export const clampCols = (n: number): number => Math.min(500, Math.max(2, Math.floor(n)))
export const clampRows = (n: number): number => Math.min(300, Math.max(1, Math.floor(n)))
