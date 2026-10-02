// Phase C (main process): the Antigravity driver on Google's `agy` CLI.
// The pure parts (the hook policy, the stream mapping) are tested with the JSON recorded in
// docs/spikes-phase-c.md; the hook script runs against a local HTTP server; the driver and the
// session manager run against tests/fixtures/fake-agy.cjs (same command line, same stream-json
// protocol, and it runs the hook command the way agy does). No real agy and no model turn is used
// here: see scripts/e2e-phase-c.cjs for that.
// Run: npm test   (chained from codex.test.ts)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatEvent, ChatItem } from '../shared/chat.ts'
import type { AgentEvent } from '../shared/events.ts'
import { friendlyModelName } from '../shared/models.ts'
import type { BoardSettings } from '../shared/board.ts'
import type { PermissionMode, PermissionRequestInfo, SessionInfo } from '../shared/sessions.ts'
import { Board, DEFAULT_BOARD_SETTINGS } from '../electron/board.ts'
import { BOARD_MCP_ROUTE, boardMcpRoute } from '../electron/boardMcp.ts'
import { folderProject } from '../electron/boardProject.ts'
import {
  AGY_CONVERSATION_GONE,
  AGY_DEFAULT_MODEL,
  AGY_HOOKS_NOT_LOADED,
  AGY_LOGIN_INSTRUCTION,
  AGY_QUEUED_NOTE,
  AGY_STEERED_NOTE,
  AGY_TAMPERED,
  agyEnv,
  agyGateLoaded,
  agyHookCommand,
  agyHooksConfig,
  agyProvider,
  buildAgySessionFolder,
  cheapestAgyModel,
  hashAgySessionFiles,
  parseAgyModels,
  parseAgyUsage,
  sweepAgySessions
} from '../electron/drivers/agy.ts'
import { createAgyHooksAdapter } from '../electron/drivers/agyHookBridge.ts'
import { agyPathArgs, agyPolicy, agyToolClass, flattenForPathSearch, PLAN_DENY_REASON, PROTECTED_DENY_REASON, SUBAGENT_DENY_REASON, type AgyPolicyInput } from '../electron/drivers/agyPolicy.ts'
import { AgyChat, agyCommandIntent, agyFileChange, agyWorldActivity, parseAgyLine, replacedFileDiff } from '../electron/drivers/agyStream.ts'
import { officeBriefing } from '../electron/drivers/briefing.ts'
import type { PtyHost } from '../electron/drivers/types.ts'
import { AGY_HOOK_ROUTE, authenticate, authorise, SessionTokens } from '../electron/ingest/auth.ts'
import { startIngestServer } from '../electron/ingest/server.ts'
import { DEFAULT_DENY_MESSAGE } from '../electron/permissions.ts'
import { CONVERSATION_GONE, SessionManager } from '../electron/sessions.ts'
import { SessionStore } from '../electron/sessionStore.ts'
import { parseDiff } from '../src/ui/chat/diff.ts'
import { modeHints, modelPlaceholder, orderTargets } from '../src/ui/format.ts'

let pass = 0
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn()
  pass++
  console.log('ok -', name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(cond: () => T, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = cond()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

const FAKE = fileURLToPath(new URL('./fixtures/fake-agy.cjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../hook/agy-hook.cjs', import.meta.url))
const BRIDGE = fileURLToPath(new URL('../hook/agy-board-mcp.cjs', import.meta.url))
const SPIKE_LOGS = fileURLToPath(new URL('../scripts/spikes/agy/logs/', import.meta.url))

// ---- names, parsing, the session folder ---------------------------------------------------------------

await t('model names: Gemini ids lose their effort suffix; unknown ids stay as they are', () => {
  assert.equal(friendlyModelName('gemini-3.8-flash-low'), 'Gemini 3.8 Flash')
  assert.equal(friendlyModelName('gemini-3.8-flash-high'), 'Gemini 3.8 Flash')
  assert.equal(friendlyModelName('gemini-3.1-pro-low'), 'Gemini 3.1 Pro')
  assert.equal(friendlyModelName('gemini-3.6-flash'), 'Gemini 3.6 Flash')
  assert.equal(friendlyModelName('claude-sonnet-4-6'), 'Sonnet 4.6')
  assert.equal(friendlyModelName('gpt-oss-120b-medium'), 'gpt-oss-120b-medium')
  assert.equal(friendlyModelName('gemini-next'), 'gemini-next')
})

await t('agy models / usage / hooks answers (the real output recorded in the spikes)', () => {
  const models = parseAgyModels('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\nFetching…\n')
  assert.deepEqual(models.map((m) => m.id), ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-opus-4-6-thinking'])
  assert.equal(cheapestAgyModel(models), AGY_DEFAULT_MODEL)
  assert.equal(AGY_DEFAULT_MODEL, 'gemini-3.8-flash-low')
  assert.equal(cheapestAgyModel([{ id: 'gemini-4-flash-high' }, { id: 'gemini-4-flash-low' }]), 'gemini-4-flash-low')
  assert.equal(cheapestAgyModel([{ id: 'x-pro' }]), 'x-pro')
  assert.equal(cheapestAgyModel([]), AGY_DEFAULT_MODEL)

  const usage =
    '{"conversation_id":"","status":"SUCCESS","response":"…","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.9824175834655762,"reset_time":"2026-10-09T14:46:26Z"}]},{"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-10-09T14:50:05Z"}]}]}}}'
  assert.deepEqual(parseAgyUsage(usage), { usedPercent: 1.8, resetsAt: Date.parse('2026-10-09T14:46:26Z'), windowMinutes: 10080 })
  assert.equal(parseAgyUsage('not json'), null)
  assert.equal(parseAgyUsage('{"command":{"data":{"groups":[]}}}'), null)

  // `agy -p /hooks --output-format json`, as recorded (with the app's own names in it).
  const file = 'C:\\Users\\H\\AppData\\Roaming\\agent-office\\agy-sessions\\s-1\\.agents\\hooks.json'
  const answer = (over: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => ({
    command: {
      name: 'hooks',
      data: {
        hooks: [
          {
            name: 'agent-office',
            enabled: true,
            source: file,
            actions: [
              { event: 'PreInvocation', type: 'command', command: 'node agy-hook.cjs PreInvocation', timeout_seconds: 10 },
              { event: 'PreToolUse', matcher: '*', type: 'command', command: 'node agy-hook.cjs PreToolUse', timeout_seconds: 3600, ...action }
            ],
            ...over
          }
        ]
      }
    }
  })
  assert.equal(agyGateLoaded(answer(), file), true)
  assert.equal(agyGateLoaded(answer(), file.toUpperCase().replace(/\\/g, '/')), process.platform === 'win32')
  assert.equal(agyGateLoaded(answer({ enabled: false }), file), false)
  assert.equal(agyGateLoaded(answer({ source: 'C:\\project\\.agents\\hooks.json' }), file), false) // somebody else's hook of the same name
  assert.equal(agyGateLoaded(answer({ name: 'other' }), file), false)
  assert.equal(agyGateLoaded(answer({}, { command: 'node other.cjs PreToolUse' }), file), false)
  assert.equal(agyGateLoaded(answer({}, { matcher: 'run_command' }), file), false) // only some tools gated
  assert.equal(agyGateLoaded(answer({}, { event: 'PostToolUse' }), file), false)
  assert.equal(agyGateLoaded({ command: { data: { hooks: [] } } }, file), false)
  assert.equal(agyGateLoaded(null, file), false)
})

await t('the session folder: hooks.json without a double quote, no secret in any file, a hash that notices changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao agy folder-'))
  const dir = join(root, 's-1')
  const folder = buildAgySessionFolder({ dir, hookScript: HOOK, boardScript: BRIDGE })
  const hooks = readFileSync(folder.hooksFile, 'utf8')
  assert.deepEqual(JSON.parse(hooks), agyHooksConfig())
  // Windows: agy hands the command to `cmd /c` with inner quotes escaped, so a quoted path breaks.
  for (const event of ['PreToolUse', 'PreInvocation'] as const) assert.ok(!agyHookCommand(event).includes('"') && !/[\\/]/.test(agyHookCommand(event)))
  assert.deepEqual(Object.keys(agyHooksConfig()['agent-office'] as object), ['PreToolUse', 'PreInvocation'])
  assert.equal(readFileSync(join(dir, '.agents', 'agy-hook.cjs'), 'utf8'), readFileSync(HOOK, 'utf8'))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.agents', 'mcp_config.json'), 'utf8')), {
    mcpServers: { agent_office: { command: 'node', args: [join(dir, '.agents', 'agy-board-mcp.cjs')] } }
  })
  assert.deepEqual(folder.files.map((f) => f.replace(/\\/g, '/')), ['.agents/hooks.json', '.agents/agy-hook.cjs', '.agents/mcp_config.json', '.agents/agy-board-mcp.cjs'])
  for (const f of folder.files) assert.ok(!/token|bearer [0-9a-f]{16}/i.test(readFileSync(join(dir, f), 'utf8').replace(/AO_(AGY|BOARD)_TOKEN|x-agent-office-token|never print the token|board token|no token|the token|const token|token\b/gi, '')), f)
  // The hash follows every gate file.
  assert.equal(hashAgySessionFiles(dir, folder.files), folder.hash)
  writeFileSync(join(dir, '.agents', 'agy-hook.cjs'), "process.stdout.write('{\"decision\":\"allow\"}')")
  assert.notEqual(hashAgySessionFiles(dir, folder.files), folder.hash)
  const again = buildAgySessionFolder({ dir, hookScript: HOOK, boardScript: BRIDGE })
  assert.equal(again.hash, folder.hash)
  rmSync(join(dir, '.agents', 'hooks.json'))
  assert.notEqual(hashAgySessionFiles(dir, folder.files), folder.hash)
  // Without the board there is no MCP config (and a leftover one is removed).
  const plain = buildAgySessionFolder({ dir, hookScript: HOOK })
  assert.equal(existsSync(join(dir, '.agents', 'mcp_config.json')), false)
  assert.equal(plain.files.length, 2)
  // Leftovers of a crash are swept at launch.
  sweepAgySessions(root)
  assert.deepEqual(readdirSync(root), [])
  sweepAgySessions(join(root, 'missing'))
  rmSync(root, { recursive: true, force: true })
})

await t('the environment of a hosted agy: no parent-agent variables, no stale tokens, the updater off', () => {
  const env = agyEnv(
    { PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_X: 'y', AI_AGENT: 'a', CODEX_HOME: 'c', GEMINI_API_KEY: 'k', GOOGLE_GEMINI_BASE_URL: 'u', AGY_ADC_AUTH: '1', ANTIGRAVITY_X: 'x', AO_AGY_TOKEN: 'old', AO_BOARD_TOKEN: 'old', APPDATA: 'r', undef: undefined },
    { AO_AGY_TOKEN: 'new' }
  )
  assert.deepEqual(env, { PATH: 'p', APPDATA: 'r', AGY_CLI_DISABLE_AUTO_UPDATE: 'true', AO_AGY_TOKEN: 'new' })
})

await t('briefing: Antigravity is told about the inbox, the second workspace folder, its mode and the board', () => {
  const plain = officeBriefing('antigravity', { title: 'Gemini 3.8 Flash', mode: 'default', cwd: 'C:\\work\\proj' })
  // Where to work comes first: agy lists the app's session folder as a workspace too.
  assert.match(plain, /- The project folder, and your working folder, is C:\\work\\proj \. Run every command there/)
  assert.match(plain, /never use it as the working directory of a command/)
  assert.match(plain, /This Antigravity session was started from Agent Office/)
  assert.match(plain, /CEO inbox/)
  assert.match(plain, /agy-sessions/)
  assert.match(plain, /asks the user before every command and every file change/)
  assert.ok(!/board_read/.test(plain))
  const plan = officeBriefing('antigravity', { title: 'x', mode: 'plan', board: true })
  assert.match(plan, /plan mode: it is read-only/)
  assert.match(plan, /board_read, board_claim, board_post, board_release and board_handover \(MCP server "agent_office"\)/)
  assert.match(officeBriefing('antigravity', { title: 'x', mode: 'acceptEdits' }), /file edits inside the project folder go through without asking/)
  for (const text of [plain, plan]) {
    assert.ok(text.length < 3500, String(text.length))
    assert.ok(!/token|127\.0\.0\.1|http:/i.test(text))
  }
  // The other providers' texts did not change shape.
  assert.ok(!/agy-sessions/.test(officeBriefing('codex', { title: 'x' })))
})

// ---- the policy table ---------------------------------------------------------------------------------

const CWD = 'C:\\work\\proj'
const USER_DATA = 'C:\\Users\\Harry\\AppData\\Roaming\\agent-office'
const SESSION_DIR = `${USER_DATA}\\agy-sessions\\s-abc123`
const ENV = { APPDATA: 'C:\\Users\\Harry\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Harry\\AppData\\Local', USERPROFILE: 'C:\\Users\\Harry', TEMP: 'C:\\Users\\Harry\\AppData\\Local\\Temp' }
const policy = (tool: string, args: unknown, mode: PermissionMode = 'default', over: Partial<AgyPolicyInput> = {}) =>
  agyPolicy({ tool, args, mode, cwd: CWD, protectedPaths: [USER_DATA, SESSION_DIR], who: 'Gemini', env: ENV, platform: 'win32', ...over })
const act = (tool: string, args: unknown, mode: PermissionMode = 'default', over: Partial<AgyPolicyInput> = {}): string => policy(tool, args, mode, over).action
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan']

await t('policy: tool classes', () => {
  const cls = (tool: string, args?: unknown) => agyToolClass(tool, args)
  assert.deepEqual(['run_command', 'send_command_input', 'notebook_execution'].map((x) => cls(x)), ['command', 'command', 'command'])
  assert.deepEqual(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit', 'generate_image'].map((x) => cls(x)), Array(6).fill('write'))
  assert.deepEqual(['view_file', 'list_dir', 'find_by_name', 'grep_search'].map((x) => cls(x)), Array(4).fill('read'))
  assert.deepEqual(['search_web', 'read_url_content'].map((x) => cls(x)), ['web', 'web'])
  assert.deepEqual(['open_browser_url', 'browser_click_element', 'capture_browser_screenshot', 'execute_browser_javascript', 'click_browser_pixel'].map((x) => cls(x)), Array(5).fill('browser'))
  assert.deepEqual(['invoke_subagent', 'browser_subagent', 'manage_subagents', 'run_workflow', 'schedule'].map((x) => cls(x)), Array(5).fill('delegate'))
  assert.deepEqual(['finish', 'wait', 'wait_5_seconds', 'command_status', 'ask_question'].map((x) => cls(x)), Array(5).fill('passive'))
  assert.deepEqual(['ask_permission', 'ask_custom_permission'].map((x) => cls(x)), ['request', 'request'])
  assert.deepEqual(['manage_inbox', 'send_message', 'delete_knowledge', 'some_future_tool', ''].map((x) => cls(x)), Array(5).fill('unknown'))
  assert.equal(cls('call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue' }), 'mcp')
  assert.equal(cls('call_mcp_tool', { ServerName: 'agent_office', ToolName: 'board_read' }), 'board')
  assert.equal(cls('call_mcp_tool', { ServerName: 'agent_office', ToolName: 'delete_everything' }), 'mcp') // not one of the five
  assert.equal(cls('call_mcp_tool', { ServerName: 'agent-office-evil', ToolName: 'board_read' }), 'mcp')
  assert.deepEqual(agyPathArgs({ TargetFile: 'a', CodeContent: 'C:\\x', AbsolutePath: 'b', DirectoryPath: 'c', SearchDirectory: 'd', SearchPath: 'e', Cwd: 'f', TargetContent: 'no', Query: 'no' }), ['a', 'b', 'c', 'd', 'e', 'f'])
})

