// Draws the office theme's art in code (no third-party assets) and renders it to PNG with Electron:
//   themes/office/art/branch-floor.png   floor + walls of one branch, 2x the map's size
//   themes/office/art/hq-floor.png       floor + walls of the headquarters, the same way
//   themes/office/art/furniture.png      furniture sprites, 4x the map's size
//   themes/office/art/furniture.json     their frames (TexturePacker "JSON (Hash)" + pivot)
//
//   node scripts/gen-office-map.cjs            (first: this script reads hq.json and branch.json)
//   npx electron scripts/gen-office-art.cjs
//
// Everything is SVG text built below, drawn onto a canvas by Chromium's software rasteriser, so the
// same input gives the same files. Units in the drawing code are map px (32 = one tile).
// The look: flat colour, rounded corners, two or three tones per object, no outlines, one soft drop
// shadow per object falling down and a little to the right. Images are padded to powers of two so
// the scene can mip-map them. A sprite named `x@1` is the second frame of `x` (animated furniture).
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
  wallCap: '#fbfcfd', wallEdge: '#e2e6ed', wallFace: '#cdd3de', wallFaceMid: '#c5ccd8', wallFaceLow: '#b6bfce',
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
 <pattern id="cork" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".45" fill="#c7a57a"/><circle cx="3" cy="2.7" r=".4" fill="#e6caa2"/></pattern>
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

/** A box standing on its footprint: shadow, a front face `faceH` high at the bottom, the top. */
function box(w, top, bottom, faceH, t, rad = 2.6) {
  return (
    shadow(rect(0.5, top + 2, w - 1, bottom - top - 2, rad + 0.5, C.shadow)) +
    rect(0, top + 3, w, bottom - top - 3, rad, t.face) +
    rect(0, bottom - 1.6, w, 1.6, 0.8, t.low) +
    rect(0, top, w, bottom - top - faceH, rad, t.top) +
    rect(1.6, top + 0.9, w - 3.2, 1.1, 0.55, t.hi, 'opacity=".9"')
  )
}
const STEEL = { top: '#dfe4ec', hi: '#eef1f5', face: '#c3cad6', low: '#aab3c2' }
const line = (x1, y1, x2, y2, stroke, w = 1, extra = '') =>
  `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" ${extra}/>`
const circle = (cx, cy, rad, fill, extra = '') => `<circle cx="${r(cx)}" cy="${r(cy)}" r="${rad}" fill="${fill}" ${extra}/>`
/** A row of book spines in a shelf opening from x0 to x1, standing on y (deterministic widths). */
function books(x0, x1, y, h) {
  const cols = ['#5b8def', '#e8785f', '#f1ba72', '#4cc38a', '#9a7fd1', '#e990a8', '#5e6a83', '#7fd3bd']
  let out = '', x = x0, i = 0
  while (x < x1 - 2) {
    const w = 1.8 + ((i * 7) % 5) * 0.45, bh = h * (0.72 + ((i * 3) % 4) * 0.08)
    if (i % 9 === 6) { x += 2.5; i++; continue } // a gap
    out += rect(x, y - bh, Math.min(w, x1 - x), bh, 0.4, cols[(i * 5) % cols.length])
    x += w + 0.35
    i++
  }
  return out
}

