// One block (HQ or branch) on screen, with its construction and demolition animations:
// floor wipe from the connecting door -> walls drawn segment by segment -> furniture pops in -> sign
// drops. Demolition runs the other way. Timings come from the scene.
import Phaser from 'phaser'
import type { Block } from '../world/layout'
import { drawImageLayers, drawTileLayers, FURNITURE_ATLAS, furnitureScale } from '../theme/loader'
import type { FloorImage, FurnitureRect, Rect, TileLayer, WallRect } from '../theme/loader'
import { TEXT_RES, WORLD_FONT } from './charTextures'
import { doorNormal } from './roster'
import type { Point } from './roster'

export type BlockState = 'planned' | 'building' | 'ready' | 'demolishing'

export interface BuildTimes {
  floorMs: number
  wallsMs: number
  furnitureMs: number
  signMs: number
}

/** Longest single furniture pop (scale bounce), ms. */
const ITEM_POP_MS = 280
const SIGN_DROP_PX = 26
const WIPE_EDGE = 0xfff3c4

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.width, b.x + b.width)
  const btm = Math.min(a.y + a.height, b.y + b.height)
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null
}

interface Item {
  rect: FurnitureRect
  obj: Phaser.GameObjects.Container
}

export class BlockView {
  state: BlockState
  readonly block: Block
  private scene: Phaser.Scene
  private depth: number
  private tiles: TileLayer[]
  /** The map's floor pictures (image layers), when it has them and they loaded. */
  private images: FloorImage[] = []
  private floor: Phaser.GameObjects.Graphics | null = null
  private areas: FurnitureRect[] = []
  private areaLabels: { text: Phaser.GameObjects.Text; at: Point }[] = []
  private items: Item[] = []
  private walls: Phaser.GameObjects.Graphics
  private wallList: WallRect[]
  private lot: Phaser.GameObjects.Graphics | null = null
  private sign: Phaser.GameObjects.Container
  private signText: Phaser.GameObjects.Text
  private signSwatch: Phaser.GameObjects.Rectangle | null
  /** Small provider-colour dot next to the team swatch. */
  private signDot: Phaser.GameObjects.Arc | null
  private signY: number
  /** 0..1 floor reveal, measured from `from` (the connecting door's edge) inward. */
  private wipe = 1
  private wallsProgress = 1
  private from: Point = { x: 0, y: 1 }