await t('policy: every mode x tool class', () => {
  const inside = `${CWD}\\src\\app.ts`
  const table: Array<[string, string, unknown, [string, string, string]]> = [
    // what, tool, args, [default, acceptEdits, plan]
    ['command', 'run_command', { CommandLine: 'npm test', Cwd: CWD }, ['ask', 'ask', 'deny']],
    ['read-only command', 'run_command', { CommandLine: 'git status', Cwd: CWD }, ['ask', 'ask', 'deny']],
    ['input to a command', 'send_command_input', { CommandId: '1', Input: 'y' }, ['ask', 'ask', 'deny']],
    ['create a file', 'write_to_file', { TargetFile: inside, CodeContent: 'x', Overwrite: false }, ['ask', 'allow', 'deny']],
    ['edit a file', 'replace_file_content', { TargetFile: inside, TargetContent: 'a', ReplacementContent: 'b' }, ['ask', 'allow', 'deny']],
    ['multi edit', 'multi_replace_file_content', { TargetFile: inside, ReplacementChunks: [] }, ['ask', 'allow', 'deny']],
    // A relative path: which of agy's two workspaces it would be resolved against is not known.
    ['edit by a relative path', 'replace_file_content', { TargetFile: 'src\\app.ts', TargetContent: 'a', ReplacementContent: 'b' }, ['ask', 'ask', 'deny']],
    ['a file tool that names no file', 'generate_image', { Prompt: 'a cat' }, ['ask', 'ask', 'deny']],
    ['read a file', 'view_file', { AbsolutePath: inside }, ['allow', 'allow', 'allow']],
    ['list a folder', 'list_dir', { DirectoryPath: CWD }, ['allow', 'allow', 'allow']],
    ['search', 'grep_search', { SearchPath: CWD, Query: 'TODO' }, ['allow', 'allow', 'allow']],
    ['find', 'find_by_name', { SearchDirectory: 'src', Pattern: '*.ts' }, ['allow', 'allow', 'allow']],
    ['web search', 'search_web', { query: 'node 24' }, ['ask', 'ask', 'ask']],
    ['web page', 'read_url_content', { Url: 'https://example.com' }, ['ask', 'ask', 'ask']],
    ['browser', 'open_browser_url', { Url: 'https://example.com' }, ['ask', 'ask', 'ask']],
    ['browser action', 'browser_click_element', { Selector: '#buy' }, ['ask', 'ask', 'ask']],
    ['another MCP server', 'call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue', Arguments: {} }, ['ask', 'ask', 'ask']],
    ['MCP resource', 'read_resource', { ServerName: 'github', Uri: 'x' }, ['ask', 'ask', 'ask']],
    ['the office board', 'call_mcp_tool', { ServerName: 'agent_office', ToolName: 'board_post', Arguments: { note: 'hi' } }, ['allow', 'allow', 'allow']],
    ['more access', 'ask_permission', { Action: 'command', Target: 'git push', Reason: 'r' }, ['ask', 'ask', 'ask']],
    ['sub-agent', 'invoke_subagent', { Subagents: [{ Prompt: 'x' }] }, ['deny', 'deny', 'deny']],
    ['schedule', 'schedule', { When: 'later' }, ['deny', 'deny', 'deny']],
    ['passive', 'command_status', { CommandId: '1' }, ['allow', 'allow', 'allow']],
    ['finish', 'finish', {}, ['allow', 'allow', 'allow']],
    ['unknown tool', 'some_future_tool', { x: 1 }, ['ask', 'ask', 'ask']],
    ['unknown tool without arguments', 'manage_inbox', null, ['ask', 'ask', 'ask']]
  ]
  for (const [what, tool, args, want] of table) {
    assert.deepEqual(MODES.map((m) => act(tool, args, m)), want, what)
  }
  // The reasons a model reads.
  const plan = policy('run_command', { CommandLine: 'npm test' }, 'plan')
  assert.deepEqual(plan, { action: 'deny', cls: 'command', reason: PLAN_DENY_REASON })
  assert.match(PLAN_DENY_REASON, /^plan mode: read-only/)
  const sub = policy('invoke_subagent', {})
  assert.equal(sub.action === 'deny' && sub.reason, SUBAGENT_DENY_REASON)
})

await t('policy: what the card says (plainPermission), and what raises its risk', () => {
  const card = (tool: string, args: unknown, mode: PermissionMode = 'default') => {
    const v = policy(tool, args, mode)
    assert.equal(v.action, 'ask', `${tool} ${JSON.stringify(args)}`)
    return v.action === 'ask' ? v.card : (undefined as never)
  }
  let c = card('run_command', { CommandLine: 'npm test', Cwd: CWD })
  assert.deepEqual([c.toolName, c.summary, c.plain.question, c.plain.risk], ['Command', 'Command: npm test', 'Gemini wants to run the tests (`npm test`).', 'normal'])
  assert.equal(c.detail, `npm test\n\nin ${CWD}`)
  c = card('run_command', { CommandLine: 'Remove-Item -Recurse dist', Cwd: CWD })
  assert.deepEqual([c.plain.risk, c.plain.riskNote], ['danger', 'Deletes files'])
  c = card('run_command', { CommandLine: 'dir', Cwd: 'C:\\Windows' })
  assert.deepEqual([c.plain.risk, c.plain.riskNote], ['caution', 'Outside the project folder'])
  c = card('write_to_file', { TargetFile: `${CWD}\\notes.txt`, CodeContent: 'hello\n', Overwrite: false })
  assert.deepEqual([c.toolName, c.summary, c.plain.question, c.plain.risk], ['Create', `Create: ${CWD}\\notes.txt`, 'Gemini wants to create the file notes.txt.', 'normal'])
  assert.equal(c.detail, `${CWD}\\notes.txt\n\nhello\n`)
  c = card('write_to_file', { TargetFile: `${CWD}\\notes.txt`, CodeContent: 'x', Overwrite: true })
  assert.deepEqual([c.toolName, c.plain.question], ['Write', 'Gemini wants to write the file notes.txt.'])
  c = card('replace_file_content', { TargetFile: `${CWD}\\a.ts`, TargetContent: 'a', ReplacementContent: 'b' })
  assert.deepEqual([c.toolName, c.plain.question], ['Edit', 'Gemini wants to change the file a.ts.'])
  c = card('call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue', Arguments: { title: 't' } })
  assert.deepEqual([c.toolName, c.summary, c.plain.question], ['mcp', 'MCP: github · create_issue', 'Gemini wants to use the “create issue” tool from github.'])
  c = card('open_browser_url', { Url: 'https://example.com' })
  assert.deepEqual([c.toolName, c.plain.risk, c.plain.riskNote], ['Browser', 'caution', 'Controls your screen'])
  assert.match(c.plain.question, /control or look at your screen\/browser/)
  c = card('search_web', { query: 'node 24 release' })
  assert.deepEqual([c.toolName, c.plain.question, c.plain.risk, c.plain.riskNote], ['WebSearch', 'Gemini wants to search the web for “node 24 release”.', 'caution', 'Uses the internet'])
  c = card('read_url_content', { Url: 'https://example.com/a' })
  assert.deepEqual([c.toolName, c.plain.question, c.plain.risk], ['WebFetch', 'Gemini wants to open the web page example.com.', 'caution'])
  c = card('ask_permission', { Action: 'command', Target: 'git push', Reason: 'to publish' })
  assert.deepEqual([c.toolName, c.plain.risk], ['Permissions', 'caution'])
  c = card('some_future_tool', { x: 1 })
  assert.deepEqual([c.toolName, c.plain.question], ['some_future_tool', 'Gemini wants to use the some_future_tool tool.'])

  // Outside the working folder: asked in every mode, with the existing rating.
  for (const mode of MODES.filter((m) => m !== 'plan')) {
    c = card('write_to_file', { TargetFile: 'C:\\Users\\Harry\\Desktop\\x.txt', CodeContent: 'x' }, mode)
    assert.deepEqual([c.plain.risk, c.plain.riskNote], ['caution', 'Outside the project folder'], mode)
  }
  for (const mode of MODES) {
    c = card('view_file', { AbsolutePath: 'C:\\Users\\Harry\\Desktop\\x.txt' }, mode)
    assert.deepEqual([c.toolName, c.plain.risk, c.plain.riskNote], ['Read', 'caution', 'Outside the project folder'], mode)
    assert.equal(act('view_file', { AbsolutePath: `${CWD}\\..\\other\\x.txt` }, mode), 'ask', mode)
    assert.equal(act('list_dir', { DirectoryPath: 'C:\\' }, mode), 'ask', mode)
  }
  // acceptEdits only lets ordinary edits through: secrets and agent settings still ask.
  assert.equal(act('write_to_file', { TargetFile: `${CWD}\\.env`, CodeContent: 'KEY=1' }, 'acceptEdits'), 'ask')
  c = card('write_to_file', { TargetFile: `${CWD}\\.agents\\hooks.json`, CodeContent: '{}' }, 'acceptEdits')
  assert.deepEqual([c.plain.risk, c.plain.riskNote], ['danger', 'Changes agent settings'])
  assert.equal(act('replace_file_content', { TargetFile: `${CWD}\\.gemini\\settings.json`, TargetContent: 'a', ReplacementContent: 'b' }, 'acceptEdits'), 'ask')
  assert.equal(act('write_to_file', { TargetFile: `${CWD}\\..\\elsewhere\\a.ts`, CodeContent: 'x' }, 'acceptEdits'), 'ask')
  // A secrets file is not read without asking either.
  c = card('view_file', { AbsolutePath: `${CWD}\\.env` })
  assert.deepEqual([c.plain.risk, c.plain.riskNote], ['danger', 'Reads a secrets file'])
  // A command that names an agent's own configuration is marked.
  c = card('run_command', { CommandLine: 'echo {} > .agents\\hooks.json', Cwd: CWD })
  assert.deepEqual([c.plain.risk, c.plain.riskNote], ['danger', 'May change agent settings'])
  // A link inside the project that leads elsewhere counts as elsewhere.
  const linked = (p: string) => (p.toLowerCase().startsWith(`${CWD}\\link`.toLowerCase()) ? `D:\\secret${p.slice(`${CWD}\\link`.length)}` : p)
  assert.equal(act('write_to_file', { TargetFile: `${CWD}\\link\\a.txt`, CodeContent: 'x' }, 'acceptEdits', { realPath: linked }), 'ask')
  assert.equal(act('view_file', { AbsolutePath: `${CWD}\\link\\a.txt` }, 'default', { realPath: linked }), 'ask')
  assert.equal(act('write_to_file', { TargetFile: `${CWD}\\src\\a.txt`, CodeContent: 'x' }, 'acceptEdits', { realPath: linked }), 'allow')
})