/** The manager's (and the CEO's) desk: deep enough to reach the seat behind it. */
function bigDesk(name, t, extras) {
  return { name, w: 96, h: 32, pad: [8, 20, 8, 9], svg: deskBody(96, -13, 32, t) + drawer(5, 27.6, 20, t) + drawer(71, 27.6, 20, t) + extras }
}
function deskManager() {
  const pens = [['#e8785f', -1.1, -4.6], ['#5b8def', 0.2, -5.4], ['#4cc38a', 1.3, -4.2]]
    .map(([c, dx, dy]) => line(86 + dx * 0.4, -4, 86 + dx, -4 + dy, c)).join('')
  return bigDesk('desk_manager', { top: C.walnut, hi: C.walnutHi, face: C.walnutFace, low: C.walnutLow },
    // laptop, open towards the manager: we see the back of its lid
    rect(38.6, -1.8, 20, 11.6, 1.6, C.shadow, 'opacity=".2"') +
    rect(38, -7.5, 20, 6, 1.2, '#b9c0cd') + rect(38, -3.8, 20, 12.2, 1.6, '#dfe3ea') + rect(38, -3.8, 20, 2, 1, '#eef0f4') +
    circle(48, 3, 1.5, '#c3c9d5') +
    paper(66, -8, 10, 12.5, 7, '#f1ba72') + paper(68.5, -3.5, 10, 12.5, -5, '#8ea6ff') +
    mug(26, -3, '#6b4a33') +
    `<ellipse cx="86.5" cy="-1.4" rx="3" ry="2.4" fill="${C.shadow}" opacity=".18"/>` + pens + rect(83.6, -5.4, 4.8, 4.6, 1.4, '#4b556b') + rect(83.6, -5.4, 4.8, 1.5, 0.75, '#5e6a83') +
    rect(39, 18.3, 18, 3.4, 1, C.shadow, 'opacity=".16"') + rect(38.6, 17.6, 18, 3.4, 1, '#f1e3c4') + rect(41, 18.8, 13.2, 1, 0.5, '#c9b48a'))
}
function deskCeo() {
  return bigDesk('desk_ceo', { top: '#7f5338', hi: '#946449', face: '#5f3c28', low: '#4b2e1e' },
    // a leather writing pad, a big screen seen from behind, a brass lamp, a phone, papers
    rect(22, -9, 52, 21, 2.2, '#3f5c50') + rect(23.5, -7.5, 49, 18, 1.6, 'none', 'stroke="#59776a" stroke-width=".7"') +
    rect(31, -6.4, 34, 11.4, 1.6, C.shadow, 'opacity=".2"') + rect(30, -12, 36, 6.4, 1.6, '#2c3247') + rect(45.5, -6.4, 5, 4, 1, '#4b556b') +
    paper(52, 0, 10, 12, 6, '#e6c77c') +
    `<ellipse cx="11.6" cy="-2" rx="4.6" ry="2.6" fill="${C.shadow}" opacity=".2"/>` + circle(11, -4.4, 4.2, '#e7c77d') + circle(11, -4.4, 2.6, '#f6e2a6') + circle(10.2, -5.3, 1, '#fff7dc') +
    rect(79, -7, 9, 6.5, 1.6, '#2f3442') + rect(80.2, -6, 6.6, 2, 0.8, '#4b556b') +
    paper(76, 4, 9, 11, -8, '#8ea6ff') +
    rect(38.6, 18.3, 19, 3.6, 1, C.shadow, 'opacity=".2"') + rect(38.2, 17.6, 19, 3.6, 1, '#e8c87e') + rect(40.6, 18.9, 14.2, 1, 0.5, '#b8964e'))
}
function chairCeo() {
  const cx = 14.4
  const studs = [-5, 0, 5].flatMap((dx) => [6, 11].map((y) => circle(cx + dx, y, 0.7, '#5a2626'))).join('')
  return {
    name: 'chair_ceo', w: 28.8, h: 32, pad: [7, 8, 7, 9],
    svg:
      shadow(rect(cx - 11, 4, 22, 27, 7, C.shadow), { alpha: 0.26 }) +
      rect(cx - 10.8, -1.5, 21.6, 23, 7.5, '#5e2a2a') + rect(cx - 9, 0, 18, 18.5, 6, '#7b3838') + studs +
      rect(cx - 13.4, 14, 3.6, 12.5, 1.8, '#5e2a2a') + rect(cx + 9.8, 14, 3.6, 12.5, 1.8, '#5e2a2a') +
      rect(cx - 10.4, 13.5, 20.8, 17.4, 6, '#7b3838') + rect(cx - 8.4, 15, 16.8, 11, 4.4, '#8f4a48')
  }
}
function armchair() {
  const c = { dark: '#8a5236', base: '#a8663f', hi: '#bb7a50' }
  return {
    name: 'armchair', w: 32, h: 32, pad: [7, 8, 7, 9],
    svg:
      shadow(rect(1, 1, 30, 30, 8, C.shadow), { alpha: 0.26 }) +
      rect(2, -2, 28, 13, 6, c.dark) + rect(4, -1, 24, 7, 3.5, c.base) +
      rect(0, 3, 7.5, 27, 3.6, c.dark) + rect(24.5, 3, 7.5, 27, 3.6, c.dark) + rect(1, 4, 5.5, 9, 2.6, c.base) + rect(25.5, 4, 5.5, 9, 2.6, c.base) +
      rect(6.5, 9, 19, 17, 3.6, c.hi) + rect(6, 25, 20, 5.5, 2.4, c.dark)
  }
}

function printer() {
  const t = { top: '#eef0f4', hi: '#fafbfc', face: '#c7ceda', low: '#b3bccb' }
  const textLines = [0, 1, 2].map((i) => rect(15, 25 + i * 1.6, 16 - i * 4, 0.6, 0.3, '#c3c9d5')).join('')
  return {
    name: 'printer', w: 64, h: 44.8, pad: [8, 8, 8, 9],
    svg:
      box(64, 1, 44.8, 12, t, 3) +
      rect(5, 4, 40, 19, 2, '#e3e7ee') + rect(5, 9.6, 40, 0.8, 0.4, '#d0d6e0') + rect(7, 5.6, 36, 2.6, 1.2, '#d6dce5') +
      rect(48, 4, 12, 19, 2, '#dde2ea') + rect(50, 6, 8, 5, 1, '#33465a') + rect(51, 7.6, 4, 0.9, 0.4, '#7fd3bd') + rect(51, 9.2, 2.5, 0.9, 0.4, '#7fd3bd') +
      circle(51.4, 14.6, 1.1, '#4cc38a') + circle(55.4, 14.6, 1.1, '#f1ba72') + circle(51.4, 18.6, 1.1, '#c3c9d5') + circle(55.4, 18.6, 1.1, '#c3c9d5') +
      // output tray with printed sheets
      rect(9, 26.4, 30, 6.2, 1.6, '#d3d9e3') + rect(12.6, 23.8, 23, 7.6, 0.6, C.shadow, 'opacity=".12"') + rect(12, 23, 23, 7.6, 0.6, C.white) + textLines +
      // the front: a paper drawer, a handle, paper sticking out of the side tray
      rect(4, 35.6, 56, 0.8, 0.4, t.low) + rect(25, 38.2, 14, 1.8, 0.9, '#a9b2c2') + rect(46, 33, 14, 2.6, 0.8, C.white) + rect(47, 33.4, 12, 0.6, 0.3, '#dfe3ea')
  }
}

