// Renderer entry: settings -> theme -> Phaser game; forwards events; rebuilds on settings change.
import Phaser from 'phaser'
import { parseAgentEvent } from '../shared/events'
import type { AgentEvent } from '../shared/events'
import type { AgentOfficeBridge, LoadedTheme, RendererSettings } from '../shared/ipc'
import type { OrderResult } from '../shared/orders'
import { parseMap, ThemeError, validateTheme } from './theme/loader'
import { OfficeScene } from './scene/OfficeScene'
import { AgentStore } from './agents'
import { Hud } from './hud'
import { OfficeWide } from './officeWide'

const gameRoot = document.getElementById('game')!
const errorBox = document.getElementById('error')!
const store = new AgentStore()
const officeWide = new OfficeWide()
let bridge: AgentOfficeBridge | null = null
const hud = new Hud(document.getElementById('hud')!, store, {
  onTeamClick: (teamId) => scene?.focusTeam(teamId),
  onSendOrder: (target, text) => sendOrder(target, text),
  onEndOfficeWide: () => setOfficeWide(false)
})

let game: Phaser.Game | null = null
let scene: OfficeScene | null = null
let settings: RendererSettings | null = null
let generation = 0

/** Speech bar: the CEO speaks (bubble + envelopes, PA banner for everyone), then the order is sent. */
async function sendOrder(target: string, text: string): Promise<OrderResult> {
  scene?.showOrder(target, text)
  if (target === 'all') hud.showBanner(text)
  if (!bridge) return { delivered: [], failed: [{ agentId: target, reason: 'not ready' }] }
  const res = await bridge.sendOrder({ target, text })
  if (target === 'all' && res.delivered.length > 0) setOfficeWide(true, res.delivered)
  return res
}

/** Office-wide mode on (tracking the teams that got the order; null = until timeout/click) or off. */
function setOfficeWide(on: boolean, teams: string[] | null = null): void {
  if (on) officeWide.start(teams)
  else if (officeWide.active) officeWide.end()
  else return
  scene?.setOfficeWide(officeWide.active)
  hud.setOfficeWide(officeWide.active ? Date.now() + officeWide.remainingMs() : null)
}

window.setInterval(() => {
  if (officeWide.check()) {
    scene?.setOfficeWide(false)
    hud.setOfficeWide(null)
  }
}, 1000)

// Dev builds only: window.__agentOfficeDev.officeWide(true) lets workers roam without a real order.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__agentOfficeDev = {
    officeWide: (on: boolean, timeoutMs?: number) => {
      if (on && typeof timeoutMs === 'number' && timeoutMs > 0) officeWide.timeoutMs = timeoutMs
      setOfficeWide(on, null)
      return officeWide.active
    },
    /** The live scene, for poking at state from devtools. */
    scene: () => scene
  }
}

function showError(msg: string): void {
  errorBox.textContent = msg
  errorBox.hidden = false
}

function clearError(): void {
  errorBox.hidden = true
  errorBox.textContent = ''
}

