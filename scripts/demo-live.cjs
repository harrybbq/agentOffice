// Live demo: launches a visible Agent Office (own data folder, so it doesn't disturb your normal one),
// starts real Claude Code and Codex sessions in throwaway folders and gives each a small task that
// spawns subagents, so you can watch a busy multi-branch office. Uses real quota (a few short turns).
//
//   npm run build && node scripts/demo-live.cjs
//
// Permission requests are left for YOU to answer in the CEO inbox. Quit the demo from its tray icon.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require('ws')

const repo = path.join(__dirname, '..')
const electron = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const userData = path.join(process.env.APPDATA || os.homedir(), 'agent-office-demo')
const work = path.join(os.tmpdir(), 'agent-office-demo')
const INGEST_PORT = 47996
const CDP_PORT = 9371

const SESSIONS = [
  {
    provider: 'claude-code', folder: 'research-desk', model: 'sonnet', permissionMode: 'acceptEdits',
    prompt:
      'Use the Agent tool to run three subagents in parallel: (1) fetch https://example.com with WebFetch and write a two-line summary to summary.md; ' +
      '(2) write a small Node script fizzbuzz.js and run it with node; (3) read every file in this folder and write INDEX.md listing them. ' +
      'When all three are done, give me a three-line report.'
  },
  {
    provider: 'claude-code', folder: 'writers-room', model: 'haiku', permissionMode: 'default',
    prompt:
      'Use the Agent tool to run two subagents in parallel: (1) write a haiku about a busy office to haiku.txt; ' +
      '(2) search the web for "Prison Architect art style" and write three bullet points to notes.md. Then report in two lines.'
  },
  {
    provider: 'codex', folder: 'landing-page', permissionMode: 'default',
    prompt: 'Create index.html and style.css for a simple landing page for a pixel-art office app, then list the files in this folder.'
  },
  {
    provider: 'codex', folder: 'primes', permissionMode: 'acceptEdits',
    prompt: 'Write a Node script primes.js that prints the first 20 primes, run it, and tell me the output.'
  }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function main() {
  fs.mkdirSync(userData, { recursive: true })
  const cfgFile = path.join(userData, 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) } catch {}
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, port: INGEST_PORT, allowOrders: true, overlay: false }, null, 2))
  for (const s of SESSIONS) {
    const dir = path.join(work, s.folder)
    fs.mkdirSync(dir, { recursive: true })
    const readme = path.join(dir, 'README.md')
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `# ${s.folder}\n\nThrowaway folder for the Agent Office live demo.\n`)
  }

  const env = { ...process.env, AGENT_OFFICE_USER_DATA: userData }
  for (const k of Object.keys(env)) if (/^(CLAUDE|AI_AGENT)/.test(k) || k === 'AGENT_OFFICE_SHOW_INACTIVE') delete env[k]
  const child = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: repo, env, detached: true, stdio: 'ignore' })
  child.unref()
  log('launched Agent Office demo, pid', child.pid)

  // Connect to the renderer over CDP.
  let page
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500)
    try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page') } catch {}
  }
  if (!page) throw new Error('app did not start')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  let seq = 0
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const on = (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.id !== id) return
      ws.off('message', on)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }
  const bridge = (expr) => ev(`(async () => { const b = window.agentOffice; return ${expr} })()`)
  for (let i = 0; i < 40; i++) { if (await ev('!!(window.agentOffice && window.agentOffice.sessions)').catch(() => false)) break; await sleep(500) }
  await sleep(2500)

  const providers = await bridge('b.sessions.providers()')
  log('providers:', providers.map((p) => `${p.label}=${p.available ? 'ok' : p.reason}${p.account ? (p.account.loggedIn ? ' (logged in)' : ' (logged out)') : ''}`).join(', '))
  const state = async (id) => (await bridge('b.sessions.list()')).find((s) => s.id === id)
  const waitState = async (id, want, ms) => {
    const t0 = Date.now()
    let s
    while (Date.now() - t0 < ms) { s = await state(id); if (!s || want.includes(s.state)) return s; await sleep(700) }
    return s
  }

  for (const [i, s] of SESSIONS.entries()) {
    const p = providers.find((x) => x.id === s.provider)
    if (!p || !p.available || (p.account && !p.account.loggedIn)) { log(`skip ${s.folder}: ${s.provider} unavailable`); continue }
    const req = { provider: s.provider, cwd: path.join(work, s.folder), permissionMode: s.permissionMode, ...(s.model ? { model: s.model } : {}) }
    let info
    try { info = await bridge(`b.sessions.start(${JSON.stringify(req)})`) } catch (e) { log(`start failed for ${s.folder}:`, e.message); continue }
    log(`started ${s.provider} in ${s.folder} (${info.id})`)
    // Select it in the sidebar so its pane opens (Ctrl+<n>).
    await sleep(1200)

    if (info.surface === 'terminal') {
      let st = await waitState(info.id, ['needs-attention', 'idle'], 30000)
      if (st && st.state === 'needs-attention') {
        // Folder-trust dialog for a brand-new demo folder: Down, Enter = "Yes, I trust this folder".
        await sleep(2500)
        await bridge(`b.terminal.write(${JSON.stringify(info.id)}, "\\u001b[B")`)
        await sleep(400)
        await bridge(`b.terminal.write(${JSON.stringify(info.id)}, "\\r")`)
        st = await waitState(info.id, ['idle'], 40000)
      }
      if (!st || st.state !== 'idle') { log(`  ${s.folder} is ${st ? st.state : 'gone'}; not sending a prompt`); continue }
      await sleep(1500)
      await bridge(`b.terminal.write(${JSON.stringify(info.id)}, ${JSON.stringify(s.prompt)})`)
      await sleep(500)
      await bridge(`b.terminal.write(${JSON.stringify(info.id)}, "\\r")`)
    } else {
      const st = await waitState(info.id, ['idle'], 40000)
      if (!st || st.state !== 'idle') { log(`  ${s.folder} is ${st ? st.state : 'gone'}; not sending a prompt`); continue }
      try { await bridge(`b.chat.send(${JSON.stringify(info.id)}, ${JSON.stringify(s.prompt)})`) } catch (e) { log('  send failed:', e.message); continue }
    }
    log(`  task sent to ${s.folder}`)
    await sleep(i < SESSIONS.length - 1 ? 6000 : 0) // stagger so the branches are built one after another
  }

  // Watch for a while and print what the office is doing.
  for (let i = 0; i < 12; i++) {
    await sleep(10000)
    const list = await bridge('b.sessions.list()')
    const pending = await bridge('b.permissions.list()')
    log(list.map((s) => `${s.title}:${s.state}`).join('  |  '), pending.length ? `  [${pending.length} waiting on you: ${pending.map((x) => x.summary.slice(0, 40)).join('; ')}]` : '')
  }
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  const out = path.join(os.tmpdir(), 'agent-office-demo', 'demo.png')
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  log('screenshot:', out)
  ws.close()
  log('demo left running — answer the CEO inbox, and quit from the tray when done')
}

main().catch((e) => { console.error(e); process.exit(1) })
