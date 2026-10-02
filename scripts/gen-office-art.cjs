// Draws the office theme's art in code (no third-party assets) and renders it to PNG with Electron:
//   themes/office/art/branch-floor.png   floor + walls of one branch, 2x the map's size
//   themes/office/art/furniture.png      furniture sprites, 4x the map's size
//   themes/office/art/furniture.json     their frames (TexturePacker "JSON (Hash)" + pivot)
//
//   node scripts/gen-office-map.cjs            (first: this script reads branch.json)
//   npx electron scripts/gen-office-art.cjs
//
// Everything is SVG text built below, drawn onto a canvas by Chromium's software rasteriser, so the
// same input gives the same files. Units in the drawing code are map px (32 = one tile).
// The look: flat colour, rounded corners, two or three tones per object, no outlines, one soft drop
// shadow per object falling down and a little to the right. Images are padded to powers of two so
// the scene can mip-map them.
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path')

const THEME = path.join(__dirname, '..', 'themes', 'office')
const OUT = path.join(THEME, 'art')
const r = (n) => Math.round(n * 100) / 100
const pot = (n) => { let p = 64; while (p < n) p *= 2; return p }

// ---- palette -------------------------------------------------------------------------------------
const C = {
  floor: '#eef0f4', floorAlt: '#eaedf2', seam: '#e0e4eb',
  wood: '#ecdfca', woodAlt: '#e9dbc4', woodSeam: '#e0d0b7',
  threshold: '#e1e5ec', thresholdLine: '#d3d8e2',
  wallCap: '#fbfcfd', wallEdge: '#e2e6ed', wallFace: '#cdd3de', wallFaceLow: '#bcc4d2',
  shadow: '#232b45',
  birch: '#ead6b4', birchHi: '#f2e2c6', birchFace: '#cfb38a', birchLow: '#bd9f76',
  walnut: '#c29a6f', walnutHi: '#cfab82', walnutFace: '#a57d55', walnutLow: '#92693f',
  screen: '#2c3247', screenIn: '#353d59', steel: '#c3c9d5', steelDark: '#a9b1c0',
  white: '#ffffff', paper: '#fbfbfd', key: '#d5d9e2', plastic: '#f3f4f7',
  chair: '#8f9cb4', chairHi: '#9daac0', chairDark: '#74819a', chairLeg: '#59647a',
  exec: '#687590', execHi: '#7785a0', execDark: '#535f77',
  leafA: '#5c9f68', leafB: '#73b77b', leafC: '#92cd8e', soil: '#6d5545', pot: '#f4f5f8', potShade: '#dde1e9',
  mat: '#8693ae', matHi: '#a4afc6', matLow: '#7786a3'
}
const SHADOW_BLUR = 2.4
/** A soft drop shadow: the given shape(s), blurred, moved down-right. */
const shadow = (shape, o = {}) =>
  `<g filter="url(#blur${o.blur ?? ''})" opacity="${o.alpha ?? 0.26}" transform="translate(${o.dx ?? 1.5} ${o.dy ?? 3})" fill="${C.shadow}">${shape}</g>`
const rect = (x, y, w, h, rx, fill, extra = '') => `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${rx}" fill="${fill}" ${extra}/>`
const DEFS = `<defs>
 <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${SHADOW_BLUR}"/></filter>
 <filter id="blurS" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1"/></filter>
 <filter id="blurL" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4.5"/></filter>
</defs>`

// ---- furniture -----------------------------------------------------------------------------------
// Each sprite: its footprint (the map rectangle it stands on, at 0,0), how far the picture sticks
// out on each side [left, top, right, bottom], and the drawing.

/** A desk seen from above with its front showing: top, front face, a drawer. */
function deskBody(w, top, bottom, t) {
  const face = 5.5
  return (
    shadow(rect(0.5, top + 2, w - 1, bottom - top - 2, 3, C.shadow)) +
    rect(0, top + 4, w, bottom - top - 4, 2.6, t.face) +
    rect(0, bottom - 1.6, w, 1.6, 0.8, t.low) +
    rect(0, top, w, bottom - top - face, 2.6, t.top) +
    rect(1.6, top + 0.9, w - 3.2, 1.1, 0.55, t.hi, 'opacity=".9"')
  )
}
const drawer = (x, y, w, t) => rect(x, y, w, 3.1, 0.9, t.low, 'opacity=".75"') + rect(x + w / 2 - 2, y + 1.15, 4, 0.8, 0.4, t.hi)

