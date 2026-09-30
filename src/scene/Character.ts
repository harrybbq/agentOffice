// A character on screen with its own action queue: walk (A* path) -> dwell (>= 1200 ms) -> next.
import Phaser from 'phaser'
import type { Point } from './roster'
import { compactQueue, MIN_DWELL_MS } from './queue'
import type { QueueItem } from './queue'
import { animKey, propKey } from './charTextures'
import type { PropKind, Skin } from './charTextures'

export const WALK_SPEED = 140 // px per second
const BUBBLE_CHARS = 28
const WALK_FRAME_MS = 150
const WORK_FRAME_MS = 400

export type ActionKind = 'spawn' | 'activity' | 'waiting' | 'done' | 'handoff' | 'return' | 'leave' | 'home'

export interface Action extends QueueItem {
  kind: ActionKind
  /** Resolved when the action starts (so seats/occupancy are current). null = stay put. */
  target: (from: Point) => Point | null
  verb?: string
  detail?: string
  /** Animation to play while dwelling (theme ActivityDef.anim). */
  anim?: string
  carry?: PropKind | null
  /** Stay after the minimum dwell until releaseStay() is called (waiting). */
  stay?: boolean
  dwellMs?: number
  onArrive?: () => void
  onDone?: () => void
}

type Phase = 'idle' | 'walking' | 'dwelling' | 'staying' | 'gone'

export interface CharacterOptions {
  id: string
  name: string
  skin: Skin
  tint: number
  x: number
  y: number
  /** Called whenever the queue runs dry. */
  onIdle?: (c: Character) => void
  /** Waypoints from -> to (excluding from), [] if already there, null if unreachable. */
  findPath: (from: Point, to: Point) => Point[] | null
}

export function truncate(s: string, n = BUBBLE_CHARS): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

export class Character {
  readonly id: string
  readonly container: Phaser.GameObjects.Container
  /** Set by the scene when the current target is the character's home. */
  atHome = false

  private scene: Phaser.Scene
  private skin: Skin
  private body: Phaser.GameObjects.Sprite
  private overlay: Phaser.GameObjects.Sprite | null
  private prop: Phaser.GameObjects.Image
  private label: Phaser.GameObjects.Text
  private bubble: Phaser.GameObjects.Text
  private badge: Phaser.GameObjects.Text
  private queue: Action[] = []
  private current: Action | null = null
  private phase: Phase = 'idle'
  private anim = 'idle'
  private frame = 0
  private frameClock = 0
  private tween: Phaser.Tweens.Tween | null = null
  private timer: Phaser.Time.TimerEvent | null = null
  private onIdle?: (c: Character) => void
  private findPath: (from: Point, to: Point) => Point[] | null
  /** Final destination of the current walk, for re-pathing when the world changes. */
  private dest: Point | null = null
  private walkDone: (() => void) | null = null

  constructor(scene: Phaser.Scene, o: CharacterOptions) {
    this.scene = scene
    this.id = o.id
    this.skin = o.skin
    this.onIdle = o.onIdle
    this.findPath = o.findPath
    const h = o.skin.height

    const shadow = scene.add.image(0, 0, o.skin.shadow).setOrigin(0.5, 1)
    if (o.skin.kind === 'placeholder') {
      this.body = scene.add.sprite(0, 0, o.skin.body[0]).setOrigin(0.5, 1)
      this.overlay = scene.add.sprite(0, 0, o.skin.overlay[0]).setOrigin(0.5, 1)
    } else {
      this.body = scene.add.sprite(0, 0, o.skin.body, 0).setOrigin(0.5, 1)
      this.overlay = o.skin.overlay ? scene.add.sprite(0, 0, o.skin.overlay, 0).setOrigin(0.5, 1) : null
    }
    this.body.setTint(o.tint)
    this.prop = scene.add.image(Math.round(h * 0.3), -Math.round(h * 0.34), propKey('handoff')).setVisible(false)

    this.label = scene.add
      .text(0, -h - 1, o.name, {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#ffffff',
        stroke: '#1e1e24',
        strokeThickness: 3,
        resolution: 2
      })
      .setOrigin(0.5, 1)
    this.bubble = scene.add
      .text(0, -h - 13, '', {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#1e1e24',
        backgroundColor: '#fffdf5',
        padding: { x: 3, y: 1 },
        resolution: 2
      })
      .setOrigin(0.5, 1)
      .setVisible(false)
    this.badge = scene.add
      .text(Math.round(h * 0.45), -h + 2, '', {
        fontFamily: 'monospace',
        fontSize: '9px',
        fontStyle: 'bold',
        color: '#ffffff',
        backgroundColor: '#d32f2f',
        padding: { x: 3, y: 1 },
        resolution: 2
      })
      .setOrigin(0.5, 1)
      .setVisible(false)

    const parts: Phaser.GameObjects.GameObject[] = [shadow, this.body]
    if (this.overlay) parts.push(this.overlay)
    parts.push(this.prop, this.label, this.bubble, this.badge)
    this.container = scene.add.container(o.x, o.y, parts)
    this.container.setDepth(o.y)
    this.setAnim('idle')
  }

