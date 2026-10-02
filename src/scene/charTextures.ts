// Procedural characters and prop textures, plus optional theme sprite sheets.
//
// The characters are drawn with the 2D canvas at RES times their size on the map, so they stay smooth
// when the camera zooms in: a rounded body with stubby arms and feet (white with grey shading: the
// provider colour is multiplied in with setTint), and on a second, untinted layer the round head, hair,
// face, the team-colour collar and the role's accessory. No legs to animate: walking is two foot
// frames plus a bob the Character adds. Canvases are powers of two so they can be mip-mapped.
import Phaser from 'phaser'
import type { Placeholder, Role, SpriteSheet, ThemeManifest } from '../../shared/theme'
import { cssToInt } from '../theme/loader'
import { HAIR_COLORS, SKIN_TONES } from './teamLook'
import type { HeadLook } from './teamLook'

export type PropKind = 'handoff' | 'report' | 'memo' | 'order'
export const PROP_KINDS: readonly PropKind[] = ['handoff', 'report', 'memo', 'order']

/** Per-character variations of the procedural placeholder (all optional). */
export interface PlaceholderLook {
  /** Distinct head (managers): hairstyle, hair colour, skin tone. Default: from the id hash. */
  head?: HeadLook
  /** Overrides the role's accent (managers: the team colour on the clipboard). */
  accent?: number
  /** Team colour collar (+ chest badge for workers). */
  collar?: number
}

const BASE_W = 24
const BASE_H = 32
/** Text in the world (names, speech bubbles, signs): the shell's sans, not a terminal font. */
export const WORLD_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
/** Texture px per CSS px for that text: it stays sharp when the camera zooms in. */
export const TEXT_RES = 3
/** Texture px per map px for everything drawn here. */
export const RES = 4
/** One character frame in map px: wider and taller than the 24x32 figure, for arms and bobbing. */
const FRAME_W = 32
const FRAME_H = 40
/** Where the feet (the character's position) are in a frame. */
const FOOT_X = 16
const FOOT_Y = 36
export const CHAR_ORIGIN_Y = FOOT_Y / FRAME_H
/** Seated characters are this much lower (map px). */
export const SEAT_DROP = 3
const INK = '#2b2f3a'

/** Skin + hair pairs; a character picks one by hashing its id. */
const TONES = [
  { skin: 0xf1c27d, hair: 0x4a3222 },
  { skin: 0xe0ac69, hair: 0x2b1d14 },
  { skin: 0xc68642, hair: 0x1b1b1b },
  { skin: 0x8d5524, hair: 0x111111 },
  { skin: 0xffdbac, hair: 0xb5651d },
  { skin: 0xd9a066, hair: 0x6b4423 }
]

export function toneIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h) % TONES.length
}

/** Body frames of the procedural character, by name. */
export const BODY_FRAMES = [
  'stand',
  'walkA',
  'walkB',
  'carryA',
  'carryB',
  'workA',
  'workB',
  'sitBack',
  'typeBackA',
  'typeBackB',
  'sitFront',
  'typeFrontA',
  'typeFrontB'
] as const
export type BodyFrame = (typeof BODY_FRAMES)[number]

/** What a Character needs to display itself. */
export type Skin =
  | {
      kind: 'placeholder'
      shadow: string
      /** One texture for every character: frames are BODY_FRAMES. */
      body: string
      /** Per look: frames 'front' and 'back'. */
      overlay: string
      /** Height of the figure on the map, px. */
      height: number
      /** Display scale of the textures (they are drawn RES times larger). */
      scale: number
    }
  | {
      kind: 'sheet'
      shadow: string
      shadowScale: number
      body: string
      overlay: string | null
      /** Animation names available for this sheet. */
      anims: Set<string>
      height: number
    }

export function animKey(sheetKey: string, name: string): string {
  return `${sheetKey}#${name}`
}

