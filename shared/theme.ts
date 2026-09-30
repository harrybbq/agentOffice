// Theme folder format. Adding a theme = adding a folder under themes/ (or <userData>/themes/).
//
//   themes/<name>/
//     theme.json   -> ThemeManifest (below)
//     map.json     -> Tiled JSON map (orthogonal). Uses:
//                     - object layer "locations": point objects; `type` (or `class`) = location type
//                     - object layer "furniture" (optional): rectangles drawn as placeholders when
//                       there is no art; custom properties `color` (#rrggbb) and `label`
//                     - any tile layers + embedded tilesets (image paths relative to the theme folder)
//     sprites/...  -> optional sprite sheets referenced from theme.json
//
// Location types the scene relies on (map must contain them):
//   boss_seat (1), manager_seat (1 per concurrent team), desk (many), inbox (1+ memo slots),
//   entrance (1+, where characters arrive and leave)
// Every other location type is free-form and just referenced from `activities`.

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
  /** Path to Tiled JSON, relative to the theme folder. */
  map: string
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
