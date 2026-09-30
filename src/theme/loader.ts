// Parses a theme's Tiled JSON map and renders it (tile layers if present, else furniture rects).
import Phaser from 'phaser'
import { activityDef, HOME, MANAGER } from '../../shared/theme'
import type { ThemeManifest } from '../../shared/theme'
import { ACTIVITIES } from '../../shared/events'
import { REQUIRED_TYPES } from '../scene/roster'
import type { LocationPoint, Locations } from '../scene/roster'

export interface FurnitureRect {
  name: string
  x: number
  y: number
  width: number
  height: number
  color: number
  alpha: number
  label: string
}

export interface TilesetRef {
  name: string
  image: string
  firstgid: number
}

export interface ParsedMap {
  widthPx: number
  heightPx: number
  furniture: FurnitureRect[]
  locations: Locations
  /** Embedded tilesets with images, and at least one tile layer: render via Phaser tilemap. */
  useTiles: boolean
  tilesets: TilesetRef[]
  tileLayers: string[]
  raw: Record<string, unknown>
  warnings: string[]
}

export class ThemeError extends Error {}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

function prop(o: Obj, name: string): unknown {
  const props = o.properties
  if (Array.isArray(props)) {
    for (const p of props) if (isObj(p) && p.name === name) return p.value
  } else if (isObj(props)) {
    return props[name] // very old Tiled format
  }
  return undefined
}

/** Tiled colours are "#rrggbb" or "#aarrggbb". */
export function parseColor(v: unknown, fallback = 0xcccccc): { color: number; alpha: number } {
  const s = str(v).replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(s)) return { color: parseInt(s, 16), alpha: 1 }
  if (/^[0-9a-f]{8}$/i.test(s)) {
    return { color: parseInt(s.slice(2), 16), alpha: parseInt(s.slice(0, 2), 16) / 255 }
  }
  return { color: fallback, alpha: 1 }
}

export function cssToInt(css: string | undefined, fallback: number): number {
  if (!css) return fallback
  return parseColor(css, fallback).color
}

/** Flattens group layers so nested object layers are found too. */
function flatLayers(layers: unknown): Obj[] {
  const out: Obj[] = []
  if (!Array.isArray(layers)) return out
  for (const l of layers) {
    if (!isObj(l)) continue
    if (l.type === 'group') out.push(...flatLayers(l.layers))
    else out.push(l)
  }
  return out
}

export function parseMap(input: unknown): ParsedMap {
  if (!isObj(input)) throw new ThemeError('Map is not a Tiled JSON object.')
  if (input.infinite === true) throw new ThemeError('Infinite Tiled maps are not supported.')
  const tw = num(input.tilewidth, 32)
  const th = num(input.tileheight, 32)
  const widthPx = num(input.width) * tw
  const heightPx = num(input.height) * th
  if (widthPx <= 0 || heightPx <= 0) throw new ThemeError('Map has no size (width/height/tilewidth).')

  const warnings: string[] = []
  const layers = flatLayers(input.layers)
  const furniture: FurnitureRect[] = []
  const locations: Locations = new Map()

  for (const layer of layers) {
    if (layer.type !== 'objectgroup' || !Array.isArray(layer.objects)) continue
    const lname = str(layer.name)
    for (const o of layer.objects) {
      if (!isObj(o) || o.visible === false) continue
      if (lname === 'locations') {
        const type = str(o.type) || str(o.class)
        if (!type) {
          warnings.push(`Location object "${str(o.name)}" has no type/class; ignored.`)
          continue
        }
        const p: LocationPoint = { name: str(o.name, type), x: num(o.x), y: num(o.y) }
        const list = locations.get(type)
        if (list) list.push(p)
        else locations.set(type, [p])
      } else if (lname === 'furniture') {
        const width = num(o.width)
        const height = num(o.height)
        if (width <= 0 || height <= 0) continue
        const { color, alpha } = parseColor(prop(o, 'color'))
        furniture.push({
          name: str(o.name),
          x: num(o.x),
          y: num(o.y),
          width,
          height,
          color,
          alpha,
          label: str(prop(o, 'label'))
        })
      }
    }
  }

  const tileLayers = layers.filter((l) => l.type === 'tilelayer').map((l) => str(l.name))
  const tilesets: TilesetRef[] = []
  let tilesOk = Array.isArray(input.tilesets) && input.tilesets.length > 0 && tileLayers.length > 0
  if (tilesOk) {
    for (const ts of input.tilesets as unknown[]) {
      if (!isObj(ts) || typeof ts.image !== 'string') {
        const src = isObj(ts) ? str(ts.source) : ''
        warnings.push(
          src
            ? `External tileset "${src}" is not supported; embed it in the map. Falling back to furniture.`
            : 'Tileset without a single image is not supported. Falling back to furniture.'
        )
        tilesOk = false
        break
      }
      tilesets.push({ name: str(ts.name), image: ts.image, firstgid: num(ts.firstgid, 1) })
    }
  }

  return {
    widthPx,
    heightPx,
    furniture,
    locations,
    useTiles: tilesOk,
    tilesets: tilesOk ? tilesets : [],
    tileLayers,
    raw: input,
    warnings
  }
}

