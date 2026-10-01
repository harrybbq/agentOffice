// DOM overlay: waiting list grouped by team + team legend (bottom-left), CEO speech bar (bottom
// centre), event/connection info (bottom-right), PA banner and office-wide indicator (top).
import type { AgentStore, WaitingInfo } from './agents'
import type { TeamInfo } from './scene/OfficeScene'
import type { OrderResult } from '../shared/orders'
import { ORDER_MAX_CHARS } from '../shared/orders'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "Delivered to 1 of 2 · not connected (...): Team B" */
export function orderToast(res: OrderResult, nameOf: (id: string) => string): { text: string; ok: boolean } {
  const parts: string[] = []
  const total = res.delivered.length + res.failed.length
  if (res.delivered.length > 0) parts.push(`Delivered to ${res.delivered.length}${total > 1 ? ` of ${total}` : ''}`)
  const byReason = new Map<string, string[]>()
  for (const f of res.failed) {
    if (!byReason.has(f.reason)) byReason.set(f.reason, [])
    if (f.agentId && f.agentId !== 'all') byReason.get(f.reason)!.push(nameOf(f.agentId))
  }
  for (const [reason, names] of byReason) parts.push(names.length > 0 ? `${reason}: ${names.join(', ')}` : reason)
  return { text: parts.join(' · ') || 'Nothing sent', ok: res.failed.length === 0 && res.delivered.length > 0 }
}

export interface HudCallbacks {
  onTeamClick?: (teamId: string) => void
  /** Speech bar submit. Resolves with the delivery result (shown as a toast). */
  onSendOrder?: (target: string, text: string) => Promise<OrderResult>
  /** Office-wide indicator clicked. */
  onEndOfficeWide?: () => void
}

export class Hud {
  private waitingBox = el('div', 'hud-panel hud-waiting')
  private waitingList = el('div')
  private legend = el('div', 'hud-panel hud-legend')
  private info = el('div', 'hud-panel hud-info')
  private bar = el('form', 'hud-panel hud-bar')
  private target = el('select', 'hud-target')
  private input = el('input', 'hud-input')
  private send = el('button', 'hud-send', 'Send')
  private toast = el('div', 'hud-toast')
  private banner = el('div', 'hud-banner')
  private wide = el('button', 'hud-wide')
  private teams: TeamInfo[] = []
  private optionsKey = ''
  private connection = ''
  private themeName = ''
  private ordersAllowed = false
  private wideEndsAt: number | null = null
  private toastTimer = 0
  private bannerTimer = 0
  private sending = false