  get position(): Point {
    return { x: this.container.x, y: this.container.y }
  }

  get isIdle(): boolean {
    return this.phase === 'idle' && this.queue.length === 0
  }

  get isStaying(): boolean {
    return this.phase === 'staying'
  }

  get queueLength(): number {
    return this.queue.length
  }

  setName(name: string): void {
    this.label.setText(name)
  }

  setTint(tint: number): void {
    this.body.setTint(tint)
  }

  setBadge(n: number): void {
    this.badge.setText(String(n)).setVisible(n > 0)
  }

  /** Updates the bubble text of a current waiting/stay action (e.g. a new question). */
  setDetail(detail: string): void {
    if (!this.current) return
    this.current.detail = detail
    if (this.phase === 'dwelling' || this.phase === 'staying') this.showBubble(this.current)
  }

  enqueue(a: Action): void {
    if (this.phase === 'gone') return
    this.queue.push(a)
    this.queue = compactQueue(this.queue)
    if (this.phase === 'idle') this.next()
  }

  /** Ends any waiting: the current stay finishes (respecting the min dwell), queued ones don't stay. */
  releaseStay(): void {
    for (const a of this.queue) a.stay = false
    if (this.current) this.current.stay = false
    if (this.phase === 'staying') this.finish()
  }

  /** Drops everything queued (not the current action) - used when leaving. */
  clearQueue(): void {
    this.queue = []
  }

  /** Abandons the current action immediately (after a stay, or to leave). */
  interrupt(): void {
    this.tween?.stop()
    this.timer?.remove(false)
    this.tween = null
    this.timer = null
    this.dest = null
    this.walkDone = null
    this.current = null
    this.phase = 'idle'
    this.hideBubble()
  }

  tick(deltaMs: number): void {
    if (this.phase === 'gone') return
    const period = this.anim === 'walk' || this.anim === 'carry' ? WALK_FRAME_MS : this.anim === 'work' ? WORK_FRAME_MS : 0
    if (this.skin.kind !== 'placeholder') return
    if (period === 0) {
      if (this.frame !== 0) this.setFrame(0)
      return
    }
    this.frameClock += deltaMs
    if (this.frameClock >= period) {
      this.frameClock = 0
      this.setFrame(this.frame ^ 1)
    }
  }

  destroy(): void {
    this.phase = 'gone'
    this.tween?.stop()
    this.timer?.remove(false)
    this.queue = []
    this.container.destroy()
  }

  fadeOutAndDestroy(onDone: () => void): void {
    this.phase = 'gone'
    this.hideBubble()
    this.scene.tweens.add({
      targets: this.container,
      alpha: 0,
      duration: 350,
      onComplete: () => {
        this.container.destroy()
        onDone()
      }
    })
  }

  // ---- internals -------------------------------------------------------------------------

  private next(): void {
    const a = this.queue.shift()
    if (!a) {
      this.current = null
      this.phase = 'idle'
      this.setAnim('idle')
      this.onIdle?.(this)
      return
    }
    this.current = a
    this.hideBubble()
    this.setCarry(a.carry ?? null)
    const to = a.target(this.position)
    const path = to ? this.route(to) : []
    this.phase = 'walking'
    this.dest = to && path.length > 0 ? to : null
    this.setAnim(path.length > 0 ? (a.carry ? 'carry' : 'walk') : 'idle')
    this.walk(path, () => this.arrive(a))
  }

