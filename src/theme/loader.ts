// Renders theme maps with Phaser: one drawing per world block (HQ / branch), offset into the
// world. Parsing lives in ./parse (Phaser-free) and is re-exported here.
import Phaser from 'phaser'
import type { Block } from '../world/layout'
import type { ThemeArt } from '../../shared/theme'
import type { FurnitureRect, ImageLayerRef, ParsedMap, WallRect } from './parse'

export * from './parse'

export type TemplateKind = 'hq' | 'branch'

const mapKey = (kind: TemplateKind) => `map:${kind}`
const tilesetKey = (kind: TemplateKind, name: string, i: number) => `tileset:${kind}:${i}:${name}`

const imageKey = (kind: TemplateKind, i: number) => `floor:${kind}:${i}`
/** The theme's furniture atlas (theme.json `art.furniture`). */
export const FURNITURE_ATLAS = 'art:furniture'

/** Queue the maps' pictures (tilesets, image layers) and the furniture atlas (call from Scene.preload). */
export function preloadTemplates(
  scene: Phaser.Scene,
  maps: Record<TemplateKind, ParsedMap>,
  baseUrl: string,
  art?: ThemeArt
): void {
  if (art?.furniture?.image && art.furniture.data) {
    scene.load.atlas(FURNITURE_ATLAS, baseUrl + art.furniture.image, baseUrl + art.furniture.data)
  }
  for (const kind of ['hq', 'branch'] as const) {
    const map = maps[kind]
    map.images.forEach((img, i) => scene.load.image(imageKey(kind, i), baseUrl + img.image))
    if (!map.useTiles) continue
    scene.load.tilemapTiledJSON(mapKey(kind), map.raw)
    map.tilesets.forEach((ts, i) => scene.load.image(tilesetKey(kind, ts.name, i), baseUrl + ts.image))
  }
}

/** The block's Tiled tile layers at its world offset ([] when the map has no usable tiles). */
export type TileLayer = Phaser.Tilemaps.TilemapLayer | Phaser.Tilemaps.TilemapGPULayer

export function drawTileLayers(scene: Phaser.Scene, block: Block, depth = -1000): TileLayer[] {
  const kind: TemplateKind = block.kind
  const map = block.template
  const out: TileLayer[] = []
  if (!map.useTiles || !scene.cache.tilemap.exists(mapKey(kind))) return out
  try {
    const tm = scene.make.tilemap({ key: mapKey(kind) })
    const sets = map.tilesets
      .map((ts, i) => tm.addTilesetImage(ts.name, tilesetKey(kind, ts.name, i)))
      .filter((t): t is Phaser.Tilemaps.Tileset => t !== null)
    for (const name of map.tileLayers) {
      const layer = tm.createLayer(name, sets, block.offset.x, block.offset.y)
      if (layer) out.push(layer.setDepth(depth))
    }
  } catch (err) {
    console.warn('[agent-office] tilemap render failed, drawing furniture instead', err)
  }
  return out
}

export interface FloorImage {
  image: Phaser.GameObjects.Image
  ref: ImageLayerRef
}

/**
 * The block's image layers at its world offset, bottom first. [] unless every one of them loaded:
 * half a floor is worse than the placeholder.
 */
export function drawImageLayers(scene: Phaser.Scene, block: Block, depth = -1000): FloorImage[] {
  const refs = block.template.images
  if (refs.length === 0 || !refs.every((_, i) => scene.textures.exists(imageKey(block.kind, i)))) return []
  return refs.map((ref, i) => ({
    ref,
    image: scene.add
      .image(block.offset.x + ref.x, block.offset.y + ref.y, imageKey(block.kind, i))
      .setOrigin(0, 0)
      .setScale(1 / ref.scale)
      .setDepth(depth + i * 0.01)
  }))
}

/** Image px per map px of the furniture atlas (its `meta.scale`), or 0 when there is no atlas. */
export function furnitureScale(scene: Phaser.Scene): number {
  if (!scene.textures.exists(FURNITURE_ATLAS)) return 0
  const meta = (scene.textures.get(FURNITURE_ATLAS).customData as { meta?: { scale?: unknown } }).meta
  const v = Number(meta?.scale)
  return Number.isFinite(v) && v > 0 ? v : 1
}

/** Draws one block at its world offset. Returns every object created, for fading/destroying. */
export function drawBlock(scene: Phaser.Scene, block: Block, depth = -1000): Phaser.GameObjects.GameObject[] {
  const out: Phaser.GameObjects.GameObject[] = drawTileLayers(scene, block, depth)
  if (out.length === 0) out.push(...drawFurniture(scene, block.furniture, depth))
  // Walls always read as walls, on top of tiles/furniture.
  out.push(drawWalls(scene, block.walls, depth + 1))
  return out
}

function drawFurniture(scene: Phaser.Scene, items: FurnitureRect[], depth: number): Phaser.GameObjects.GameObject[] {
  const out: Phaser.GameObjects.GameObject[] = []
  const g = scene.add.graphics().setDepth(depth)
  out.push(g)
  for (const f of items) {
    g.fillStyle(f.color, f.alpha)
    g.fillRect(f.x, f.y, f.width, f.height)
    // Cheat a front face so props read as objects rather than floor patches.
    if (f.width <= 128 && f.height <= 96 && f.height >= 12) {
      g.fillStyle(0x000000, 0.12)
      g.fillRect(f.x, f.y + f.height - 3, f.width, 3)
    }
  }
  for (const f of items) {
    if (!f.label) continue
    out.push(
      scene.add
        .text(f.x + f.width / 2, f.y + 3, f.label, {
          fontFamily: 'monospace',
          fontSize: '10px',
          color: '#1d1d1d',
          resolution: 2
        })
        .setOrigin(0.5, 0)
        .setAlpha(0.55)
        .setDepth(depth + 2)
    )
  }
  return out
}

function drawWalls(scene: Phaser.Scene, walls: WallRect[], depth: number): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics().setDepth(depth)
  for (const w of walls) {
    g.fillStyle(w.color, w.alpha)
    g.fillRect(w.x, w.y, w.width, w.height)
  }
  // A darker bottom edge gives the walls a little thickness.
  for (const w of walls) {
    g.fillStyle(0x000000, 0.25)
    g.fillRect(w.x, w.y + w.height - 2, w.width, 2)
  }
  return g
}
