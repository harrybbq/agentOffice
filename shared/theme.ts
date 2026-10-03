// Theme folder format. Adding a theme = adding a folder under themes/ (or <userData>/themes/).
//
//   themes/<name>/
//     theme.json   -> ThemeManifest (below)
//     hq.json      -> Tiled map of the headquarters: the boss's office + memo inbox. Exactly one.
//     branch.json  -> Tiled map of ONE team's branch: one manager seat, desks, stations.
//                     The scene stamps out a copy per active team (session) on a grid of lots. Each
//                     new branch is connected by an animated 2-tile corridor laid from a `door` of an
//                     existing building, then built. Outside buildings and corridors is not walkable.
//     sprites/...  -> optional sprite sheets referenced from theme.json
//
// Both maps are orthogonal Tiled JSON with the same tile size, and use these layers:
//   - object layer "locations": point objects; `type` (or `class`) = location type
//   - object layer "walls" (optional): rectangles nobody can cross. Pathfinding runs on a half-tile
//     grid, so doors must be at least one tile wide. A room with no door is unreachable: the boss's
//     office is sealed and agents only ever reach the inbox outside it.
//   - object layer "furniture" (optional): rectangles drawn as placeholders when there is no art;
//     properties `color` (#rrggbb), `label`, `solid` (bool: characters path around it)
//   - any tile layers + embedded tilesets (image paths relative to the theme folder)
//
// Art (all optional; a map without it is drawn as the placeholder rectangles above):
//   - image layers (Tiled `imagelayer`): one picture of the floor, drawn in layer order under the
//     furniture at the layer's offset. Custom properties: `scale` (image px per map px, default 1:
//     2 for a picture drawn at twice the map's size) and `walls` (bool: the picture includes the
//     walls, so the `walls` rectangles are not drawn; they still block walking).
//   - furniture property `sprite`: the name of a frame in the theme's furniture atlas
//     (theme.json `art.furniture`). The rectangle stays the footprint (walking, station tag, hover);
//     the frame's `pivot` in the atlas says where the centre of that rectangle is in the picture, so
//     a shadow or a front face can stick out. Without the atlas (or the frame) the rectangle is drawn.
//   - furniture property `ysort` (bool): the sprite is drawn in front of characters standing behind
//     its bottom edge (a chair's backrest), instead of under every character.
//   - furniture property `fallback` (bool): only drawn when the map has no usable floor art (image
//     layers or tile layers): the plain `floor` rectangle, a monitor that is part of the desk's
//     picture. Every other furniture rectangle is drawn on top of the floor art, as its sprite or,
//     without one, as the coloured rectangle.
//   - location property `seat` ("north" | "south"): a character standing exactly there sits, facing
//     away from the viewer (its desk is above it on the map) or towards the viewer.
//   - location property `facing` ("north" | "south" | "east" | "west"): a character standing there
//     (or next to it, when several share the spot) looks that way: seen from behind for north, in
//     profile for east and west. Walking characters always look the way they walk.
//   - animated furniture: when the atlas also has frames named `<sprite>@1`, `<sprite>@2`, ... the
//     sprite cycles through them; furniture property `fps` (default 2) sets the speed.
//
// Required location types:
//   hq.json:     boss_seat (1), inbox (1+ memo slots), door (1+, on the map edge, opens to corridor)
//   branch.json: manager_seat (1), desk (1+), entrance (1+, where characters arrive and leave),
//                door (1+, on the map edge, opens to corridor)
// Optional:
//   branch.json: manager_inbox (1): where workers drop memos for their manager (default: in front of
//                the manager_seat)
// Every other type (printer, yard, ...) is free-form and referenced from `activities`.
// Scope rules: workers only ever resolve locations inside their own branch (or their manager's
// seat/office); a missing station type sends them home. Managers resolve in their branch, then the
// HQ. The HQ `inbox` is for managers only: a waiting worker brings its memo to its manager, who takes
// it to the HQ. During an office-wide CEO order, workers may use stations and the inbox anywhere.
//
// Stations (all optional, all in theme.json; a theme without them behaves as before):
//   stationLabels  location type -> { title, subtitle?, color?, once?, offset? }: a small floating tag above
//                  every location of that type (`once`: one tag per block, at the middle of them:
//                  use it for desks and inbox slots). The dot colour defaults to the colour of the
//                  furniture next to the location. Key order = priority when tags would overlap.
//                  The same titles name the stations in the agent inspector. `offset` (map px) lifts
//                  the tag above art taller than its furniture rectangle; a `seat` behind its desk has
//                  its tag above the sitter.
//   corridor, ground  colours of the corridors (floor, edge, seam?) and of the ground between
//                  buildings (color, speckle?).
//   stationRules   a more specific routing than `activities`: a list of { activity?, detail, location,
//                  anim?, verb? }. `detail` is the source of a case-insensitive regular expression
//                  (max 200 characters; an invalid one is ignored with a warning) tested against the
//                  event's detail. The first rule that matches (and whose `activity`, if given, is the
//                  event's) wins; otherwise the `activities` table applies. When the pattern matches
//                  at the start of the detail, the matched part is left out of the speech bubble
//                  (the rule's verb says it). HOME / MANAGER work as locations; the scope rules above
//                  still apply. For `waiting` a rule only changes the verb and animation: where a
//                  waiting character goes (memo relay, inbox) is fixed.
//   idle           { location, afterMs }: managers and workers with nothing to do for afterMs walk to
//                  a location of that type inside their own branch (a lounge, a yard) and return to
//                  work on their next activity. Without it they stay at their desk. The map may have
//                  several points of that type (sofa cushions with `seat`, a spot at the water
//                  cooler with `facing`): each character takes a free one; when all are taken the
//                  rest stand side by side at one that is not a seat.
// Optional location type in hq.json: `noticeboard` (where notes for the office board fly to).

