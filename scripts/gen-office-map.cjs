// Generates the office theme's maps as Tiled 1.10 JSON:
//   themes/office/hq.json      CEO office (sealed) + reception with the memo inbox
//   themes/office/branch.json  one team's branch, stamped out per active session
// Stations are just furniture + a location point: what they are called, who goes there and when is
// in themes/office/theme.json (stationLabels, stationRules, idle).
// Art: the branch points at pictures made by scripts/gen-office-art.cjs (an image layer for the
// floor and walls, `sprite` names for furniture). That script reads branch.json, so run this one
// first. Everything that has no picture yet is still drawn as a coloured rectangle.
const fs = require('fs')
const path = require('path')
const T = 32
const WALL = 0.25 // wall thickness in tiles
const WALL_COLOR = '#5c5470'

function builder(W, H) {
  let id = 1
  const furn = [], walls = [], locs = [], images = []
  // art: { sprite, ysort, fallback } (see the header of shared/theme.ts)
  const props = (color, label, solid, art = {}) => [
    { name: 'color', type: 'color', value: color },
    { name: 'label', type: 'string', value: label },
    { name: 'solid', type: 'bool', value: solid },
    ...(art.sprite ? [{ name: 'sprite', type: 'string', value: art.sprite }] : []),
    ...(art.ysort ? [{ name: 'ysort', type: 'bool', value: true }] : []),
    ...(art.fallback ? [{ name: 'fallback', type: 'bool', value: true }] : []),
    ...(art.fps ? [{ name: 'fps', type: 'float', value: art.fps }] : [])
  ]
  const box = (name, tx, ty, tw, th) => ({ id: id++, name, x: tx * T, y: ty * T, width: tw * T, height: th * T, rotation: 0, visible: true })
  const b = {
    /** Decorative floor area (walkable). */
    area: (name, tx, ty, tw, th, color, label = '', art) => furn.push({ ...box(name, tx, ty, tw, th), type: 'area', properties: props(color, label, false, art) }),
    /** Furniture: characters path around it. */
    item: (name, tx, ty, tw, th, color, label = '', art) => furn.push({ ...box(name, tx, ty, tw, th), type: 'furniture', properties: props(color, label, true, art) }),
    /** A picture of the floor and walls under everything; `margin` map px stick out on every side. */
    image: (name, file, margin, scale) => images.push({ id: 0, name, type: 'imagelayer', image: file, opacity: 1, visible: true,
      x: 0, y: 0, offsetx: -margin, offsety: -margin,
      properties: [{ name: 'scale', type: 'float', value: scale }, { name: 'walls', type: 'bool', value: true }] }),
    wall: (name, tx, ty, tw, th) => walls.push({ ...box(name, tx, ty, tw, th), type: 'wall', properties: [{ name: 'color', type: 'color', value: WALL_COLOR }] }),
    /** A location; `look` = { seat: 'north'|'south' } (sits there) or { facing } (looks that way). */
    pt: (type, tx, ty, name = type, look = {}) => {
      const properties = Object.entries(look).map(([k, v]) => ({ name: k, type: 'string', value: v }))
      locs.push({ id: id++, name, type, x: Math.round(tx * T), y: Math.round(ty * T), width: 0, height: 0, point: true, rotation: 0, visible: true,
        ...(properties.length ? { properties } : {}) })
    },
    /** Outer walls with door gaps: gaps = { top|bottom: [[from,to]], left|right: [[from,to]] } in tiles. */
    outline(gaps = {}) {
      const run = (side, len, place) => {
        const gs = (gaps[side] || []).slice().sort((a, c) => a[0] - c[0])
        let at = 0
        for (const [g0, g1] of gs) { if (g0 > at) place(at, g0 - at); at = g1 }
        if (at < len) place(at, len - at)
      }
      run('top', W, (x, w) => b.wall('wall_top', x, 0, w, WALL))
      run('bottom', H, () => {}) // placeholder, bottom handled below
      run('bottom', W, (x, w) => b.wall('wall_bottom', x, H - WALL, w, WALL))
      run('left', H, (y, h) => b.wall('wall_left', 0, y, WALL, h))
      run('right', H, (y, h) => b.wall('wall_right', W - WALL, y, WALL, h))
    },
    write(file) {
      const layer = (lid, name, objects, visible = true) =>
        ({ id: lid, name, type: 'objectgroup', draworder: 'index', opacity: 1, visible, x: 0, y: 0, objects })
      const imgs = images.map((l, i) => ({ ...l, id: 4 + i }))
      const map = {
        type: 'map', version: '1.10', tiledversion: '1.11.0', orientation: 'orthogonal', renderorder: 'right-down',
        width: W, height: H, tilewidth: T, tileheight: T, infinite: false, nextlayerid: 4 + imgs.length, nextobjectid: id,
        layers: [...imgs, layer(1, 'furniture', furn), layer(2, 'walls', walls), layer(3, 'locations', locs, false)],
        tilesets: []
      }
      fs.writeFileSync(path.join(__dirname, '..', 'themes', 'office', file), JSON.stringify(map, null, 1))
      console.log(file, `${W}x${H}`, 'furniture', furn.length, 'walls', walls.length, 'locations', locs.length)
    }
  }
  return b
}

