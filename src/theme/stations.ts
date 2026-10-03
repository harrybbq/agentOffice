// Stations from the theme: which location an event sends a character to (stationRules, then the
// activities table), what that reads as ("Copying · example.com"), and where the floating station
// tags go. Pure logic (no Phaser, no DOM), shared by the scene, the inspector and the tests.
import type { Activity } from '../../shared/events'
import { ACTIVITIES } from '../../shared/events'
import { activityDef, HOME, STATION_RULE_MAX_PATTERN } from '../../shared/theme'
import type { ActivityDef, IdleDef, StationLabel, ThemeManifest } from '../../shared/theme'

interface CompiledRule {
  activity: Activity | null
  re: RegExp
  def: ActivityDef
}

export interface Route {
  def: ActivityDef
  /** The detail to show next to the verb (a prefix the rule's verb already says is left out). */
  detail: string
  /** Index of the stationRule that matched, or null when the activities table decided. */
  rule: number | null
}

/** What a character is doing when the theme has no verb for it. */
const PLAIN_VERB: Record<Activity, string> = {
  read: 'Reading',
  write: 'Editing',
  exec: 'Running',
  web: 'Browsing',
  capture: 'Capturing',
  waiting: 'Waiting on you',
  idle: 'Idle',
  done: 'Done'
}

const HEX = /^#[0-9a-f]{6}$/i

function isActivity(v: unknown): v is Activity {
  return typeof v === 'string' && (ACTIVITIES as readonly string[]).includes(v)
}

/** Compiles a theme's stationRules once; invalid rules are skipped with a warning. */
export class StationRouter {
  private rules: { rule: CompiledRule; index: number }[] = []
  readonly idle: IdleDef | null
  readonly labels: ReadonlyMap<string, StationLabel>

  constructor(
    private manifest: ThemeManifest,
    warn: (message: string) => void = (m) => console.warn(`[agent-office] ${m}`)
  ) {
    const list: unknown = manifest.stationRules
    if (Array.isArray(list)) {
      list.forEach((r, index) => {
        const where = `stationRules[${index}]`
        if (!r || typeof r !== 'object') return warn(`${where} is not an object; ignored.`)
        const { activity, detail, location, anim, verb } = r as Record<string, unknown>
        if (typeof detail !== 'string' || typeof location !== 'string' || location.length === 0) {
          return warn(`${where} needs a "detail" pattern and a "location"; ignored.`)
        }
        if (activity !== undefined && !isActivity(activity)) return warn(`${where} has an unknown activity "${String(activity)}"; ignored.`)
        if (detail.length > STATION_RULE_MAX_PATTERN) {
          return warn(`${where}: the pattern is longer than ${STATION_RULE_MAX_PATTERN} characters; ignored.`)
        }
        let re: RegExp
        try {
          re = new RegExp(detail, 'i')
        } catch (err) {
          return warn(`${where}: invalid pattern ${JSON.stringify(detail)} (${err instanceof Error ? err.message : String(err)}); ignored.`)
        }
        this.rules.push({
          index,
          rule: {
            activity: activity ?? null,
            re,
            def: { location, anim: typeof anim === 'string' ? anim : undefined, verb: typeof verb === 'string' ? verb : undefined }
          }
        })
      })
    } else if (list !== undefined) {
      warn('stationRules is not a list; ignored.')
    }

    const idle = manifest.idle
    this.idle =
      idle && typeof idle.location === 'string' && idle.location.length > 0 && Number.isFinite(idle.afterMs) && idle.afterMs > 0
        ? { location: idle.location, afterMs: idle.afterMs }
        : null
    if (idle && !this.idle) warn('idle needs a "location" and a positive "afterMs"; ignored.')

    const labels = new Map<string, StationLabel>()
    const raw: unknown = manifest.stationLabels
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [type, v] of Object.entries(raw as Record<string, unknown>)) {
        const l = v as Partial<StationLabel> | null
        if (!l || typeof l.title !== 'string' || l.title.trim().length === 0) {
          warn(`stationLabels.${type} needs a "title"; ignored.`)
          continue
        }
        labels.set(type, {
          title: l.title.trim(),
          subtitle: typeof l.subtitle === 'string' && l.subtitle.trim() ? l.subtitle.trim() : undefined,
          color: typeof l.color === 'string' && HEX.test(l.color) ? l.color : undefined,
          once: l.once === true,
          ...(typeof l.offset === 'number' && Number.isFinite(l.offset) && l.offset !== 0 ? { offset: l.offset } : {})
        })
      }
    }
    this.labels = labels
  }

  /** The activities-table entry (home when the theme has none). */
  table(activity: Activity): ActivityDef {
    return this.manifest.activities?.[activity] ? activityDef(this.manifest, activity) : { location: HOME }
  }

  /** Where an event goes and how it reads: the first matching rule, else the activities table. */
  route(activity: Activity, detail: string): Route {
    const text = detail ?? ''
    for (const { rule, index } of this.rules) {
      if (rule.activity !== null && rule.activity !== activity) continue
      const m = rule.re.exec(text)
      if (!m) continue
      const base = this.table(activity)
      const def: ActivityDef = { location: rule.def.location, anim: rule.def.anim ?? base.anim, verb: rule.def.verb ?? base.verb }
      // The verb replaces a prefix it already says ("planning: the API" -> "Planning · the API").
      const cut = rule.def.verb && m.index === 0 && m[0].length > 0 ? text.slice(m[0].length).trim() : text
      return { def, detail: cut, rule: index }
    }
    return { def: this.table(activity), detail: text, rule: null }
  }

  /** The verb for an event: the theme's, or a plain one when the theme has none. */
  verb(activity: Activity, detail = ''): string {
    return this.route(activity, detail).def.verb?.trim() || PLAIN_VERB[activity]
  }

  /** "Copying · example.com": what an agent is doing, in the theme's words. */
  phrase(activity: Activity, detail = ''): string {
    const r = this.route(activity, detail)
    return joinPhrase(r.def.verb?.trim() || PLAIN_VERB[activity], r.detail)
  }

  /** The station an activity belongs to by default, for naming it ("Filing cabinet"). */
  stationTitle(activity: Activity): string | null {
    return this.labels.get(this.table(activity).location)?.title ?? null
  }
}