import type { Activity } from './events'

export type Role = 'boss' | 'manager' | 'worker'

/** Special targets in the activity table, besides map location types. */
export const HOME = 'home' //       the character's own desk / seat
export const MANAGER = 'manager' // the character's manager's seat (home for a manager)

/** Procedurally drawn Prison-Architect-style character (no legs: shadow, body blob, oval head).
 *  The body is tinted by the provider's colour; the role is shown by accessory + accent colour. */
export interface Placeholder {
  accessory: 'tie' | 'clipboard' | 'cap' | 'peaked_cap' | 'baton' | 'number' | 'none'
  /** Colour of the accessory. */
  accent: string
  /** Relative size, 1 = normal. Bosses can be a bit bigger. */
  scale?: number
}

export interface SpriteSheet {
  /** Body layer, drawn white/light grey; gets the provider tint. Path relative to the theme folder. */
  sheet: string
  /** Optional untinted layer with identical frames (head, outline, accessory). */
  overlay?: string
  frameWidth: number
  frameHeight: number
  /** Animation name -> frames. Recognised names: idle, walk, work, carry; for characters on a `seat`:
   *  sit, type (facing the viewer), sit_back, type_back (facing away); for looking away or sideways
   *  (a location's `facing`, or the way a character walks): idle_back, walk_back, carry_back,
   *  work_back, idle_side, walk_side, carry_side, work_side (drawn facing right; mirrored for left).
   *  Missing ones fall back: x_back / x_side -> x, type -> work, sit -> idle, anything -> idle. */
  animations: Record<string, { frames: number[]; fps: number; repeat?: number }>
}

export interface RoleDef {
  /** Title shown in the UI, e.g. "CEO", "Warden". */
  label: string
  placeholder: Placeholder
  sprite?: SpriteSheet
}

/** How a provider's characters look different. Tint = body colour (placeholder and sprite body layer). */
export interface ProviderSkin {
  tint?: string
  /** Optional full replacement sheets per role, e.g. a different uniform. */
  sprites?: Partial<Record<Role, SpriteSheet>>
}

export interface ActivityDef {
  /** Location type from the map, or HOME / MANAGER. */
  location: string
  /** Animation to play on arrival (see SpriteSheet.animations). */
  anim?: string
  /** Short verb for the speech bubble, e.g. "Copying", "Filing". */
  verb?: string
}

