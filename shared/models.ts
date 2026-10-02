// Friendly names for model ids, used as the default title of a session (and so of its team).
// Table / pattern driven: an id that matches nothing is returned as it is, so ids of other
// providers (e.g. "gpt-6-luna") pass through unchanged until they get a rule of their own.

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Claude families that can be named on their own ("opus" as a `--model` alias). */
const CLAUDE_FAMILIES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable']

interface Rule {
  pattern: RegExp
  name(m: RegExpExecArray): string
}

const version = (major: string, minor?: string): string => (minor ? `${major}.${minor}` : major)

const RULES: readonly Rule[] = [
  // claude-opus-5-5, claude-haiku-4-5-20251001, claude-opus-4
  { pattern: /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/, name: (m) => `${cap(m[1])} ${version(m[2], m[3])}` },
  // The older order: claude-3-5-sonnet-20241022
  { pattern: /^claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/, name: (m) => `${cap(m[3])} ${version(m[1], m[2])}` }
]

/** "claude-opus-5-5" -> "Opus 5.5". Unknown ids come back unchanged. */
export function friendlyModelName(modelId: string): string {
  const raw = modelId.trim()
  // Variant suffixes such as "[1m]" (context size) don't change which model it is.
  const id = raw.replace(/\[[^\]]*\]$/, '').toLowerCase()
  if (CLAUDE_FAMILIES.includes(id)) return cap(id)
  for (const rule of RULES) {
    const m = rule.pattern.exec(id)
    if (m) return rule.name(m)
  }
  return raw
}