// ---- HQ: 10 x 8 tiles ------------------------------------------------------------------------
{
  const W = 10, H = 8
  const b = builder(W, H)
  b.image('floor', 'art/hq-floor.png', 24, 2)
  b.area('floor', 0, 0, W, H, '#e9e4d8', '', { fallback: true })
  b.area('ceo_room', 0, 0, W, 5, '#d8cfae', '', { fallback: true })
  b.area('reception', 0, 5.25, W, 2.75, '#e0d9c6', '', { fallback: true })
  b.wall('top_band', 0, 0, W, 0.75)
  b.outline({ bottom: [[4, 6]], left: [[5.75, 7.5]], right: [[5.75, 7.5]] })
  // CEO office: sealed, no door. Agents can never enter.
  b.wall('ceo_wall_bottom', 0, 5, W, WALL)
  b.area('ceo_rug', 2.7, 1.05, 4.6, 3.2, '#b5838d', '', { fallback: true }) // part of the floor picture
  b.area('ceo_chair', 4.55, 0.85, 0.9, 1.0, '#5b3a2e', '', { sprite: 'chair_ceo' })
  b.item('ceo_desk', 3.5, 2.3, 3, 1, '#8d6e63', '', { sprite: 'desk_ceo', ysort: true })
  b.item('plant', 0.6, 1.1, 0.7, 0.7, '#6a994e', '', { sprite: 'plant_tall' })
  b.item('bookshelf', 8, 0.8, 1.6, 0.6, '#7f5539', '', { sprite: 'bookshelf' })
  b.area('ceo_plant', 9.0, 3.9, 0.7, 0.7, '#6a994e', '', { sprite: 'plant' })
  b.area('ceo_armchair', 0.55, 3.05, 1.0, 1.0, '#8d6e63', '', { sprite: 'armchair' })
  b.pt('boss_seat', 5, 1.6, 'boss_seat', { seat: 'south' })
  // The security gate in the CEO's wall: requests queue outside it.
  b.item('memo_hatch', 4, 4.6, 2, 0.6, '#c9b458', '', { sprite: 'security_gate' })
  for (let i = 0; i < 6; i++) b.pt('inbox', 1.25 + i * 1.5, 6.1, 'inbox_' + (i + 1), { facing: 'north' })
  // The office board, on the reception's front wall (clear of the gate): notes fly here.
  b.item('notice_board', 6.8, 7.45, 2.2, 0.3, '#f2c94c', '', { sprite: 'notice_board' })
  b.pt('noticeboard', 7.9, 7, 'noticeboard', { facing: 'south' })
  b.area('reception_plant', 2.3, 6.95, 0.7, 0.7, '#6a994e', '', { sprite: 'plant' })
  // Doors open onto the corridor
  b.pt('door', 5, H, 'door_bottom')
  b.pt('door', 0, 6.6, 'door_left')
  b.pt('door', W, 6.6, 'door_right')
  b.write('hq.json')
}

