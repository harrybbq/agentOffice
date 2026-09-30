import type { AgentEvent } from '../../shared/events'

export interface EventSink {
  emit(e: AgentEvent): void
}

/** An adapter reached over HTTP POST at `route`. */
export interface HttpAdapter {
  route: string
  /** Returns the JSON response body. Future: may carry allow/deny decisions (e.g. Claude Code hooks). */
  handle(body: unknown, sink: EventSink): unknown | Promise<unknown>
}

/** An adapter that produces events on its own (e.g. tailing transcripts). */
export interface BackgroundAdapter {
  name: string
  start(sink: EventSink): void
  stop(): void
}
