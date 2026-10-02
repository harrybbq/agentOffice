# Art direction (research 2026-09-30)

> **Update 2026-10-02.** The user chose self-made art drawn in code (option C in `art-shortlist.md`) with a
> smooth, flat, soft-shadow look instead of pixel art. What still holds below: orthogonal top-down, 32 px
> tiles, no legs, the two colour axes and the white body layer. What changed: no dark outlines (a soft rim in
> a darker shade of the same colour), art drawn at 2x-4x and filtered (`pixelArt: false`, mip-maps) instead of
> `pixelArt: true`. A preview of one room is in `docs/art-preview/`.

## Direction: Prison Architect / RimWorld style
- Orthogonal top-down (not isometric), thick flat walls, and props cheated slightly so their fronts show.
- Characters have no legs: a rounded body blob with a big oval head on top. Walking is a slide plus a 1 px bob, so there's no walk cycle to draw.
- Muted floors (concrete, lino) so uniform colours pop. Thin dark outline, flat fill, one shade band, soft drop shadow.
- PA shows roles purely by uniform colour (prisoners: grey/orange/red). Refs: en.wikipedia.org/wiki/Prison_Architect,
  prisonarchitect.paradoxwikis.com/Prisoner, ryansumo.blogspot.com (2012 "On Introversion and Prison Architect").

## Two colour axes
- **Provider = body colour.** The body layer is drawn white/light grey and tinted with Phaser `setTint`, which multiplies, so a pre-coloured body would go muddy.
- **Role = silhouette + accessory.** CEO tie, manager clipboard, warden peaked cap, guard cap + baton, prisoner shaved head/number patch.
- Budget: about 6-8 clearly different provider colours before they collide.
- Prison: the prisoner body takes the provider colour, so we drop the orange-uniform convention because it reads better at small size.

## Sprite spec (self-made / commission)
- Canvas 24x32 for 32 px tiles (16x24 for 16 px), anchored bottom-centre.
- Layers, bottom to top: shadow ellipse -> body (white, tinted) -> outline/shading (untinted) -> head/skin -> role accessory -> carried item.
- Views S / N / E (W = E mirrored), or a single view.
- Frames: idle 1-2, walk 2 (bob), work 2-4, carry = walk + item layer.
- Phaser config: `pixelArt: true`, `roundPixels: true`.

## Asset candidates (ask before buying/downloading)
| Asset | Price | Licence | Notes |
|---|---|---|---|
| LimeZu Modern Interiors https://limezu.itch.io/moderninteriors | $1.50+ | commercial OK, credit required | 16/32/48 px, 3/4 RPG; includes a jail update (cell bars, animated door); legged characters |
| LimeZu Modern Office https://limezu.itch.io/modernoffice | ~$2.50-5 | commercial OK, credit required | office props, no characters |
| Verdant 20 Prison https://csaf.itch.io/verdant-20-prison | $12.99 | commercial OK, no attribution | 16 px top-down, ships Tiled .tsx/.tmx |
| Kenney Top-down Shooter https://kenney.nl/assets/top-down-shooter | free | CC0 | overhead people, closest construction to PA; vector source |
| Kenney Roguelike Indoors / RPG Urban | free | CC0 | placeholder furniture/buildings |
| Indoor Office Appliances https://opengameart.org/content/indoor-office-appliances | free | CC0 | 32 px office props |
| Pixel Office & Dungeon (operationcwal) | $4.99+ | commercial OK | walk/typing/carry anims; tagged "AI Assisted"; perspective unverified |
| Base Building Tileset (elihaun) | PWYW | **no licence stated** | RimWorld-like; ask the author first |

No verified pack has PA-style tinted-body characters, so plan to make characters procedurally or commission them. Tilesets can come from a pack.