  constructor(scene: Phaser.Scene, block: Block, o: { depth: number; signDepth: number; built: boolean }) {
    this.scene = scene
    this.block = block
    this.depth = o.depth
    this.state = o.built ? 'ready' : 'planned'
    const d = o.depth

    this.tiles = drawTileLayers(scene, block, d)
    if (this.tiles.length === 0) this.images = drawImageLayers(scene, block, d)
    // With a floor from the theme (tiles or pictures) the stand-in rectangles marked `fallback` go.
    const art = this.tiles.length > 0 || this.images.length > 0
    const atlas = furnitureScale(scene)
    const frames = atlas > 0 ? scene.textures.get(FURNITURE_ATLAS) : null
    const sprite = (f: FurnitureRect) => !!f.sprite && !!frames && frames.has(f.sprite)
    {
      const shown = block.furniture.filter((f) => !(art && f.fallback))
      this.areas = shown.filter((f) => !f.solid && !sprite(f))
      this.floor = scene.add.graphics().setDepth(d + 0.1)
      for (const f of this.areas) {
        if (!f.label) continue
        const at = { x: f.x + f.width / 2, y: f.y + 3 }
        const text = scene.add
          .text(at.x, at.y, f.label, { fontFamily: WORLD_FONT, fontSize: '10px', color: '#1d1d1d', resolution: TEXT_RES })
          .setOrigin(0.5, 0)
          .setAlpha(0.55)
          .setDepth(d + 2)
        this.areaLabels.push({ text, at })
      }
      for (const f of shown) {
        if (sprite(f)) {
          // Flat things (a mat, a chair's seat) lie under the solid ones; `ysort` ones stand in front
          // of whoever is behind their bottom edge.
          const depth = f.ysort ? f.y + f.height : f.solid ? d + 0.5 : d + 0.3
          this.items.push({ rect: f, obj: this.makeSprite(f, depth, atlas) })
        } else if (f.solid) this.items.push({ rect: f, obj: this.makeItem(f, d + 0.5) })
      }
    }
    // Walls painted on the floor picture are not drawn again (they still block walking).
    this.wallList = this.images.some((i) => i.ref.walls) ? [] : block.walls
    this.walls = scene.add.graphics().setDepth(d + 1)

    const isHq = block.kind === 'hq'
    this.signY = block.offset.y - 6
    this.signText = scene.add
      .text(0, 0, '', {
        fontFamily: WORLD_FONT,
        fontSize: '13px',
        color: '#f4f1ea',
        backgroundColor: 'rgba(20, 22, 32, 0.85)',
        padding: { left: isHq ? 6 : 30, right: 6, top: 2, bottom: 2 },
        resolution: TEXT_RES
      })
      .setOrigin(0.5, 1)
    this.signSwatch = isHq ? null : scene.add.rectangle(0, 0, 10, 10, 0xffffff).setStrokeStyle(1, 0x000000, 0.6)
    const parts: Phaser.GameObjects.GameObject[] = [this.signText]
    this.signDot = isHq ? null : scene.add.circle(0, 0, 3, 0xffffff).setStrokeStyle(1, 0x000000, 0.6)
    if (this.signSwatch) parts.push(this.signSwatch)
    if (this.signDot) parts.push(this.signDot)
    this.sign = scene.add.container(block.offset.x + block.width / 2, this.signY, parts).setDepth(o.signDepth)

    if (o.built) {
      this.redrawFloor()
      this.redrawWalls()
    } else {
      this.wipe = 0
      this.wallsProgress = 0
      this.redrawFloor()
      this.redrawWalls()
      for (const it of this.items) it.obj.setScale(0).setVisible(false)
      this.sign.setAlpha(0)
    }
  }

  get rect(): Rect {
    const b = this.block
    return { x: b.offset.x, y: b.offset.y, width: b.width, height: b.height }
  }

  /**
   * The sign as it stands now: its centre, bottom edge and width in world coordinates. Null while it
   * is not (fully) there: the block is still being built or is coming down.
   */
  get signBox(): { x: number; y: number; width: number } | null {
    if (this.state !== 'ready' || this.sign.alpha < 1) return null
    return { x: this.sign.x, y: this.sign.y, width: this.signText.width }
  }

  /** Team name, team colour swatch and (optional) provider colour dot. */
  setSign(text: string, color: number | null, providerColor: number | null = null): void {
    this.signText.setText(text)
    if (this.signSwatch) {
      if (color !== null) this.signSwatch.setFillStyle(color)
      this.signSwatch.setPosition(-this.signText.width / 2 + 20, -this.signText.height / 2)
    }
    if (this.signDot) {
      this.signDot.setVisible(providerColor !== null)
      if (providerColor !== null) this.signDot.setFillStyle(providerColor)
      this.signDot.setPosition(-this.signText.width / 2 + 8, -this.signText.height / 2)
    }
  }

  /** Construction: floor wipe from `door` inward, walls, furniture, sign. */
  async build(t: BuildTimes, door: Point | null): Promise<void> {
    this.state = 'building'
    if (door) this.from = doorNormal(this.block, door)
    this.showLot()
    const floor = this.counter(t.floorMs, 'Sine.easeInOut', (v) => {
      this.wipe = v
      this.redrawFloor()
    })
    await this.wait(t.floorMs * 0.6)
    const walls = this.counter(t.wallsMs, 'Linear', (v) => {
      this.wallsProgress = v
      this.redrawWalls()
    })
    await this.wait(t.wallsMs * 0.7)
    const items = this.popItems(t.furnitureMs, door)
    await Promise.all([floor, walls, items])
    this.hideLot()
    await this.dropSign(t.signMs)
  }

