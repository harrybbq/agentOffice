// A character on screen with its own action queue: walk (A* path) -> dwell (>= 1200 ms) -> next.
import Phaser from 'phaser'
import type { Point } from './roster'
import { compactQueue, MIN_DWELL_MS } from './queue'
import type { QueueItem } from './queue'
import { animKey, CHAR_ORIGIN_Y, PROP_SCALE, propKey, RES, SEAT_DROP, TEXT_RES, WORLD_FONT } from './charTextures'
import type { BodyFrame, PropKind, Skin } from './charTextures'

export const WALK_SPEED = 140 // px per second
const BUBBLE_CHARS = 28
/** One step (a foot change and one bounce). */
const WALK_FRAME_MS = 210
const WORK_FRAME_MS = 400
const TYPE_FRAME_MS = 240
/** Bounce of a step and the slow rise of breathing, map px. */
const WALK_BOB = 1.5
const IDLE_BOB = 0.7
const IDLE_BOB_MS = 2600
/** A character on a seat facing the viewer sits this much closer to its desk (map px). */
const SEAT_PULL = 5
const BUBBLE_PAD_X = 4
const BUBBLE_PAD_Y = 1.5

/** 'north': seated facing away from the viewer; 'south': facing the viewer. */
export type SeatFacing = 'north' | 'south'

/** The procedural character's poses: body frames (two alternate), which side of the head shows. */
const POSES: Record<string, { frames: readonly [BodyFrame, BodyFrame]; back: boolean; seated: boolean; ms: number }> = {
  idle: { frames: ['stand', 'stand'], back: false, seated: false, ms: 0 },
  walk: { frames: ['walkA', 'walkB'], back: false, seated: false, ms: WALK_FRAME_MS },
  carry: { frames: ['carryA', 'carryB'], back: false, seated: false, ms: WALK_FRAME_MS },
  work: { frames: ['workA', 'workB'], back: false, seated: false, ms: WORK_FRAME_MS },
  sit: { frames: ['sitFront', 'sitFront'], back: false, seated: true, ms: 0 },
  type: { frames: ['typeFrontA', 'typeFrontB'], back: false, seated: true, ms: TYPE_FRAME_MS },
  sit_back: { frames: ['sitBack', 'sitBack'], back: true, seated: true, ms: 0 },
  type_back: { frames: ['typeBackA', 'typeBackB'], back: true, seated: true, ms: TYPE_FRAME_MS }
}

/** The pose for an animation on a seat (or not on one). */
export function poseName(anim: string, seat: SeatFacing | null): string {
  if (seat && (anim === 'idle' || anim === 'work')) return (anim === 'work' ? 'type' : 'sit') + (seat === 'north' ? '_back' : '')
  return anim
}

export type ActionKind = 'spawn' | 'activity' | 'waiting' | 'relay' | 'done' | 'handoff' | 'return' | 'leave' | 'home' | 'rest'

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
  /** Team colour pin, for sprite-sheet skins (placeholders bake a collar instead). */
  teamColor?: number
  /** Is this spot a seat (a map location with `seat`)? Asked whenever the character stops. */
  seatAt?: (p: Point) => SeatFacing | null
}

/** None, pointed at, or the one the inspector shows. */
export type Highlight = 'none' | 'hover' | 'selected'

