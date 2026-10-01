// Who may walk where. Pure logic (no Phaser).
//
// - full:     every built block + every built corridor (office-wide orders, workers walking home)
// - branch:   one branch interior only: where workers live in normal mode (no corridors, no HQ)
// - manager:  the HQ + corridors + the manager's own branch. Other branches are never walkable for
//             a manager, so no branch is a thoroughfare even if a corridor passes its door.
import type { Rect } from '../theme/parse'
import type { Block } from './layout'
import { buildNav } from './corridors'
import type { NavGrid } from './pathfinding'

export class NavScopes {
  private cache = new Map<string, NavGrid>()

  constructor(
    private bounds: Rect,
    /** Built blocks (walkable interiors), HQ included. */
    private blocks: Block[],
    /** Built corridor cell rects. */
    private corridorRects: Rect[]
  ) {}

  full(): NavGrid {
    return this.get('full', () => buildNav(this.bounds, this.blocks, this.corridorRects))
  }

  /** Inside one branch only. Unknown/unbuilt branch -> nothing walkable. */
  branch(id: string): NavGrid {
    return this.get(`b:${id}`, () =>
      buildNav(
        this.bounds,
        this.blocks.filter((b) => b.id === id),
        []
      )
    )
  }

  /** HQ + corridors + the team's own branch. */
  manager(teamId: string): NavGrid {
    return this.get(`m:${teamId}`, () =>
      buildNav(
        this.bounds,
        this.blocks.filter((b) => b.kind === 'hq' || b.id === teamId),
        this.corridorRects
      )
    )
  }

  private get(key: string, make: () => NavGrid): NavGrid {
    let g = this.cache.get(key)
    if (!g) this.cache.set(key, (g = make()))
    return g
  }
}
