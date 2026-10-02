// The permission policy of a hosted Antigravity (`agy`) session. Hosted agy sessions run with
// `--dangerously-skip-permissions` (a hook `allow` does not lift agy's own headless soft-deny, see
// docs/spikes-phase-c.md), so the app's PreToolUse hook is the only gate and THIS table is agy's
// permission system: tool + arguments + the session's mode + its folder + the paths that belong to
// the app  ->  allow | ask the user (a CEO inbox card) | deny with a reason.
//
// Pure: no clock, no I/O. Paths are compared as text after the caller resolved links
// (`realPath`, optional). When in doubt the answer is `ask`, never `allow`.
import { posix, win32 } from 'node:path'
import type { PermissionMode } from '../../shared/sessions'
import { plainPermission, type PermissionRisk, type PlainPermission } from '../../shared/permissionText'
import { BOARD_SERVER_AGY, BOARD_TOOL_NAMES } from '../boardMcp'
import { describeToolInput } from '../permissions'

export const PLAN_DENY_REASON = 'plan mode: read-only. Describe the change instead of making it.'
export const PROTECTED_DENY_REASON =
  'That path belongs to Agent Office itself (its settings and the files that host this session). It cannot be read or changed from a session.'
export const SUBAGENT_DENY_REASON =
  'Not available in an Agent Office session: Agent Office could not check what a sub-agent, a workflow or a scheduled task does. Do the work in this conversation instead.'

export type AgyToolClass =
  | 'command' //   runs something: run_command, send_command_input, notebook_execution
  | 'write' //     creates or changes a file
  | 'read' //      reads, lists or searches files
  | 'web' //       search_web, read_url_content
  | 'browser' //   drives or looks at the browser
  | 'mcp' //       an MCP tool or resource of another server
  | 'board' //     the app's own office-board tools
  | 'delegate' //  sub-agents, workflows, schedules: actions the gate may not see
  | 'passive' //   no effect outside the conversation (finish, wait, command_status)
  | 'request' //   the agent asks for more access
  | 'unknown'

const COMMAND_TOOLS: readonly string[] = ['run_command', 'send_command_input', 'notebook_execution']
export const AGY_WRITE_TOOLS: readonly string[] = ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit', 'generate_image']
export const AGY_READ_TOOLS: readonly string[] = ['view_file', 'list_dir', 'find_by_name', 'grep_search', 'view_file_outline', 'view_code_item']
const WEB_TOOLS: readonly string[] = ['search_web', 'read_url_content']
const BROWSER_TOOLS: readonly string[] = ['open_browser_url', 'read_browser_page', 'list_browser_pages', 'capture_browser_screenshot', 'capture_browser_console_logs', 'click_browser_pixel', 'execute_browser_javascript']
const MCP_TOOLS: readonly string[] = ['call_mcp_tool', 'read_resource', 'list_resources']
const DELEGATE_TOOLS: readonly string[] = ['invoke_subagent', 'browser_subagent', 'manage_subagents', 'run_workflow', 'schedule']
const PASSIVE_TOOLS: readonly string[] = ['finish', 'wait', 'wait_5_seconds', 'command_status', 'list_permissions', 'ask_question']
const REQUEST_TOOLS: readonly string[] = ['ask_permission', 'ask_custom_permission']

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 100_000): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Is this agy tool call one of the office board's own tools? */
export function isAgyBoardCall(tool: string, args: unknown): boolean {
  if (tool !== 'call_mcp_tool' || !isRecord(args)) return false
  return args.ServerName === BOARD_SERVER_AGY && (BOARD_TOOL_NAMES as readonly string[]).includes(str(args.ToolName, 100))
}