  /** Demolition: furniture shrinks out, walls retract, floor and sign fade. Destroys the view. */
  async demolish(t: BuildTimes): Promise<void> {
    this.state = 'demolishing'
    const items = [...this.items].sort((a, b) => b.rect.y - a.rect.y)
    const n = items.length
    const pop = Math.min(ITEM_POP_MS, t.furnitureMs * 0.6)
    await Promise.all(
      items.map((it, i) =>
        this.tween({
          targets: it.obj,
          scale: 0,
          duration: pop,
          delay: n > 1 ? (i / (n - 1)) * Math.max(0, t.furnitureMs - pop) : 0,
          ease: 'Back.easeIn'
        })
      )
    )
    this.tween({ targets: this.sign, alpha: 0, y: this.signY - SIGN_DROP_PX / 2, duration: t.signMs, ease: 'Sine.easeIn' })
    await this.counter(t.wallsMs, 'Linear', (v) => {
      this.wallsProgress = 1 - v
      this.redrawWalls()
    })
    const fading: Phaser.GameObjects.GameObject[] = [...this.tiles, ...this.images.map((i) => i.image), ...this.areaLabels.map((l) => l.text)]
    if (this.floor) fading.push(this.floor)
    await this.tween({ targets: fading, alpha: 0, duration: t.floorMs, ease: 'Sine.easeIn' })
    this.destroy()
  }

  destroy(): void {
    for (const t of this.tiles) t.destroy()
    for (const i of this.images) i.image.destroy()
    this.floor?.destroy()
    for (const l of this.areaLabels) l.text.destroy()
    for (const it of this.items) it.obj.destroy()
    this.walls.destroy()
    this.lot?.destroy()
    this.sign.destroy()
  }

  // ---- drawing -------------------------------------------------------------------------------

  /** The part of the block revealed so far, growing from the connecting door's edge. */
  private revealed(): Rect | null {
    if (this.wipe <= 0) return null
    const r = this.rect
    const n = this.from
    if (n.y > 0) return { x: r.x, y: r.y + r.height * (1 - this.wipe), width: r.width, height: r.height * this.wipe }
    if (n.y < 0) return { x: r.x, y: r.y, width: r.width, height: r.height * this.wipe }
    if (n.x > 0) return { x: r.x + r.width * (1 - this.wipe), y: r.y, width: r.width * this.wipe, height: r.height }
    return { x: r.x, y: r.y, width: r.width * this.wipe, height: r.height }
  }

