// The small part of the `codex app-server` protocol (v2, JSON-RPC over stdio) that the Codex driver
// uses, written by hand from `codex app-server generate-ts` (codex-cli 0.160.0) and the logged
// exchanges in docs/spikes-phase-b.md. The wire carries fields the generated types don't list, so
// everything here is parsed leniently: unknown fields are ignored and missing ones tolerated.
//
// Pure: no Electron, no process handling. Tested in tests/codex.test.ts.
import type { PermissionMode, ProviderInfo, SessionHistoryEntry } from '../../shared/sessions'

export type JsonRpcId = number | string

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const str = (v: unknown, max = 100_000): string => (typeof v === 'string' ? v.slice(0, max) : '')
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

// ---- wire -------------------------------------------------------------------------------------------

export type WireMessage =
  | { kind: 'response'; id: JsonRpcId; result?: unknown; error?: { code?: number; message: string } }
  /** Server -> client request: must be answered with the same id (which can be 0). */
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }

/** One line of the server's stdout. There is no `jsonrpc` member in either direction. */
export function parseWireLine(line: string): WireMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(msg)) return null
  const id = msg.id
  // 0 is a valid id (server request ids start there): never test for truthiness.
  const hasId = typeof id === 'number' || typeof id === 'string'
  const method = typeof msg.method === 'string' ? msg.method : null
  const params = isRecord(msg.params) ? msg.params : {}
  if (method !== null) return hasId ? { kind: 'request', id, method, params } : { kind: 'notification', method, params }
  if (!hasId) return null
  if (isRecord(msg.error)) {
    return { kind: 'response', id, error: { code: num(msg.error.code) ?? undefined, message: str(msg.error.message, 2000) || 'request failed' } }
  }
  return { kind: 'response', id, result: msg.result }
}

/** The thread a notification or server request is about, if any (`thread/started` carries the thread itself). */
export function threadIdOf(params: Record<string, unknown>): string | null {
  if (typeof params.threadId === 'string' && params.threadId) return params.threadId
  if (isRecord(params.thread) && typeof params.thread.id === 'string' && params.thread.id) return params.thread.id
  return null
}

/** The thread that spawned this one (subagents are real threads), if the server says so. */
export function parentThreadIdOf(thread: unknown): string | null {
  if (!isRecord(thread)) return null
  if (typeof thread.parentThreadId === 'string' && thread.parentThreadId) return thread.parentThreadId
  const source = thread.source
  if (isRecord(source) && isRecord(source.subagent) && isRecord(source.subagent.thread_spawn)) {
    const p = source.subagent.thread_spawn.parent_thread_id
    if (typeof p === 'string' && p) return p
  }
  return null
}

export const textInput = (text: string): unknown[] => [{ type: 'text', text, text_elements: [] }]

// ---- thread history ---------------------------------------------------------------------------------

export const HISTORY_PREVIEW_CHARS = 200

/**
 * A `thread/list` result as the "Resume previous…" list: the threads this app started (`originator`
 * is the client name of the `initialize` that created them; the server can't filter on it), newest
 * activity first. Sub-agent threads and ephemeral ones are left out. Times on the wire are Unix
 * seconds, and `updatedAt` does not move with later turns: `recencyAt` does.
 * The rollout path and everything else in the entry stay in the main process.
 */
export function threadHistory(result: unknown, opts: { originator: string; limit?: number }): SessionHistoryEntry[] {
  const out: SessionHistoryEntry[] = []
  for (const t of arr(isRecord(result) ? result.data : null)) {
    if (!isRecord(t)) continue
    const id = str(t.id, 200)
    // The same shape the session manager accepts for `resume`.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) continue
    if (t.originator !== opts.originator || t.ephemeral === true || parentThreadIdOf(t)) continue
    const seconds = num(t.recencyAt) ?? num(t.updatedAt) ?? num(t.createdAt) ?? 0
    const preview = str(t.preview, 4000)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const entry: SessionHistoryEntry = {
      id,
      preview: preview.length > HISTORY_PREVIEW_CHARS ? `${preview.slice(0, HISTORY_PREVIEW_CHARS - 1)}…` : preview,
      updatedAt: Math.round(seconds * 1000)
    }
    const model = str(t.model, 100)
    if (model) entry.model = model
    out.push(entry)
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out.slice(0, opts.limit ?? 20)
}

// ---- permission mode -> approval policy + sandbox ---------------------------------------------------

export type ApprovalPolicy = 'untrusted' | 'on-request'
/** `sandbox` of thread/start and thread/resume. */
export type SandboxMode = 'read-only' | 'workspace-write'
/** `sandbox.type` of the responses, and of the `sandboxPolicy` object turn/start takes. */
export type SandboxType = 'readOnly' | 'workspaceWrite'

export interface CodexPolicy {
  approvalPolicy: ApprovalPolicy
  sandbox: SandboxMode
  sandboxType: SandboxType
  /** For turn/start, which takes the object form. */
  sandboxPolicy: Record<string, unknown>
}

/**
 * The user's decision (docs/spikes-phase-b.md, permission table):
 *   default      untrusted  + workspace-write   every command and edit asks first (CEO inbox)
 *   acceptEdits  on-request + workspace-write   asks only to leave the sandbox
 *   plan         on-request + read-only
 * `never` and `danger-full-access` are not offered.
 */
export function policyFor(mode: PermissionMode): CodexPolicy {
  const readOnly = mode === 'plan'
  const sandboxPolicy = readOnly
    ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  return {
    approvalPolicy: mode === 'default' ? 'untrusted' : 'on-request',
    sandbox: readOnly ? 'read-only' : 'workspace-write',
    sandboxType: readOnly ? 'readOnly' : 'workspaceWrite',
    sandboxPolicy
  }
}

/** `sandbox.type` of a thread/start or thread/resume response. */
export function sandboxTypeOf(response: unknown): string {
  return isRecord(response) && isRecord(response.sandbox) ? str(response.sandbox.type, 60) : ''
}

/**
 * Did the server apply another sandbox than the one asked for? On Windows `workspace-write` silently
 * becomes read-only when the Windows sandbox is not set up. Returns the text of the notice, or null.
 */
export function sandboxMismatch(policy: CodexPolicy, response: unknown): string | null {
  const got = sandboxTypeOf(response)
  if (!got || got === policy.sandboxType) return null
  if (policy.sandboxType === 'workspaceWrite' && got === 'readOnly') {
    return 'Codex is running this session read-only: the workspace-write sandbox was requested, but the Windows sandbox is not set up, so Codex fell back to read-only. Set it up in the Codex app (or `codex` CLI) and start a new session.'
  }
  return `Codex applied the "${got}" sandbox instead of the requested "${policy.sandboxType}".`
}

// ---- login ------------------------------------------------------------------------------------------

/** Hosts the ChatGPT login may be opened on. */
export const LOGIN_HOSTS: readonly string[] = ['auth.openai.com', 'chatgpt.com']

/** Only an https URL on OpenAI's own login hosts is ever handed to the system browser. */
export function isAllowedLoginUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 4096) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false
  if (u.port !== '' && u.port !== '443') return false
  return LOGIN_HOSTS.includes(u.hostname.toLowerCase())
}