await t('policy: the app’s own folders are never touched, however the path is written', () => {
  const denied = (tool: string, args: unknown, mode: PermissionMode = 'default', over: Partial<AgyPolicyInput> = {}) => {
    const v = policy(tool, args, mode, over)
    assert.deepEqual([v.action, v.action === 'deny' && v.reason], ['deny', PROTECTED_DENY_REASON], `${tool} ${JSON.stringify(args)} (${mode})`)
  }
  for (const mode of MODES) {
    // File tools: write, edit, and read (config.json holds the app's ingest token).
    denied('write_to_file', { TargetFile: `${SESSION_DIR}\\.agents\\agy-hook.cjs`, CodeContent: 'allow all', Overwrite: true }, mode)
    denied('replace_file_content', { TargetFile: `${SESSION_DIR}\\.agents\\hooks.json`, TargetContent: 'a', ReplacementContent: 'b' }, mode)
    denied('write_to_file', { TargetFile: `${USER_DATA}\\config.json`, CodeContent: '{}' }, mode)
    denied('view_file', { AbsolutePath: `${USER_DATA}\\config.json` }, mode)
    denied('list_dir', { DirectoryPath: SESSION_DIR }, mode)
    denied('grep_search', { SearchPath: USER_DATA, Query: 'token' }, mode)
    // Other spellings of the same file.
    denied('write_to_file', { TargetFile: `${SESSION_DIR.toUpperCase()}/.AGENTS/HOOKS.JSON`, CodeContent: 'x' }, mode)
    denied('write_to_file', { TargetFile: 'C:/Users/Harry/AppData/Roaming/agent-office/sessions.json', CodeContent: 'x' }, mode)
    denied('write_to_file', { TargetFile: `${CWD}\\..\\..\\Users\\Harry\\AppData\\Roaming\\agent-office\\config.json`, CodeContent: 'x' }, mode)
    denied('write_to_file', { TargetFile: '..\\..\\Users\\Harry\\AppData\\Roaming\\agent-office\\config.json', CodeContent: 'x' }, mode)
    // Commands that mention it, with every quoting trick a shell would undo.
    for (const cmd of [
      `Remove-Item -Recurse ${SESSION_DIR}`,
      `del "${SESSION_DIR}\\.agents\\hooks.json"`,
      `type 'C:/Users/Harry/AppData/Roaming/agent-office/config.json'`,
      `echo x > C:\\Users\\Harry\\App"Data"\\Roaming\\agent-office\\agy-sessions\\s-abc123\\.agents\\agy-hook.cjs`,
      'copy evil.cjs C:\\Users\\Harry\\AppData\\Roaming\\agent^-office\\agy-sessions\\s-abc123\\.agents\\agy-hook.cjs',
      'Set-Content C:\\Users\\Harry\\AppData\\Roaming\\agent`-office\\config.json x',
      'del C:\\\\Users\\\\Harry\\\\AppData\\\\Roaming\\\\agent-office\\\\config.json',
      'DEL C:\\USERS\\HARRY\\APPDATA\\ROAMING\\AGENT-OFFICE\\CONFIG.JSON',
      'del %APPDATA%\\agent-office\\config.json',
      'del "%AppData%\\agent-office\\agy-sessions\\s-abc123\\.agents\\hooks.json"',
      'Remove-Item $env:APPDATA\\agent-office -Recurse',
      'Remove-Item "${env:APPDATA}/agent-office/config.json"',
      'rm ~/AppData/Roaming/agent-office/config.json',
      'rm $HOME\\AppData\\Roaming\\agent-office\\config.json',
      'del %USERPROFILE%\\AppData\\Roaming\\agent-office\\config.json',
      `node -e "require('fs').rmSync('C:/Users/Harry/AppData/Roaming/agent-office', {recursive:true})"`,
      `cmd /c "cd /d C:\\Users\\Harry\\AppData\\Roaming\\agent-office && del config.json"`
    ]) {
      denied('run_command', { CommandLine: cmd, Cwd: CWD }, mode)
    }
    // A command started inside it, and any other tool that names it.
    denied('run_command', { CommandLine: 'del hooks.json', Cwd: `${SESSION_DIR}\\.agents` }, mode)
    denied('call_mcp_tool', { ServerName: 'fs', ToolName: 'write', Arguments: { path: `${SESSION_DIR}\\.agents\\hooks.json` } }, mode)
    denied('some_future_tool', { where: [`${USER_DATA}\\config.json`] }, mode)
    // A link inside the project that leads into it.
    const linked = (p: string) => (p.toLowerCase().startsWith(`${CWD}\\link`.toLowerCase()) ? `${USER_DATA}${p.slice(`${CWD}\\link`.length)}` : p)
    denied('write_to_file', { TargetFile: `${CWD}\\link\\config.json`, CodeContent: 'x' }, mode, { realPath: linked })
    denied('view_file', { AbsolutePath: `${CWD}\\link\\config.json` }, mode, { realPath: linked })
  }
  assert.equal(flattenForPathSearch('C:\\Users\\Ha"rr"y\\\\App^Data//x', true), 'c:/users/harry/appdata/x')

  // Not sure it is the app's folder: never allowed by itself; the user sees a marked card.
  for (const cmd of [
    'cd ..\\..\\Users\\Harry\\AppData\\Roaming\\agent-office; del config.json',
    'del Roaming\\agent-office\\config.json',
    'Get-ChildItem -Recurse -Filter agy-hook.cjs | Remove-Item',
    'del agy-sessions\\s-abc123\\.agents\\hooks.json'
  ]) {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const v = policy('run_command', { CommandLine: cmd, Cwd: CWD }, mode)
      assert.equal(v.action, 'ask', cmd)
      assert.deepEqual(v.action === 'ask' && [v.card.plain.risk, v.card.plain.riskNote], ['danger', "May touch Agent Office's own files"], cmd)
    }
    assert.equal(act('run_command', { CommandLine: cmd, Cwd: CWD }, 'plan'), 'deny')
  }
  // A file's content or a search text may mention the path: the file it names decides.
  assert.equal(act('write_to_file', { TargetFile: `${CWD}\\README.md`, CodeContent: `Config lives in ${USER_DATA}\\config.json` }, 'acceptEdits'), 'allow')
  assert.equal(act('grep_search', { SearchPath: CWD, Query: 'agent-office\\agy-sessions' }), 'allow')
  // The project itself may be called like the app.
  assert.equal(act('view_file', { AbsolutePath: 'C:\\work\\agent-office\\README.md' }, 'default', { cwd: 'C:\\work\\agent-office' }), 'allow')
  const own = policy('run_command', { CommandLine: 'npm test', Cwd: 'C:\\work\\agent-office' }, 'default', { cwd: 'C:\\work\\agent-office' })
  assert.deepEqual(own.action === 'ask' && own.card.plain.risk, 'normal')
  // The board's tools are allowed whatever they say (they reach nothing but the board).
  assert.equal(act('call_mcp_tool', { ServerName: 'agent_office', ToolName: 'board_post', Arguments: { note: `see ${USER_DATA}` } }), 'allow')
  // POSIX spellings.
  const posix = (cmd: string) =>
    agyPolicy({ tool: 'run_command', args: { CommandLine: cmd }, mode: 'default', cwd: '/home/h/proj', protectedPaths: ['/home/h/.config/agent-office'], who: 'G', env: { HOME: '/home/h' }, platform: 'linux' }).action
  assert.deepEqual(['rm -rf /home/h/.config/agent-office', "rm -rf '/home/h/.config'/agent-office", 'rm -rf ~/.config/agent-office/x', 'rm -rf $HOME/.config/agent-office', 'rm -rf ${HOME}/.config/agent-office', 'ls'].map(posix), ['deny', 'deny', 'deny', 'deny', 'deny', 'ask'])
})

// ---- the stream ---------------------------------------------------------------------------------------

/** stdout of the "gate" run (docs/spikes-phase-c.md, `check.cjs --only gate`), text deltas shortened. */
const C = 'b7be720e-3f57-4753-a7ae-2449e3c3538d'
const GATE_RUN = [
  `{"event":"init","conversation_id":"${C}","init":{"model":"gemini-3.8-flash-low","cwd":"C:\\\\scratch\\\\check-project","tools":["call_mcp_tool","run_command","write_to_file"],"permission_mode":"always-proceed"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":1.4364246,"usage":{"input_tokens":13159,"output_tokens":90,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13249}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \\"console.log('ao-allow')\\""}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.5550226,"tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \\"console.log('ao-allow')\\""},"output":"ao-allow\\n"}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":3,"state":"DONE","step_type":"agent_response","duration_seconds":7.5798404999999995,"usage":{"input_tokens":13338,"output_tokens":90,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13428}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \\"console.log('ao-deny')\\""}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":4,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.1021063,"tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \\"console.log('ao-deny')\\""},"error":{"type":"TOOL_ERROR","message":"tool call denied by pre-tool hook: Denied from the Agent Office CEO desk."}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":6,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \\"console.log('ao-crash')\\""}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":6,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.1925784,"tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \\"console.log('ao-crash')\\""},"error":{"type":"TOOL_ERROR","message":"JSON hook \\"jsonhook__agent-office_PreToolUse_0_0\\" failed: command failed: exit status 1, stderr:"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":9,"state":"ACTIVE","step_type":"agent_response","text_delta":"1: ao-allow, 2: REFUSED, "}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":9,"state":"ACTIVE","step_type":"agent_response","text_delta":"3: REFUSED, 4: REFUSED"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":9,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":3.4020238,"usage":{"input_tokens":13910,"output_tokens":23,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13933}}}`,
  `{"event":"result","result":{"conversation_id":"${C}","status":"SUCCESS","response":"1: ao-allow, 2: REFUSED, 3: REFUSED, 4: REFUSED\\n","duration_seconds":17.540429,"num_turns":1,"usage":{"input_tokens":67663,"output_tokens":383,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":68046}}}`
]
/** Other lines seen in the spikes: an injected step, a file tool, an MCP tool, the headless soft-deny. */
const INJECTED = `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0}}`
const WRITE_ACTIVE = `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"C:\\\\scratch\\\\check-project\\\\ao-note.txt"}}}}`
const MCP_ACTIVE = `{"event":"step_update","step_update":{"conversation_id":"${C}","step_index":8,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"text":"hi"},"ServerName":"office","ToolName":"board_post"}}}}`
const SOFT_DENY = `{"event":"result","result":{"conversation_id":"${C}","status":"SUCCESS","response":"","duration_seconds":24.3843392,"num_turns":1,"usage":{"input_tokens":13213,"output_tokens":242,"thinking_tokens":151,"cache_read_tokens":0,"total_tokens":13455},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}`

await t('stream: lines are parsed into init / step / result; anything else is tolerated', () => {
  assert.deepEqual(parseAgyLine(GATE_RUN[0]), { type: 'init', conversationId: C, model: 'gemini-3.8-flash-low', cwd: 'C:\\scratch\\check-project', permissionMode: 'always-proceed' })
  assert.deepEqual(parseAgyLine(GATE_RUN[3]), {
    type: 'step', conversationId: C, index: 2, state: 'ACTIVE', stepType: 'tool', toolName: 'run_command', params: { CommandLine: `node -e "console.log('ao-allow')"` }, output: null, error: '', textDelta: '', durationMs: null, usage: null
  })
  const done = parseAgyLine(GATE_RUN[4])
  assert.deepEqual(done?.type === 'step' && [done.state, done.output, done.durationMs], ['DONE', 'ao-allow\n', 555])
  const failed = parseAgyLine(GATE_RUN[7])
  assert.deepEqual(failed?.type === 'step' && [failed.state, failed.error], ['ERROR', 'tool call denied by pre-tool hook: Denied from the Agent Office CEO desk.'])
  assert.deepEqual(parseAgyLine(SOFT_DENY), { type: 'result', conversationId: C, status: 'SUCCESS', response: '', denied: ['RunCommand'], usage: { input: 13213, output: 242, thinking: 151, cacheRead: 0, total: 13455 } })
  assert.deepEqual(parseAgyLine('{"event":"command_result","command":{}}'), { type: 'other', event: 'command_result' })
  assert.deepEqual(parseAgyLine('{"event":"step_update","step_update":{"state":"DONE"}}'), { type: 'other', event: 'step_update' })
  assert.equal(parseAgyLine('not json'), null)
  assert.equal(parseAgyLine('[1]'), null)
  assert.equal(parseAgyLine('"x"'), null)
})

await t('stream -> chat: a command that ran, one that was refused, one whose hook crashed, the streamed answer', () => {
  const chat = new AgyChat('s1')
  const events: ChatEvent[] = []
  const ctx = (now: number) => ({ agentId: 's1', now, turnId: 'turn-1', cwd: 'C:\\scratch\\check-project' })
  events.push(...chat.turnStarted('turn-1'))
  events.push(...chat.user('Run these four shell commands', 'human', ctx(1)).events)
  GATE_RUN.forEach((line, i) => {
    const e = parseAgyLine(line)!
    // What the driver does when the user denies: the step is marked before agy reports the error.
    if (e.type === 'step' && e.index === 4 && e.state === 'ACTIVE') events.push(...chat.apply(e, ctx(10 + i)), ...(chat.refuse(4), []))
    else events.push(...chat.apply(e, ctx(10 + i)))
  })
  events.push(...chat.turnEnded('turn-1', 'completed', ctx(99)))
  const items = chat.list()
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [['user:1', 'user'], ['step:2', 'command'], ['step:4', 'command'], ['step:6', 'command'], ['step:9', 'assistant']])
  const [, ran, refused, crashed, answer] = items
  assert.deepEqual(ran.kind === 'command' && [ran.command, ran.intent, ran.output, ran.exitCode, ran.status, ran.durationMs], [`node -e "console.log('ao-allow')"`, 'exec', 'ao-allow\n', null, 'done', 555])
  assert.deepEqual(refused.kind === 'command' && [refused.status, refused.output], ['declined', 'tool call denied by pre-tool hook: Denied from the Agent Office CEO desk.'])
  // A hook that crashed is agy's failure, not a decision.
  assert.deepEqual(crashed.kind === 'command' && [crashed.status, /JSON hook .* failed/.test(crashed.output)], ['failed', true])
  assert.deepEqual(answer.kind === 'assistant' && [answer.text, answer.streaming], ['1: ao-allow, 2: REFUSED, 3: REFUSED, 4: REFUSED\n', false])
  assert.ok(items.every((i) => i.turnId === 'turn-1' && i.sessionId === 's1' && i.agentId === 's1'))
  // Model calls that only made a tool call (steps 1, 3) gave no empty bubble.
  assert.equal(items.filter((i) => i.kind === 'assistant').length, 1)
  // The renderer's contract: an item is introduced before its deltas; the turn's end comes last.
  const firstItem = events.findIndex((e) => e.type === 'item' && e.item.id === 'step:9')
  const deltas = events.filter((e) => e.type === 'delta')
  assert.deepEqual(deltas, [{ type: 'delta', sessionId: 's1', itemId: 'step:9', field: 'text', delta: '3: REFUSED, 4: REFUSED' }])
  assert.ok(firstItem >= 0 && firstItem < events.indexOf(deltas[0]))
  assert.deepEqual(events[0], { type: 'turn', sessionId: 's1', turnId: 'turn-1', status: 'started' })
  assert.deepEqual(events[events.length - 1], { type: 'turn', sessionId: 's1', turnId: 'turn-1', status: 'completed' })
  // The result's answer was already shown as it streamed: not twice.
  assert.equal(items.filter((i) => i.id.startsWith('answer:')).length, 0)
})

await t('stream -> chat: injected steps, file and MCP tools, the hook payload fills in what the stream lacks', () => {
  const chat = new AgyChat('s1')
  const ctx = { agentId: 's1', now: 5, turnId: 'turn-1', cwd: 'C:\\scratch\\check-project' }
  chat.turnStarted('turn-1')
  assert.deepEqual(chat.apply(parseAgyLine(INJECTED)!, ctx), []) // the briefing: nothing to show
  assert.deepEqual(chat.apply(parseAgyLine(GATE_RUN[1])!, ctx), []) // user_input: the driver showed the prompt itself

  // write_to_file: the stream only names the file.
  chat.apply(parseAgyLine(WRITE_ACTIVE)!, ctx)
  let file = chat.get('step:4')!
  assert.deepEqual(file.kind === 'file-change' && [file.status, file.changes], ['running', [{ path: 'C:\\scratch\\check-project\\ao-note.txt', change: 'add', diff: '' }]])
  // The PreToolUse payload (toolCall.args) has the content.
  const args = { TargetFile: 'C:\\scratch\\check-project\\ao-note.txt', CodeContent: 'hello\nworld\n', Overwrite: false, Description: 'Create ao-note.txt' }
  const filled = chat.toolArgs(4, 'write_to_file', args, { before: null })
  assert.equal(filled.length, 1)
  file = chat.get('step:4')!
  assert.deepEqual(file.kind === 'file-change' && file.changes, [{ path: args.TargetFile, change: 'add', diff: '@@ -0,0 +1,2 @@\n+hello\n+world\n' }])
  // …and it survives the step's end.
  chat.apply(parseAgyLine(WRITE_ACTIVE.replace('"ACTIVE"', '"DONE"'))!, ctx)
  file = chat.get('step:4')!
  assert.deepEqual(file.kind === 'file-change' && [file.status, file.changes[0].diff], ['done', '@@ -0,0 +1,2 @@\n+hello\n+world\n'])
  assert.deepEqual(parseDiff(file.kind === 'file-change' ? file.changes[0].diff : '', 'add').added, 2)
  // A failed file tool says why (the card has no place for it).
  const failed = chat.apply(parseAgyLine(WRITE_ACTIVE.replace('"step_index":4', '"step_index":5').replace('"ACTIVE"', '"ERROR"').replace('"parameters":', '"error":{"type":"TOOL_ERROR","message":"disk full"},"parameters":'))!, ctx)
  assert.deepEqual(failed.map((e) => e.type === 'item' && [e.item.kind, e.item.kind === 'notice' ? e.item.text : (e.item as { status?: string }).status]), [['file-change', 'failed'], ['notice', 'write_to_file failed: disk full']])

  chat.apply(parseAgyLine(MCP_ACTIVE)!, ctx)
  const tool = chat.get('step:8')!
  assert.deepEqual(tool.kind === 'tool' && [tool.server, tool.tool, tool.input, tool.status], ['office', 'board_post', '{\n  "text": "hi"\n}', 'running'])
  const board = new AgyChat('s2')
  board.apply(parseAgyLine(MCP_ACTIVE.replace('"office"', '"agent_office"'))!, ctx)
  const own = board.get('step:8')!
  assert.equal(own.kind === 'tool' && own.server, 'Office board')

  // The headless soft-deny (should not happen with the gate, but must not look like nothing happened).
  const soft = chat.apply(parseAgyLine(SOFT_DENY)!, ctx)
  assert.deepEqual(soft.map((e) => e.type === 'item' && e.item.kind === 'notice' && [e.item.level, e.item.text]), [['warning', 'Antigravity itself refused: RunCommand. The turn ended there.']])
  // An answer that was not streamed is shown from the result.
  const whole = new AgyChat('s3')
  whole.turnStarted('t')
  const shown = whole.apply({ type: 'result', conversationId: C, status: 'SUCCESS', response: 'All done.\n', denied: [], usage: null }, ctx)
  assert.deepEqual(shown.map((e) => e.type === 'item' && e.item.kind === 'assistant' && [e.item.text, e.item.streaming]), [['All done.\n', false]])

  // A turn that is cut off closes what was open.
  const cut = new AgyChat('s4')
  cut.turnStarted('turn-1')
  cut.apply(parseAgyLine(GATE_RUN[3])!, ctx)
  cut.apply(parseAgyLine(GATE_RUN[11])!, { ...ctx })
  cut.approvalRequested({ requestId: 'perm-1', stepIndex: 2, summary: 'Command: x', detail: 'x', question: 'Q', risk: 'caution', riskNote: 'N' }, ctx)
  const closed = cut.turnEnded('turn-1', 'interrupted', ctx)
  assert.deepEqual(cut.list().map((i) => [i.kind, 'status' in i ? i.status : i.kind === 'assistant' ? i.streaming : i.kind === 'approval' ? i.outcome : i.kind === 'notice' ? i.text : '']), [
    ['command', 'interrupted'], ['assistant', false], ['approval', 'resolved-elsewhere'], ['notice', 'Turn interrupted']
  ])
  const approval = cut.get('approval:perm-1')!
  assert.deepEqual(approval.kind === 'approval' && [approval.subjectId, approval.question, approval.risk, approval.riskNote], ['step:2', 'Q', 'caution', 'N'])
  assert.deepEqual(closed[closed.length - 1], { type: 'turn', sessionId: 's4', turnId: 'turn-1', status: 'interrupted' })
  const bad = cut.turnEnded('turn-2', 'failed', ctx, 'quota reached')
  assert.deepEqual(bad[bad.length - 1], { type: 'turn', sessionId: 's4', turnId: 'turn-2', status: 'failed', error: 'quota reached' })
})

