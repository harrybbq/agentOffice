// Codex thread items -> what the character does in the world (AgentEvent activity + detail).
// The table is spike 5 of docs/spikes-phase-b.md. Pure; the driver feeds the result to the same
// actor bookkeeping the Claude driver uses (ClaudeHookMapper.activity / waiting / resume / settle).
//
// Sub-agents were not exercised in the spikes, so everything about them is parsed defensively.
import type { Activity } from '../../shared/events'
import { relativeTo } from '../../shared/paths'
import { CAPTURE_TOOL_PATTERN } from '../adapters/claude-code-hooks'
import { arr, commandIntent, innerCommand, isRecord, str } from './codexProtocol'

export const CODEX_PROVIDER = 'codex'

export interface WorldActivity {
  activity: Activity
  detail: string
}

/**
 * What `item/started` means for the world, or null when the item is not an activity (messages,
 * reasoning, plans). `cwd` is the session's folder: changed files under it are named relative to it.
 */
export function worldActivityForItem(item: unknown, cwd?: string): WorldActivity | null {
  if (!isRecord(item)) return null
  switch (item.type) {
    case 'commandExecution': {
      const actions = arr(item.commandActions)
      if (commandIntent(actions) === 'exec') return { activity: 'exec', detail: innerCommand(item.command, actions) }
      // Reads, listings and searches done through the shell: show what is being looked at.
      const first = actions.find(isRecord)
      const detail = first ? str(first.path) || str(first.query) || str(first.name) || str(first.command) : ''
      return { activity: 'read', detail }
    }
    case 'fileChange': {
      const paths = arr(item.changes)
        .map((c) => (isRecord(c) ? relativeTo(str(c.path), cwd) : ''))
        .filter((p) => p.length > 0)
      const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : ''
      return { activity: 'write', detail: paths.length > 0 ? `${paths[0]}${more}` : '' }
    }
    case 'webSearch': {
      const action = isRecord(item.action) ? item.action : {}
      return { activity: 'web', detail: str(action.url) || str(item.query) || str(action.query) || str(action.pattern) }
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const tool = str(item.tool, 200)
      const server = str(item.server, 200) || str(item.namespace, 200)
      const detail = server ? `${server}.${tool}` : tool
      const args = isRecord(item.arguments) ? item.arguments : {}
      // Screenshot / computer-use tools: by name, or by an `action` argument as browser tools take it.
      if (CAPTURE_TOOL_PATTERN.test(tool) || (typeof args.action === 'string' && CAPTURE_TOOL_PATTERN.test(args.action))) {
        return { activity: 'capture', detail }
      }
      return { activity: item.readOnlyHint === true ? 'read' : 'exec', detail }
    }
    case 'collabAgentToolCall':
      return { activity: 'exec', detail: 'delegating' }
    case 'imageView':
      return { activity: 'read', detail: str(item.path) }
    case 'imageGeneration':
      return { activity: 'write', detail: 'image' }
    default:
      return null
  }
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
