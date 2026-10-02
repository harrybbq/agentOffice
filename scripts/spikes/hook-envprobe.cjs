// Spike: `type: "command"` hook. Reads Claude Code's inbox endpoint from its own env and POSTs it
// (with the hook stdin) to the spike server. Argument: a label (e.g. "settings-flag" / "project").
const http = require('node:http')
let stdin = ''
process.stdin.on('data', (c) => (stdin += c))
process.stdin.on('end', () => {
  let hook = null
  try { hook = JSON.parse(stdin) } catch {}
  const body = JSON.stringify({
    label: process.argv[2] || 'settings-flag',
    socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || null,
    token: process.env.CLAUDE_CODE_MESSAGING_TOKEN || null,
    hook,
    claudeEnvKeys: Object.keys(process.env).filter((k) => /^CLAUDE/.test(k)).sort()
  })
  const url = new URL(process.env.AO_PROBE_URL)
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-agent-office-token': process.env.AO_TOKEN || '' } },
    (res) => { res.resume(); res.on('end', () => process.exit(0)) })
  req.on('error', () => process.exit(0))
  req.end(body)
})
