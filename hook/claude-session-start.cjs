// SessionStart command hook for sessions hosted by Agent Office. Injected through the temp file
// passed to `claude --settings`; nothing is ever written to the user's own settings.
//
// SessionStart can't be a `type:"http"` hook, and only a command hook can read the session's inbox
// endpoint (CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN). This script POSTs the hook
// input plus that endpoint to the app, which keeps it in memory to deliver CEO orders.
//
// Rules: no dependencies, always exit 0, finish fast, never write to stdout (Claude Code would
// read it as hook output) and never print the token.
'use strict'
const http = require('node:http')

const HARD_LIMIT_MS = 3000
const done = () => process.exit(0)
setTimeout(done, HARD_LIMIT_MS)
process.on('uncaughtException', done)
process.on('unhandledRejection', done)

function post(stdin) {
  let target
  try {
    target = new URL(process.env.AO_URL || '')
  } catch {
    return done()
  }
  // The app only listens on loopback; never send the endpoint anywhere else.
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !process.env.AO_TOKEN) return done()
  let hook = null
  try {
    hook = JSON.parse(stdin)
  } catch {}
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) hook = {}
  const body = JSON.stringify({
    ...hook,
    hook_event_name: 'SessionStart',
    _ao: {
      socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || null,
      token: process.env.CLAUDE_CODE_MESSAGING_TOKEN || null
    }
  })
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-agent-office-token': process.env.AO_TOKEN
  }
  if (process.env.AO_SESSION) headers['x-agent-office-session'] = process.env.AO_SESSION
  const req = http.request(
    { host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers, timeout: 2000 },
    (res) => {
      res.resume()
      res.on('end', done)
      res.on('error', done)
    }
  )
  req.on('timeout', () => req.destroy())
  req.on('error', done)
  req.end(body)
}

let stdin = ''
let sent = false
const send = () => {
  if (sent) return
  sent = true
  post(stdin)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  if (stdin.length < 1024 * 1024) stdin += c
})
process.stdin.on('end', send)
process.stdin.on('error', send)
// If stdin never closes, still report the endpoint.
setTimeout(send, 1000)
