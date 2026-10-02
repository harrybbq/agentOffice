// The live preview pane: address detection, address validation, the static server over real HTTP
// (what it serves and everything it refuses), the script runner with a fake process, the manager,
// the frame rules, and the pane's pure renderer logic.
// Imported by ui.test.ts (npm test runs everything); also runs alone: tsx tests/preview.test.ts
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEvent } from '../shared/chat.ts'
import { completeAddress, NOT_LOOPBACK, parsePreviewUrl, samePreviewServer, type PreviewInfo } from '../shared/preview.ts'
import { DETECT_MAX_PER_TEXT, extractAddresses, StreamScanner, stripAnsi } from '../electron/preview/detect.ts'
import { ExternalGate, subFrameNavigation } from '../electron/preview/guard.ts'
import { PreviewManager, SELF_ADDRESS, UNKNOWN_SCRIPT, UNKNOWN_SESSION, NO_PAGE } from '../electron/preview/manager.ts'
import { forbidsFraming, probeHttp, probePort, titleOf } from '../electron/preview/probe.ts'
import { devScripts, isSafeScriptName, Runner, runnerCommand, runnerEnv, RUNNER_LOG_CHARS, type RunnerChild, type RunnerCommand } from '../electron/preview/runner.ts'
import {
  injectReload,
  isInside,
  isServableSegment,
  isWatchedPath,
  mimeOf,
  RELOAD_ROUTE,
  RELOAD_SCRIPT_ROUTE,
  requestSegments,
  startStaticServer
} from '../electron/preview/staticServer.ts'
import { allowWebPermission } from '../electron/webPermissions.ts'
import {
  blockedNotice,
  checkAddress,
  clampPaneWidth,
  dotState,
  fallbackText,
  fallbackTitle,
  frameLayout,
  PANE_DEFAULT,
  PANE_LEAVES,
  PANE_MIN,
  paneFootprint,
  paneReducer,
  parsePaneState,
  RAIL_WIDTH,
  scaleLabel,
  shortAddress,
  shownSession,
  showsFallback,
  updatedLabel
} from '../src/ui/preview.ts'

let pass = 0
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn()
  pass++
  console.log('ok -', name)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const until = async (fn: () => boolean, ms = 5000): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(25)
  }
  return fn()
}
const rejects = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  assert.fail('expected a rejection')
}

// ---- detect --------------------------------------------------------------------------------------

await t('detect: Vite, with its colour codes and a bold port', () => {
  const vite =
    '\u001b[32m\u001b[1m  VITE\u001b[22m v7.3.6\u001b[39m  \u001b[2mready in \u001b[0m\u001b[1m412\u001b[22m ms\n\n' +
    '  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n' +
    '  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m: \u001b[36mhttp://192.168.1.24:\u001b[1m5173\u001b[22m/\u001b[39m\n' +
    '  \u001b[2m➜  press h + enter to show help\u001b[22m\n'
  assert.deepEqual(extractAddresses(vite), ['http://localhost:5173/'])
  assert.equal(stripAnsi('\u001b]0;npm run dev\u0007\u001b[2K\u001b[1Ghello'), 'hello')
})

await t('detect: Next, create-react-app, http-server, python, webpack, Storybook', () => {
  const next = '   ▲ Next.js 16.1.0\n   - Local:        http://localhost:3000\n   - Network:      http://10.0.0.7:3000\n\n ✓ Ready in 1.9s\n'
  assert.deepEqual(extractAddresses(next), ['http://localhost:3000/'])
  const cra = 'Compiled successfully!\n\nYou can now view my-app in the browser.\n\n  Local:            http://localhost:3000\n  On Your Network:  http://192.168.0.12:3000\n'
  assert.deepEqual(extractAddresses(cra), ['http://localhost:3000/'])
  const httpServer = 'Starting up http-server, serving ./\n\nAvailable on:\n  http://192.168.1.24:8080\n  http://127.0.0.1:8080\nHit CTRL-C to stop the server\n'
  assert.deepEqual(extractAddresses(httpServer), ['http://127.0.0.1:8080/'])
  // 0.0.0.0 and [::] are "every interface", not addresses: they become localhost.
  assert.deepEqual(extractAddresses('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'), ['http://localhost:8000/'])
  assert.deepEqual(extractAddresses('Serving HTTP on :: port 8000 (http://[::]:8000/) ...'), ['http://localhost:8000/'])
  assert.deepEqual(extractAddresses('<i> [webpack-dev-server] Loopback: http://localhost:8081/, http://[::1]:8081/'), ['http://localhost:8081/'])
  assert.deepEqual(extractAddresses('│   Local:            http://localhost:6006/?path=/story/button--primary   │'), ['http://localhost:6006/?path=/story/button--primary'])
  assert.deepEqual(extractAddresses('Server running at https://localhost:8443/app.'), ['https://localhost:8443/app'])
  assert.deepEqual(extractAddresses('listening on http://127.0.0.1:4000, press q to quit'), ['http://127.0.0.1:4000/'])
})

await t('detect: other hosts, look-alikes and addresses without a port are ignored', () => {
  for (const text of [
    'Network: http://192.168.1.5:3000/',
    'docs at https://example.com:8443/guide',
    'http://localhost.evil.example:3000/',
    'http://localhost:3000.evil.example/',
    'http://localhost:80@evil.example/',
    'http://127.0.0.1.nip.io:8080/',
    'http://localhost/ (no port)',
    'xhttp://localhost:3000',
    'ftp://localhost:2121/',
    'http://localhost:999999/',
    'http://localhost:0/',
    'http://user:pw@localhost:3000/'
  ]) {
    assert.deepEqual(extractAddresses(text), [], text)
  }
})

await t('detect: duplicates collapse, the number per text is capped', () => {
  assert.deepEqual(extractAddresses('http://localhost:3000 http://0.0.0.0:3000/ http://[::1]:3000 http://127.0.0.1:3000'), ['http://localhost:3000/', 'http://127.0.0.1:3000/'])
  const many = Array.from({ length: 40 }, (_, i) => `http://localhost:${4000 + i}/`).join('\n')
  assert.equal(extractAddresses(many).length, DETECT_MAX_PER_TEXT)
})

await t('detect: a stream scanner finds an address split across chunks, once', () => {
  const s = new StreamScanner()
  assert.deepEqual(s.push('  Local:   \u001b[36mhttp://local'), [])
  assert.deepEqual(s.push('host:\u001b[1m51'), []) // could still grow: "…:51" is not reported
  assert.deepEqual(s.push('73\u001b[22m/\u001b[39m\n'), ['http://localhost:5173/'])
  assert.deepEqual(s.push('  Local:   http://localhost:5173/\n'), []) // a TUI redraws: reported once
  assert.deepEqual(s.push('x'.repeat(5000) + ' http://127.0.0.1:8080\n'), ['http://127.0.0.1:8080/'])
  // An address at the very end waits for more output, or for the pause.
  assert.deepEqual(s.push('ready on http://localhost:4321'), [])
  assert.deepEqual(s.flush(), ['http://localhost:4321/'])
  assert.deepEqual(s.flush(), [])
  // It keeps a short tail, never the output.
  s.push('y'.repeat(100_000))
  assert.ok((s as unknown as { tail: string }).tail.length <= 400)
})

// ---- address validation ----------------------------------------------------------------------------

await t('address: loopback with a port only; [::1] becomes localhost', () => {
  const ok = (raw: string, url: string) => assert.deepEqual(parsePreviewUrl(raw), { ok: true, url, port: Number(new URL(url).port) }, raw)
  ok('http://localhost:5173', 'http://localhost:5173/')
  ok('http://127.0.0.1:8080/app/?q=1#top', 'http://127.0.0.1:8080/app/?q=1#top')
  ok('https://localhost:8443/', 'https://localhost:8443/')
  ok('http://[::1]:3000/x', 'http://localhost:3000/x')
  ok('HTTP://LOCALHOST:3000', 'http://localhost:3000/')
  ok('  http://localhost:65535  ', 'http://localhost:65535/')
})