// ---- Branch: 18 x 13 tiles -------------------------------------------------------------------
//
//    0     6        10  12            18
//  0 +-----+---------+==+-------------+     == door gaps (top 10-12, right 5-7, bottom 7-9,
//    | Mgr | printer      filing  srv |        left 7.5-9.5)
//    |     |                          |
//  5 +- ---+           whiteboard     =
//    |                                =
//  7 = d1  d2  d3  d4        lounge   |
//    =                       (sofa)   |
// 10 | d5  d6  d7  d8                 |
//    |                                |
// 12 | photo        kanban      vault |
// 13 +---------==---------------------+
// (13 tiles high keeps the left door level with the HQ's side doors: a straight corridor.)
{
  const W = 18, H = 13
  const b = builder(W, H)
  // Floor + walls picture (2x the map's size, 24 px of margin for the outside walls and their fronts).
  b.image('floor', 'art/branch-floor.png', 24, 2)
  b.area('floor', 0, 0, W, H, '#e9e4d8', '', { fallback: true })
  b.outline({ bottom: [[7, 9]], top: [[10, 12]], left: [[7.5, 9.5]], right: [[5, 7]] })
  // Manager office with a door
  b.area('mgr_room', 0, 0, 6, 5, '#d7e3e8', '', { fallback: true })
  b.wall('mgr_wall_right', 6 - WALL, 0, WALL, 5 + WALL)
  b.wall('mgr_wall_bl', 0, 5, 2, WALL)
  b.wall('mgr_wall_br', 3.5, 5, 2.5, WALL)
  b.area('mgr_chair', 2.6, 0.75, 0.8, 0.95, '#5d6b82', '', { sprite: 'chair_manager' })
  // The desk stands in front of whoever sits behind it, so it is drawn over them (ysort).
  b.item('mgr_desk', 1.5, 2.2, 3, 1, '#795548', '', { sprite: 'desk_manager', ysort: true })
  b.pt('manager_seat', 3, 1.5, 'manager_seat', { seat: 'south' })
  b.area('mgr_plant', 0.45, 0.75, 0.7, 0.7, '#6a994e', '', { sprite: 'plant' })
  b.area('mgr_shelf', 4.2, 0.62, 1.4, 0.45, '#8d6e63', '', { sprite: 'shelf_low' })
  // Stations along the top wall
  b.item('printer', 6.75, 0.6, 2, 1.4, '#90a4ae', '', { sprite: 'printer' })
  b.pt('printer', 7.75, 2.7, 'printer', { facing: 'north' })
  b.item('filing', 12.6, 0.6, 1.6, 1.4, '#a1887f', '', { sprite: 'filing_cabinet' })
  b.pt('filing_cabinet', 13.4, 2.7, 'filing_cabinet', { facing: 'north' })
  b.item('server_rack', 16.3, 0.6, 1.2, 2.4, '#546e7a', '', { sprite: 'server_rack', fps: 1.6 })
  b.pt('server_room', 15.7, 2.4, 'server_room', { facing: 'east' })
  // A freestanding whiteboard in the open space
  b.item('whiteboard', 12.4, 3.85, 2.6, 0.3, '#f5f7fa', '', { sprite: 'whiteboard' })
  b.item('whiteboard_foot_l', 12.5, 4.15, 0.2, 0.2, '#90a4ae', '', { fallback: true }) // in the picture
  b.item('whiteboard_foot_r', 14.7, 4.15, 0.2, 0.2, '#90a4ae', '', { fallback: true })
  b.pt('whiteboard', 13.7, 5.05, 'whiteboard', { facing: 'north' })
  // Lounge: a rug, a sofa and the water cooler
  b.area('lounge_rug', 13.5, 7.4, 4.1, 3, '#d9e4d2', '', { fallback: true }) // part of the floor picture
  // Only the sofa's backrest and armrests block (all on whole path cells): the cushions are floor to
  // walk onto, one seat each. The picture of the whole sofa hangs down from the backrest.
  b.item('sofa', 14, 7.5, 3, 0.5, '#e07a5f', '', { sprite: 'sofa' })
  b.item('sofa_arm_l', 14, 8, 0.375, 0.5, '#c06e56', '', { fallback: true }) // in the picture
  b.item('sofa_arm_r', 16.625, 8, 0.375, 0.5, '#c06e56', '', { fallback: true })
  b.area('sofa_seat', 14.375, 8, 2.25, 0.5, '#e69c84', '', { fallback: true })
  for (let i = 0; i < 3; i++) b.pt('lounge', 14.75 + i * 0.75, 8.25, 'sofa_' + (i + 1), { seat: 'south' })
  b.item('water', 13.75, 9.6, 0.7, 0.7, '#81d4fa', '', { sprite: 'water_cooler' })
  b.pt('water_cooler', 14.1, 10.8, 'water_cooler', { facing: 'north' })
  // Resting is the sofa or a drink: a lounge spot beside the cooler (so it stays in view), facing it,
  // far enough down that the names of those standing there clear the sofa.
  b.pt('lounge', 15, 10.3, 'cooler', { facing: 'west' })
  // Desks: 2 rows x 4 columns
  let d = 0
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
    const x = 0.75 + c * 3, y = 6.2 + r * 2.9
    b.item('desk_' + (++d), x, y, 2, 1, '#a1887f', '', { sprite: ['desk', 'desk_b', 'desk_c'][(c + r * 2) % 3] })
    b.item('monitor_' + d, x + 0.7, y + 0.1, 0.6, 0.35, '#263238', '', { fallback: true }) // on the desk picture
    // The chair is two pictures: the seat under whoever sits there, the backrest in front of them.
    b.area('chair_' + d, x + 0.65, y + 1.0, 0.7, 0.6, '#8e9bb3', '', { sprite: 'chair_seat' })
    b.area('chair_back_' + d, x + 0.65, y + 1.4, 0.7, 0.3, '#73819b', '', { sprite: 'chair_back', ysort: true })
    b.pt('desk', x + 1, y + 1.6, 'desk_' + d, { seat: 'north' })
  }
  // Plants (decoration only: nobody paths around them)
  b.area('plant_door', 0.45, 5.45, 0.7, 0.7, '#6a994e', '', { sprite: 'plant' })
  b.area('plant_printer', 9.05, 0.75, 0.7, 0.7, '#6a994e', '', { sprite: 'plant' })
  // Along the bottom wall: photo booth, the kanban wall, the vault
  b.item('photo_booth', 0.6, 11.25, 2.2, 1.4, '#b39ddb', '', { sprite: 'photo_booth' })
  b.pt('photo_booth', 3.5, 12, 'photo_booth', { facing: 'west' })
  b.item('kanban_wall', 10.2, 12.35, 2.8, 0.4, '#f2c94c', '', { sprite: 'kanban' })
  b.pt('noticeboard', 11.6, 11.85, 'noticeboard', { facing: 'south' })
  b.item('vault', 15.6, 10.95, 1.9, 1.65, '#78909c', '', { sprite: 'vault' })
  b.item('vault_door', 16.25, 11.5, 0.6, 0.6, '#455a64', '', { fallback: true }) // in the picture
  b.pt('vault', 14.9, 12, 'vault', { facing: 'east' })
  b.area('mat', 7, 12, 2, 1, '#6d4c41', 'Entrance', { sprite: 'mat' })
  b.pt('entrance', 8, 12.3)
  b.pt('door', 8, H, 'door_bottom')
  b.pt('door', 11, 0, 'door_top')
  b.pt('door', 0, 8.5, 'door_left')
  b.pt('door', W, 6, 'door_right')
  b.write('branch.json')
}
