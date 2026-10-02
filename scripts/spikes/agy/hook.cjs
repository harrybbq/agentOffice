#!/usr/bin/env node
// Phase C spike: the hook command agy runs (`cmd /c node hook.cjs <Event>` on Windows). Dependency-free.
// It forwards the hook payload (JSON on stdin) to a local HTTP server and prints whatever JSON the
// server answers, which is agy's hook result. The HTTP request is the QUESTION; the held response
// carries the answer. Nothing here can approve anything by itself.
//
// Where the server is: env AO_AGY_HOOK_URL + AO_AGY_HOOK_TOKEN (inherited from the agy process), or,
// when the env did not come through, the file `ao-hook-endpoint.json` next to hooks.json (agy sets the
// hook's working directory to the folder that holds hooks.json).
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const event = process.argv[2] || 'Unknown'

/** What agy gets when the app can't be reached: PreToolUse fails closed, everything else is a no-op. */
function fallback(reason) {
  if (event === 'PreToolUse') return { decision: 'deny', reason: `Agent Office could not be reached (${reason}), so this action was not approved.` }
  if (event === 'Stop') return { decision: 'stop' }
  return {}
}

function endpoint() {
  if (process.env.AO_AGY_HOOK_URL) return { url: process.env.AO_AGY_HOOK_URL, token: process.env.AO_AGY_HOOK_TOKEN || '', source: 'env' }
  for (const dir of [process.cwd(), __dirname]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'ao-hook-endpoint.json'), 'utf8'))
      if (j.url) return { url: j.url, token: j.token || '', source: `file:${dir}` }
    } catch {
      // try the next place
    }
  }
  return null
}

function finish(obj) {
  process.stdout.write(JSON.stringify(obj))
  process.exit(0)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  const ep = endpoint()
  if (!ep) return finish(fallback('no endpoint'))
  let payload
  try {
    payload = JSON.parse(raw.replace(/^﻿/, ''))
  } catch {
    payload = { unparsed: raw.slice(0, 2000) }
  }
  const body = JSON.stringify({
    event,
    payload,
    // Diagnostics for the spike: how agy runs hooks.
    diag: {
      cwd: process.cwd(),
      argv: process.argv.slice(1),
      endpointFrom: ep.source,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTIGRAVITY_|AGY_|AO_AGY_|GEMINI_)/.test(k)).map(([k, v]) => [k, /TOKEN|KEY/.test(k) ? '<set>' : v])),
      ppid: process.ppid
    }
  })
  const u = new URL(ep.url)
  const req = http.request(
    { host: u.hostname, port: u.port, path: `${u.pathname.replace(/\/$/, '')}/${event}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-ao-token': ep.token } },
    (res) => {
      let out = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (out += d))
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(fallback(`HTTP ${res.statusCode}`))
        try {
          finish(JSON.parse(out))
        } catch {
          finish(fallback('bad answer'))
        }
      })
    }
  )
  // No client-side timeout: agy's own hook `timeout` is the limit, the server holds the response.
  req.on('error', (err) => finish(fallback(err.code || 'error')))
  req.end(body)
})