await t('address: everything else is refused with a sentence', () => {
  const bad = [
    'https://example.com/',
    'http://example.com:3000/',
    'http://192.168.1.10:3000/',
    'http://10.0.0.1:80/',
    'http://localhost.example.com:3000/',
    'http://127.0.0.1.example.com:3000/',
    'http://127.0.0.2:3000/',
    'http://0.0.0.0:3000/', // only accepted from server output (anyHost), never from the renderer
    'http://[::]:3000/',
    'http://[::ffff:127.0.0.1]:3000/',
    'http://2130706433:3000/x', // 127.0.0.1 as a number: the parser rewrites it, which is fine, see below
    'http://user:pw@localhost:3000/',
    'http://user@localhost:3000/',
    'http://localhost/', // no port
    'http://localhost:80/', // the default port counts as none
    'https://localhost:443/',
    'http://localhost:0/',
    'http://localhost:65536/',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'about:blank',
    'ws://localhost:3000/',
    'ftp://localhost:2121/',
    'chrome://settings',
    'theme://office/x.png',
    '//localhost:3000/',
    'localhost:3000',
    'http://localhost:3000\\@example.com/',
    'http://local host:3000/',
    '',
    'x'.repeat(3000)
  ]
  for (const raw of bad) {
    const r = parsePreviewUrl(raw)
    // "http://2130706433:3000" is 127.0.0.1 to the URL parser: accepted, and normalised to it.
    if (raw.startsWith('http://2130706433')) {
      assert.deepEqual(r, { ok: true, url: 'http://127.0.0.1:3000/x', port: 3000 })
      continue
    }
    assert.equal(r.ok, false, raw)
    if (!r.ok) assert.ok(r.error.length > 10, raw)
  }
  for (const raw of [undefined, null, 5173, {}, ['http://localhost:1/']]) assert.equal(parsePreviewUrl(raw).ok, false)
  const r = parsePreviewUrl('https://example.com/')
  assert.ok(!r.ok && r.error === NOT_LOOPBACK)
  assert.deepEqual(parsePreviewUrl('http://0.0.0.0:8000/', { anyHost: true }), { ok: true, url: 'http://localhost:8000/', port: 8000 })
  assert.equal(parsePreviewUrl('http://192.168.0.2:8000/', { anyHost: true }).ok, false)
})

await t('address: what is typed gets its missing parts; same server = same port and scheme', () => {
  assert.equal(completeAddress('localhost:3000'), 'http://localhost:3000')
  assert.equal(completeAddress(' 127.0.0.1:8080/app '), 'http://127.0.0.1:8080/app')
  assert.equal(completeAddress('5173'), 'http://localhost:5173')
  assert.equal(completeAddress(':5173/x'), 'http://localhost:5173/x')
  assert.equal(completeAddress('https://localhost:8443'), 'https://localhost:8443')
  assert.deepEqual(checkAddress('localhost:3000'), { ok: true, url: 'http://localhost:3000/' })
  assert.deepEqual(checkAddress('3000'), { ok: true, url: 'http://localhost:3000/' })
  assert.equal(checkAddress('example.com').ok, false)
  assert.equal(checkAddress('https://news.example.com/x').ok, false)
  assert.equal(checkAddress('   ').ok, false)
  assert.equal(shortAddress('http://localhost:5173/'), 'localhost:5173')
  assert.ok(samePreviewServer('http://localhost:3000/a', 'http://127.0.0.1:3000/b'))
  assert.ok(!samePreviewServer('http://localhost:3000/', 'http://localhost:3001/'))
  assert.ok(!samePreviewServer('http://localhost:3000/', 'https://localhost:3000/'))
  assert.ok(!samePreviewServer('nonsense', 'http://localhost:3000/'))
})

// ---- static server ---------------------------------------------------------------------------------

interface Reply {
  status: number
  headers: IncomingMessage['headers']
  body: string
}

/** A raw request: the path and the Host header go out exactly as given (no client-side normalising). */
function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...opts.headers }, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Opens the reload stream and collects what arrives. */
function listen(port: number): Promise<{ text: () => string; close: () => void; status: number; type: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: RELOAD_ROUTE, headers: { Host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (text += c))
      res.on('error', () => undefined)
      resolve({ text: () => text, close: () => req.destroy(), status: res.statusCode ?? 0, type: String(res.headers['content-type']) })
    })
    req.on('error', reject)
    req.end()
  })
}

