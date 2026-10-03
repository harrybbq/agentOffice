// The floating station tags ("Vault · Secure storage") and the character hover card. They are DOM
// elements in a layer over the canvas, positioned from world coordinates: text stays sharp at any
// zoom (the Phaser canvas is pixel-art scaled) and costs nothing while the camera is still.
//
// What a tag says comes from the theme (stationLabels); where it sits from the map (stationAnchors).
// Declutter: below LABEL_FULL_ZOOM only titles, below LABEL_MIN_ZOOM nothing; tags that would overlap
// a more important one are dropped; a tag fades while a character's speech bubble is behind it; the
// station under the pointer always shows in full, with who is there.
// Styles: .station-tag / .agent-hover in ui/styles/inspect.css.
import type { StationLabel } from '../../shared/theme'
import { declutter, labelMode, stationAnchors } from '../theme/stations'
import type { LabelAnchor, LabelMode } from '../theme/stations'
import type { Block } from '../world/layout'
import type { Point } from './roster'

export interface CameraView {
  /** World coordinates of the canvas's top-left corner. */
  x: number
  y: number
  zoom: number
  width: number
  height: number
}

interface Tag {
  blockId: string
  anchor: LabelAnchor
  el: HTMLDivElement
  who: HTMLSpanElement
  /** Measured size per mode ('title' | 'full' | 'hover:<names>'). */
  sizes: Map<string, { w: number; h: number }>
  leaving: boolean
}

export interface StationHit {
  blockId: string
  anchor: LabelAnchor
}

const HIT_PAD = 4
const HIT_RADIUS = 16
const FADE_MS = 320
/** How much of a tag sits above its anchor (the top edge of the station): it clips onto the edge. */
const TAG_LIFT = 0.72

function css(color: number | null): string {
  return color === null ? '' : `#${color.toString(16).padStart(6, '0')}`
}

export class StationLabels {
  private layer: HTMLDivElement
  private tags: Tag[] = []
  private enabled = true
  private hover: Tag | null = null
  private hoverNames = ''
  private dirty = true
  private last: CameraView | null = null
  private lastBubbles = ''

  constructor(
    host: HTMLElement,
    private labels: ReadonlyMap<string, StationLabel>,
    private tile: number
  ) {
    this.layer = document.createElement('div')
    this.layer.className = 'station-layer'
    host.appendChild(this.layer)
  }

  get count(): number {
    return this.tags.length
  }

  /** Tags for a block that now stands. `animate`: they pop in one after another. */
  add(block: Block, animate: boolean): void {
    if (this.labels.size === 0) return
    this.drop(block.id)
    const { offset, template } = block
    const anchors = stationAnchors(block, this.labels, this.tile, (p) =>
      template.seats.some((s) => Math.abs(s.x + offset.x - p.x) < 1 && Math.abs(s.y + offset.y - p.y) < 1)
    )
    anchors.forEach((anchor, i) => {
      const el = document.createElement('div')
      el.className = 'station-tag'
      const dot = document.createElement('span')
      dot.className = 'station-dot'
      const colour = css(anchor.color)
      if (colour) dot.style.background = colour
      const text = document.createElement('span')
      text.className = 'station-text'
      const title = document.createElement('span')
      title.className = 'station-title'
      title.textContent = anchor.label.title
      text.appendChild(title)
      if (anchor.label.subtitle) {
        const sub = document.createElement('span')
        sub.className = 'station-sub'
        sub.textContent = anchor.label.subtitle
        text.appendChild(sub)
      }
      const who = document.createElement('span')
      who.className = 'station-who'
      text.appendChild(who)
      el.append(dot, text)
      if (animate) {
        el.classList.add('is-new')
        el.style.animationDelay = `${Math.min(i * 45, 500)}ms`
      }
      this.layer.appendChild(el)
      this.tags.push({ blockId: block.id, anchor, el, who, sizes: new Map(), leaving: false })
    })
    this.dirty = true
  }

