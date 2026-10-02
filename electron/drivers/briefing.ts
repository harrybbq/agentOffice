// What a hosted session is told about where it runs: one short, factual text per provider, built
// from the same parts. Claude Code gets it appended to its system prompt
// (`--append-system-prompt-file`); Codex gets it as `developerInstructions` of its thread.
// It is context, not instructions. Edit the template here; the tests check its size and that it
// carries no secrets.
import type { ProviderId } from '../../shared/sessions'

/** First line of an order delivered through a Claude Code session's inbox, so the session can tell where it came from. */
export const CEO_ORDER_TAG = '[CEO order via Agent Office]'

export interface BriefingValues {
  /** The session's title in the app: the name of its team. */
  title: string
}

/** A title is the user's own text; keep it on one line and inside its quotes. */
function quotable(title: string): string {
  return title.replace(/["`]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 60) || 'this session'
}

/** The order text as it is delivered to a Claude Code session. (Codex gets an order as a plain user turn.) */
export function taggedOrder(text: string): string {
  return `${CEO_ORDER_TAG}\n${text}`
}

interface ProviderParts {
  /** "This Claude Code session" */
  session: string
  /** Bullets after the first one. */
  bullets: string[]
}

const PARTS: Partial<Record<ProviderId, ProviderParts>> = {
  'claude-code': {
    session: 'This Claude Code session',
    bullets: [
      'The terminal pane is a normal Claude Code terminal. Everything works as usual.',
      'Permission requests appear in the user\'s "CEO inbox" in the app as well as in the terminal. The user may answer in either.',
      `The user types "orders" in the app's order bar, for this session, for one provider's sessions, or for every agent at once. They may arrive as a cross-session message beginning with the line \`${CEO_ORDER_TAG}\`.`,
      "Other sessions, possibly other AI providers, may be working in other folders. Don't assume their work is visible. Cross-session messaging tools are disabled in this session; you can't see or contact the user's other sessions."
    ]
  },
  codex: {
    session: 'This Codex session',
    bullets: [
      'The user talks to you through a chat pane in the app. There is no terminal UI.',
      'Approval requests for commands and file changes appear in the user\'s "CEO inbox" in the app. A declined request may be followed by a message saying why.',
      'The user also types "orders" in the app\'s order bar, for this session, for one provider\'s sessions, or for every agent at once. An order reaches you as an ordinary user message, possibly while you are in the middle of a turn.',
      "Other sessions, possibly other AI providers, may be working in other folders. Don't assume their work is visible."
    ]
  }
}

/** The briefing for one provider. Providers without a text of their own get the Claude Code one. */
export function officeBriefing(provider: ProviderId, values: BriefingValues): string {
  const title = quotable(values.title)
  const parts = PARTS[provider] ?? (PARTS['claude-code'] as ProviderParts)
  const worker = provider === 'codex' ? 'each sub-agent you spawn' : 'each subagent you spawn'
  return `# Agent Office

${parts.session} was started from Agent Office, a desktop app the user runs as their main interface for AI coding agents.

- The user sees an animated office: they are the CEO, this session manages a team called "${title}" with its own branch, and ${worker} appears as a worker at a desk. Tool use shows as activity (reading: filing cabinet, editing: desk, shell: server room, web: printer).
${parts.bullets.map((b) => `- ${b}`).join('\n')}

No change in behaviour is required. This is context, so you can answer "where am I running?" and understand orders.
`
}
