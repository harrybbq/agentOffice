// Turns a raw permission request (tool name + input) into ONE plain sentence a non-expert can judge
// at a glance, plus a risk level. Pure and provider-neutral: Claude tool names (Bash, Write, …) and
// Codex card kinds (Command, Edit, Create, Delete, Permissions, MCP) both work.
// Deterministic templates only — never ask a model to summarise what it is asking permission for.

export type PermissionRisk = 'normal' | 'caution' | 'danger'

export interface PlainPermission {
  /** "Sonnet 5.5 wants to run the tests (`npm test`)." Always one sentence, <= ~160 chars. */
  question: string
  risk: PermissionRisk
  /** Short reason shown next to the risk badge, e.g. "Deletes files". */
  riskNote?: string
}

export interface PermissionSubject {
  /** Who is asking, as shown in the office: "Sonnet 5.5", "Explore (Sonnet 5.5's team)". */
  who: string
  tool: string
  input: unknown
  /** The session's working folder, to tell "inside the project" from "outside". */
  cwd?: string
}

const MAX_QUOTE = 56

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const clip = (s: string, n = MAX_QUOTE): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const baseName = (p: string): string => norm(p).split('/').pop() || p
const code = (s: string): string => '`' + clip(s.replace(/\s+/g, ' ').trim()) + '`'

function isInside(file: string, cwd?: string): boolean {
  if (!cwd) return true
  const f = norm(file).toLowerCase()
  const c = norm(cwd).toLowerCase()
  if (!/^([a-z]:|\/)/.test(f)) return !f.split('/').includes('..') // relative path
  return f === c || f.startsWith(c + '/')
}

const SENSITIVE = /(^|[\\/])(\.env(\.[\w.-]+)?|\.ssh|\.aws|\.gnupg|id_(rsa|ed25519)[\w.]*|credentials(\.\w+)?|\.npmrc|\.netrc|auth\.json|secrets?(\.\w+)?)($|[\\/])/i
const AGENT_CONFIG = /(^|[\\/])\.(claude|codex|gemini)([\\/]|$)/i

function fileRisk(file: string, cwd: string | undefined, writing: boolean): Pick<PlainPermission, 'risk' | 'riskNote'> {
  if (SENSITIVE.test(file)) return { risk: 'danger', riskNote: writing ? 'Changes a secrets file' : 'Reads a secrets file' }
  if (AGENT_CONFIG.test(file) && writing) return { risk: 'danger', riskNote: 'Changes agent settings' }
  if (!isInside(file, cwd)) return { risk: 'caution', riskNote: 'Outside the project folder' }
  return { risk: 'normal' }
}

interface CommandRule {
  test: RegExp
  say: string | ((m: RegExpMatchArray, cmd: string) => string)
  risk?: PermissionRisk
  note?: string
  /** Don't append the raw command in backticks (the sentence already says it all). */
  bare?: boolean
}