await t('stream: file diffs from tool arguments; read tools; world activities', () => {
  // A new file, an overwritten file (a hunk around what differs), replacements.
  assert.deepEqual(agyFileChange('write_to_file', { TargetFile: 'a.txt', CodeContent: 'one\ntwo\n' }, { before: null }), { path: 'a.txt', change: 'add', diff: '@@ -0,0 +1,2 @@\n+one\n+two\n' })
  assert.deepEqual(agyFileChange('write_to_file', { TargetFile: 'a.txt', CodeContent: '', Overwrite: false }), { path: 'a.txt', change: 'add', diff: '' })
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n'
  const after = ['a', 'b', 'c', 'd', 'E', 'E2', 'f', 'g', 'h'].join('\n') + '\n'
  const over = agyFileChange('write_to_file', { TargetFile: 'a.txt', CodeContent: after, Overwrite: true }, { before })!
  assert.equal(over.change, 'update')
  assert.equal(over.diff, '@@ -2,7 +2,8 @@\n b\n c\n d\n-e\n+E\n+E2\n f\n g\n h\n')
  const parsed = parseDiff(over.diff)
  assert.deepEqual([parsed.added, parsed.removed], [2, 1])
  assert.deepEqual(parsed.lines.filter((l) => l.kind === 'add').map((l) => l.newNo), [5, 6])
  assert.equal(replacedFileDiff('same\n', 'same\n'), '')
  assert.equal(replacedFileDiff('', 'x\n'), '@@ -0,0 +1,1 @@\n+x\n')
  // Overwrite of a file whose content is not known: shown as the new content.
  assert.deepEqual(agyFileChange('write_to_file', { TargetFile: 'a.txt', CodeContent: 'x\n', Overwrite: true }), { path: 'a.txt', change: 'update', diff: '@@ -0,0 +1,1 @@\n+x\n' })
  assert.deepEqual(agyFileChange('replace_file_content', { TargetFile: 'a.ts', TargetContent: 'const a = 1', ReplacementContent: 'const a = 2\nconst b = 3', StartLine: 12, EndLine: 12 }), {
    path: 'a.ts', change: 'update', diff: '@@ -12,1 +12,2 @@\n-const a = 1\n+const a = 2\n+const b = 3\n'
  })
  const multi = agyFileChange('multi_replace_file_content', { TargetFile: 'a.ts', ReplacementChunks: [{ TargetContent: 'x', ReplacementContent: 'y', StartLine: 3 }, { TargetContent: 'p\nq', ReplacementContent: '', StartLine: 20 }, 'junk'] })!
  assert.equal(multi.diff, '@@ -3,1 +3,1 @@\n-x\n+y\n@@ -20,2 +0,0 @@\n-p\n-q\n')
  assert.deepEqual([parseDiff(multi.diff).added, parseDiff(multi.diff).removed], [1, 3])
  assert.deepEqual(agyFileChange('sed_file', { TargetFile: 'a.ts' }), { path: 'a.ts', change: 'update', diff: '' })
  assert.equal(agyFileChange('write_to_file', { CodeContent: 'x' }), null)
  // The diff is capped.
  const big = agyFileChange('write_to_file', { TargetFile: 'big.txt', CodeContent: 'line\n'.repeat(5000) }, { before: null }, 1000)!
  assert.ok(big.diff.length <= 1002 && big.diff.endsWith('\n…'))

  // Read tools are shown like the reads of the other providers.
  const chat = new AgyChat('s1')
  const ctx = { agentId: 's1', now: 1, turnId: 't', cwd: 'C:\\w' }
  const stepOf = (index: number, tool: string, params: Record<string, unknown>, state = 'ACTIVE', extra: Record<string, unknown> = {}) =>
    parseAgyLine(JSON.stringify({ event: 'step_update', step_update: { conversation_id: C, step_index: index, state, step_type: 'tool', tool_name: tool, tool_info: { name: tool, parameters: params, ...extra } } }))!
  chat.apply(stepOf(1, 'view_file', { AbsolutePath: 'C:\\w\\src\\a.ts' }), ctx)
  chat.apply(stepOf(2, 'list_dir', { DirectoryPath: 'C:\\w' }), ctx)
  chat.apply(stepOf(3, 'grep_search', { SearchPath: 'C:\\w\\src', Query: 'TODO' }), ctx)
  chat.apply(stepOf(4, 'find_by_name', { SearchDirectory: 'C:\\w', Pattern: '*.ts' }), ctx)
  chat.apply(stepOf(5, 'search_web', { query: 'node 24' }), ctx)
  chat.apply(stepOf(6, 'read_url_content', { Url: 'https://example.com' }), ctx)
  chat.apply(stepOf(7, 'some_future_tool', { a: 1 }), ctx)
  chat.apply(stepOf(7, 'some_future_tool', { a: 1 }, 'DONE', { output: 'fine' }), ctx)
  chat.apply(stepOf(8, 'run_command', { CommandLine: 'git status' }), ctx)
  chat.toolArgs(8, 'run_command', { CommandLine: 'git status', Cwd: 'C:\\w\\sub' })
  assert.deepEqual(chat.list().map((i) => (i.kind === 'command' ? [i.command, i.intent, i.cwd] : i.kind === 'web' ? [i.action, i.query ?? i.url] : i.kind === 'tool' ? [i.tool, i.result, i.status] : [])), [
    ['read src\\a.ts', 'read', undefined],
    ['list .', 'list', undefined],
    ['search "TODO" in src', 'search', undefined],
    ['find *.ts in .', 'search', undefined],
    ['search', 'node 24'],
    ['open', 'https://example.com'],
    ['some_future_tool', 'fine', 'done'],
    ['git status', 'read', 'C:\\w\\sub']
  ])
  // Output is capped to its tail.
  const small = new AgyChat('s1', { maxItems: 3, maxOutputChars: 10, maxDiffChars: 50 })
  small.apply(stepOf(1, 'run_command', { CommandLine: 'x' }, 'DONE', { output: '0123456789abcdef' }), ctx)
  const capped = small.get('step:1')!
  assert.deepEqual(capped.kind === 'command' && [capped.output, capped.outputTruncated], ['6789abcdef', true])
  for (let i = 2; i < 6; i++) small.apply(stepOf(i, 'run_command', { CommandLine: 'x' }), ctx)
  assert.deepEqual(small.list().map((i) => i.id), ['step:3', 'step:4', 'step:5'])

  // World: where the character goes.
  assert.equal(agyCommandIntent('git status'), 'read')
  assert.equal(agyCommandIntent('Get-ChildItem src'), 'read')
  assert.equal(agyCommandIntent('type a.txt > b.txt'), 'exec')
  assert.equal(agyCommandIntent('dir; del x'), 'exec')
  assert.equal(agyCommandIntent('cat a | node x.js'), 'exec')
  assert.equal(agyCommandIntent('npm test'), 'exec')
  const w = (tool: string, params: Record<string, unknown>) => agyWorldActivity(tool, params, 'C:\\w')
  assert.deepEqual(w('run_command', { CommandLine: 'npm test' }), { activity: 'exec', detail: 'npm test' })
  assert.deepEqual(w('run_command', { CommandLine: 'git log' }), { activity: 'read', detail: 'git log' })
  assert.deepEqual(w('write_to_file', { TargetFile: 'C:\\w\\src\\a.ts' }), { activity: 'write', detail: 'src\\a.ts' })
  assert.deepEqual(w('replace_file_content', { TargetFile: 'C:\\other\\a.ts' }), { activity: 'write', detail: 'C:\\other\\a.ts' })
  assert.deepEqual(w('view_file', { AbsolutePath: 'C:\\w\\a.ts' }), { activity: 'read', detail: 'a.ts' })
  assert.deepEqual(w('grep_search', { Query: 'TODO' }), { activity: 'read', detail: 'TODO' })
  assert.deepEqual(w('search_web', { query: 'q' }), { activity: 'web', detail: 'q' })
  assert.deepEqual(w('read_url_content', { Url: 'https://e.com' }), { activity: 'web', detail: 'https://e.com' })
  assert.deepEqual(w('open_browser_url', { Url: 'https://e.com' }), { activity: 'web', detail: 'https://e.com' })
  assert.deepEqual(w('capture_browser_screenshot', {}), { activity: 'capture', detail: 'capture_browser_screenshot' })
  assert.deepEqual(w('call_mcp_tool', { ServerName: 'agent_office', ToolName: 'board_read' }), { activity: 'read', detail: 'checking the board' })
  assert.deepEqual(w('call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue' }), { activity: 'exec', detail: 'github.create_issue' })
  assert.deepEqual(w('call_mcp_tool', { ServerName: 'pw', ToolName: 'take_screenshot' }), { activity: 'capture', detail: 'pw.take_screenshot' })
  assert.deepEqual(w('invoke_subagent', {}), { activity: 'exec', detail: 'delegating' })
  assert.deepEqual(w('some_future_tool', {}), { activity: 'exec', detail: 'some_future_tool' })
  assert.equal(w('finish', {}), null)
  assert.equal(w('command_status', {}), null)
})

await t('stream: the run logs of the spikes replay without an open item left (when they are on this machine)', () => {
  // scripts/spikes/agy/logs is git-ignored: this part only runs where the spikes were run.
  let files: string[] = []
  try {
    files = readdirSync(SPIKE_LOGS).filter((f) => /check-(gate|approvals|second)\.log$/.test(f))
  } catch {
    files = []
  }
  for (const name of files) {
    const chat = new AgyChat('s1')
    let turns = 0
    let turnId = ''
    for (const line of readFileSync(join(SPIKE_LOGS, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let rec: { dir?: string; msg?: unknown }
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const ctx = { agentId: 's1', now: 1, turnId, cwd: 'C:\\x' }
      if (rec.dir === '->') {
        turnId = `turn-${++turns}`
        chat.turnStarted(turnId)
      } else if (rec.dir === '<-') {
        const e = parseAgyLine(JSON.stringify(rec.msg))
        assert.ok(e, `${name}: a stdout line that is not an event`)
        if (e.type === 'init') continue
        chat.apply(e, ctx)
        if (e.type === 'result') chat.turnEnded(turnId, 'completed', ctx)
      }
    }
    for (const item of chat.list()) {
      assert.ok(!('status' in item) || item.status !== 'running', `${name}: ${item.id} still running`)
      assert.ok(item.kind !== 'assistant' || (!item.streaming && item.text.trim().length > 0), `${name}: ${item.id}`)
    }
    if (turns > 0) assert.ok(chat.list().length > 0, name)
  }
})

// ---- the hook script ----------------------------------------------------------------------------------

interface HookRun {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/** Runs hook/agy-hook.cjs like agy does: the payload on stdin, the answer on stdout. */
function runHook(event: string, payload: unknown, env: Record<string, string>, via?: { cwd: string; command: string }): Promise<HookRun> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const full = { ...agyEnv(process.env), ...env }
    const child = via
      ? spawn(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', via.command], { cwd: via.cwd, env: full, windowsHide: true })
      : spawn(process.execPath, [HOOK, event], { env: full, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.on('error', () => {})
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }))
  })
}

function localServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ server: Server; url: string; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (d) => (body += d))
      req.on('end', () => handler(req, body, res))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ server, port, url: `http://127.0.0.1:${port}/hooks/agy` })
    })
  })
}