function filingCabinet() {
  const drawerAt = (y) => rect(3, y, 45.2, 8.4, 1.2, '#cfd5df') + rect(3, y + 7.2, 45.2, 1.2, 0.6, '#b9c1cd') + rect(19.6, y + 3, 12, 1.8, 0.9, '#9aa4b5') + rect(7, y + 2, 8, 3, 0.5, '#f7f8fa')
  return {
    name: 'filing_cabinet', w: 51.2, h: 44.8, pad: [7, 8, 7, 9],
    svg:
      box(51.2, 1, 44.8, 22, STEEL, 2.4) + drawerAt(24.4) + drawerAt(34) +
      paper(6, 4, 12, 10, -6, '#f1ba72') + paper(8, 6, 12, 10, 4, '#8ea6ff') +
      rect(31, 3.4, 13, 14, 1.4, C.shadow, 'opacity=".16"') + rect(30.4, 2.6, 13, 14, 1.4, '#5b8def') + rect(32, 4.4, 9.8, 3, 0.6, '#cfe0ff')
  }
}

function serverRack(frame) {
  const t = { top: '#3b4357', hi: '#4c556b', face: '#2a3040', low: '#222634' }
  // Lights per unit: [colour, on in frame 0, on in frame 1]
  const lit = [['#4cc38a', 1, 1], ['#5b8def', 1, 0], ['#4cc38a', 0, 1], ['#f1ba72', 1, 1], ['#4cc38a', 1, 0], ['#5b8def', 0, 1], ['#4cc38a', 1, 1], ['#e8785f', 0, 1]]
  let units = ''
  for (let i = 0; i < 8; i++) {
    const y = 3 + i * 8.4
    units += rect(4.5, y, 30, 7, 1.1, '#454e65') + rect(18, y + 2, 13.5, 0.7, 0.35, '#363e53') + rect(18, y + 4.2, 13.5, 0.7, 0.35, '#363e53')
    const [c, a, b] = lit[i]
    const on = frame ? b : a
    units += circle(8, y + 3.5, 1.15, on ? c : '#2f3547') + circle(11.6, y + 3.5, 1.15, (i + frame) % 3 ? '#4cc38a' : '#2f3547')
    if (on) units += circle(8, y + 3.5, 2.4, c, 'opacity=".22"')
  }
  return {
    name: frame ? 'server_rack@1' : 'server_rack', w: 38.4, h: 76.8, pad: [7, 3, 7, 8],
    svg: box(38.4, 0, 76.8, 8, t, 2.5) + rect(0.8, 1.5, 2.6, 66, 1.3, '#5a647c') + units
  }
}

function whiteboard() {
  const blue = '#5b8def', red = '#e8785f', green = '#4cc38a', grey = '#9aa3b5'
  const scrib =
    `<path d="M 7 -22.5 q 3 -2.6 6 0 t 6 0 t 6 0 t 6 0" fill="none" stroke="${blue}" stroke-width="1" stroke-linecap="round"/>` +
    [0, 1, 2].map((i) => line(7, -17 + i * 3.4, 7 + [22, 17, 24][i], -17 + i * 3.4, grey, 0.9)).join('') +
    `<rect x="36" y="-23" width="10" height="6.5" rx="1" fill="none" stroke="${red}" stroke-width="0.9"/>` +
    `<rect x="36" y="-11" width="10" height="6.5" rx="1" fill="none" stroke="${red}" stroke-width="0.9"/>` +
    line(41, -16.4, 41, -11.8, red, 0.9) + `<path d="M 39.4 -13.4 L 41 -11.6 L 42.6 -13.4" fill="none" stroke="${red}" stroke-width="0.9" stroke-linejoin="round"/>` +
    `<polyline points="51,-6 55,-11 59,-9 63,-16 67,-13" fill="none" stroke="${green}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>` +
    line(51, -5, 68, -5, grey, 0.7) + line(51, -5, 51, -18, grey, 0.7) +
    `<g transform="rotate(-6 64 -22)">${rect(60, -26, 7.5, 7.5, 0.6, '#f6dd7b')}</g><g transform="rotate(5 73 -20)">${rect(70, -24, 7.5, 7.5, 0.6, '#f4a9b8')}</g>`
  return {
    name: 'whiteboard', w: 83.2, h: 9.6, pad: [6, 36, 6, 12],
    svg:
      shadow(rect(2, 9, 79, 7, 3, C.shadow), { alpha: 0.2 }) +
      rect(5.4, -2, 2, 17, 1, '#a9b1c0') + rect(75.8, -2, 2, 17, 1, '#a9b1c0') +
      `<ellipse cx="6.4" cy="15.6" rx="4" ry="1.5" fill="#8f98a9"/><ellipse cx="76.8" cy="15.6" rx="4" ry="1.5" fill="#8f98a9"/>` +
      rect(0, -30, 83.2, 34, 2.5, '#c9d0db') + rect(1.8, -28.2, 79.6, 30.4, 1.6, '#fdfdfe') + scrib +
      rect(4, 3.4, 75, 2.6, 1.3, '#b9c1ce') + rect(10, 3.6, 7, 1.6, 0.8, blue) + rect(19, 3.6, 7, 1.6, 0.8, red) + rect(66, 3.4, 8, 2.2, 0.8, '#eef0f4')
  }
}