  private redrawFloor(): void {
    const shown = this.revealed()
    const has = (p: Point) => !!shown && p.x >= shown.x && p.x <= shown.x + shown.width && p.y >= shown.y && p.y <= shown.y + shown.height
    for (const layer of this.tiles) {
      for (const row of layer.layer.data) {
        for (const tile of row) {
          tile.visible = has({ x: layer.x + tile.pixelX + tile.width / 2, y: layer.y + tile.pixelY + tile.height / 2 })
        }
      }
    }
    for (const { image, ref } of this.images) {
      image.setVisible(!!shown)
      if (!shown) continue
      if (this.wipe >= 1) {
        image.setCrop()
        continue
      }
      // Cut at the wipe's leading edge only: the picture may stick out past the block on the others.
      const n = this.from
      const x0 = n.x > 0 ? (shown.x - image.x) * ref.scale : 0
      const y0 = n.y > 0 ? (shown.y - image.y) * ref.scale : 0
      const x1 = n.x < 0 || (n.x === 0 && n.y === 0) ? (shown.x + shown.width - image.x) * ref.scale : image.width
      const y1 = n.y < 0 ? (shown.y + shown.height - image.y) * ref.scale : image.height
      image.setCrop(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0))
    }
    for (const l of this.areaLabels) l.text.setVisible(has(l.at))
    const g = this.floor
    if (!g) return
    g.clear()
    if (!shown) return
    for (const f of this.areas) {
      const c = intersect(f, shown)
      if (!c) continue
      g.fillStyle(f.color, f.alpha)
      g.fillRect(c.x, c.y, c.width, c.height)
    }
    if (this.wipe < 1) {
      // Bright leading edge of the wipe.
      const n = this.from
      g.fillStyle(WIPE_EDGE, 0.85)
      if (n.y > 0) g.fillRect(shown.x, shown.y, shown.width, 3)
      else if (n.y < 0) g.fillRect(shown.x, shown.y + shown.height - 3, shown.width, 3)
      else if (n.x > 0) g.fillRect(shown.x, shown.y, 3, shown.height)
      else g.fillRect(shown.x + shown.width - 3, shown.y, 3, shown.height)
    }
  }

  /** Walls nearest the door first; each grows along its length from the end nearer the door. */
  private redrawWalls(): void {
    const g = this.walls
    g.clear()
    if (this.wallsProgress <= 0) return
    const door = this.doorPoint()
    const walls = [...this.wallList].sort(
      (a, b) =>
        Math.hypot(a.x + a.width / 2 - door.x, a.y + a.height / 2 - door.y) -
        Math.hypot(b.x + b.width / 2 - door.x, b.y + b.height / 2 - door.y)
    )
    const k = walls.length
    const parts: Rect[] = []
    walls.forEach((w, i) => {
      const start = k > 1 ? (i / (k - 1)) * 0.6 : 0
      const f = this.wallsProgress >= 1 ? 1 : clamp01((this.wallsProgress - start) / 0.4)
      if (f <= 0) return
      let r: Rect
      if (w.width >= w.height) {
        const len = w.width * f
        const fromRight = Math.abs(w.x + w.width - door.x) < Math.abs(w.x - door.x)
        r = { x: fromRight ? w.x + w.width - len : w.x, y: w.y, width: len, height: w.height }
      } else {
        const len = w.height * f
        const fromBottom = Math.abs(w.y + w.height - door.y) < Math.abs(w.y - door.y)
        r = { x: w.x, y: fromBottom ? w.y + w.height - len : w.y, width: w.width, height: len }
      }
      g.fillStyle(w.color, w.alpha)
      g.fillRect(r.x, r.y, r.width, r.height)
      parts.push(r)
    })
    // A darker bottom edge gives the walls a little thickness.
    g.fillStyle(0x000000, 0.25)
    for (const r of parts) g.fillRect(r.x, r.y + r.height - 2, r.width, Math.min(2, r.height))
  }

  private doorPoint(): Point {
    const r = this.rect
    const n = this.from
    return { x: r.x + r.width * (0.5 + n.x * 0.5), y: r.y + r.height * (0.5 + n.y * 0.5) }
  }

  /** A picture from the theme's furniture atlas; its pivot sits on the centre of the rectangle. */
  private makeSprite(f: FurnitureRect, depth: number, atlasScale: number): Phaser.GameObjects.Container {
    const img = this.scene.add.image(0, 0, FURNITURE_ATLAS, f.sprite)
    const frame = img.frame
    img.setOrigin(frame.customPivot ? frame.pivotX : 0.5, frame.customPivot ? frame.pivotY : 0.5).setScale(1 / atlasScale)
    return this.scene.add.container(f.x + f.width / 2, f.y + f.height / 2, [img]).setDepth(depth)
  }

  private makeItem(f: FurnitureRect, depth: number): Phaser.GameObjects.Container {
    const g = this.scene.add.graphics()
    const w = f.width
    const h = f.height
    const rad = Math.min(3, w / 2, h / 2)
    // A stand-in block: soft shadow, rounded body, a darker front so it reads as an object.
    g.fillStyle(0x1c2238, 0.1)
    g.fillRoundedRect(-w / 2 + 1, -h / 2 + 2, w + 1, h + 1.5, rad + 1)
    g.fillRoundedRect(-w / 2 + 0.5, -h / 2 + 1, w + 0.5, h + 1, rad)
    g.fillStyle(f.color, f.alpha)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, rad)
    if (w <= 128 && h <= 96 && h >= 12) {
      g.fillStyle(0x000000, 0.12)
      g.fillRoundedRect(-w / 2, h / 2 - 3.5, w, 3.5, { tl: 0, tr: 0, bl: rad, br: rad })
    }
    const parts: Phaser.GameObjects.GameObject[] = [g]
    if (f.label) {
      parts.push(
        this.scene.add
          .text(0, -h / 2 + 3, f.label, { fontFamily: WORLD_FONT, fontSize: '10px', color: '#1d1d1d', resolution: TEXT_RES })
          .setOrigin(0.5, 0)
          .setAlpha(0.55)
      )
    }
    return this.scene.add.container(f.x + w / 2, f.y + h / 2, parts).setDepth(depth)
  }

  private showLot(): void {
    const r = this.rect
    this.lot = this.scene.add.graphics().setDepth(this.depth - 1)
    this.lot.lineStyle(2, WIPE_EDGE, 0.35)
    const dash = 12
    // Dashed site outline.
    for (let x = r.x; x < r.x + r.width; x += dash * 2) {
      const len = Math.min(dash, r.x + r.width - x)
      this.lot.lineBetween(x, r.y, x + len, r.y)
      this.lot.lineBetween(x, r.y + r.height, x + len, r.y + r.height)
    }
    for (let y = r.y; y < r.y + r.height; y += dash * 2) {
      const len = Math.min(dash, r.y + r.height - y)
      this.lot.lineBetween(r.x, y, r.x, y + len)
      this.lot.lineBetween(r.x + r.width, y, r.x + r.width, y + len)
    }
  }

  private hideLot(): void {
    const lot = this.lot
    this.lot = null
    if (lot) this.tween({ targets: lot, alpha: 0, duration: 200 }).then(() => lot.destroy())
  }

  private popItems(total: number, door: Point | null): Promise<void> {
    const from = door ?? this.doorPoint()
    const items = [...this.items].sort(
      (a, b) =>
        Math.hypot(a.obj.x - from.x, a.obj.y - from.y) - Math.hypot(b.obj.x - from.x, b.obj.y - from.y)
    )
    const n = items.length
    const pop = Math.min(ITEM_POP_MS, total * 0.6)
    return Promise.all(
      items.map((it, i) => {
        it.obj.setVisible(true).setScale(0)
        return this.tween({
          targets: it.obj,
          scale: 1,
          duration: pop,
          delay: n > 1 ? (i / (n - 1)) * Math.max(0, total - pop) : 0,
          ease: 'Back.easeOut'
        })
      })
    ).then(() => undefined)
  }

  private dropSign(ms: number): Promise<void> {
    this.sign.setY(this.signY - SIGN_DROP_PX).setAlpha(0)
    return this.tween({ targets: this.sign, y: this.signY, alpha: 1, duration: ms, ease: 'Bounce.easeOut' })
  }

  // ---- promise helpers -------------------------------------------------------------------------

  private tween(cfg: Phaser.Types.Tweens.TweenBuilderConfig): Promise<void> {
    return new Promise((resolve) => {
      if (!cfg.duration || (cfg.duration as number) <= 0) cfg.duration = 1
      this.scene.tweens.add({ ...cfg, onComplete: () => resolve() })
    })
  }

  private counter(ms: number, ease: string, onUpdate: (v: number) => void): Promise<void> {
    return new Promise((resolve) => {
      this.scene.tweens.addCounter({
        from: 0,
        to: 1,
        duration: Math.max(1, ms),
        ease,
        onUpdate: (tw) => onUpdate(tw.getValue() ?? 0),
        onComplete: () => {
          onUpdate(1)
          resolve()
        }
      })
    })
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.scene.time.delayedCall(Math.max(0, ms), () => resolve()))
  }
}
