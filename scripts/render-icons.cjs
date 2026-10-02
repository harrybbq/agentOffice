// Renders assets/logo*.svg to PNGs and a multi-size assets/icon.ico using Electron (no extra deps).
//   npx electron scripts/render-icons.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), path = require('path')
const assets = path.join(__dirname, '..', 'assets')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  try {
  const pngs = []
  // One offscreen window, reused: tiny windows are unreliable, so capture a sub-rect instead.
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true } })
  for (const size of SIZES) {
    const svg = fs.readFileSync(path.join(assets, size <= 24 ? 'logo-small.svg' : 'logo.svg'), 'utf8')
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`
    const file = path.join(app.getPath('temp'), `ao-icon-${size}.html`)
    fs.writeFileSync(file, html)
    await win.loadFile(file)
    await new Promise((r) => setTimeout(r, 200))
    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    const png = shot.resize({ width: size, height: size, quality: 'best' }).toPNG()
    fs.writeFileSync(path.join(assets, `icon-${size}.png`), png)
    pngs.push({ size, png })
    fs.unlinkSync(file)
  }
  win.destroy()
  // ICO container with PNG-compressed entries.
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, dir, ...pngs.map((p) => p.png)]))
  fs.copyFileSync(path.join(assets, 'icon-256.png'), path.join(assets, 'icon.png'))
  console.log('wrote', SIZES.map((s) => `icon-${s}.png`).join(', '), '+ icon.ico, icon.png')
  } catch (e) { console.error(e); process.exitCode = 1 }
  app.quit()
})