function sofa() {
  // Footprint 96 x 16: the backrest. The armrests and the three cushions hang down from it (on the
  // map: two more blocking rectangles and a strip of floor with a seat on every cushion).
  const c = { dark: '#c06e56', base: '#d9846b', hi: '#e69c84', seam: '#d48a72' }
  const cushions = [0, 1, 2].map((i) => rect(12.4 + i * 24, 7, 23.2, 21.5, 3.6, c.hi) + rect(14.4 + i * 24, 8.6, 19.2, 1.1, 0.55, '#eeab95', 'opacity=".8"')).join('')
  return {
    name: 'sofa', w: 96, h: 16, pad: [6, 10, 7, 24],
    svg:
      shadow(rect(1, -3, 94, 36, 8, C.shadow), { alpha: 0.26 }) +
      rect(2, -8, 92, 18, 6.5, c.dark) + rect(4, -7, 88, 9, 4, c.base) +
      rect(0, -3, 12.5, 36, 5, c.dark) + rect(83.5, -3, 12.5, 36, 5, c.dark) + rect(1, -2, 10.5, 11, 4, c.base) + rect(84.5, -2, 10.5, 11, 4, c.base) +
      rect(11.5, 26, 73, 7, 2.6, c.dark) + cushions
  }
}

function waterCooler() {
  return {
    name: 'water_cooler', w: 22.4, h: 22.4, pad: [7, 20, 7, 9],
    svg:
      shadow(rect(1.5, 6, 19.4, 16.4, 3, C.shadow), { alpha: 0.24 }) +
      rect(2, 4, 18.4, 18.4, 2.6, '#d9dee7') + rect(2, 20.6, 18.4, 1.8, 0.9, '#c3cad6') + rect(2, 2, 18.4, 9, 2.6, '#f4f5f8') +
      circle(8, 13.4, 1.15, '#5b8def') + circle(14.4, 13.4, 1.15, '#e8785f') + rect(6, 17, 10.4, 2, 1, '#bfc6d2') +
      // the bottle, standing up
      rect(4.2, -15, 14, 17, 6, '#a8d8f2', 'opacity=".95"') + rect(4.2, -9, 14, 11, 5, '#86c4ea', 'opacity=".9"') +
      rect(6.4, -13, 2.4, 11, 1.2, '#ffffff', 'opacity=".55"') + rect(8.7, 1, 5, 3, 1, '#6fb2df') +
      rect(-3.4, 6, 4.4, 8, 1.4, '#e3e7ee') + rect(-3, 5, 3.6, 2, 1, '#ffffff')
  }
}

function photoBooth() {
  const t = { top: '#b6aae6', hi: '#c9c0f0', face: '#9387ca', low: '#7f73b6' }
  const dots = ['#e8785f', '#f1ba72', '#4cc38a', '#5b8def', '#9a7fd1'].map((c, i) => circle(12 + i * 6.5, 0.5, 1.4, c)).join('')
  const folds = [57.5, 60.5, 63.5, 66.5].map((x) => `<path d="M ${x} 7 q 1 7 0 14 t 0 14" fill="none" stroke="#a84458" stroke-width="1" opacity=".7"/>`).join('')
  return {
    name: 'photo_booth', w: 70.4, h: 44.8, pad: [8, 14, 10, 9],
    svg:
      box(70.4, -6, 44.8, 12, t, 4) +
      rect(6, -3, 40, 7, 2, '#fdfdfe') + dots +
      // the camera's flash on the roof, with a glint
      rect(50, -3.4, 11, 7.4, 2, '#4b556b') + circle(55.5, 0.3, 2.3, '#e8eef8') + circle(55.5, 0.3, 1.1, '#9fb3d1') +
      `<path d="M 63 -9 l 1.1 3 l 3 1.1 l -3 1.1 l -1.1 3 l -1.1 -3 l -3 -1.1 l 3 -1.1 z" fill="#fff1a8"/>` +
      // the curtain on the open side
      rect(53, 5, 16.4, 1.8, 0.9, '#6f63a8') + rect(54.4, 6.2, 14, 30, 2, '#c4596d') + folds +
      rect(8, 9, 40, 22, 2.6, '#a69ad9') + rect(12, 13, 32, 14, 2, '#bfb4ec') + rect(22, 17, 12, 6, 1.4, '#fdfdfe', 'opacity=".75"') +
      rect(8, 35.5, 20, 4.2, 1, '#fdfdfe', 'opacity=".8"') + rect(10, 37, 12, 1.2, 0.6, '#9387ca')
  }
}

