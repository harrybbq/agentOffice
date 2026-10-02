// Where the window was: its bounds and whether it was maximised, remembered per display layout
// (the same laptop with and without its external screen keeps two positions). On restore the
// bounds are clamped to a display that exists now, so the window can never come back off-screen.
//
// Pure: no Electron imports. main.ts feeds it `screen.getAllDisplays()` and the window's bounds.

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindow {
  /** The window's normal (not maximised) bounds. */
  bounds: WindowBounds
  maximized: boolean
}

/** Saved windows by display layout (`displayKey`), most recently used last. */
export type WindowStates = Record<string, SavedWindow>

/** At most this many display layouts are remembered. */
export const MAX_WINDOW_STATES = 8

const isBounds = (v: unknown): v is WindowBounds => {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((k) => Number.isInteger(o[k]) && Math.abs(o[k] as number) < 100_000) && (o.width as number) > 0 && (o.height as number) > 0
}

/** Names a display layout: every display's size and position, in a fixed order. */
export function displayKey(displays: readonly { bounds: WindowBounds }[]): string {
  return displays
    .map((d) => `${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y}`)
    .sort()
    .join('|')
    .slice(0, 400)
}

/** What config.json may hold under `window`: only well-formed entries survive. */
export function parseWindowStates(raw: unknown): WindowStates {
  const out: WindowStates = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(-MAX_WINDOW_STATES)) {
    if (key.length === 0 || key.length > 400 || !value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (!isBounds(v.bounds)) continue
    const { x, y, width, height } = v.bounds
    out[key] = { bounds: { x, y, width, height }, maximized: v.maximized === true }
  }
  return out
}

/** The states with this layout's window (re)placed last; the oldest layouts fall out. */
export function rememberWindow(states: WindowStates, key: string, saved: SavedWindow): WindowStates {
  const next: WindowStates = {}
  for (const [k, v] of Object.entries(states)) if (k !== key) next[k] = v
  next[key] = { bounds: { ...saved.bounds }, maximized: saved.maximized }
  const keys = Object.keys(next)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_WINDOW_STATES))) delete next[k]
  return next
}

const overlap = (a: WindowBounds, b: WindowBounds): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * The saved bounds, moved and shrunk so the whole window is inside one display's work area: the
 * display it overlaps most, or the first one (centred) if it is on none. Never smaller than `min`
 * unless the display is. Null without a display.
 */
export function clampToDisplays(
  bounds: WindowBounds,
  workAreas: readonly WindowBounds[],
  min: { width: number; height: number } = { width: 0, height: 0 }
): WindowBounds | null {
  if (workAreas.length === 0) return null
  let area = workAreas[0]
  let best = 0
  for (const a of workAreas) {
    const o = overlap(bounds, a)
    if (o > best) {
      best = o
      area = a
    }
  }
  const width = Math.min(area.width, Math.max(min.width, bounds.width))
  const height = Math.min(area.height, Math.max(min.height, bounds.height))
  if (best === 0) {
    return { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height }
  }
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}
