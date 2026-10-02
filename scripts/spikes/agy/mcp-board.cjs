#!/usr/bin/env node
// Phase C spike: the smallest possible MCP server over stdio (newline-delimited JSON-RPC), standing in
// for the planned "office board" tools. One tool, `board_post`. Every message is appended to
// AO_MCP_LOG when set, so the harness can see whether agy started the server and what it called.
'use strict'
const fs = require('node:fs')

const logFile = process.env.AO_MCP_LOG
const note = (dir, msg) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), dir, msg }) + '\n')
}
const send = (msg) => {
  note('->', msg)
  process.stdout.write(JSON.stringify(msg) + '\n')
}

note('--', { started: process.pid, cwd: process.cwd(), env: Object.keys(process.env).filter((k) => /^(ANTIGRAVITY_|AGY_|AO_)/.test(k)) })

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
    note('<-', msg)
    if (msg.id === undefined) continue // a notification
    switch (msg.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'office', version: '0.0.0' } } })
        break
      case 'ping':
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
        break
      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'board_post',
                description: 'Posts a short note on the Agent Office board.',
                inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The note.' } }, required: ['text'] }
              }
            ]
          }
        })
        break
      case 'tools/call':
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `posted: ${String(msg.params?.arguments?.text ?? '')}` }], isError: false } })
        break
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