function mug(cx, cy, liquid = '#8b5e3c') {
  return (
    `<ellipse cx="${cx + 0.5}" cy="${cy + 1}" rx="2.9" ry="2.6" fill="${C.shadow}" opacity=".16"/>` +
    `<path d="M ${cx + 2} ${cy - 1.1} q 2.6 0.2 2.3 1.5 q -0.3 1.2 -2.5 0.9" fill="none" stroke="${C.white}" stroke-width="1"/>` +
    `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${C.white}"/><circle cx="${cx}" cy="${cy}" r="1.75" fill="${liquid}"/>`
  )
}
function paper(x, y, w, h, angle, accent) {
  const lines = [0.38, 0.54, 0.7].map((f, i) => rect(x + 1.3, y + h * f, (w - 2.6) * (i === 2 ? 0.6 : 1), 0.7, 0.35, '#c9cedb')).join('')
  return `<g transform="rotate(${angle} ${x + w / 2} ${y + h / 2})">${rect(x + 0.5, y + 0.8, w, h, 0.8, C.shadow, 'opacity=".14"')}${rect(x, y, w, h, 0.8, C.paper)}${rect(x + 1.3, y + 1.4, w - 2.6, 1.5, 0.5, accent)}${lines}</g>`
}

/** What is on the screen and lying on the desk, per variant (so a row of desks is not one stamp). */
const DESKS = {
  desk: {
    code: [[21.6, -4.4, 7, '#7fd3bd'], [29.6, -4.4, 4.5, '#8ea6ff'], [23, -2.5, 9.5, '#f1ba72'], [33.5, -2.5, 6, '#7fd3bd'],
      [23, -0.6, 5, '#e990a8'], [29, -0.6, 8.5, '#8ea6ff'], [21.6, 1.3, 11, '#c9cfe4'], [21.6, 3.2, 6, '#f1ba72']],
    things: () => mug(10.5, 8.5) + paper(6, 13.5, 8, 9.5, -8, '#8ea6ff') + rect(52, 6.5, 4.6, 4.6, 0.6, '#f6dd7b') + rect(52, 6.5, 4.6, 1.2, 0.6, '#ecca55')
  },
  desk_b: {
    code: [[21.6, -4.4, 10, '#8ea6ff'], [23, -2.5, 6, '#7fd3bd'], [30, -2.5, 8, '#c9cfe4'], [23, -0.6, 11, '#f1ba72'],
      [24.4, 1.3, 6.5, '#e990a8'], [21.6, 3.2, 8, '#8ea6ff']],
    things: () => paper(49.5, 6.5, 8, 9.5, 6, '#f1ba72') + paper(51.5, 9.5, 8, 9.5, -4, '#7fd3bd') + mug(8.5, 17, '#b9c88a') +
      // a small succulent
      `<ellipse cx="10.6" cy="9.6" rx="3" ry="2" fill="${C.shadow}" opacity=".16"/><circle cx="10" cy="8.4" r="2.6" fill="${C.pot}"/>` +
      `<circle cx="10" cy="8.4" r="1.9" fill="${C.leafA}"/><circle cx="9.3" cy="7.7" r="1.1" fill="${C.leafC}"/>`
  },
  desk_c: {
    code: [[21.6, -4.4, 5, '#f1ba72'], [27.4, -4.4, 9, '#c9cfe4'], [23, -2.5, 12, '#7fd3bd'], [23, -0.6, 7, '#8ea6ff'],
      [31, -0.6, 5, '#e990a8'], [23, 1.3, 9, '#f1ba72'], [21.6, 3.2, 12.5, '#c9cfe4']],
    things: () => mug(52.5, 9, '#8b5e3c') + rect(49, 15.5, 4.2, 4.2, 0.6, '#f4a9b8') + rect(49, 15.5, 4.2, 1.1, 0.6, '#e98ea1') +
      // headphones lying on the desk
      `<path d="M 7.2 16.4 a 4.4 4.4 0 0 1 8.8 0" fill="none" stroke="#4b556b" stroke-width="1.5" stroke-linecap="round"/>` +
      rect(5.9, 15.4, 2.8, 4.4, 1.3, '#5e6a83') + rect(14.5, 15.4, 2.8, 4.4, 1.3, '#5e6a83') +
      paper(7, 5, 7, 7, 10, '#8ea6ff')
  }
}

