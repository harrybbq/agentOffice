#!/usr/bin/env node
// A stand-in for Google's Antigravity CLI (`agy`) for the tests and for driving the UI without a
// model: the same command line, the same stream-json protocol on stdio, and the same way of running
// hooks (the command from `<add-dir>/.agents/hooks.json`, through `cmd /c` on Windows with that
// folder as the working directory, the payload on stdin, the answer on stdout). Shapes are the
// ones recorded in docs/spikes-phase-c.md. No model: a prompt is a little script.
//
//   node fake-agy.cjs models | --version | -p /usage … | -p /hooks … --add-dir <dir>
//   node fake-agy.cjs --input-format stream-json --output-format stream-json --add-dir <dir> [--model m]
//                     [--conversation <id>] [--dangerously-skip-permissions] …
//
// A prompt, one directive per line (anything else is ignored):
//   run: <command>                 run_command (output "out:<command>"; `sleep <ms>` really waits)
//   child: <ms>                    run_command that starts a real child process living <ms> (its pid -> <home>/child.pid)
//   write: <path>|<content>        write_to_file (really writes; `\n` in the content is a line break)
//   replace: <path>|<old>|<new>    replace_file_content (really edits)
//   read: <path>                   view_file
//   web: <url>                     read_url_content
//   mcp: <server>|<tool>|<json>    call_mcp_tool (really calls the server of <add-dir>/.agents/mcp_config.json)
//   tool: <name>|<json args>       any other tool
//   say: <text>                    the final answer (default: a JSON summary, see below)
// The default final answer is JSON: {results:[…], injected:[…], history:[first lines of earlier prompts]}.
//
// State (conversations, a log of flagged spawns, what ran without a gate) lives under FAKE_AGY_HOME.
// Switches: FAKE_AGY_LOGGED_OUT=1 or a file <home>/logged-out; FAKE_AGY_NO_HOOKS=1 or a file
// <home>/no-hooks (the `/hooks` answer lists nothing); <home>/usage (remaining fraction).
'use strict'
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const HOME = process.env.FAKE_AGY_HOME || path.join(require('node:os').tmpdir(), 'fake-agy-home')
fs.mkdirSync(path.join(HOME, 'conversations'), { recursive: true })
const has = (name) => fs.existsSync(path.join(HOME, name))
const flag = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const values = (name) => argv.map((a, i) => (a === name ? argv[i + 1] : null)).filter(Boolean)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const note = (file, obj) => fs.appendFileSync(path.join(HOME, file), JSON.stringify(obj) + '\n')

const loggedOut = process.env.FAKE_AGY_LOGGED_OUT === '1' || has('logged-out')
const MODELS = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)']
]
const TOOLS = ['call_mcp_tool', 'find_by_name', 'grep_search', 'invoke_subagent', 'list_dir', 'read_url_content', 'replace_file_content', 'run_command', 'search_web', 'view_file', 'write_to_file']

// ---- hooks ------------------------------------------------------------------------------------------

/** Every hooks.json agy would load: the working folder's and each --add-dir's. */
function hookFiles() {
  return [process.cwd(), ...values('--add-dir')].map((dir) => path.join(dir, '.agents', 'hooks.json')).filter((f) => fs.existsSync(f))
}

function loadHooks() {
  const found = []
  for (const file of hookFiles()) {
    let json
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const [name, spec] of Object.entries(json)) {
      if (!spec || typeof spec !== 'object' || spec.enabled === false) continue
      const actions = []
      for (const [event, list] of Object.entries(spec)) {
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          if (Array.isArray(entry.hooks)) for (const h of entry.hooks) actions.push({ event, matcher: entry.matcher ?? '*', type: h.type, command: h.command, timeout_seconds: h.timeout ?? 30 })
          else actions.push({ event, type: entry.type, command: entry.command, timeout_seconds: entry.timeout ?? 30 })
        }
      }
      found.push({ name, enabled: true, source: file, actions })
    }
  }
  return found
}

/** Runs one hook command the way agy does. Resolves {ok, answer} or {ok:false, error}. */
function runHook(hook, action, payload, conversationId) {
  return new Promise((resolve) => {
    const cwd = path.dirname(hook.source)
    const win = process.platform === 'win32'
    const child = spawn(win ? 'cmd' : 'sh', [win ? '/c' : '-c', action.command], {
      cwd,
      env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: conversationId },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
    const timer = setTimeout(() => child.kill(), action.timeout_seconds * 1000)
    child.on('error', (err) => resolve({ ok: false, error: `command failed: ${err.message}` }))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve({ ok: false, error: `command failed: exit status ${code}, stderr: ${stderr.trim()}` })
      try {
        resolve({ ok: true, answer: JSON.parse(stdout) })
      } catch {
        resolve({ ok: false, error: 'hook output is not JSON' })
      }
    })
  })
}