function darken(c: number, f = 0.7): number {
  const r = Math.round(((c >> 16) & 0xff) * f)
  const g = Math.round(((c >> 8) & 0xff) * f)
  const b = Math.round((c & 0xff) * f)
  return (r << 16) | (g << 8) | b
}
const css = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`

type Ctx = CanvasRenderingContext2D

/**
 * A canvas texture of `cols` x `rows` cells, each drawn in map px with (0,0) at its top-left corner.
 * Its size is rounded up to powers of two (mip-maps); linear filtering whatever the game's setting.
 */
function bakeSheet(
  scene: Phaser.Scene,
  key: string,
  cellW: number,
  cellH: number,
  names: readonly string[],
  cols: number,
  draw: (ctx: Ctx, name: string) => void
): void {
  if (scene.textures.exists(key)) return
  const pot = (n: number) => {
    let p = 32
    while (p < n) p *= 2
    return p
  }
  const rows = Math.ceil(names.length / cols)
  const tex = scene.textures.createCanvas(key, pot(cols * cellW * RES), pot(rows * cellH * RES))
  if (!tex) return
  const ctx = tex.getContext()
  names.forEach((name, i) => {
    const x = (i % cols) * cellW * RES
    const y = Math.floor(i / cols) * cellH * RES
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, cellW * RES, cellH * RES)
    ctx.clip()
    ctx.translate(x, y)
    ctx.scale(RES, RES)
    draw(ctx, name)
    ctx.restore()
    tex.add(name, 0, x, y, cellW * RES, cellH * RES)
  })
  tex.refresh()
  // Smooth art even in a pixel-art theme (otherwise the game's own filtering, with mip-maps, applies).
  if (scene.game.config.pixelArt) tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2))
}
function fillRound(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string): void {
  roundRect(ctx, x, y, w, h, r)
  ctx.fillStyle = fill
  ctx.fill()
}
function ellipse(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, fill: string): void {
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

const SHADOW_KEY = 'ph:shadow'
/** Soft contact shadow, 32x16 map px, centred. */
function ensureShadow(scene: Phaser.Scene): string {
  bakeSheet(scene, SHADOW_KEY, 32, 16, ['shadow'], 1, (ctx) => {
    ctx.translate(16, 8)
    ctx.scale(1, 0.4)
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 12.5)
    g.addColorStop(0, 'rgba(24,30,52,0.34)')
    g.addColorStop(0.55, 'rgba(24,30,52,0.2)')
    g.addColorStop(1, 'rgba(24,30,52,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, 12.5, 0, Math.PI * 2)
    ctx.fill()
  })
  return SHADOW_KEY
}

// ---- body (white: tinted with the provider colour) -------------------------------------------------

const BODY_RIM = '#c6c6c6'
const LIMB = '#ececec'
const FOOT = '#c2c2c2'

/** The torso: narrow shoulders, a wider rounded bottom. */
function torso(ctx: Ctx, top: number, bottom: number): void {
  const cx = FOOT_X
  const h = bottom - top
  ctx.beginPath()
  ctx.moveTo(cx - 6, top + h * 0.22)
  ctx.quadraticCurveTo(cx - 6, top, cx, top)
  ctx.quadraticCurveTo(cx + 6, top, cx + 6, top + h * 0.22)
  ctx.bezierCurveTo(cx + 7.6, top + h * 0.45, cx + 8.6, top + h * 0.62, cx + 8.2, top + h * 0.8)
  ctx.quadraticCurveTo(cx + 7.6, bottom, cx, bottom)
  ctx.quadraticCurveTo(cx - 7.6, bottom, cx - 8.2, top + h * 0.8)
  ctx.bezierCurveTo(cx - 8.6, top + h * 0.62, cx - 7.6, top + h * 0.45, cx - 6, top + h * 0.22)
  ctx.closePath()
  const g = ctx.createLinearGradient(0, top, 0, bottom)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(0.55, '#f4f4f4')
  g.addColorStop(1, '#d2d2d2')
  ctx.fillStyle = g
  ctx.fill()
  ctx.lineWidth = 0.55
  ctx.strokeStyle = BODY_RIM
  ctx.stroke()
}

/** A stubby arm: a capsule from the shoulder to the hand. */
function arm(ctx: Ctx, x0: number, y0: number, x1: number, y1: number): void {
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.lineWidth = 4.7
  ctx.strokeStyle = BODY_RIM
  ctx.stroke()
  ctx.lineWidth = 3.7
  ctx.strokeStyle = LIMB
  ctx.stroke()
}

function foot(ctx: Ctx, x: number, y: number): void {
  ellipse(ctx, x, y, 2.9, 1.9, BODY_RIM)
  ellipse(ctx, x, y - 0.2, 2.4, 1.5, FOOT)
}

function drawBody(ctx: Ctx, f: BodyFrame): void {
  const L = FOOT_X - 6.3
  const R = FOOT_X + 6.3
  const both = (y0: number, lx: number, ly: number, rx: number, ry: number) => {
    arm(ctx, L, y0, lx, ly)
    arm(ctx, R, y0, rx, ry)
  }
  switch (f) {
    case 'stand':
      foot(ctx, 12.4, 35)
      foot(ctx, 19.6, 35)
      both(23, 7.4, 28.6, 24.6, 28.6)
      torso(ctx, 18.6, 34.6)
      break
    case 'walkA':
    case 'walkB': {
      const a = f === 'walkA'
      foot(ctx, 12.4, a ? 35.6 : 33.8)
      foot(ctx, 19.6, a ? 33.8 : 35.6)
      both(23, a ? 6.9 : 8, a ? 27.6 : 28.9, a ? 24 : 25.1, a ? 28.9 : 27.6)
      torso(ctx, 18.6, 34.6)
      break
    }
    case 'carryA':
    case 'carryB': {
      const a = f === 'carryA'
      foot(ctx, 12.4, a ? 35.6 : 33.8)
      foot(ctx, 19.6, a ? 33.8 : 35.6)
      torso(ctx, 18.6, 34.6)
      both(24.2, 11.6, 28, 20.4, 28) // both hands in front, holding the thing
      break
    }
    case 'workA':
    case 'workB': {
      const a = f === 'workA'
      foot(ctx, 12.4, 35)
      foot(ctx, 19.6, 35)
      both(23, 5.6, a ? 19.6 : 21.6, 26.4, a ? 21.6 : 19.6) // hands up, busy
      torso(ctx, 18.6, 34.6)
      break
    }
    case 'sitBack':
      both(23 + SEAT_DROP, 7.6, 30.4, 24.4, 30.4)
      torso(ctx, 18.6 + SEAT_DROP, 34)
      break
    case 'typeBackA':
    case 'typeBackB': {
      const a = f === 'typeBackA'
      // Seen from behind: elbows out, hands on the keyboard beyond the head.
      both(24 + SEAT_DROP, 7.2, a ? 21.6 : 22.8, 24.8, a ? 22.8 : 21.6)
      torso(ctx, 18.6 + SEAT_DROP, 34)
      break
    }
    case 'sitFront':
    case 'typeFrontA':
    case 'typeFrontB': {
      const dl = f === 'typeFrontA' ? 0.9 : 0
      const dr = f === 'typeFrontB' ? 0.9 : 0
      foot(ctx, 12.6, 35.2)
      foot(ctx, 19.4, 35.2)
      torso(ctx, 18.6 + SEAT_DROP, 34.4)
      both(25 + SEAT_DROP, 10.6, 31.2 + dl, 21.4, 31.2 + dr) // hands forward, towards the desk
      break
    }
  }
}

const BODY_KEY = 'ph:body'
function ensureBody(scene: Phaser.Scene): string {
  bakeSheet(scene, BODY_KEY, FRAME_W, FRAME_H, BODY_FRAMES, 8, (ctx, name) => drawBody(ctx, name as BodyFrame))
  return BODY_KEY
}

// ---- head, hair, collar, accessory (untinted) ------------------------------------------------------

const HEAD_X = FOOT_X
const HEAD_Y = 12.2
const HEAD_R = 7.2

function drawOverlay(ctx: Ctx, back: boolean, ph: Placeholder, tone: number, look: PlaceholderLook, role: Role): void {
  const base = TONES[tone % TONES.length]
  const skin = look.head ? SKIN_TONES[look.head.skin % SKIN_TONES.length] : base.skin
  const hairN = look.head ? HAIR_COLORS[look.head.hair % HAIR_COLORS.length] : base.hair
  const hair = css(hairN)
  const hairDark = css(darken(hairN, 0.78))
  const accentN = look.accent ?? cssToInt(ph.accent, 0xffffff)
  const accent = css(accentN)
  const accentDark = css(darken(accentN, 0.78))
  const cx = HEAD_X

  // Shade under the chin (over the collar it would dull the colour, so it comes first).
  ellipse(ctx, cx, 20, 5.6, 1.9, 'rgba(20,24,40,0.16)')

  // Team collar, and for workers a chest badge.
  if (look.collar !== undefined) {
    fillRound(ctx, cx - 5.9, 19.2, 11.8, 3.1, 1.55, css(darken(look.collar, 0.8)))
    fillRound(ctx, cx - 5.9, 19.2, 11.8, 2.4, 1.2, css(look.collar))
    if (role === 'worker' && !back) {
      fillRound(ctx, cx - 5.2, 24.6, 3.6, 3.6, 1, css(darken(look.collar, 0.8)))
      fillRound(ctx, cx - 5.2, 24.4, 3.6, 3.3, 1, css(look.collar))
    }
  }

  // Accessories worn on the body go under the head. From behind only the baton shows.
  if (!back) {
    switch (ph.accessory) {
      case 'tie':
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.moveTo(cx - 3.6, 19.4)
        ctx.lineTo(cx + 3.6, 19.4)
        ctx.lineTo(cx, 23.4)
        ctx.closePath()
        ctx.fill()
        ctx.fillStyle = accent
        ctx.beginPath()
        ctx.moveTo(cx - 1.2, 20.2)
        ctx.lineTo(cx + 1.2, 20.2)
        ctx.lineTo(cx + 1.7, 27)
        ctx.lineTo(cx, 29.2)
        ctx.lineTo(cx - 1.7, 27)
        ctx.closePath()
        ctx.fill()
        fillRound(ctx, cx - 1.5, 19.8, 3, 2, 0.8, accentDark)
        break
      case 'number':
        fillRound(ctx, cx - 4.4, 23.2, 8.8, 5.2, 1.2, accent)
        ctx.fillStyle = INK
        ctx.fillRect(cx - 3, 24.4, 1, 2.8)
        ctx.fillRect(cx - 1, 24.4, 2, 1)
        ctx.fillRect(cx, 25.4, 1, 1.8)
        ctx.fillRect(cx + 2, 24.4, 1, 2.8)
        break
      case 'clipboard':
        fillRound(ctx, cx + 3.4, 22.8, 7.6, 9.6, 1.3, 'rgba(20,24,40,0.18)')
        fillRound(ctx, cx + 3, 22.2, 7.6, 9.6, 1.3, accent)
        fillRound(ctx, cx + 4, 23.6, 5.6, 7.2, 0.7, '#ffffff')
        ctx.fillStyle = '#b4bac8'
        ctx.fillRect(cx + 4.9, 25.4, 3.8, 0.7)
        ctx.fillRect(cx + 4.9, 27, 3.8, 0.7)
        ctx.fillRect(cx + 4.9, 28.6, 2.6, 0.7)
        fillRound(ctx, cx + 5.3, 21.6, 3, 1.7, 0.6, '#4b5468')
        break
      default:
        break
    }
  }
  if (ph.accessory === 'baton') {
    ctx.fillStyle = accentDark
    ctx.fillRect(cx - 7.6, 28.4, 15.2, 1.6) // belt
    fillRound(ctx, cx + 7.4, 23, 2.6, 10.5, 1.3, accent)
  }

  // Head: a round ball in a skin tone, lit from the top left.
  const head = () => {
    ctx.beginPath()
    ctx.arc(cx, HEAD_Y, HEAD_R, 0, Math.PI * 2)
  }
  head()
  const g = ctx.createRadialGradient(cx - 2.4, HEAD_Y - 2.8, 1, cx, HEAD_Y, HEAD_R + 1.5)
  g.addColorStop(0, css(skin))
  g.addColorStop(0.7, css(skin))
  g.addColorStop(1, css(darken(skin, 0.84)))
  ctx.fillStyle = g
  ctx.fill()

  const shaved = ph.accessory === 'number'
  const hatted = ph.accessory === 'cap' || ph.accessory === 'peaked_cap'
  const style = look.head?.style ?? 'short'
  /** Fills inside the head only. */
  const onHead = (paint: () => void) => {
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, HEAD_Y, HEAD_R + 0.35, 0, Math.PI * 2)
    ctx.clip()
    paint()
    ctx.restore()
  }
  /** Hair over the top of the head down to `y` at the sides, with a soft fringe (or the nape). */
  const crown = (fill: string, y: number, dip: number) =>
    onHead(() => {
      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.moveTo(cx - 9, y)
      if (back) ctx.quadraticCurveTo(cx, y + dip, cx + 9, y)
      else {
        ctx.quadraticCurveTo(cx - 4, y - dip, cx - 0.5, y - dip * 0.35)
        ctx.quadraticCurveTo(cx + 4, y - dip * 1.2, cx + 9, y)
      }
      ctx.lineTo(cx + 9, 0)
      ctx.lineTo(cx - 9, 0)
      ctx.closePath()
      ctx.fill()
    })
  const hairLine = back ? 15.2 : 10.6
  const dip = back ? 3.4 : 2.6
  const baseballCap = (fill: number) => {
    crown(css(fill), back ? 13.2 : 9.6, back ? 2.4 : 0)
    if (!back) {
      ellipse(ctx, cx, 10, 8.2, 2.1, css(darken(fill, 0.72)))
      ellipse(ctx, cx, 9.5, 8, 1.7, css(darken(fill, 0.86)))
    } else fillRound(ctx, cx - 1.6, 12.6, 3.2, 1.4, 0.7, css(darken(fill, 0.72)))
  }

  if (!hatted) {
    if (shaved) crown(css(darken(skin, 0.86)), hairLine - 1, dip)
    else if (style === 'bald') {
      ellipse(ctx, cx - 2.6, 7.6, 2.4, 1.4, 'rgba(255,255,255,0.35)')
      onHead(() => {
        ellipse(ctx, cx - 7, 12.6, 1.7, 2.8, hair)
        ellipse(ctx, cx + 7, 12.6, 1.7, 2.8, hair)
        if (back) fillRound(ctx, cx - 7, 13.6, 14, 4, 2, hair)
      })
    } else if (style === 'cap') baseballCap(accentN)
    else {
      if (style === 'bun') {
        ellipse(ctx, cx, 4.5, 3, 3, hairDark)
        ellipse(ctx, cx, 4.3, 2.6, 2.6, hair)
      }
      if (style === 'spiky') {
        ctx.fillStyle = hair
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(cx - 6.6, 9)
        for (const [x, y] of [[-5.6, 3.4], [-3.4, 6], [-1.6, 2], [0.6, 5.6], [2.6, 2.4], [4.2, 6.2], [6.2, 4], [6.6, 9]]) ctx.lineTo(cx + x, y)
        ctx.closePath()
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = hair
        ctx.stroke()
      }
      if (style === 'long') {
        if (back) fillRound(ctx, cx - 7.8, 6, 15.6, 16.4, 6, hairDark)
        else {
          fillRound(ctx, cx - 8.2, 8.5, 3, 12, 1.5, hairDark)
          fillRound(ctx, cx + 5.2, 8.5, 3, 12, 1.5, hairDark)
        }
      }
      crown(hair, back && style === 'long' ? 30 : hairLine, dip)
    }
  }

  // The face: two eyes, a little colour on the cheeks, a small smile.
  if (!back) {
    ellipse(ctx, cx - 4.5, 15.4, 1.5, 1, 'rgba(235,110,95,0.28)')
    ellipse(ctx, cx + 4.5, 15.4, 1.5, 1, 'rgba(235,110,95,0.28)')
    ellipse(ctx, cx - 2.7, 13.5, 0.95, 1.15, INK)
    ellipse(ctx, cx + 2.7, 13.5, 0.95, 1.15, INK)
    ctx.beginPath()
    ctx.arc(cx, 15.3, 1.5, Math.PI * 0.2, Math.PI * 0.8)
    ctx.lineWidth = 0.55
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(43,47,58,0.75)'
    ctx.stroke()
  }

  // A soft rim in a darker skin tone instead of an outline.
  head()
  ctx.lineWidth = 0.6
  ctx.strokeStyle = css(darken(skin, 0.72))
  ctx.globalAlpha = 0.55
  ctx.stroke()
  ctx.globalAlpha = 1

  if (ph.accessory === 'cap') baseballCap(accentN)
  else if (ph.accessory === 'peaked_cap') {
    fillRound(ctx, cx - 7.8, 3.4, 15.6, 6.4, 2.6, accent)
    fillRound(ctx, cx - 7.2, 8.4, 14.4, 1.9, 0.9, '#1c1f2a')
    if (!back) {
      ellipse(ctx, cx, 10.3, 7.2, 1.5, '#1c1f2a')
      ellipse(ctx, cx, 6, 1.4, 1.4, '#f2c94c')
    }
  }
}

/** Generates (once) the textures for a role + skin tone (+ look) and returns the skin. */
export function placeholderSkin(
  scene: Phaser.Scene,
  role: Role,
  ph: Placeholder,
  tone: number,
  look: PlaceholderLook = {}
): Skin {
  const s = ph.scale && ph.scale > 0 ? ph.scale : 1
  // Every look parameter is in the key: textures are reused by key.
  const hd = look.head ? `${look.head.style}.${look.head.hair}.${look.head.skin}` : '-'
  const overlay = `ph:over:${role}:${ph.accessory}:${look.accent ?? ph.accent}:${hd}:${look.collar ?? '-'}:${tone}`
  bakeSheet(scene, overlay, FRAME_W, FRAME_H, ['front', 'back'], 2, (ctx, name) => drawOverlay(ctx, name === 'back', ph, tone, look, role))
  return { kind: 'placeholder', shadow: ensureShadow(scene), body: ensureBody(scene), overlay, height: Math.ceil(BASE_H * s), scale: s / RES }
}

export function propKey(kind: PropKind): string {
  return `prop:${kind}`
}
/** Display scale of the prop textures. */
export const PROP_SCALE = 1 / RES

/** The carried items: folder (handoff), report, sticky memo, sealed order. 16x16 map px each, centred. */
export function ensureProps(scene: Phaser.Scene): void {
  const one = (kind: PropKind, draw: (ctx: Ctx) => void) =>
    bakeSheet(scene, propKey(kind), 16, 16, ['__BASE'], 1, (ctx) => {
      fillRoundShadow(ctx)
      draw(ctx)
    })
  const fillRoundShadow = (ctx: Ctx) => ellipse(ctx, 8.4, 13.4, 5.4, 1.3, 'rgba(20,24,40,0.16)')
  one('handoff', (ctx) => {
    fillRound(ctx, 2.2, 3.4, 5.6, 3, 1, '#c9902e') // tab
    fillRound(ctx, 2, 4.8, 12, 8.2, 1.4, '#d9a23c')
    fillRound(ctx, 2, 6, 12, 7, 1.4, '#efbd58')
  })
  one('report', (ctx) => {
    fillRound(ctx, 3.6, 2.2, 9, 11.4, 1.1, '#fdfdfe')
    fillRound(ctx, 3.6, 2.2, 9, 3, 1.1, '#5b8def')
    ctx.fillStyle = '#b9bfcc'
    ctx.fillRect(5.2, 7, 5.8, 0.8)
    ctx.fillRect(5.2, 8.8, 5.8, 0.8)
    ctx.fillRect(5.2, 10.6, 3.8, 0.8)
  })
  // Sealed order envelope (CEO -> manager).
  one('order', (ctx) => {
    fillRound(ctx, 2, 3.6, 12, 9, 1.2, '#fffdf5')
    ctx.beginPath()
    ctx.moveTo(2.4, 4.2)
    ctx.lineTo(8, 9)
    ctx.lineTo(13.6, 4.2)
    ctx.lineWidth = 0.7
    ctx.strokeStyle = '#c4c0b2'
    ctx.stroke()
    ellipse(ctx, 8, 9, 1.9, 1.9, '#c0392b')
  })
  one('memo', (ctx) => {
    fillRound(ctx, 4, 3.6, 8.4, 8.4, 1, '#f6e05e')
    ctx.fillStyle = '#dcc23a'
    ctx.beginPath()
    ctx.moveTo(12.4, 9)
    ctx.lineTo(9.4, 12)
    ctx.lineTo(9.4, 9)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#b9a22e'
    ctx.fillRect(5.4, 5.4, 5, 0.7)
    ctx.fillRect(5.4, 7.1, 3.6, 0.7)
  })
}

// ---- Optional sprite sheets from the theme -------------------------------------------------

export function roleSheetKey(role: Role): string {
  return `sheet:role:${role}`
}
export function providerSheetKey(provider: string, role: Role): string {
  return `sheet:prov:${provider}:${role}`
}
const overlayKey = (k: string) => `${k}:overlay`

function allSheets(theme: ThemeManifest): Array<{ key: string; def: SpriteSheet }> {
  const out: Array<{ key: string; def: SpriteSheet }> = []
  for (const role of ['boss', 'manager', 'worker'] as const) {
    const def = theme.roles[role]?.sprite
    if (def) out.push({ key: roleSheetKey(role), def })
  }
  for (const [provider, skin] of Object.entries(theme.providers)) {
    for (const [role, def] of Object.entries(skin.sprites ?? {})) {
      if (def) out.push({ key: providerSheetKey(provider, role as Role), def })
    }
  }
  return out
}

/** Queue every sheet the theme references (Scene.preload). */
export function preloadSheets(scene: Phaser.Scene, theme: ThemeManifest, baseUrl: string): void {
  for (const { key, def } of allSheets(theme)) {
    const cfg = { frameWidth: def.frameWidth, frameHeight: def.frameHeight }
    scene.load.spritesheet(key, baseUrl + def.sheet, cfg)
    if (def.overlay) scene.load.spritesheet(overlayKey(key), baseUrl + def.overlay, cfg)
  }
}

/** Create animations for loaded sheets (Scene.create). */
export function createSheetAnims(scene: Phaser.Scene, theme: ThemeManifest): void {
  for (const { key, def } of allSheets(theme)) {
    if (!scene.textures.exists(key)) continue
    const hasOverlay = !!def.overlay && scene.textures.exists(overlayKey(key))
    for (const [name, a] of Object.entries(def.animations)) {
      const mk = (tex: string) => {
        const k = animKey(tex, name)
        if (scene.anims.exists(k)) return
        scene.anims.create({
          key: k,
          frames: scene.anims.generateFrameNumbers(tex, { frames: a.frames }),
          frameRate: a.fps,
          repeat: a.repeat ?? -1
        })
      }
      mk(key)
      if (hasOverlay) mk(overlayKey(key))
    }
  }
}

/** Skin from a loaded sheet, or null if it failed to load. */
export function sheetSkin(scene: Phaser.Scene, key: string, def: SpriteSheet): Skin | null {
  if (!scene.textures.exists(key)) return null
  const ov = overlayKey(key)
  return {
    kind: 'sheet',
    shadow: ensureShadow(scene),
    shadowScale: def.frameWidth / BASE_W / RES,
    body: key,
    overlay: def.overlay && scene.textures.exists(ov) ? ov : null,
    anims: new Set(Object.keys(def.animations)),
    height: def.frameHeight
  }
}