export function agyToolClass(tool: string, args?: unknown): AgyToolClass {
  if (isAgyBoardCall(tool, args)) return 'board'
  if (COMMAND_TOOLS.includes(tool)) return 'command'
  if (AGY_WRITE_TOOLS.includes(tool)) return 'write'
  if (AGY_READ_TOOLS.includes(tool)) return 'read'
  if (WEB_TOOLS.includes(tool)) return 'web'
  if (BROWSER_TOOLS.includes(tool) || tool.startsWith('browser_')) return tool === 'browser_subagent' ? 'delegate' : 'browser'
  if (MCP_TOOLS.includes(tool)) return 'mcp'
  if (DELEGATE_TOOLS.includes(tool)) return 'delegate'
  if (PASSIVE_TOOLS.includes(tool)) return 'passive'
  if (REQUEST_TOOLS.includes(tool)) return 'request'
  return 'unknown'
}

/** Argument names that hold a file or folder path (agy's own naming: TargetFile, AbsolutePath, DirectoryPath, …). */
const PATH_KEY = /(File|Path|Directory|Dir|Folder|Notebook|Cwd)$/
/** …except these, which hold text. */
const NOT_A_PATH = /^(TargetContent|ReplacementContent|CodeContent)$/

/** The file and folder paths a tool call names, as written. */
export function agyPathArgs(args: unknown): string[] {
  if (!isRecord(args)) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4000) continue
    if (PATH_KEY.test(key) && !NOT_A_PATH.test(key)) out.push(value)
  }
  return out
}

export interface AgyPolicyInput {
  tool: string
  args: unknown
  mode: PermissionMode
  /** The session's working folder, absolute. */
  cwd: string
  /** Folders of the app that no session may touch: its per-session folder, the app's userData. Absolute. */
  protectedPaths: readonly string[]
  /** Who asks, for the card's sentence: the session's title. */
  who: string
  /** Resolves links (junctions, symlinks) of an absolute path as far as it exists. Default: as it is. */
  realPath?: (path: string) => string
  /** Well-known folders, to recognise `%APPDATA%\…`, `$env:APPDATA\…`, `~\…` spellings of a protected path. */
  env?: Readonly<Record<string, string | undefined>>
  /** Default: the platform this runs on. */
  platform?: NodeJS.Platform
}

export interface AgyCard {
  /** "Command", "Create", "Edit", "Read", "WebFetch", "mcp", … (what shared/permissionText.ts understands). */
  toolName: string
  /** One line: "Command: npm test". */
  summary: string
  /** The raw request for "Details". */
  detail: string
  plain: PlainPermission
}

export type AgyVerdict =
  | { action: 'allow'; cls: AgyToolClass }
  | { action: 'deny'; cls: AgyToolClass; reason: string }
  | { action: 'ask'; cls: AgyToolClass; card: AgyCard }

// ---- paths ------------------------------------------------------------------------------------------

interface PathKit {
  win: boolean
  /** Absolute, forward slashes, no trailing slash, lower case on Windows. */
  key(path: string, base: string): string
}

function kit(platform: NodeJS.Platform): PathKit {
  const win = platform === 'win32'
  const p = win ? win32 : posix
  return {
    win,
    key(path, base) {
      let abs = path.trim().replace(/^file:\/\/\/?/i, win ? '' : '/')
      abs = p.resolve(base, abs)
      abs = abs.replace(/\\/g, '/').replace(/\/+$/, '')
      return win ? abs.toLowerCase() : abs
    }
  }
}

const insideKey = (file: string, root: string): boolean => root.length > 0 && (file === root || file.startsWith(`${root}/`))

/**
 * Text as a shell would join it, for finding a path inside a command: quotes, carets and backticks
 * removed, every run of slashes (either kind) one forward slash, lower case.
 */
