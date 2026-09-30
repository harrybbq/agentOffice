// Minimal DOM overlay: waiting list (top-left), team legend, event/connection info (top-right).
import type { AgentStore } from './agents'
import type { TeamInfo } from './scene/OfficeScene'

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

export class Hud {
  private waitingBox = el('div', 'hud-panel hud-waiting')
  private waitingList = el('ul')
  private legend = el('div', 'hud-panel hud-legend')
  private info = el('div', 'hud-panel hud-info')
  private teams: TeamInfo[] = []
  private connection = ''
  private themeName = ''

  constructor(
    root: HTMLElement,
    private store: AgentStore,
    private onTeamClick: (teamId: string) => void = () => undefined
  ) {
    root.replaceChildren()
    const left = el('div', 'hud-left')
    this.waitingBox.append(el('h2', undefined, 'Waiting on you'), this.waitingList)
    left.append(this.waitingBox, this.legend)
    // pointerdown (not click): the legend re-renders every second, which can swallow a click.
    this.legend.addEventListener('pointerdown', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-team]')
      if (row?.dataset.team) this.onTeamClick(row.dataset.team)
    })
    root.append(left, this.info)
    window.setInterval(() => this.render(), 1000)
    this.render()
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
    this.render()
  }

  render(): void {
    const now = Date.now()
    const waiting = this.store.waiting
    this.waitingBox.hidden = waiting.length === 0
    this.waitingList.replaceChildren(
      ...waiting.map((w) => {
        const li = el('li')
        li.append(el('strong', undefined, w.displayName), el('span', 'hud-ago', ago(now - w.since)))
        if (w.detail) li.append(el('div', 'hud-detail', w.detail))
        return li
      })
    )

    this.legend.hidden = this.teams.length === 0
    this.legend.replaceChildren(
      ...this.teams.map((t) => {
        const row = el('div', 'hud-team')
        const sw = el('span', 'hud-swatch')
        sw.style.background = t.color
        row.title = `${t.provider} · click to show this branch (double-click the office to fit all)`
        row.dataset.team = t.id
        row.append(sw, el('span', undefined, t.workers > 0 ? `${t.name} (+${t.workers})` : t.name))
        return row
      })
    )

    const last = this.store.lastEventAt
    this.info.replaceChildren(
      el('div', undefined, `${this.store.eventCount} events${last ? ` · last ${ago(now - last)} ago` : ''}`),
      el('div', 'hud-dim', [this.connection, this.themeName].filter(Boolean).join(' · '))
    )
  }
}
