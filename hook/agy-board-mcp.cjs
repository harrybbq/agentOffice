// The office board for a hosted Antigravity (`agy`) session: a tiny MCP server over stdio that
// forwards every JSON-RPC message to the app's board route (POST /mcp on 127.0.0.1) and prints the
// answer. agy starts it from the per-session `.agents/mcp_config.json`; where the app is and the
// session's board token come from the environment agy was started with (AO_BOARD_URL,
// AO_BOARD_TOKEN), so no token is ever written to a file.
//
// The board route only reads and writes the board (electron/boardMcp.ts): nothing here can answer
// a permission request or send a prompt.
//
// Rules: no dependencies, newline-delimited JSON on stdout only, never print the token.
'use strict'
const http = require('node:http')

const MAX_LINE = 64 * 1024
let target = null
try {
  target = new URL(process.env.AO_BOARD_URL || '')
} catch {
  target = null
}
const token = process.env.AO_BOARD_TOKEN || ''
const usable = !!target && target.protocol === 'http:' && target.hostname === '127.0.0.1' && token.length > 0

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const idOf = (msg) => (msg && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : undefined)
const fail = (msg, text) => {
  const id = idOf(msg)
  if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } })
}

/** One at a time, in order: answers leave in the order the requests came. */
let chain = Promise.resolve()

function forward(msg) {
  return new Promise((resolve) => {
    if (!usable) {
      fail(msg, 'The Agent Office board is not available.')
      return resolve()
    }
    const body = JSON.stringify(msg)
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        timeout: 15_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` }
      },
      (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (d) => {
          if (out.length < 1024 * 1024) out += d
        })
        res.on('error', () => {
          fail(msg, 'The Agent Office board did not answer.')
          resolve()
        })
        res.on('end', () => {
          if (res.statusCode === 202 || out.length === 0) return resolve() // a notification
          try {
            const answer = JSON.parse(out)
            if (res.statusCode === 200) write(answer)
            else fail(msg, 'The Agent Office board refused the request.')
          } catch {
            fail(msg, 'The Agent Office board gave an unreadable answer.')
          }
          resolve()
        })
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => {
      fail(msg, 'The Agent Office board could not be reached.')
      resolve()
    })
    req.end(body)
  })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    chain = chain.then(() => forward(msg))
  }
  if (buf.length > MAX_LINE) buf = ''
})
process.stdin.on('end', () => void chain.then(() => process.exit(0)))
process.stdin.on('error', () => process.exit(0))