function kanban() {
  const heads = ['#5b8def', '#f1ba72', '#e990a8', '#4cc38a']
  const cards = ['#cfe0ff', '#fde7a6', '#fad1da', '#c9f0dc']
  const counts = [3, 2, 3, 2]
  let cols = ''
  for (let i = 0; i < 4; i++) {
    const x = 3.6 + i * 20.8
    cols += rect(x, -22.4, 18.4, 3, 1.2, heads[i])
    for (let k = 0; k < counts[i]; k++) cols += rect(x + 1, -17.4 + k * 7.6, 16.4, 6, 1, cards[(i + k) % 4]) + rect(x + 2.4, -15.6 + k * 7.6, 9 + ((i + k) % 3) * 2, 0.8, 0.4, '#8f99ab')
    if (i) cols += rect(x - 1.4, -22.4, 0.6, 30, 0.3, '#e3e7ee')
  }
  return {
    name: 'kanban', w: 89.6, h: 12.8, pad: [6, 30, 6, 8],
    svg: shadow(rect(1, 6, 87.6, 7, 2, C.shadow), { alpha: 0.22 }) + rect(0, -26, 89.6, 37, 2.5, '#c9d0db') + rect(1.8, -24.2, 86, 33.4, 1.6, '#fbfbfd') + cols
  }
}

function noticeBoard() {
  const notes = [[6, -19, '#f6dd7b', -6], [17, -15, '#cfe0ff', 4], [29, -20, '#fad1da', -3], [41, -14, '#c9f0dc', 7], [52, -19, '#fde7a6', -5], [12, -6, '#ffffff', 3], [36, -5, '#f6dd7b', -4], [56, -6, '#cfe0ff', 5]]
  const pinned = notes.map(([x, y, c, a], i) =>
    `<g transform="rotate(${a} ${x + 4.5} ${y + 4.5})">${rect(x + 0.4, y + 0.8, 9, 9, 0.6, C.shadow, 'opacity=".18"')}${rect(x, y, 9, 9, 0.6, c)}${rect(x + 1.5, y + 3.6, 6, 0.7, 0.35, '#a7afbf')}${rect(x + 1.5, y + 5.4, 4, 0.7, 0.35, '#a7afbf')}</g>` +
    circle(x + 4.5, y + 1.2, 1, ['#e8785f', '#5b8def', '#4cc38a'][i % 3])).join('')
  return {
    name: 'notice_board', w: 70.4, h: 9.6, pad: [6, 28, 6, 8],
    svg: shadow(rect(1, 4, 68.4, 7, 2, C.shadow), { alpha: 0.22 }) + rect(0, -24, 70.4, 33, 2.5, '#a8835c') + rect(2, -22, 66.4, 29, 1.6, '#d9b98f') +
      rect(2, -22, 66.4, 29, 1.6, 'url(#cork)') + pinned
  }
}

function vault() {
  const t = { top: '#cfd5de', hi: '#e3e7ed', face: '#a9b2c0', low: '#949eae' }
  const cx = 25, cy = 16
  const spokes = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (i * Math.PI) / 3 + 0.3
    return line(cx + Math.cos(a) * 2.6, cy + Math.sin(a) * 2.6, cx + Math.cos(a) * 7.6, cy + Math.sin(a) * 7.6, '#7d8798', 1.3)
  }).join('')
  return {
    name: 'vault', w: 60.8, h: 52.8, pad: [8, 10, 8, 9],
    svg:
      box(60.8, -4, 52.8, 13, t, 4) +
      rect(5, -0.5, 42, 33, 3, '#bdc4cf') + rect(7, 1.5, 38, 29, 2.2, '#c9cfd9') +
      rect(2.6, 4, 3.6, 6, 1.2, '#8f99aa') + rect(2.6, 20, 3.6, 6, 1.2, '#8f99aa') +
      circle(cx + 0.6, cy + 1, 9.6, C.shadow, 'opacity=".14"') + circle(cx, cy, 9.4, '#98a2b2') + circle(cx, cy, 7.9, '#e2e6ec') + spokes + circle(cx, cy, 2.6, '#7d8798') + circle(cx - 0.6, cy - 0.6, 0.9, '#c3c9d5') +
      rect(49.5, 6, 5.4, 16, 2.4, '#8f99aa') + rect(48.6, 24, 7.6, 6, 1.2, '#33465a') + circle(52.4, 26.2, 0.9, '#4cc38a') +
      rect(24, 42, 13, 3, 1, '#e3e7ed')
  }
}

