// Office-board spike, Codex side, NO model turns: how can the app give app-server threads an MCP
// server (and hooks) without touching ~/.codex/config.toml, and can the board tell threads apart?
//
//   node scripts/spikes/board/codex-probe.cjs [--root <scratch dir>]
//
// One app-server on the default home (plugins/apps off to save memory), ephemeral threads, no turn.
// Evidence: scripts/spikes/board/logs/codex-probe.log (wire) + the board server's own request log.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CodexRpc, sleep } = require('../codex/rpc.cjs')
const { startBoardServer } = require('./board-mcp-http.cjs')

const argv = process.argv.slice(2)
const flag = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined)
const root = path.resolve(flag('--root') ?? path.join(os.tmpdir(), 'ao-board-spike'))
const workdir = path.join(root, 'ws-codex')
fs.mkdirSync(workdir, { recursive: true })
const logDir = path.join(__dirname, 'logs')
const stdioScript = path.join(__dirname, 'board-mcp-stdio.cjs').replace(/\\/g, '/')
const hookScript = path.join(__dirname, 'codex-hook-probe.cjs').replace(/\\/g, '/')

const out = []
const note = (k, v) => {
  out.push([k, v])
  console.log(`\n### ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`)
}
const brief = (status) =>
  (status?.data ?? []).map((s) => ({ name: s.name, runtimeStatus: s.runtimeStatus, tools: Object.keys(s.tools ?? {}), httpOrigin: s.httpOrigin, authStatus: s.authStatus, toolsError: s.toolsError }))

;(async () => {
  const tokens = {
    'tok-cli': { session: 'cli-default', team: 'CLI default' },
    'tok-thread-1': { session: 'thread-1', team: 'Team One' },
    'tok-thread-2': { session: 'thread-2', team: 'Team Two' },
    'tok-nested': { session: 'thread-nested', team: 'Team Nested' },
    'tok-stdio': { session: 'thread-stdio', team: 'Team Stdio' },
    'tok-env': { session: 'env-header', team: 'Env header' }
  }
  const board = await startBoardServer({ tokens })
  const seen = () => board.calls.map((c) => `${c.session ?? '401'}:${c.method}${c.tool ? `:${c.tool}` : ''}`)

  const toml = (s) => JSON.stringify(s) // a JSON string is a valid TOML basic string
  const rpc = new CodexRpc({
    logFile: path.join(logDir, 'codex-probe.log'),
    cwd: workdir,
    echo: false,
    args: [
      '--disable', 'plugins', '--disable', 'apps', '-c', 'mcp_servers.node_repl.enabled=false',
      // (1) an MCP server for every thread of this app-server, from the command line only
      '-c', `mcp_servers.office.url=${toml(board.url)}`,
      '-c', 'mcp_servers.office.http_headers={Authorization="Bearer tok-cli"}',
      // (2) a hook from the command line only
      '-c', `hooks.PreToolUse=[{matcher="apply_patch|Edit|Write",hooks=[{type="command",command=${toml(`node "${hookScript}"`)},timeout=5}]}]`,
      '-c', `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${toml(`node "${hookScript}"`)},timeout=5}]}]`
    ],
    onRequest: (msg) => {
      note('server request', { method: msg.method, params: msg.params })
      return undefined
    }
  }).start()
  try {
    const init = await rpc.initialize()
    note('initialize', init)

    const start = async (label, config) => {
      const t0 = Date.now()
      const r = await rpc.try('thread/start', { cwd: workdir, ephemeral: true, approvalPolicy: 'untrusted', sandbox: 'read-only', ...(config ? { config } : {}) })
      if (r.error) {
        note(`thread/start ${label} ERROR`, r.error)
        return null
      }
      const threadId = r.result.thread.id
      // MCP servers start in the background: give them a moment, then ask.
      await sleep(2500)
      const st = await rpc.try('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' })
      note(`thread ${label} (${Date.now() - t0} ms) mcp`, st.error ?? brief(st.result))
      return threadId
    }
    const callTool = async (label, threadId, server = 'office') => {
      const r = await rpc.try('mcpServer/tool/call', { threadId, server, tool: 'board_claim', arguments: { task: `task of ${label}` } })
      note(`mcpServer/tool/call ${label}`, r.error ?? r.result)
    }

    // A. command-line server only
    const tA = await start('A (cli -c only)')
    if (tA) await callTool('A', tA)

    // B. per-thread override of the SAME server name: dotted keys
    const t1 = await start('B1 (config dotted key, header override)', { 'mcp_servers.office.http_headers': { Authorization: 'Bearer tok-thread-1' } })
    if (t1) await callTool('B1', t1)
    const t2 = await start('B2 (config dotted key, other header)', { 'mcp_servers.office.http_headers': { Authorization: 'Bearer tok-thread-2' } })
    if (t2) await callTool('B2', t2)

    // C. per-thread: nested object, a server the command line doesn't know
    const t3 = await start('C (config nested object, new server)', { mcp_servers: { office_nested: { url: board.url, http_headers: { Authorization: 'Bearer tok-nested' } } } })
    if (t3) await callTool('C', t3, 'office_nested')

    // D. per-thread: stdio bridge with the token in its env
    const t4 = await start('D (config stdio per thread)', {
      'mcp_servers.office_stdio': { command: 'node', args: [stdioScript], env: { AO_BOARD_URL: board.url, AO_BOARD_TOKEN: 'tok-stdio' } }
    })
    if (t4) await callTool('D', t4, 'office_stdio')

    // G. per-thread only: a whole http server as ONE dotted key (what the driver would send; nothing on the command line)
    const t6 = await start('G (config dotted table, http, new server)', {
      'mcp_servers.office_http': { url: board.url, http_headers: { Authorization: 'Bearer tok-nested' } }
    })
    if (t6) await callTool('G', t6, 'office_http')
    // H. a wrong token: what does the thread see?
    await start('H (unknown token)', { 'mcp_servers.office.http_headers': { Authorization: 'Bearer wrong' } })

    // E. approval mode keys accepted? (effect needs a turn)
    const t5 = await start('E (default_tools_approval_mode=approve)', {
      'mcp_servers.office.http_headers': { Authorization: 'Bearer tok-thread-1' },
      'mcp_servers.office.default_tools_approval_mode': 'approve'
    })

    // Did thread A keep its own identity after the other threads started?
    if (tA) await callTool('A again', tA)
    if (t1) await callTool('B1 again', t1)

    note('board saw (session:method)', seen())
    note('board state as thread-1 reads it', board.board.render('thread-1'))

    // F. hooks
    const hooks = await rpc.try('hooks/list', { cwds: [workdir] })
    note('hooks/list', hooks.error ?? hooks.result)
    const cfg = await rpc.try('config/read', { includeLayers: true, cwd: workdir })
    if (cfg.result) {
      note('config.mcp_servers.office', cfg.result.config?.mcp_servers?.office ?? null)
      note('config.hooks', cfg.result.config?.hooks ?? null)
      note('config layers', (cfg.result.layers ?? []).map((l) => l.name ?? l.source ?? Object.keys(l)))
    } else note('config/read ERROR', cfg.error)
    void t5
  } finally {
    await rpc.stop()
    await board.close()
    fs.writeFileSync(path.join(logDir, 'codex-probe.findings.log'), JSON.stringify(out, null, 2))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