  /** Path to `to`, or [] (stay put) with a warning when there is none. Never teleports. */
  private route(to: Point): Point[] {
    const path = this.findPath(this.position, to)
    if (path) return path
    console.warn(
      `[agent-office] no path for ${this.id} from (${Math.round(this.container.x)},${Math.round(this.container.y)}) ` +
        `to (${Math.round(to.x)},${Math.round(to.y)}); staying put`
    )
    return []
  }

  /** True while waiting in place (stay) or walking somewhere: relocate() will work. */
  get canRelocate(): boolean {
    return this.phase === 'staying' || (this.phase === 'walking' && this.dest !== null && this.walkDone !== null)
  }

  /** Moves a staying (or walking) character to a new spot without ending its action. */
  relocate(to: Point): boolean {
    const a = this.current
    if (!a || !this.canRelocate) return false
    if (this.phase === 'walking') {
      this.dest = to
      this.repath()
      return true
    }
    const path = this.route(to)
    this.phase = 'walking'
    this.hideBubble()
    this.dest = path.length > 0 ? to : null
    this.setAnim(path.length > 0 ? (a.carry ? 'carry' : 'walk') : 'idle')
    this.walk(path, () => {
      if (this.phase === 'gone' || this.current !== a) return
      this.container.setDepth(this.container.y)
      this.setAnim(a.anim ?? 'idle')
      this.showBubble(a)
      if (a.stay) this.phase = 'staying'
      else this.finish()
    })
    return true
  }

  /** The world changed (a branch appeared/vanished): re-plan the current walk from here. */
  repath(): void {
    if (this.phase !== 'walking' || !this.dest || !this.walkDone) return
    const done = this.walkDone
    this.tween?.stop()
    this.tween = null
    const path = this.route(this.dest)
    if (path.length === 0) this.setAnim('idle')
    this.walk(path, done)
  }

  private walk(path: Point[], done: () => void): void {
    this.walkDone = done
    const seg = path.shift()
    if (!seg) {
      this.walkDone = null
      this.dest = null
      done()
      return
    }
    const d = Math.hypot(seg.x - this.container.x, seg.y - this.container.y)
    this.tween = this.scene.tweens.add({
      targets: this.container,
      x: seg.x,
      y: seg.y,
      duration: Math.max(1, (d / WALK_SPEED) * 1000),
      ease: 'Linear',
      onUpdate: () => this.container.setDepth(this.container.y),
      onComplete: () => {
        this.tween = null
        this.walk(path, done)
      }
    })
  }

  private arrive(a: Action): void {
    if (this.phase === 'gone') return
    this.container.setDepth(this.container.y)
    a.onArrive?.()
    if (a.kind === 'leave') return // scene despawns us
    this.phase = 'dwelling'
    this.setAnim(a.anim ?? 'idle')
    this.showBubble(a)
    const ms = Math.max(MIN_DWELL_MS, a.dwellMs ?? 0)
    this.timer = this.scene.time.delayedCall(ms, () => {
      this.timer = null
      if (a.stay) this.phase = 'staying'
      else this.finish()
    })
  }

  private finish(): void {
    const a = this.current
    this.current = null
    this.hideBubble()
    a?.onDone?.()
    if (this.phase === 'gone') return
    this.setCarry(null)
    this.next()
  }

  private showBubble(a: Action): void {
    const text = [a.verb ?? '', truncate(a.detail ?? '')].filter((s) => s.length > 0).join(' ')
    this.bubble.setText(text).setVisible(text.length > 0)
  }

  private hideBubble(): void {
    this.bubble.setVisible(false)
  }

  private setCarry(kind: PropKind | null): void {
    if (kind) this.prop.setTexture(propKey(kind)).setVisible(true)
    else this.prop.setVisible(false)
  }

  private setAnim(name: string): void {
    this.anim = name
    this.frameClock = 0
    if (this.skin.kind === 'placeholder') {
      this.setFrame(0)
      return
    }
    const skin = this.skin
    const pick = skin.anims.has(name) ? name : name === 'carry' && skin.anims.has('walk') ? 'walk' : 'idle'
    if (!skin.anims.has(pick)) return
    this.body.play(animKey(skin.body, pick), true)
    if (this.overlay && skin.overlay) this.overlay.play(animKey(skin.overlay, pick), true)
  }

  private setFrame(f: number): void {
    if (this.skin.kind !== 'placeholder') return
    this.frame = f
    this.body.setTexture(this.skin.body[f])
    this.overlay?.setTexture(this.skin.overlay[f])
  }
}
