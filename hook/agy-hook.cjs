// Hook command of an Antigravity (`agy`) session hosted by Agent Office. agy runs it as
// `cmd /c node agy-hook.cjs <Event>` (the command must not contain a double quote on Windows), with
// the folder of hooks.json as the working directory and the hook payload as JSON on stdin. A copy of
// this file sits next to that hooks.json, in the app's own per-session folder; nothing is ever
// written to ~/.gemini or to the user's project.
//
// It forwards the payload to the app (POST /hooks/agy on 127.0.0.1) and prints the app's answer,
// which is agy's hook result. The request is the QUESTION; the app holds the response until the
// user decided in the CEO inbox. This script can approve nothing by itself.
//
// Hosted agy sessions run with agy's own permission checks lifted, so the PreToolUse answer is the
// ONLY gate. Therefore, for PreToolUse: whenever the app can't be reached, answers late, answers
// with anything but a well-formed `allow` or `deny`, or anything at all goes wrong here, the answer
// is `deny`. Never an allow by default.
//
// Rules: no dependencies, always exit 0, stdout is exactly one JSON object, never print the token.
'use strict'
const http = require('node:http')

const event = String(process.argv[2] || '')
const GATE = event === 'PreToolUse'
/** A little under the `timeout` of the hook in hooks.json, so agy gets an answer and not a killed process. */
const DEFAULT_TIMEOUT_MS = GATE ? 3_540_000 : 4000
const MAX_STDIN = 8 * 1024 * 1024
const MAX_ANSWER = 1024 * 1024

let finished = false
function finish(obj) {
  if (finished) return
  finished = true
  let text = '{}'
  try {
    text = JSON.stringify(obj)
  } catch {
    text = GATE ? '{"decision":"deny","reason":"Agent Office: internal hook error, so this action was not approved."}' : '{}'
  }
  process.stdout.write(text, () => process.exit(0))
  // If stdout never drains, still leave.
  setTimeout(() => process.exit(0), 1000)
}

/** What agy gets when the app gave no usable answer: the gate fails closed, everything else is a no-op. */
function fallback(why) {
  if (GATE) return { decision: 'deny', reason: `Agent Office could not be asked (${why}), so this action was not approved.` }
  return {}
}

/** The app's answer, as agy may see it. For the gate, anything that is not exactly allow / deny is a deny. */
function vet(answer) {
  const isObject = !!answer && typeof answer === 'object' && !Array.isArray(answer)
  if (!GATE) return isObject ? answer : {}
  if (!isObject) return fallback('malformed answer')
  if (answer.decision === 'allow') return { decision: 'allow' }
  if (answer.decision === 'deny') {
    const reason = typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason.slice(0, 2000) : 'Denied by Agent Office.'
    return { decision: 'deny', reason }
  }
  return fallback('malformed answer')
}

process.on('uncaughtException', () => finish(fallback('hook error')))
process.on('unhandledRejection', () => finish(fallback('hook error')))

function ask(stdin) {
  let target
  try {
    target = new URL(process.env.AO_AGY_URL || '')
  } catch {
    return finish(fallback('no endpoint'))
  }
  const token = process.env.AO_AGY_TOKEN || ''
  // The app only listens on loopback; never send a payload anywhere else.
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !token) return finish(fallback('no endpoint'))
  let payload = null
  try {
    payload = JSON.parse(stdin.replace(/^﻿/, ''))
  } catch {
    payload = null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return finish(fallback('unreadable hook input'))

  const limit = Number(process.env.AO_AGY_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_TIMEOUT_MS
  const body = JSON.stringify({ event, payload })
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-agent-office-token': token
  }
  if (process.env.AO_AGY_SESSION) headers['x-agent-office-session'] = process.env.AO_AGY_SESSION

  const timer = setTimeout(() => {
    finish(fallback('no answer in time'))
    req.destroy()
  }, timeoutMs)
  const req = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers }, (res) => {
    let out = ''
    let tooLong = false
    res.setEncoding('utf8')
    res.on('data', (d) => {
      if (out.length + d.length > MAX_ANSWER) tooLong = true
      else out += d
    })
    res.on('error', () => finish(fallback('connection lost')))
    res.on('end', () => {
      clearTimeout(timer)
      if (res.statusCode !== 200) return finish(fallback(`HTTP ${res.statusCode}`))
      if (tooLong) return finish(fallback('malformed answer'))
      let answer
      try {
        answer = JSON.parse(out)
      } catch {
        return finish(fallback('malformed answer'))
      }
      finish(vet(answer))
    })
  })
  req.on('error', () => {
    clearTimeout(timer)
    finish(fallback('not reachable'))
  })
  req.end(body)
}

let stdin = ''
let tooBig = false
let sent = false
const send = () => {
  if (sent) return
  sent = true
  if (tooBig) return finish(fallback('hook input too large'))
  ask(stdin)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  if (stdin.length + c.length > MAX_STDIN) tooBig = true
  else stdin += c
})
process.stdin.on('end', send)
process.stdin.on('error', send)