/** A low shelf against the wall, books in it, a vase on top. */
function shelfLow() {
  return {
    name: 'shelf_low', w: 44.8, h: 14.4, pad: [6, 18, 6, 8],
    svg:
      shadow(rect(0.5, 2, 43.8, 13, 2, C.shadow), { alpha: 0.22 }) +
      rect(0, -10, 44.8, 24.4, 2, '#a8835c') + rect(2, -6, 40.8, 17.4, 1.2, '#6e5034') + books(3, 42, 11.4, 14) +
      rect(0, -12, 44.8, 5, 1.8, '#c79f75') + rect(1.5, -11.4, 41.8, 1, 0.5, '#d8b48a') +
      `<ellipse cx="36.4" cy="-11.6" rx="3.6" ry="1.6" fill="${C.shadow}" opacity=".18"/>` + rect(33, -16, 6, 5, 1.6, C.white) +
      circle(34.6, -17.4, 2.2, C.leafA) + circle(37.6, -17.8, 2.2, C.leafB) + circle(36, -19.6, 2, C.leafC)
  }
}
function bookshelf() {
  return {
    name: 'bookshelf', w: 51.2, h: 19.2, pad: [6, 30, 6, 8],
    svg:
      shadow(rect(0.5, 4, 50.2, 15, 2, C.shadow), { alpha: 0.24 }) +
      rect(0, -26, 51.2, 45, 2.2, '#6e4a33') + rect(2.2, -22, 46.8, 39, 1.2, '#4a3122') +
      books(3.2, 48, -9.5, 12) + books(4, 48, 3.5, 12) + books(3.2, 47, 16, 12) +
      rect(2.2, -9.5, 46.8, 1.6, 0.6, '#6e4a33') + rect(2.2, 3.5, 46.8, 1.6, 0.6, '#6e4a33') +
      rect(0, -28, 51.2, 5, 2, '#8a5f43') + rect(1.5, -27.4, 48.2, 1, 0.5, '#9d7052')
  }
}

function securityGate() {
  const t = { top: '#f6f4f0', hi: '#ffffff', face: '#d9d0c3', low: '#c5bbad' }
  return {
    name: 'security_gate', w: 64, h: 19.2, pad: [8, 18, 8, 22],
    svg:
      // a counter built into the wall, its front covering the wall's front below
      shadow(rect(0.5, 4, 63, 32, 3, C.shadow), { alpha: 0.24 }) +
      rect(0, 4, 64, 32, 3, t.face) + rect(0, 34.4, 64, 1.6, 0.8, t.low) + rect(4, 24, 56, 0.8, 0.4, '#cbc1b2') +
      rect(0, 0, 64, 24, 3, t.top) + rect(1.6, 0.9, 60.8, 1.1, 0.55, t.hi) +
      // the glass screen on its back edge, with a gap to pass papers through
      rect(3, -14, 58, 15, 1.6, '#cfe4f3', 'opacity=".6"') + rect(3, -14, 58, 1.4, 0.7, '#a9c3d6') +
      `<path d="M 10 -12 L 16 -12 L 9 -2 L 5 -2 Z" fill="#ffffff" opacity=".45"/>` + rect(24, -1.6, 16, 3, 1.2, '#e6eef4') +
      // an in-tray with memos, a bell
      rect(7, 6, 15, 10, 1.4, '#e3e7ee') + paper(8.6, 6.6, 11, 8, -4, '#f1ba72') +
      `<ellipse cx="49" cy="12.6" rx="3.4" ry="1.4" fill="${C.shadow}" opacity=".2"/>` + rect(45.8, 11, 6.4, 1.6, 0.8, '#b8964e') + `<path d="M 46.4 11.2 a 2.6 2.6 0 0 1 5.2 0 z" fill="#e7c77d"/>` + circle(49, 8.2, 0.7, '#f6e2a6') +
      // the posts of the gate, a green light on each
      rect(-3, -8, 4.2, 30, 1.8, '#9aa4b4') + rect(62.8, -8, 4.2, 30, 1.8, '#9aa4b4') + circle(-0.9, -7.4, 1.7, '#4cc38a') + circle(64.9, -7.4, 1.7, '#4cc38a')
  }
}