  constructor(
    root: HTMLElement,
    private store: AgentStore,
    private cb: HudCallbacks = {}
  ) {
    root.replaceChildren()
    const left = el('div', 'hud-left')
    this.waitingBox.append(el('h2', undefined, 'Waiting on you'), this.waitingList)
    left.append(this.waitingBox, this.legend)
    // pointerdown (not click): the legend re-renders every second, which can swallow a click.
    this.legend.addEventListener('pointerdown', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-team]')
      if (row?.dataset.team) this.cb.onTeamClick?.(row.dataset.team)
    })

    this.buildBar()
    this.banner.hidden = true
    this.wide.type = 'button'
    this.wide.hidden = true
    this.wide.title = 'Click to end office-wide mode (workers go back to their branches)'
    this.wide.addEventListener('click', () => this.cb.onEndOfficeWide?.())
    const top = el('div', 'hud-top')
    top.append(this.banner, this.wide)

    root.append(top, left, this.bar, this.info)
    window.setInterval(() => this.render(), 1000)
    this.render()
  }

  private buildBar(): void {
    this.bar.setAttribute('autocomplete', 'off')
    this.target.title = 'Who hears the CEO'
    this.target.setAttribute('aria-label', 'Order target')
    this.input.type = 'text'
    this.input.maxLength = ORDER_MAX_CHARS
    this.input.setAttribute('aria-label', 'CEO order')
    this.input.spellcheck = false
    this.send.type = 'submit'
    this.toast.hidden = true
    this.toast.setAttribute('role', 'status')
    const row = el('div', 'hud-bar-row')
    row.append(el('span', 'hud-bar-label', 'CEO'), this.target, this.input, this.send)
    this.bar.append(this.toast, row)
    this.bar.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.submit()
    })
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        this.input.blur()
      }
      ev.stopPropagation() // keep typing out of the game
    })
    this.updateOptions()
    this.updatePlaceholder()
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim()
    if (!text || this.sending || !this.cb.onSendOrder) return
    const target = this.target.value || 'all'
    this.sending = true
    this.send.disabled = true
    try {
      const res = await this.cb.onSendOrder(target, text)
      const t = orderToast(res, (id) => this.teams.find((x) => x.id === id)?.name ?? id.slice(0, 8))
      this.showToast(t.text, t.ok)
      if (res.delivered.length > 0) this.input.value = ''
    } catch (err) {
      this.showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, false)
    } finally {
      this.sending = false
      this.send.disabled = false
    }
  }

  showToast(text: string, ok: boolean, ms = 6000): void {
    this.toast.textContent = text
    this.toast.classList.toggle('hud-toast-ok', ok)
    this.toast.hidden = false
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => (this.toast.hidden = true), ms)
  }

  /** The PA announcement across the top (orders to the whole office). */
  showBanner(text: string, ms = 5000): void {
    this.banner.textContent = `PA · CEO to all staff: ${text}`
    this.banner.hidden = false
    this.banner.classList.remove('hud-banner-in')
    void this.banner.offsetWidth // restart the animation
    this.banner.classList.add('hud-banner-in')
    window.clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => (this.banner.hidden = true), ms)
  }

  setOfficeWide(endsAt: number | null): void {
    this.wideEndsAt = endsAt
    this.render()
  }

  setOrdersAllowed(on: boolean): void {
    this.ordersAllowed = on
    this.updatePlaceholder()
  }

  setConnection(text: string): void {
    this.connection = text
    this.render()
  }

  setTheme(name: string): void {
    this.themeName = name
    this.render()
  }

  setTeams(teams: TeamInfo[]): void {
    this.teams = teams
    this.updateOptions()
    this.render()
  }

  private updatePlaceholder(): void {
    this.input.placeholder = this.ordersAllowed
      ? 'Tell your managers something… (Enter to send, Esc to leave)'
      : 'Orders are off (tray → Allow CEO orders) · Enter sends, Esc leaves'
  }

  /** Rebuilds the target list only when the live teams change, keeping the selection. */
  private updateOptions(): void {
    const live = this.teams.filter((t) => t.live)
    const key = live.map((t) => `${t.id}=${t.name}`).join('|')
    if (key === this.optionsKey && this.target.options.length > 0) return
    this.optionsKey = key
    const prev = this.target.value
    const all = el('option', undefined, 'Whole office')
    all.value = 'all'
    this.target.replaceChildren(
      all,
      ...live.map((t) => {
        const o = el('option', undefined, t.name)
        o.value = t.id
        return o
      })
    )
    this.target.value = [...this.target.options].some((o) => o.value === prev) ? prev : 'all'
  }

  render(): void {
    const now = Date.now()
    this.renderWaiting(now)

    this.legend.hidden = this.teams.length === 0
    this.legend.replaceChildren(
      ...this.teams.map((t) => {
        const row = el('div', 'hud-team')
        const sw = el('span', 'hud-swatch')
        sw.style.background = t.color
        sw.title = 'Team colour'
        const dot = el('span', 'hud-dot')
        dot.style.background = t.providerColor
        dot.title = t.provider
        row.title = `${t.provider} · click to show this branch (double-click the office to fit all)`
        row.dataset.team = t.id
        row.append(sw, dot, el('span', undefined, t.workers > 0 ? `${t.name} (+${t.workers})` : t.name))
        return row
      })
    )

    if (this.wideEndsAt !== null) {
      this.wide.hidden = false
      this.wide.textContent = `Office-wide task in progress · ${ago(this.wideEndsAt - now)} left · click to end`
    } else this.wide.hidden = true

    const last = this.store.lastEventAt
    this.info.replaceChildren(
      el('div', undefined, `${this.store.eventCount} events${last ? ` · last ${ago(now - last)} ago` : ''}`),
      el('div', 'hud-dim', [this.connection, this.themeName].filter(Boolean).join(' · '))
    )
  }

  /** Each waiting agent individually, grouped by team. */
  private renderWaiting(now: number): void {
    const waiting = this.store.waiting
    this.waitingBox.hidden = waiting.length === 0
    const groups = new Map<string, WaitingInfo[]>()
    for (const w of waiting) {
      if (!groups.has(w.teamId)) groups.set(w.teamId, [])
      groups.get(w.teamId)!.push(w)
    }
    const out: HTMLElement[] = []
    for (const [teamId, list] of groups) {
      const team = this.teams.find((t) => t.id === teamId)
      const head = el('div', 'hud-wgroup')
      const sw = el('span', 'hud-swatch')
      sw.style.background = team?.color ?? '#888'
      head.append(sw, el('span', undefined, team?.name ?? teamId.slice(0, 10)))
      const ul = el('ul')
      for (const w of list) {
        const li = el('li')
        li.append(el('strong', undefined, w.displayName), el('span', 'hud-ago', ago(now - w.since)))
        if (w.detail) li.append(el('div', 'hud-detail', w.detail))
        ul.append(li)
      }
      out.push(head, ul)
    }
    this.waitingList.replaceChildren(...out)
  }
}
