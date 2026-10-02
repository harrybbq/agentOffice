// A Claude Code session's plan, read from its hook payloads, for the progress bar
// (electron/progress.ts). Two generations of tools write it (payload shapes: docs/progress-notes.md):
//
// - `TodoWrite`: `tool_input.todos` is the WHOLE list every time (`content`, `status`), so each
//   call replaces what was known.
// - the task tools: `TaskCreate` adds one task (its id is only in the PostToolUse `tool_response`),
//   `TaskUpdate` changes one by id (`status`, `subject`; `deleted` removes it), `TaskList` answers
//   with the list as Claude holds it, which replaces ours.
//
// Only the main thread's calls count: a subagent's own to-do list does not replace the manager's.
// Anything that cannot be read leaves the list as it was last known. Pure; never throws.
import type { ProgressStep } from '../../shared/progress'
import { progressText, stepStatus } from '../progress'
import type { MappedHook } from './claude-code-hooks'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const MAX_TASKS = 200
const GONE: readonly string[] = ['deleted', 'cancelled', 'canceled']

/** A task id as a string: Claude's are "1", "2", …; a number is accepted too. */
function taskId(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' ? v.trim().slice(0, 60) : ''
}

/** JSON in a string (a tool response may arrive as text), or the value itself. */
function parsed(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const text = v.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return v
  try {
    return JSON.parse(text)
  } catch {
    return v
  }
}

/** `TodoWrite` todos (or anything of that shape) as steps; null when it is not a list. */
export function todoSteps(todos: unknown): ProgressStep[] | null {
  if (!Array.isArray(todos)) return null
  const steps: ProgressStep[] = []
  for (const t of todos) {
    if (!isRecord(t)) continue
    const text = progressText(t.content) || progressText(t.subject) || progressText(t.activeForm) || progressText(t.description)
    if (!text) continue
    steps.push({ text, status: stepStatus(t.status) })
  }
  // Rows that could not be read: don't let half a list replace a whole one.
  return steps.length === 0 && todos.length > 0 ? null : steps
}

/** The id `TaskCreate` gave its task: `tool_response.task.id`, or the other places it could be. */
export function createdTaskId(response: unknown): string {
  const r = parsed(response)
  if (isRecord(r)) {
    const task = isRecord(r.task) ? r.task : r
    return taskId(task.id) || taskId(task.taskId) || taskId(r.taskId) || taskId(r.id)
  }
  const m = typeof r === 'string' ? /task\s+#?([\w-]{1,40})\s+created/i.exec(r) : null
  return m ? m[1] : ''
}

/** The tasks in a `TaskList` response (`tool_response.tasks`), or null when there is no such list. */
export function listedTasks(response: unknown): { id: string; step: ProgressStep }[] | null {
  const r = parsed(response)
  const list = Array.isArray(r) ? r : isRecord(r) && Array.isArray(r.tasks) ? r.tasks : null
  if (!list) return null
  const out: { id: string; step: ProgressStep }[] = []
  for (const t of list) {
    if (!isRecord(t)) continue
    const id = taskId(t.id) || taskId(t.taskId)
    const text = progressText(t.subject) || progressText(t.content) || progressText(t.description)
    if (!id || !text) continue
    if (typeof t.status === 'string' && GONE.includes(t.status.toLowerCase())) continue
    out.push({ id, step: { text, status: stepStatus(t.status) } })
  }
  return out.length === 0 && list.length > 0 ? null : out
}

export class ClaudePlan {
  /** Task tools: the tasks by id, in the order they were created. */
  private tasks = new Map<string, ProgressStep>()
  /** What was last reported, serialised (a repeat is not news). */
  private last = ''

  constructor(private readonly rootId: string) {}

  /**
   * Feeds one hook of the session. Returns the plan as it is now when this hook changed it (an
   * empty list: it was cleared), else null.
   */
  observe(body: Record<string, unknown>, mapped: MappedHook): ProgressStep[] | null {
    try {
      return this.handle(body, mapped)
    } catch {
      return null
    }
  }

  private handle(body: Record<string, unknown>, mapped: MappedHook): ProgressStep[] | null {
    if (mapped.kind !== 'pre-tool' && mapped.kind !== 'post-tool') return null
    // The main thread only: a subagent's payload carries its `agent_id`.
    if (mapped.agentId !== this.rootId || (typeof body.agent_id === 'string' && body.agent_id.length > 0)) return null
    const tool = typeof body.tool_name === 'string' ? body.tool_name : ''
    const input = isRecord(body.tool_input) ? body.tool_input : {}
    const post = mapped.kind === 'post-tool'
    if (post && body.hook_event_name !== 'PostToolUse') return null // the call failed: nothing changed

    if (tool === 'TodoWrite') {
      // The input is the whole list (PreToolUse is enough); the response repeats it as `newTodos`.
      const response = post ? parsed(body.tool_response) : null
      const steps = (isRecord(response) ? todoSteps(response.newTodos) : null) ?? todoSteps(input.todos)
      if (!steps) return null
      this.tasks.clear()
      return this.report(steps)
    }
    // The task tools have changed Claude's list once they ran: PostToolUse only.
    if (!post) return null
    if (tool === 'TaskCreate') {
      const text = progressText(input.subject) || progressText(input.description) || progressText(input.activeForm)
      if (!text) return null
      // A list that was finished is over: this task starts the next one.
      if (this.tasks.size > 0 && [...this.tasks.values()].every((s) => s.status === 'completed')) this.tasks.clear()
      if (this.tasks.size >= MAX_TASKS) return null
      this.tasks.set(createdTaskId(body.tool_response) || this.nextId(), { text, status: stepStatus(input.status) })
      return this.report([...this.tasks.values()])
    }
    if (tool === 'TaskUpdate') {
      const id = taskId(input.taskId) || taskId(input.id)
      if (!id) return null
      const status = typeof input.status === 'string' ? input.status.toLowerCase() : ''
      if (GONE.includes(status)) return this.tasks.delete(id) ? this.report([...this.tasks.values()]) : null
      const known = this.tasks.get(id)
      const text = progressText(input.subject) || known?.text || ''
      // A task we never saw created and that is not named here: leave the list as it is.
      if (!text) return null
      if (!known && this.tasks.size >= MAX_TASKS) return null
      this.tasks.set(id, { text, status: status ? stepStatus(status) : (known?.status ?? 'pending') })
      return this.report([...this.tasks.values()])
    }
    if (tool === 'TaskList') {
      const listed = listedTasks(body.tool_response)
      if (!listed) return null
      this.tasks = new Map(listed.slice(0, MAX_TASKS).map((t) => [t.id, t.step]))
      return this.report([...this.tasks.values()])
    }
    return null
  }

  /** Claude numbers its tasks 1, 2, 3…: the next one, when a response did not say. */
  private nextId(): string {
    let max = 0
    for (const id of this.tasks.keys()) if (/^\d+$/.test(id)) max = Math.max(max, Number(id))
    return String(max + 1)
  }

  private report(steps: ProgressStep[]): ProgressStep[] | null {
    const text = JSON.stringify(steps)
    if (text === this.last) return null
    this.last = text
    return steps.map((s) => ({ ...s }))
  }
}