const SECRET = 'TOP-SECRET-OUTSIDE-THE-FOLDER'
const outer = realpathSync(mkdtempSync(join(tmpdir(), 'ao-preview-')))
const site = join(outer, 'site')
mkdirSync(join(site, 'sub'), { recursive: true })
mkdirSync(join(site, '.git'))
mkdirSync(join(site, 'assets'))
mkdirSync(join(site, 'empty'))
mkdirSync(join(site, 'node_modules', 'pkg'), { recursive: true })
writeFileSync(join(outer, 'secret.txt'), SECRET)
writeFileSync(join(site, 'index.html'), '<!doctype html><html><head><title>Demo  site</title><link rel="stylesheet" href="style.css"></head><body><h1>Hello</h1></body></html>')
writeFileSync(join(site, 'style.css'), 'h1 { color: teal }')
writeFileSync(join(site, 'app.js'), 'console.log(1)')
writeFileSync(join(site, 'data.json'), '{"a":1}')
writeFileSync(join(site, 'notes.unknownext'), 'plain')
writeFileSync(join(site, 'nobody.html'), '<p>no body tag</p>')
writeFileSync(join(site, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
writeFileSync(join(site, 'assets', 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
writeFileSync(join(site, 'sub', 'index.html'), '<html><body>sub page</body></html>')
writeFileSync(join(site, 'sub', 'page.html'), '<html><BODY>upper</BODY></html>')
writeFileSync(join(site, '.env'), 'API_KEY=' + SECRET)
writeFileSync(join(site, '.git', 'config'), '[core] ' + SECRET)
writeFileSync(join(site, 'sub', '.hidden'), SECRET)
writeFileSync(join(site, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'node server.js', build: 'vite build', lint: 'eslint .', 'docs:dev': 'vitepress dev', 'evil & calc': 'echo x', prestart: 'echo pre' } }))
// A junction needs no admin rights on Windows; elsewhere it is an ordinary directory link.
let escapeLink = false
try {
  symlinkSync(outer, join(site, 'esc'), 'junction')
  symlinkSync(join(site, 'sub'), join(site, 'inner'), 'junction')
  escapeLink = true
} catch {
  console.log('   (links cannot be created here: the link tests are skipped)')
}

const srv = await startStaticServer({ root: site })

await t('static: bound to 127.0.0.1 on a port of its own', () => {
  assert.match(srv.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(srv.port > 1023)
})

await t('static: index.html with the reload hook before </body>, never cached', async () => {
  const r = await raw(srv.port, '/')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin')
  assert.equal(r.headers['access-control-allow-origin'], undefined)
  assert.ok(r.body.includes(`<h1>Hello</h1><script src="${RELOAD_SCRIPT_ROUTE}"></script></body>`), r.body)
  assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body))
  assert.equal((await raw(srv.port, '/index.html')).body, r.body)
  // Upper-case </BODY>, and a page without one.
  assert.ok((await raw(srv.port, '/sub/page.html')).body.includes(`upper<script src="${RELOAD_SCRIPT_ROUTE}"></script></BODY>`))
  assert.ok((await raw(srv.port, '/nobody.html')).body.endsWith(`<p>no body tag</p><script src="${RELOAD_SCRIPT_ROUTE}"></script>`))
  assert.equal(injectReload('<body>a</body><body>b</body>'), `<body>a</body><body>b<script src="${RELOAD_SCRIPT_ROUTE}"></script></body>`)
  const js = await raw(srv.port, RELOAD_SCRIPT_ROUTE)
  assert.equal(js.status, 200)
  assert.match(String(js.headers['content-type']), /^text\/javascript/)
  assert.ok(js.body.includes(`new EventSource('${RELOAD_ROUTE}')`) && js.body.includes('location.reload()'))
})

await t('static: MIME types; other files are served untouched', async () => {
  const type = async (p: string) => (await raw(srv.port, p)).headers['content-type']
  assert.equal(await type('/style.css'), 'text/css; charset=utf-8')
  assert.equal(await type('/app.js'), 'text/javascript; charset=utf-8')
  assert.equal(await type('/data.json'), 'application/json; charset=utf-8')
  assert.equal(await type('/assets/logo.svg'), 'image/svg+xml')
  assert.equal(await type('/assets/dot.png'), 'image/png')
  assert.equal(await type('/notes.unknownext'), 'application/octet-stream')
  assert.equal((await raw(srv.port, '/style.css')).body, 'h1 { color: teal }')
  assert.equal((await raw(srv.port, '/style.css?v=2')).body, 'h1 { color: teal }')
  assert.equal(mimeOf('X.WOFF2'), 'font/woff2')
  assert.equal(mimeOf('a.wasm'), 'application/wasm')
})

await t('static: a folder is its index.html (after a redirect to the slash), never a listing', async () => {
  const redirect = await raw(srv.port, '/sub?x=1')
  assert.equal(redirect.status, 301)
  assert.equal(redirect.headers.location, '/sub/?x=1')
  assert.ok((await raw(srv.port, '/sub/')).body.includes('sub page'))
  for (const p of ['/assets/', '/assets', '/empty/', '/empty', '/node_modules/', '/node_modules/pkg/']) {
    const r = await raw(srv.port, p)
    assert.equal(r.status, 404, p)
    assert.equal(r.body, 'not found', p)
  }
  assert.equal((await raw(srv.port, '/nope.html')).status, 404)
})

await t('static: no way out of the folder (.., encodings, absolute paths, drive letters, device names)', async () => {
  const attempts = [
    '/../secret.txt',
    '/sub/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/..\\secret.txt',
    '/sub/..%2f..%2fsecret.txt',
    '/sub/%2e%2e/%2e%2e/secret.txt',
    '/%252e%252e/secret.txt',
    '/..%252fsecret.txt',
    '/....//secret.txt',
    '/.../secret.txt',
    '//secret.txt',
    '/%2f..%2fsecret.txt',
    '/' + encodeURIComponent(join(outer, 'secret.txt')),
    '/' + join(outer, 'secret.txt').replace(/\\/g, '/'),
    '//' + join(outer, 'secret.txt').replace(/\\/g, '/'),
    '/C:/Windows/win.ini',
    '/C:%5CWindows%5Cwin.ini',
    '/c%3A/Windows/win.ini',
    '/%5C%5Clocalhost%5Cc$%5CWindows%5Cwin.ini',
    '//localhost/c$/Windows/win.ini',
    '/%3F%3F/C:/Windows/win.ini',
    '/etc/passwd',
    '/index.html%00.css',
    '/%00',
    '/index.html::$DATA',
    '/index.html:stream',
    '/nul',
    '/NUL.txt',
    '/con',
    '/sub/aux.html',
    '/COM1',
    '/%',
    '/%zz',
    '/%c0%ae%c0%ae/secret.txt',
    '/%ff'
  ]
  for (const p of attempts) {
    const r = await raw(srv.port, p)
    assert.equal(r.status, 404, `${p} -> ${r.status}`)
    assert.ok(!r.body.includes(SECRET), p)
    assert.ok(!/\[fonts\]|root:/.test(r.body), p)
  }
  assert.equal(isInside(site, join(site, 'a', 'b.txt')), true)
  assert.equal(isInside(site, site), true)
  assert.equal(isInside(site, outer), false)
  assert.equal(isInside(site, join(outer, 'site2', 'x')), false)
  assert.equal(isInside(site, join(site, '.git', 'config')), false)
  assert.equal(requestSegments('/a/b.css')?.join('|'), 'a|b.css')
  assert.equal(requestSegments('/a//b.css')?.join('|'), 'a|b.css')
  assert.deepEqual(requestSegments('/'), [])
  assert.equal(requestSegments('a/b'), null)
  assert.equal(requestSegments('/a/../b'), null)
})

await t('static: dotfiles and dot-folders are refused, also by their other spellings', async () => {
  for (const p of ['/.env', '/.git/config', '/.git/', '/.git', '/sub/.hidden', '/%2eenv', '/%2Egit/config', '/.env.', '/.env%20', '/.env::$DATA', '/GIT~1/config', '/sub/./.hidden', '/.', '/..', '/.well-known/x']) {
    const r = await raw(srv.port, p)
    assert.equal(r.status, 404, `${p} -> ${r.status}`)
    assert.ok(!r.body.includes(SECRET), p)
  }
  for (const seg of ['.env', '.git', '..', '.', 'a\\b', 'a/b', 'C:', 'x:y', 'file.', 'file ', 'nul', 'NUL.txt', 'com1', 'LPT9.log', 'GIT~1', 'a*b', 'a?b', 'a|b', 'a<b', 'a"b', 'a\u0000b', '']) {
    assert.equal(isServableSegment(seg), false, JSON.stringify(seg))
  }
  for (const seg of ['index.html', 'my file.css', 'a.b.c', 'héllo.js', 'console.log.txt', 'nullish.js', '_next', '@scope', 'a+b(1).png']) {
    assert.equal(isServableSegment(seg), true, seg)
  }
})

await t('static: a link that leads out of the folder is not followed; one that stays inside is', async () => {
  if (!escapeLink) return
  for (const p of ['/esc/secret.txt', '/esc/', '/esc', '/esc/site/.env', '/inner/.hidden']) {
    const r = await raw(srv.port, p)
    assert.equal(r.status, 404, `${p} -> ${r.status}`)
    assert.ok(!r.body.includes(SECRET), p)
  }
  // Out and back in again ends inside the folder: that is the folder's own page.
  assert.equal((await raw(srv.port, '/esc/site/style.css')).body, 'h1 { color: teal }')
  assert.ok((await raw(srv.port, '/inner/page.html')).body.includes('upper'))
})

await t('static: a wrong Host, a foreign Origin and background requests of other sites are refused', async () => {
  const p = srv.port
  for (const host of ['evil.example', `evil.example:${p}`, '127.0.0.1', `127.0.0.1:${p + 1}`, `127.0.0.1.evil.example:${p}`, `[::1]:${p}`, `0.0.0.0:${p}`]) {
    const r = await raw(p, '/', { headers: { Host: host } })
    assert.equal(r.status, 403, `Host ${host}`)
    assert.ok(!r.body.includes('Hello'))
  }
  assert.equal((await raw(p, '/', { headers: { Host: `localhost:${p}` } })).status, 200)
  assert.equal((await raw(p, '/', { headers: { Host: `LOCALHOST:${p}` } })).status, 200)
  for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${p + 1}`, 'file://']) {
    assert.equal((await raw(p, '/data.json', { headers: { Origin: origin } })).status, 403, origin)
  }
  assert.equal((await raw(p, '/data.json', { headers: { Origin: `http://127.0.0.1:${p}` } })).status, 200)
  // Another site loading a file in the background (script, image, fetch): refused. Opening the page (a navigation) is fine.
  assert.equal((await raw(p, '/app.js', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' } })).status, 403)
  assert.equal((await raw(p, '/app.js', { headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors' } })).status, 403)
  assert.equal((await raw(p, '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })).status, 200)
  assert.equal((await raw(p, '/app.js', { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors' } })).status, 200)
})

await t('static: GET and HEAD only', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'PROPFIND']) {
    const r = await raw(srv.port, '/index.html', { method })
    assert.equal(r.status, 405, method)
    assert.equal(r.headers.allow, 'GET, HEAD', method)
    assert.ok(!r.body.includes('Hello'))
  }
  const head = await raw(srv.port, '/style.css', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.equal(head.headers['content-length'], '18')
  const headHtml = await raw(srv.port, '/', { method: 'HEAD' })
  assert.equal(headHtml.status, 200)
  assert.equal(headHtml.body, '')
  assert.equal(Number(headHtml.headers['content-length']), Buffer.byteLength((await raw(srv.port, '/')).body))
})

await t('static: the reload stream tells every open page, and the server stops cleanly', async () => {
  const a = await listen(srv.port)
  const b = await listen(srv.port)
  assert.equal(a.status, 200)
  assert.match(a.type, /^text\/event-stream/)
  assert.ok(await until(() => srv.listeners() === 2))
  assert.ok(!a.text().includes('event: reload'))
  srv.reload()
  assert.ok(await until(() => a.text().includes('event: reload') && b.text().includes('event: reload')))
  b.close()
  assert.ok(await until(() => srv.listeners() === 1))
  await srv.close()
  await srv.close() // twice is fine
  assert.equal(srv.listeners(), 0)
  await assert.rejects(raw(srv.port, '/'))
  a.close()
})

await t('static: which changes count as "the page changed"', () => {
  assert.equal(isWatchedPath('index.html'), true)
  assert.equal(isWatchedPath('src\\app\\main.tsx'), true)
  assert.equal(isWatchedPath('node_modules\\x\\index.js'), false)
  assert.equal(isWatchedPath('.git/HEAD'), false)
  assert.equal(isWatchedPath('packages/a/node_modules/x.js'), false)
  assert.equal(isWatchedPath('dist/index.html'), false)
  assert.equal(isWatchedPath('out\\main\\index.js'), false)
  assert.equal(isWatchedPath('.env'), false)
  assert.equal(isWatchedPath('src/.cache/x'), false)
  assert.equal(isWatchedPath(''), false)
  // The page being served lives in build output: then that output counts.
  assert.equal(isWatchedPath('dist/index.html', ['dist']), true)
  assert.equal(isWatchedPath('dist/node_modules/x.js', ['dist']), false)
})

// ---- probe -----------------------------------------------------------------------------------------

/** A ten-line web server standing in for a dev server. */
function tinyServer(handler?: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number; hits: () => number }> {
  return new Promise((resolve) => {
    let hits = 0
    const server = createServer((req, res) => {
      hits++
      if (handler) return handler(req, res)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><head><title> My  dev\n app </title></head><body>dev</body></html>')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, hits: () => hits }))
  })
}
const closeServer = (s: Server): Promise<void> =>
  new Promise((r) => {
    s.closeAllConnections()
    s.close(() => r())
  })

const dev = await tinyServer()
const framed = await tinyServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' })
  res.end('<title>No frames</title>')
})
const redirecting = await tinyServer((_req, res) => {
  res.writeHead(302, { Location: 'https://example.com/elsewhere' })
  res.end()
})
/** A port nothing listens on. */
const deadPort = await new Promise<number>((resolve) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as AddressInfo).port
    s.close(() => resolve(port))
  })
})

await t('probe: reachable or not, the title, "do not frame me"; loopback only, redirects not followed', async () => {
  assert.deepEqual(await probeHttp(`http://127.0.0.1:${dev.port}/`), { reachable: true, framable: true, title: 'My dev app' })
  assert.deepEqual(await probeHttp(`http://127.0.0.1:${framed.port}/`), { reachable: true, framable: false, title: 'No frames' })
  assert.deepEqual(await probeHttp(`http://127.0.0.1:${deadPort}/`), { reachable: false })
  // A redirect to another site is an answer (the server is up); it is never followed.
  assert.equal((await probeHttp(`http://127.0.0.1:${redirecting.port}/`)).reachable, true)
  assert.equal(redirecting.hits(), 1)
  // Not a loopback address: not even asked.
  assert.deepEqual(await probeHttp('https://example.com/'), { reachable: false })
  assert.deepEqual(await probeHttp(`http://user:pw@127.0.0.1:${dev.port}/`), { reachable: false })
  assert.equal(await probePort(`http://127.0.0.1:${dev.port}/`), true)
  assert.equal(await probePort(`http://127.0.0.1:${deadPort}/`), false)
  assert.equal(await probePort('http://example.com:80/'), false)
  assert.equal(forbidsFraming({ 'x-frame-options': 'SAMEORIGIN' }), true)
  assert.equal(forbidsFraming({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), true)
  assert.equal(forbidsFraming({ 'content-security-policy': "frame-ancestors 'self' https://a.example" }), true)
  assert.equal(forbidsFraming({ 'content-security-policy': 'frame-ancestors *' }), false)
  assert.equal(forbidsFraming({ 'content-security-policy': "default-src 'self'" }), false)
  assert.equal(forbidsFraming({}), false)
  assert.equal(titleOf('<html><TITLE lang="en">A  b</TITLE>'), 'A b')
  assert.equal(titleOf('<p>none</p>'), undefined)
})

// ---- runner ----------------------------------------------------------------------------------------

await t('runner: which package.json scripts look like dev servers', () => {
  const pkg = JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', storybook: 'x', preview: 'x', serve: 'x', start: 'x', dev: 'x', 'docs:dev': 'x', 'start-web': 'x', prestart: 'x', postinstall: 'x', 'dev && calc': 'x', 'a b': 'x', empty: '', notAString: 5, devtools: 'x' }
  })
  assert.deepEqual(devScripts(pkg), ['dev', 'start', 'serve', 'preview', 'storybook', 'docs:dev', 'start-web'])
  assert.deepEqual(devScripts('{"scripts":{"build":"x"}}'), [])
  assert.deepEqual(devScripts('{"scripts":["dev"]}'), [])
  assert.deepEqual(devScripts('{"name":"x"}'), [])
  assert.deepEqual(devScripts('not json'), [])
  assert.deepEqual(devScripts('null'), [])
  assert.equal(devScripts(JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`dev:${i}`, 'x'])) })).length, 12)
})

await t('runner: a script NAME becomes a fixed command; anything a shell could act on is refused', () => {
  assert.deepEqual(runnerCommand('dev', 'win32', 'C:\\Windows\\system32\\cmd.exe'), { file: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd run dev'], verbatim: true })
  assert.deepEqual(runnerCommand('docs:dev', 'win32', ''), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd run docs:dev'], verbatim: true })
  assert.deepEqual(runnerCommand('start', 'linux'), { file: 'npm', args: ['run', 'start'], verbatim: false })
  for (const bad of ['dev & calc', 'dev&&calc', 'dev|more', 'dev;ls', 'dev > x', '"dev"', "dev'", 'dev`x`', '$(x)', '%PATH%', 'dev^', 'a b', '-dev', '--prefix=..', '', 'x'.repeat(65), 'dev\n', 'dév', '../x', 'a/b', 'a\\b', '!x']) {
    assert.equal(isSafeScriptName(bad), false, bad)
    assert.throws(() => runnerCommand(bad, 'win32'), /cannot be run/, bad)
    assert.throws(() => runnerCommand(bad, 'linux'), /cannot be run/, bad)
  }
  for (const v of [undefined, null, 5, ['dev'], { name: 'dev' }]) assert.equal(isSafeScriptName(v), false)
  const env = runnerEnv({ PATH: 'x', ELECTRON_RUN_AS_NODE: '1', AGENT_OFFICE_USER_DATA: 'y', NODE_OPTIONS: '--inspect', HOME: 'h', UNSET: undefined })
  assert.deepEqual(env, { PATH: 'x', HOME: 'h', BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' })
})

class FakeChild extends EventEmitter implements RunnerChild {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = undefined
  killed = 0
  kill(): boolean {
    this.killed++
    setImmediate(() => this.emit('exit', null))
    return true
  }
  print(text: string, err = false): void {
    ;(err ? this.stderr : this.stdout).emit('data', Buffer.from(text))
  }
}

await t('runner: output is passed on and kept as a bounded log; stop kills it', async () => {
  const child = new FakeChild()
  const out: string[] = []
  const exits: Array<number | null> = []
  const spawned: Array<{ cmd: RunnerCommand; cwd: string; env: NodeJS.ProcessEnv }> = []
  const r = new Runner({ cwd: site, script: 'dev', onOutput: (x) => out.push(x), onExit: (c) => exits.push(c), spawn: (cmd, o) => (spawned.push({ cmd, ...o }), child), env: { PATH: 'p', ELECTRON_RUN_AS_NODE: '1' } })
  assert.equal(r.running, false)
  r.start()
  assert.equal(r.running, true)
  assert.throws(() => r.start(), /already running/)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0]!.cwd, site)
  assert.deepEqual(spawned[0]!.cmd, runnerCommand('dev'))
  assert.equal(spawned[0]!.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(spawned[0]!.env.BROWSER, 'none')
  child.print('\u001b[32mready\u001b[39m\r\n')
  child.print('warning: x\n', true)
  assert.deepEqual(out, ['\u001b[32mready\u001b[39m\r\n', 'warning: x\n'])
  assert.equal(r.log(), '> npm run dev\nready\nwarning: x\n')
  child.print('z'.repeat(RUNNER_LOG_CHARS * 2))
  assert.equal(r.log().length, RUNNER_LOG_CHARS)
  await r.stop()
  assert.equal(child.killed, 1)
  assert.equal(r.running, false)
  assert.deepEqual(exits, [null])
  assert.match(r.log(), /\[the script ended\]\n$/)
  await r.stop() // already gone
  assert.equal(child.killed, 1)
  // A process that cannot be started is a readable error.
  const broken = new Runner({ cwd: site, script: 'dev', onOutput: () => undefined, onExit: () => undefined, spawn: () => { throw new Error('ENOENT') } })
  assert.throws(() => broken.start(), /could not start npm: ENOENT/)
})

// ---- manager ---------------------------------------------------------------------------------------

interface Harness {
  m: PreviewManager
  changed: PreviewInfo[]
  reloads: string[]
  detected: string[]
  children: FakeChild[]
  commands: RunnerCommand[]
  live: Map<string, string>
  last: (id: string) => PreviewInfo | undefined
}

function harness(selfPorts: number[] = []): Harness {
  const changed: PreviewInfo[] = []
  const reloads: string[] = []
  const detected: string[] = []
  const children: FakeChild[] = []
  const commands: RunnerCommand[] = []
  const live = new Map<string, string>([
    ['s1', site],
    ['s2', outer]
  ])
  const m = new PreviewManager({
    session: (id) => (live.has(id) ? { id, cwd: live.get(id)! } : undefined),
    onChanged: (i) => changed.push(i),
    onReload: (id) => reloads.push(id),
    onDetected: (id) => detected.push(id),
    selfPorts: () => selfPorts,
    spawn: (cmd) => {
      const c = new FakeChild()
      children.push(c)
      commands.push(cmd)
      return c
    },
    verifyEveryMs: 60,
    adoptWaitMs: 20
  })
  return { m, changed, reloads, detected, children, commands, live, last: (id) => [...changed].reverse().find((i) => i.sessionId === id) }
}

await t('manager: only a live hosted session has a preview', async () => {
  const h = harness()
  for (const id of ['nope', '', undefined, null, 5, {}, 'x'.repeat(100)]) {
    assert.equal(await rejects(h.m.open(id, `http://127.0.0.1:${dev.port}/`)), UNKNOWN_SESSION)
    assert.equal(await rejects(h.m.serveFolder(id)), UNKNOWN_SESSION)
    assert.equal(await rejects(h.m.run(id, 'dev')), UNKNOWN_SESSION)
    assert.equal(await rejects(h.m.scripts(id)), UNKNOWN_SESSION)
    assert.equal(await rejects(h.m.suggestions(id)), UNKNOWN_SESSION)
    assert.equal(await rejects(h.m.staticEntries(id)), UNKNOWN_SESSION)
    assert.equal(h.m.get(id), null)
    assert.equal(h.m.log(id), '')
    await h.m.stop(id)
  }
  assert.deepEqual(h.changed, [])
  await h.m.shutdown()
})

await t('manager: open takes loopback addresses only, and never the app itself', async () => {
  const h = harness([47821])
  for (const url of ['https://example.com/', 'http://192.168.1.2:3000/', 'file:///C:/x.html', 'javascript:alert(1)', 'http://user:pw@localhost:3000/', 'http://localhost/', 'http://0.0.0.0:3000/', '', undefined, 5]) {
    const msg = await rejects(h.m.open('s1', url))
    assert.ok(msg.length > 10 && msg !== SELF_ADDRESS, String(url))
  }
  assert.equal(await rejects(h.m.open('s1', 'http://localhost:47821/')), SELF_ADDRESS)
  assert.equal(await rejects(h.m.open('s1', 'http://127.0.0.1:47821/health')), SELF_ADDRESS)
  assert.equal(h.m.get('s1'), null)
  assert.deepEqual(h.changed, [])

  const info = await h.m.open('s1', `http://127.0.0.1:${dev.port}`)
  assert.deepEqual(info, { sessionId: 's1', url: `http://127.0.0.1:${dev.port}/`, kind: 'manual', status: 'ready', title: 'My dev app' })
  assert.equal(h.changed[0]!.status, 'starting')
  assert.deepEqual(h.m.get('s1'), info)
  // An address nothing answers at: shown as unreachable, not refused.
  const dead = await h.m.open('s2', `http://127.0.0.1:${deadPort}/`)
  assert.equal(dead.status, 'unreachable')
  assert.ok(dead.note)
  // A page that forbids framing says so.
  assert.equal((await h.m.open('s2', `http://127.0.0.1:${framed.port}/`)).framable, false)
  assert.equal(h.m.active().length, 2)
  await h.m.stop('s1')
  assert.equal(h.last('s1')!.status, 'stopped')
  assert.equal(h.m.get('s1'), null)
  await h.m.shutdown()
  assert.equal(h.m.active().length, 0)
  assert.equal(await rejects(h.m.open('s1', `http://127.0.0.1:${dev.port}`)), UNKNOWN_SESSION)
})

await t('manager: the shown address is checked again and again (down, then back up)', async () => {
  const h = harness()
  const flaky = await tinyServer()
  const url = `http://127.0.0.1:${flaky.port}/`
  assert.equal((await h.m.open('s1', url)).status, 'ready')
  const hitsWhenReady = flaky.hits()
  await sleep(250)
  assert.equal(flaky.hits(), hitsWhenReady) // the repeated check is a port check: nothing in the server's log
  await closeServer(flaky.server)
  assert.ok(await until(() => h.m.get('s1')?.status === 'unreachable'))
  const back = await new Promise<Server>((resolve) => {
    const s = createServer((_q, res) => res.end('<title>Back</title>'))
    s.listen(flaky.port, '127.0.0.1', () => resolve(s))
  })
  assert.ok(await until(() => h.m.get('s1')?.status === 'ready'))
  assert.equal(h.m.get('s1')!.note, undefined)
  // What the frame reports: where it went, and that the page refused to be framed.
  h.m.frameNavigated(`http://127.0.0.1:${flaky.port}/about.html`)
  assert.equal(h.m.get('s1')!.currentUrl, `http://127.0.0.1:${flaky.port}/about.html`)
  h.m.frameNavigated('https://example.com/')
  h.m.frameNavigated(`http://127.0.0.1:${dev.port}/other-server`)
  assert.equal(h.m.get('s1')!.currentUrl, `http://127.0.0.1:${flaky.port}/about.html`)
  h.m.frameNavigated(url)
  assert.equal(h.m.get('s1')!.currentUrl, undefined)
  h.m.frameFailed(url, true)
  assert.equal(h.m.get('s1')!.framable, false)
  await h.m.shutdown()
  await closeServer(back)
})

await t('manager: addresses seen in a session are offered once they answer', async () => {
  const h = harness([47821])
  h.m.observeAddresses('s1', [`http://localhost:${deadPort}/`, `http://127.0.0.1:${dev.port}/`, 'https://example.com/', 'http://localhost:47821/', 42, `http://0.0.0.0:${framed.port}/`], 'terminal')
  await sleep(10)
  assert.deepEqual(h.detected, ['s1'])
  const sug = await h.m.suggestions('s1')
  assert.deepEqual(sug.map((s) => s.url).sort(), [`http://127.0.0.1:${dev.port}/`, `http://localhost:${framed.port}/`].sort())
  assert.ok(sug.every((s) => s.source === 'terminal'))
  assert.deepEqual(await h.m.suggestions('s2'), [])
  // Chat sessions: command output as it streams, finished commands, finished answers.
  const delta = (text: string): ChatEvent => ({ type: 'delta', sessionId: 's2', itemId: 'c1', field: 'output', delta: text })
  h.m.observeChat(delta('  Local: http://127.0.0.1:'))
  h.m.observeChat(delta(`${dev.port}/\n`))
  h.m.observeChat({ type: 'delta', sessionId: 's2', itemId: 'a1', field: 'text', delta: `http://127.0.0.1:${framed.port}/ ` })
  assert.deepEqual(await h.m.suggestions('s2'), [{ url: `http://127.0.0.1:${dev.port}/`, source: 'command output' }])
  h.m.observeChat({ type: 'item', item: { id: 'a1', sessionId: 's2', agentId: 's2', ts: 1, kind: 'assistant', text: `It runs at http://localhost:${framed.port}.`, streaming: false } })
  assert.deepEqual((await h.m.suggestions('s2')).map((s) => s.source).sort(), ['chat', 'command output'])
  // Opening a suggestion remembers where it came from.
  const info = await h.m.open('s1', `http://127.0.0.1:${dev.port}/`)
  assert.equal(info.kind, 'dev-server')
  assert.equal(info.detectedFrom, 'terminal')
  // Only so many are remembered.
  h.m.observeAddresses('s1', Array.from({ length: 12 }, (_, i) => `http://localhost:${20000 + i}/`), 'terminal')
  h.m.observeAddresses('s1', Array.from({ length: 12 }, (_, i) => `http://localhost:${21000 + i}/`), 'terminal')
  assert.equal((h.m as unknown as { entries: Map<string, { candidates: Map<string, unknown> }> }).entries.get('s1')!.candidates.size, 12)
  await h.m.shutdown()
})

await t('manager: "Serve this folder" serves it with live reload, and reloads when a file changes', async () => {
  const h = harness()
  assert.deepEqual(await h.m.staticEntries('s1'), ['index.html'])
  assert.deepEqual(await h.m.staticEntries('s2'), ['site/index.html']) // a page in a usual sub-folder is offered too
  for (const bad of ['../secret.txt', '..\\secret.txt', '.env', '.git/config', 'C:\\Windows\\win.ini', '/etc/passwd', 'nope.html', 'esc/secret.txt', 'empty', 5, {}, 'x'.repeat(600)]) {
    assert.equal(await rejects(h.m.serveFolder('s1', bad)), NO_PAGE, String(bad))
  }
  assert.equal(await rejects(h.m.serveFolder('s2')), NO_PAGE) // no index.html there
  assert.equal(h.m.active().length, 0)

  const info = await h.m.serveFolder('s1')
  assert.equal(info.kind, 'static')
  assert.equal(info.status, 'ready')
  assert.equal(info.title, 'Demo site')
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  const port = Number(new URL(info.url).port)
  assert.ok((await raw(port, '/')).body.includes('<h1>Hello</h1>'))
  // Another page of the same server keeps the preview (and its server).
  const other = await h.m.open('s1', `http://127.0.0.1:${port}/sub/page.html`)
  assert.equal(other.kind, 'static')
  assert.equal(other.url, `http://127.0.0.1:${port}/sub/page.html`)
  assert.equal((await raw(port, '/sub/page.html')).status, 200)

  const page = await listen(port)
  await sleep(300) // let the folder watcher settle
  h.reloads.length = 0
  writeFileSync(join(site, 'node_modules', 'pkg', 'x.js'), '1')
  writeFileSync(join(site, '.git', 'HEAD'), 'ref')
  await sleep(500)
  assert.deepEqual(h.reloads, [], 'changes in node_modules and .git do not count')
  assert.ok(!page.text().includes('event: reload'))
  writeFileSync(join(site, 'style.css'), 'h1 { color: crimson }')
  assert.ok(await until(() => page.text().includes('event: reload')), 'the page was told to reload')
  assert.ok(await until(() => h.reloads.includes('s1')))
  assert.equal((await raw(port, '/style.css')).body, 'h1 { color: crimson }')
  // Several quick changes are one reload.
  await sleep(300)
  h.reloads.length = 0
  for (let i = 0; i < 5; i++) writeFileSync(join(site, 'app.js'), `console.log(${i})`)
  await sleep(600)
  assert.equal(h.reloads.length, 1)
  // The board saying "this session changed a file" is a hint as well (not the first snapshot).
  await sleep(300)
  h.reloads.length = 0
  h.m.boardChanged({ branches: [{ sessionId: 's1', files: [{ ts: 100 }] }] })
  await sleep(300)
  assert.deepEqual(h.reloads, [])
  h.m.boardChanged({ branches: [{ sessionId: 's1', files: [{ ts: 200 }, { ts: 100 }] }] })
  assert.ok(await until(() => h.reloads.length === 1))

  // A sub-folder page; ".../index.html" is shown as its folder.
  const sub = await h.m.serveFolder('s1', 'sub/index.html')
  assert.match(sub.url, /^http:\/\/127\.0\.0\.1:\d+\/sub\/$/)
  assert.notEqual(new URL(sub.url).port, String(port))
  await assert.rejects(raw(port, '/'), 'the earlier server is closed')
  const subPort = Number(new URL(sub.url).port)
  assert.match((await h.m.serveFolder('s1', 'sub\\page.html')).url, /\/sub\/page\.html$/)
  await assert.rejects(raw(subPort, '/'))

  // The session ends: its preview and its server end with it.
  const lastPort = Number(new URL(h.m.get('s1')!.url).port)
  h.live.delete('s1')
  h.m.sessionsChanged(new Set(['s2']))
  assert.ok(await until(() => h.last('s1')?.status === 'stopped'))
  assert.equal(h.m.get('s1'), null)
  assert.ok(await until(() => h.m.active().length === 0))
  await sleep(50)
  await assert.rejects(raw(lastPort, '/'))
  page.close()
  await h.m.shutdown()
})

await t('manager: run takes the NAME of a dev script of that folder, nothing else', async () => {
  const h = harness()
  assert.deepEqual(await h.m.scripts('s1'), ['dev', 'start', 'docs:dev'])
  assert.deepEqual(await h.m.scripts('s2'), []) // no package.json
  for (const bad of ['build', 'lint', 'prestart', 'evil & calc', 'dev & calc', 'dev && calc.exe', 'nope', 'DEV', ' dev', 'dev ', '', undefined, null, 5, ['dev'], { toString: () => 'dev' }]) {
    assert.equal(await rejects(h.m.run('s1', bad)), UNKNOWN_SCRIPT, String(bad))
  }
  assert.equal(await rejects(h.m.run('s2', 'dev')), UNKNOWN_SCRIPT)
  assert.equal(h.children.length, 0, 'nothing was started')
  assert.equal(h.m.get('s1'), null)

  const info = await h.m.run('s1', 'dev')
  assert.deepEqual(info, { sessionId: 's1', url: '', kind: 'dev-server', status: 'starting', script: 'dev', detectedFrom: 'npm run dev' })
  assert.equal(h.children.length, 1)
  assert.deepEqual(h.commands[0], runnerCommand('dev'))
  assert.match(await rejects(h.m.run('s1', 'start')), /already running/)
  assert.equal(h.children.length, 1, 'one script per session')
  // It prints its address (in colour, in two chunks): the preview follows.
  const child = h.children[0]!
  child.print('\n  VITE v7  ready in 300 ms\n\n  ➜  Local:   \u001b[36mhttp://127.0.0.1:')
  child.print(`\u001b[1m${dev.port}\u001b[22m/\u001b[39m\n  ➜  Network: http://192.168.1.9:${dev.port}/\n`)
  assert.ok(await until(() => h.m.get('s1')?.status === 'ready'))
  assert.deepEqual(h.m.get('s1'), { sessionId: 's1', url: `http://127.0.0.1:${dev.port}/`, kind: 'dev-server', status: 'ready', script: 'dev', detectedFrom: 'npm run dev', title: 'My dev app' })
  assert.match(h.m.log('s1'), /^> npm run dev\n\n {2}VITE v7 {2}ready in 300 ms\n\n {2}➜ {2}Local: {3}http:\/\/127\.0\.0\.1:\d+\/\n/)
  assert.deepEqual((await h.m.suggestions('s1')).map((s) => s.source), ['npm run dev'])
  // Stop kills the script.
  await h.m.stop('s1')
  assert.equal(child.killed, 1)
  assert.equal(h.last('s1')!.status, 'stopped')
  assert.equal(h.m.get('s1'), null)
  assert.equal(h.m.log('s1'), '')

  // A script that ends by itself leaves a note and its log.
  await h.m.run('s1', 'start')
  const second = h.children[1]!
  second.print('Error: Cannot find module "./server.js"\n', true)
  second.emit('exit', 1)
  assert.ok(await until(() => h.m.get('s1')?.status === 'unreachable'))
  assert.match(h.m.get('s1')!.note!, /The script ended \(code 1\)/)
  assert.match(h.m.log('s1'), /Cannot find module/)
  // ...and the next run replaces it; the app quitting kills what runs.
  await h.m.run('s1', 'docs:dev')
  assert.equal(h.children.length, 3)
  // A script that prints nothing useful says so after a while.
  assert.ok(await until(() => /has not printed an address yet/.test(h.m.get('s1')?.note ?? '')))
  await h.m.shutdown()
  assert.equal(h.children[2]!.killed, 1)
  assert.equal(h.m.active().length, 0)
})

await t('manager: the session ending kills its script', async () => {
  const h = harness()
  await h.m.run('s1', 'dev')
  h.m.sessionsChanged(new Set())
  assert.ok(await until(() => h.children[0]!.killed === 1))
  assert.equal(h.last('s1')!.status, 'stopped')
  // killSync is the last resort when the app dies.
  await h.m.run('s2', 'dev').catch(() => undefined)
  h.live.set('s1', site)
  await h.m.run('s1', 'dev')
  h.m.killSync()
  assert.equal(h.children[1]!.killed, 1)
  await h.m.shutdown()
})

// ---- frames inside the window ----------------------------------------------------------------------

await t('frames: a frame in the window only goes to loopback pages; web links leave for the browser', () => {
  const self = [47821, 5173]
  assert.equal(subFrameNavigation('http://localhost:3000/', self), 'allow')
  assert.equal(subFrameNavigation('http://127.0.0.1:8080/a/b?c#d', self), 'allow')
  assert.equal(subFrameNavigation('https://localhost:8443/', self), 'allow')
  assert.equal(subFrameNavigation('http://[::1]:3000/', self), 'allow')
  assert.equal(subFrameNavigation('about:blank', self), 'allow')
  assert.equal(subFrameNavigation('about:srcdoc', self), 'allow')
  assert.equal(subFrameNavigation('https://example.com/', self), 'external')
  assert.equal(subFrameNavigation('http://example.com:3000/x', self), 'external')
  assert.equal(subFrameNavigation('http://192.168.1.2:3000/', self), 'external')
  assert.equal(subFrameNavigation('http://localhost.example.com:3000/', self), 'external')
  for (const url of [
    'http://localhost:47821/', // the app's own ingest server
    'http://127.0.0.1:47821/health',
    'http://localhost:5173/', // the app's own page in development
    'http://localhost/',
    'http://127.0.0.1/',
    'http://0.0.0.0:3000/',
    'https://user:pw@example.com/',
    'http://user:pw@localhost:3000/',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:http://localhost:3000/abc',
    'chrome://gpu',
    'theme://office/hq.json',
    'ws://localhost:3000/',
    'about:config',
    '',
    undefined,
    null,
    5
  ]) {
    assert.equal(subFrameNavigation(url, self), 'block', String(url))
  }
  // A page that sends itself out again and again opens one browser tab, not dozens.
  let now = 0
  const gate = new ExternalGate(2000, () => now)
  assert.equal(gate.allow(), true)
  assert.equal(gate.allow(), false)
  now = 1999
  assert.equal(gate.allow(), false)
  now = 2000
  assert.equal(gate.allow(), true)
})

await t('frames: the clipboard is for the window\'s own page, not for a page shown inside it', () => {
  assert.equal(allowWebPermission('clipboard-read', true), true)
  assert.equal(allowWebPermission('clipboard-read', true, true), true)
  assert.equal(allowWebPermission('clipboard-read', true, false), false)
  assert.equal(allowWebPermission('clipboard-sanitized-write', true, false), false)
  for (const perm of ['media', 'geolocation', 'notifications', 'midi', 'pointerLock', 'fullscreen', 'openExternal', 'display-capture', 'hid', 'serial', 'usb']) {
    assert.equal(allowWebPermission(perm, true, false), false, perm)
    assert.equal(allowWebPermission(perm, true, true), false, perm)
  }
  assert.equal(allowWebPermission('clipboard-read', false, true), false)
})

// ---- the pane (pure renderer logic) ----------------------------------------------------------------

await t('pane: open, close, pin, device and width, remembered safely', () => {
  let s = PANE_DEFAULT
  assert.equal(s.open, false)
  s = paneReducer(s, { type: 'toggle' })
  assert.equal(s.open, true)
  assert.equal(paneReducer(s, { type: 'open' }), s, 'no change, same object')
  s = paneReducer(s, { type: 'close' })
  assert.equal(s.open, false)
  assert.equal(paneReducer(s, { type: 'close' }), s)
  s = paneReducer(s, { type: 'device', device: 'phone' })
  assert.equal(s.device, 'phone')
  assert.equal(paneReducer(s, { type: 'device', device: 'watch' as 'phone' }), s)
  // Width: at least PANE_MIN, and it leaves room for the office.
  s = paneReducer(s, { type: 'resize', width: 10, total: 1200 })
  assert.equal(s.width, PANE_MIN)
  s = paneReducer(s, { type: 'resize', width: 5000, total: 1200 })
  assert.equal(s.width, 1200 - PANE_LEAVES)
  s = paneReducer(s, { type: 'resize', width: 500.4, total: 1200 })
  assert.equal(s.width, 500)
  assert.equal(clampPaneWidth(700, 500), PANE_MIN, 'a window too small for both: the minimum')
  assert.equal(clampPaneWidth(Number.NaN, 1200), PANE_DEFAULT.width)
  // Pin: the pane keeps showing that session; it lets go when the session is gone.
  assert.equal(shownSession(s, 'a'), 'a')
  assert.equal(shownSession(s, null), null)
  s = paneReducer(s, { type: 'pin', sessionId: 'b' })
  assert.equal(shownSession(s, 'a'), 'b')
  assert.equal(paneReducer(s, { type: 'sessions', ids: ['a', 'b'] }), s)
  s = paneReducer(s, { type: 'sessions', ids: ['a'] })
  assert.equal(s.pinned, null)
  assert.equal(shownSession(s, 'a'), 'a')
  s = paneReducer(paneReducer(s, { type: 'pin', sessionId: 'a' }), { type: 'pin', sessionId: null })
  assert.equal(s.pinned, null)
  // What the layout next to it has to give up.
  assert.equal(paneFootprint({ ...s, open: false }, 1200), RAIL_WIDTH)
  assert.equal(paneFootprint({ ...s, open: true, width: 500 }, 1200), 501)
  assert.equal(paneFootprint({ ...s, open: true, width: 5000 }, 1200), 1200 - PANE_LEAVES + 1)
  // Stored state: anything odd falls back.
  assert.deepEqual(parsePaneState(null), PANE_DEFAULT)
  assert.deepEqual(parsePaneState('x'), PANE_DEFAULT)
  assert.deepEqual(parsePaneState({ open: 'yes', width: 'wide', device: 'tv', pinned: 7 }), PANE_DEFAULT)
  assert.deepEqual(parsePaneState({ open: true, width: 512.6, device: 'tablet', pinned: 's1' }), { open: true, width: 513, device: 'tablet', pinned: 's1' })
  assert.equal(parsePaneState({ width: -5 }).width, PANE_MIN)
  assert.equal(parsePaneState({ width: 1e9 }).width, 4000)
})

await t('pane: device widths: centred at 1:1 when they fit, scaled down when they do not', () => {
  assert.deepEqual(frameLayout(500, 700, null), { width: 500, height: 700, scale: 1, left: 0 })
  // Phone in a 500 px pane: 390 wide, centred.
  assert.deepEqual(frameLayout(500, 700, 390), { width: 390, height: 700, scale: 1, left: 55 })
  // Desktop in a 500 px pane: laid out at 1280, scaled to fit; the height grows by the same factor.
  const d = frameLayout(500, 700, 1280)
  assert.equal(d.width, 1280)
  assert.equal(d.scale, 500 / 1280)
  assert.equal(d.height, 1792)
  assert.equal(d.left, 0)
  assert.ok(Math.abs(d.width * d.scale - 500) < 0.001 && Math.abs(d.height * d.scale - 700) < 0.5, 'fills the pane exactly')
  assert.deepEqual(frameLayout(768, 600, 768), { width: 768, height: 600, scale: 1, left: 0 })
  assert.equal(frameLayout(767, 600, 768).scale, 767 / 768)
  assert.deepEqual(frameLayout(0, 0, 1280), { width: 0, height: 0, scale: 1, left: 0 })
  assert.deepEqual(frameLayout(500.9, 700.9, null), { width: 500, height: 700, scale: 1, left: 0 })
  assert.equal(scaleLabel(1), '')
  assert.equal(scaleLabel(500 / 1280), '39%')
  assert.equal(scaleLabel(0.999), '')
})

await t('pane: status dot, "updated … ago", and when the page is replaced by a fallback', () => {
  const base: PreviewInfo = { sessionId: 's', url: 'http://localhost:3000/', kind: 'manual', status: 'ready' }
  assert.equal(dotState(null), 'none')
  assert.equal(dotState(base), 'live')
  assert.equal(dotState({ ...base, status: 'starting' }), 'starting')
  assert.equal(dotState({ ...base, status: 'unreachable' }), 'unreachable')
  assert.equal(dotState({ ...base, status: 'stopped' }), 'none')
  assert.equal(dotState({ ...base, framable: false }), 'unreachable')
  assert.equal(updatedLabel(undefined, 0), '')
  assert.equal(updatedLabel(10_000, 10_500), 'updated just now')
  assert.equal(updatedLabel(10_000, 13_400), 'updated 3 s ago')
  assert.equal(updatedLabel(10_000, 10_000 + 125_000), 'updated 2 min ago')
  assert.equal(updatedLabel(10_000, 10_000 + 3 * 3_600_000), 'updated 3 h ago')
  assert.equal(updatedLabel(10_000, 5_000), 'updated just now')
  assert.equal(showsFallback(base, false), false)
  assert.equal(showsFallback(base, true), true)
  assert.equal(showsFallback({ ...base, status: 'unreachable' }, false), true)
  assert.equal(showsFallback({ ...base, framable: false }, false), true)
  assert.equal(showsFallback({ ...base, url: '', status: 'starting', script: 'dev' }, false), true)
  assert.equal(fallbackText({ ...base, url: '', status: 'starting', script: 'dev' }, false), 'Starting npm run dev…')
  assert.equal(fallbackText({ ...base, status: 'unreachable', note: 'The script ended (code 1).' }, false), 'The script ended (code 1).')
  assert.equal(fallbackText({ ...base, status: 'unreachable' }, false), 'Nothing answers at this address.')
  assert.match(fallbackText({ ...base, framable: false }, false), /does not allow being shown/)
  assert.match(fallbackText(base, true), /taking a long time/)
  assert.equal(fallbackTitle({ ...base, url: '', status: 'starting', script: 'dev' }), 'Starting the server')
  assert.equal(fallbackTitle({ ...base, url: '', status: 'unreachable', script: 'dev' }), 'The server did not start')
  assert.equal(fallbackTitle({ ...base, status: 'unreachable', script: 'dev' }), 'The server stopped')
  assert.equal(fallbackTitle({ ...base, status: 'unreachable' }), 'Not reachable')
  assert.equal(fallbackTitle({ ...base, framable: false }), 'This page cannot be shown here')
  assert.equal(fallbackTitle(base), 'Still loading')
  assert.equal(blockedNotice({ url: 'http://localhost:47821/health', opened: false }, 60_000).text, 'The page tried to go to localhost:47821, which is not shown here.')
  // A page that wants out: once is undone (and said), again right away is not (that would loop).
  assert.deepEqual(blockedNotice({ url: 'https://example.com/x', opened: true }, 60_000), { text: 'Opened example.com in your browser.', restore: true })
  assert.deepEqual(blockedNotice({ url: 'https://example.com/x', opened: false }, 60_000), { text: 'The page tried to go to example.com. Only pages on this computer are shown here.', restore: true })
  assert.deepEqual(blockedNotice({ url: 'https://example.com/x', opened: false }, 1200), { text: 'This page keeps leaving for example.com. Reload to show it again.', restore: false })
  assert.equal(blockedNotice({ url: 'nonsense', opened: false }, 60_000).text, 'The page tried to go to another site. Only pages on this computer are shown here.')
})

await closeServer(dev.server)
await closeServer(framed.server)
await closeServer(redirecting.server)
try {
  rmSync(outer, { recursive: true, force: true })
} catch {
  /* a watcher may still hold it for a moment */
}

console.log(`\n${pass} preview tests passed\n`)