  /** The block is being demolished: its tags fade out. */
  remove(blockId: string): void {
    for (const t of this.tags) {
      if (t.blockId !== blockId || t.leaving) continue
      t.leaving = true
      t.el.classList.add('is-out')
      if (this.hover === t) this.hover = null
      window.setTimeout(() => {
        t.el.remove()
        this.tags = this.tags.filter((x) => x !== t)
      }, FADE_MS)
    }
  }

  private drop(blockId: string): void {
    for (const t of this.tags) if (t.blockId === blockId) t.el.remove()
    this.tags = this.tags.filter((t) => t.blockId !== blockId)
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    this.layer.classList.toggle('is-off', !on)
    this.dirty = true
  }

  /** The station under a world point, if any (its furniture, or right at its location). */
  stationAt(p: Point): StationHit | null {
    if (!this.enabled) return null
    for (const t of this.tags) {
      if (t.leaving) continue
      const r = t.anchor.rect
      if (r && p.x >= r.x - HIT_PAD && p.x <= r.x + r.width + HIT_PAD && p.y >= r.y - HIT_PAD && p.y <= r.y + r.height + HIT_PAD) {
        return { blockId: t.blockId, anchor: t.anchor }
      }
      if (t.anchor.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= HIT_RADIUS)) return { blockId: t.blockId, anchor: t.anchor }
    }
    return null
  }

  /** The station being pointed at (shown in full with who is there), or null. */
  setHover(hit: StationHit | null, names: readonly string[] = []): void {
    const tag = hit ? (this.tags.find((t) => t.blockId === hit.blockId && t.anchor.key === hit.anchor.key && !t.leaving) ?? null) : null
    const text = tag ? names.join(', ') : ''
    if (tag === this.hover && text === this.hoverNames) return
    if (this.hover && this.hover !== tag) {
      this.hover.el.classList.remove('is-hover')
      this.hover.who.textContent = ''
    }
    this.hover = tag
    this.hoverNames = text
    if (tag) {
      tag.el.classList.add('is-hover')
      tag.who.textContent = text ? `Here: ${text}` : 'Nobody here'
    }
    this.dirty = true
  }

  /**
   * Positions the tags for this camera; does nothing while neither it, the tags nor the speech
   * bubbles (`bubbles`, world rects) changed. A tag over a bubble fades: what is said comes first.
   */
  layout(cam: CameraView, bubbles: readonly { x: number; y: number; width: number; height: number }[] = []): void {
    const l = this.last
    const key = bubbles.map((b) => `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}`).join(';')
    if (!this.dirty && key === this.lastBubbles && l && l.x === cam.x && l.y === cam.y && l.zoom === cam.zoom && l.width === cam.width && l.height === cam.height) return
    this.last = { ...cam }
    this.lastBubbles = key
    this.dirty = false
    if (!this.enabled) return
    const mode: LabelMode = labelMode(cam.zoom)
    this.layer.dataset.mode = mode

    const placed: { tag: Tag; x: number; y: number; width: number; height: number; priority: number; forced: boolean; sx: number; sy: number }[] = []
    for (const t of this.tags) {
      const hovered = t === this.hover
      if (t.leaving || (mode === 'hidden' && !hovered)) {
        t.el.classList.add('is-hidden')
        continue
      }
      const sx = (t.anchor.x - cam.x) * cam.zoom
      const sy = (t.anchor.y - cam.y) * cam.zoom
      // A station that is out of view has no tag (a tag never stands in for something unseen).
      if (sx < 0 || sy < -10 || sx > cam.width || sy > cam.height + 10) {
        t.el.classList.add('is-hidden')
        continue
      }
      const size = this.measure(t, hovered ? `hover:${this.hoverNames}` : mode)
      // Kept inside the view horizontally, so a tag at the edge stays readable.
      const half = size.w / 2
      const cx = Math.min(Math.max(sx, half + 4), Math.max(half + 4, cam.width - half - 4))
      placed.push({ tag: t, sx: cx, sy, x: cx - half, y: sy - size.h * TAG_LIFT, width: size.w, height: size.h, priority: t.anchor.priority, forced: hovered })
    }
    const keep = declutter(placed)
    const talk = bubbles.map((b) => ({ x: (b.x - cam.x) * cam.zoom, y: (b.y - cam.y) * cam.zoom, width: b.width * cam.zoom, height: b.height * cam.zoom }))
    for (const p of placed) {
      const el = p.tag.el
      if (!keep.has(p)) {
        el.classList.add('is-hidden')
        continue
      }
      el.classList.remove('is-hidden')
      const covers = !p.forced && talk.some((b) => p.x < b.x + b.width && b.x < p.x + p.width && p.y < b.y + b.height && b.y < p.y + p.height)
      el.classList.toggle('is-behind', covers)
      el.style.transform = `translate(${Math.round(p.sx)}px, ${Math.round(p.sy)}px) translate(-50%, -${TAG_LIFT * 100}%)`
    }
  }

  private measure(t: Tag, key: string): { w: number; h: number } {
    let s = t.sizes.get(key)
    if (!s) {
      // Measured while not hidden; the mode class on the layer decides what is in the tag.
      const hidden = t.el.classList.contains('is-hidden')
      if (hidden) t.el.classList.remove('is-hidden')
      s = { w: t.el.offsetWidth, h: t.el.offsetHeight }
      if (hidden) t.el.classList.add('is-hidden')
      if (s.w > 0) {
        if (t.sizes.size > 12) t.sizes.clear()
        t.sizes.set(key, s)
      }
    }
    return s
  }

  destroy(): void {
    this.layer.remove()
    this.tags = []
    this.hover = null
  }
}