function desk(name = 'desk') {
  const t = { top: C.birch, hi: C.birchHi, face: C.birchFace, low: C.birchLow }
  const code = DESKS[name].code.map(([x, y, w, c]) => rect(x, y, w, 1, 0.5, c)).join('')
  const keys = [0, 1, 2].map((row) => Array.from({ length: 8 }, (_, i) => rect(23.3 + i * 2.05, 16.1 + row * 1.55, 1.45, 0.95, 0.3, C.key)).join('')).join('')
  return {
    name, w: 64, h: 32, pad: [8, 12, 8, 9],
    svg:
      deskBody(64, 1, 32, t) + drawer(45, 27.6, 14, t) +
      // monitor: stand, then the screen standing up at the back edge
      `<ellipse cx="32.6" cy="10.4" rx="7.5" ry="2.6" fill="${C.shadow}" opacity=".18"/>` +
      `<ellipse cx="32" cy="9.4" rx="5.2" ry="1.9" fill="${C.steel}"/>` + rect(30.6, 5, 2.8, 4.6, 0.6, C.steelDark) +
      rect(18.6, -7.4, 26.8, 14.4, 2.2, C.screen) + rect(20, -6.1, 24, 11.6, 1.3, C.screenIn) + code +
      `<path d="M 36 -6.1 L 44 -6.1 L 44 2 Z" fill="#fff" opacity=".05"/>` +
      // keyboard + mouse
      rect(22.5, 15.9, 18.2, 6, 1.3, C.shadow, 'opacity=".15"') + rect(22, 15.2, 18.2, 6, 1.3, C.plastic) + keys +
      rect(43.4, 16.6, 3.6, 5.2, 1.8, C.shadow, 'opacity=".15"') + rect(43, 16, 3.6, 5.2, 1.8, C.plastic) +
      DESKS[name].things()
  }
}

function deskManager() {
  const t = { top: C.walnut, hi: C.walnutHi, face: C.walnutFace, low: C.walnutLow }
  const pens = [['#e8785f', -1.1, -4.6], ['#5b8def', 0.2, -5.4], ['#4cc38a', 1.3, -4.2]]
    .map(([c, dx, dy]) => `<line x1="${86 + dx * 0.4}" y1="2" x2="${86 + dx}" y2="${2 + dy}" stroke="${c}" stroke-width="1" stroke-linecap="round"/>`).join('')
  return {
    name: 'desk_manager', w: 96, h: 32, pad: [8, 14, 8, 9],
    svg:
      deskBody(96, -5, 32, t) + drawer(5, 27.6, 20, t) + drawer(71, 27.6, 20, t) +
      // laptop, open towards the manager: we see the back of its lid
      rect(38.6, 4.2, 20, 11.6, 1.6, C.shadow, 'opacity=".2"') +
      rect(38, -1.5, 20, 6, 1.2, '#b9c0cd') + rect(38, 2.2, 20, 12.2, 1.6, '#dfe3ea') + rect(38, 2.2, 20, 2, 1, '#eef0f4') +
      `<circle cx="48" cy="9" r="1.5" fill="#c3c9d5"/>` +
      paper(66, -1, 10, 12.5, 7, '#f1ba72') + paper(68.5, 3.5, 10, 12.5, -5, '#8ea6ff') +
      mug(27, 3.5, '#6b4a33') +
      // pen pot
      `<ellipse cx="86.5" cy="4.6" rx="3" ry="2.4" fill="${C.shadow}" opacity=".18"/>` + pens + rect(83.6, 0.6, 4.8, 4.6, 1.4, '#4b556b') + rect(83.6, 0.6, 4.8, 1.5, 0.75, '#5e6a83') +
      // name plate on the front edge
      rect(39, 20.3, 18, 3.4, 1, C.shadow, 'opacity=".16"') + rect(38.6, 19.6, 18, 3.4, 1, '#f1e3c4') + rect(41, 20.8, 13.2, 1, 0.5, '#c9b48a')
  }
}

