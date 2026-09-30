// Procedural Prison-Architect-style characters and prop textures, plus optional theme sprite sheets.
import Phaser from 'phaser'
import type { Placeholder, Role, SpriteSheet, ThemeManifest } from '../../shared/theme'
import { cssToInt } from '../theme/loader'

export type PropKind = 'handoff' | 'report' | 'memo'
export const PROP_KINDS: readonly PropKind[] = ['handoff', 'report', 'memo']

const BASE_W = 24
const BASE_H = 32
const OUTLINE = 0x1e1e24

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

/** What a Character needs to display itself. */
export type Skin =
  | {
      kind: 'placeholder'
      shadow: string
      body: [string, string]
      overlay: [string, string]
      height: number
    }
  | {
      kind: 'sheet'
      shadow: string
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

function bake(scene: Phaser.Scene, key: string, w: number, h: number, draw: (g: Phaser.GameObjects.Graphics) => void) {
  if (scene.textures.exists(key)) return
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  draw(g)
  g.generateTexture(key, w, h)
  g.destroy()
}

function dims(scale: number) {
  return { w: Math.ceil(BASE_W * scale), h: Math.ceil(BASE_H * scale) }
}

function ensureShadow(scene: Phaser.Scene, scale: number): string {
  const { w, h } = dims(scale)
  const key = `ph:shadow:${w}x${h}`
  bake(scene, key, w, h, (g) => {
    g.fillStyle(0x000000, 0.18)
    g.fillEllipse(w / 2, h - 3 * scale, 20 * scale, 7 * scale)
    g.fillStyle(0x000000, 0.18)
    g.fillEllipse(w / 2, h - 3 * scale, 14 * scale, 4 * scale)
  })
  return key
}

/** Body blob: white with one light-grey shade band, so setTint multiplies cleanly. */
function drawBody(g: Phaser.GameObjects.Graphics, s: number, dy: number) {
  g.fillStyle(0xcfcfcf, 1)
  g.fillRoundedRect(4 * s, (14 + dy) * s, 16 * s, 16 * s, 7 * s)
  g.fillStyle(0xffffff, 1)
  g.fillRoundedRect(4 * s, (14 + dy) * s, 13 * s, 12.5 * s, 6 * s)
}

function drawOverlay(g: Phaser.GameObjects.Graphics, s: number, dy: number, ph: Placeholder, tone: number) {
  const { skin, hair } = TONES[tone % TONES.length]
  const a = cssToInt(ph.accent, 0xffffff)
  const cx = 12 * s
  const y = (v: number) => (v + dy) * s
  const line = Math.max(1, Math.round(s))

  // Body outline.
  g.lineStyle(line, OUTLINE, 1)
  g.strokeRoundedRect(4.5 * s, y(14.5), 15 * s, 15 * s, 7 * s)

  // Accessories worn on the body go under the head.
  switch (ph.accessory) {
    case 'tie':
      g.fillStyle(0xffffff, 1)
      g.fillTriangle(9 * s, y(15), 15 * s, y(15), cx, y(18))
      g.fillStyle(a, 1)
      g.fillRect(11 * s, y(16), 2 * s, 6 * s)
      g.fillTriangle(10.5 * s, y(22), 13.5 * s, y(22), cx, y(24.5))
      break
    case 'number':
      g.fillStyle(a, 1)
      g.fillRect(8 * s, y(18), 8 * s, 5 * s)
      g.fillStyle(OUTLINE, 1)
      g.fillRect(9 * s, y(19), 1 * s, 3 * s)
      g.fillRect(11 * s, y(19), 2 * s, 1 * s)
      g.fillRect(12 * s, y(20), 1 * s, 2 * s)
      g.fillRect(14 * s, y(19), 1 * s, 3 * s)
      break
    case 'baton':
      g.fillStyle(darken(a, 0.8), 1)
      g.fillRect(4 * s, y(22), 16 * s, 1.5 * s) // belt
      g.fillStyle(a, 1)
      g.fillRoundedRect(19 * s, y(17), 2.5 * s, 11 * s, 1 * s)
      g.lineStyle(line, OUTLINE, 1)
      g.strokeRoundedRect(19 * s, y(17), 2.5 * s, 11 * s, 1 * s)
      break
    case 'clipboard':
      g.fillStyle(a, 1)
      g.fillRect(15 * s, y(18), 7 * s, 9 * s)
      g.fillStyle(0xffffff, 1)
      g.fillRect(16 * s, y(19.5), 5 * s, 6.5 * s)
      g.fillStyle(0x9e9e9e, 1)
      g.fillRect(16.5 * s, y(21), 4 * s, 0.75 * s)
      g.fillRect(16.5 * s, y(22.75), 4 * s, 0.75 * s)
      g.fillRect(16.5 * s, y(24.5), 3 * s, 0.75 * s)
      g.fillStyle(0x424242, 1)
      g.fillRect(17 * s, y(17.5), 3 * s, 1.5 * s)
      g.lineStyle(line, OUTLINE, 1)
      g.strokeRect(15 * s, y(18), 7 * s, 9 * s)
      break
    default:
      break
  }

  // Head: big oval in a skin tone.
  g.fillStyle(skin, 1)
  g.fillEllipse(cx, y(10), 12 * s, 13 * s)
  const shaved = ph.accessory === 'number'
  const hatted = ph.accessory === 'cap' || ph.accessory === 'peaked_cap'
  if (!hatted) {
    g.fillStyle(shaved ? darken(skin, 0.85) : hair, 1)
    g.beginPath()
    g.arc(cx, y(9), 5.8 * s, Math.PI, 0, false)
    g.closePath()
    g.fillPath()
  }
  g.lineStyle(line, OUTLINE, 1)
  g.strokeEllipse(cx, y(10), 12 * s, 13 * s)

  if (ph.accessory === 'cap') {
    g.fillStyle(a, 1)
    g.beginPath()
    g.arc(cx, y(8), 6.2 * s, Math.PI, 0, false)
    g.closePath()
    g.fillPath()
    g.fillStyle(darken(a), 1)
    g.fillRect(5.5 * s, y(7.5), 13 * s, 2 * s)
    g.lineStyle(line, OUTLINE, 1)
    g.strokeRect(5.5 * s, y(7.5), 13 * s, 2 * s)
  } else if (ph.accessory === 'peaked_cap') {
    g.fillStyle(a, 1)
    g.fillRoundedRect(4.5 * s, y(2), 15 * s, 6 * s, 2 * s)
    g.fillStyle(0x111111, 1)
    g.fillRect(6 * s, y(7.5), 12 * s, 2 * s)
    g.fillStyle(0xf2c94c, 1)
    g.fillCircle(cx, y(4.8), 1.3 * s)
    g.lineStyle(line, OUTLINE, 1)
    g.strokeRoundedRect(4.5 * s, y(2), 15 * s, 6 * s, 2 * s)
  }
}

/** Generates (once) the placeholder textures for a role + skin tone and returns the skin. */
export function placeholderSkin(scene: Phaser.Scene, role: Role, ph: Placeholder, tone: number): Skin {
  const s = ph.scale && ph.scale > 0 ? ph.scale : 1
  const { w, h } = dims(s)
  const sig = `${role}:${ph.accessory}:${ph.accent}:${s}`
  const body: [string, string] = [`ph:body:${s}:0`, `ph:body:${s}:1`]
  const overlay: [string, string] = [`ph:over:${sig}:${tone}:0`, `ph:over:${sig}:${tone}:1`]
  for (let f = 0; f < 2; f++) {
    const dy = f === 0 ? 0 : -1
    bake(scene, body[f], w, h, (g) => drawBody(g, s, dy))
    bake(scene, overlay[f], w, h, (g) => drawOverlay(g, s, dy, ph, tone))
  }
  return { kind: 'placeholder', shadow: ensureShadow(scene, s), body, overlay, height: h }
}

export function propKey(kind: PropKind): string {
  return `prop:${kind}`
}

/** Three distinct carried items: folder (handoff), report (report), sticky memo (memo). */
export function ensureProps(scene: Phaser.Scene): void {
  bake(scene, propKey('handoff'), 12, 10, (g) => {
    g.fillStyle(0xc98f2a, 1)
    g.fillRect(1, 1, 5, 2) // tab
    g.fillStyle(0xe8b04a, 1)
    g.fillRect(0, 2, 12, 8)
    g.lineStyle(1, OUTLINE, 1)
    g.strokeRect(0.5, 2.5, 11, 7)
  })
  bake(scene, propKey('report'), 9, 11, (g) => {
    g.fillStyle(0xffffff, 1)
    g.fillRect(0, 0, 9, 11)
    g.fillStyle(0x3d7fd1, 1)
    g.fillRect(0, 0, 9, 3)
    g.fillStyle(0x9e9e9e, 1)
    g.fillRect(2, 5, 5, 1)
    g.fillRect(2, 7, 5, 1)
    g.lineStyle(1, OUTLINE, 1)
    g.strokeRect(0.5, 0.5, 8, 10)
  })
  bake(scene, propKey('memo'), 8, 8, (g) => {
    g.fillStyle(0xf6e05e, 1)
    g.fillTriangle(0, 0, 8, 0, 0, 8)
    g.fillTriangle(8, 0, 8, 5, 0, 8)
    g.fillTriangle(8, 5, 5, 8, 0, 8)
    g.fillStyle(0xc9b233, 1)
    g.fillTriangle(8, 5, 5, 5, 5, 8)
    g.lineStyle(1, OUTLINE, 1)
    g.strokeRect(0.5, 0.5, 7, 7)
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
    shadow: ensureShadow(scene, def.frameWidth / BASE_W),
    body: key,
    overlay: def.overlay && scene.textures.exists(ov) ? ov : null,
    anims: new Set(Object.keys(def.animations)),
    height: def.frameHeight
  }
}
