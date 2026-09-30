import type { HttpAdapter } from './types'

/**
 * Claude Code `type: "http"` hooks POST their hook input JSON here (see docs/claude-code-hooks-notes.md).
 * The response body uses the hook output format, so later this can return permission decisions.
 */
export const claudeCodeHooksAdapter: HttpAdapter = {
  route: '/hooks/claude-code',
  handle(_body, _sink) {
    // TODO(milestone 2): map hook_event_name / tool_name / agent_id to AgentEvents and sink.emit() them.
    // TODO(later): return hookSpecificOutput decisions for PreToolUse / PermissionRequest. Read-only for now.
    return {}
  }
}
