// Generates the office theme's placeholder maps (no tiles) as Tiled 1.10 JSON:
//   themes/office/hq.json      CEO office (sealed) + reception with the memo inbox
//   themes/office/branch.json  one team's branch, stamped out per active session
// Once real art exists, edit the maps in Tiled instead and delete this script.
const fs = require('fs')
const path = require('path')
const T = 32
const WALL = 0.25 // wall thickness in tiles
const WALL_COLOR = '#5c5470'

function builder(W, H) {
  let id = 1
  const furn = [], walls = [], locs = []
  const props = (color, label, solid) => [
    { name: 'color', type: 'color', value: color },
    { name: 'label', type: 'string', value: label },
    { name: 'solid', type: 'bool', value: solid }
  ]
  const box = (name, tx, ty, tw, th) => ({ id: id++, name, x: tx * T, y: ty * T, width: tw * T, height: th * T, rotation: 0, visible: true })
  const b = {
    /** Decorative floor area (walkable). */
    area: (name, tx, ty, tw, th, color, label = '') => furn.push({ ...box(name, tx, ty, tw, th), type: 'area', properties: props(color, label, false) }),
    /** Furniture: characters path around it. */
    item: (name, tx, ty, tw, th, color, label = '') => furn.push({ ...box(name, tx, ty, tw, th), type: 'furniture', properties: props(color, label, true) }),
    wall: (name, tx, ty, tw, th) => walls.push({ ...box(name, tx, ty, tw, th), type: 'wall', properties: [{ name: 'color', type: 'color', value: WALL_COLOR }] }),
    pt: (type, tx, ty, name = type) =>
      locs.push({ id: id++, name, type, x: Math.round(tx * T), y: Math.round(ty * T), width: 0, height: 0, point: true, rotation: 0, visible: true }),
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
      const map = {
        type: 'map', version: '1.10', tiledversion: '1.11.0', orientation: 'orthogonal', renderorder: 'right-down',
        width: W, height: H, tilewidth: T, tileheight: T, infinite: false, nextlayerid: 4, nextobjectid: id,
        layers: [layer(1, 'furniture', furn), layer(2, 'walls', walls), layer(3, 'locations', locs, false)],
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
  b.area('floor', 0, 0, W, H, '#e9e4d8', '')
  b.area('ceo_room', 0, 0, W, 5, '#d8cfae', 'CEO')
  b.area('reception', 0, 5.25, W, 2.75, '#e0d9c6', 'Reception')
  b.wall('top_band', 0, 0, W, 0.75)
  b.outline({ bottom: [[4, 6]], left: [[5.75, 7.5]], right: [[5.75, 7.5]] })
  // CEO office: sealed, no door. Agents can never enter.
  b.wall('ceo_wall_bottom', 0, 5, W, WALL)
  b.item('ceo_desk', 3.5, 2.3, 3, 1, '#8d6e63')
  b.item('plant', 0.6, 1.1, 0.7, 0.7, '#6a994e')
  b.item('bookshelf', 8, 0.8, 1.6, 0.6, '#7f5539')
  b.pt('boss_seat', 5, 1.6)
  // Memo hatch in the CEO's wall; memos queue outside it.
  b.item('memo_hatch', 4, 4.6, 2, 0.6, '#c9b458', 'Memo hatch')
  for (let i = 0; i < 6; i++) b.pt('inbox', 1.25 + i * 1.5, 6.1, 'inbox_' + (i + 1))
  // Doors open onto the corridor
  b.pt('door', 5, H, 'door_bottom')
  b.pt('door', 0, 6.6, 'door_left')
  b.pt('door', W, 6.6, 'door_right')
  b.write('hq.json')
}

// ---- Branch: 16 x 12 tiles -------------------------------------------------------------------
{
  const W = 16, H = 12
  const b = builder(W, H)
  b.area('floor', 0, 0, W, H, '#e9e4d8', '')
  b.outline({ bottom: [[7, 9]], top: [[10, 12]], left: [[7.5, 9.5]], right: [[5, 7]] })
  // Manager office with a door
  b.area('mgr_room', 0, 0, 6, 5, '#d7e3e8', 'Manager')
  b.wall('mgr_wall_right', 6 - WALL, 0, WALL, 5 + WALL)
  b.wall('mgr_wall_bl', 0, 5, 2, WALL)
  b.wall('mgr_wall_br', 3.5, 5, 2.5, WALL)
  b.item('mgr_desk', 1.5, 2.2, 3, 1, '#795548')
  b.pt('manager_seat', 3, 1.5)
  // Stations
  b.item('printer', 6.75, 0.6, 2, 1.4, '#90a4ae', 'Printer')
  b.pt('printer', 7.75, 2.7)
  b.item('filing', 12.5, 0.6, 1.6, 1.4, '#a1887f', 'Filing')
  b.pt('filing_cabinet', 13.3, 2.7)
  b.item('server_rack', 14.5, 0.6, 1.2, 2.4, '#546e7a', 'Server')
  b.pt('server_room', 14.2, 3.6)
  b.item('photo_booth', 13, 6.3, 2.2, 2, '#b39ddb', 'Photo')
  b.pt('photo_booth', 14.1, 9)
  b.item('water', 7, 3.4, 0.8, 0.8, '#81d4fa', '')
  b.pt('water_cooler', 7.4, 4.8)
  // Desks: 2 rows x 4 columns
  let d = 0
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
    const x = 0.75 + c * 3, y = 6.2 + r * 2.9
    b.item('desk_' + (++d), x, y, 2, 1, '#a1887f')
    b.item('monitor_' + d, x + 0.7, y + 0.1, 0.6, 0.35, '#263238')
    b.pt('desk', x + 1, y + 1.6, 'desk_' + d)
  }
  b.area('mat', 7, 11, 2, 1, '#6d4c41', 'Entrance')
  b.pt('entrance', 8, 11.3)
  b.pt('door', 8, H, 'door_bottom')
  b.pt('door', 11, 0, 'door_top')
  b.pt('door', 0, 8.5, 'door_left')
  b.pt('door', W, 6, 'door_right')
  b.write('branch.json')
}