/** Throws ThemeError on missing required location types; returns non-fatal warnings. */
export function validateTheme(manifest: ThemeManifest, map: ParsedMap): string[] {
  const missing = REQUIRED_TYPES.filter((t) => !(map.locations.get(t)?.length))
  if (missing.length > 0) {
    throw new ThemeError(
      `Theme "${manifest.name}" map is missing required location type(s): ${missing.join(', ')}. ` +
        `Add point objects with these types to the "locations" object layer.`
    )
  }
  if (!manifest.roles?.boss || !manifest.roles.manager || !manifest.roles.worker) {
    throw new ThemeError(`Theme "${manifest.name}" must define roles boss, manager and worker.`)
  }
  if (!manifest.providers?.default) {
    throw new ThemeError(`Theme "${manifest.name}" must define providers.default.`)
  }
  const warnings = [...map.warnings]
  for (const a of ACTIVITIES) {
    if (!manifest.activities?.[a]) {
      warnings.push(`Activity "${a}" is not in the theme; characters will go home for it.`)
      continue
    }
    const loc = activityDef(manifest, a).location
    if (loc !== HOME && loc !== MANAGER && !map.locations.get(loc)?.length) {
      warnings.push(`Activity "${a}" uses location "${loc}", which the map doesn't have; using home.`)
    }
  }
  return warnings
}

const tilesetKey = (name: string, i: number) => `tileset:${i}:${name}`

/** Queue tileset images (call from Scene.preload). */
export function preloadMap(scene: Phaser.Scene, map: ParsedMap, baseUrl: string): void {
  if (!map.useTiles) return
  scene.load.tilemapTiledJSON('map', map.raw)
  map.tilesets.forEach((ts, i) => scene.load.image(tilesetKey(ts.name, i), baseUrl + ts.image))
}

/** Draws the map (call from Scene.create). */
export function drawMap(scene: Phaser.Scene, map: ParsedMap): void {
  if (map.useTiles) {
    try {
      const tm = scene.make.tilemap({ key: 'map' })
      const sets = map.tilesets
        .map((ts, i) => tm.addTilesetImage(ts.name, tilesetKey(ts.name, i)))
        .filter((t): t is Phaser.Tilemaps.Tileset => t !== null)
      for (const name of map.tileLayers) tm.createLayer(name, sets)?.setDepth(-1000)
      return
    } catch (err) {
      console.warn('[agent-office] tilemap render failed, drawing furniture instead', err)
    }
  }
  drawFurniture(scene, map.furniture)
}

function drawFurniture(scene: Phaser.Scene, items: FurnitureRect[]): void {
  const g = scene.add.graphics().setDepth(-1000)
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
    scene.add
      .text(f.x + f.width / 2, f.y + 3, f.label, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#1d1d1d',
        resolution: 2
      })
      .setOrigin(0.5, 0)
      .setAlpha(0.55)
      .setDepth(-999)
  }
}
