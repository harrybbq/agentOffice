// Pure Tiled JSON parsing + theme validation (no Phaser, so tests can import it).
import { activityDef, HOME, MANAGER } from '../../shared/theme'
import type { ThemeManifest } from '../../shared/theme'
import { ACTIVITIES } from '../../shared/events'
import type { LocationPoint, Locations } from '../scene/roster'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface FurnitureRect extends Rect {
  name: string
  color: number
  alpha: number
  label: string
  /** Characters path around it. */
  solid: boolean
  /** Frame in the theme's furniture atlas ('' = none: drawn as a rectangle). */
  sprite: string
  /** Drawn in front of characters standing behind its bottom edge. */
  ysort: boolean
  /** Only drawn when the map's pictures can't be used. */
  fallback: boolean
  /** Frames per second of an animated sprite (0 = default). */
  fps: number
}

/** A Tiled image layer: one picture of the floor (and maybe the walls). */
export interface ImageLayerRef {
  name: string
  image: string
  /** Top-left corner in map px. */
  x: number
  y: number
  /** Image px per map px. */
  scale: number
  /** The picture includes the walls: the wall rectangles are not drawn. */
  walls: boolean
}

/** A location where a character standing there looks a given way (at its station). */
export interface FacingPoint {
  x: number
  y: number
  facing: 'north' | 'south' | 'east' | 'west'
}

/** A location where a character sits. */
export interface SeatPoint {
  x: number
  y: number
  /** 'north': facing away from the viewer; 'south': facing the viewer. */
  facing: 'north' | 'south'
}

export interface WallRect extends Rect {
  color: number
  alpha: number
}

export interface TilesetRef {
  name: string
  image: string
  firstgid: number
}

export interface ParsedMap {
  widthPx: number
  heightPx: number
  tileWidth: number
  tileHeight: number
  furniture: FurnitureRect[]
  walls: WallRect[]
  locations: Locations
  /** Embedded tilesets with images, and at least one tile layer: render via Phaser tilemap. */
  useTiles: boolean
  tilesets: TilesetRef[]
  tileLayers: string[]
  /** Image layers, bottom first. */
  images: ImageLayerRef[]
  seats: SeatPoint[]
  facings: FacingPoint[]
  raw: Record<string, unknown>
  warnings: string[]
}

/** Location types each template must have. */
export const HQ_REQUIRED = ['boss_seat', 'inbox', 'door'] as const
export const BRANCH_REQUIRED = ['manager_seat', 'desk', 'entrance', 'door'] as const

export const DEFAULT_WALL_COLOR = 0x5c5470

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

