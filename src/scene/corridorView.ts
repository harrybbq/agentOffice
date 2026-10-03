// Draws the corridor network from the set of laid cells: floor strips with skirting lines along
// their open sides, a construction marker at the head of a corridor being laid, and door pulses.
import Phaser from 'phaser'
import type { Rect } from '../theme/loader'
import type { Cell, CorridorNetwork } from '../world/corridors'

export interface CorridorStyle {
  floor: number
  edge: number
  /** Lines between floor tiles (default: black at 6%). */
  seam?: number
}

const SUB = 16 // sub-cell size for edge detection (= nav cell)
const EDGE_PX = 3
const HEAD_COLOR = 0xffd166
const PULSE_COLOR = 0xffe08a

export class CorridorView {
  private scene: Phaser.Scene
  private net: CorridorNetwork
  private style: CorridorStyle
  private g: Phaser.GameObjects.Graphics
  private head: Phaser.GameObjects.Rectangle
  private laid = new Map<number, Cell>()
  private builtBlocks: Rect[] = []
  private depth: number

  constructor(scene: Phaser.Scene, net: CorridorNetwork, style: CorridorStyle, depth: number) {
    this.scene = scene
    this.net = net
    this.style = style
    this.depth = depth
    this.g = scene.add.graphics().setDepth(depth)
    const size = net.half * 2
    this.head = scene.add.rectangle(0, 0, size, size, HEAD_COLOR, 0.45).setDepth(depth + 1).setVisible(false)
  }

  has(c: Cell): boolean {
    return this.laid.has(this.net.key(c))
  }

  /** Adds a cell; returns false if it was already laid. */
  add(c: Cell): boolean {
    const k = this.net.key(c)
    if (this.laid.has(k)) return false
    this.laid.set(k, c)
    return true
  }

  remove(c: Cell): boolean {
    return this.laid.delete(this.net.key(c))
  }

  /** Built block rects: no skirting is drawn where a corridor meets one (its doors). */
  setBuiltBlocks(rects: Rect[]): void {
    this.builtBlocks = rects
  }

  setHead(c: Cell | null): void {
    if (!c) {
      this.head.setVisible(false)
      return
    }
    const p = this.net.cellCenter(c)
    this.head.setPosition(p.x, p.y).setVisible(true)
  }

  /** Two expanding rings on a door's corridor square. */
  pulse(c: Cell, ms: number): Promise<void> {
    const r = this.net.cellRect(c)
    const ring = this.scene.add
      .rectangle(r.x + r.width / 2, r.y + r.height / 2, r.width, r.height)
      .setStrokeStyle(3, PULSE_COLOR, 1)
      .setFillStyle(PULSE_COLOR, 0.25)
      .setDepth(this.depth + 2)
    return new Promise((resolve) => {
      this.scene.tweens.add({
        targets: ring,
        scale: { from: 0.7, to: 1.35 },
        alpha: { from: 1, to: 0 },
        duration: Math.max(1, ms / 2),
        repeat: 1,
        ease: 'Sine.easeOut',
        onComplete: () => {
          ring.destroy()
          resolve()
        }
      })
    })
  }

  redraw(): void {
    const g = this.g
    g.clear()
    if (this.laid.size === 0) return
    const subs = new Set<number>()
    const key = (x: number, y: number) => x * 65536 + y
    g.fillStyle(this.style.floor, 1)
    for (const c of this.laid.values()) {
      const r = this.net.cellRect(c)
      g.fillRect(r.x, r.y, r.width, r.height)
      const x0 = Math.round(r.x / SUB)
      const y0 = Math.round(r.y / SUB)
      const n = Math.round(r.width / SUB)
      for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) subs.add(key(x, y))
    }
    // Faint seams every tile so the floor reads as a laid hallway.
    if (this.style.seam !== undefined) g.fillStyle(this.style.seam, 1)
    else g.fillStyle(0x000000, 0.06)
    for (const k of subs) {
      const x = Math.floor(k / 65536)
      const y = k % 65536
      if (x % 2 === 0) g.fillRect(x * SUB, y * SUB, 1, SUB)
      if (y % 2 === 0) g.fillRect(x * SUB, y * SUB, SUB, 1)
    }
    // Skirting on sides that face the outside (not other corridor, not a built block).
    const inBlock = (x: number, y: number) => {
      const px = (x + 0.5) * SUB
      const py = (y + 0.5) * SUB
      return this.builtBlocks.some((r) => px > r.x && px < r.x + r.width && py > r.y && py < r.y + r.height)
    }
    const open = (x: number, y: number) => !subs.has(key(x, y)) && !inBlock(x, y)
    // A low wall: its shadow on the ground outside (down and right), a soft shade on the floor
    // inside, then the wall itself.
    const sides = (draw: (px: number, py: number, side: number) => void) => {
      for (const k of subs) {
        const x = Math.floor(k / 65536)
        const y = k % 65536
        if (open(x, y - 1)) draw(x * SUB, y * SUB, 0)
        if (open(x, y + 1)) draw(x * SUB, y * SUB, 1)
        if (open(x - 1, y)) draw(x * SUB, y * SUB, 2)
        if (open(x + 1, y)) draw(x * SUB, y * SUB, 3)
      }
    }
    g.fillStyle(0x000000, 0.22)
    sides((px, py, side) => {
      if (side === 1) g.fillRect(px + 1, py + SUB, SUB, 3)
      else if (side === 3) g.fillRect(px + SUB, py + 1, 2, SUB)
    })
    g.fillStyle(0x000000, 0.05)
    sides((px, py, side) => {
      if (side === 0) g.fillRect(px, py + EDGE_PX, SUB, 3)
      else if (side === 2) g.fillRect(px + EDGE_PX, py, 2, SUB)
    })
    g.fillStyle(this.style.edge, 1)
    sides((px, py, side) => {
      if (side === 0) g.fillRect(px, py, SUB, EDGE_PX)
      else if (side === 1) g.fillRect(px, py + SUB - EDGE_PX, SUB, EDGE_PX)
      else if (side === 2) g.fillRect(px, py, EDGE_PX, SUB)
      else g.fillRect(px + SUB - EDGE_PX, py, EDGE_PX, SUB)
    })
  }
}