// ---- one-shot commands ------------------------------------------------------------------------------

function printMode() {
  const prompt = value('-p') ?? value('--print') ?? value('--prompt') ?? ''
  const base = { conversation_id: '', status: 'SUCCESS', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } }
  if (prompt === '/usage') {
    let remaining = 0.9
    try {
      remaining = Number(fs.readFileSync(path.join(HOME, 'usage'), 'utf8'))
    } catch {
      // default
    }
    note('usage-calls.log', { at: Date.now() })
    out({
      ...base,
      response: `Gemini Models\tWeekly Limit Remaining\t${Math.round(remaining * 100)}%\t2026-10-09T14:46:26Z\n`,
      command: {
        name: 'usage',
        data: {
          groups: [
            { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: remaining, reset_time: '2026-10-09T14:46:26Z' }] },
            { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-09T14:50:05Z' }] }
          ]
        }
      }
    })
    return process.exit(0)
  }
  if (prompt === '/hooks') {
    const hooks = process.env.FAKE_AGY_NO_HOOKS === '1' || has('no-hooks') ? [] : loadHooks()
    note('hooks-probes.log', { at: Date.now(), cwd: process.cwd(), addDir: values('--add-dir') })
    out({ ...base, response: hooks.map((h) => h.actions.map((a) => `${h.name}\tenabled\t${a.event}\t${a.matcher ?? '-'}\tcommand\t${a.command}`).join('\n')).join('\n'), command: { name: 'hooks', data: { hooks } } })
    return process.exit(0)
  }
  // Anything else in print mode would be a real model turn: the tests must never get here.
  note('print-turns.log', { prompt })
  process.stderr.write('fake-agy: a print-mode prompt would have been a model turn\n')
  process.exit(3)
}

// ---- conversations ----------------------------------------------------------------------------------

const convFile = (id) => path.join(HOME, 'conversations', `${id}.json`)
function loadConversation(id) {
  try {
    return JSON.parse(fs.readFileSync(convFile(id), 'utf8'))
  } catch {
    return null
  }
}
const saveConversation = (c) => fs.writeFileSync(convFile(c.id), JSON.stringify(c))

// ---- the MCP server of the session folder -----------------------------------------------------------

function callMcp(server, tool, args) {
  return new Promise((resolve) => {
    let config = null
    for (const dir of values('--add-dir')) {
      try {
        config = JSON.parse(fs.readFileSync(path.join(dir, '.agents', 'mcp_config.json'), 'utf8')).mcpServers[server] ?? config
      } catch {
        // none here
      }
    }
    if (!config) return resolve({ error: `MCP server "${server}" is not configured` })
    const child = spawn(config.command, config.args ?? [], { cwd: process.cwd(), env: { ...process.env, ...(config.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ error: 'the MCP server did not answer' })
    }, 10_000)
    child.on('error', (err) => resolve({ error: err.message }))
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n')
        if (msg.id === 2) {
          clearTimeout(timer)
          child.stdin.end()
          const text = msg.result?.content?.map((c) => c.text).join('\n')
          resolve(msg.error || msg.result?.isError ? { error: msg.error?.message ?? text ?? 'tool error' } : { output: text ?? '' })
        }
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'antigravity-client', version: 'v1.0.0' } } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  })
}

// ---- a session --------------------------------------------------------------------------------------

