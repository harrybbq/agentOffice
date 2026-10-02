# Art shortlist (research 2026-10-02)

Follows `docs/art-direction.md`. Nothing was downloaded, bought or signed up for. Every candidate below was
checked by fetching its store/licence page as text on 2026-10-02.

**Limits of this research.** Pages were read as text, not viewed. Prices, licence wording, tile sizes and
file formats are from the pages. **Perspective and visual style are from the listing's own words and file
formats, not from looking at the art**, so every style verdict needs a human look at the previews before
any purchase. Licence files inside the downloads (`LICENSE.txt`) could not be read.

## 1. What we need

Derived from `scripts/gen-office-map.cjs`, `shared/theme.ts` and `themes/office/theme.json`. Tiles are 32 px.

**Floors (tile layer):** open-plan floor, CEO office floor, reception floor, manager office floor, corridor
floor (corridors are 2 tiles wide and are laid by code, not by the map), entrance mat (2x1), and an
outdoor/ground filler for the unbuilt lot around buildings (today a flat `background` colour).

**Walls and doors:** orthogonal top-down walls as straight, corner, T and end pieces, or one 16-piece
auto-tile set. Door openings are 2 tiles wide (pathfinding needs at least 1). Today's walls are 0.25 tile
thick rectangles plus a 0.75 tile top band, so **any tile-based wall means regenerating both maps on a
whole- or half-tile grid.**

**Furniture and stations (footprint in tiles, rounded up from the generator):**

| Item | Footprint | In the map today |
|---|---|---|
| CEO desk / manager desk | 3x1 | yes |
| Worker desk + monitor | 2x1 (monitor is a 1x1 overlay) | yes, 8 per branch |
| Printer / copier | 2x2 | yes |
| Filing cabinet | 2x2 | yes |
| Server rack | 2x3 | yes |
| Photo booth | 3x2 | yes |
| Water cooler, plant | 1x1 each | yes |
| Bookshelf, memo hatch (in the CEO wall) | 2x1 each | yes |
| Chairs (desk, CEO) | 1x1 | no, wanted |
| Reception desk / security gate, whiteboard, kanban/notice board, vault door, lounge sofa | 2x1 to 3x1 | no, wanted |

**Characters:** three roles (boss at 1.15 scale, manager, worker) on a 24x32 canvas, anchored bottom-centre.
Animations `idle`, `walk`, `work`, `carry` (missing ones fall back to idle). One view is enough today; three
views (S, N, E with W mirrored) is the upgrade. Four carried props already exist (folder, report, memo, order).

**The tint constraint.** `SpriteSheet.sheet` is the BODY layer and must be white/light grey, because the
provider colour is applied with Phaser `setTint`, which multiplies. Head, outline and accessories go on the
untinted `overlay`. Team colour goes on small accents (collar, badge, clipboard). Consequence: **no
third-party character sprite found is usable as shipped.** All are pre-coloured single-layer sprites, so
each would need a body mask extracted and the body repainted grey for every frame (a palette-swap pipeline),
or we keep our procedural characters on top of third-party environment tiles. The second is far cheaper.

## 2. Candidates

**Headline finding: every paid pack forbids redistributing its files, so none can be committed to a
repository that may become public.** They would have to live in a git-ignored folder with a manual
download step, which also means a fresh clone shows placeholders. Only CC0 and plain CC-BY assets can be
committed.

Legend for "Commit to repo?": **Yes** = licence clearly allows; **No** = store page forbids distribution;
**Grey** = wording is ambiguous or not shown.

