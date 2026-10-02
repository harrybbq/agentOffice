// Provider-agnostic chat model for sessions that have no terminal (Codex app-server, later Antigravity)
// and, as a secondary log, for Claude. The main process keeps a bounded ChatItem list per session and
// streams ChatEvents to the renderer; a late attach gets a `reset` (like TerminalSnapshot for terminals).
// Nothing here names a provider's tool or method. Design notes: docs/spikes-phase-b.md.

export type ChatItemStatus = 'running' | 'done' | 'failed' | 'declined' | 'interrupted'

export interface ChatItemBase {
  /** Unique within the session and stable across updates: the provider's item id where it has one
   *  (Codex ThreadItem.id, Claude tool_use_id / transcript uuid), otherwise app-generated. */
  id: string
  sessionId: string
  /** World agent that produced it: the session itself or one of its subagents (shared/sessions.ts subagentId). */
  agentId: string
  /** Provider turn id, when the provider has turns. Groups items and lets a turn be marked failed/interrupted. */
  turnId?: string
  /** Unix ms of the first event for this item. Items are ordered by arrival, not by ts. */
  ts: number
}

export type ChatItem = ChatItemBase &
  (
    | {
        kind: 'user'
        text: string
        /** typed in the app's chat box | CEO speech bar | sent while a turn was running | hand-backs, task notifications */
        origin: 'human' | 'order' | 'steer' | 'system'
      }
    | {
        kind: 'assistant'
        text: string
        /** True while deltas are still arriving. Providers that do not stream deliver one finished item. */
        streaming: boolean
        phase?: 'commentary' | 'final'
      }
    | {
        kind: 'reasoning'
        /** Summary parts (rendered collapsed). */
        summary: string[]
        /** Raw reasoning text, when the provider exposes it. */
        text?: string
        streaming: boolean
      }
    | {
        kind: 'command'
        command: string
        cwd?: string
        /** What the command is for, when the provider can tell. Drives the icon and the world activity. */
        intent: 'read' | 'search' | 'list' | 'exec'
        /** stdout + stderr, capped by the main process (keep the tail). */
        output: string
        outputTruncated: boolean
        exitCode: number | null
        durationMs?: number
        status: ChatItemStatus
      }
    | {
        kind: 'file-change'
        changes: Array<{
          path: string
          change: 'add' | 'delete' | 'update'
          movedTo?: string
          /** Unified diff, capped. Empty when the provider gives none. */
          diff: string
        }>
        status: ChatItemStatus
      }
    | {
        kind: 'web'
        action: 'search' | 'open' | 'find'
        query?: string
        url?: string
        status: ChatItemStatus
      }
    | {
        kind: 'tool'
        /** MCP server or tool namespace, if any. */
        server?: string
        tool: string
        /** Pretty-printed input, truncated (permissions.ts describeToolInput). */
        input: string
        result?: string
        error?: string
        progress?: string
        status: ChatItemStatus
      }
    | {
        kind: 'plan'
        explanation?: string
        steps: Array<{ text: string; status: 'pending' | 'in-progress' | 'completed' }>
      }
    | {
        kind: 'subagent'
        /** World id of the worker. */
        childAgentId: string
        action: 'spawn' | 'message' | 'wait' | 'close'
        name?: string
        prompt?: string
        status: ChatItemStatus
      }
    | {
        kind: 'approval'
        /** PermissionRequestInfo.id: the card is the same request the CEO office inbox shows. */
        requestId: string
        /** The command / file-change item this approval is about, if it is in the list. */
        subjectId?: string
        summary: string
        detail: string
        outcome: 'pending' | 'allowed' | 'denied' | 'resolved-elsewhere'
      }
    | {
        kind: 'notice'
        level: 'info' | 'warning' | 'error'
        /** "Reconnecting 2/5", "context compacted", "turn interrupted", "usage limit reached" */
        text: string
      }
  )

export type ChatStreamField = 'text' | 'summary' | 'output'

export type ChatEvent =
  /** Insert or replace by id (item started, item finished, plan replaced, approval outcome changed). */
  | { type: 'item'; item: ChatItem }
  /** Append to a string field of an existing item. `index` selects the summary part. */
  | { type: 'delta'; sessionId: string; itemId: string; field: ChatStreamField; index?: number; delta: string }
  | {
      type: 'turn'
      sessionId: string
      turnId: string
      status: 'started' | 'completed' | 'interrupted' | 'failed'
      error?: string
    }
  /** Full list: sent on attach, and after a resume rebuilt the history. */
  | { type: 'reset'; sessionId: string; items: ChatItem[] }

/** Bounds enforced by the main process. */
export const CHAT_MAX_ITEMS = 2000
export const CHAT_MAX_OUTPUT_CHARS = 64_000
export const CHAT_MAX_DIFF_CHARS = 64_000
export const CHAT_MAX_PROMPT_CHARS = 32_000