export function parseMap(input: unknown, label = 'Map'): ParsedMap {
  if (!isObj(input)) throw new ThemeError(`${label} is not a Tiled JSON object.`)
  if (input.infinite === true) throw new ThemeError(`${label}: infinite Tiled maps are not supported.`)
  const tw = num(input.tilewidth, 32)
  const th = num(input.tileheight, 32)
  const widthPx = num(input.width) * tw
  const heightPx = num(input.height) * th
  if (widthPx <= 0 || heightPx <= 0) throw new ThemeError(`${label} has no size (width/height/tilewidth).`)

  const warnings: string[] = []
  const layers = flatLayers(input.layers)
  const furniture: FurnitureRect[] = []
  const walls: WallRect[] = []
  const locations: Locations = new Map()
  const images: ImageLayerRef[] = []
  const seats: SeatPoint[] = []
  const facings: FacingPoint[] = []

  for (const layer of layers) {
    if (layer.type === 'imagelayer' && typeof layer.image === 'string' && layer.image && layer.visible !== false) {
      const scale = num(prop(layer, 'scale'), 1)
      images.push({
        name: str(layer.name),
        image: layer.image,
        x: num(layer.x) + num(layer.offsetx),
        y: num(layer.y) + num(layer.offsety),
        scale: scale > 0 ? scale : 1,
        walls: prop(layer, 'walls') === true
      })
      continue
    }
    if (layer.type !== 'objectgroup' || !Array.isArray(layer.objects)) continue
    const lname = str(layer.name)
    for (const o of layer.objects) {
      if (!isObj(o) || o.visible === false) continue
      if (lname === 'locations') {
        const type = str(o.type) || str(o.class)
        if (!type) {
          warnings.push(`${label}: location object "${str(o.name)}" has no type/class; ignored.`)
          continue
        }
        const p: LocationPoint = { name: str(o.name, type), x: num(o.x), y: num(o.y) }
        const list = locations.get(type)
        if (list) list.push(p)
        else locations.set(type, [p])
        const seat = prop(o, 'seat')
        if (seat === 'north' || seat === 'south') seats.push({ x: p.x, y: p.y, facing: seat })
        const facing = prop(o, 'facing')
        if (facing === 'north' || facing === 'south' || facing === 'east' || facing === 'west') facings.push({ x: p.x, y: p.y, facing })
        continue
      }
      const width = num(o.width)
      const height = num(o.height)
      if (width <= 0 || height <= 0) continue
      if (lname === 'walls') {
        const { color, alpha } = parseColor(prop(o, 'color'), DEFAULT_WALL_COLOR)
        walls.push({ x: num(o.x), y: num(o.y), width, height, color, alpha })
      } else if (lname === 'furniture') {
        const { color, alpha } = parseColor(prop(o, 'color'))
        furniture.push({
          name: str(o.name),
          x: num(o.x),
          y: num(o.y),
          width,
          height,
          color,
          alpha,
          label: str(prop(o, 'label')),
          solid: prop(o, 'solid') === true,
          sprite: str(prop(o, 'sprite')),
          ysort: prop(o, 'ysort') === true,
          fallback: prop(o, 'fallback') === true,
          fps: num(prop(o, 'fps'), 0)
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
            ? `${label}: external tileset "${src}" is not supported; embed it in the map. Falling back to furniture.`
            : `${label}: tileset without a single image is not supported. Falling back to furniture.`
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
    tileWidth: tw,
    tileHeight: th,
    furniture,
    walls,
    locations,
    useTiles: tilesOk,
    tilesets: tilesOk ? tilesets : [],
    tileLayers,
    images,
    seats,
    facings,
    raw: input,
    warnings
  }
}

function requireTypes(manifest: ThemeManifest, map: ParsedMap, file: string, types: readonly string[]): void {
  const missing = types.filter((t) => !map.locations.get(t)?.length)
  if (missing.length > 0) {
    throw new ThemeError(
      `Theme "${manifest.name}" ${file} is missing required location type(s): ${missing.join(', ')}. ` +
        `Add point objects with these types to its "locations" object layer.`
    )
  }
}

/** Throws ThemeError on missing required location types; returns non-fatal warnings. */
export function validateTheme(manifest: ThemeManifest, hq: ParsedMap, branch: ParsedMap): string[] {
  requireTypes(manifest, hq, manifest.hq ?? 'hq map', HQ_REQUIRED)
  requireTypes(manifest, branch, manifest.branch ?? 'branch map', BRANCH_REQUIRED)
  if (!manifest.roles?.boss || !manifest.roles.manager || !manifest.roles.worker) {
    throw new ThemeError(`Theme "${manifest.name}" must define roles boss, manager and worker.`)
  }
  if (!manifest.providers?.default) {
    throw new ThemeError(`Theme "${manifest.name}" must define providers.default.`)
  }
  const warnings = [...hq.warnings, ...branch.warnings]
  if (hq.tileWidth !== branch.tileWidth || hq.tileHeight !== branch.tileHeight) {
    warnings.push(
      `HQ and branch maps use different tile sizes (${hq.tileWidth}x${hq.tileHeight} vs ` +
        `${branch.tileWidth}x${branch.tileHeight}); the layout uses the branch's.`
    )
  }
  if ((branch.locations.get('manager_seat')?.length ?? 0) > 1) {
    warnings.push('Branch map has more than one manager_seat; only the first is used.')
  }
  for (const a of ACTIVITIES) {
    if (!manifest.activities?.[a]) {
      warnings.push(`Activity "${a}" is not in the theme; characters will go home for it.`)
      continue
    }
    const loc = activityDef(manifest, a).location
    if (loc !== HOME && loc !== MANAGER && !branch.locations.get(loc)?.length && !hq.locations.get(loc)?.length) {
      warnings.push(`Activity "${a}" uses location "${loc}", which neither map has; using home.`)
    }
  }
  // Stations (all optional): a name that no map has is a typo worth hearing about.
  const known = (loc: unknown): boolean =>
    typeof loc === 'string' && (loc === HOME || loc === MANAGER || !!branch.locations.get(loc)?.length || !!hq.locations.get(loc)?.length)
  if (Array.isArray(manifest.stationRules)) {
    manifest.stationRules.forEach((r, i) => {
      if (r && typeof r === 'object' && typeof r.location === 'string' && !known(r.location)) {
        warnings.push(`stationRules[${i}] uses location "${r.location}", which neither map has; characters go home for it.`)
      }
    })
  }
  const idle = manifest.idle
  if (idle && typeof idle.location === 'string' && !branch.locations.get(idle.location)?.length) {
    warnings.push(`idle.location "${idle.location}" is not in the branch map; idle characters stay at their desks.`)
  }
  if (manifest.stationLabels && typeof manifest.stationLabels === 'object') {
    for (const type of Object.keys(manifest.stationLabels)) {
      if (!branch.locations.get(type)?.length && !hq.locations.get(type)?.length) {
        warnings.push(`stationLabels.${type}: neither map has a location of that type; no tag is shown.`)
      }
    }
  }
  return warnings
}