| # | Asset | Price | Licence (quoted from the page) | Commit to repo? | Tile / view (per listing) | Formats | AI | Covers / missing | Fit |
|---|---|---|---|---|---|---|---|---|---|
| 1 | [LimeZu Modern Interiors](https://limezu.itch.io/moderninteriors) | $1.50+ (free cut-down version exists) | "YOU CAN: Edit and use the asset in any commercial or non commercial project. YOU CAN'T: Resell or distribute the asset to others. Edit and resell the asset to others. Credits required." | **No.** A search summary claimed "CC-BY"; that is not on the store page, treat as false | 16/32/48 px; ships RPG Maker sheets, so 3/4 RPG view with tall walls (a "2D wall" option is also listed) | PNG sheets, RPG Maker; no Tiled files | "No generative AI was used" | Office, jail and much more; 2D and 3D walls; legged pre-coloured characters. Updated 16 days ago | Widest coverage, covers both themes. Dense detailed pixel art, not the minimal reference |
| 2 | [LimeZu Modern Office](https://limezu.itch.io/modernoffice) | $2.50 (on sale from $5) | "You CAN use the asset in any commercial or non commercial project", "You CAN'T resell or distribute the asset to others"; credit required | **No** | 16 px base, supplied at 16/32/48; 3/4 RPG | PNG, RPG Maker MV | No AI | 300+ office sprites; no characters; last update Dec 2020 | Same style as #1; optional add-on |
| 3 | [Pixel Office 32x32 (Masalimov Ilnur)](https://masalimov-ilnur.itch.io/pixel-office) | $5+ | "You can modify the assets for your projects", "Credit is appreciated but not required"; redistribution and resale of original files prohibited | **No** | Native 32 px; "top-down" | PNG sheets, Unity package | No AI | Walls, floors, windows, doors, desks, chairs, shelves, cabinets, computers, plants; 5 animated + 3 seated characters. Missing: server rack, printer, photo booth, vault (not listed) | Best native-32 px office pack. Pixel art, not flat |
| 4 | [Office Interior Tileset (Donarg)](https://donarg.itch.io/officetileset) | $2+ | "You CAN edit and use this tileset for commercial and non-commercial projects." "You CAN NOT resell and distribute this tileset to others (even if edited)." | **No** (explicitly, even edited) | 16/32/48 px; RPG Maker layout, so 3/4 | PNG, RPG Maker VX Ace | No AI | Desks, meeting tables, chairs, computers, printers, coffee machines, 17 floors, shadows. No characters | Cheap, decent coverage |
| 5 | [Pixel Office & Dungeon (operationcwal)](https://operationcwal.itch.io/pixel-office-dungeon-top-down-asset-pack) | $4.99+ | "Modify and extend freely. Credit appreciated but not required. Do not resell, redistribute, or repackage the assets as-is." | **Grey**, treat as No | 16 px and 32 px exports; "3D wall tileset" suggests 3/4 | PNG, **Tiled .tsx**, JSON frame data | Tagged **AI Assisted** (described as code-drawn) | Office, walls (15 pieces x 6 colours), layered character generator, typing/reading/carry animations in 4 directions | Only pack with our exact animations and Tiled files. Layered generator might allow a grey body layer (unverified) |
| 6 | [Verdant 14 Institutional (CSAF)](https://csaf.itch.io/verdant-14-institutional) | $12.99 | "Commercial use permitted, unlimited projects, no attribution required. You may not resell or redistribute the pack itself as an asset pack." | **Grey** (a repo is not an asset pack, but the PNGs would be freely downloadable); full terms in an unread LICENSE.txt | 16 px only (needs 2x scaling) | **Tiled .tsx/.tmx**, Godot, RPG Maker, PNG | Generated by code; listing carries itch's AI tag | 6 floor materials, 11 full 47-mask auto-tile sets (partitions, glazing), only 20 objects (server racks, monitors, photocopiers) | Strong on floors and walls, thin on furniture, most expensive |
| 7 | [Verdant 20 Prison (CSAF)](https://csaf.itch.io/verdant-20-prison) | $12.99 | "Unlimited projects, no attribution required", "You may not resell or redistribute the pack itself" | **Grey**, as #6 | 16 px | Tiled .tsx/.tmx, Godot, RPG Maker, PNG | As #6 | 750 tiles, 12 auto-tile sets, 36 objects: cellblock, bars, yard | Prison theme only. Still exists, price unchanged |
| 8 | [Kenney Roguelike Indoors](https://kenney.nl/assets/roguelike-indoors) and [RPG Urban Pack](https://kenney.nl/assets/rpg-urban-pack) | Free | "Creative Commons CC0"; "Attribution is not required" | **Yes** | 16 px; 3/4 RPG | PNG sheet | Not stated (2015 and 2019) | 480 tiles each: tables, chairs, sofas, kitchen; Urban has buildings and small characters. No office machines | Clean and flat-ish but tiny and domestic |
| 9 | [Kenney Top-down Shooter](https://kenney.nl/assets/top-down-shooter) | Free | CC0 | **Yes** | Size not stated on the page; seen from directly overhead | 580 PNGs, sheets, vector source | Not stated (2016) | Floor tiles, some furniture, people seen from above (head and shoulders) | **Correction to art-direction.md:** this is not Prison Architect's construction (a front-facing blob with the head on top). Smooth vector look is useful for floors only |
| 10 | [Pixel Office Asset Pack (2dPig)](https://2dpig.itch.io/pixel-office) | Pay what you want | CC0, "No attribution is required but it is greatly appreciated" | **Yes** | Not a grid tileset; "top-down" | PNG, Aseprite | No AI | Furniture, computers, plants, decor, 5 characters, example scene. No walls or floors stated | Best CC0 office props; needs manual slicing |
| 11 | [Indoor Office Appliances (semtex99)](https://opengameart.org/content/indoor-office-appliances) | Free | CC0 | **Yes** | 32 px; view not stated | One PNG | Not stated (2020) | "indoor office / factory decorations" | Filler only. Still exists |
| 12 | [Free Furniture Office Equipment (Antea)](https://stcrbcn.itch.io/furniture-office-set) | Free | CC BY 4.0: "distribute, remix, adapt, and build upon the material ... so long as attribution is given" | **Yes**, with credit | 16 and 32 px; "top-down" | Aseprite source | No AI | 40+ sprites: cabinets, printers, vending machines, desks, chairs, bookshelves, wall notes. No floors, walls or characters | Good free furniture set |
| 13 | [Pixel Art Lab/Office Tiles (The Leafy Lemur)](https://opengameart.org/content/pixel-art-laboffice-tiles) | Free | CC-BY 3.0, "please remember to credit me" | **Yes**, with credit | 32 px top-down | One 8.5 kB PNG | Not stated | A few floor and wall tiles | Very small |
| 14 | [Modern Office 2D Top-Down Props (nacl1234)](https://nacl1234.itch.io/top-down-modern-office-2d-asset-pack) | Pay what you want | **No licence terms on the page** | **Grey**, do not use without asking the author | High-res "flat-cartoon", top-down | PNGs, grid sheet and atlas with JSON | Tagged **AI Assisted** | 68 props: furniture, electronics, desk items, plants. No walls, floors or characters | **The only flat-style candidate, so closest to the reference on paper**, but no licence and AI-made |
| 15 | [Pixel Life: Office Essentials (Chris Perich)](https://christianperich.itch.io/pixel-life-office-essentials) | PWYW, tiers $3.99 / $5.99 | Listed as CC BY 4.0 but also says "No resale or redistribution of standalone files" (contradictory) | **Grey** | 32 px top-down | PNG, Aseprite | No AI | Desks, seating, storage, tech, floors, doors | Ask the author before relying on it |
| 16 | [Base Building Tileset (elihaun)](https://elihaun.itch.io/base-building-tileset) | PWYW | **None stated** (unchanged) | **Grey** | 16 px, RimWorld-like | One 16 kB PNG | No AI | Walls, floors, furniture, workstations, 4 pawns | Reference only |

Also checked: [Cozy Space Station](https://aquumgifts.itch.io/cozy-space-station) (free, 39 "soft, clean"
sprites, licence only as "see LICENSE.txt", unverified); lennoxstudio's corporate office packs ($2.99 each,
tagged AI Assisted, no licence text on the page); CraftPix (no top-down office set found; its licence says
"You can not redistribute the art ... in a manner that would make some or all of the art files useable to
another end user", so **No** for a repo); a GameDevMarket office tileset (page returned 403, unverified).

**Re-check of `art-direction.md`:** all eight earlier candidates still exist. Changes: Modern Office is $2.50
on sale; Pixel Office & Dungeon is confirmed to have 32 px exports and Tiled files; LimeZu's terms forbid
distribution (the old table only said "credit required"); the Kenney Top-down Shooter note was wrong (row 9).
Precedent, not permission: the public repo `MantejGill/munder-difflin` (a similar agents-in-an-office app)
bundles LimeZu Modern Interiors with a `LICENSE-ASSETS` carve-out. That contradicts the store wording.

## 3. Three options

Each option is tested against: (a) can the PNGs be committed, (b) does the white-body tint work, (c) how
close is it to the reference (clean, bright, flat, soft shadows, rounded solid-colour characters).

### A. One bought environment pack + our procedural characters

- **Pack:** LimeZu Modern Interiors ($1.50) plus Modern Office ($2.50), **$4.00 total**, because it is the
  only pack covering both the office and the prison (jail set) in one style, with no AI involved.
  Alternative if native 32 px matters more than prison coverage: Pixel Office 32x32 at $5.
- **Still to draw:** all characters (restyled with a pixel outline to sit on pixel art), probably the photo
  booth, memo hatch and vault, team-colour signs, and both maps rebuilt by hand in Tiled.
- **(a) No.** Assets stay in a git-ignored `themes/office/vendor/` with a documented download step and a
  `CREDITS.md`; credit to LimeZu is mandatory. A clone of the repo falls back to placeholders.
- **(b) Yes**, because characters stay ours.
- **(c) Weak.** Detailed 3/4 pixel art is the opposite of minimal and flat. Professional, but a different taste.
- **Loader work: the most.** First real use of tile layers and embedded tilesets (never exercised).
  3/4 furniture needs Y-sorted depth: characters already use `setDepth(y)` (`src/scene/Character.ts`) but
  tile layers are all drawn at depth -1000, so tall furniture and wall tops would need an "above" layer or
  per-object sprites. Whole-tile walls mean new maps and collision rectangles. No Tiled files ship with
  LimeZu, so tilesets must be assembled by hand.

### B. All free, committable (CC0 / CC-BY)

- **Mix:** Kenney Roguelike Indoors and RPG Urban for floors and walls, 2dPig Pixel Office (CC0) and Antea's
  furniture (CC BY 4.0) for office props, our procedural characters.
- **Cost:** $0. **(a) Yes**, with a `CREDITS.md`. **(b) Yes.**
- **(c) Poor.** Three or four artists, two tile sizes (16 px scaled 2x beside 32 px), different palettes and
  outline weights. It would read as a collage. Gaps: server rack, photo booth, water cooler, vault, security
  gate, whiteboard, and everything the prison needs.
- **Loader work:** same tile-layer and depth work as A, plus slicing loose sprites into a sheet.

### C. Fully self-made, generated in code

A script `scripts/gen-office-art.cjs` in the manner of `scripts/gen-logo.cjs`: it writes SVG, and the existing
Electron renderer path (`scripts/render-icons.cjs`, no extra dependencies) turns it into PNG sheets inside
`themes/office/`. The art is still plain files in the theme folder, so **the theme stays swappable** and a
later theme can use bought art.

Sprites to draw:

| Sheet | Contents | Size |
|---|---|---|
| `tiles.png` | 5 floors (open plan, CEO, manager, reception, corridor), ground filler, entrance mat (2 tiles), 16-piece wall auto-tile with a soft inner shadow, door threshold, 2 floor-shadow tiles | 32x32 each, about 30 tiles |
| `furniture.png` | desk 2x1, big desk 3x1, monitor, chair (4 facings), printer 2x2, filing cabinet 2x2, server rack 2x3 (2 blink frames), photo booth 3x2, water cooler, plant, bookshelf 2x1, memo hatch 2x1, reception desk 3x1, whiteboard 2x1, kanban board 2x1, vault door 2x2, sofa 2x1 | about 20 sprites, each with a baked soft drop shadow |
| `chars-body.png` + `chars-overlay.png` | rounded body (white, one grey shade band) and head/outline/accessory; frames: idle 2, walk 2 (bob), work 2 (typing), carry 2, sitting 1; one view first, 3 views later | 24x32 per frame (28x37 for the boss) |

- **Cost:** $0. **(a) Yes**, no licence at all to track. **(b) Perfect**, the sheets are designed for it.
- **(c) Closest of the three.** The reference is flat vector with soft shadows, which is exactly what
  code-drawn SVG produces well; no pixel pack found matches it.
- **Honest quality judgement:** flat shapes, rounded corners, a consistent palette and soft shadows will look
  clean and intentional, comparable to the reference. It will not have the hand-drawn charm or item density
  of LimeZu, and complex objects (photo booth, plants) will look schematic unless iterated. Quality depends on
  2 to 3 review rounds with the user looking at screenshots.
- **Effort:** roughly 2 to 3 working sessions: generator and tiles, furniture, characters and loader fixes.
- **Loader work: the least.** True top-down, so no depth sorting beyond what exists; the same generator
  can emit the Tiled maps with tile layers, so walls and collisions stay in step. Two real tasks: exercise
  the tile-layer and sprite-sheet paths for the first time, and decide rendering (flat vector art wants
  smoothing, while `art-direction.md` specifies `pixelArt: true`; render sheets at 2x or make it a theme flag).

| | Cost | Licence risk | Commit PNGs | Loader work | Close to reference |
|---|---|---|---|---|---|
| A | $4 to $5 | low if kept local, real if committed | no | high | low to medium |
| B | $0 | none (credits file) | yes | high | low |
| C | $0 | none | yes | low to medium | high |

## 4. Recommendation

**Option C.** It is the only option that satisfies all three tests: the art can be committed to a public
repo, it fits the tint and team-colour system by construction, and flat code-drawn shapes are the nearest
match to the reference image. It also avoids the depth-sorting and hand-built-tileset work that a 3/4 pixel
pack brings. The risk is that it looks schematic; that is managed by doing the open-plan room first (floor,
walls, desk, chair, monitor, one worker) and showing a screenshot before drawing the rest.

Fallback if the user prefers bought art after seeing that first room: Option A with LimeZu ($4.00), kept
out of the repository.

**Needed from the user (pick one):**
1. A go for the self-made route (no purchases), and the reference image saved into `docs/` so colours and
   shadow softness can be matched.
2. Or approval to buy LimeZu Modern Interiors + Modern Office ($4.00), accepting that the art stays local.
3. Either way: confirm whether the repo will be public, since that rules out committing any paid pack.

## 5. Appendix: prison theme

Needs: cell floor and bars (bars as a wall variant that characters can be seen through), cell door, bunk,
toilet, yard ground with fence, guard post, warden office (reuses the big desk), workshop bench, library
shelves, canteen table; roles warden (peaked cap), guard (cap + baton), prisoner (number patch), all already
supported by the procedural accessories.

- **Verdant 20 Prison** ($12.99, 16 px, Tiled-ready): cellblock, bars and yard; furniture coverage unverified.
- **LimeZu Modern Interiors**: has a jail set (cell bars, animated door) in the same style as its office.
- **Kenney / other CC0:** nothing found for cells or bars.
- **Option C:** about 12 more sprites in the same generator (bars are easy in flat style); one shared
  palette and wall auto-tile keeps both themes consistent at no cost.