await t('hook script: allow and deny pass through; unreachable, late, garbage or odd answers are a deny; never an allow by default', async () => {
  const TOKEN = 'a'.repeat(64)
  const seen: Array<{ headers: IncomingMessage['headers']; body: unknown; url?: string; method?: string }> = []
  let reply: (res: ServerResponse) => void = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"decision":"allow"}')
  const { server, url, port } = await localServer((req, body, res) => {
    seen.push({ headers: req.headers, body: JSON.parse(body), url: req.url, method: req.method })
    reply(res)
  })
  const env = { AO_AGY_URL: url, AO_AGY_TOKEN: TOKEN, AO_AGY_SESSION: 's-1' }
  const payload = { toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, stepIdx: 2, conversationId: C }
  const gate = async (over: Record<string, string> = {}, input: unknown = payload) => {
    const r = await runHook('PreToolUse', input, { ...env, ...over })
    // Always exit 0 with exactly one JSON object, and never the token.
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stderr, '')
    assert.ok(!r.stdout.includes(TOKEN))
    return JSON.parse(r.stdout) as { decision?: string; reason?: string }
  }
  const isDeny = (a: { decision?: string; reason?: string }, why: RegExp) => {
    assert.equal(a.decision, 'deny')
    assert.match(a.reason ?? '', why)
  }

  // allow: what the app said, and how the question was asked.
  assert.deepEqual(await gate(), { decision: 'allow' })
  assert.deepEqual([seen[0].method, seen[0].url, seen[0].headers['x-agent-office-token'], seen[0].headers['x-agent-office-session']], ['POST', '/hooks/agy', TOKEN, 's-1'])
  assert.deepEqual(seen[0].body, { event: 'PreToolUse', payload })
  // Nothing but the decision gets through (no permissionOverrides, no rewritten arguments).
  reply = (res) => res.writeHead(200).end('{"decision":"allow","permissionOverrides":["command(*)"],"overwrite":{"CommandLine":"rm -rf /"}}')
  assert.deepEqual(await gate(), { decision: 'allow' })
  // deny with the user's message.
  reply = (res) => res.writeHead(200).end('{"decision":"deny","reason":"Not now, use the staging database."}')
  assert.deepEqual(await gate(), { decision: 'deny', reason: 'Not now, use the staging database.' })
  reply = (res) => res.writeHead(200).end('{"decision":"deny"}')
  assert.deepEqual(await gate(), { decision: 'deny', reason: 'Denied by Agent Office.' })

  // Garbage and odd answers.
  for (const [body, status] of [['not json', 200], ['', 200], ['{}', 200], ['[]', 200], ['null', 200], ['"allow"', 200], ['{"decision":"ask"}', 200], ['{"decision":"ALLOW"}', 200], ['{"decision":true}', 200], ['{"decision":"allow"', 200], ['{"decision":"allow"}', 500], ['{"decision":"allow"}', 403], ['{"decision":"allow"}', 202]] as const) {
    reply = (res) => res.writeHead(status).end(body)
    isDeny(await gate(), /Agent Office could not be asked \((malformed answer|HTTP \d+)\)/)
  }
  // The app hangs up without answering.
  reply = (res) => res.socket?.destroy()
  isDeny(await gate(), /not reachable|connection lost/)
  // The app does not answer in time.
  reply = () => {}
  const late = await gate({ AO_AGY_TIMEOUT_MS: '300' })
  isDeny(late, /no answer in time/)
  // The hook's own input is unreadable.
  reply = (res) => res.writeHead(200).end('{"decision":"allow"}')
  const before = seen.length
  isDeny(await gate({}, 'not json'), /unreadable hook input/)
  isDeny(await gate({}, '[1,2]'), /unreadable hook input/)
  assert.equal(seen.length, before) // nothing was sent
  // No endpoint, no token, or an endpoint that is not this machine.
  isDeny(await gate({ AO_AGY_URL: '' }), /no endpoint/)
  isDeny(await gate({ AO_AGY_TOKEN: '' }), /no endpoint/)
  isDeny(await gate({ AO_AGY_URL: 'http://example.com/hooks/agy' }), /no endpoint/)
  isDeny(await gate({ AO_AGY_URL: `https://127.0.0.1:${port}/hooks/agy` }), /no endpoint/)
  assert.equal(seen.length, before)

  // Unreachable: the app is gone.
  await new Promise((r) => server.close(r))
  isDeny(await gate(), /not reachable/)

  // The other events never block agy: no answer = nothing injected.
  const pre = await runHook('PreInvocation', { invocationNum: 0, conversationId: C }, env)
  assert.deepEqual([pre.code, pre.stdout], [0, '{}'])
  const odd = await runHook('', { x: 1 }, env)
  assert.deepEqual([odd.code, odd.stdout], [0, '{}'])
})

await t('hook script: runs from hooks.json exactly as agy runs it, also from a folder with a space in its path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ao agy hook-'))
  const folder = buildAgySessionFolder({ dir: join(root, 'user data', 's-1'), hookScript: HOOK })
  const { server, url } = await localServer((_req, body, res) => {
    const msg = JSON.parse(body) as { event: string }
    res.writeHead(200).end(msg.event === 'PreInvocation' ? '{"injectSteps":[{"ephemeralMessage":"hello"}]}' : '{"decision":"deny","reason":"no"}')
  })
  const env = { AO_AGY_URL: url, AO_AGY_TOKEN: 'b'.repeat(64) }
  const cwd = join(folder.dir, '.agents') // agy: the folder that holds hooks.json
  const config = agyHooksConfig()['agent-office'] as { PreToolUse: Array<{ hooks: Array<{ command: string }> }>; PreInvocation: Array<{ command: string }> }
  const gate = await runHook('PreToolUse', { toolCall: { name: 'run_command', args: {} }, stepIdx: 1 }, env, { cwd, command: config.PreToolUse[0].hooks[0].command })
  assert.deepEqual([gate.code, JSON.parse(gate.stdout)], [0, { decision: 'deny', reason: 'no' }])
  const pre = await runHook('PreInvocation', { invocationNum: 0 }, env, { cwd, command: config.PreInvocation[0].command })
  assert.deepEqual([pre.code, JSON.parse(pre.stdout)], [0, { injectSteps: [{ ephemeralMessage: 'hello' }] }])
  await new Promise((r) => server.close(r))
  rmSync(root, { recursive: true, force: true })
})

// ---- token scopes -------------------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