export function flattenForPathSearch(text: string, win: boolean): string {
  const t = text.replace(/["'`^]/g, '').replace(/[\\/]+/g, '/')
  return win ? t.toLowerCase() : t
}

const ENV_SPELLINGS: Record<string, (name: string) => string[]> = {
  win: (name) => [`%${name}%`, `$env:${name}`, `\${env:${name}}`],
  posix: (name) => [`$${name}`, `\${${name}}`]
}

/** Every way a protected folder may be written in a command: the path itself, and through an environment variable or `~`. */
function spellings(root: string, env: Readonly<Record<string, string | undefined>>, k: PathKit): string[] {
  const out = new Set<string>([root])
  const vars = k.win ? ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEPATH', 'TEMP', 'TMP', 'ProgramData'] : ['HOME', 'XDG_CONFIG_HOME', 'TMPDIR']
  for (const name of vars) {
    const value = env[name]
    if (!value) continue
    const base = k.key(value, value)
    if (!insideKey(root, base)) continue
    const rest = root.slice(base.length) // "" or "/…"
    for (const spelling of ENV_SPELLINGS[k.win ? 'win' : 'posix'](name)) out.add(`${k.win ? spelling.toLowerCase() : spelling}${rest}`)
    if (name === 'USERPROFILE' || name === 'HOME') {
      out.add(`~${rest}`)
      out.add(`$home${rest}`)
    }
  }
  return [...out]
}

/** The longest relative tail of a protected folder that is worth looking for ("appdata/roaming/agent-office"). */
function tails(root: string): string[] {
  const parts = root.split('/').filter(Boolean)
  const out: string[] = []
  // Two or more segments: one alone ("agent-office") is too common a word to mean the folder.
  for (let n = Math.min(parts.length - 1, 3); n >= 2; n--) out.push(parts.slice(parts.length - n).join('/'))
  return out
}

/** Names that only the app's own session folders have. */
const OWN_MARKERS: readonly string[] = ['agy-sessions', 'agy-hook', 'agy-board-mcp']
/** A command that names an agent's own configuration. */
const AGENT_CONFIG_IN_COMMAND = /(^|[\\/\s"'=])\.(agents|gemini|claude|codex)([\\/]|$|\s|["'])|hooks\.json|mcp_config\.json/i

type Touch = 'protected' | 'maybe' | 'no'

/** Every string in a tool's arguments (values and keys, any depth), as written. */
function allStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 2000 || depth > 8) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out, depth + 1)
  else if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) {
      out.push(key)
      allStrings(v, out, depth + 1)
    }
  }
  return out
}

function touchesProtected(input: AgyPolicyInput, cls: AgyToolClass, k: PathKit): Touch {
  const roots = input.protectedPaths.map((r) => k.key(r, r)).filter((r) => r.length > 0)
  if (roots.length === 0) return 'no'
  const real = input.realPath ?? ((p: string) => p)
  const args = isRecord(input.args) ? input.args : {}

  // 1. A path argument that is (or resolves into) a protected folder.
  for (const raw of agyPathArgs(args)) {
    const direct = k.key(raw, input.cwd)
    let resolved = direct
    try {
      resolved = k.key(real(k.win ? win32.resolve(input.cwd, raw) : posix.resolve(input.cwd, raw)), input.cwd)
    } catch {
      resolved = direct
    }
    if (roots.some((r) => insideKey(direct, r) || insideKey(resolved, r))) return 'protected'
  }

  // A file tool is judged by the file it names: its content or search text may mention any path.
  if (cls === 'read' || cls === 'write' || cls === 'passive') return 'no'

  // 2. The path written anywhere in the arguments: a command line, a script, a tool's input.
  const text = flattenForPathSearch(allStrings(args).join('\n'), k.win)
  const env = input.env ?? {}
  for (const root of roots) {
    for (const s of spellings(root, env, k)) if (text.includes(flattenForPathSearch(s, k.win))) return 'protected'
  }
  // 3. Not the path itself, but something that smells of it.
  for (const root of roots) for (const tail of tails(root)) if (text.includes(tail)) return 'maybe'
  if (OWN_MARKERS.some((m) => text.includes(m))) return 'maybe'
  return 'no'
}

// ---- cards ------------------------------------------------------------------------------------------

