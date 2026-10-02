// Codex thread items -> what the character does in the world (AgentEvent activity + detail).
// The table is spike 5 of docs/spikes-phase-b.md. Pure; the driver feeds the result to the same
// actor bookkeeping the Claude driver uses (ClaudeHookMapper.activity / waiting / resume / settle).
//
// Sub-agents were not exercised in the spikes, so everything about them is parsed defensively.
import { DETAIL_DELEGATING, DETAIL_PLANNING, fileDetail } from '../../shared/details'
import type { Activity } from '../../shared/events'
import type { TokenUsage } from '../../shared/inspector'
import { relativeTo } from '../../shared/paths'
import { BOARD_ACTIVITY, BOARD_ACTIVITY_DETAIL, CAPTURE_TOOL_PATTERN } from '../adapters/claude-code-hooks'
import { BOARD_SERVER_CODEX } from '../boardMcp'
import { arr, commandIntent, innerCommand, isRecord, str } from './codexProtocol'

export const CODEX_PROVIDER = 'codex'

export interface WorldActivity {
  activity: Activity
  detail: string
}

/**
 * What `item/started` means for the world, or null when the item is not an activity (messages,
 * reasoning). A plan is `write` with a "planning: " detail, and a secrets-like file gets the
 * "secrets: " prefix (shared/details.ts). `cwd` is the session's folder: changed files under it are named relative to it.
 */
export function worldActivityForItem(item: unknown, cwd?: string): WorldActivity | null {
  if (!isRecord(item)) return null
  switch (item.type) {
    case 'commandExecution': {
      const actions = arr(item.commandActions)
      if (commandIntent(actions) === 'exec') return { activity: 'exec', detail: innerCommand(item.command, actions) }
      // Reads, listings and searches done through the shell: show what is being looked at.
      const first = actions.find(isRecord)
      const path = first ? str(first.path) : ''
      const detail = first ? path || str(first.query) || str(first.name) || str(first.command) : ''
      return { activity: 'read', detail: path ? fileDetail(detail, path) : detail }
    }
    case 'fileChange': {
      const paths = arr(item.changes)
        .map((c) => (isRecord(c) ? relativeTo(str(c.path), cwd) : ''))
        .filter((p) => p.length > 0)
      const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : ''
      // Any secrets-like file among them is what the detail says first.
      const shown = paths.find((p) => fileDetail(p) !== p) ?? paths[0]
      return { activity: 'write', detail: paths.length > 0 ? fileDetail(`${shown}${more}`, shown) : '' }
    }
    case 'webSearch': {
      const action = isRecord(item.action) ? item.action : {}
      return { activity: 'web', detail: str(action.url) || str(item.query) || str(action.query) || str(action.pattern) }
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const tool = str(item.tool, 200)
      const server = str(item.server, 200) || str(item.namespace, 200)
      // The app's own board tools (also the writing ones): looking something up, not the server room.
      if (item.type === 'mcpToolCall' && server === BOARD_SERVER_CODEX) return { activity: BOARD_ACTIVITY, detail: BOARD_ACTIVITY_DETAIL }
      const detail = server ? `${server}.${tool}` : tool
      const args = isRecord(item.arguments) ? item.arguments : {}
      // Screenshot / computer-use tools: by name, or by an `action` argument as browser tools take it.
      if (CAPTURE_TOOL_PATTERN.test(tool) || (typeof args.action === 'string' && CAPTURE_TOOL_PATTERN.test(args.action))) {
        return { activity: 'capture', detail }
      }
      return { activity: item.readOnlyHint === true ? 'read' : 'exec', detail }
    }
    case 'collabAgentToolCall':
      return { activity: 'exec', detail: DETAIL_DELEGATING }
    case 'plan':
      return { activity: 'write', detail: `${DETAIL_PLANNING}writing a plan` }
    case 'imageView':
      return { activity: 'read', detail: str(item.path) }
    case 'imageGeneration':
      return { activity: 'write', detail: 'image' }
    default:
      return null
  }
}

/**
 * `turn/plan/updated {explanation, plan: {step, status}[]}` (the whole list each time) as a world
 * activity: `write`, "planning: <the step in progress> (2/5 done)".
 */
export function planActivity(params: unknown): WorldActivity {
  const p = isRecord(params) ? params : {}
  const steps = arr(p.plan).filter(isRecord)
  const done = steps.filter((s) => s.status === 'completed').length
  const now = steps.find((s) => s.status === 'inProgress') ?? steps.find((s) => s.status !== 'completed')
  const what = (now ? str(now.step, 200) : '') || str(p.explanation, 200) || 'the plan'
  return { activity: 'write', detail: steps.length > 0 ? `${DETAIL_PLANNING}${what} (${done}/${steps.length} done)` : `${DETAIL_PLANNING}${what}` }
}

const tokens = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/**
 * `thread/tokenUsage/updated {tokenUsage: {total, last, modelContextWindow}}` as the inspector's
 * TokenUsage, or null when the shape is not that. `total` is the thread's running total (the server
 * replays it on resume), so it replaces what was known. Codex counts cached input inside
 * `inputTokens` and reasoning inside `outputTokens`: here `input` is the uncached part, so that
 * input + cached + output = total. `contextUsed` is the size of the last request.
 */
export function codexTokenUsage(params: unknown): TokenUsage | null {
  const usage = isRecord(params) && isRecord(params.tokenUsage) ? params.tokenUsage : null
  if (!usage || !isRecord(usage.total)) return null
  const total = usage.total
  const cached = tokens(total.cachedInputTokens)
  const input = Math.max(0, tokens(total.inputTokens) - cached)
  const output = tokens(total.outputTokens)
  const out: TokenUsage = { input, output, cached, total: tokens(total.totalTokens) || input + cached + output }
  if (out.total === 0) return null
  const reasoning = tokens(total.reasoningOutputTokens)
  if (reasoning > 0) out.reasoning = reasoning
  const last = isRecord(usage.last) ? usage.last : null
  const context = last ? tokens(last.totalTokens) || tokens(last.inputTokens) + tokens(last.outputTokens) : 0
  if (context > 0) out.contextUsed = context
  const window = tokens(usage.modelContextWindow)
  if (window > 0) out.contextWindow = window
  return out
}

/** Sub-agent states that mean the worker is finished. */
const ENDED_AGENT_STATES: readonly string[] = ['completed', 'shutdown', 'errored', 'notFound']

export interface CollabInfo {
  tool: string
  /** Thread ids of the agents the call is about (for `spawnAgent`: the new agent). */
  receivers: string[]
  prompt: string
  /** Receivers whose reported state says they are finished. */
  ended: string[]
}

/** The parts of a `collabAgentToolCall` item the world cares about, or null if it isn't one. */
export function collabInfo(item: unknown): CollabInfo | null {
  if (!isRecord(item) || item.type !== 'collabAgentToolCall') return null
  const receivers = arr(item.receiverThreadIds).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100)
  const states = isRecord(item.agentsStates) ? item.agentsStates : {}
  const ended = Object.entries(states)
    .filter(([, s]) => isRecord(s) && ENDED_AGENT_STATES.includes(str(s.status, 40)))
    .map(([id]) => id)
  return { tool: str(item.tool, 60), receivers, prompt: str(item.prompt, 2000), ended }
}