function chairSeat() {
  // Footprint 22.4 x 19.2: the seat of a swivel chair, armrests, the star base peeking out.
  const cx = 11.2
  const legs = [[-8.5, 3.5], [8.5, 3.5], [-5.5, -5], [5.5, -5], [0, 7.5]]
    .map(([dx, dy]) => `<line x1="${cx}" y1="10.5" x2="${cx + dx}" y2="${10.5 + dy}" stroke="${C.chairLeg}" stroke-width="1.7" stroke-linecap="round"/><circle cx="${cx + dx}" cy="${10.5 + dy}" r="1.3" fill="${C.chairLeg}"/>`).join('')
  return {
    name: 'chair_seat', w: 22.4, h: 19.2, pad: [7, 7, 7, 9],
    svg:
      shadow(`<ellipse cx="${cx}" cy="11" rx="10.5" ry="8"/>`, { alpha: 0.22 }) + legs +
      rect(cx - 10.6, 5, 3, 9, 1.5, C.chairDark) + rect(cx + 7.6, 5, 3, 9, 1.5, C.chairDark) +
      rect(cx - 8.6, 2, 17.2, 15, 5, C.chair) + rect(cx - 6.8, 3.4, 13.6, 9.5, 3.6, C.chairHi)
  }
}
function chairBack() {
  // Footprint 22.4 x 9.6: the backrest, seen from behind.
  return {
    name: 'chair_back', w: 22.4, h: 9.6, pad: [6, 6, 6, 8],
    svg:
      shadow(rect(1.6, 1.4, 19.2, 7.6, 3.8, C.shadow), { alpha: 0.2, dy: 2.2, dx: 1 }) +
      rect(1.6, 0.8, 19.2, 8, 4, C.chairDark) + rect(1.6, 0.8, 19.2, 5.4, 2.7, C.chair) + rect(4, 1.7, 14.4, 1.2, 0.6, C.chairHi, 'opacity=".8"')
  }
}
function chairManager() {
  // Footprint 25.6 x 30.4: a high-backed chair facing the viewer (the backrest is behind the sitter).
  const cx = 12.8
  return {
    name: 'chair_manager', w: 25.6, h: 30.4, pad: [7, 7, 7, 9],
    svg:
      shadow(rect(cx - 10, 4, 20, 25, 6, C.shadow), { alpha: 0.24 }) +
      rect(cx - 9.8, 0.5, 19.6, 21, 6.5, C.execDark) + rect(cx - 8, 2, 16, 17, 5, C.exec) + rect(cx - 5.5, 3.4, 11, 1.3, 0.65, C.execHi, 'opacity=".7"') +
      rect(cx - 12.2, 14, 3.2, 11.5, 1.6, C.execDark) + rect(cx + 9, 14, 3.2, 11.5, 1.6, C.execDark) +
      rect(cx - 9.6, 13, 19.2, 16.4, 5.5, C.exec) + rect(cx - 7.6, 14.6, 15.2, 10.5, 4, C.execHi)
  }
}

