// Office board, open question of docs/spikes-board.md: does a NON-ephemeral Codex thread write its
// per-thread `config` (and so the board token in `mcp_servers.agent_office.http_headers`) to disk
// under ~/.codex (rollout file, state databases)?
//
//   node scripts/spikes/board/codex-persist-probe.cjs [--turn]
//
// NO model turn by default: thread/start with a marker in the config, then `thread/inject_items`
// (appends a developer message to the thread's history, which makes the server materialise the
// rollout), then every file under ~/.codex that changed since the start is searched for the marker.
// `--turn` adds ONE short model turn (effort low) before the last scan.
// Nothing under ~/.codex is written by this script; the app-server leaves one throwaway thread.
'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CodexRpc, sleep } = require('../codex/rpc.cjs')

const WITH_TURN = process.argv.includes('--turn')
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const root = path.join(os.tmpdir(), 'ao-board-spike')
const workdir = path.join(root, 'ws-persist')
fs.mkdirSync(workdir, { recursive: true })
const MARKER = `AOPROBE${crypto.randomBytes(12).toString('hex')}`
const INJECTED = `AOINJECT${crypto.randomBytes(6).toString('hex')}`
const T0 = Date.now()

/** Files under CODEX_HOME changed since the probe started that contain `needle`. */
function scan(needle) {
  const hits = []
  let scanned = 0
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['vendor_imports', 'plugins', 'skills', 'cache', 'pets'].includes(e.name)) continue
        walk(p, depth + 1)
        continue
      }
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (st.mtimeMs < T0 - 5000 || st.size > 300 * 1024 * 1024) continue
      if (e.name === 'auth.json') continue // credentials: never read
      scanned++
      let buf
      try {
        buf = fs.readFileSync(p)
      } catch {
        continue
      }
      const at = buf.indexOf(needle)
      if (at >= 0) {
        const around = buf.subarray(Math.max(0, at - 90), at + needle.length + 30).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
        hits.push({ file: path.relative(CODEX_HOME, p), size: st.size, around })
      }
    }
  }
  walk(CODEX_HOME, 0)
  return { scanned, hits }
}

;(async () => {
  const rpc = new CodexRpc({
    logFile: path.join(root, 'codex-persist-probe.log'),
    cwd: workdir,
    echo: false,
    args: ['--disable', 'plugins', '--disable', 'apps'],
    onRequest: () => undefined
  }).start()
  const report = (k, v) => console.log(`### ${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`)
  try {
    await rpc.initialize()
    const r = await rpc.try('thread/start', {
      cwd: workdir,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      config: { 'mcp_servers.agent_office': { url: 'http://127.0.0.1:9/mcp', http_headers: { Authorization: `Bearer ${MARKER}` } } }
    })
    if (r.error) return report('thread/start ERROR', r.error)
    const threadId = r.result.thread.id
    report('thread', { id: threadId, ephemeral: r.result.thread.ephemeral, path: r.result.thread.path ?? null })
    await sleep(2500)
    report('scan after thread/start (config marker)', scan(MARKER))

    const inj = await rpc.try('thread/inject_items', {
      threadId,
      items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `probe ${INJECTED}` }] }]
    })
    report('thread/inject_items', inj.error ?? 'ok')
    await sleep(2500)
    report('scan after inject (config marker)', scan(MARKER))
    report('scan after inject (injected text: is the rollout written at all?)', scan(INJECTED))

    if (WITH_TURN) {
      const turn = await rpc.try('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Reply with the single word: ok', text_elements: [] }],
        effort: 'low',
        approvalPolicy: 'untrusted'
      })
      report('turn/start', turn.error ?? 'started')
      await rpc.waitFor('turn/completed', 90_000)
      await sleep(1500)
      report('scan after one turn (config marker)', scan(MARKER))
      report('scan after one turn (injected text)', scan(INJECTED))
    }

    const read = await rpc.try('thread/read', { threadId, includeTurns: false })
    report('thread/read mentions the marker', read.error ? read.error : JSON.stringify(read.result).includes(MARKER))
    await rpc.try('thread/unsubscribe', { threadId }, 5000)
  } finally {
    await rpc.stop()
  }
  await sleep(1500)
  report('scan after the app-server stopped (config marker)', scan(MARKER))
  report('scan after the app-server stopped (injected text)', scan(INJECTED))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
