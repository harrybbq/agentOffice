// Office-board spike: checks both MCP servers with a hand-written client. No model, no quota.
//   node scripts/spikes/board/selftest.cjs
'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const assert = require('node:assert')
const { startBoardServer } = require('./board-mcp-http.cjs')

async function post(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

;(async () => {
  const srv = await startBoardServer({ tokens: { 'tok-a': { session: 's-a', team: 'Team A' }, 'tok-b': { session: 's-b', team: 'Team B' } }, log: () => {} })
  const call = (token, id, name, args = {}) => post(srv.url, token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

  assert.equal((await post(srv.url, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401)
  assert.equal((await post(srv.url, 'nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401)
  const init = await post(srv.url, 'tok-a', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  assert.equal(init.json.result.protocolVersion, '2025-06-18')
  assert.equal((await post(srv.url, 'tok-a', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  const list = await post(srv.url, 'tok-a', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual(list.json.result.tools.map((t) => t.name), ['board_read', 'board_claim', 'board_post'])

  const c1 = await call('tok-a', 3, 'board_claim', { task: 'Write tests' })
  assert.equal(c1.json.result.isError, false)
  const c2 = await call('tok-b', 4, 'board_claim', { task: 'write tests' })
  assert.equal(c2.json.result.isError, true)
  assert.match(c2.json.result.content[0].text, /team "Team A" claimed/)
  // A note can't carry control characters or grow without bound, and is attributed by token only.
  await call('tok-b', 5, 'board_post', { note: 'done\nwith\u001b[31m parser ' + 'x'.repeat(1000), team: 'Team A' })
  const read = await call('tok-a', 6, 'board_read')
  const text = read.json.result.content[0].text
  assert.match(text, /from team "Team B"/)
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(text))
  assert.ok(text.length < 1200, `board too long: ${text.length}`)
  console.log('http: ok\n' + text + '\n')

  // stdio bridge
  const child = spawn(process.execPath, [path.join(__dirname, 'board-mcp-stdio.cjs')], {
    env: { ...process.env, AO_BOARD_URL: srv.url, AO_BOARD_TOKEN: 'tok-b' },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const lines = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => {
    buf += c
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
    }
  })
  const t0 = Date.now()
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'board_read', arguments: {} } }) + '\n')
  while (lines.length < 2 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20))
  assert.equal(lines.length, 2)
  assert.match(lines.find((l) => l.id === 2).result.content[0].text, /"Write tests" by team "Team A"/)
  console.log(`stdio: ok (${Date.now() - t0} ms for spawn + initialize + one call)`)
  child.stdin.end()
  await new Promise((r) => child.once('exit', r))
  await srv.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