function plant() {
  // Footprint 22.4 x 22.4: a white pot with a fan of leaves.
  const cx = 11.2
  const leaf = (angle, len, wid, fill, vein) =>
    `<g transform="rotate(${angle} ${cx} 13)"><path d="M ${cx} 13 C ${cx - wid} ${13 - len * 0.45}, ${cx - wid * 0.7} ${13 - len * 0.95}, ${cx} ${13 - len} C ${cx + wid * 0.7} ${13 - len * 0.95}, ${cx + wid} ${13 - len * 0.45}, ${cx} 13 Z" fill="${fill}"/>` +
    (vein ? `<line x1="${cx}" y1="${13 - len * 0.2}" x2="${cx}" y2="${13 - len * 0.82}" stroke="${vein}" stroke-width=".6" stroke-linecap="round" opacity=".7"/>` : '') + `</g>`
  return {
    name: 'plant', w: 22.4, h: 22.4, pad: [9, 10, 9, 9],
    svg:
      shadow(`<ellipse cx="${cx}" cy="18.5" rx="8.5" ry="5"/>`, { alpha: 0.24 }) +
      // pot
      `<path d="M ${cx - 6.2} 13 L ${cx - 4.6} 20.6 Q ${cx} 23 ${cx + 4.6} 20.6 L ${cx + 6.2} 13 Z" fill="${C.pot}"/>` +
      `<path d="M ${cx + 1.5} 13 L ${cx + 1.2} 22 Q ${cx + 3.4} 21.6 ${cx + 4.6} 20.6 L ${cx + 6.2} 13 Z" fill="${C.potShade}"/>` +
      `<ellipse cx="${cx}" cy="13" rx="6.2" ry="2.3" fill="${C.white}"/><ellipse cx="${cx}" cy="13.1" rx="4.9" ry="1.6" fill="${C.soil}"/>` +
      // leaves, back to front
      leaf(-62, 12, 4.2, C.leafA) + leaf(62, 12, 4.2, C.leafA) + leaf(-30, 15, 4.6, C.leafA) + leaf(30, 15, 4.6, C.leafA) +
      leaf(0, 16.5, 4.8, C.leafB, C.leafC) + leaf(-46, 10.5, 4, C.leafB, C.leafC) + leaf(46, 10.5, 4, C.leafB, C.leafC) +
      leaf(-17, 11.5, 3.8, C.leafC) + leaf(17, 11.5, 3.8, C.leafC)
  }
}

function mat() {
  // Footprint 64 x 32 (it lies in the doorway).
  const ridges = Array.from({ length: 5 }, (_, i) => rect(9, 9.6 + i * 3.2, 46, 1, 0.5, C.matLow, 'opacity=".55"')).join('')
  return {
    name: 'mat', w: 64, h: 32, pad: [4, 4, 4, 5],
    svg:
      shadow(rect(4, 5, 56, 22, 3, C.shadow), { blur: 'S', alpha: 0.28, dx: 0.6, dy: 1.2 }) +
      rect(4, 5, 56, 22, 3, C.mat) + rect(6.2, 7.2, 51.6, 17.6, 1.8, 'none', `stroke="${C.matHi}" stroke-width="1"`) + ridges
  }
}

const SPRITES = [desk('desk'), desk('desk_b'), desk('desk_c'), deskManager(), chairSeat(), chairBack(), chairManager(), plant(), mat()]
const ATLAS_SCALE = 4

