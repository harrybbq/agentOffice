// Office-board spike: a Codex command hook. Records that it ran (and what it was given) next to
// itself in logs/, and answers with additionalContext. Used by codex-probe.cjs / codex-turns.cjs.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let input = {}
  try {
    input = JSON.parse(raw)
  } catch {
    // keep {}
  }
  try {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true })
    fs.appendFileSync(path.join(__dirname, 'logs', 'codex-hook-probe.log'), JSON.stringify({ t: Date.now(), input }) + '\n')
  } catch {
    // evidence only
  }
  const event = input.hook_event_name || 'PreToolUse'
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: event === 'UserPromptSubmit' ? 'OFFICE BOARD (hook): team "Team Hook" is rewriting the parser. Code word: UPS-PINEAPPLE.' : 'OFFICE BOARD (hook): team "Team Hook" edited this file 3 minutes ago. Code word: PRE-PAPAYA.'
      }
    })
  )
})