/** A more specific route than the `activities` table (see the header). */
export interface StationRule {
  /** Only for events of this activity; any activity when left out. */
  activity?: Activity
  /** Source of a case-insensitive regular expression tested against the event's detail. */
  detail: string
  /** Location type from the map, or HOME / MANAGER. */
  location: string
  anim?: string
  verb?: string
}

/** The floating tag above a station. */
export interface StationLabel {
  title: string
  subtitle?: string
  /** Dot colour (#rrggbb). Default: the colour of the furniture next to the location. */
  color?: string
  /** One tag per block for this type instead of one per location (desks, inbox slots). */
  once?: boolean
  /** Map px to lift the tag above the furniture's top edge, for art that is taller than its
   *  footprint (a monitor, a board on legs). Default 0. */
  offset?: number
}

export interface IdleDef {
  /** Location type inside the character's own branch. */
  location: string
  /** How long a character has had nothing to do before it walks there, in ms. */
  afterMs: number
}

/** Pictures the theme brings (see the header). */
export interface ThemeArt {
  /** 'smooth' (default): pictures are filtered and mip-mapped, for flat vector-like art drawn larger
   *  than the map. 'pixel': nearest-neighbour, for pixel art drawn at the map's size. */
  filter?: 'smooth' | 'pixel'
  /** Furniture sprites: one image plus a TexturePacker "JSON (Hash)" file, both relative to the theme
   *  folder. `meta.scale` in the data is the image's px per map px (default 1). */
  furniture?: { image: string; data: string }
}

/** Colours of the corridors the scene lays between buildings. */
export interface CorridorColors {
  floor: string
  edge: string
  /** Faint lines between the corridor's floor tiles (default: a little darker than the floor). */
  seam?: string
}

/** The ground between buildings. */
export interface GroundStyle {
  color: string
  /** Sparse dots in this colour, a calm texture (none when left out). */
  speckle?: string
}

/** Longest `stationRules[].detail` pattern that is compiled. */
export const STATION_RULE_MAX_PATTERN = 200

export interface ThemeManifest {
  name: string
  displayName: string
  /** Tiled JSON of the headquarters (boss office + inbox), relative to the theme folder. */
  hq: string
  /** Tiled JSON of one team's branch, stamped out once per active team. */
  branch: string
  background: string
  roles: Record<Role, RoleDef>
  /** Keyed by AgentEvent.provider; "default" is required, "human" is used for the boss (you). */
  providers: Record<string, ProviderSkin>
  /** Either a location string or a full ActivityDef. */
  activities: Record<Activity, string | ActivityDef>
  /** Names for the items carried between characters. */
  props: { handoff: string; report: string; memo: string }
  /** Team (branch) colours: the manager's accessory, a collar/badge on its workers, the branch sign
   *  and the HUD legend. Assigned per team, unique among live teams while the palette lasts. */
  teams?: { colors: string[] }
  /** Floating tags above stations, by location type (see the header). */
  stationLabels?: Record<string, StationLabel>
  /** Detail-specific routing, checked before `activities`; the first match wins. */
  stationRules?: StationRule[]
  /** Where characters with nothing to do go, and after how long. */
  idle?: IdleDef
  /** Pictures: filtering and the furniture atlas. */
  art?: ThemeArt
  /** Corridor colours. Default: derived from the branch map's `floor` rectangle and first wall. */
  corridor?: CorridorColors
  /** The ground between buildings. Default: the background colour with a hint of green. */
  ground?: GroundStyle
}

/** Used when a theme has no `teams.colors`: 10 clearly distinct colours. */
export const DEFAULT_TEAM_COLORS: readonly string[] = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#bfef45',
  '#ffe119',
  '#9a6324'
]

export function teamColors(t: ThemeManifest): readonly string[] {
  const c = t.teams?.colors?.filter((x) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x))
  return c && c.length > 0 ? c : DEFAULT_TEAM_COLORS
}

export function activityDef(t: ThemeManifest, a: Activity): ActivityDef {
  const v = t.activities[a]
  return typeof v === 'string' ? { location: v } : v
}
