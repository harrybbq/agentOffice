// What a hosted Claude Code session is told about where it runs. The text is appended to Claude's
// system prompt (`--append-system-prompt-file`). The template is shared with the other providers:
// see drivers/briefing.ts.
import { officeBriefing, type BriefingValues } from './briefing'

export { CEO_ORDER_TAG, taggedOrder, type BriefingValues } from './briefing'

export function claudeBriefing(values: BriefingValues): string {
  return officeBriefing('claude-code', values)
}