const worst = (a: PermissionRisk, b: PermissionRisk): PermissionRisk => (a === 'danger' || b === 'danger' ? 'danger' : a === 'caution' || b === 'caution' ? 'caution' : 'normal')
const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** At least `risk`, keeping a note the sentence builder already gave for something worse. */
function atLeast(plain: PlainPermission, risk: PermissionRisk, note: string): PlainPermission {
  const next = worst(plain.risk, risk)
  if (next === plain.risk && plain.riskNote) return plain
  return { ...plain, risk: next, riskNote: next === plain.risk ? (plain.riskNote ?? note) : note }
}

/** The request as the CEO inbox shows it (spike 9 d of docs/spikes-phase-c.md). */
export function agyCard(tool: string, rawArgs: unknown, cwd: string, who: string, cls = agyToolClass(tool, rawArgs)): AgyCard {
  const args = isRecord(rawArgs) ? rawArgs : {}
  const sentence = (name: string, input: unknown): PlainPermission => plainPermission({ who, tool: name, input, cwd })
  const file = agyPathArgs(args)[0] ?? ''

  switch (cls) {
    case 'command': {
      if (tool === 'run_command') {
        const command = str(args.CommandLine, 20_000)
        const runIn = str(args.Cwd, 2000)
        return { toolName: 'Command', summary: `Command: ${oneLine(command)}`, detail: runIn ? `${command}\n\nin ${runIn}` : command, plain: sentence('Command', { command }) }
      }
      const what = tool === 'send_command_input' ? `input to a running command: ${str(args.Input, 2000)}` : `${tool} ${describeToolInput(args)}`
      return { toolName: 'Command', summary: `Command: ${oneLine(what)}`, detail: describeToolInput(args), plain: sentence('Command', { command: what }) }
    }
    case 'write': {
      const creating = tool === 'write_to_file' && args.Overwrite !== true
      const name = tool === 'write_to_file' ? (creating ? 'Create' : 'Write') : 'Edit'
      const body = str(args.CodeContent, 4000) || str(args.ReplacementContent, 4000)
      const detail = body ? `${file}\n\n${body}` : describeToolInput(args)
      return { toolName: name, summary: `${name}: ${file || tool}`, detail, plain: sentence(name, { file_path: file }) }
    }
    case 'read': {
      const target = file || str(args.Pattern, 400) || str(args.Query, 400)
      return { toolName: 'Read', summary: `Read: ${oneLine(target || tool)}`, detail: describeToolInput(args), plain: sentence('Read', { file_path: file, pattern: str(args.Pattern, 400) || str(args.Query, 400) }) }
    }
    case 'web': {
      if (tool === 'search_web') {
        const query = str(args.query, 1000) || str(args.Query, 1000)
        return { toolName: 'WebSearch', summary: `Web search: ${oneLine(query)}`, detail: describeToolInput(args), plain: atLeast(sentence('WebSearch', { query }), 'caution', 'Uses the internet') }
      }
      const url = str(args.Url, 2000) || str(args.url, 2000)
      return { toolName: 'WebFetch', summary: `Web page: ${oneLine(url)}`, detail: describeToolInput(args), plain: atLeast(sentence('WebFetch', { url }), 'caution', 'Uses the internet') }
    }
    case 'browser': {
      const url = str(args.Url, 2000) || str(args.url, 2000)
      const plain = atLeast(sentence('mcp', { server: 'the built-in browser', tool }), 'caution', 'Controls your browser')
      return { toolName: 'Browser', summary: `Browser: ${oneLine(url ? `${tool} ${url}` : tool)}`, detail: describeToolInput(args), plain }
    }
    case 'mcp': {
      const server = str(args.ServerName, 200)
      const name = tool === 'call_mcp_tool' ? str(args.ToolName, 200) : tool
      return { toolName: 'mcp', summary: `MCP: ${server ? `${server} · ` : ''}${name}`, detail: describeToolInput(args), plain: sentence('mcp', { server, tool: name }) }
    }
    case 'request': {
      const wants = [str(args.Action, 100), str(args.Target, 300)].filter(Boolean).join(' ')
      const reason = str(args.Reason, 1000)
      return { toolName: 'Permissions', summary: `More access: ${oneLine(wants || tool)}`, detail: reason ? `${wants}\n\n${reason}` : describeToolInput(args), plain: sentence('Permissions', { wants: wants ? [wants] : [] }) }
    }
    default:
      return { toolName: tool || 'unknown', summary: `${tool || 'unknown tool'}`, detail: describeToolInput(args), plain: sentence(tool, args) }
  }
}