// ---- hover card ------------------------------------------------------------------------------------

export interface HoverInfo {
  name: string
  /** "Manager" / "Worker · Explore" */
  role: string
  /** "Copying · example.com" */
  phrase: string
  /** "12 min in the office" */
  runtime: string
  /** Team colour (CSS) or '' */
  color: string
}

/** The small card over the character under the pointer. Data comes from the scene: no IPC. */
export class HoverCard {
  private el: HTMLDivElement
  private name: HTMLSpanElement
  private role: HTMLSpanElement
  private phrase: HTMLDivElement
  private runtime: HTMLDivElement
  private swatch: HTMLSpanElement
  private shown = false
  private key = ''

  constructor(host: HTMLElement) {
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
      const e = document.createElement(tag)
      e.className = cls
      return e
    }
    this.el = mk('div', 'agent-hover')
    const head = mk('div', 'agent-hover-head')
    this.swatch = mk('span', 'swatch')
    this.name = mk('span', 'agent-hover-name')
    this.role = mk('span', 'agent-hover-role')
    head.append(this.swatch, this.name, this.role)
    this.phrase = mk('div', 'agent-hover-phrase')
    this.runtime = mk('div', 'agent-hover-runtime')
    this.el.append(head, this.phrase, this.runtime)
    host.appendChild(this.el)
  }

  /** Shows the card above screen point (x, y) = the top of the character's head. */
  show(info: HoverInfo, x: number, y: number, view: { width: number; height: number }): void {
    const key = `${info.name}\n${info.role}\n${info.phrase}\n${info.runtime}\n${info.color}`
    if (key !== this.key) {
      this.key = key
      this.name.textContent = info.name
      this.role.textContent = info.role
      this.phrase.textContent = info.phrase
      this.runtime.textContent = info.runtime
      this.swatch.style.background = info.color
      this.swatch.style.display = info.color ? '' : 'none'
    }
    if (!this.shown) {
      this.shown = true
      this.el.classList.add('is-shown')
    }
    const w = this.el.offsetWidth
    const h = this.el.offsetHeight
    const left = Math.round(Math.min(Math.max(x - w / 2, 6), Math.max(6, view.width - w - 6)))
    // Above the head; below the feet when there is no room above.
    const above = y - h - 10
    const top = Math.round(above >= 6 ? above : Math.min(view.height - h - 6, y + 64))
    this.el.style.transform = `translate(${left}px, ${top}px)`
  }

  hide(): void {
    if (!this.shown) return
    this.shown = false
    this.el.classList.remove('is-shown')
  }

  destroy(): void {
    this.el.remove()
  }
}
