// Renders the art preview into docs/art-preview/ (one room of the office theme, for judging the look):
//   office-full-1x.png                      the app as it opens: HQ + three teams at the default fit
//   office-full-2x.png                      the HQ and the first branch, closer
//   hq-2x.png, branch-2x.png                one building each at camera zoom 2
//   stations.png                            every station of a branch with someone working at it
//   office-6-teams.png                      six teams: the default zoom gets small
//   sprites.png                             every sprite drawn so far, on a neutral background
//   compare.png                             our room beside a crop of the reference (only when
//                                           docs/reference/office-reference.png exists; local, not committed)
//
//   npx electron scripts/art-preview.cjs
//
// It starts its own renderer dev server (Vite, port 5263, with the themes folder served) and opens
// the app's browser stub in its own hidden window: no agents, no main process, nothing shared with a
// running Agent Office. Fake agents are staged with the stub's event hook (managers at their desks,
// workers at desks and stations, a manager queuing at the HQ's security gate).
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path')

const REPO = path.join(__dirname, '..')
// AO_PREVIEW_OUT=<dir> writes somewhere else; AO_PREVIEW_NO_ART=1 leaves the theme's pictures
// unreachable, to check that the office then falls back to its coloured rectangles.
const OUT = process.env.AO_PREVIEW_OUT || path.join(REPO, 'docs', 'art-preview')
const NO_ART = process.env.AO_PREVIEW_NO_ART === '1'
const REFERENCE = path.join(REPO, 'docs', 'reference', 'office-reference.png')
const PORT = 5263
const MIME = { '.png': 'image/png', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

app.setPath('userData', path.join(os.tmpdir(), 'agent-office-art-preview'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startServer() {
  const vite = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const themes = {
    name: 'serve-themes',
    configureServer(server) {
      server.middlewares.use('/themes', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0])
        const file = path.join(REPO, 'themes', rel)
        if (NO_ART) return next()
        if (!file.startsWith(path.join(REPO, 'themes') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
        res.end(fs.readFileSync(file))
      })
    }
  }
  const server = await vite.createServer({
    configFile: false, root: path.join(REPO, 'src'), plugins: [react(), themes], logLevel: 'warn',
    server: { port: PORT, strictPort: true, host: '127.0.0.1' },
    cacheDir: path.join(REPO, 'node_modules', '.vite-art-preview')
  })
  await server.listen()
  return server
}

app.whenReady().then(async () => {
  let server = null
  try {
    fs.mkdirSync(OUT, { recursive: true })
    server = await startServer()
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } })
    win.webContents.setFrameRate(30)
    const logs = []
    win.webContents.on('console-message', (e) => { if (e.level === 'warning' || e.level === 'error') logs.push(`[${e.level}] ${e.message}`) })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const until = async (what, cond, ms = 40000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (await js(`(() => { try { return !!(${cond}) } catch { return false } })()`)) return
        await sleep(100)
      }
      throw new Error('timed out waiting for ' + what)
    }
    const save = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); console.log('saved ' + path.relative(REPO, path.join(OUT, name))) }
    const shot = async (name, rect) => {
      await sleep(350)
      const img = await win.webContents.capturePage(rect)
      const size = img.getSize()
      if (rect && (size.width !== rect.width || size.height !== rect.height)) console.warn(`${name}: captured ${size.width}x${size.height}, wanted ${rect.width}x${rect.height}`)
      save(name, img.toPNG())
      return img
    }

    /** A fresh office (nothing running), the scene handle as `sc`, `ev(...)` to send an agent event. */
    const fresh = async (query = '', panel = false) => {
      win.setContentSize(1440, 900)
      await win.loadURL(`http://127.0.0.1:${PORT}/?stub=empty&restore=none&progress=quiet&board=none${query}`)
      await until('the scene', '__agentOfficeDev.scene()')
      await js(`window.sc = __agentOfficeDev.scene(); window.ev = (agentId, parentId, provider, displayName, activity, detail = '') => __agentOfficeEmit({ agentId, parentId, provider, displayName, activity, detail }); ${panel ? '' : '__agentOfficeDev.app.setLayout({ panelOpen: false, inboxOpen: false }, false);'} 0`)
      await sleep(400)
    }
    const built = (id) => until(`branch ${id} to be built`, `sc.views.get('${id}') && sc.views.get('${id}').state === 'ready'`, 60000)
    const settledAll = (ids) => until('everyone to settle', ids.map((id) => `sc.chars.get('${id}') && sc.chars.get('${id}').isIdle`).join(' && '), 180000)
    /** The world over the whole window (no shell), the camera on a world rect at a zoom; saves the view. */
    const alone = () => js(`(() => {
      const hide = document.createElement('style')
      hide.textContent = '.world { position: fixed !important; inset: 0; z-index: 99999 } .world > *:not(.world-canvas):not(.world-tags) { display: none !important }'
      document.head.appendChild(hide)
      sc.autoFit = false
    })()`)
    const view = async (name, rectJs, zoom) => {
      const r0 = await js(`(() => { const r = ${rectJs}; return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      const w = Math.round(r0.width * zoom), h = Math.round(r0.height * zoom)
      win.setContentSize(w, h)
      await sleep(500)
      await js(`(() => { window.dispatchEvent(new Event('resize')); sc.scale.refresh(); const cam = sc.cameras.main; cam.setZoom(${zoom}); cam.centerOn(${r0.x + r0.width / 2}, ${r0.y + r0.height / 2}) })()`)
      await sleep(400)
      await js(`sc.syncOverlay(); 0`)
      return shot(name, { x: 0, y: 0, width: w, height: h })
    }
    const blockRect = (id, pad = 28) => `(() => { const b = ${id === 'hq' ? 'sc.layout.hq' : `sc.layout.branch('${id}')`}; return { x: b.offset.x - ${pad}, y: b.offset.y - ${pad + 24}, width: b.width + ${pad * 2}, height: b.height + ${pad * 2 + 24} } })()`

    // AO_PREVIEW_ONLY=office,stations,six renders only those parts.
    const want = (part) => !process.env.AO_PREVIEW_ONLY || process.env.AO_PREVIEW_ONLY.split(',').includes(part)
    let cmpImg = null
    if (want('office')) {
    // ---- 1. The office: HQ and three teams (Claude, Codex, Antigravity), people at work ------------
    await fresh()
    console.log('renderer:', await js(`(() => { const g = sc.game; return (g.renderer.gl ? 'WebGL' : 'Canvas') + ', pixelArt ' + g.config.pixelArt + ', mipmaps ' + g.config.mipmapFilter + ', furniture atlas ' + g.textures.exists('art:furniture') + ', floor pictures ' + g.textures.exists('floor:branch:0') + '/' + g.textures.exists('floor:hq:0') })()`))
    const teams = [['m1', 'claude-code', 'frontend', [['w1', 'codex', 'Builder'], ['w2', 'antigravity', 'Explore']]],
      ['m2', 'codex', 'storefront', [['w3', 'codex', 'Tests'], ['w4', 'claude-code', 'Docs']]],
      ['m3', 'antigravity', 'gemini', [['w5', 'antigravity', 'Research'], ['w6', 'codex', 'Lint']]]]
    for (const [m, prov, name, workers] of teams) {
      await js(`ev('${m}', null, '${prov}', '${name}', 'write', 'plan.md')`)
      await built(m)
      for (const [w, wp, wn] of workers) await js(`ev('${w}', '${m}', '${wp}', '${wn}', 'write', 'src/app.ts')`)
    }
    await settledAll(['m1', 'm2', 'm3', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6'])
    await sleep(1500)
    // Some work at stations, a manager waiting at the HQ's security gate, the rest typing.
    await js(`ev('w1', 'm1', 'codex', 'Builder', 'write', 'src/app.ts'); ev('w2', 'm1', 'antigravity', 'Explore', 'web', 'docs.example.com');
      ev('w3', 'm2', 'codex', 'Tests', 'exec', 'npm test'); ev('w4', 'm2', 'claude-code', 'Docs', 'read', 'README.md');
      ev('w5', 'm3', 'antigravity', 'Research', 'write', 'planning: the release'); ev('w6', 'm3', 'codex', 'Lint', 'write', 'src/lint.ts');
      ev('m1', null, 'claude-code', 'frontend', 'write', 'plan.md'); ev('m3', null, 'antigravity', 'gemini', 'write', 'notes.md');
      ev('m2', null, 'codex', 'storefront', 'waiting', 'question: ship it?')`)
    await until('the manager at the security gate', `(() => { const c = sc.chars.get('m2'), h = sc.layout.hq; return c.isSettled && c.position.y < h.offset.y + h.height && c.position.y > h.offset.y + 160 })()`, 30000)
    await js(`ev('w1', 'm1', 'codex', 'Builder', 'write', 'src/app.ts'); ev('w6', 'm3', 'codex', 'Lint', 'write', 'src/lint.ts'); ev('m1', null, 'claude-code', 'frontend', 'write', 'plan.md'); ev('m3', null, 'antigravity', 'gemini', 'write', 'notes.md')`)
    await sleep(700)
    await js(`sc.scene.pause(); 0`)
    console.log('portrait:', await js(`new Promise((ok) => sc.portrait('w1', (url) => ok(url ? url.length + ' chars' : 'none')))`))
    console.log('poses:', await js(`JSON.stringify([...sc.chars.entries()].map(([id, c]) => id + ':' + c.pose))`))
    // The app as it opens: default fit, side panel closed.
    await js(`sc.autoFit = true; sc.fitCamera(false); 0`)
    await sleep(500)
    await js(`sc.syncOverlay(); 0`)
    await shot('office-full-1x.png')
    await alone()
    await view('office-full-2x.png', `(() => { const h = sc.layout.hq, b = sc.layout.branch('m1'); const x0 = Math.min(h.offset.x, b.offset.x) - 30, y0 = Math.min(h.offset.y, b.offset.y) - 50; return { x: x0, y: y0, width: Math.max(h.offset.x + h.width, b.offset.x + b.width) - x0 + 30, height: Math.max(h.offset.y + h.height, b.offset.y + b.height) - y0 + 40 } })()`, 1.25)
    await view('hq-2x.png', blockRect('hq'), 2)
    cmpImg = await view('branch-2x.png', blockRect('m1'), 2)
    }
    if (want('stations')) {

    // ---- 2. Every station with someone working at it ---------------------------------------------
    await fresh()
    const jobs = [['s1', 'codex', 'Files', 'read', 'src/index.ts'], ['s2', 'antigravity', 'Shell', 'exec', 'npm run build'], ['s3', 'claude-code', 'Web', 'web', 'docs.example.com'],
      ['s4', 'codex', 'Snap', 'capture', 'screen.png'], ['s5', 'antigravity', 'Plan', 'write', 'planning: next steps'], ['s6', 'claude-code', 'Board', 'write', 'checking the board'],
      ['s7', 'codex', 'Keys', 'write', 'secrets: .env'], ['s8', 'antigravity', 'Editor', 'write', 'src/app.ts']]
    await js(`ev('m1', null, 'claude-code', 'frontend', 'write', 'plan.md')`)
    await built('m1')
    for (const [id, p, n] of jobs) await js(`ev('${id}', 'm1', '${p}', '${n}', 'write', 'src/x.ts')`)
    await settledAll(['m1', ...jobs.map((j) => j[0])])
    const again = `${jobs.map(([id, p, n, a, d]) => `ev('${id}', 'm1', '${p}', '${n}', '${a}', ${JSON.stringify(d)})`).join(';')}; ev('m1', null, 'claude-code', 'frontend', 'write', 'plan.md')`
    let ok = false
    for (let i = 0; i < 40 && !ok; i++) {
      await js(again)
      await sleep(1000)
      ok = await js(`[${jobs.map((j) => `'${j[0]}'`).join(',')}].every((id) => { const c = sc.chars.get(id); return c.isSettled && !['idle', 'sit', 'sit_back'].includes(c.pose) })`)
    }
    await js(again)
    await sleep(500)
    await js(`sc.scene.pause(); 0`)
    console.log('stations:', await js(`JSON.stringify([...sc.chars.entries()].map(([id, c]) => id + ':' + c.pose))`))
    await alone()
    await view('stations.png', blockRect('m1'), 2)
    }
    if (want('six')) {

    // ---- 3. Six teams, with the side panel open as the app starts: the default zoom gets small ----
    await fresh('', true)
    const six = ['claude-code', 'codex', 'antigravity', 'claude-code', 'codex', 'antigravity']
    for (let i = 0; i < 6; i++) {
      await js(`ev('t${i}', null, '${six[i]}', 'team ${i + 1}', 'write', 'plan.md'); ev('t${i}w', 't${i}', '${six[(i + 1) % 6]}', 'helper', 'write', 'src/a.ts')`)
      await built(`t${i}`)
    }
    await sleep(3000)
    await js(`sc.autoFit = true; sc.fitCamera(false); 0`)
    await sleep(600)
    await js(`sc.syncOverlay(); 0`)
    console.log('six teams zoom:', await js(`sc.cameras.main.zoom.toFixed(2)`))
    await shot('office-6-teams.png')
    }

    // Every sprite: the furniture atlas frames, then the character's poses in three provider colours.
    const sheet = NO_ART || !want('sprites') ? null : await js(`(async () => {
      const m = await import('/scene/charTextures.ts')
      const theme = sc.manifest
      const S = 3, FS = 2
      const furn = sc.textures.get('art:furniture')
      const names = furn.getFrameNames()
      const fscale = Number(furn.customData.meta.scale)
      const W = 1900, pad = 28
      const c = document.createElement('canvas')
      c.width = W; c.height = 2000
      const g = c.getContext('2d')
      g.fillStyle = '#e9ebf0'; g.fillRect(0, 0, c.width, c.height)
      const caption = (t, x, y, bold) => { g.fillStyle = bold ? '#30364a' : '#6b7286'; g.font = (bold ? '600 15px' : '12px') + ' system-ui, sans-serif'; g.textAlign = 'left'; g.fillText(t, x, y) }
      let x = pad, y = pad + 6
      caption('Furniture (themes/office/art/furniture.png), shown at 2x; @1 = second frame of an animated one', pad, y, true); y += 14
      let rowH = 0
      for (const n of names) {
        const f = furn.get(n)
        const w = f.width / fscale * FS, h = f.height / fscale * FS
        if (x + w > W - pad) { x = pad; y += rowH + 26; rowH = 0 }
        g.drawImage(f.source.image, f.cutX, f.cutY, f.width, f.height, x, y, w, h)
        caption(n, x + 8, y + h + 12)
        x += w + 16; rowH = Math.max(rowH, h)
      }
      y += rowH + 54
      const person = (bodyFrame, over, overFrame, tint, x, y, drop) => {
        const body = sc.textures.get('ph:body'), bf = body.get(bodyFrame)
        const t = document.createElement('canvas'); t.width = bf.width; t.height = bf.height
        const tg = t.getContext('2d')
        tg.drawImage(bf.source.image, bf.cutX, bf.cutY, bf.width, bf.height, 0, 0, bf.width, bf.height)
        tg.globalCompositeOperation = 'multiply'; tg.fillStyle = tint; tg.fillRect(0, 0, t.width, t.height)
        tg.globalCompositeOperation = 'destination-in'; tg.drawImage(bf.source.image, bf.cutX, bf.cutY, bf.width, bf.height, 0, 0, bf.width, bf.height)
        const k = S / m.RES
        const sh = sc.textures.get('ph:shadow').get()
        g.drawImage(sh.source.image, 0, 0, sh.width, sh.height, x + (bf.width - sh.width) / 2 * k, y + (36 - 8 - 1) * S, sh.width * k, sh.height * k)
        g.drawImage(t, x, y, bf.width * k, bf.height * k)
        const of = sc.textures.get(over).get(overFrame)
        g.drawImage(of.source.image, of.cutX, of.cutY, of.width, of.height, x, y + drop * S, of.width * k, of.height * k)
      }
      const tints = [['Claude', theme.providers['claude-code'].tint], ['Codex', theme.providers.codex.tint], ['Antigravity', theme.providers.antigravity.tint], ['default', theme.providers.default.tint]]
      const team = [0x3cb44b, 0x4363d8, 0xf58231, 0x911eb4]
      const poses = [['stand', 'front', 0, 'idle'], ['walkA', 'front', 0, 'walk'], ['walkB', 'front', 0, ''], ['carryA', 'front', 0, 'carry'], ['workA', 'front', 0, 'work'], ['workB', 'front', 0, ''],
        ['sitFront', 'front', 3, 'sit'], ['typeFrontA', 'front', 3, 'type'], ['sitBack', 'back', 3, 'sit (back)'], ['typeBackA', 'back', 3, 'type (back)'],
        ['workBackA', 'back', 0, 'work (back)'], ['workBackB', 'back', 0, ''], ['sideStand', 'side', 0, 'side'], ['walkSideA', 'side', 0, 'walk (side)'], ['walkSideB', 'side', 0, ''], ['carrySideA', 'side', 0, 'carry (side)'], ['workSideA', 'side', 0, 'work (side)']]
      caption('Characters: white body tinted with the provider colour; head, hair, face, collar and accessory are untinted. Shown at 3x', pad, y, true); y += 10
      const styles = ['short', 'bun', 'spiky', 'long']
      tints.forEach(([label, tint], row) => {
        const worker = m.placeholderSkin(sc, 'worker', theme.roles.worker.placeholder, row + 1, { collar: team[row] })
        const manager = m.placeholderSkin(sc, 'manager', theme.roles.manager.placeholder, row, { head: { style: styles[row], hair: (row * 2 + 1) % 6, skin: (row * 5) % 6 }, accent: team[row], collar: team[row] })
        caption(label + ' worker', pad, y + 16)
        poses.forEach(([bf, of, drop, name], i) => { person(bf, worker.overlay, of, tint, pad + i * 84, y + 14, drop); if (row === 0 && name) caption(name, pad + i * 84 + 18, y + 134) })
        const mx = pad + poses.length * 84 + 30
        caption(label + ' manager', mx, y + 16)
        ;[['stand', 'front', 0], ['typeFrontA', 'front', 3], ['sitBack', 'back', 3]].forEach(([bf, of, drop], i) => person(bf, manager.overlay, of, tint, mx + i * 84, y + 14, drop))
        y += 138
      })
      // The CEO, the other accessories and hair styles, and the carried items.
      y += 8
      caption('Roles, accessories, hair, carried items', pad, y, true)
      const boss = m.placeholderSkin(sc, 'boss', theme.roles.boss.placeholder, 2, {})
      person('stand', boss.overlay, 'front', theme.providers.human.tint, pad, y + 6, 0); caption('CEO (tie)', pad + 26, y + 136)
      const extra = [['cap', '#3d7fd1', {}, 'cap'], ['peaked_cap', '#34495e', {}, 'peaked cap'], ['baton', '#444b5c', {}, 'baton'], ['number', '#f5f5f5', {}, 'number'],
        ['none', '#fff', { head: { style: 'bald', hair: 4, skin: 4 } }, 'bald'], ['none', '#e6194b', { head: { style: 'cap', hair: 0, skin: 1 }, accent: 0xe6194b }, 'cap (hair)'], ['none', '#fff', { head: { style: 'long', hair: 2, skin: 0 } }, 'long'], ['none', '#fff', { head: { style: 'bun', hair: 3, skin: 2 } }, 'bun']]
      extra.forEach(([accessory, accent, look, name], i) => {
        const sk = m.placeholderSkin(sc, 'worker', { accessory, accent }, i, look)
        person('stand', sk.overlay, 'front', tints[i % 4][1], pad + 110 + i * 100, y + 6, 0)
        caption(name, pad + 110 + i * 100 + 26, y + 136)
      })
      m.PROP_KINDS.forEach((kind, i) => {
        const f = sc.textures.get(m.propKey(kind)).get()
        g.drawImage(f.source.image, 0, 0, f.width, f.height, pad + 930 + i * 90, y + 44, 64, 64)
        caption(theme.props[kind] ?? kind, pad + 940 + i * 90, y + 136)
      })
      y += 160
      const out = document.createElement('canvas'); out.width = W; out.height = y
      out.getContext('2d').drawImage(c, 0, 0)
      return out.toDataURL('image/png')
    })()`)
    if (sheet) save('sprites.png', Buffer.from(sheet.slice(sheet.indexOf(',') + 1), 'base64'))

    // Our room beside a crop of the reference (someone else's work: a style reference only).
    if (fs.existsSync(REFERENCE) && cmpImg) {
      const ref = 'data:image/png;base64,' + fs.readFileSync(REFERENCE).toString('base64')
      const cmp = await js(`(async () => {
        const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src })
        const ours = await load(${JSON.stringify(cmpImg.toDataURL())}), ref = await load(${JSON.stringify(ref)})
        const crop = { x: 0, y: 95, w: 1179, h: 790 }
        const H = ours.height, rw = Math.round(crop.w * H / crop.h), gap = 24, top = 40
        const c = document.createElement('canvas'); c.width = ours.width + rw + gap * 3; c.height = H + top + gap
        const g = c.getContext('2d')
        g.fillStyle = '#14151c'; g.fillRect(0, 0, c.width, c.height)
        g.drawImage(ours, gap, top)
        g.drawImage(ref, crop.x, crop.y, crop.w, crop.h, ours.width + gap * 2, top, rw, H)
        g.fillStyle = '#e8eaf2'; g.font = '600 16px system-ui, sans-serif'
        g.fillText('Ours: one branch, orthogonal top-down, drawn in code (camera zoom 2)', gap, 26)
        g.fillText('Reference: style only (isometric 3D, not ours)', ours.width + gap * 2, 26)
        return c.toDataURL('image/png')
      })()`)
      save('compare.png', Buffer.from(cmp.slice(cmp.indexOf(',') + 1), 'base64'))
    }
    if (logs.length) console.log('--- renderer warnings ---\n' + [...new Set(logs)].slice(0, 20).join('\n'))
    win.destroy()
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  if (server) await server.close()
  app.quit()
})