// First match wins. Order: most dangerous first.
const COMMAND_RULES: CommandRule[] = [
  { test: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(sh|bash|zsh|iex|invoke-expression|powershell|pwsh|node|python\d?)\b/i, say: 'download a script from the internet and run it', risk: 'danger', note: 'Runs downloaded code' },
  { test: /\b(sudo|runas|doas)\b|start-process[^|]*-verb\s+runas/i, say: 'run a command with administrator rights', risk: 'danger', note: 'Admin rights' },
  { test: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+|\b(rmdir|rd)\s+\/s|\bremove-item\b[^|]*-recurse|\bdel\s+\/s|\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=/i, say: 'delete files or folders permanently', risk: 'danger', note: 'Deletes files' },
  { test: /\bgit\s+push\b[^|;&]*(--force|-f\b)/i, say: 'overwrite history on the remote repository (force push)', risk: 'danger', note: 'Force push' },
  { test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fd]|checkout\s+--\s|restore\s+(?!--staged))/i, say: 'throw away uncommitted changes', risk: 'danger', note: 'Discards work' },
  { test: /\b(shutdown|restart-computer|stop-computer|reboot)\b|\btaskkill\b|\bstop-process\b|\bkill(all)?\s+-?9?/i, say: 'stop running programs', risk: 'caution', note: 'Stops processes' },
  { test: /\b(rm|del|erase|remove-item|rmdir|rd|unlink)\b/i, say: 'delete files', risk: 'caution', note: 'Deletes files' },
  { test: /\bgit\s+push\b/i, say: 'upload commits to the remote repository', risk: 'caution', note: 'Publishes code' },
  { test: /\b(gh\s+(pr|issue|release)\s+(create|merge|close|comment)|gh\s+repo\s+(create|delete))\b/i, say: 'change something on GitHub', risk: 'caution', note: 'Acts on GitHub' },
  { test: /\b(npm|pnpm|yarn|bun)\s+(publish)\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, say: 'publish a package publicly', risk: 'danger', note: 'Publishes publicly' },
  { test: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip\d?\s+install\b|\bcargo\s+(add|install)\b|\bwinget\s+install\b|\bchoco\s+install\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b/i, say: 'install software packages', risk: 'caution', note: 'Installs software' },
  { test: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i, say: (_m, cmd) => `download from ${hostOf(cmd) || 'the internet'}`, risk: 'caution', note: 'Uses the internet' },
  { test: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|vitest|jest|mocha)\b|\b(cargo|go|dotnet)\s+test\b|\btsx\s+tests?[\\/]/i, say: 'run the tests' },
  { test: /\b(npm|pnpm|yarn|bun)\s+run\s+(build|typecheck|lint|format)\b|\b(tsc|eslint|prettier)\b|\b(cargo|go|dotnet)\s+build\b|\bmake\b/i, say: 'build or check the project' },
  { test: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b/i, say: 'start the app' },
  { test: /\bgit\s+(status|diff|log|show|branch|remote|rev-parse|ls-files|blame)\b/i, say: 'look at the git history (read-only)' },
  { test: /\bgit\s+(add|commit|stash|tag|switch|checkout|merge|rebase|pull|fetch|worktree)\b/i, say: 'update the local git repository' },
  { test: /\bdocker\b|\bdocker-compose\b|\bkubectl\b/i, say: 'run containers', risk: 'caution', note: 'Runs containers' },
  { test: /\b(mkdir|md|new-item)\b/i, say: 'create a folder or file' },
  { test: /\b(mv|move|move-item|ren|rename-item)\b/i, say: 'move or rename files' },
  { test: /\b(cp|copy|copy-item|xcopy|robocopy)\b/i, say: 'copy files' },
  { test: /^\s*(ls|dir|cat|type|get-content|get-childitem|grep|rg|findstr|find|head|tail|wc|tree|pwd|where|which|echo|select-string)\b/i, say: 'look at files (read-only)' },
  { test: /\b(node|python\d?|deno|bun|ruby|php|pwsh|powershell)\s+(-e|-c|--eval|-command)\b/i, say: 'run a short script' },
  { test: /\b(node|python\d?|deno|bun|ruby|php|tsx|ts-node)\s+([\w./\\-]+\.\w+)/i, say: (m) => `run the script ${baseName(m[2])}`, bare: true }
]

