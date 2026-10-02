// What a hosted Claude Code session is told about where it runs. The text is appended to Claude's
// system prompt (`--append-system-prompt-file`), so keep it short and factual: it is context, not
// instructions. Edit the template here; tests/hosted.test.ts checks its size and that it carries
// no secrets.

/** First line of an order delivered through the session inbox, so the session can tell where it came from. */
export const CEO_ORDER_TAG = '[CEO order via Agent Office]'

export interface BriefingValues {
  /** The session's title in the app: the name of its team. */
  title: string
}

/** A title is the user's own text; keep it on one line and inside its quotes. */
function quotable(title: string): string {
  return title.replace(/["`]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 60) || 'this session'
}

/** The order text as it is delivered to a session. */
export function taggedOrder(text: string): string {
  return `${CEO_ORDER_TAG}\n${text}`
}

export function claudeBriefing(values: BriefingValues): string {
  const title = quotable(values.title)
  return `# Agent Office

This Claude Code session was started from Agent Office, a desktop app the user runs as their main interface for AI coding agents.

- The user sees an animated office: they are the CEO, this session manages a team called "${title}" with its own branch, and each subagent you spawn appears as a worker at a desk. Tool use shows as activity (reading: filing cabinet, editing: desk, shell: server room, web: printer).
- The terminal pane is a normal Claude Code terminal. Everything works as usual.
- Permission requests appear in the user's "CEO inbox" in the app as well as in the terminal. The user may answer in either.
- The user types "orders" in the app's order bar, for this session, for one provider's sessions, or for every agent at once. They may arrive as a cross-session message beginning with the line \`${CEO_ORDER_TAG}\`.
- Other sessions, possibly other AI providers, may be working in other folders. Don't assume their work is visible. Cross-session messaging tools are disabled in this session; you can't see or contact the user's other sessions.

No change in behaviour is required. This is context, so you can answer "where am I running?" and understand orders.
`
}
