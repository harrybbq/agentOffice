# Claude Code hooks — research notes (2026-09-30)

Sources: https://code.claude.com/docs/en/hooks.md, hooks-guide.md, tools.md, sessions.md, sub-agents.md

## Common input fields
`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`

## Events we use
| Event | Extra fields |
|---|---|
| SessionStart | `source` (startup/resume/clear/compact/fork), `model`, `agent_type` |
| UserPromptSubmit | `prompt_id`, prompt text |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` |
| PostToolUse | `tool_name`, `tool_input`, `tool_output`, `tool_use_id` |
| PostToolUseFailure | `tool_name`, `tool_input`, `error`, `tool_use_id` |
| PermissionRequest | `tool_name`, `tool_input`, `tool_use_id` |
| SubagentStart | `agent_id`, `agent_type`, `agent_description` |
| SubagentStop | `agent_id`, `agent_type`, `last_assistant_message` |
| Notification | `notification_type` (permission_prompt, idle_prompt, agent_needs_input, ...), `message` |
| Stop | `last_assistant_message` |
| SessionEnd | `exit_reason` — shared 1.5 s budget for all SessionEnd hooks |

**Subagents share the parent's `session_id`.** Whether PreToolUse/PostToolUse carry `agent_id`
inside a subagent is NOT confirmed by the docs -> verify empirically by logging raw payloads.

## Config
```json
{"hooks": {"PreToolUse": [{"matcher": "...", "hooks": [{"type": "command", "command": "...", "timeout": 5, "async": true}]}]}}
```
- `type: "http"` exists: `{ "type": "http", "url": "...", "headers": {"X": "$VAR"}, "allowedEnvVars": ["VAR"] }`;
  the body is the same JSON as command-hook stdin; the response body uses the same output format.
- `async: true` runs a command hook in the background (can't return decisions).
- Default timeout 600 s.

## Output semantics (for future approve/deny)
- exit 0 + empty stdout = no effect.
- PreToolUse: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask|defer","permissionDecisionReason":"..."}}`
- PermissionRequest: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow|deny"}}}`

## Tool names
Read, Write, Edit, Glob, Grep, Bash, PowerShell, WebFetch, WebSearch, Agent, Task*, NotebookEdit,
TodoWrite, LSP, Skill, AskUserQuestion, ... MCP: `mcp__<server>__<tool>`.

## Transcripts
`~/.claude/projects/<project>/<session-id>.jsonl`; subagents in
`<session-id>/subagents/agent-<agent-id>.jsonl`. The format is internal and changes between versions, so parse defensively.

## Sending prompts INTO a running session (CEO speech bar) — for M2
Source: https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket
- Claude Code exports `CLAUDE_CODE_MESSAGING_SOCKET` (Windows: named pipe `\.\pipe\LOCAL\cc-msg-...`;
  macOS/Linux: unix socket) and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and child processes.
  Verified present in Claude Code 2.1.284 on this machine.
- Protocol: connect, send `{"type":"auth","token":"<token>"}\n` (required on Windows), then the message text + `\n`.
- Mid-turn: delivered between tool calls (never interrupts a tool). Idle: starts a new turn.
- It arrives as a *peer* message ("from another session"): it can't approve permissions, and slash commands arrive as plain text.
  The receiver's `crossSessionInbound` setting can be accept (default) / hold / refuse.
- Plan: the hook script includes the socket path + token with SessionStart (and each event, cheaply).
  The app keeps them **in memory only** per session_id; the speech bar writes to the pipe.
- Fallbacks: Stop hook `{"decision":"block","reason":...}` (loop guard `stop_hook_active`).
