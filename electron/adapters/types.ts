import type { AgentEvent } from '../../shared/events'
import type { Auth } from '../ingest/auth'

export interface EventSink {
  emit(e: AgentEvent): void
}

/** What the ingest server knows about the request an adapter is handling. */
export interface RequestContext {
  /** Which token authenticated the request (global, or one hosted session's own). */
  auth: Auth
  /**
   * Aborts when the client closes the connection before the response was sent. Adapters that hold
   * a response open (a pending permission request) use it to learn the request was abandoned.
   */
  signal: AbortSignal
}

/** An adapter reached over HTTP POST at `route`. */
export interface HttpAdapter {
  route: string
  /** Body cap for this route in bytes (default: the server's MAX_BODY). */
  maxBody?: number
  /** Returns the JSON response body. May resolve late (e.g. a permission decision). */
  handle(body: unknown, sink: EventSink, ctx: RequestContext): unknown | Promise<unknown>
}

/** An adapter that produces events on its own (e.g. tailing transcripts). */
export interface BackgroundAdapter {
  name: string
  start(sink: EventSink): void
  stop(): void
}
