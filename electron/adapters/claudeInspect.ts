// What a Claude Code hook payload tells the inspector (electron/agentStats.ts) beyond the world
// event the mapper makes of it: turns, the task a subagent was given, the files an agent changed,
// and when to look at a transcript for the token usage. One observer per session, hosted or
// external; it only reads the payload and never answers a hook.
//
// A subagent's task: SubagentStart carries the agent's id and type but not what it was asked to do
// (docs/spikes-phase-a.md). The `Agent` tool call that spawned it does (`tool_input.description`,
// `subagent_type`, `prompt`), in its PreToolUse just before. So: remember the Agent calls in order,
// give a starting subagent the oldest open call of its type, and correct that when the call's
// PostToolUse names the agent it really launched (`tool_response.agentId`).
//
// No Electron imports: the tests load this file under plain Node.
import { INSPECT_PREVIEW_CHARS } from '../../shared/inspector'
import { relativeTo } from '../../shared/paths'
import { subagentId } from '../../shared/sessions'
import type { AgentFact } from '../agentStats'
import { savedText } from '../sessionStore'
import { subagentTranscriptPath, type TranscriptPoker } from '../transcriptUsage'
import { DELEGATING_TOOLS, type MappedHook } from './claude-code-hooks'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** The tools that change a file (the same list the office board records). */
const EDIT_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
const MAX_OPEN_CALLS = 50

export interface SpawnInfo {
  /** The call's description (a few words), or a preview of its prompt. One line, no secrets. */
  task: string
  /** `subagent_type` of the call ('' when it named none). */
  agentType: string
}

interface OpenCall extends SpawnInfo {
  toolUseId: string
  /** The provider agent id this call was given to at SubagentStart (a guess until confirmed). */
  agent: string | null
}

/** Links `Agent` tool calls to the subagents they start, for one session. Pure. */
export class SubagentTasks {
  private calls: OpenCall[] = []

  /** PreToolUse of `Agent` / `Task`. */
  requested(toolUseId: string, toolInput: unknown): void {
    const input = isRecord(toolInput) ? toolInput : {}
    const task = savedText(input.description, INSPECT_PREVIEW_CHARS) || savedText(input.prompt, INSPECT_PREVIEW_CHARS)
    this.calls = this.calls.filter((c) => c.toolUseId !== toolUseId || !toolUseId)
    this.calls.push({ toolUseId, task, agentType: str(input.subagent_type, 60), agent: null })
    if (this.calls.length > MAX_OPEN_CALLS) this.calls.shift()
  }

  /** SubagentStart: the oldest open call of that type (a call that names no type fits any); failing that, the oldest open call. */
  started(agent: string, agentType: string): SpawnInfo | null {
    const open = this.calls.filter((c) => c.agent === null)
    const same = (c: OpenCall): boolean => c.agentType.toLowerCase() === agentType.toLowerCase()
    const call = open.find(same) ?? open.find((c) => !c.agentType) ?? open[0]
    if (!call) return null
    call.agent = agent
    return { task: call.task, agentType: call.agentType }
  }

  /**
   * PostToolUse of the call: `tool_response.agentId` says which agent it launched. Returns what has
   * to be corrected: nothing when the guess was right, else the task of that agent (and of the
   * agent that had been given this call by mistake, when the two were swapped).
   */
  confirmed(toolUseId: string, agent: string): Array<{ agent: string } & SpawnInfo> {
    const call = toolUseId ? this.calls.find((c) => c.toolUseId === toolUseId) : undefined
    if (!call) return []
    this.calls = this.calls.filter((c) => c !== call)
    if (!agent || call.agent === agent) return []
    const out: Array<{ agent: string } & SpawnInfo> = [{ agent, task: call.task, agentType: call.agentType }]
    // The call this agent had been given belongs to whoever had ours.
    const other = this.calls.find((c) => c.agent === agent)
    if (other) {
      other.agent = call.agent
      if (call.agent) out.push({ agent: call.agent, task: other.task, agentType: other.agentType })
    }
    return out
  }

  /** The call failed or never launched anything. */
  dropped(toolUseId: string): void {
    if (toolUseId) this.calls = this.calls.filter((c) => c.toolUseId !== toolUseId)
  }

