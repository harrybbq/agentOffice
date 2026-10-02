// Pure logic of the preview pane (no DOM, no React): the pane's remembered state, the device
// widths and how a frame is scaled to fit, the address field. Tested in tests/preview.test.ts.
import { completeAddress, parsePreviewUrl, type PreviewBlocked, type PreviewInfo } from '../../shared/preview'

// ---- pane state ----------------------------------------------------------------------------------

export type DeviceId = 'fit' | 'desktop' | 'tablet' | 'phone'

export interface Device {
  id: DeviceId
  label: string
  /** CSS pixels the page is laid out at; null = as wide as the pane. */
  width: number | null
}

export const DEVICES: readonly Device[] = [
  { id: 'fit', label: 'Fit', width: null },
  { id: 'desktop', label: 'Desktop', width: 1280 },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'phone', label: 'Phone', width: 390 }
]

export interface PaneState {
  open: boolean
  /** Width of the open pane in px. */
  width: number
  device: DeviceId
  /** The session whose preview stays on screen while others are selected; null = follow the selection. */
  pinned: string | null
}

export const PANE_MIN = 300
/** What the pane leaves for the rest of the window (the sidebar is not part of `total`). */
export const PANE_LEAVES = 340
export const PANE_DEFAULT: PaneState = { open: false, width: 460, device: 'fit', pinned: null }
/** Width of the closed pane (a rail with a button). */
export const RAIL_WIDTH = 30

/** `total`: the width the pane shares with the office and the panel (window minus sidebar). */
export function clampPaneWidth(width: number, total: number): number {
  const max = Math.max(PANE_MIN, total - PANE_LEAVES)
  return Math.round(Math.min(max, Math.max(PANE_MIN, Number.isFinite(width) ? width : PANE_DEFAULT.width)))
}

export type PaneAction =
  | { type: 'toggle' }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'resize'; width: number; total: number }
  | { type: 'device'; device: DeviceId }
  /** Pin that session (or null: follow the selection again). */
  | { type: 'pin'; sessionId: string | null }
  /** The session list changed: a pinned session that is gone is unpinned. */
  | { type: 'sessions'; ids: readonly string[] }

export function paneReducer(state: PaneState, action: PaneAction): PaneState {
  switch (action.type) {
    case 'toggle':
      return { ...state, open: !state.open }
    case 'open':
      return state.open ? state : { ...state, open: true }
    case 'close':
      return state.open ? { ...state, open: false } : state
    case 'resize': {
      const width = clampPaneWidth(action.width, action.total)
      return width === state.width ? state : { ...state, width }
    }
    case 'device':
      return DEVICES.some((d) => d.id === action.device) && action.device !== state.device ? { ...state, device: action.device } : state
    case 'pin':
      return action.sessionId === state.pinned ? state : { ...state, pinned: action.sessionId }
    case 'sessions':
      return state.pinned !== null && !action.ids.includes(state.pinned) ? { ...state, pinned: null } : state
  }
}

/** What was stored (localStorage) as a pane state; anything odd falls back to the default. */
export function parsePaneState(raw: unknown): PaneState {
  if (!raw || typeof raw !== 'object') return PANE_DEFAULT
  const r = raw as Partial<Record<keyof PaneState, unknown>>
  return {
    open: typeof r.open === 'boolean' ? r.open : PANE_DEFAULT.open,
    width: typeof r.width === 'number' && Number.isFinite(r.width) ? Math.max(PANE_MIN, Math.min(4000, Math.round(r.width))) : PANE_DEFAULT.width,
    device: DEVICES.some((d) => d.id === r.device) ? (r.device as DeviceId) : PANE_DEFAULT.device,
    pinned: typeof r.pinned === 'string' && r.pinned.length <= 64 ? r.pinned : null
  }
}

/** The session whose preview the pane shows: the pinned one, otherwise the selected one. */
export function shownSession(state: PaneState, selectedId: string | null): string | null {
  return state.pinned ?? selectedId
}

/** How much of the window's width the pane takes (for the layout of what is next to it). */
export function paneFootprint(state: PaneState, total: number): number {
  return state.open ? clampPaneWidth(state.width, total) + 1 : RAIL_WIDTH
}

// ---- device widths -------------------------------------------------------------------------------

export interface FrameLayout {
  /** Size of the frame element in CSS px, before scaling. */
  width: number
  height: number
  /** CSS transform scale (1 = not scaled). */
  scale: number
  /** Left offset that centres the (scaled) frame in the pane. */
  left: number
}

/**
 * Where the frame goes in a pane of `paneW` x `paneH` for a device width. A device wider than the
 * pane is laid out at its full width and scaled down to fit; a narrower one is centred at 1:1.
 */
