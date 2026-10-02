// Codex server requests (the server asks, the client must answer) -> a card for the CEO inbox, and
// the user's decision -> the JSON-RPC result. Pure. Shapes: docs/spikes-phase-b.md, spike 4.
import type { ChatItem } from '../../shared/chat'
import type { PermissionDecision } from '../../shared/sessions'
import { describeToolInput } from '../permissions'
import { arr, innerCommand, isRecord, str } from './codexProtocol'

export interface ApprovalCard {
  /** "Command", "File change", … (PermissionRequestInfo.toolName). */
  toolName: string
  /** One line: "Command: node -e …" or "Edit: path (+2 more)". */
  summary: string
  /** Command + cwd + reason, or the file list with diffs. The registry truncates it. */
  detail: string
  /** The item the request is about (the command or file-change card in the chat). */
  itemId: string
}

export type RequestHandling =
  | { kind: 'card'; card: ApprovalCard }
  /** Something the inbox can't express: answer at once with `result` and tell the user why. */
  | { kind: 'auto'; result: unknown; notice: string }
  | { kind: 'unknown' }

const DETAIL_DIFF_CHARS = 1500

function pathsOf(permissions: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || out.length >= 20) return
    if (typeof v === 'string' && v.length > 0) out.push(v.slice(0, 300))
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (isRecord(v)) Object.values(v).forEach((x) => walk(x, depth + 1))
  }
  walk(permissions, 0)
  return out
}

/**
 * What to do with a server request. `subject` is the chat item with the request's `itemId`: a
 * file-change request carries no paths or diff of its own, the item sent just before it does.
 */
export function describeServerRequest(method: string, params: Record<string, unknown>, subject?: ChatItem): RequestHandling {
  const itemId = str(params.itemId, 200)
  const reason = str(params.reason, 1000)
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      // The inner command, not the PowerShell wrapper Codex runs it in.
      const command = innerCommand(params.command, params.commandActions) || (subject?.kind === 'command' ? subject.command : '')
      const cwd = str(params.cwd, 1000) || (subject?.kind === 'command' ? (subject.cwd ?? '') : '')
      const network = isRecord(params.networkApprovalContext) ? str(params.networkApprovalContext.host, 300) : ''
      const lines = [command || '(command not given)']
      if (cwd) lines.push('', `cwd: ${cwd}`)
      if (network) lines.push(`network: ${network}`)
      if (reason) lines.push(`reason: ${reason}`)
      const what = params.kind === 'writeStdin' ? 'Input to command' : 'Command'
      return { kind: 'card', card: { toolName: 'Command', summary: `${what}: ${command || network || 'run a command'}`, detail: lines.join('\n'), itemId } }
    }
    case 'item/fileChange/requestApproval': {
      const changes = subject?.kind === 'file-change' ? subject.changes : []
      const first = changes[0]?.path ?? ''
      const more = changes.length > 1 ? ` (+${changes.length - 1} more)` : ''
      const lines: string[] = []
      for (const c of changes) {
        lines.push(`${c.change} ${c.path}${c.movedTo ? ` -> ${c.movedTo}` : ''}`)
        if (c.diff) lines.push(c.diff.length > DETAIL_DIFF_CHARS ? `${c.diff.slice(0, DETAIL_DIFF_CHARS)}\n…` : c.diff)
      }
      const root = str(params.grantRoot, 1000)
      if (root) lines.push(`grant write access under: ${root}`)
      if (reason) lines.push(`reason: ${reason}`)
      return { kind: 'card', card: { toolName: 'File change', summary: `Edit: ${first || 'files'}${more}`, detail: lines.join('\n') || 'file change', itemId } }
    }
    case 'item/permissions/requestApproval': {
      const perms = isRecord(params.permissions) ? params.permissions : {}
      const wants: string[] = []
      if (perms.network != null) wants.push('network access')
      if (perms.fileSystem != null) wants.push('file access')
      const paths = pathsOf(perms.fileSystem)
      const lines = [`Codex asks for more permissions for this turn: ${wants.join(' and ') || 'unspecified'}`]
      if (paths.length > 0) lines.push(...paths.map((p) => `  ${p}`))
      const cwd = str(params.cwd, 1000)
      if (cwd) lines.push(`cwd: ${cwd}`)
      if (reason) lines.push(`reason: ${reason}`)
      lines.push('', describeToolInput(perms))
      return { kind: 'card', card: { toolName: 'Permissions', summary: `Permissions: ${wants.join(' + ') || 'more access'}${paths[0] ? ` (${paths[0]})` : ''}`, detail: lines.join('\n'), itemId } }
    }
    case 'mcpServer/elicitation/request': {
      const server = str(params.serverName, 200) || 'MCP server'
      const message = str(params.message, 2000)
      const schema = isRecord(params.requestedSchema) ? params.requestedSchema : {}
      const fields = isRecord(schema.properties) ? Object.keys(schema.properties).length : 0
      // A yes/no question (how Codex asks before a plugin's tool runs) fits a card. A form or a
      // link to open does not: the inbox can't collect input.
      if (params.mode === 'url' || fields > 0) {
        return { kind: 'auto', result: { action: 'decline', content: null, _meta: null }, notice: `${server} asked for input Agent Office can't collect yet, so the request was declined: ${message || '(no message)'}` }
      }
      return { kind: 'card', card: { toolName: 'MCP', summary: `${server}: ${message || 'asks to continue'}`, detail: [`server: ${server}`, message].filter(Boolean).join('\n'), itemId } }
    }
    case 'item/tool/requestUserInput': {
      const questions = arr(params.questions)
        .map((q) => (isRecord(q) ? str(q.question, 300) || str(q.header, 300) : ''))
        .filter(Boolean)
      return { kind: 'auto', result: { answers: {} }, notice: `Codex asked a question Agent Office can't show yet; it was left unanswered${questions.length ? `: ${questions.join(' / ')}` : '.'}` }
    }
    default:
      return { kind: 'unknown' }
  }
}

/**
 * The JSON-RPC result for a decision. allow -> `accept`, deny -> `decline` (the turn goes on and the
 * model is told; a deny message follows as a steer, because the protocol has no field for it).
 * `null` = the app gave up on the request (session stopped): `cancel`.
 */
export function approvalResult(method: string, params: Record<string, unknown>, decision: PermissionDecision | null): unknown {
  const allow = decision?.behavior === 'allow'
  switch (method) {
    case 'item/permissions/requestApproval': {
      if (!allow) return { permissions: {}, scope: 'turn' }
      // Exactly what was asked for, for this turn only.
      const asked = isRecord(params.permissions) ? params.permissions : {}
      const granted: Record<string, unknown> = {}
      if (asked.network != null) granted.network = asked.network
      if (asked.fileSystem != null) granted.fileSystem = asked.fileSystem
      return { permissions: granted, scope: 'turn' }
    }
    case 'mcpServer/elicitation/request':
      return allow ? { action: 'accept', content: {}, _meta: null } : { action: decision ? 'decline' : 'cancel', content: null, _meta: null }
    default:
      return { decision: allow ? 'accept' : decision ? 'decline' : 'cancel' }
  }
}