/** A tool name in front of the detail ("WebFetch: example.com") says nothing the verb doesn't. */
export function plainDetail(detail: string): string {
  return detail
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[A-Za-z][\w.-]{0,30}:\s+/, '')
}

export function joinPhrase(verb: string, detail: string): string {
  const d = plainDetail(detail)
  return d ? (verb ? `${verb} · ${d}` : d) : verb
}

// ---- label anchors -------------------------------------------------------------------------------

interface XY {
  x: number
  y: number
}
interface Box extends XY {
  width: number
  height: number
}

export interface LabelAnchor {
  /** Location type. */
  type: string
  /** Unique within the block. */
  key: string
  label: StationLabel
  /** Where the tag is pinned: the top edge of the station's furniture, or above the location. */
  x: number
  y: number
  /** The location characters stand at. */
  point: XY
  /** Every location this tag stands for (all of the type for a `once` tag). */
  points: XY[]
  /** The station's furniture (hover area), if the map has one next to the location. */
  rect: Box | null
  /** Dot colour: the label's, else the furniture's, else null (a neutral dot). */
  color: number | null
  /** Position in stationLabels (lower = kept when tags would overlap). */
  priority: number
}

function distToBox(p: XY, r: Box): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width))
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height))
  return Math.hypot(dx, dy)
}

/** Furniture this close to a location (in tiles) is taken to be its station. */
const NEAR_TILES = 1.5
/** Without furniture the tag floats this far above the location (in tiles). */
const FLOAT_TILES = 1.4

/**
 * Where the station tags of one block go. `locations` and `furniture` share a coordinate space
 * (world coordinates for a placed block).
 */
export function stationAnchors(
  block: {
    locations: ReadonlyMap<string, readonly (XY & { name: string })[]>
    furniture: readonly (Box & { solid: boolean; color: number })[]
  },
  labels: ReadonlyMap<string, StationLabel>,
  tile = 32,
  /** Is this location a seat (map property `seat`)? Its tag then goes above the sitter. */
  isSeat: (p: XY) => boolean = () => false
): LabelAnchor[] {
  const out: LabelAnchor[] = []
  const solid = block.furniture.filter((f) => f.solid)
  let priority = 0
  for (const [type, label] of labels) {
    const order = priority++
    const pts = block.locations.get(type)
    if (!pts || pts.length === 0) continue
    let chosen: readonly (XY & { name: string })[] = pts
    if (label.once) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
      let best = pts[0]
      for (const p of pts) if (Math.hypot(p.x - cx, p.y - cy) < Math.hypot(best.x - cx, best.y - cy)) best = p
      chosen = [best]
    }
    chosen.forEach((p, i) => {
      let rect: (Box & { color: number }) | null = null
      let bestD = NEAR_TILES * tile
      for (const f of solid) {
        const d = distToBox(p, f)
        if (d < bestD) {
          bestD = d
          rect = f
        }
      }
      const r = rect as (Box & { color: number }) | null
      // A seat behind its desk (above it on the map) has its tag above whoever sits there, not on
      // the desk in front of them.
      const behind = !!r && p.y < r.y && isSeat(p)
      out.push({
        type,
        key: `${type}#${i}`,
        label,
        x: r && !behind ? r.x + r.width / 2 : p.x,
        y: r && !behind ? r.y - (label.offset ?? 0) : p.y - FLOAT_TILES * tile,
        point: { x: p.x, y: p.y },
        points: (label.once ? pts : [p]).map((q) => ({ x: q.x, y: q.y })),
        rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        color: label.color ? parseInt(label.color.slice(1), 16) : r ? r.color : null,
        priority: order
      })
    })
  }
  return out
}

// ---- declutter ------------------------------------------------------------------------------------

export type LabelMode = 'hidden' | 'title' | 'full'

/** Below this zoom the tags are hidden; below the second, only their titles show. */
export const LABEL_MIN_ZOOM = 0.42
export const LABEL_FULL_ZOOM = 1.05

export function labelMode(zoom: number): LabelMode {
  if (zoom < LABEL_MIN_ZOOM) return 'hidden'
  return zoom < LABEL_FULL_ZOOM ? 'title' : 'full'
}

/**
 * Which of the (screen-space) tags to show: in priority order, a tag that would overlap one already
 * kept is dropped. `forced` tags (hovered) are always kept and placed first.
 */
export function declutter<T extends Box & { priority: number; forced?: boolean }>(tags: readonly T[], gap = 4): Set<T> {
  const kept: T[] = []
  const order = [...tags].sort((a, b) => Number(!!b.forced) - Number(!!a.forced) || a.priority - b.priority)
  for (const t of order) {
    const hit = kept.some(
      (k) => t.x < k.x + k.width + gap && k.x < t.x + t.width + gap && t.y < k.y + k.height + gap && k.y < t.y + t.height + gap
    )
    if (!hit || t.forced) kept.push(t)
  }
  return new Set(kept)
}