export function frameLayout(paneW: number, paneH: number, deviceWidth: number | null): FrameLayout {
  const w = Math.max(0, Math.floor(paneW))
  const h = Math.max(0, Math.floor(paneH))
  if (deviceWidth === null || deviceWidth <= 0 || w === 0) return { width: w, height: h, scale: 1, left: 0 }
  if (deviceWidth <= w) return { width: deviceWidth, height: h, scale: 1, left: Math.floor((w - deviceWidth) / 2) }
  const scale = w / deviceWidth
  return { width: deviceWidth, height: Math.round(h / scale), scale, left: 0 }
}

/** "62%" next to a device that is scaled down; "" at 1:1. */
export function scaleLabel(scale: number): string {
  return scale >= 0.995 ? '' : `${Math.round(scale * 100)}%`
}

// ---- address field -------------------------------------------------------------------------------

export type AddressCheck = { ok: true; url: string } | { ok: false; error: string }

/** What the user typed, completed ("localhost:3000" -> "http://localhost:3000/") and checked. */
export function checkAddress(typed: string): AddressCheck {
  if (typed.trim().length === 0) return { ok: false, error: 'Type an address, like http://localhost:5173.' }
  const parsed = parsePreviewUrl(completeAddress(typed))
  return parsed.ok ? { ok: true, url: parsed.url } : { ok: false, error: parsed.error }
}

/** The address without the scheme, for labels: "localhost:5173/app". */
export function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

// ---- a page that wants out -----------------------------------------------------------------------

/** After the frame was put back on its page, a second attempt to leave within this time is not undone again. */
export const LEAVE_AGAIN_MS = 5000

export interface BlockedNotice {
  text: string
  /** Put the frame back on its page (false: it keeps leaving; that would loop). */
  restore: boolean
}

/** What the pane says and does when the page in the frame tried to go somewhere else. */
export function blockedNotice(blocked: PreviewBlocked, sinceLastMs: number): BlockedNotice {
  let host = 'another site'
  let local = false
  try {
    const u = new URL(blocked.url)
    host = u.host || host
    local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  } catch {
    /* not an address: keep the generic word */
  }
  if (sinceLastMs < LEAVE_AGAIN_MS) return { text: `This page keeps leaving for ${host}. Reload to show it again.`, restore: false }
  return {
    text: blocked.opened
      ? `Opened ${host} in your browser.`
      : local
        ? `The page tried to go to ${host}, which is not shown here.`
        : `The page tried to go to ${host}. Only pages on this computer are shown here.`,
    restore: true
  }
}

// ---- status --------------------------------------------------------------------------------------

export type DotState = 'none' | 'starting' | 'live' | 'unreachable'

export function dotState(info: PreviewInfo | null | undefined): DotState {
  if (!info || info.status === 'stopped') return 'none'
  if (info.status === 'ready') return info.framable === false ? 'unreachable' : 'live'
  return info.status === 'starting' ? 'starting' : 'unreachable'
}

export const DOT_LABEL: Record<DotState, string> = {
  none: 'No preview',
  starting: 'Starting',
  live: 'Live',
  unreachable: 'Not reachable'
}

/** "updated just now", "updated 3 s ago", "updated 2 min ago". */
export function updatedLabel(at: number | undefined, now: number): string {
  if (at === undefined) return ''
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 2) return 'updated just now'
  if (s < 60) return `updated ${s} s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `updated ${m} min ago` : `updated ${Math.floor(m / 60)} h ago`
}

/** Should the frame be replaced by the "cannot be shown here" screen? */
export function showsFallback(info: PreviewInfo, loadTimedOut: boolean): boolean {
  if (!info.url) return true
  return info.status === 'unreachable' || info.framable === false || loadTimedOut
}

/** The fallback's headline. */
export function fallbackTitle(info: PreviewInfo): string {
  if (!info.url) return info.status === 'starting' ? 'Starting the server' : 'The server did not start'
  if (info.status === 'unreachable') return info.script ? 'The server stopped' : 'Not reachable'
  if (info.framable === false) return 'This page cannot be shown here'
  return 'Still loading'
}

/** The fallback's sentence. */
export function fallbackText(info: PreviewInfo, loadTimedOut: boolean): string {
  if (info.note && (info.status === 'unreachable' || !info.url)) return info.note
  if (!info.url) return info.script ? `Starting npm run ${info.script}…` : 'Starting…'
  if (info.framable === false) return 'This page does not allow being shown inside another app.'
  if (info.status === 'unreachable') return 'Nothing answers at this address.'
  if (loadTimedOut) return 'The page is taking a long time to load.'
  return ''
}
