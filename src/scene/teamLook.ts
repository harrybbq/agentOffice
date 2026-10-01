// Per-team identity: a team colour and a distinct manager head. Pure logic (no Phaser).
//
// Picks are deterministic (hash of the team id first, then the next free option), so a team keeps
// its look across reloads, and unique among live teams while the options last.

export const HAIR_STYLES = ['short', 'bald', 'bun', 'spiky', 'cap', 'long'] as const
export type HairStyle = (typeof HAIR_STYLES)[number]

export const HAIR_COLORS = [0x1b1b1b, 0x5a3825, 0xe3c565, 0xb5491d, 0x9e9e9e, 0x2e4a7a] as const
export const SKIN_TONES = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xd9a066] as const

/** Head variant for the procedural placeholder. Indices into the tables above. */
export interface HeadLook {
  style: HairStyle
  hair: number
  skin: number
}

export interface TeamLook {
  /** Index into the theme's team colour palette. */
  color: number
  head: HeadLook
}

export function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** First index from `start` (wrapping) that `free` accepts, or `start` if none does. */
function firstFree(n: number, start: number, free: (i: number) => boolean): number {
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (free(i)) return i
  }
  return start % n
}

export class TeamLooks {
  private looks = new Map<string, TeamLook>()

  constructor(private paletteSize: number) {}

  get(teamId: string): TeamLook | undefined {
    return this.looks.get(teamId)
  }

  /** The team's look, assigned on first use. */
  ensure(teamId: string): TeamLook {
    const held = this.looks.get(teamId)
    if (held) return held
    const h = hashId(teamId)
    const used = [...this.looks.values()]
    const n = Math.max(1, this.paletteSize)
    const color = firstFree(n, h % n, (i) => !used.some((l) => l.color === i))
    const ns = HAIR_STYLES.length
    const nh = HAIR_COLORS.length
    const style = firstFree(ns, (h >>> 8) % ns, (i) => !used.some((l) => l.head.style === HAIR_STYLES[i]))
    // Hair colour: prefer one no live manager with the same style has, then one nobody has.
    const startHair = (h >>> 16) % nh
    const sameStyle = used.filter((l) => l.head.style === HAIR_STYLES[style])
    let hair = firstFree(nh, startHair, (i) => !used.some((l) => l.head.hair === i))
    if (sameStyle.some((l) => l.head.hair === hair)) {
      hair = firstFree(nh, startHair, (i) => !sameStyle.some((l) => l.head.hair === i))
    }
    const skin = (h >>> 24) % SKIN_TONES.length
    const look: TeamLook = { color, head: { style: HAIR_STYLES[style], hair, skin } }
    this.looks.set(teamId, look)
    return look
  }

  /** The team has left: its colour and head become available again. */
  release(teamId: string): void {
    this.looks.delete(teamId)
  }
}