function plantTall() {
  const cx = 11.2
  const leaf = (x, y, rx, ry, angle, fill) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" transform="rotate(${angle} ${x} ${y})"/>`
  const stem = `<path d="M ${cx} 14 C ${cx - 1} 4, ${cx + 1} -6, ${cx} -16" fill="none" stroke="#6b5443" stroke-width="1.4"/>`
  return {
    name: 'plant_tall', w: 22.4, h: 22.4, pad: [12, 30, 12, 9],
    svg:
      shadow(`<ellipse cx="${cx}" cy="19" rx="9" ry="5"/>`, { alpha: 0.26 }) +
      `<path d="M ${cx - 6.6} 12 L ${cx - 5} 21 Q ${cx} 23.4 ${cx + 5} 21 L ${cx + 6.6} 12 Z" fill="#4b556b"/>` +
      `<path d="M ${cx + 1.5} 12 L ${cx + 1.2} 22.6 Q ${cx + 3.6} 22 ${cx + 5} 21 L ${cx + 6.6} 12 Z" fill="#3e4759"/>` +
      `<ellipse cx="${cx}" cy="12" rx="6.6" ry="2.3" fill="#5e6a83"/><ellipse cx="${cx}" cy="12.1" rx="5.3" ry="1.6" fill="${C.soil}"/>` + stem +
      leaf(cx - 6, 4, 4.4, 6, -40, C.leafA) + leaf(cx + 6, 2, 4.4, 6, 40, C.leafA) + leaf(cx - 5, -8, 4.2, 5.8, -30, C.leafB) +
      leaf(cx + 5.5, -10, 4.2, 5.8, 35, C.leafB) + leaf(cx - 1, -18, 4.6, 6, -8, C.leafC) + leaf(cx + 2, -2, 3.8, 5.2, 20, C.leafC) + leaf(cx - 2.6, 10, 3.8, 4.8, -60, C.leafB)
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

const SPRITES = [
  desk('desk'), desk('desk_b'), desk('desk_c'), deskManager(), deskCeo(), chairSeat(), chairBack(), chairManager(), chairCeo(), armchair(),
  plant(), plantTall(), mat(), printer(), filingCabinet(), serverRack(0), serverRack(1), whiteboard(), sofa(), waterCooler(), photoBooth(),
  kanban(), noticeBoard(), vault(), shelfLow(), bookshelf(), securityGate()
]
const ATLAS_SCALE = 4

function atlas() {
  const gap = 2
  const cells = SPRITES.map((s, i) => {
    const [l, t, rr, b] = s.pad
    return { s, i, w: Math.ceil((s.w + l + rr) * ATLAS_SCALE), h: Math.ceil((s.h + t + b) * ATLAS_SCALE) }
  }).sort((a, b) => b.h - a.h || a.i - b.i)
  // Shelf packing, in the order given, into the smallest power-of-two width that keeps it squarish.
  const pack = (W) => {
    let x = gap, y = gap, rowH = 0
    for (const c of cells) {
      if (x + c.w + gap > W) { x = gap; y += rowH + gap; rowH = 0 }
      c.x = x; c.y = y; x += c.w + gap; rowH = Math.max(rowH, c.h)
    }
    return y + rowH + gap
  }
  // The smallest power-of-two page it fits on (squarer wins a tie), at most 2048 x 2048.
  let W = 0, H = 0
  for (const w of [512, 1024, 2048]) {
    const h = pot(pack(w))
    if (h <= 2048 && (!W || w * h < W * H || (w * h === W * H && Math.abs(w - h) < Math.abs(W - H)))) { W = w; H = h }
  }
  if (!W) throw new Error('the furniture does not fit on a 2048 x 2048 atlas')
  pack(W)
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

// ---- floor + walls pictures ----------------------------------------------------------------------
const FLOOR_SCALE = 2
const MARGIN = 24 // must match the image layers' offset in gen-office-map.cjs
const FACE = 16 //   height of a wall's visible front
const OUTSET = 3 //  outside walls are drawn this much thicker, outwards (they still block only their rectangle)

/** Floor finishes by the name of the map rectangle they fill (the rest gets FLOORS.floor). */
const FLOORS = {
  floor: { kind: 'tiles', base: C.floor, alt: C.floorAlt, seam: C.seam, size: 64 },
  reception: { kind: 'tiles', base: '#f4f2ed', alt: '#f0ede7', seam: '#e4e0d8', size: 64 },
  mgr_room: { kind: 'planks', base: C.wood, alt: C.woodAlt, seam: C.woodSeam },
  ceo_room: { kind: 'planks', base: '#e0c49c', alt: '#dbbd93', seam: '#cdab7e' }
}
/** Rugs, also by name: flat, so they are part of the floor rather than sprites. */
const RUGS = {
  lounge_rug: { base: '#d8e4d3', border: '#c3d4bd', inner: '#e3ece0' },
  ceo_rug: { base: '#3f4d6e', border: '#d3b46d', inner: '#4a5a80' }
}

function finish(f, x0, y0, w, h) {
  let out = rect(x0, y0, w, h, 0, f.base)
  if (f.kind === 'tiles') {
    const s = f.size
    for (let y = 0; y < y0 + h; y += s) for (let x = (y / s) % 2 ? s : 0; x < x0 + w; x += s * 2) if (x + s > x0 && y + s > y0) out += rect(x, y, s, s, 0, f.alt)
    for (let x = s; x < x0 + w; x += s) if (x > x0) out += rect(x - 0.5, y0, 1, h, 0, f.seam)
    for (let y = s; y < y0 + h; y += s) if (y > y0) out += rect(x0, y - 0.5, w, 1, 0, f.seam)
  } else {
    const ph = 32 / 3
    for (let i = 0, y = y0; y < y0 + h - 0.1; y += ph, i++) {
      if (i % 2) out += rect(x0, y, w, ph, 0, f.alt)
      out += rect(x0, y - 0.4, w, 0.8, 0, f.seam)
      for (let x = x0 + [38, 86, 14, 62][i % 4]; x < x0 + w; x += 96) out += rect(x - 0.4, y, 0.8, ph, 0, f.seam)
    }
  }
  return out
}

function rug(o, k) {
  return (
    shadow(rect(o.x, o.y, o.width, o.height, 5, C.shadow), { blur: 'S', alpha: 0.18, dx: 0.6, dy: 1.4 }) +
    rect(o.x, o.y, o.width, o.height, 5, k.base) + rect(o.x + 4, o.y + 4, o.width - 8, o.height - 8, 3, 'none', `stroke="${k.border}" stroke-width="2"`) +
    rect(o.x + 9, o.y + 9, o.width - 18, o.height - 18, 2, k.inner)
  )
}

function floorPicture(file) {
  const map = JSON.parse(fs.readFileSync(path.join(THEME, file), 'utf8'))
  const W = map.width * map.tilewidth, H = map.height * map.tileheight
  const objs = (n) => map.layers.find((l) => l.type === 'objectgroup' && l.name === n).objects
  const walls = objs('walls')
  const furniture = objs('furniture')
  const horiz = walls.filter((w) => w.width >= w.height), vert = walls.filter((w) => w.width < w.height)

  let floor = finish(FLOORS.floor, 0, 0, W, H)
  for (const o of furniture) {
    const f = o.name !== 'floor' && FLOORS[o.name]
    if (!f) continue
    floor += `<clipPath id="zone-${o.id}"><rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}"/></clipPath><g clip-path="url(#zone-${o.id})">${finish(f, o.x, o.y, o.width, o.height)}</g>`
  }
  for (const o of furniture) if (RUGS[o.name]) floor += rug(o, RUGS[o.name])

  // Doorways: where two walls on one line leave a gap.
  let doors = '', steps = ''
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
      // A door in the front wall gets a step where the wall's front would be.
      if (along === 'x' && a.y + a.height >= H) steps += rect(from, H, to - from, FACE, 0, C.wallFace) + rect(from, H, to - from, FACE - 5, 0, C.threshold) + rect(from, H + FACE - 5, to - from, 1, 0, C.thresholdLine)
    }
  }
  gapsOf(horiz, 'x', 'y', 'width', 'height')
  gapsOf(vert, 'y', 'x', 'height', 'width')

  // The walls as drawn: outside walls a little thicker outwards, inside walls a little either side.
  const drawn = walls.map((w) => {
    const e = { x: w.x, y: w.y, width: w.width, height: w.height, across: w.width >= w.height }
    const grow = (k, lo, hi) => {
      if (k === 'x') {
        if (lo) { e.x -= OUTSET; e.width += OUTSET }
        if (hi) e.width += OUTSET
      } else {
        if (lo) { e.y -= OUTSET; e.height += OUTSET }
        if (hi) e.height += OUTSET
      }
    }
    const edgeX = w.x <= 0 || w.x + w.width >= W, edgeY = w.y <= 0 || w.y + w.height >= H
    if (e.across) {
      if (edgeY) grow('y', w.y <= 0, w.y + w.height >= H)
      else { e.y -= 1; e.height += 2 }
      grow('x', w.x <= 0, w.x + w.width >= W)
    } else {
      if (edgeX) grow('x', w.x <= 0, w.x + w.width >= W)
      else { e.x -= 1; e.width += 2 }
      grow('y', w.y <= 0, w.y + w.height >= H)
    }
    return e
  })
  const faces = drawn.map((w) => rect(w.x, w.y + w.height - 2, w.width, FACE + 2, 0, C.wallFace) + rect(w.x, w.y + w.height + FACE - 5, w.width, 5, 0, C.wallFaceMid) + rect(w.x, w.y + w.height + FACE - 1.6, w.width, 1.6, 0, C.wallFaceLow)).join('')
  // Walls across first (with a soft line where the top meets the front), then the ones running down
  // the map over them, so a corner is one clean white shape.
  const caps = drawn.filter((w) => w.across).map((w) => rect(w.x, w.y, w.width, w.height, 0, C.wallCap) + rect(w.x, w.y + 0.6, w.width, 1.2, 0, C.white) + rect(w.x, w.y + w.height - 1.4, w.width, 1.4, 0, C.wallEdge)).join('') +
    drawn.filter((w) => !w.across).map((w) => rect(w.x, w.y, w.width, w.height, 0, C.wallCap) + rect(w.x + 0.6, w.y, 1.2, w.height, 0, C.white)).join('')
  const silhouettes = drawn.map((w) => rect(w.x, w.y, w.width, w.height + FACE, 0, C.shadow)).join('')

  const vw = W + MARGIN * 2, vh = H + MARGIN * 2
  const pw = vw * FLOOR_SCALE, ph = vh * FLOOR_SCALE
  const O = OUTSET
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="${-MARGIN} ${-MARGIN} ${vw} ${vh}">${DEFS}
 <clipPath id="slab"><rect x="0" y="0" width="${W}" height="${H}" rx="3"/></clipPath>
 <clipPath id="building"><rect x="${-O}" y="${-O}" width="${W + 2 * O}" height="${H + 2 * O + FACE}" rx="4"/></clipPath>
 <g filter="url(#blurL)" opacity=".5"><rect x="${1 - O}" y="${3 - O}" width="${W - 2 + 2 * O}" height="${H + 2 * O + FACE}" rx="5" fill="#0b0e1a"/></g>
 <g clip-path="url(#slab)">${floor}${doors}
  <g filter="url(#blurL)" opacity=".22" transform="translate(3 5)">${silhouettes}</g>
  <g filter="url(#blur)" opacity=".16" transform="translate(1 2)">${silhouettes}</g>
 </g>
 <g clip-path="url(#building)">${steps}${faces}${caps}</g>
</svg>`
  return { svg, w: pw, h: ph, W: pot(pw), H: pot(ph) }
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
    for (const name of ['branch', 'hq']) {
      const f = floorPicture(name + '.json')
      fs.writeFileSync(path.join(OUT, name + '-floor.png'), await png(f.svg, f.w, f.h, f.W, f.H))
      console.log(`${name}-floor.png ${f.W}x${f.H} (picture ${f.w}x${f.h} at ${FLOOR_SCALE}x)`)
    }
    win.destroy()
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  app.quit()
})
