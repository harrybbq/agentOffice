// The slim progress bar under each branch's sign. DOM elements in the layer over the canvas (like
// the station tags), positioned from world coordinates: the Phaser canvas is pixel-art scaled, a
// bar drawn in it would blur and change thickness with the zoom; this one stays crisp and 4 px.
//
// What a bar shows comes from the shell (ui/progress.ts signBars): a determinate fill in the team
// colour when there is a real count, a striped "working" bar when there is none, nothing when idle.
// Not part of the station tags: the "Labels" switch does not hide it, and overlay mode keeps it.
// Styles: .sign-bar in ui/styles/progress.css.
import type { CameraView } from './stationLabels'

export interface SignBarState {
  mode: 'determinate' | 'indeterminate'
  /** 0..1 */
  fraction: number
  tone: 'live' | 'waiting' | 'stopped' | 'finished'
  /** "3/7", or '' */
  label: string
}

/** Where a branch's sign is, in world coordinates, and its team colour. Null: no sign to hang a bar on. */
export interface SignAnchor {
  /** Centre of the sign. */
  x: number
  /** Bottom edge of the sign. */
  y: number
  /** Width of the sign. */
  width: number
  /** Team colour (CSS), or ''. */
  color: string
}

interface Bar {
  el: HTMLDivElement
  fill: HTMLSpanElement
  label: HTMLSpanElement
  /** What the element shows now (state + colour), and where. */
  shown: string
  placed: string
}

/** Never narrower than this on screen, however far the camera is zoomed out. */
const MIN_WIDTH = 34
const MAX_WIDTH = 220
/** Below this width the count next to the bar is left out. */
const LABEL_MIN_WIDTH = 48

export class SignBars {
  private layer: HTMLDivElement
  private bars = new Map<string, Bar>()
  private states: ReadonlyMap<string, SignBarState> = new Map()

  constructor(host: HTMLElement) {
    this.layer = document.createElement('div')
    this.layer.className = 'sign-bar-layer'
    host.appendChild(this.layer)
  }

  get count(): number {
    return this.bars.size
  }

  /** The bars to show, by team id. Teams that are not in the map have none. */
  set(states: ReadonlyMap<string, SignBarState>): void {
    this.states = states
    for (const [id, bar] of this.bars) {
      if (states.has(id)) continue
      bar.el.remove()
      this.bars.delete(id)
    }
  }

  /** Positions the bars for this camera. `anchor` says where a team's sign is (null: none right now). */
  layout(cam: CameraView, anchor: (teamId: string) => SignAnchor | null): void {
    for (const [id, state] of this.states) {
      const at = anchor(id)
      let bar = this.bars.get(id)
      if (!at) {
        if (bar && bar.placed !== 'hidden') {
          bar.el.classList.add('is-hidden')
          bar.placed = 'hidden'
        }
        continue
      }
      if (!bar) {
        bar = this.make()
        this.bars.set(id, bar)
      }
      const fraction = Math.min(1, Math.max(0, state.fraction))
      const shown = `${state.mode}|${fraction.toFixed(4)}|${state.tone}|${state.label}|${at.color}`
      if (shown !== bar.shown) {
        bar.shown = shown
        bar.el.className = `sign-bar is-${state.mode} is-${state.tone}`
        bar.el.style.setProperty('--pbar-color', at.color || '')
        bar.fill.style.width = state.mode === 'determinate' ? `${(fraction * 100).toFixed(2)}%` : ''
        bar.label.textContent = state.label
        bar.placed = ''
      }
      const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, at.width * cam.zoom)))
      const x = Math.round((at.x - cam.x) * cam.zoom - width / 2)
      const y = Math.round((at.y - cam.y) * cam.zoom)
      const out = x + width < 0 || x > cam.width || y < -8 || y > cam.height
      const placed = out ? 'hidden' : `${x},${y},${width}`
      if (placed === bar.placed) continue
      bar.placed = placed
      bar.el.classList.toggle('is-hidden', out)
      if (out) continue
      bar.el.style.width = `${width}px`
      bar.el.style.transform = `translate(${x}px, ${y}px)`
      bar.label.style.display = width >= LABEL_MIN_WIDTH && state.label ? '' : 'none'
    }
  }

  private make(): Bar {
    const el = document.createElement('div')
    el.className = 'sign-bar'
    const fill = document.createElement('span')
    fill.className = 'sign-bar-fill'
    const label = document.createElement('span')
    label.className = 'sign-bar-label'
    el.append(fill, label)
    this.layer.appendChild(el)
    return { el, fill, label, shown: '', placed: '' }
  }

  destroy(): void {
    this.layer.remove()
    this.bars.clear()
  }
}