function atlas() {
  const gap = 4
  const cells = SPRITES.map((s) => {
    const [l, t, rr, b] = s.pad
    return { s, w: Math.ceil((s.w + l + rr) * ATLAS_SCALE), h: Math.ceil((s.h + t + b) * ATLAS_SCALE) }
  })
  // Shelf packing, in the order given, into the smallest power-of-two width that keeps it squarish.
  const pack = (W) => {
    let x = gap, y = gap, rowH = 0
    for (const c of cells) {
      if (x + c.w + gap > W) { x = gap; y += rowH + gap; rowH = 0 }
      c.x = x; c.y = y; x += c.w + gap; rowH = Math.max(rowH, c.h)
    }
    return y + rowH + gap
  }
  let W = 512, H = pack(W)
  while (H > W) { W *= 2; H = pack(W) }
  H = pot(H)
  const frames = {}
  let body = ''
  for (const c of cells) {
    const [l, t] = c.s.pad
    const vw = c.w / ATLAS_SCALE, vh = c.h / ATLAS_SCALE
    body += `<svg x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" viewBox="${-l} ${-t} ${r(vw)} ${r(vh)}">${c.s.svg}</svg>\n`
    frames[c.s.name] = {
      frame: { x: c.x, y: c.y, w: c.w, h: c.h }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: c.w, h: c.h }, sourceSize: { w: c.w, h: c.h },
      // Where the centre of the map rectangle is in the picture.
      pivot: { x: r((l + c.s.w / 2) / vw * 100) / 100, y: r((t + c.s.h / 2) / vh * 100) / 100 }
    }
  }
  for (const f of Object.values(frames)) { f.pivot.x = Math.round(f.pivot.x * 1e4) / 1e4; f.pivot.y = Math.round(f.pivot.y * 1e4) / 1e4 }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${DEFS}\n${body}</svg>`
  const data = { frames, meta: { app: 'scripts/gen-office-art.cjs', image: 'furniture.png', format: 'RGBA8888', size: { w: W, h: H }, scale: String(ATLAS_SCALE) } }
  return { svg, W, H, data }
}
// Exact pivots (the two-step rounding above would lose precision).
function pivots(data) {
  for (const s of SPRITES) {
    const [l, t, rr, b] = s.pad
    const f = data.frames[s.name]
    f.pivot = { x: Math.round(((l + s.w / 2) * ATLAS_SCALE / f.frame.w) * 1e5) / 1e5, y: Math.round(((t + s.h / 2) * ATLAS_SCALE / f.frame.h) * 1e5) / 1e5 }
  }
  return data
}

// ---- floor + walls of the branch -----------------------------------------------------------------
const FLOOR_SCALE = 2
const MARGIN = 16 // must match the image layer's offset in gen-office-map.cjs
const FACE = 10 //   height of a wall's visible front

function branchFloor() {
  const map = JSON.parse(fs.readFileSync(path.join(THEME, 'branch.json'), 'utf8'))
  const W = map.width * map.tilewidth, H = map.height * map.tileheight
  const objs = (n) => map.layers.find((l) => l.type === 'objectgroup' && l.name === n).objects
  const walls = objs('walls')
  const room = objs('furniture').find((o) => o.name === 'mgr_room')
  const horiz = walls.filter((w) => w.width >= w.height), vert = walls.filter((w) => w.width < w.height)

  // Floor: big tiles in two nearly equal tones.
  let floor = rect(0, 0, W, H, 0, C.floor)
  for (let y = 0; y < H; y += 64) for (let x = (y / 64) % 2 ? 64 : 0; x < W; x += 128) floor += rect(x, y, 64, 64, 0, C.floorAlt)
  for (let x = 64; x < W; x += 64) floor += rect(x - 0.5, 0, 1, H, 0, C.seam)
  for (let y = 64; y < H; y += 64) floor += rect(0, y - 0.5, W, 1, 0, C.seam)
  // Manager's office: pale wood planks.
  if (room) {
    const ph = 32 / 3
    let planks = rect(room.x, room.y, room.width, room.height, 0, C.wood)
    for (let i = 0, y = room.y; y < room.y + room.height - 0.1; y += ph, i++) {
      if (i % 2) planks += rect(room.x, y, room.width, ph, 0, C.woodAlt)
      planks += rect(room.x, y - 0.4, room.width, 0.8, 0, C.woodSeam)
      for (let x = room.x + [38, 86, 14, 62][i % 4]; x < room.x + room.width; x += 96) planks += rect(x - 0.4, y, 0.8, ph, 0, C.woodSeam)
    }
    floor += `<clipPath id="room"><rect x="${room.x}" y="${room.y}" width="${room.width}" height="${room.height}"/></clipPath><g clip-path="url(#room)">${planks}</g>`
  }
  // Doorways: where two walls on one line leave a gap.
  let doors = ''
  const gapsOf = (list, along, across, len, thick) => {
    for (const a of list) for (const b of list) {
      if (a === b || a[across] !== b[across] || a[thick] !== b[thick]) continue
      const from = a[along] + a[len], to = b[along]
      if (to <= from || to - from > 96) continue
      if (list.some((c) => c !== a && c !== b && c[across] === a[across] && c[along] >= from && c[along] < to)) continue
      const box = along === 'x' ? [from, a.y, to - from, a.height] : [a.x, from, a.width, to - from]
      doors += rect(box[0], box[1], box[2], box[3], 0, C.threshold)
      doors += along === 'x'
        ? rect(box[0], box[1], box[2], 1, 0, C.thresholdLine) + rect(box[0], box[1] + box[3] - 1, box[2], 1, 0, C.thresholdLine)
        : rect(box[0], box[1], 1, box[3], 0, C.thresholdLine) + rect(box[0] + box[2] - 1, box[1], 1, box[3], 0, C.thresholdLine)
    }
  }
  gapsOf(horiz, 'x', 'y', 'width', 'height')
  gapsOf(vert, 'y', 'x', 'height', 'width')
  // A door in the front wall gets a step where the wall's front would be.
  const steps = horiz.filter((a) => a.y + a.height >= H).flatMap((a) => horiz
    .filter((b) => b !== a && b.y === a.y && b.x > a.x + a.width && b.x - (a.x + a.width) <= 96)
    .map((b) => rect(a.x + a.width, H, b.x - a.x - a.width, FACE, 0, C.wallFace) + rect(a.x + a.width, H, b.x - a.x - a.width, FACE - 4, 0, C.threshold) + rect(a.x + a.width, H + FACE - 4, b.x - a.x - a.width, 1, 0, C.thresholdLine))).join('')

  // Walls: a light top, and a darker front below every wall that has floor in front of it.
  const faces = walls.map((w) => rect(w.x, w.y + w.height - 2, w.width, FACE + 2, 0, C.wallFace) + rect(w.x, w.y + w.height + FACE - 1.4, w.width, 1.4, 0, C.wallFaceLow)).join('')
  // Walls across first (with the line where the top meets the front), then the ones running down
  // the map over them, so a corner is one clean white shape.
  const caps = horiz.map((w) => rect(w.x, w.y, w.width, w.height, 0, C.wallCap) + rect(w.x, w.y + w.height - 1, w.width, 1, 0, C.wallEdge)).join('') +
    vert.map((w) => rect(w.x, w.y, w.width, w.height, 0, C.wallCap)).join('')
  const silhouettes = walls.map((w) => rect(w.x, w.y, w.width, w.height + FACE, 0, C.shadow)).join('')

  const vw = W + MARGIN * 2, vh = H + MARGIN * 2
  const pw = vw * FLOOR_SCALE, ph2 = vh * FLOOR_SCALE
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph2}" viewBox="${-MARGIN} ${-MARGIN} ${vw} ${vh}">${DEFS}
 <clipPath id="slab"><rect x="0" y="0" width="${W}" height="${H}" rx="3"/></clipPath>
 <clipPath id="building"><rect x="0" y="0" width="${W}" height="${H + FACE}" rx="3"/></clipPath>
 <g filter="url(#blurL)" opacity=".5"><rect x="1" y="3" width="${W - 2}" height="${H + FACE}" rx="4" fill="#0b0e1a"/></g>
 <g clip-path="url(#slab)">${floor}${doors}
  <g filter="url(#blurL)" opacity=".2" transform="translate(2.5 4)">${silhouettes}</g>
  <g filter="url(#blur)" opacity=".16" transform="translate(1 1.5)">${silhouettes}</g>
 </g>
 <g clip-path="url(#building)">${steps}${faces}${caps}</g>
</svg>`
  return { svg, w: pw, h: ph2, W: pot(pw), H: pot(ph2) }
}

