// Renders the art preview into docs/art-preview/ (one room of the office theme, for judging the look):
//   room-1x.png, room-2x.png, room-3x.png   the room alone at camera zoom 1, 2 and 3
//   room-in-app.png                         the same scene inside the app's shell
//   sprites.png                             every sprite drawn so far, on a neutral background
//   compare.png                             our room beside a crop of the reference (only when
//                                           docs/reference/office-reference.png exists; local, not committed)
//
//   npx electron scripts/art-preview.cjs
//
// It starts its own renderer dev server (Vite, port 5263, with the themes folder served) and opens
// the app's browser stub in its own hidden window: no agents, no main process, nothing shared with a
// running Agent Office. Three fake agents are staged: a manager at their desk (Claude), a worker
// typing (Codex) and a worker walking to the printer (Antigravity).
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path')

const REPO = path.join(__dirname, '..')
// AO_PREVIEW_OUT=<dir> writes somewhere else; AO_PREVIEW_NO_ART=1 leaves the theme's pictures
// unreachable, to check that the office then falls back to its coloured rectangles.
const OUT = process.env.AO_PREVIEW_OUT || path.join(REPO, 'docs', 'art-preview')
const NO_ART = process.env.AO_PREVIEW_NO_ART === '1'
const REFERENCE = path.join(REPO, 'docs', 'reference', 'office-reference.png')
const PORT = 5263
/** The corner of the branch that has art, in map px relative to the branch (x, y, width, height). */
const ROOM = { x: -12, y: -30, width: 404, height: 462 }
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

    await win.loadURL(`http://127.0.0.1:${PORT}/?stub=empty&restore=none&progress=quiet&board=none`)
    await until('the scene', '__agentOfficeDev.scene()')
    console.log('renderer:', await js(`(() => { const g = __agentOfficeDev.scene().game; return (g.renderer.gl ? 'WebGL' : 'Canvas') + ', pixelArt ' + g.config.pixelArt + ', mipmaps ' + g.config.mipmapFilter + ', furniture atlas ' + g.textures.exists('art:furniture') + ', floor picture ' + g.textures.exists('floor:branch:0') })()`))
    await js(`window.sc = __agentOfficeDev.scene(); window.ev = (agentId, parentId, provider, displayName, activity, detail = '') => __agentOfficeEmit({ agentId, parentId, provider, displayName, activity, detail }); 0`)
    const settled = (id, x, y) => `(() => { const c = sc.chars.get('${id}'); if (!c || !c.isSettled) return false; const b = sc.layout.branch('m1'); return Math.abs(c.position.x - b.offset.x - ${x}) < 2 && Math.abs(c.position.y - b.offset.y - ${y}) < 2 })()`

    // A manager (Claude) moves in; two workers get their desks (the manager walks over with a folder).
    await js(`ev('m1', null, 'claude-code', 'frontend', 'write', 'plan.md')`)
    await until('the branch to be built', `sc.views.get('m1').state === 'ready'`)
    await js(`ev('w1', 'm1', 'codex', 'Builder', 'write', 'src/app.ts')`)
    await until('the first worker at its desk', settled('w1', 56, 250))
    await js(`ev('w2', 'm1', 'antigravity', 'Explore', 'write', 'README.md')`)
    await until('the second worker at its desk', settled('w2', 152, 250))
    const quiet = (id) => `sc.chars.get('${id}').isIdle`
    await until('the manager back at their desk', `${settled('m1', 96, 48)} && ${quiet('m1')} && ${quiet('w1')} && ${quiet('w2')}`)
    await sleep(2500)
    await until('everyone to settle', `${settled('m1', 96, 48)} && ${quiet('m1')} && ${quiet('w1')} && ${quiet('w2')}`)
    // The second worker walks to the printer while the other two type: stop the world when it is on
    // the open floor (an activity is shown for at least 1.2 s, the walk there takes less).
    await js(`ev('m1', null, 'claude-code', 'frontend', 'write', 'plan.md'); ev('w1', 'm1', 'codex', 'Builder', 'write', 'src/app.ts'); ev('w2', 'm1', 'antigravity', 'Explore', 'web', 'docs.example.com')`)
    await until('the walker on the open floor', `sc.chars.get('w2').position.y - sc.layout.branch('m1').offset.y < 186`, 5000)
    await js(`sc.scene.pause(); 0`)
    console.log('portrait:', await js(`new Promise((ok) => sc.portrait('w1', (url) => ok(url ? url.length + ' chars' : 'none')))`))
    console.log('staged:', await js(`JSON.stringify(['m1', 'w1', 'w2'].map((id) => { const c = sc.chars.get(id); const b = sc.layout.branch('m1'); return [id, c.pose, Math.round(c.position.x - b.offset.x), Math.round(c.position.y - b.offset.y)] }))`))

    // In the app: the side panel closed, so the office has room.
    await js(`__agentOfficeDev.app.setLayout({ panelOpen: false, inboxOpen: false }, false); 0`)
    await sleep(600)
    await js(`(() => { window.dispatchEvent(new Event('resize')); const b = sc.layout.branch('m1'), h = sc.layout.hq, cam = sc.cameras.main; sc.autoFit = false; cam.setZoom(1.5); cam.centerOn(b.offset.x + b.width / 2 - 70, b.offset.y + b.height / 2 - 10) })()`)
    await sleep(400)
    await js(`sc.syncOverlay(); 0`)
    await shot('room-in-app.png')

    // The room alone: the world canvas over the whole window, the camera on the room.
    await js(`(() => {
      const hide = document.createElement('style')
      hide.textContent = '.world { position: fixed !important; inset: 0; z-index: 99999 } .world > *:not(.world-canvas):not(.world-tags) { display: none !important }'
      document.head.appendChild(hide)
      sc.autoFit = false
    })()`)
    let room2 = null
    for (const zoom of [3, 2, 1]) {
      const w = Math.round(ROOM.width * zoom), h = Math.round(ROOM.height * zoom)
      win.setContentSize(w + 40, h + 40)
      await sleep(500)
      await js(`(() => {
        window.dispatchEvent(new Event('resize'))
        sc.scale.refresh()
        const b = sc.layout.branch('m1'), cam = sc.cameras.main
        cam.setZoom(${zoom})
        cam.centerOn(b.offset.x + ${ROOM.x + ROOM.width / 2}, b.offset.y + ${ROOM.y + ROOM.height / 2})
      })()`)
      await sleep(400)
      await js(`sc.syncOverlay(); 0`)
      const img = await shot(`room-${zoom}x.png`, { x: 20, y: 20, width: w, height: h })
      if (zoom === 2) room2 = img
    }

    // Every sprite: the furniture atlas frames, then the character's poses in three provider colours.
    const sheet = NO_ART ? null : await js(`(async () => {
      const m = await import('/scene/charTextures.ts')
      const theme = sc.manifest
      const S = 3
      const furn = sc.textures.get('art:furniture')
      const names = furn.getFrameNames()
      const fscale = Number(furn.customData.meta.scale)
      const W = 1500, pad = 28
      const c = document.createElement('canvas')
      c.width = W; c.height = 1500
      const g = c.getContext('2d')
      g.fillStyle = '#e9ebf0'; g.fillRect(0, 0, c.width, c.height)
      const caption = (t, x, y, bold) => { g.fillStyle = bold ? '#30364a' : '#6b7286'; g.font = (bold ? '600 15px' : '12px') + ' system-ui, sans-serif'; g.textAlign = 'left'; g.fillText(t, x, y) }
      let x = pad, y = pad + 6
      caption('Furniture (themes/office/art/furniture.png), shown at 3x', pad, y, true); y += 14
      let rowH = 0
      for (const n of names) {
        const f = furn.get(n)
        const w = f.width / fscale * S, h = f.height / fscale * S
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
        ['sitFront', 'front', 3, 'sit'], ['typeFrontA', 'front', 3, 'type'], ['sitBack', 'back', 3, 'sit (back)'], ['typeBackA', 'back', 3, 'type (back)'], ['typeBackB', 'back', 3, '']]
      caption('Characters: white body tinted with the provider colour; head, hair, face, collar and accessory are untinted. Shown at 3x', pad, y, true); y += 10
      const styles = ['short', 'bun', 'spiky', 'long']
      tints.forEach(([label, tint], row) => {
        const worker = m.placeholderSkin(sc, 'worker', theme.roles.worker.placeholder, row + 1, { collar: team[row] })
        const manager = m.placeholderSkin(sc, 'manager', theme.roles.manager.placeholder, row, { head: { style: styles[row], hair: (row * 2 + 1) % 6, skin: (row * 5) % 6 }, accent: team[row], collar: team[row] })
        caption(label + ' worker', pad, y + 16)
        poses.forEach(([bf, of, drop, name], i) => { person(bf, worker.overlay, of, tint, pad + i * 100, y + 14, drop); if (row === 0 && name) caption(name, pad + i * 100 + 30, y + 134) })
        const mx = pad + poses.length * 100 + 30
        caption(label + ' manager', mx, y + 16)
        ;[['stand', 'front', 0], ['typeFrontA', 'front', 3], ['sitBack', 'back', 3]].forEach(([bf, of, drop], i) => person(bf, manager.overlay, of, tint, mx + i * 100, y + 14, drop))
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
    if (fs.existsSync(REFERENCE) && room2) {
      const ref = 'data:image/png;base64,' + fs.readFileSync(REFERENCE).toString('base64')
      const cmp = await js(`(async () => {
        const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src })
        const ours = await load(${JSON.stringify(room2.toDataURL())}), ref = await load(${JSON.stringify(ref)})
        const crop = { x: 0, y: 95, w: 1179, h: 790 }
        const H = ours.height, rw = Math.round(crop.w * H / crop.h), gap = 24, top = 40
        const c = document.createElement('canvas'); c.width = ours.width + rw + gap * 3; c.height = H + top + gap
        const g = c.getContext('2d')
        g.fillStyle = '#14151c'; g.fillRect(0, 0, c.width, c.height)
        g.drawImage(ours, gap, top)
        g.drawImage(ref, crop.x, crop.y, crop.w, crop.h, ours.width + gap * 2, top, rw, H)
        g.fillStyle = '#e8eaf2'; g.font = '600 16px system-ui, sans-serif'
        g.fillText('Ours: orthogonal top-down, drawn in code (camera zoom 2)', gap, 26)
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