  get open(): number {
    return this.calls.length
  }
}

export interface ClaudeObserverOptions {
  /** World id of the session's manager. */
  rootId: string
  emit(fact: AgentFact): void
  /** Reads token usage from transcripts; absent = no tokens. */
  transcripts?: TranscriptPoker
  /** The session's folder (hosted). Default: each payload's own `cwd`. */
  cwd?: string
  /**
   * Report the manager's task (a preview of its prompt) from here. Off for hosted sessions: the
   * session manager already keeps that preview (SessionInfo.lastPrompt).
   */
  managerTask?: boolean
}

/** Turns one session's hook payloads into inspector facts. Never throws. */
export class ClaudeHookObserver {
  private readonly tasks = new SubagentTasks()

  constructor(private readonly opts: ClaudeObserverOptions) {}

  observe(body: Record<string, unknown>, mapped: MappedHook): void {
    try {
      this.handle(body, mapped)
    } catch {
      // the inspector is a convenience: a hook is never held up by it
    }
  }

  private handle(body: Record<string, unknown>, mapped: MappedHook): void {
    const { rootId, emit, transcripts } = this.opts
    const tool = str(body.tool_name, 200)
    const toolUseId = str(body.tool_use_id, 200)
    const providerAgent = str(body.agent_id, 100)
    const transcript = (): unknown =>
      mapped.agentId === rootId ? body.transcript_path : subagentTranscriptPath(body.transcript_path, providerAgent, body.agent_transcript_path)

    switch (mapped.kind) {
      case 'prompt':
        emit({ kind: 'turn', agentId: rootId })
        if (this.opts.managerTask) {
          const text = savedText(body.prompt, INSPECT_PREVIEW_CHARS)
          if (text) emit({ kind: 'task', agentId: rootId, text })
        }
        break

      case 'pre-tool':
        if (DELEGATING_TOOLS.includes(tool)) this.tasks.requested(toolUseId, body.tool_input)
        break

      case 'subagent-start': {
        const agentType = str(body.agent_type, 60)
        const info = this.tasks.started(providerAgent, agentType)
        emit({ kind: 'worker', agentId: mapped.agentId, agentType: agentType || info?.agentType, task: info?.task })
        // It works from now until it stops, also between its tool calls.
        emit({ kind: 'busy', agentId: mapped.agentId, busy: true })
        break
      }

      case 'post-tool': {
        const failed = body.hook_event_name !== 'PostToolUse'
        if (DELEGATING_TOOLS.includes(tool)) {
          const launched = isRecord(body.tool_response) ? str(body.tool_response.agentId, 100) : ''
          if (failed || !launched) this.tasks.dropped(toolUseId)
          else for (const fix of this.tasks.confirmed(toolUseId, launched)) emit({ kind: 'worker', agentId: subagentId(rootId, fix.agent), agentType: fix.agentType || undefined, task: fix.task })
        }
        if (!failed && EDIT_TOOLS.includes(tool) && isRecord(body.tool_input)) {
          const path = str(body.tool_input.file_path ?? body.tool_input.notebook_path, 2000)
          if (path) {
            const created = tool === 'Write' && isRecord(body.tool_response) && body.tool_response.type === 'create'
            emit({ kind: 'file', agentId: mapped.agentId, path: this.shown(path, body.cwd), change: created ? 'create' : 'edit' })
          }
        }
        transcripts?.poke(mapped.agentId, transcript(), mapped.agentId === rootId)
        break
      }

      case 'stop':
        transcripts?.poke(rootId, body.transcript_path, true)
        break

      case 'subagent-stop':
        transcripts?.poke(mapped.agentId, transcript(), false)
        break

      default:
        break
    }
  }

  /** A file as the panel shows it: relative to the session's folder, with forward slashes. */
  private shown(path: string, payloadCwd: unknown): string {
    const cwd = this.opts.cwd ?? (typeof payloadCwd === 'string' ? payloadCwd : '')
    const rel = relativeTo(path, cwd)
    return rel === path ? path : rel.replace(/\\/g, '/')
  }
}