// ---- render --------------------------------------------------------------------------------------
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.setPath('userData', path.join(os.tmpdir(), 'agent-office-art-gen'))
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true })
    const win = new BrowserWindow({ width: 64, height: 64, show: false, webPreferences: { offscreen: true } })
    await win.loadURL('about:blank')
    /** The SVG drawn at (0,0) on a transparent canvas of cw x ch, as PNG bytes. */
    const png = async (svg, w, h, cw, ch) => {
      const url = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image()
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)})
        await img.decode()
        const c = document.createElement('canvas')
        c.width = ${cw}; c.height = ${ch}
        c.getContext('2d').drawImage(img, 0, 0, ${w}, ${h})
        return c.toDataURL('image/png')
      })()`)
      return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    }
    const a = atlas()
    fs.writeFileSync(path.join(OUT, 'furniture.png'), await png(a.svg, a.W, a.H, a.W, a.H))
    fs.writeFileSync(path.join(OUT, 'furniture.json'), JSON.stringify(pivots(a.data), null, 1) + '\n')
    console.log(`furniture.png ${a.W}x${a.H}, ${SPRITES.length} sprites at ${ATLAS_SCALE}x:`, SPRITES.map((s) => s.name).join(', '))
    const f = branchFloor()
    fs.writeFileSync(path.join(OUT, 'branch-floor.png'), await png(f.svg, f.w, f.h, f.W, f.H))
    console.log(`branch-floor.png ${f.W}x${f.H} (picture ${f.w}x${f.h} at ${FLOOR_SCALE}x)`)
    win.destroy()
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  app.quit()
})