async function streamSession() {
  const skip = flag('--dangerously-skip-permissions')
  if (skip) note('flagged-spawns.log', { at: Date.now(), cwd: process.cwd(), addDir: values('--add-dir'), conversation: value('--conversation') ?? null })
  if (loggedOut) {
    process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n")
    return process.exit(1)
  }
  const asked = value('--conversation')
  let conv = asked ? loadConversation(asked) : null
  if (asked && !conv) process.stderr.write(`warning: conversation "${asked}" not found\n`)
  if (!conv) conv = { id: crypto.randomUUID(), steps: 0, turns: 0, prompts: [] }
  saveConversation(conv)
  const workspace = [process.cwd(), ...values('--add-dir')].map((p) => p.replace(/\\/g, '/'))
  const model = value('--model')
  await sleep(Number(process.env.FAKE_AGY_INIT_MS ?? 30))
  out({ event: 'init', conversation_id: conv.id, init: { ...(model ? { model } : {}), cwd: process.cwd(), tools: TOOLS, permission_mode: skip ? 'always-proceed' : 'request-review' } })

  const step = (fields) => out({ event: 'step_update', step_update: { conversation_id: conv.id, ...fields } })
  const common = () => ({ conversationId: conv.id, workspacePaths: workspace, transcriptPath: `~/.gemini/antigravity-cli/brain/${conv.id}/.system_generated/logs/transcript_full.jsonl`, artifactDirectoryPath: `~/.gemini/antigravity-cli/brain/${conv.id}`, modelName: model ?? 'gemini-3.8-flash-high' })
  const hooksFor = (event) => loadHooks().flatMap((h) => h.actions.filter((a) => a.event === event && a.type === 'command').map((a) => ({ hook: h, action: a })))

  async function turn(text) {
    const lines = text.split('\n').map((l) => l.trim())
    const script = lines.filter((l) => /^(run|child|write|replace|read|web|mcp|tool|say):/.test(l))
    const results = []
    const injected = []
    let say = null
    let invocation = 0
    step({ step_index: conv.steps++, state: 'DONE', step_type: 'user_input' })

    /** Before each model call. Injected user messages may add directives to the script. */
    const preInvocation = async () => {
      for (const { hook, action } of hooksFor('PreInvocation')) {
        const r = await runHook(hook, action, { ...common(), invocationNum: invocation, initialNumSteps: conv.steps }, conv.id)
        for (const s of r.ok && Array.isArray(r.answer.injectSteps) ? r.answer.injectSteps : []) {
          if (typeof s.ephemeralMessage === 'string') {
            injected.push(s.ephemeralMessage)
            step({ step_index: conv.steps++, state: 'DONE', step_type: 'unknown', duration_seconds: 0 })
          } else if (typeof s.userMessage === 'string') {
            injected.push(`user:${s.userMessage}`)
            step({ step_index: conv.steps++, state: 'DONE', step_type: 'user_input' })
            script.push(...s.userMessage.split('\n').map((l) => l.trim()).filter((l) => /^(run|child|write|replace|read|web|mcp|tool|say):/.test(l)))
          }
        }
      }
      invocation++
    }

    while (script.length > 0) {
      await preInvocation()
      const line = script.shift()
      if (line === undefined) break
      const kind = line.slice(0, line.indexOf(':'))
      const rest = line.slice(line.indexOf(':') + 1).trim()
      if (kind === 'say') {
        say = rest
        continue
      }
      const parts = rest.split('|')
      let name
      let args
      let shown
      let perform
      if (kind === 'run' || kind === 'child') {
        const command = kind === 'child' ? `node child ${rest}` : rest
        name = 'run_command'
        args = { CommandLine: command, Cwd: process.cwd(), IsDaemon: false, WaitMsBeforeAsync: 5000, toolAction: 'Running a command', toolSummary: 'Run a command' }
        shown = { CommandLine: command }
        perform = async () => {
          if (kind === 'child') {
            const c = spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${Number(rest) || 1000})`], { stdio: 'ignore', windowsHide: true })
            fs.writeFileSync(path.join(HOME, 'child.pid'), String(c.pid))
            await new Promise((r) => c.on('close', r))
          }
          const m = /^sleep (\d+)$/.exec(command)
          if (m) await sleep(Number(m[1]))
          note('ran.log', { command })
          return { output: `out:${command}\n` }
        }
      } else if (kind === 'write') {
        const file = path.resolve(process.cwd(), parts[0])
        const content = parts.slice(1).join('|').replace(/\\n/g, '\n')
        name = 'write_to_file'
        args = { TargetFile: file, CodeContent: content, Overwrite: fs.existsSync(file), Description: 'Write a file', toolAction: 'Writing a file', toolSummary: 'Write a file' }
        shown = { TargetFile: file }
        perform = async () => {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, content)
          return { output: '' }
        }
      } else if (kind === 'replace') {
        const file = path.resolve(process.cwd(), parts[0])
        name = 'replace_file_content'
        args = { TargetFile: file, TargetContent: parts[1] ?? '', ReplacementContent: parts[2] ?? '', StartLine: 1, EndLine: 1 }
        shown = { TargetFile: file }
        perform = async () => {
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(parts[1] ?? '', parts[2] ?? ''))
          return { output: '' }
        }
      } else if (kind === 'read') {
        const file = path.resolve(process.cwd(), parts[0])
        name = 'view_file'
        args = { AbsolutePath: file }
        shown = args
        perform = async () => {
          try {
            return { output: fs.readFileSync(file, 'utf8') }
          } catch (err) {
            return { error: err.message }
          }
        }
      } else if (kind === 'web') {
        name = 'read_url_content'
        args = { Url: rest }
        shown = args
        perform = async () => ({ output: `page:${rest}` })
      } else if (kind === 'mcp') {
        let input = {}
        try {
          input = JSON.parse(parts.slice(2).join('|') || '{}')
        } catch {
          // {}
        }
        name = 'call_mcp_tool'
        args = { ServerName: parts[0], ToolName: parts[1], Arguments: input }
        shown = args
        perform = () => callMcp(parts[0], parts[1], input)
      } else {
        let input = {}
        try {
          input = JSON.parse(parts.slice(1).join('|') || '{}')
        } catch {
          // {}
        }
        name = parts[0]
        args = input
        shown = input
        perform = async () => ({ output: `did:${name}` })
      }

      // The model call that asks for the tool, then the tool step.
      step({ step_index: conv.steps++, state: 'DONE', step_type: 'agent_response', duration_seconds: 0.01, usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 } })
      const index = conv.steps++
      const t0 = Date.now()
      const info = { name, parameters: shown }
      step({ step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: info })
      const fail = (message) => {
        results.push({ tool: name, refused: message })
        step({ step_index: index, state: 'ERROR', step_type: 'tool', tool_name: name, duration_seconds: (Date.now() - t0) / 1000, tool_info: { ...info, error: { type: 'TOOL_ERROR', message } } })
      }
      const gates = hooksFor('PreToolUse')
      let blocked = false
      for (const { hook, action } of gates) {
        const r = await runHook(hook, action, { ...common(), stepIdx: index, toolCall: { name, args } }, conv.id)
        if (!r.ok) {
          fail(`JSON hook "jsonhook__${hook.name}_PreToolUse_0_0" failed: ${r.error}`)
          blocked = true
        } else if (r.answer.decision !== 'allow') {
          fail(`tool call denied by pre-tool hook: ${r.answer.reason ?? ''}`.trim())
          blocked = true
        }
        if (blocked) break
      }
      if (blocked) continue
      if (gates.length === 0) {
        if (!skip && name === 'run_command') {
          // Headless without the flag and without a hook: the soft-deny, and the turn ends there.
          fail(`permission check failed for command "${args.CommandLine}": user denied permission to run command`)
          process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n')
          conv.turns++
          saveConversation(conv)
          return out({ event: 'result', result: { conversation_id: conv.id, status: 'SUCCESS', response: '', num_turns: conv.turns, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } })
        }
        // What the driver must never let happen: a tool that ran with nobody asked.
        note('ungated.log', { tool: name, args })
      }
      const done = await perform()
      if (done.error) fail(done.error)
      else {
        results.push({ tool: name, output: done.output })
        step({ step_index: index, state: 'DONE', step_type: 'tool', tool_name: name, duration_seconds: (Date.now() - t0) / 1000, tool_info: { ...info, output: done.output } })
      }
    }

    // The final answer, as text deltas.
    await preInvocation()
    while (script.length > 0) {
      const line = script.shift()
      if (line.startsWith('say:')) say = line.slice(4).trim()
    }
    const answer = say ?? JSON.stringify({ results, injected, history: conv.prompts })
    const index = conv.steps++
    const third = Math.ceil(answer.length / 3)
    step({ step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: answer.slice(0, third) })
    step({ step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: answer.slice(third, 2 * third) })
    step({ step_index: index, state: 'DONE', step_type: 'agent_response', text_delta: `${answer.slice(2 * third)}\n`, duration_seconds: 0.02, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 120 } })
    conv.turns++
    conv.prompts.push(lines[0] ?? '')
    saveConversation(conv)
    out({ event: 'result', result: { conversation_id: conv.id, status: 'SUCCESS', response: `${answer}\n`, duration_seconds: 0.1, num_turns: conv.turns, usage: { input_tokens: 100 * conv.turns, output_tokens: 20 * conv.turns, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 120 * conv.turns } } })
  }

  // One prompt per line, one turn at a time: a line written while a turn runs waits in the pipe.
  let chain = Promise.resolve()
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
      if (msg.event !== 'user') {
        chain = chain.then(() => void process.stderr.write(`warning: ignoring unsupported stream input message event "${msg.event}"\n`))
        continue
      }
      const content = typeof msg.message?.content === 'string' ? msg.message.content : (msg.message?.content ?? []).map((c) => c.text ?? '').join('\n')
      chain = chain.then(() => turn(content)).catch((err) => process.stderr.write(`fake-agy: ${err.stack}\n`))
    }
  })
  process.stdin.on('end', () => void chain.then(() => process.exit(0)))
}

// ---- main -------------------------------------------------------------------------------------------

if (argv[0] === '--version') {
  process.stdout.write('1.2.14\n')
} else if (argv[0] === 'models') {
  process.stderr.write('Fetching available models...\n')
  if (loggedOut) {
    process.stderr.write('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n')
    process.exit(1)
  }
  note('models-calls.log', { at: Date.now() })
  process.stdout.write(MODELS.map((m) => m.join('\t')).join('\n') + '\n')
} else if (argv.includes('-p') || argv.includes('--print') || argv.includes('--prompt')) {
  printMode()
} else if (value('--input-format') === 'stream-json' && value('--output-format') === 'stream-json') {
  streamSession()
} else {
  process.stderr.write('fake-agy: unsupported invocation\n')
  process.exit(2)
}