// ---- the table --------------------------------------------------------------------------------------

/**
 * | class     | default | acceptEdits                               | plan  |
 * |-----------|---------|-------------------------------------------|-------|
 * | board     | allow   | allow                                     | allow |
 * | passive   | allow   | allow                                     | allow |
 * | read      | allow inside the folder (ask for a secrets file, or outside)       |
 * | write     | ask     | allow inside the folder if nothing is odd | deny  |
 * |           |         | (an absolute path, no secrets file, no agent settings)    |
 * | command   | ask     | ask                                       | deny  |
 * | web, browser, mcp, request, unknown | ask in every mode                   |
 * | delegate  | deny in every mode (its actions could not be checked)             |
 * Before all of it: anything that touches the app's own folders is denied.
 */
export function agyPolicy(input: AgyPolicyInput): AgyVerdict {
  const k = kit(input.platform ?? process.platform)
  const tool = input.tool
  const cls = agyToolClass(tool, input.args)

  // The board's tools take no path and reach nothing but the board.
  if (cls === 'board') return { action: 'allow', cls }

  const touch = touchesProtected(input, cls, k)
  if (touch === 'protected') return { action: 'deny', cls, reason: PROTECTED_DENY_REASON }
  if (cls === 'delegate') return { action: 'deny', cls, reason: SUBAGENT_DENY_REASON }
  if (cls === 'passive') return { action: 'allow', cls }
  if (input.mode === 'plan' && (cls === 'command' || cls === 'write')) return { action: 'deny', cls, reason: PLAN_DENY_REASON }

  let card = agyCard(tool, input.args, input.cwd, input.who, cls)
  const cwdKey = k.key(input.cwd, input.cwd)
  const paths = agyPathArgs(input.args)
  const real = input.realPath ?? ((p: string) => p)
  const allInside = paths.every((raw) => {
    const direct = k.key(raw, input.cwd)
    let resolved = direct
    try {
      resolved = k.key(real(k.win ? win32.resolve(input.cwd, raw) : posix.resolve(input.cwd, raw)), input.cwd)
    } catch {
      return false
    }
    return insideKey(direct, cwdKey) && insideKey(resolved, cwdKey)
  })
  if (!allInside) card = { ...card, plain: atLeast(card.plain, 'caution', 'Outside the project folder') }
  if (touch === 'maybe') card = { ...card, plain: { ...card.plain, risk: 'danger', riskNote: "May touch Agent Office's own files" } }
  else if (cls === 'command' && AGENT_CONFIG_IN_COMMAND.test(allStrings(input.args).join('\n'))) {
    card = { ...card, plain: atLeast(card.plain, 'danger', 'May change agent settings') }
  }
  const ordinary = allInside && touch === 'no' && card.plain.risk === 'normal'

  if (cls === 'read' && ordinary) return { action: 'allow', cls }
  // A file tool that names no file is not "an edit inside the folder". Nor is one that names it
  // relatively: which folder agy resolves that against is not known (it has two workspaces).
  const absolute = paths.length > 0 && paths.every((raw) => (k.win ? win32 : posix).isAbsolute(raw))
  if (cls === 'write' && input.mode === 'acceptEdits' && ordinary && absolute && tool !== 'generate_image') return { action: 'allow', cls }
  return { action: 'ask', cls, card }
}
