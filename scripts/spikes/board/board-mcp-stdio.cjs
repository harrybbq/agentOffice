// Office-board spike: the stdio alternative. The AGENT spawns this (`node board-mcp-stdio.cjs`); it
// is a dumb pipe that forwards every JSON-RPC line from stdin to the app's board endpoint over HTTP
// and writes the answer to stdout. No state, no dependencies; the board lives in the app.
//
// Env (set by the app in the agent's environment, or by the MCP config's `env`):
//   AO_BOARD_URL    http://127.0.0.1:<port>/mcp
//   AO_BOARD_TOKEN  the session's own board token
//
// stdout carries protocol messages only; diagnostics go to stderr.
'use strict'
const http = require('node:http')

const target = process.env.AO_BOARD_URL
const token = process.env.AO_BOARD_TOKEN
if (!target || !token) {
  process.stderr.write('board-mcp-stdio: AO_BOARD_URL / AO_BOARD_TOKEN are not set\n')
  process.exit(2)
}
const url = new URL(target)
if (url.hostname !== '127.0.0.1') {
  process.stderr.write('board-mcp-stdio: the board must be on 127.0.0.1\n')
  process.exit(2)
}

function forward(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const isRequest = msg && msg.id !== undefined && msg.id !== null && typeof msg.method === 'string'
  const fail = (message) => {
    if (isRequest) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } }) + '\n')
  }
  const body = Buffer.from(line, 'utf8')
  const req = http.request(
    {
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: 10_000,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': body.length,
        authorization: `Bearer ${token}`,
        'user-agent': 'agent-office-board-stdio/0.0.1'
      }
    },
    (res) => {
      let out = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (out += c))
      res.on('end', () => {
        if (res.statusCode === 202 || out.length === 0) return
        if (res.statusCode !== 200) return fail(`the office board answered ${res.statusCode}`)
        // One line per message: a JSON body never contains a raw newline, but be safe.
        process.stdout.write(out.replace(/\r?\n/g, ' ') + '\n')
      })
    }
  )
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', (e) => fail(`the office board is not reachable (${e.message})`))
  req.end(body)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, '')
    buf = buf.slice(nl + 1)
    if (line.trim()) forward(line)
  }
})
// The agent closed our stdin: it is gone, so are we.
process.stdin.on('end', () => setTimeout(() => process.exit(0), 200))
