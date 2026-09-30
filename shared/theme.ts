// Theme folder format. Adding a theme = adding a folder under themes/ (or <userData>/themes/).
//
//   themes/<name>/
//     theme.json   -> ThemeManifest (below)
//     hq.json      -> Tiled map of the headquarters: the boss's office + memo inbox. Exactly one.
//     branch.json  -> Tiled map of ONE team's branch: one manager seat, desks, stations.
//                     The scene stamps out a copy per active team (session) and lays them all out
//                     in one world, separated by walkable corridors, all visible at once.
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
// Required location types:
//   hq.json:     boss_seat (1), inbox (1+ memo slots), door (1+, on the map edge, opens to corridor)
//   branch.json: manager_seat (1), desk (1+), entrance (1+, where characters arrive and leave),
//                door (1+, on the map edge, opens to corridor)
// Every other type (printer, yard, ...) is free-form and referenced from `activities`.
// Station lookups are scoped to the character's own branch; `inbox` always resolves to the HQ.

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
  /** Animation name -> frames. Recognised names: idle, walk, work, carry. Missing ones fall back to idle. */
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
}

export function activityDef(t: ThemeManifest, a: Activity): ActivityDef {
  const v = t.activities[a]
  return typeof v === 'string' ? { location: v } : v
}
