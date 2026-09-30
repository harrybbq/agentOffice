// Renders theme maps with Phaser: one drawing per world block (HQ / branch), offset into the
// world. Parsing lives in ./parse (Phaser-free) and is re-exported here.
import Phaser from 'phaser'
import type { Block } from '../world/layout'
import type { FurnitureRect, ParsedMap, WallRect } from './parse'

export * from './parse'

export type TemplateKind = 'hq' | 'branch'

const mapKey = (kind: TemplateKind) => `map:${kind}`
const tilesetKey = (kind: TemplateKind, name: string, i: number) => `tileset:${kind}:${i}:${name}`

/** Queue tileset images for both templates (call from Scene.preload). */
export function preloadTemplates(scene: Phaser.Scene, maps: Record<TemplateKind, ParsedMap>, baseUrl: string): void {
  for (const kind of ['hq', 'branch'] as const) {
    const map = maps[kind]
    if (!map.useTiles) continue
    scene.load.tilemapTiledJSON(mapKey(kind), map.raw)
    map.tilesets.forEach((ts, i) => scene.load.image(tilesetKey(kind, ts.name, i), baseUrl + ts.image))
  }
}

/** Draws one block at its world offset. Returns every object created, for fading/destroying. */
export function drawBlock(scene: Phaser.Scene, block: Block, depth = -1000): Phaser.GameObjects.GameObject[] {
  const kind: TemplateKind = block.kind
  const map = block.template
  const out: Phaser.GameObjects.GameObject[] = []
  let tiled = false
  if (map.useTiles && scene.cache.tilemap.exists(mapKey(kind))) {
    try {
      const tm = scene.make.tilemap({ key: mapKey(kind) })
      const sets = map.tilesets
        .map((ts, i) => tm.addTilesetImage(ts.name, tilesetKey(kind, ts.name, i)))
        .filter((t): t is Phaser.Tilemaps.Tileset => t !== null)
      for (const name of map.tileLayers) {
        const layer = tm.createLayer(name, sets, block.offset.x, block.offset.y)
        if (layer) out.push(layer.setDepth(depth))
      }
      tiled = out.length > 0
    } catch (err) {
      console.warn('[agent-office] tilemap render failed, drawing furniture instead', err)
    }
  }
  if (!tiled) out.push(...drawFurniture(scene, block.furniture, depth))
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