const RING_SELECTED = 0x7c8cff
const RING_DARK = 0x14151c

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
  /** The pose shown (an entry of POSES, or the sheet animation playing). */
  private pose = 'idle'
  private frame = 0
  private frameClock = 0
  /** Runs on for the bob; starts at a per-character offset so a room doesn't breathe in step. */
  private bobClock: number
  private seatAt?: (p: Point) => SeatFacing | null
  private shadow: Phaser.GameObjects.Image
  private propY = 0
  private tween: Phaser.Tweens.Tween | null = null
  private timer: Phaser.Time.TimerEvent | null = null
  private onIdle?: (c: Character) => void
  private findPath: (from: Point, to: Point) => Point[] | null
  /** Final destination of the current walk, for re-pathing when the world changes. */
  private dest: Point | null = null
  private walkDone: (() => void) | null = null
  private sayTimer: Phaser.Time.TimerEvent | null = null
  /** Ring on the floor under the character (hover / selection). */
  private ring: Phaser.GameObjects.Graphics
  private highlight: Highlight = 'none'
  private labelBg: Phaser.GameObjects.Graphics
  private bubbleBg: Phaser.GameObjects.Graphics
  private ringTween: Phaser.Tweens.Tween | null = null

  constructor(scene: Phaser.Scene, o: CharacterOptions) {
    this.scene = scene
    this.id = o.id
    this.skin = o.skin
    this.onIdle = o.onIdle
    this.findPath = o.findPath
    this.seatAt = o.seatAt
    let hash = 0
    for (let i = 0; i < o.id.length; i++) hash = (hash * 31 + o.id.charCodeAt(i)) | 0
    this.bobClock = Math.abs(hash) % IDLE_BOB_MS
    const h = o.skin.height

    this.ring = scene.add.graphics().setVisible(false)
    const shadow = scene.add.image(0, -1, o.skin.shadow).setOrigin(0.5, 0.5)
    shadow.setScale(o.skin.kind === 'placeholder' ? o.skin.scale : o.skin.shadowScale)
    this.shadow = shadow
    if (o.skin.kind === 'placeholder') {
      this.body = scene.add.sprite(0, 0, o.skin.body, 'stand').setOrigin(0.5, CHAR_ORIGIN_Y).setScale(o.skin.scale)
      this.overlay = scene.add.sprite(0, 0, o.skin.overlay, 'front').setOrigin(0.5, CHAR_ORIGIN_Y).setScale(o.skin.scale)
    } else {
      this.body = scene.add.sprite(0, 0, o.skin.body, 0).setOrigin(0.5, 1)
      this.overlay = o.skin.overlay ? scene.add.sprite(0, 0, o.skin.overlay, 0).setOrigin(0.5, 1) : null
    }
    this.body.setTint(o.tint)
    const pin =
      o.skin.kind === 'sheet' && o.teamColor !== undefined
        ? scene.add.circle(Math.round(h * -0.18), -Math.round(h * 0.38), 2.5, o.teamColor).setStrokeStyle(1, 0x1e1e24)
        : null
    // Held in both hands in front of the body (at the side on a sprite sheet, which has no such pose).
    const held = o.skin.kind === 'placeholder'
    this.prop = scene.add
      .image(held ? h * 0.05 : Math.round(h * 0.3), -Math.round(h * (held ? 0.29 : 0.34)), propKey('handoff'))
      .setScale(o.skin.kind === 'placeholder' ? o.skin.scale : PROP_SCALE)
      .setVisible(false)
    this.propY = this.prop.y

    // Name: white on a small dark pill. Speech: dark on a white rounded bubble with a tail.
    this.labelBg = scene.add.graphics()
    this.label = scene.add
      .text(0, -h - 3, o.name, { fontFamily: WORLD_FONT, fontSize: '9px', fontStyle: '600', color: '#ffffff', resolution: TEXT_RES })
      .setOrigin(0.5, 1)
    this.bubbleBg = scene.add.graphics().setVisible(false)
    this.bubble = scene.add
      .text(0, -h - 19, '', { fontFamily: WORLD_FONT, fontSize: '9px', color: '#2b2f3a', resolution: TEXT_RES })
      .setOrigin(0.5, 1)
      .setVisible(false)
    this.drawLabel()
    this.badge = scene.add
      .text(Math.round(h * 0.45), -h + 2, '', {
        fontFamily: WORLD_FONT,
        fontSize: '9px',
        fontStyle: 'bold',
        color: '#ffffff',
        backgroundColor: '#d32f2f',
        padding: { x: 3, y: 1 },
        resolution: TEXT_RES
      })
      .setOrigin(0.5, 1)
      .setVisible(false)

    const parts: Phaser.GameObjects.GameObject[] = [this.ring, shadow, this.body]
    if (this.overlay) parts.push(this.overlay)
    if (pin) parts.push(pin)
    parts.push(this.prop, this.labelBg, this.label, this.bubbleBg, this.bubble, this.badge)
    this.container = scene.add.container(o.x, o.y, parts)
    this.container.setDepth(o.y)
    this.setAnim('idle')
  }

  get position(): Point {
    return { x: this.container.x, y: this.container.y }
  }

  /** Drawn height in world px (for hit-testing and for placing things above the head). */
  get height(): number {
    return this.skin.height
  }

  /** World rect of the speech bubble while it shows (station tags make way for it), else null. */
  get bubbleBounds(): { x: number; y: number; width: number; height: number } | null {
    if (this.phase === 'gone' || !this.bubble.visible) return null
    const w = this.bubble.width + BUBBLE_PAD_X * 2
    const h = this.bubble.height + BUBBLE_PAD_Y * 2
    return { x: this.container.x + this.bubble.x - w / 2, y: this.container.y + this.bubble.y - h + BUBBLE_PAD_Y, width: w, height: h }
  }

  /** Standing somewhere (not on its way). */
  get isSettled(): boolean {
    return this.phase === 'idle' || this.phase === 'dwelling' || this.phase === 'staying'
  }

  /** A ring on the floor: thin while pointed at, the accent colour while selected. It follows the character. */
  setHighlight(mode: Highlight): void {
    if (mode === this.highlight || this.phase === 'gone') return
    this.highlight = mode
    const g = this.ring
    this.ringTween?.stop()
    this.ringTween = null
    g.clear().setAlpha(1).setScale(1)
    if (mode === 'none') {
      g.setVisible(false)
      return
    }
    const h = this.skin.height
    const rx = Math.max(9, h * 0.46)
    const ry = Math.max(4.5, h * 0.2)
    const cy = -2
    if (mode === 'selected') {
      g.fillStyle(RING_SELECTED, 0.22)
      g.fillEllipse(0, cy, rx * 2, ry * 2)
      g.lineStyle(3.5, RING_DARK, 0.55)
      g.strokeEllipse(0, cy, rx * 2, ry * 2)
      g.lineStyle(2, RING_SELECTED, 1)
      g.strokeEllipse(0, cy, rx * 2, ry * 2)
      this.ringTween = this.scene.tweens.add({ targets: g, scale: 1.12, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    } else {
      g.lineStyle(3, RING_DARK, 0.4)
      g.strokeEllipse(0, cy, rx * 2, ry * 2)
      g.lineStyle(1.5, 0xffffff, 0.95)
      g.strokeEllipse(0, cy, rx * 2, ry * 2)
    }
    g.setVisible(true)
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
    this.drawLabel()
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

  /** Runs `a` right after the current action (ahead of everything queued). */
  enqueueFront(a: Action): void {
    if (this.phase === 'gone') return
    this.queue.unshift(a)
    if (this.phase === 'idle') this.next()
  }

  /** Removes queued (not current) actions matching `pred` and returns them, oldest first. */
  dropQueued(pred: (a: Action) => boolean): Action[] {
    const out = this.queue.filter(pred)
    this.queue = this.queue.filter((a) => !pred(a))
    return out
  }

  /** The action being carried out, if any. */
  get currentAction(): Action | null {
    return this.current
  }

  /** A short speech bubble that doesn't touch the queue (CEO speaking, an order arriving). */
  say(text: string, ms = 3500, chars = 48): void {
    if (this.phase === 'gone') return
    this.sayTimer?.remove(false)
    this.setBubble(truncate(text, chars))
    this.sayTimer = this.scene.time.delayedCall(ms, () => {
      this.sayTimer = null
      if (this.phase === 'gone') return
      if (this.current && (this.phase === 'dwelling' || this.phase === 'staying')) this.showBubble(this.current)
      else this.hideBubble()
    })
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
    if (this.skin.kind !== 'placeholder') return
    const pose = POSES[this.pose] ?? POSES.idle
    this.bobClock += deltaMs
    if (pose.ms > 0) {
      this.frameClock += deltaMs
      if (this.frameClock >= pose.ms) {
        this.frameClock -= pose.ms
        if (this.frameClock >= pose.ms) this.frameClock = 0
        this.setFrame(this.frame ^ 1)
      }
    }
    // Walking: one soft bounce per step, the whole figure. Otherwise: breathing, mostly the head.
    const s = this.skin.scale * RES
    const walking = this.pose === 'walk' || this.pose === 'carry'
    const up = walking
      ? Math.sin((this.frameClock / pose.ms) * Math.PI) * WALK_BOB
      : (0.5 + 0.5 * Math.sin((this.bobClock / IDLE_BOB_MS) * Math.PI * 2)) * IDLE_BOB * (pose.seated ? 0.6 : 1)
    const base = pose.seated && !pose.back ? SEAT_PULL : 0
    this.body.y = base - (walking ? up : up * 0.35) * s
    if (this.overlay) this.overlay.y = base + ((pose.seated ? SEAT_DROP : 0) - up) * s
    this.shadow.y = base - 1
    if (this.prop.visible) this.prop.y = this.propY - up * s
  }

  destroy(): void {
    this.phase = 'gone'
    this.ringTween?.stop()
    this.sayTimer?.remove(false)
    this.tween?.stop()
    this.timer?.remove(false)
    this.queue = []
    this.container.destroy()
  }

  fadeOutAndDestroy(onDone: () => void): void {
    this.phase = 'gone'
    this.ringTween?.stop()
    this.ringTween = null
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
    this.setBubble(text)
  }

  private hideBubble(): void {
    this.bubble.setVisible(false)
    this.bubbleBg.setVisible(false)
  }

  private setBubble(text: string): void {
    const on = text.length > 0
    this.bubble.setText(text).setVisible(on)
    const g = this.bubbleBg.setVisible(on)
    g.clear()
    if (!on) return
    const w = this.bubble.width + BUBBLE_PAD_X * 2
    const h = this.bubble.height + BUBBLE_PAD_Y * 2
    const x = -w / 2
    const y = this.bubble.y - this.bubble.height - BUBBLE_PAD_Y
    g.fillStyle(0x1c2238, 0.14)
    g.fillRoundedRect(x + 0.5, y + 1.2, w, h, 4)
    g.fillStyle(0xffffff, 1)
    g.fillRoundedRect(x, y, w, h, 4)
    g.fillTriangle(-2.6, y + h - 0.2, 2.6, y + h - 0.2, 0, y + h + 2.8)
  }

  private drawLabel(): void {
    const g = this.labelBg
    g.clear()
    const w = this.label.width + 7
    const h = this.label.height + 1
    g.fillStyle(0x1b1e2c, 0.66)
    g.fillRoundedRect(-w / 2, this.label.y - this.label.height - 0.5, w, h, h / 2)
  }

  private setCarry(kind: PropKind | null): void {
    if (kind) this.prop.setTexture(propKey(kind)).setVisible(true)
    else this.prop.setVisible(false)
  }

  private setAnim(name: string): void {
    this.anim = name
    this.frameClock = 0
    // Sitting is a matter of where the character has stopped, not of the activity.
    const seat = name === 'idle' || name === 'work' ? (this.seatAt?.(this.position) ?? null) : null
    const pose = poseName(name, seat)
    if (this.skin.kind === 'placeholder') {
      this.pose = POSES[pose] ? pose : 'idle'
      this.overlay?.setFrame(POSES[this.pose].back ? 'back' : 'front')
      this.setFrame(0)
      this.tick(0)
      return
    }
    const skin = this.skin
    // type_back -> type -> work -> idle; sit_back -> sit -> idle; carry -> walk -> idle.
    const chain = [pose, pose.replace('_back', ''), name, name === 'carry' ? 'walk' : 'idle', 'idle']
    const pick = chain.find((n) => skin.anims.has(n))
    if (!pick) return
    this.pose = pick
    this.body.play(animKey(skin.body, pick), true)
    if (this.overlay && skin.overlay) this.overlay.play(animKey(skin.overlay, pick), true)
  }

  private setFrame(f: number): void {
    if (this.skin.kind !== 'placeholder') return
    this.frame = f
    this.body.setFrame((POSES[this.pose] ?? POSES.idle).frames[f])
  }
}