// ---- account ----------------------------------------------------------------------------------------

/** `account/read` result -> ProviderInfo.account. An API-key account counts as logged in. */
export function accountInfo(result: unknown): NonNullable<ProviderInfo['account']> {
  const account = isRecord(result) ? result.account : null
  if (!isRecord(account)) return { loggedIn: false }
  const plan = str(account.planType, 40) || (account.type === 'apiKey' ? 'API key' : '')
  return plan ? { loggedIn: true, plan } : { loggedIn: true }
}

/** `account/rateLimits/read` result or an `account/rateLimits/updated` notification -> ProviderInfo.usage. */
export function usageInfo(payload: unknown): ProviderInfo['usage'] | undefined {
  const limits = isRecord(payload) ? payload.rateLimits : null
  const primary = isRecord(limits) ? limits.primary : null
  if (!isRecord(primary)) return undefined
  const usedPercent = num(primary.usedPercent)
  if (usedPercent === null) return undefined
  const usage: NonNullable<ProviderInfo['usage']> = { usedPercent: Math.max(0, Math.min(100, usedPercent)) }
  const resetsAt = num(primary.resetsAt)
  // The server reports Unix seconds.
  if (resetsAt !== null) usage.resetsAt = resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt
  const mins = num(primary.windowDurationMins)
  if (mins !== null) usage.windowMinutes = mins
  return usage
}

// ---- errors -----------------------------------------------------------------------------------------

/** The name of a `codexErrorInfo` (a string, or an object with one key). */
export function errorInfoName(info: unknown): string {
  if (typeof info === 'string') return info
  if (isRecord(info)) return Object.keys(info)[0] ?? ''
  return ''
}

/** HTTP status inside a `codexErrorInfo`, when it has one. */
export function errorInfoStatus(info: unknown): number | null {
  if (!isRecord(info)) return null
  const inner = Object.values(info)[0]
  return isRecord(inner) ? num(inner.httpStatusCode) : null
}

/** Does this turn error mean the account is not (or no longer) logged in? */
export function isAuthError(error: unknown): boolean {
  if (!isRecord(error)) return false
  const info = error.codexErrorInfo
  return errorInfoName(info) === 'unauthorized' || errorInfoStatus(info) === 401
}

export const NOT_LOGGED_IN = 'Not logged in to Codex — use Log in'

/** A turn error as one readable line. */
export function describeTurnError(error: unknown): string {
  if (!isRecord(error)) return 'the turn failed'
  if (isAuthError(error)) return NOT_LOGGED_IN
  switch (errorInfoName(error.codexErrorInfo)) {
    case 'usageLimitExceeded':
      return 'Codex usage limit reached'
    case 'rateLimitExceeded':
      return 'Codex rate limit reached; try again in a moment'
    case 'contextWindowExceeded':
      return 'The conversation no longer fits the model’s context window'
    case 'serverOverloaded':
      return 'Codex is overloaded; try again in a moment'
    default: {
      const message = str(error.message, 400).replace(/\s+/g, ' ').trim()
      return message || 'the turn failed'
    }
  }
}

// ---- commands ---------------------------------------------------------------------------------------

/**
 * The command to show. Codex wraps every command in PowerShell (`powershell.exe -Command "…"`);
 * `commandActions[].command` holds the inner command(s), one per piped stage.
 */
export function innerCommand(command: unknown, commandActions: unknown): string {
  const parts = arr(commandActions)
    .map((a) => (isRecord(a) ? str(a.command, 20_000) : ''))
    .filter((c) => c.length > 0)
  if (parts.length > 0) return parts.join(' | ')
  return str(command, 20_000)
}

export type CommandIntent = 'read' | 'search' | 'list' | 'exec'

/** What a command is for, from Codex's best-effort parse. Any stage it can't classify makes it `exec`. */
export function commandIntent(commandActions: unknown): CommandIntent {
  const types = arr(commandActions).map((a) => (isRecord(a) ? str(a.type, 40) : ''))
  if (types.length === 0 || types.some((t) => t !== 'read' && t !== 'listFiles' && t !== 'search')) return 'exec'
  if (types.every((t) => t === 'search')) return 'search'
  if (types.every((t) => t === 'listFiles')) return 'list'
  return 'read'
}
