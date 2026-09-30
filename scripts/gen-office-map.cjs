// Generates themes/office/map.json (placeholder layout, no tiles) as a Tiled 1.10 JSON map.
// Once real art exists, edit the map in Tiled instead and delete this script.
const T = 32, W = 30, H = 20
const WALL = 0.25 // wall thickness in tiles
let id = 1
const furn = [], walls = [], locs = []
const props = (color, label, solid) => [
  { name: 'color', type: 'color', value: color },
  { name: 'label', type: 'string', value: label },
  { name: 'solid', type: 'bool', value: solid }
]
const box = (name, tx, ty, tw, th) => ({ id: id++, name, x: tx * T, y: ty * T, width: tw * T, height: th * T, rotation: 0, visible: true })
// Decorative floor areas (walkable)
const area = (name, tx, ty, tw, th, color, label = '') => furn.push({ ...box(name, tx, ty, tw, th), type: 'area', properties: props(color, label, false) })
// Furniture: characters walk around it
const item = (name, tx, ty, tw, th, color, label = '') => furn.push({ ...box(name, tx, ty, tw, th), type: 'furniture', properties: props(color, label, true) })
// Walls: impassable, drawn in the wall colour
const wall = (name, tx, ty, tw, th) => walls.push({ ...box(name, tx, ty, tw, th), type: 'wall', properties: [{ name: 'color', type: 'color', value: '#5c5470' }] })
const pt = (type, px, py, name = type) =>
  locs.push({ id: id++, name, type, x: Math.round(px), y: Math.round(py), width: 0, height: 0, point: true, rotation: 0, visible: true })

area('floor', 0, 0, W, H, '#e9e4d8')

// Outer walls
wall('wall_top', 0, 0, W, 1)
wall('wall_left', 0, 0, WALL, H)
wall('wall_right', W - WALL, 0, WALL, H)
wall('wall_bottom_l', 0, H - WALL, 22.5, WALL)
wall('wall_bottom_r', 24.5, H - WALL, W - 24.5, WALL) // gap = entrance door

// CEO office: fully enclosed, no door. Agents can never enter; memos go through the hatch.
area('ceo_room', 0, 1, 7, 6, '#d8cfae', 'CEO')
item('ceo_desk', 2, 2.4, 3, 1, '#8d6e63')
pt('boss_seat', 3.5 * T, 1.7 * T)
wall('ceo_wall_right', 7 - WALL, 1, WALL, 6 + WALL)
wall('ceo_wall_bottom', 0, 7, 7, WALL)
item('memo_hatch', 2.5, 6.7, 2, 0.55, '#c9b458', 'Memo hatch')
for (let i = 0; i < 4; i++) pt('inbox', (1.4 + i * 1.4) * T, 8 * T, 'inbox_' + (i + 1))

// Manager offices, each with a door in the bottom wall
for (let m = 0; m < 3; m++) {
  const x = 7 + m * 5
  area('mgr_room_' + (m + 1), x, 1, 5, 6, m % 2 ? '#cfd8dc' : '#d7e3e8', 'Manager ' + (m + 1))
  item('mgr_desk_' + (m + 1), x + 1, 2.4, 3, 1, '#795548')
  pt('manager_seat', (x + 2.5) * T, 1.7 * T, 'manager_seat_' + (m + 1))
  wall('mgr_wall_right_' + (m + 1), x + 5 - WALL, 1, WALL, 6 + WALL)
  // bottom wall with a 1.5-tile door starting 1.75 tiles in
  wall('mgr_wall_bl_' + (m + 1), x, 7, 1.75, WALL)
  wall('mgr_wall_br_' + (m + 1), x + 3.25, 7, 1.75, WALL)
}

// Shared stations
item('printer', 24, 2, 2, 1.5, '#90a4ae', 'Printer')
pt('printer', 25 * T, 4.2 * T)
item('filing', 27, 2, 2, 1.5, '#a1887f', 'Filing')
pt('filing_cabinet', 28 * T, 4.2 * T)
item('photo_booth', 24, 9, 2, 2, '#b39ddb', 'Photo booth')
pt('photo_booth', 25 * T, 11.8 * T)
item('water', 27, 9, 1, 1, '#81d4fa', 'Water')
pt('water_cooler', 27.5 * T, 10.8 * T)
item('server_rack', 27, 13, 2, 2, '#546e7a', 'Server')
pt('server_room', 28 * T, 15.8 * T)

area('door', 22.5, 19, 2, 1, '#6d4c41', 'Entrance')
pt('entrance', 23.5 * T, 19.2 * T)

// Open-plan desks: 4 columns x 3 rows
let d = 0
for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) {
  const x = 1 + c * 5.5, y = 10 + r * 3
  item('desk_' + (++d), x, y, 2, 1, '#a1887f')
  item('monitor_' + d, x + 0.7, y + 0.1, 0.6, 0.35, '#263238')
  pt('desk', (x + 1) * T, (y + 1.6) * T, 'desk_' + d)
}

const layer = (lid, name, objects, visible = true) =>
  ({ id: lid, name, type: 'objectgroup', draworder: 'index', opacity: 1, visible, x: 0, y: 0, objects })
const map = {
  type: 'map', version: '1.10', tiledversion: '1.11.0', orientation: 'orthogonal', renderorder: 'right-down',
  width: W, height: H, tilewidth: T, tileheight: T, infinite: false, nextlayerid: 4, nextobjectid: id,
  layers: [layer(1, 'furniture', furn), layer(2, 'walls', walls), layer(3, 'locations', locs, false)],
  tilesets: []
}
require('fs').writeFileSync(require('path').join(__dirname, '..', 'themes', 'office', 'map.json'), JSON.stringify(map, null, 1))
console.log('furniture', furn.length, 'walls', walls.length, 'locations', locs.length)
