// Generates assets/logo.svg (full) and assets/logo-small.svg (simplified for 16-24 px).
// PNG/ICO rendering: `npx electron scripts/render-icons.cjs`.
const fs = require('fs'), path = require('path')
const NAVY = '#2b2d42', EDGE = '#4a4e73', DESK = '#a1887f', DESKD = '#7d6558'
const SKIN = '#f0c8a0', OUT = '#1b1c2b'
const ORANGE = '#d97757', TEAL = '#4fb3a8', BLUE = '#5b8def'
const r = (n) => Math.round(n * 100) / 100
// Prison-Architect-style figure: shadow, blob body, oval head, hair
function fig(cx, by, s, body, hair, extra = '') {
  const bw = 11 * s, bh = 13 * s, hr = 5.2 * s
  return `<g>
  <ellipse cx="${cx}" cy="${by}" rx="${r(bw * 0.62)}" ry="${r(2.2 * s)}" fill="#000" opacity=".28"/>
  <rect x="${r(cx - bw / 2)}" y="${r(by - bh)}" width="${r(bw)}" height="${r(bh)}" rx="${r(5 * s)}" fill="${body}" stroke="${OUT}" stroke-width="${r(1.1 * s)}"/>
  <rect x="${r(cx - bw / 2 + 1.1 * s)}" y="${r(by - 4.2 * s)}" width="${r(bw - 2.2 * s)}" height="${r(3.2 * s)}" rx="${r(2.4 * s)}" fill="#000" opacity=".16"/>
  ${extra}
  <circle cx="${cx}" cy="${r(by - bh - hr * 0.55)}" r="${r(hr)}" fill="${SKIN}" stroke="${OUT}" stroke-width="${r(1.1 * s)}"/>
  <path d="M ${r(cx - hr)} ${r(by - bh - hr * 0.75)} a ${r(hr)} ${r(hr)} 0 0 1 ${r(2 * hr)} 0 q ${r(-hr)} ${r(-hr * 0.7)} ${r(-2 * hr)} 0 z" fill="${hair}" stroke="${OUT}" stroke-width="${r(0.9 * s)}" stroke-linejoin="round"/>
 </g>`
}
const tie = (cx, by, s) =>
  `<path d="M ${r(cx - 1.3 * s)} ${r(by - 12.4 * s)} h ${r(2.6 * s)} l ${r(-0.5 * s)} ${r(2 * s)} l ${r(1.1 * s)} ${r(4.6 * s)} l ${r(-1.9 * s)} ${r(1.9 * s)} l ${r(-1.9 * s)} ${r(-1.9 * s)} l ${r(1.1 * s)} ${r(-4.6 * s)} z" fill="#c0392b" stroke="${OUT}" stroke-width="${r(0.5 * s)}"/>`
const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
 <defs><clipPath id="tile"><rect x="2" y="2" width="60" height="60" rx="14"/></clipPath></defs>
 <rect x="2" y="2" width="60" height="60" rx="14" fill="${NAVY}"/>
 <g clip-path="url(#tile)">${inner}</g>
 <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="13.25" fill="none" stroke="${EDGE}" stroke-width="1.5"/>
</svg>
`
const desk = (x, y, w) => `<rect x="${x}" y="${y}" width="${w}" height="9" rx="2.5" fill="${DESK}" stroke="${OUT}" stroke-width="1.1"/>
 <rect x="${x}" y="${y + 6}" width="${w}" height="3" rx="1.5" fill="${DESKD}"/>`

const full = frame(`
 <rect x="2" y="40" width="60" height="22" fill="#353852"/>
 ${fig(17, 43, 1.0, TEAL, '#3b2a20')}
 ${fig(47, 43, 1.0, BLUE, '#d9b25f')}
 ${fig(32, 44, 1.28, ORANGE, '#5a3825', tie(32, 44, 1.28))}
 ${desk(7, 43, 50)}`)

// Tiny sizes: just the manager, bigger, with team-colour dots.
const small = frame(`
 <rect x="2" y="44" width="60" height="18" fill="#353852"/>
 <circle cx="12" cy="14" r="5" fill="${TEAL}"/><circle cx="52" cy="14" r="5" fill="${BLUE}"/>
 ${fig(32, 50, 2.0, ORANGE, '#5a3825', tie(32, 50, 2.0))}
 ${desk(6, 48, 52)}`)

const out = path.join(__dirname, '..', 'assets')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'logo.svg'), full)
fs.writeFileSync(path.join(out, 'logo-small.svg'), small)
console.log('wrote assets/logo.svg, assets/logo-small.svg')
