import { parseAgentEvent } from '../../shared/events'
import type { EventSink, HttpAdapter } from './types'

export interface IngestResult {
  accepted: number
  rejected: number
}

/** Accepts one AgentEvent or an array of them; each is validated independently. */
export function ingestEvents(body: unknown, sink: EventSink): IngestResult {
  const items = Array.isArray(body) ? body : [body]
  let accepted = 0
  let rejected = 0
  for (const item of items) {
    const e = parseAgentEvent(item)
    if (e) {
      sink.emit(e)
      accepted++
    } else {
      rejected++
    }
  }
  return { accepted, rejected }
}

export const genericAdapter: HttpAdapter = {
  route: '/events',
  handle: (body, sink) => ingestEvents(body, sink)
}
