// App config at <userData>/config.json. userData is pinned to "<appData>/agent-office" so external
// scripts (hooks, simulators) can find the token without knowing Electron's defaults.
import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Must run before app 'ready' and before anything reads userData. main.ts imports this module first.
app.setPath('userData', join(app.getPath('appData'), 'agent-office'))

export interface AppConfig {
  token: string
  port: number
  theme: string
  alwaysOnTop: boolean
  overlay: boolean
}

export const DEFAULT_PORT = 47821

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function newToken(): string {
  return randomBytes(32).toString('hex')
}

function defaults(): AppConfig {
  return { token: newToken(), port: DEFAULT_PORT, theme: 'office', alwaysOnTop: false, overlay: false }
}

let current: AppConfig | null = null

function normalise(raw: unknown): { cfg: AppConfig; changed: boolean } {
  const d = defaults()
  if (!raw || typeof raw !== 'object') return { cfg: d, changed: true }
  const o = raw as Record<string, unknown>
  let changed = false
  const pick = <T>(ok: boolean, v: unknown, fallback: T): T => {
    if (ok) return v as T
    changed = true
    return fallback
  }
  const cfg: AppConfig = {
    token: pick(typeof o.token === 'string' && /^[!-~]{16,256}$/.test(o.token), o.token, d.token),
    port: pick(Number.isInteger(o.port) && (o.port as number) > 0 && (o.port as number) < 65536, o.port, d.port),
    theme: pick(typeof o.theme === 'string' && /^[a-z0-9_-]+$/.test(o.theme), o.theme, d.theme),
    alwaysOnTop: pick(typeof o.alwaysOnTop === 'boolean', o.alwaysOnTop, d.alwaysOnTop),
    overlay: pick(typeof o.overlay === 'boolean', o.overlay, d.overlay)
  }
  return { cfg, changed }
}

/** Loads (and caches) the config, creating it with a fresh token on first run. */
export function loadConfig(): AppConfig {
  if (current) return current
  const p = configPath()
  let raw: unknown = null
  if (existsSync(p)) {
    try {
      raw = JSON.parse(readFileSync(p, 'utf8'))
    } catch (err) {
      console.error('[agent-office] config.json unreadable, recreating:', err)
    }
  }
  const { cfg, changed } = normalise(raw)
  current = cfg
  if (changed) writeAtomic(cfg)
  return cfg
}

/** Current config (always read through this so token changes apply immediately). */
export function getConfig(): AppConfig {
  return current ?? loadConfig()
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...getConfig(), ...patch }
  writeAtomic(next)
  current = next
  return next
}

export function regenerateToken(): string {
  return saveConfig({ token: newToken() }).token
}

function writeAtomic(cfg: AppConfig): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  // mode is honoured on POSIX; Windows ignores it (the file lives in the per-user profile).
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, p)
}