function post(port: number, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let out = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (out += d))
      res.on('end', () => {
        let json: unknown = out
        try {
          json = JSON.parse(out)
        } catch {
          // keep the text
        }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

await t('token scopes: an agy hook token only reaches /hooks/agy (for its session); no other token reaches that route', async () => {
  const GLOBAL = 'G'.repeat(64)
  const hookTokens = new SessionTokens()
  const boardTokens = new SessionTokens()
  const agyTokens = new SessionTokens()
  const claude = hookTokens.issue('s-claude')
  const board = boardTokens.issue('s-agy')
  const agy = agyTokens.issue('s-agy')
  const req = (headers: Record<string, string>, method = 'POST') => ({ headers, method }) as unknown as IncomingMessage
  const who = (headers: Record<string, string>) => authenticate(req(headers), GLOBAL, hookTokens, boardTokens, agyTokens)
  assert.deepEqual(who({ 'x-agent-office-token': agy }), { kind: 'agy', sessionId: 's-agy' })
  assert.deepEqual(who({ 'x-agent-office-token': claude }), { kind: 'session', sessionId: 's-claude' })
  assert.equal(who({ authorization: `Bearer ${agy}` }), null) // never as a bearer token
  assert.equal(authenticate(req({ 'x-agent-office-token': agy }), GLOBAL, hookTokens, boardTokens), null) // unknown without its table
  const can = (auth: NonNullable<ReturnType<typeof who>>, path: string, headers: Record<string, string> = {}, method = 'POST') => authorise(auth, req(headers, method), path)
  const asAgy = { kind: 'agy', sessionId: 's-agy' } as const
  assert.equal(AGY_HOOK_ROUTE, '/hooks/agy')
  assert.deepEqual(['/hooks/agy', '/hooks/claude-code', '/mcp', '/events', '/health', '/ws'].map((p) => can(asAgy, p)), [true, false, false, false, false, false])
  assert.equal(can(asAgy, '/hooks/agy', {}, 'GET'), false)
  assert.equal(can(asAgy, '/hooks/agy', { 'x-agent-office-session': 's-agy' }), true)
  assert.equal(can(asAgy, '/hooks/agy', { 'x-agent-office-session': 's-other' }), false)
  assert.equal(can({ kind: 'global' }, '/hooks/agy'), false)
  assert.equal(can({ kind: 'session', sessionId: 's-claude' }, '/hooks/agy'), false)
  assert.equal(can({ kind: 'board', sessionId: 's-agy' }, '/hooks/agy'), false)
  assert.equal(can({ kind: 'global' }, '/events'), true)

  // Over real HTTP, with a target that records what reaches it.
  const port = await freePort()
  const reached: Array<[string, string, unknown]> = []
  const targets = {
    agyHookTarget: (sessionId: string) =>
      sessionId === 's-agy'
        ? { handleAgyHook: (event: string, payload: Record<string, unknown>) => (reached.push([sessionId, event, payload]), event === 'PreToolUse' ? { decision: 'allow' } : { injectSteps: [] }) }
        : undefined
  }
  const server = await startIngestServer({
    port, getToken: () => GLOBAL, sink: { emit: () => {} }, sessionTokens: hookTokens,
    board: { route: boardMcpRoute(new Board({ settings: () => ({ ...DEFAULT_BOARD_SETTINGS }) })), tokens: boardTokens },
    agy: { adapter: createAgyHooksAdapter(targets), tokens: agyTokens }
  })
  const body = { event: 'PreToolUse', payload: { toolCall: { name: 'run_command' }, stepIdx: 1 } }
  const tok = (t: string) => ({ 'x-agent-office-token': t })
  assert.deepEqual(await post(port, '/hooks/agy', tok(agy), body), { status: 200, json: { decision: 'allow' } })
  assert.deepEqual(reached, [['s-agy', 'PreToolUse', body.payload]])
  // Every other identity is turned away before the adapter.
  for (const headers of [tok(GLOBAL), tok(claude), tok(board), { authorization: `Bearer ${board}` }, { authorization: `Bearer ${agy}` }, tok('x'.repeat(64)), {}]) {
    const r = await post(port, '/hooks/agy', headers as Record<string, string>, body)
    assert.ok(r.status === 401 || r.status === 403, `${JSON.stringify(Object.keys(headers))}: ${r.status}`)
    assert.notDeepEqual(r.json, { decision: 'allow' })
  }
  assert.equal(reached.length, 1)
  // The agy token opens nothing else.
  assert.equal((await post(port, '/hooks/claude-code', tok(agy), { hook_event_name: 'Stop' })).status, 403)
  assert.equal((await post(port, '/events', tok(agy), { agentId: 'x', activity: 'idle' })).status, 403)
  assert.equal((await post(port, '/mcp', tok(agy), { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 403)
  assert.equal((await post(port, '/mcp', { authorization: `Bearer ${agy}` }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  assert.equal((await post(port, '/hooks/agy', { ...tok(agy), 'x-agent-office-session': 's-other' }, body)).status, 403)
  // The route itself: anything it cannot place is a deny for the gate, a no-op otherwise. Never an approval.
  assert.deepEqual((await post(port, '/hooks/agy', tok(agy), { event: 'PreToolUse' })).json, { decision: 'deny', reason: 'Agent Office could not read this request.' })
  assert.deepEqual((await post(port, '/hooks/agy', tok(agy), { event: 'PostToolUse', payload: {} })).json, {})
  assert.deepEqual((await post(port, '/hooks/agy', tok(agy), { event: 'Stop', payload: {} })).json, {})
  assert.deepEqual((await post(port, '/hooks/agy', tok(agy), [1])).json, {})
  const ghost = agyTokens.issue('s-ghost') // a token whose session has no driver
  assert.deepEqual((await post(port, '/hooks/agy', tok(ghost), body)).json, { decision: 'deny', reason: 'This Agent Office session has ended.' })
  // A revoked token is nobody.
  agyTokens.revoke('s-agy')
  assert.equal((await post(port, '/hooks/agy', tok(agy), body)).status, 401)
  await server.close()
  // The adapter's own lock, should the server ever let another identity through.
  const adapter = createAgyHooksAdapter(targets)
  const signal = new AbortController().signal
  assert.deepEqual(await adapter.handle(body, { emit: () => {} }, { auth: { kind: 'global' }, signal }), { decision: 'deny', reason: 'Agent Office did not recognise this session.' })
  assert.deepEqual(await adapter.handle(body, { emit: () => {} }, { auth: { kind: 'session', sessionId: 's-agy' }, signal }), { decision: 'deny', reason: 'Agent Office did not recognise this session.' })
  const throwing = createAgyHooksAdapter({ agyHookTarget: () => ({ handleAgyHook: () => Promise.reject(new Error('boom')) }) })
  assert.deepEqual(await throwing.handle(body, { emit: () => {} }, { auth: { kind: 'agy', sessionId: 's-agy' }, signal }), { decision: 'deny', reason: 'Agent Office failed while checking this action.' })
})

// ---- the driver against the fake agy ------------------------------------------------------------------

class NoPty implements PtyHost {
  async spawn(): Promise<void> {}
  write(): void {}
  resize(): void {}
  kill(): void {}
  dispose(): void {}
  async snapshot(): Promise<null> {
    return null
  }
  detach(): void {}
  ack(): void {}
}

interface StackOptions {
  root?: string
  env?: Record<string, string>
  steer?: 'queue' | 'inject'
  store?: boolean
  probeGate?: () => Promise<string | null>
  hookTimeoutMs?: number
}

const lines = (file: string): Array<Record<string, unknown>> => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

async function stack(o: StackOptions = {}) {
  // A space in every path the hook command and the bridge have to live with.
  const root = o.root ?? mkdtempSync(join(tmpdir(), 'ao agy '))
  const home = join(root, 'fake home')
  const userData = join(root, 'user data')
  const work = join(root, 'project')
  for (const d of [home, userData, work]) mkdirSync(d, { recursive: true })
  const port = await freePort()
  const GLOBAL = 'G'.repeat(64)
  const agyTokens = new SessionTokens()
  const boardTokens = new SessionTokens()
  const state = { allowOrders: true, settings: { ...DEFAULT_BOARD_SETTINGS } as BoardSettings }
  const board = new Board({ settings: () => state.settings })
  const world: AgentEvent[] = []
  const chat: ChatEvent[] = []
  let sessions: SessionInfo[] = []
  let permissions: PermissionRequestInfo[] = []
  const provider = agyProvider({
    sessionsDir: join(userData, 'agy-sessions'),
    protectedPaths: [userData],
    hookScript: HOOK,
    boardScript: BRIDGE,
    ingest: { baseUrl: () => `http://127.0.0.1:${port}`, tokens: agyTokens },
    cli: {
      findExecutable: () => process.execPath,
      resolveSpawn: (_exe, args) => ({ file: process.execPath, args: [FAKE, ...args] }),
      env: { ...process.env, FAKE_AGY_HOME: home, ...(o.env ?? {}) }
    },
    steer: o.steer,
    probeGate: o.probeGate,
    hookTimeoutMs: o.hookTimeoutMs
  })
  const store = o.store ? new SessionStore({ file: join(userData, 'sessions.json') }) : undefined
  const manager = new SessionManager({
    pty: new NoPty(),
    sink: { emit: (e) => void world.push(e) },
    providers: [provider],
    allowOrders: () => state.allowOrders,
    worldTopLevel: () => [],
    onSessionsChanged: (list) => (sessions = list),
    onPermissionsChanged: (list) => (permissions = list),
    onTerminalData: () => {},
    onChatEvent: (e) => void chat.push(e),
    board: {
      model: board,
      endpoint: { url: () => `http://127.0.0.1:${port}${BOARD_MCP_ROUTE}`, tokens: boardTokens },
      resolveProject: async (cwd) => folderProject(cwd),
      saveSettings: (patch) => (state.settings = { ...state.settings, ...patch })
    },
    ...(store ? { restore: { store, settings: () => ({ mode: 'none' as const }) } } : {})
  })
  const server = await startIngestServer({
    port,
    getToken: () => GLOBAL,
    sink: { emit: () => {} },
    board: { route: boardMcpRoute(board), tokens: boardTokens },
    agy: { adapter: createAgyHooksAdapter(manager), tokens: agyTokens }
  })
  const items = (id: string): ChatItem[] => manager.chatAttach(id)
  const row = (id: string) => manager.list().find((s) => s.id === id)
  const waitState = (id: string, want: string, ms?: number) => until(() => row(id)?.state === want, `state ${want} (is ${row(id)?.state})`, ms)
  /** The answer of the newest finished turn, parsed (the fake answers with a JSON summary). */
  const lastAnswer = (id: string): { results: Array<{ tool: string; output?: string; refused?: string }>; injected: string[]; history: string[] } => {
    const answers = items(id).filter((i) => i.kind === 'assistant')
    const last = answers[answers.length - 1]
    return JSON.parse(last.kind === 'assistant' ? last.text : '{}')
  }
  /** Sends a prompt and resolves when its turn is over. */
  const run = async (id: string, text: string) => {
    const before = items(id).filter((i) => i.kind === 'assistant').length
    await manager.chatSend(id, text)
    await until(() => row(id)?.state === 'idle' && items(id).filter((i) => i.kind === 'assistant').length > before, `the turn "${text.split('\n')[0]}"`)
    return lastAnswer(id)
  }
  const pending = (id: string, n = 1) => until(() => (manager.listPermissions().filter((p) => p.sessionId === id).length >= n ? manager.listPermissions().filter((p) => p.sessionId === id) : null), `${n} pending request(s)`)
  return {
    root, home, userData, work, port, GLOBAL, agyTokens, boardTokens, state, board, world, chat, provider, manager, server, store,
    items, row, waitState, lastAnswer, run, pending,
    /** Starts a session with the chat attached from its first event (as the renderer does when it is selected). */
    async start(req: Record<string, unknown>): Promise<SessionInfo> {
      const info = await manager.start(req)
      manager.chatAttach(info.id)
      return info
    },
    sessions: () => sessions,
    permissions: () => permissions,
    log: (name: string) => lines(join(home, name)),
    sessionDir: (id: string) => join(userData, 'agy-sessions', id),
    async close() {
      await manager.shutdown()
      provider.cli.killSync()
      await server.close()
    }
  }
}

await t('provider: available with the login state and the weekly usage; logged out -> start refused, the instruction, "Check again"', async () => {
  const a = await stack()
  const list = await a.manager.providers()
  assert.deepEqual(list.map((p) => [p.id, p.available, p.reason]), [['claude-code', false, 'no driver'], ['codex', false, 'no driver'], ['antigravity', true, undefined]])
  await until(() => a.provider.account.usage, 'the usage')
  const info = (await a.manager.providers())[2]
  assert.deepEqual(info, {
    id: 'antigravity', label: 'Antigravity', available: true, loginHelp: `${AGY_LOGIN_INSTRUCTION}.`, version: '1.2.14',
    account: { loggedIn: true }, usage: { usedPercent: 10, resetsAt: Date.parse('2026-10-09T14:46:26Z'), windowMinutes: 10080 }
  })
  // No plan name: agy does not say which plan it is.
  assert.equal(info.account?.plan, undefined)
  await a.manager.login('antigravity') // signed in: "Check again" simply succeeds
  // The login probe is cached (a provider list must not start a process every time).
  const probes = a.log('models-calls.log').length
  await a.manager.providers()
  await a.manager.providers()
  assert.equal(a.log('models-calls.log').length, probes)
  await a.close()

  // Logged out: listed as available, a session can't start, and the app says what to do.
  const b = await stack()
  writeFileSync(join(b.home, 'logged-out'), '')
  const out = (await b.manager.providers())[2]
  assert.deepEqual([out.available, out.account, out.usage, out.loginHelp], [true, { loggedIn: false }, undefined, `${AGY_LOGIN_INSTRUCTION}.`])
  await assert.rejects(b.start({ provider: 'antigravity', cwd: b.work }), /Antigravity is not signed in\. Open a terminal, run `agy`, choose the personal Google sign-in/)
  assert.deepEqual(b.manager.list(), [])
  assert.deepEqual(b.log('flagged-spawns.log'), [])
  await assert.rejects(b.manager.login('antigravity'), new RegExp(`^Error: ${AGY_LOGIN_INSTRUCTION.replace(/[()`]/g, '\\$&')}$`))
  assert.equal(AGY_LOGIN_INSTRUCTION, 'Open a terminal, run `agy`, choose the personal Google sign-in (not the Google Cloud project option), then come back')
  // The user signed in in a terminal: "Check again" finds out, and sessions start.
  rmSync(join(b.home, 'logged-out'))
  await b.manager.login('antigravity')
  assert.equal((await b.manager.providers())[2].account?.loggedIn, true)
  const s = await b.start({ provider: 'antigravity', cwd: b.work })
  assert.equal(s.state, 'idle')
  await b.close()
  // Not installed.
  const c = agyProvider({ sessionsDir: 'x', protectedPaths: [], hookScript: HOOK, ingest: { baseUrl: () => null, tokens: new SessionTokens() }, cli: { findExecutable: () => null } })
  assert.deepEqual(await c.probe(), { id: 'antigravity', label: 'Antigravity', available: false, reason: 'not installed' })
  await assert.rejects(c.login(), /not installed/)
})

await t('refuse to start: without the app’s hook in agy’s own `/hooks` answer, the flagged process is never spawned', async () => {
  const a = await stack()
  // agy does not load the hooks (as if --add-dir were not honoured).
  writeFileSync(join(a.home, 'no-hooks'), '')
  await assert.rejects(a.start({ provider: 'antigravity', cwd: a.work }), (err: Error) => {
    assert.ok(err.message.startsWith(AGY_HOOKS_NOT_LOADED), err.message)
    assert.match(err.message, /the app's PreToolUse hook is not in agy's list of hooks/)
    return true
  })
  assert.deepEqual(a.manager.list(), [])
  assert.equal(a.log('hooks-probes.log').length, 1)
  assert.deepEqual(a.log('flagged-spawns.log'), []) // never spawned with the flag
  assert.deepEqual(a.world, [])
  assert.equal(a.agyTokens.size, 0)
  assert.deepEqual(readdirSync(join(a.userData, 'agy-sessions')), []) // nothing left behind
  // The check asked about THIS session's folder, from the project folder.
  const probe = a.log('hooks-probes.log')[0] as { cwd: string; addDir: string[] }
  assert.equal(probe.cwd, a.work)
  assert.match(probe.addDir[0], /agy-sessions[\\/]s-[0-9a-f]{12}$/)
  // With the hooks back the same request starts.
  rmSync(join(a.home, 'no-hooks'))
  const s = await a.start({ provider: 'antigravity', cwd: a.work })
  assert.equal(a.log('flagged-spawns.log').length, 1)
  await a.close()
  assert.equal(existsSync(a.sessionDir(s.id)), false)

  // The check cannot be made at all (agy missing its answer, a timeout): the same refusal.
  const b = await stack({ probeGate: async () => 'agy did not answer the hooks check in time' })
  await assert.rejects(b.start({ provider: 'antigravity', cwd: b.work }), /did not load Agent Office's approval hook.*did not answer the hooks check in time/)
  assert.deepEqual(b.log('flagged-spawns.log'), [])
  await b.close()
  // The local server is not there to be asked: nothing is started either.
  const c = agyProvider({
    sessionsDir: join(a.root, 'c-sessions'), protectedPaths: [], hookScript: HOOK, ingest: { baseUrl: () => null, tokens: new SessionTokens() },
    cli: { findExecutable: () => process.execPath, resolveSpawn: (_e, args) => ({ file: process.execPath, args: [FAKE, ...args] }), env: { ...process.env, FAKE_AGY_HOME: a.home } }
  })
  const mc = new SessionManager({ pty: new NoPty(), sink: { emit: () => {} }, providers: [c], allowOrders: () => true, worldTopLevel: () => [], onSessionsChanged: () => {}, onPermissionsChanged: () => {}, onTerminalData: () => {} })
  await assert.rejects(mc.start({ provider: 'antigravity', cwd: a.work }), /local server is not running/)
  assert.equal(a.log('flagged-spawns.log').length, 1)
})

await t('a turn in default mode: the inbox decides (allow, deny with a message), reads and the board go through, the chat shows it all', async () => {
  const a = await stack()
  const s = await a.start({ provider: 'antigravity', cwd: a.work })
  assert.deepEqual([s.provider, s.surface, s.state, s.permissionMode, s.model, s.canReceiveOrders], ['antigravity', 'chat', 'idle', 'default', 'gemini-3.8-flash-low', true])
  assert.match(s.providerSessionId ?? '', /^[0-9a-f-]{36}$/)
  // Named after its model, and the cheapest model was chosen.
  assert.equal(s.title, 'Gemini 3.8 Flash')
  assert.equal(a.world[0].provider, 'antigravity')
  assert.deepEqual([a.world[0].activity, a.world[0].displayName], ['idle', 'Gemini 3.8 Flash'])
  // How it was spawned: the flag only after the hooks check, the session folder under userData.
  assert.equal(a.log('hooks-probes.log').length, 1)
  const spawned = a.log('flagged-spawns.log')[0] as { cwd: string; addDir: string[]; conversation: string | null }
  assert.deepEqual([spawned.cwd, spawned.addDir, spawned.conversation], [a.work, [a.sessionDir(s.id)], null])
  assert.deepEqual(readdirSync(a.work), []) // nothing was written into the project
  // The tokens are in the environment, not in the session folder.
  for (const f of ['hooks.json', 'agy-hook.cjs', 'mcp_config.json', 'agy-board-mcp.cjs']) {
    assert.ok(!/[0-9a-f]{64}/.test(readFileSync(join(a.sessionDir(s.id), '.agents', f), 'utf8')), f)
  }

  writeFileSync(join(a.work, 'seen.txt'), 'already here\n')
  const sent = a.manager.chatSend(s.id, ['Do the work', 'read: seen.txt', 'run: npm test', 'write: notes/a.txt|hello\\nworld\\n', 'run: git push', 'mcp: agent_office|board_post|{"note":"tests are green"}', 'web: https://example.com/docs'].join('\n'))
  // 1. The command: one card, the session waits, the world shows it.
  let [p] = await a.pending(s.id)
  await sent
  assert.deepEqual([p.provider, p.toolName, p.summary, p.question, p.risk, p.displayName], ['antigravity', 'Command', 'Command: npm test', 'Gemini 3.8 Flash wants to run the tests (`npm test`).', 'normal', 'Gemini 3.8 Flash'])
  assert.equal(a.row(s.id)?.state, 'waiting-permission')
  assert.deepEqual(a.world.filter((e) => e.activity === 'waiting').map((e) => e.detail), ['run the tests (`npm test`)'])
  assert.deepEqual(a.log('ran.log'), []) // nothing ran while the question is open
  let card = a.items(s.id).find((i) => i.kind === 'approval' && i.requestId === p.id)!
  assert.deepEqual(card.kind === 'approval' && [card.outcome, card.question, a.items(s.id).find((i) => i.id === card.subjectId)?.kind], ['pending', p.question, 'command'])
  assert.equal(a.manager.decide(p.id, { behavior: 'allow' }), 'allowed')
  // 2. The file: a card with its content; allowed -> a diff card.
  ;[p] = await a.pending(s.id)
  assert.deepEqual([p.toolName, p.question], ['Create', 'Gemini 3.8 Flash wants to create the file a.txt.'])
  assert.match(p.detail, /notes[\\/]a\.txt\n\nhello\nworld\n$/)
  assert.deepEqual(a.log('ran.log').map((r) => r.command), ['npm test'])
  assert.equal(existsSync(join(a.work, 'notes', 'a.txt')), false)
  assert.equal(a.manager.decide(p.id, { behavior: 'allow' }), 'allowed')
  // 3. The second command: denied with a message.
  ;[p] = await a.pending(s.id)
  assert.deepEqual([p.summary, p.risk, p.riskNote], ['Command: git push', 'caution', 'Publishes code'])
  assert.equal(a.manager.decide(p.id, { behavior: 'deny', message: 'Not yet: open a pull request instead.' }), 'denied')
  // (the board tool needs no card)  4. The web page: asked, with a caution.
  ;[p] = await a.pending(s.id)
  assert.deepEqual([p.toolName, p.question, p.risk, p.riskNote], ['WebFetch', 'Gemini 3.8 Flash wants to open the web page example.com.', 'caution', 'Uses the internet'])
  assert.equal(a.manager.decide(p.id, { behavior: 'deny' }), 'denied')
  await a.waitState(s.id, 'idle')
  await until(() => a.items(s.id).some((i) => i.kind === 'assistant' && !i.streaming), 'the answer')

  const answer = a.lastAnswer(s.id)
  assert.deepEqual(answer.results, [
    { tool: 'view_file', output: 'already here\n' }, // read inside the folder: never asked
    { tool: 'run_command', output: 'out:npm test\n' },
    { tool: 'write_to_file', output: '' },
    // The model reads the user's own words, and the default text when there were none.
    { tool: 'run_command', refused: 'tool call denied by pre-tool hook: Not yet: open a pull request instead.' },
    { tool: 'call_mcp_tool', output: 'Posted. Other teams see the note with their next prompt or board_read.' },
    { tool: 'read_url_content', refused: `tool call denied by pre-tool hook: ${DEFAULT_DENY_MESSAGE}` }
  ])
  assert.equal(readFileSync(join(a.work, 'notes', 'a.txt'), 'utf8'), 'hello\nworld\n')
  assert.deepEqual(a.log('ran.log').map((r) => r.command), ['npm test']) // `git push` never ran
  assert.deepEqual(a.log('ungated.log'), []) // nothing ran without the gate being asked
  // The briefing reached the model before its first call, once.
  assert.equal(answer.injected.length, 1)
  assert.equal(answer.injected[0], officeBriefing('antigravity', { title: 'Gemini 3.8 Flash', board: true, mode: 'default', cwd: a.work }))
  // The board: the note is there, the changed file is recorded for this team.
  const snap = a.board.snapshot()
  assert.deepEqual(snap.notes.map((n) => n.text), ['tests are green'])
  assert.deepEqual(snap.branches[0].files.map((f) => [f.path.replace(/\\/g, '/'), f.kind]), [['notes/a.txt', 'create']])

  // The chat: prompt, read, command with output, file card with the content as a diff, the declined command, the board tool, the declined page, the answer.
  const list = a.items(s.id)
  const view = list.map((i) =>
    i.kind === 'user' ? ['user', i.origin] : i.kind === 'command' ? ['command', i.command, i.status, i.intent] : i.kind === 'file-change' ? ['file', i.status, i.changes[0].change, i.changes[0].diff] : i.kind === 'approval' ? ['approval', i.outcome] : i.kind === 'tool' ? ['tool', i.server, i.tool, i.status, i.result] : i.kind === 'web' ? ['web', i.url, i.status] : [i.kind]
  )
  assert.deepEqual(view, [
    ['user', 'human'],
    ['command', 'read seen.txt', 'done', 'read'],
    ['command', 'npm test', 'done', 'exec'],
    ['approval', 'allowed'],
    ['file', 'done', 'add', '@@ -0,0 +1,2 @@\n+hello\n+world\n'],
    ['approval', 'allowed'],
    ['command', 'git push', 'declined', 'exec'],
    ['approval', 'denied'],
    ['tool', 'Office board', 'board_post', 'done', 'Posted. Other teams see the note with their next prompt or board_read.'],
    ['web', 'https://example.com/docs', 'declined'],
    ['approval', 'denied'],
    ['assistant']
  ])
  const ran = list.find((i) => i.kind === 'command' && i.command === 'npm test')!
  assert.deepEqual(ran.kind === 'command' && [ran.output, ran.cwd], ['out:npm test\n', a.work])
  assert.ok(list.every((i) => i.turnId === 'turn-1'))
  const turns = a.chat.filter((e) => e.type === 'turn')
  assert.deepEqual(turns.map((e) => e.type === 'turn' && [e.turnId, e.status]), [['turn-1', 'started'], ['turn-1', 'completed']])
  // The world: read, exec, waiting, write, …, and idle at the end.
  const acts = a.world.filter((e) => e.agentId === s.id).map((e) => e.activity)
  for (const want of ['read', 'exec', 'waiting', 'write', 'web', 'idle'] as const) assert.ok(acts.includes(want), want)
  assert.equal(acts[acts.length - 1], 'idle')
  assert.ok(a.world.every((e) => e.provider === 'antigravity' && e.parentId === null))
  assert.ok(a.world.some((e) => e.activity === 'read' && e.detail === 'checking the board'))
  assert.deepEqual(a.manager.listPermissions(), [])
  // The usage was read again after the turn, and not more than once a minute.
  const usageCalls = a.log('usage-calls.log').length
  await a.run(s.id, 'Another turn\nread: seen.txt')
  await sleep(100)
  assert.equal(a.log('usage-calls.log').length, usageCalls)
  // The second turn: no second briefing, the conversation goes on.
  assert.deepEqual([a.lastAnswer(s.id).injected, a.lastAnswer(s.id).history], [[], ['Do the work']])

  // Stop: the process ends, the token dies, the folder goes, the world says done.
  await a.manager.stop(s.id)
  assert.equal(a.row(s.id)?.state, 'exited')
  assert.equal(a.agyTokens.size, 0)
  await until(() => !existsSync(a.sessionDir(s.id)), 'the session folder to be removed')
  assert.equal(a.world[a.world.length - 1].activity, 'done')
  await a.close()
})

await t('forged and stray questions: a question that is not a tool call of the running turn gets a deny and no card', async () => {
  const a = await stack()
  const s = await a.start({ provider: 'antigravity', cwd: a.work })
  const conversationId = s.providerSessionId
  // What an agent's own command could do: it knows the session's token (it is in its environment).
  const driver = a.manager.agyHookTarget(s.id)!
  const signal = new AbortController().signal
  const ask = (payload: Record<string, unknown>) => driver.handleAgyHook('PreToolUse', payload, { auth: { kind: 'agy', sessionId: s.id }, signal }) as Promise<{ decision: string; reason: string }>
  const call = { toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } }, stepIdx: 7, conversationId }
  // Idle: no turn is running.
  assert.deepEqual((await ask(call)).decision, 'deny')
  // Another conversation (a sub-agent's, or made up).
  assert.match((await ask({ ...call, conversationId: 'other' })).reason, /does not know this conversation/)
  assert.match((await ask({ toolCall: {}, conversationId })).reason, /could not read this request/)
  // Mid-turn: a step the stream never announced, a wrong tool name for a real step, and a second question for the same step.
  const sent = a.manager.chatSend(s.id, 'Go\nrun: npm test')
  const [p] = await a.pending(s.id)
  await sent
  const real = a.items(s.id).find((i) => i.kind === 'command')!
  const index = Number(real.id.split(':')[1])
  assert.match((await ask({ ...call, stepIdx: index + 40 })).reason, /did not see this tool call start/)
  assert.match((await ask({ toolCall: { name: 'view_file', args: {} }, stepIdx: index, conversationId })).reason, /did not see this tool call start/)
  assert.match((await ask({ ...call, stepIdx: index })).reason, /did not see this tool call start/) // already asked by agy itself
  assert.equal(a.manager.listPermissions().length, 1) // still only agy's own question
  // Another session's token cannot ask for this one over HTTP either.
  const other = a.agyTokens.issue('s-other')
  const r = await post(a.port, '/hooks/agy', { 'x-agent-office-token': other, 'x-agent-office-session': s.id }, { event: 'PreToolUse', payload: call })
  assert.equal(r.status, 403)
  a.manager.decide(p.id, { behavior: 'allow' })
  await a.waitState(s.id, 'idle')
  assert.deepEqual(a.log('ran.log').map((x) => x.command), ['npm test'])
  await a.close()
})

await t('modes: plan is read-only (denied with the reason); acceptEdits lets edits in the folder through and still asks for commands', async () => {
  const a = await stack()
  writeFileSync(join(a.work, 'a.txt'), 'one\ntwo\n')
  const plan = await a.start({ provider: 'antigravity', cwd: a.work, permissionMode: 'plan', title: 'Planner' })
  const answer = await a.run(plan.id, 'Plan it\nread: a.txt\nrun: npm test\nwrite: b.txt|x\nreplace: a.txt|one|ONE')
  assert.deepEqual(answer.results, [
    { tool: 'view_file', output: 'one\ntwo\n' },
    { tool: 'run_command', refused: `tool call denied by pre-tool hook: ${PLAN_DENY_REASON}` },
    { tool: 'write_to_file', refused: `tool call denied by pre-tool hook: ${PLAN_DENY_REASON}` },
    { tool: 'replace_file_content', refused: `tool call denied by pre-tool hook: ${PLAN_DENY_REASON}` }
  ])
  assert.deepEqual(a.permissions(), []) // nothing was asked
  assert.deepEqual([existsSync(join(a.work, 'b.txt')), readFileSync(join(a.work, 'a.txt'), 'utf8'), a.log('ran.log')], [false, 'one\ntwo\n', []])
  assert.match(answer.injected[0], /plan mode: it is read-only/)
  const shown = a.items(plan.id)
  assert.deepEqual(shown.filter((i) => 'status' in i).map((i) => 'status' in i && i.status), ['done', 'declined', 'declined', 'declined'])
  assert.equal(shown.filter((i) => i.kind === 'notice' && i.text === `Not allowed: ${PLAN_DENY_REASON}`).length, 3)
  // The refused write still shows what it would have written.
  const wanted = shown.find((i) => i.kind === 'file-change')!
  assert.deepEqual(wanted.kind === 'file-change' && wanted.changes[0].diff, '@@ -0,0 +1,1 @@\n+x\n')
  await a.manager.stop(plan.id)

  const edits = await a.start({ provider: 'antigravity', cwd: a.work, permissionMode: 'acceptEdits', title: 'Editor' })
  const sent = a.manager.chatSend(edits.id, 'Edit\nwrite: b.txt|new\nreplace: a.txt|one|ONE\nwrite: .agents/hooks.json|{}\nrun: npm test')
  // The edits went through unasked; a write to an agent's own settings and the command are asked.
  let [p] = await a.pending(edits.id)
  await sent
  assert.deepEqual([p.toolName, p.risk, p.riskNote], ['Create', 'danger', 'Changes agent settings'])
  assert.deepEqual([readFileSync(join(a.work, 'b.txt'), 'utf8'), readFileSync(join(a.work, 'a.txt'), 'utf8')], ['new', 'ONE\ntwo\n'])
  a.manager.decide(p.id, { behavior: 'deny' })
  ;[p] = await a.pending(edits.id)
  assert.equal(p.summary, 'Command: npm test')
  a.manager.decide(p.id, { behavior: 'allow' })
  await a.waitState(edits.id, 'idle')
  assert.equal(existsSync(join(a.work, '.agents')), false)
  // An overwrite shows a diff against what was there; a replacement its two sides.
  const diffs = a.items(edits.id).filter((i) => i.kind === 'file-change').map((i) => i.kind === 'file-change' && [i.changes[0].change, i.changes[0].diff, i.status])
  assert.deepEqual(diffs, [['add', '@@ -0,0 +1,1 @@\n+new\n', 'done'], ['update', '@@ -1,1 +1,1 @@\n-one\n+ONE\n', 'done'], ['add', '@@ -0,0 +1,1 @@\n+{}\n', 'declined']])
  await a.close()
})

await t('the app’s own folders: a tool call into the session folder or userData is denied in every mode, even a "harmless" read', async () => {
  const a = await stack()
  writeFileSync(join(a.userData, 'config.json'), '{"token":"secret"}')
  const s = await a.start({ provider: 'antigravity', cwd: a.work, permissionMode: 'acceptEdits' })
  const hook = join(a.sessionDir(s.id), '.agents', 'agy-hook.cjs')
  const answer = await a.run(
    s.id,
    ['Break out', `write: ${hook}|process.stdout.write(JSON.stringify({decision:"allow"}))`, `read: ${join(a.userData, 'config.json')}`, `run: del "${join(a.sessionDir(s.id), '.agents', 'hooks.json')}"`, `tool: some_future_tool|{"path":${JSON.stringify(a.userData)}}`].join('\n')
  )
  // The reason also says where to work (a model may take the session folder for the project).
  const refusal = `tool call denied by pre-tool hook: ${PROTECTED_DENY_REASON} Work in the project folder instead: ${a.work}`
  assert.deepEqual(answer.results.map((r) => [r.tool, r.refused]), [
    ['write_to_file', refusal],
    ['view_file', refusal],
    ['run_command', refusal],
    ['some_future_tool', refusal]
  ])
  // A command the model starts IN the session folder (seen with the real model) is refused the same way.
  const inside = await a.run(s.id, ['Wrong folder', `tool: run_command|${JSON.stringify({ CommandLine: 'node -e 1', Cwd: a.sessionDir(s.id) })}`, `write: ${join(a.sessionDir(s.id), 'note.txt')}|hello`].join('\n'))
  assert.deepEqual(inside.results.map((r) => [r.tool, r.refused]), [['run_command', refusal], ['write_to_file', refusal]])
  assert.equal(existsSync(join(a.sessionDir(s.id), 'note.txt')), false)
  assert.deepEqual(a.permissions(), []) // denied outright: no card to click through
  assert.equal(readFileSync(hook, 'utf8'), readFileSync(HOOK, 'utf8'))
  // The refused write shows what it wanted to write; the file that is there was never read for a diff.
  const overwrite = await a.run(s.id, `Overwrite\nwrite: ${join(a.userData, 'config.json')}|{}`)
  assert.equal(overwrite.results[0].refused, refusal)
  for (const item of a.items(s.id)) {
    assert.ok(!JSON.stringify(item).includes('secret'), item.id)
    if (item.kind === 'file-change') assert.ok(!/^-/m.test(item.changes[0].diff), item.changes[0].diff)
  }
  assert.equal(readFileSync(join(a.userData, 'config.json'), 'utf8'), '{"token":"secret"}')
  assert.equal(a.row(s.id)?.state, 'idle')
  await a.close()
})

await t('hash mismatch: a changed hook file stops the session, before a turn and in the middle of one', async () => {
  const a = await stack()
  const s = await a.start({ provider: 'antigravity', cwd: a.work })
  await a.run(s.id, 'Fine\nread: nothing.txt')
  // Before a turn: the prompt is refused and never reaches agy.
  writeFileSync(join(a.sessionDir(s.id), '.agents', 'agy-hook.cjs'), 'process.stdout.write(JSON.stringify({decision:"allow"}))')
  await assert.rejects(a.manager.chatSend(s.id, 'Now\nrun: rm -rf everything'), new RegExp(AGY_TAMPERED.slice(0, 60)))
  const row = a.row(s.id)!
  assert.deepEqual([row.state, row.notice], ['exited', AGY_TAMPERED])
  assert.deepEqual(a.log('ran.log'), [])
  assert.deepEqual(a.log('ungated.log'), [])
  const notices = a.items(s.id).filter((i) => i.kind === 'notice' && i.level === 'error')
  assert.deepEqual(notices.map((i) => i.kind === 'notice' && i.text), [AGY_TAMPERED])
  await assert.rejects(a.manager.chatSend(s.id, 'again'), /the session has ended/)

  // In the middle of a turn: hooks.json is replaced while a card is open. The pending question may
  // still be answered, but the next tool call finds the change: denied, session stopped.
  const b = await a.start({ provider: 'antigravity', cwd: a.work })
  const sent = a.manager.chatSend(b.id, 'Two steps\nrun: one\nrun: two')
  const [p] = await a.pending(b.id)
  await sent
  writeFileSync(join(a.sessionDir(b.id), '.agents', 'mcp_config.json'), '{"mcpServers":{"evil":{"command":"node","args":["x"]}}}')
  a.manager.decide(p.id, { behavior: 'allow' })
  await a.waitState(b.id, 'exited')
  assert.equal(a.row(b.id)?.notice, AGY_TAMPERED)
  assert.deepEqual(a.log('ran.log').map((r) => r.command), ['one']) // `two` never ran
  assert.equal(a.agyTokens.size, 0)
  await a.close()
})

await t('the hook cannot reach the app: every tool call of the turn is refused (fail closed)', async () => {
  const a = await stack({ hookTimeoutMs: 400 })
  const s = await a.start({ provider: 'antigravity', cwd: a.work })
  // The app's server goes away under the running session.
  await a.server.close()
  const answer = await a.run(s.id, 'Try\nrun: npm test\nwrite: x.txt|x\nread: x.txt')
  assert.deepEqual(answer.results.map((r) => [r.tool, /^tool call denied by pre-tool hook: Agent Office could not be asked \(not reachable\)/.test(r.refused ?? '')]), [
    ['run_command', true], ['write_to_file', true], ['view_file', true]
  ])
  assert.deepEqual([a.log('ran.log'), a.log('ungated.log'), existsSync(join(a.work, 'x.txt'))], [[], [], false])
  await a.manager.shutdown()
  a.provider.cli.killSync()

  // The app is there but nobody answers the card: when the hook gives up, the tool is refused and the card goes.
  const b = await stack({ hookTimeoutMs: 600 })
  const t2 = await b.start({ provider: 'antigravity', cwd: b.work })
  const sent = b.manager.chatSend(t2.id, 'Wait for me\nrun: npm test')
  await b.pending(t2.id)
  await sent
  await b.waitState(t2.id, 'idle')
  assert.deepEqual(b.lastAnswer(t2.id).results.map((r) => /could not be asked \(no answer in time\)/.test(r.refused ?? '')), [true])
  assert.deepEqual(b.manager.listPermissions(), [])
  const card = b.items(t2.id).find((i) => i.kind === 'approval')!
  assert.equal(card.kind === 'approval' && card.outcome, 'resolved-elsewhere')
  assert.deepEqual(b.log('ran.log'), [])
  await b.close()
})

await t('prompts while a turn runs: queued for the next turn (and said so); with steering on, handed into the running turn', async () => {
  const a = await stack()
  const s = await a.start({ provider: 'antigravity', cwd: a.work })
  a.state.allowOrders = true
  const first = a.manager.chatSend(s.id, 'First\nrun: sleep 400\nsay: first done')
  const [p] = await a.pending(s.id)
  await first
  // Typed in the chat box, and an order from the order bar, while the turn waits on the inbox.
  await a.manager.chatSend(s.id, 'Second\nsay: second done')
  assert.deepEqual(await a.manager.sendOrder({ target: 'provider:antigravity', text: 'Third\nsay: third done' }), { delivered: [s.id], failed: [] })
  let list = a.items(s.id)
  assert.deepEqual(list.filter((i) => i.kind === 'user').map((i) => i.kind === 'user' && [i.text.split('\n')[0], i.origin, i.turnId]), [['First', 'human', 'turn-1'], ['Second', 'human', undefined], ['Third', 'order', undefined]])
  assert.deepEqual(list.filter((i) => i.kind === 'notice').map((i) => i.kind === 'notice' && i.text), [AGY_QUEUED_NOTE, AGY_QUEUED_NOTE])
  assert.match(AGY_QUEUED_NOTE, /queued and runs as the next turn/)
  a.manager.decide(p.id, { behavior: 'allow' })
  // Each runs as its own turn, in order.
  await until(() => a.items(s.id).filter((i) => i.kind === 'assistant' && !i.streaming).length === 3 && a.row(s.id)?.state === 'idle', 'three answers')
  list = a.items(s.id)
  assert.deepEqual(list.filter((i) => i.kind === 'assistant').map((i) => i.kind === 'assistant' && [i.text.trim(), i.turnId]), [['first done', 'turn-1'], ['second done', 'turn-2'], ['third done', 'turn-3']])
  assert.deepEqual(list.filter((i) => i.kind === 'user').map((i) => i.turnId), ['turn-1', 'turn-2', 'turn-3'])
  assert.ok(list.filter((i) => i.kind === 'notice').every((i) => i.kind === 'notice' && i.text === 'Sent while a turn was running: started when that turn ended.'))
  assert.deepEqual(a.chat.filter((e) => e.type === 'turn').map((e) => e.type === 'turn' && `${e.turnId} ${e.status}`), ['turn-1 started', 'turn-1 completed', 'turn-2 started', 'turn-2 completed', 'turn-3 started', 'turn-3 completed'])
  assert.equal(a.row(s.id)?.lastPrompt, 'Third say: third done')
  // Orders: off -> refused; the targets the order bar offers.
  a.state.allowOrders = false
  assert.match((await a.manager.sendOrder({ target: s.id, text: 'x' })).failed[0].reason, /CEO orders are off/)
  const targets = orderTargets(await a.manager.providers(), a.manager.list(), [])
  assert.deepEqual(targets.map((o) => [o.value, o.label]), [['all', 'Everyone'], ['provider:antigravity', 'All Antigravity'], [s.id, 'Gemini 3.8 Flash']])
  await a.close()

  // Steering on: the prompt goes into the running turn at the next model call.
  const b = await stack({ steer: 'inject' })
  const t2 = await b.start({ provider: 'antigravity', cwd: b.work })
  const one = b.manager.chatSend(t2.id, 'First\nrun: one')
  const [q] = await b.pending(t2.id)
  await one
  await b.manager.chatSend(t2.id, 'Also this\nsay: steered')
  b.manager.decide(q.id, { behavior: 'allow' })
  await until(() => b.row(t2.id)?.state === 'idle' && b.items(t2.id).some((i) => i.kind === 'assistant' && !i.streaming), 'the answer')
  const after = b.items(t2.id)
  assert.deepEqual(after.filter((i) => i.kind === 'assistant').map((i) => i.kind === 'assistant' && i.text.trim()), ['steered']) // one turn, shaped by the second prompt
  assert.deepEqual(after.filter((i) => i.kind === 'notice').map((i) => i.kind === 'notice' && i.text), [AGY_STEERED_NOTE])
  assert.deepEqual(after.filter((i) => i.kind === 'user').map((i) => i.kind === 'user' && [i.origin, i.turnId]), [['human', 'turn-1'], ['steer', 'turn-1']])
  assert.deepEqual(b.chat.filter((e) => e.type === 'turn').map((e) => e.type === 'turn' && e.status), ['started', 'completed'])
  await b.close()
})

await t('interrupt: the process tree is killed, open items are marked, the gate is checked again and the conversation continues in a new process', async () => {
  const a = await stack()
  const s = await a.start({ provider: 'antigravity', cwd: a.work })
  await a.run(s.id, 'Remember this\nread: nothing.txt')
  const conversation = a.row(s.id)?.providerSessionId
  const probes = a.log('hooks-probes.log').length
  // A command that starts a real child process and takes long.
  const sent = a.manager.chatSend(s.id, 'Long one\nchild: 60000\nrun: after')
  const [p] = await a.pending(s.id)
  await sent
  a.manager.decide(p.id, { behavior: 'allow' })
  const childPid = Number(await until(() => (existsSync(join(a.home, 'child.pid')) ? readFileSync(join(a.home, 'child.pid'), 'utf8') : ''), 'the command to start'))
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  assert.equal(alive(childPid), true)
  assert.equal(a.row(s.id)?.state, 'busy')
  a.manager.interrupt(s.id)
  a.manager.interrupt(s.id) // a second click does nothing more
  await until(() => a.row(s.id)?.state === 'starting', 'the respawn to begin', 5000).catch(() => undefined)
  await a.waitState(s.id, 'idle')
  // The command's own child went with the tree.
  await until(() => !alive(childPid), 'the child process to be gone')
  const list = a.items(s.id)
  const cut = list.find((i) => i.kind === 'command' && i.command.startsWith('node child'))!
  assert.equal(cut.kind === 'command' && cut.status, 'interrupted')
  assert.ok(list.some((i) => i.kind === 'notice' && i.text === 'Turn interrupted'))
  assert.deepEqual(a.chat.filter((e) => e.type === 'turn').map((e) => e.type === 'turn' && `${e.turnId} ${e.status}`), ['turn-1 started', 'turn-1 completed', 'turn-2 started', 'turn-2 interrupted'])
  assert.deepEqual(a.log('ran.log'), []) // neither the cut command nor the one after it
  // The respawn: checked again, the same conversation, a new token.
  assert.equal(a.log('hooks-probes.log').length, probes + 1)
  const spawns = a.log('flagged-spawns.log')
  assert.deepEqual(spawns.map((x) => x.conversation), [null, conversation])
  assert.equal(a.row(s.id)?.providerSessionId, conversation)
  assert.equal(a.agyTokens.size, 1)
  const world = a.world.filter((e) => e.agentId === s.id).map((e) => e.activity)
  assert.equal(world[world.length - 1], 'idle')
  assert.ok(!world.includes('done'))
  // A follow-up turn proves the conversation continued (and the new process was briefed again).
  const answer = await a.run(s.id, 'What do you remember?')
  assert.deepEqual(answer.history, ['Remember this'])
  assert.equal(answer.injected.length, 1)
  // An interrupt with a card open: the card is resolved elsewhere.
  const again = a.manager.chatSend(s.id, 'Ask me\nrun: npm test')
  await a.pending(s.id)
  await again
  a.manager.interrupt(s.id)
  await a.waitState(s.id, 'idle')
  assert.deepEqual(a.manager.listPermissions(), [])
  const card = a.items(s.id).filter((i) => i.kind === 'approval').pop()!
  assert.equal(card.kind === 'approval' && card.outcome, 'resolved-elsewhere')
  assert.deepEqual(a.log('ran.log'), [])
  // Interrupting an idle session does nothing.
  a.manager.interrupt(s.id)
  await sleep(100)
  assert.equal(a.row(s.id)?.state, 'idle')

  // If the gate is gone when the session comes back, it does not come back.
  const waiting = a.manager.chatSend(s.id, 'Once more\nrun: sleep 5000')
  const [w] = await a.pending(s.id)
  await waiting
  a.manager.decide(w.id, { behavior: 'allow' })
  await until(() => a.row(s.id)?.state === 'busy', 'busy')
  writeFileSync(join(a.home, 'no-hooks'), '')
  const flagged = a.log('flagged-spawns.log').length
  a.manager.interrupt(s.id)
  await a.waitState(s.id, 'exited')
  assert.match(a.row(s.id)?.notice ?? '', /interrupted, but Antigravity could not be started again: Antigravity did not load Agent Office's approval hook/)
  assert.equal(a.log('flagged-spawns.log').length, flagged)
  assert.deepEqual(a.log('ungated.log'), [])
  await a.close()
})

await t('resume and restore: `--conversation`, wake after a restart, and a conversation agy no longer has', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ao agy '))
  const a = await stack({ root, store: true })
  const s = await a.start({ provider: 'antigravity', cwd: a.work, permissionMode: 'acceptEdits' })
  await a.run(s.id, 'The secret word is plum')
  const conversation = a.row(s.id)!.providerSessionId!
  assert.equal(a.store!.get(s.id)?.providerSessionId, conversation)
  // The app closes (the processes die with it): the record stays open.
  await a.close()
  assert.equal(a.store!.get(s.id)?.status, 'open')

  // A fresh stack ("app restart"): the session is asleep; waking resumes the conversation.
  const b = await stack({ root, store: true })
  assert.deepEqual(b.manager.list().map((x) => [x.id, x.state, x.surface, x.wakeable]), [[s.id, 'asleep', 'chat', true]])
  const woken = await b.manager.wake(s.id)
  assert.deepEqual([woken.id, woken.state, woken.providerSessionId, woken.permissionMode, woken.title], [s.id, 'idle', conversation, 'acceptEdits', 'Gemini 3.8 Flash'])
  const spawned = b.log('flagged-spawns.log').pop()!
  assert.equal(spawned.conversation, conversation)
  assert.ok(b.items(s.id).some((i) => i.kind === 'notice' && /Resumed the earlier conversation/.test(i.text)))
  assert.deepEqual((await b.run(s.id, 'Which word?')).history, ['The secret word is plum'])
  // The same from the new-session path (`resume`).
  await b.manager.stop(s.id)
  const again = await b.start({ provider: 'antigravity', cwd: b.work, resume: conversation })
  assert.equal(again.providerSessionId, conversation)
  await b.close()

  // The conversation is gone (agy warns on stderr and starts a NEW one): detected by comparing the ids.
  rmSync(join(root, 'fake home', 'conversations'), { recursive: true, force: true })
  const c = await stack({ root, store: true })
  const spawnsBefore = c.log('flagged-spawns.log').length
  await assert.rejects(c.start({ provider: 'antigravity', cwd: c.work, resume: conversation }), new RegExp(AGY_CONVERSATION_GONE))
  assert.equal(c.manager.list().filter((x) => x.state !== 'asleep').length, 0)
  // The process that started the stray conversation was killed, and nothing of the session is left.
  assert.equal(c.log('flagged-spawns.log').length, spawnsBefore + 1)
  assert.equal(c.agyTokens.size, 0)
  // Waking the saved row: the restore contract's notice, and the record can never be woken again.
  const asleep = c.manager.list().find((x) => x.state === 'asleep')!
  await assert.rejects(c.manager.wake(asleep.id), new RegExp(CONVERSATION_GONE))
  const ended = c.row(asleep.id)!
  assert.deepEqual([ended.state, ended.notice, ended.providerSessionId, ended.wakeable], ['exited', CONVERSATION_GONE, undefined, undefined])
  assert.equal(c.store!.get(asleep.id)?.providerSessionId, undefined)
  assert.equal(c.provider.conversationGone?.({ error: AGY_CONVERSATION_GONE }), true)
  assert.equal(c.provider.conversationGone?.({ error: 'Antigravity did not start in time' }), false)
  await c.close()
})

await t('office board: the digest reaches the model with the next prompt, a conflicting edit is stopped once, the session cap counts agy sessions', async () => {
  const a = await stack()
  writeFileSync(join(a.work, 'shared.txt'), 'v1\n')
  const one = await a.start({ provider: 'antigravity', cwd: a.work, title: 'Backend', permissionMode: 'acceptEdits' })
  const two = await a.start({ provider: 'antigravity', cwd: a.work, title: 'Frontend', permissionMode: 'acceptEdits' })
  // Backend changes a file and posts a note.
  await a.run(one.id, 'Change it\nreplace: shared.txt|v1|v2\nmcp: agent_office|board_post|{"note":"API renamed"}')
  // Frontend's next prompt carries the digest (after its briefing), once.
  let answer = await a.run(two.id, 'Hello\nread: shared.txt')
  assert.equal(answer.injected.length, 2)
  assert.match(answer.injected[0], /^# Agent Office/)
  assert.match(answer.injected[1], /Team "Backend"/)
  assert.match(answer.injected[1], /API renamed/)
  assert.match(answer.injected[1], /shared\.txt/)
  answer = await a.run(two.id, 'Again\nread: shared.txt')
  assert.deepEqual(answer.injected, []) // no news, no digest
  // Frontend edits the file Backend just changed: refused once with the fixed warning, then it goes through.
  answer = await a.run(two.id, 'Edit\nreplace: shared.txt|v2|v3\nreplace: shared.txt|v2|v3')
  assert.match(answer.results[0].refused ?? '', /^tool call denied by pre-tool hook: .*Backend/)
  assert.deepEqual(answer.results[1], { tool: 'replace_file_content', output: '' })
  assert.equal(readFileSync(join(a.work, 'shared.txt'), 'utf8'), 'v3\n')
  assert.ok(a.items(two.id).some((i) => i.kind === 'notice' && /Office board: this change was stopped once, because team "Backend" changed/.test(i.text)))
  assert.equal(a.board.snapshot().warnings.length, 1)
  // The board switched off: no digest, and the tools answer that it is off.
  a.state.settings = { ...a.state.settings, enabled: false }
  answer = await a.run(one.id, 'Post\nmcp: agent_office|board_post|{"note":"ignored"}')
  assert.match(answer.results[0].refused ?? '', /switched off|off/i)
  a.state.settings = { ...a.state.settings, enabled: true }
  // Each session has its own board token; a session's hook token is not a board token.
  assert.equal(a.boardTokens.size, 2)
  assert.equal(a.agyTokens.size, 2)

  // The cap on live sessions holds for Antigravity like for the others.
  for (let i = 0; i < 6; i++) await a.start({ provider: 'antigravity', cwd: a.work, title: `T${i}` })
  await assert.rejects(a.start({ provider: 'antigravity', cwd: a.work }), /too many sessions \(at most 8 at a time\)/)
  await a.close()
  assert.equal(a.agyTokens.size, 0)
  assert.equal(a.boardTokens.size, 0)
  await until(() => readdirSync(join(a.userData, 'agy-sessions')).length === 0, 'the session folders to be removed')
  assert.deepEqual(a.log('ungated.log'), [])
  assert.deepEqual(a.log('print-turns.log'), []) // no probe ever became a model turn
})

await t('renderer texts: mode help and the model hint for Antigravity', () => {
  assert.deepEqual(modeHints('antigravity'), { default: 'Ask before every command and file change', acceptEdits: 'Edit files in the folder freely; ask for commands', plan: 'Read-only: looks and plans, changes nothing' })
  assert.match(modelPlaceholder('antigravity'), /gemini-3\.8-flash-low/)
})

console.log(`\n${pass} antigravity tests passed\n`)