/** Plain-browser fallback (vite dev without Electron): fetch the theme over HTTP, no events. */
function devBridge(): AgentOfficeBridge {
  const emitters = new Set<(e: AgentEvent) => void>()
  // Handy from the devtools console: __agentOfficeEmit({ agentId: 'a', ... })
  ;(window as unknown as Record<string, unknown>).__agentOfficeEmit = (input: object) => {
    const e = parseAgentEvent({ provider: 'simulate', ...input })
    if (e) emitters.forEach((cb) => cb(e))
    else console.warn('[agent-office] invalid event', input)
  }
  return {
    onEvent: (cb) => (emitters.add(cb), () => emitters.delete(cb)),
    onSettings: () => () => undefined,
    getSettings: async () => ({ theme: 'office', overlay: false, allowOrders: false, officeWideTimeoutMs: 10 * 60_000 }),
    sendOrder: async (req) => ({
      delivered: [],
      failed: [{ agentId: req.target, reason: 'dev mode (no Electron): orders are not sent' }]
    }),
    listThemes: async () => [{ name: 'office', displayName: 'Office' }],
    loadTheme: async (name) => {
      const baseUrl = `/themes/${encodeURIComponent(name)}/`
      const get = async (path: string) => {
        const r = await fetch(baseUrl + path)
        if (!r.ok) throw new Error(`${r.status} for ${baseUrl + path}`)
        return r.json()
      }
      try {
        const manifest = await get('theme.json')
        const [hq, branch] = await Promise.all([get(manifest.hq), get(manifest.branch)])
        return { manifest, hq, branch, baseUrl }
      } catch (err) {
        throw new Error(
          `Not running inside Electron and the theme couldn't be fetched (${String(err)}). ` +
            'Start the app with "npm run dev".'
        )
      }
    }
  }
}

async function build(s: RendererSettings, bridge: AgentOfficeBridge): Promise<void> {
  const gen = ++generation
  game?.destroy(true)
  game = null
  scene = null
  document.body.classList.toggle('overlay', s.overlay)

  let theme: LoadedTheme
  try {
    theme = await bridge.loadTheme(s.theme)
  } catch (err) {
    showError(`Couldn't load theme "${s.theme}": ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (gen !== generation) return

  let hq, branch
  try {
    hq = parseMap(theme.hq, theme.manifest.hq ?? 'HQ map')
    branch = parseMap(theme.branch, theme.manifest.branch ?? 'Branch map')
    for (const w of validateTheme(theme.manifest, hq, branch)) console.warn(`[agent-office] ${w}`)
  } catch (err) {
    showError(err instanceof ThemeError ? err.message : `Invalid theme: ${String(err)}`)
    return
  }
  clearError()
  hud.setTheme(theme.manifest.displayName)

  const sc = new OfficeScene({
    theme,
    hq,
    branch,
    overlay: s.overlay,
    onTeams: (teams) => hud.setTeams(teams),
    isOfficeWide: () => officeWide.active,
    onReady: () => {
      if (gen !== generation) return
      scene = sc
      // Rebuild the roster from what we already know; characters walk in again.
      sc.replay(store.replay())
    }
  })

  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: gameRoot,
    width: window.innerWidth,
    height: window.innerHeight,
    pixelArt: true,
    roundPixels: true,
    transparent: s.overlay,
    backgroundColor: s.overlay ? undefined : theme.manifest.background,
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
    banner: false,
    scene: [sc]
  })
  if (typeof window.agentOffice === 'undefined') {
    ;(window as unknown as Record<string, unknown>).__agentOfficeGame = game // dev-only debugging handle
  }
}

async function boot(): Promise<void> {
  const inElectron = typeof window.agentOffice !== 'undefined'
  const b = inElectron ? window.agentOffice : devBridge()
  bridge = b
  hud.setConnection(inElectron ? 'connected' : 'dev mode (no Electron)')

  b.onEvent((e) => {
    store.apply(e)
    scene?.handleEvent(e)
    if (officeWide.observe(e)) {
      scene?.setOfficeWide(false)
      hud.setOfficeWide(null)
    }
    hud.render()
  })
  const applySettings = (s: RendererSettings) => {
    hud.setOrdersAllowed(s.allowOrders)
    if (s.officeWideTimeoutMs > 0) officeWide.timeoutMs = s.officeWideTimeoutMs
  }
  b.onSettings((s) => {
    const prev = settings
    settings = s
    applySettings(s)
    if (!prev || prev.theme !== s.theme || prev.overlay !== s.overlay) void build(s, b)
  })

  try {
    settings = await b.getSettings()
  } catch (err) {
    showError(`Couldn't read settings: ${String(err)}`)
    return
  }
  applySettings(settings)
  await build(settings, b)
}

void boot()