function hostOf(text: string): string {
  const m = text.match(/https?:\/\/([^\s/'"`)]+)/i)
  return m ? m[1].replace(/^www\./, '') : ''
}

/** Strips `cd x &&` prefixes and PowerShell/cmd wrappers so rules see the real command. */
function innerCommand(raw: string): string {
  let c = raw.trim()
  const wrapped = c.match(/^"?[^"]*(?:powershell|pwsh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|\/c)\s+"([\s\S]*)"$/i)
  if (wrapped) c = wrapped[1].replace(/\\"/g, '"')
  for (let i = 0; i < 3; i++) {
    const cd = c.match(/^(?:cd|set-location|pushd)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*([\s\S]+)$/i)
    if (!cd) break
    c = cd[1]
  }
  return c.trim()
}

function describeCommand(raw: string): { say: string; risk: PermissionRisk; note?: string } {
  const cmd = innerCommand(raw)
  if (!cmd) return { say: 'run a command', risk: 'normal' }
  for (const r of COMMAND_RULES) {
    const m = cmd.match(r.test)
    if (!m) continue
    const text = typeof r.say === 'function' ? r.say(m, cmd) : r.say
    return { say: r.bare ? text : `${text} (${code(cmd)})`, risk: r.risk ?? 'normal', note: r.note }
  }
  return { say: `run the command ${code(cmd)}`, risk: 'normal' }
}

function where(file: string, cwd?: string): string {
  if (!file) return ''
  if (!cwd || !isInside(file, cwd)) return ` (${clip(norm(file), 70)})`
  return ''
}

const worst = (a: PermissionRisk, b: PermissionRisk): PermissionRisk =>
  a === 'danger' || b === 'danger' ? 'danger' : a === 'caution' || b === 'caution' ? 'caution' : 'normal'

export function plainPermission(p: PermissionSubject): PlainPermission {
  const who = p.who.trim() || 'An agent'
  const input = obj(p.input)
  const tool = p.tool
  const t = tool.toLowerCase()
  const done = (action: string, risk: PermissionRisk = 'normal', riskNote?: string): PlainPermission => ({
    question: `${who} wants to ${action}.`,
    risk,
    ...(riskNote ? { riskNote } : {})
  })

  // ---- shell ----
  if (t === 'bash' || t === 'powershell' || t === 'command' || t === 'shell') {
    const d = describeCommand(str(input.command) || str(input.cmd) || str(input.script))
    return done(d.say, d.risk, d.note)
  }

  // ---- files ----
  const file = str(input.file_path) || str(input.path) || str(input.notebook_path) || str(input.file)
  if (t === 'write' || t === 'create') {
    const r = fileRisk(file, p.cwd, true)
    return done(`${t === 'create' ? 'create' : 'write'} the file ${baseName(file) || 'a file'}${where(file, p.cwd)}`, r.risk, r.riskNote)
  }
  if (t === 'edit' || t === 'multiedit' || t === 'notebookedit' || t === 'update') {
    const r = fileRisk(file, p.cwd, true)
    const more = typeof input.more === 'number' && input.more > 0 ? ` and ${input.more} more` : ''
    return done(`change the file ${baseName(file) || 'a file'}${more}${where(file, p.cwd)}`, r.risk, r.riskNote)
  }
  if (t === 'delete') {
    const r = fileRisk(file, p.cwd, true)
    return done(`delete the file ${baseName(file) || 'a file'}${where(file, p.cwd)}`, worst(r.risk, 'caution'), r.riskNote ?? 'Deletes a file')
  }
  if (t === 'read' || t === 'glob' || t === 'grep' || t === 'ls') {
    const target = file || str(input.pattern)
    const r = file ? fileRisk(file, p.cwd, false) : { risk: 'normal' as const }
    return done(`read ${file ? `the file ${baseName(file)}` : target ? `files matching ${code(target)}` : 'files'}${where(file, p.cwd)}`, r.risk, r.riskNote)
  }

  // ---- web ----
  if (t === 'webfetch') return done(`open the web page ${hostOf(str(input.url)) || clip(str(input.url)) || 'a web page'}`)
  if (t === 'websearch') return done(`search the web for “${clip(str(input.query), 70)}”`)

  // ---- helpers ----
  if (t === 'agent' || t === 'task') {
    const what = str(input.description) || str(input.subagent_type)
    return done(`start a helper agent${what ? ` to ${clip(what.charAt(0).toLowerCase() + what.slice(1), 70)}` : ''}`)
  }

  // ---- Codex "more access" ----
  if (t === 'permissions') {
    const wants = Array.isArray(input.wants) ? input.wants.filter((x): x is string => typeof x === 'string') : []
    return done(`get more access${wants.length ? `: ${wants.join(' and ')}` : ''}`, 'caution', 'Leaves the sandbox')
  }

  // ---- MCP / plugins ----
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  if (mcp || t === 'mcp') {
    const server = mcp ? mcp[1].replace(/^plugin_/, '').replace(/_/g, ' ') : str(input.server)
    const name = (mcp ? mcp[2] : str(input.tool)).replace(/_/g, ' ')
    const screen = /screenshot|computer|click|type|key|mouse|browser|navigate/i.test(mcp ? mcp[2] : name)
    if (screen) return done(`control or look at your screen/browser (${name}, from ${server || 'a plugin'})`, 'caution', 'Controls your screen')
    return done(`use the “${clip(name, 40)}” tool from ${server || 'a plugin'}`)
  }

  return done(`use the ${tool || 'unknown'} tool`)
}
