# Phase A feasibility spikes: hosting the `claude` TUI (2026-10-02)

Environment: Windows 11 Home 10.0.26200, Node 24.19.0, Electron 44.5.1 (bundled Node 24.21.0, N-API 10),
Claude Code 2.1.284 (`claude.exe`, Claude Max login), `node-pty@1.2.0-beta.15`.

Scripts are in `scripts/spikes/`:

| File | Purpose |
|---|---|
| `spike1-electron-main.cjs` + `pty-utility.cjs` | node-pty inside `utilityProcess.fork` (`npx electron scripts/spikes/spike1-electron-main.cjs`) |
| `claude-harness.cjs` | Hosts the real TUI in node-pty, injects hooks through `--settings`, logs payloads, answers PermissionRequest, renders the screen with `@xterm/headless`. Scenarios: `events`, `permissions`, `inject`, `inbox`, `interrupt` |
| `hook-envprobe.cjs` | `type:"command"` SessionStart hook that POSTs the inbox socket and token |

Run: `node scripts/spikes/claude-harness.cjs <scenario> --xterm <path to @xterm/headless> --root <scratch dir>`.
`@xterm/headless` was installed in a scratch directory, not in the repo. Six real sessions were used, about 17 short turns.
Sessions 2 to 6 ran under plain Node 24 rather than Electron; spike 1 covers the Electron load separately.

## Summary

| # | Spike | Result |
|---|---|---|
| 1 | node-pty in an Electron 44 utilityProcess | PASS |
| 2 | Hook injection through `--settings` with http hooks | PARTIAL: SessionStart never fires over http, and the messaging token cannot be put in a header |
| 3 | PermissionRequest answered by the app | PASS, with one design consequence: the TUI shows its own dialog while the hook is pending |
| 4a | Prompt injection through the inbox socket | PASS after a protocol fix: the message must be a JSON line, so `electron/sessionInbox.ts` is wrong today |
| 4b | Prompt injection by bracketed paste | PARTIAL: works, but larger pastes are wrapped in `<pasted_content>` and read as an attachment |
| 5 | Idle/busy detection | PARTIAL: UserPromptSubmit and Stop work, but Stop does not fire on interrupt and fires early when subagents run in the background |
| 6 | Interrupt | PASS: both `\x1b` and `\x03` interrupt a running turn |

## Changes to the plan

1. **Fix the inbox wire format.** `wirePayload()` in `electron/sessionInbox.ts` sends plain text after the auth line. Claude Code 2.1.284 silently drops that. The second line must be `{"type":"user","message":{"role":"user","content":"<text>"}}`. Newlines can then stay in the text.
2. **SessionStart needs a command hook.** `type:"http"` is not supported for SessionStart (docs: "Only `type: "command"` and `type: "mcp_tool"` hooks are supported"). The same command hook is the only way to get `CLAUDE_CODE_MESSAGING_TOKEN`, because header interpolation blanks it.
3. **The approval card and the TUI dialog coexist.** While the PermissionRequest hook is pending, the TUI shows its normal "Do you want to proceed?" dialog. Whichever side answers first wins. The app must dismiss its card when Claude closes the hook connection.
4. **Stop is not a complete idle signal.** It does not fire after Esc/Ctrl+C, and it fires while background subagents are still running. The driver needs a second signal (see spike 5).
5. **Spawn with an explicit `--permission-mode`.** With no flag, the session ran in `auto` on this machine. That session's only tool call was a read-only listing, so it says nothing about PermissionRequest in auto mode. Sessions started with `--permission-mode default` raised PermissionRequest as expected.
6. **Filter synthetic events.** UserPromptSubmit also fires for subagent hand-backs and task notifications, and SubagentStop fires for an internal agent with `agent_type: ""`.
7. **The folder-trust dialog defaults to "No, exit".** A blind Enter quits the session.
8. **Scrub `CLAUDE*` env vars before spawning** when the app itself was started from a Claude Code terminal.

## Spike 1: node-pty under Electron 44 in a utilityProcess (PASS)

- `npm install --save-exact node-pty@1.2.0-beta.15` used the shipped prebuilds. No electron-rebuild and no node-gyp build ran. The addon is N-API (`node-addon-api`), so the same binary loads in Node 24 and in Electron 44.
- Load path: `node_modules/node-pty/prebuilds/win32-x64/conpty.node`. `build/Release/` holds only `conpty/conpty.dll` and `conpty/OpenConsole.exe`, copied there by the post-install script.

```
[utility] versions electron=44.5.1 node=24.21.0 napi=10 modules=149 arch=x64
[utility] loadNativeModule('conpty') dir=../prebuilds/win32-x64 (relative to node-pty/lib)
[utility] [claude --version dll=false] exit=0 ms=1180 text="2.1.284 (Claude Code)"
[utility] [powershell echo dll=false] exit=0 ms=1475 text="hi"
[utility] [claude --version dll=true] exit=0 ms=3245 text="2.1.284 (Claude Code)"
[utility] [powershell echo dll=true] exit=0 ms=3411 text="hi"
```

Windows details:

- ConPTY is the only backend in this version (no winpty).
- `useConptyDll: false` uses the system ConPTY. Output begins `ESC[?9001h ESC[?1004h ESC[?25l ESC[2J ESC[m ESC[H`.
- `useConptyDll: true` uses the bundled `conpty.dll` and `OpenConsole.exe`. It first emits `ESC[1t ESC[c` (a device-attributes query). With nothing answering, each command took about 2 s longer (3.2 s against 1.2 s), which looks like a wait for the reply. Wire xterm.js `onData` back to `pty.write` before spawning if this mode is used. All Claude sessions below used `useConptyDll: false`.
- `pty.pid` read `0` immediately after `spawn()` in the utility process. Read it later if it is needed.
- Bundling: `conpty.node`, `conpty_console_list.node`, and the `conpty/` folder must be left outside the asar and outside the Vite bundle (mark `node-pty` external for the utility process entry). Not tested here in a packaged build.
- Spawn `...\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` directly. `claude.cmd` only adds a `cmd.exe` layer.

## Spike 2: hook injection through `--settings` (PARTIAL)

`--settings <path to a temp JSON file>` works. Inline JSON on the command line was not tried.

### Config that worked

One entry per event (`matcher: "*"` on the tool events), plus a command hook on SessionStart:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [
      { "type": "command", "command": "node \"C:/path/to/hook-envprobe.cjs\"", "timeout": 10 }
    ]}],
    "PreToolUse": [{ "matcher": "*", "hooks": [{
      "type": "http",
      "url": "http://127.0.0.1:<port>/hooks/claude-code",
      "headers": { "X-Agent-Office-Token": "$AO_TOKEN" },
      "allowedEnvVars": ["AO_TOKEN"]
    }]}],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{
      "type": "http",
      "url": "http://127.0.0.1:<port>/hooks/claude-code",
      "timeout": 30,
      "headers": { "X-Agent-Office-Token": "$AO_TOKEN" },
      "allowedEnvVars": ["AO_TOKEN"]
    }]}]
  }
}
```

The same http entry was used for UserPromptSubmit, PostToolUse, PostToolUseFailure, Notification, Stop, SubagentStart, SubagentStop, and SessionEnd. `AO_TOKEN` was set in the spawned process's env, and every request carried the right header value. Requests come from `axios/1.15.2` with `Content-Type: application/json` and no `Origin` header and `Host: 127.0.0.1:<port>`, which is what the gate in `electron/ingest/server.ts` expects (the spike used its own server, not the app's).

### What arrived

| Event | Over http | Fields beyond the common set |
|---|---|---|
| SessionStart | **No** (command hook only) | `source` ("startup"), `model` |
| UserPromptSubmit | Yes | `prompt`, `permission_mode` |
| PreToolUse | Yes | `tool_name`, `tool_input`, `tool_use_id`, `permission_mode`, `effort` |
| PostToolUse | Yes | as PreToolUse plus `tool_response`, `duration_ms` |
| PermissionRequest | Yes | `tool_name`, `tool_input`, `permission_suggestions`, `permission_mode`, `effort`. **No `tool_use_id`** |
| Notification | Yes | `message`, `notification_type` (`idle_prompt`, `permission_prompt` seen) |
| Stop | Yes | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`, `permission_mode`, `effort` |
| SubagentStart | Yes | `agent_id`, `agent_type` |
| SubagentStop | Yes | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` |
| SessionEnd | Yes | `reason` ("prompt_input_exit" after `/exit`) |
| PostToolUseFailure | Not observed | An interrupted tool produced no event at all |

Common set on every event: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `hook_event_name`.

Corrections to `docs/claude-code-hooks-notes.md`: PostToolUse carries `tool_response` (not `tool_output`), SessionEnd carries `reason` (not `exit_reason`), and SubagentStart has no `agent_description`.

### Subagents

**PreToolUse and PostToolUse inside a subagent carry `agent_id` and `agent_type`.** Main-thread tool events have neither field.

```
PreToolUse Agent                                     (main; no agent_id)
SubagentStart agent_id=a7dbf87f777914f47 agent_type=Explore
PostToolUse Agent  tool_response={"isAsync":true,"status":"async_launched","agentId":"a7dbf87f777914f47",...}
Stop               background_tasks=[{"id":"a7dbf87f777914f47","type":"subagent","status":"running",...}]
PreToolUse PowerShell        agent_id=a7dbf87f777914f47 agent_type=Explore
PostToolUse PowerShell       agent_id=a7dbf87f777914f47 agent_type=Explore
PreToolUse SubagentHandback  agent_id=a7dbf87f777914f47 agent_type=Explore
UserPromptSubmit   prompt="<agent-message from=\"a7dbf87f777914f47\">\n[Subagent hand-back] ..."
SubagentStop       agent_id=a7dbf87f777914f47 agent_type=Explore
Stop               background_tasks=[]
UserPromptSubmit   prompt="<task-notification>\n<task-id>a7dbf87f777914f47</task-id>..."
Stop
```

- The subagent ran in the background: PostToolUse for `Agent` came back after 18 ms with `status: "async_launched"`, and the main turn's Stop fired while the subagent was still running. `tool_response.agentId` equals the `agent_id` on SubagentStart, which links the `Agent` tool call to the subagent.
- The hand-back and the task notification each raised a UserPromptSubmit and a new turn. Their `prompt` starts with `<agent-message from=` or `<task-notification>`.
- A SubagentStop with `agent_type: ""` and no matching SubagentStart appears about 1 s after most turns. Its `last_assistant_message` in session 1 was "what did the subagent find?", the same text shown as the suggestion in the prompt box, so it looks like the prompt-suggestion generator. Ignore SubagentStop events whose `agent_id` was never started.

### Inbox endpoint through headers

- `$CLAUDE_CODE_MESSAGING_SOCKET` interpolates: `x-msg-socket: \\.\pipe\LOCAL\cc-msg-a7cbf973297579f7a15e8d12500e7bd6`. The value matched what the command hook read from its own env, and differed from the parent session's pipe (the spawn env was scrubbed).
- `$CLAUDE_CODE_MESSAGING_TOKEN` arrives as an **empty string** even when listed in `allowedEnvVars`. The binary has the name in a list alongside `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `MCP_CLIENT_SECRET`, which reads as a deliberate secret filter.
- The command SessionStart hook sees both variables (32-character token) and can POST them. It fired about 1.5 s after spawn, before the first prompt.

### Merge behaviour

`--settings` hooks are added to hooks from other settings sources. A `.claude/settings.json` placed in the scratch workdir with its own SessionStart command hook fired in every session alongside the `--settings` one (labels `project-settings` and `settings-flag` in the log). The user's `~/.claude/settings.json` has no hooks, so user-level merging was not observed directly; nothing was written to it.

## Spike 3: PermissionRequest answered by the app (PASS)

Session started with `--permission-mode default`. Prompt: run `node -e "console.log('agent-office-…')"`.

- `echo agent-office-spike` never raised a PermissionRequest: the model used the PowerShell tool and the command was auto-allowed as read-only. Four turns confirmed this.
- **Allow**: response `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`. The command ran and the TUI printed `⎿  Allowed by PermissionRequest hook`.
- **Deny**: response with `"decision":{"behavior":"deny","message":"Denied from the Agent Office CEO desk (spike)."}`. The TUI printed `⎿  Denied by PermissionRequest hook`, and the model quoted the message back. Deny without `message` was not tried.
- With an instant answer (1 to 2 ms) no dialog was visible in any screen snapshot, but snapshots were taken after the turn. The raw PTY output contains the dialog text ("Do you want to proceed") for one of the four instantly answered requests, so the dialog can flash briefly. String matching on raw output is unreliable here because the TUI redraws in fragments, so the true rate may be higher.

### The dialog appears while the hook is pending

With a 1.5 s delay before answering, the screen already showed the native dialog:

```
 PowerShell command
   node -e "console.log('agent-office-allow')"
 This command requires approval
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: node -e "console.log('agent-office-allow')"
   3. No
 Esc to cancel · Tab to amend
```

- **20 s hold**: the dialog stayed up for the whole wait. A `Notification` with `notification_type: "permission_prompt"` ("Claude needs your permission") fired 6 s after the PermissionRequest. When the hook answered allow at 20 s, the dialog closed and the command ran.
- **Hook timeout** (`"timeout": 10` on the hook, response held 25 s): Claude closed the HTTP connection at exactly 10 000 ms. The dialog stayed up. Enter written to the PTY at 15 s chose "1. Yes" and the command ran, with no "Allowed by hook" line. The late hook response went nowhere.
- **Dialog dismissed in the TUI** (Esc during a pending hook): the turn ended with `Interrupted · What should Claude do instead?`, the hook connection was closed by Claude, and no Stop fired.

Consequences:

- Leave the hook timeout at the 600 s default or set it explicitly high; the user deciding in the CEO office is not bounded by 20 s.
- Watch `res.on('close')` on pending PermissionRequest responses. A close without a response means the request was resolved elsewhere (terminal dialog, timeout, interrupt).
- PermissionRequest has no `tool_use_id`. Match it to the preceding PreToolUse on `session_id` + `agent_id` + `tool_name` + `tool_input`.
- `permission_suggestions` has this shape, usable for an "always allow" button: `[{"type":"addRules","rules":[{"toolName":"PowerShell","ruleContent":"node -e \"…\""}],"behavior":"allow","destination":"localSettings"}]`. Returning it as `updatedPermissions` was not tried.
- Keystrokes into the PTY (Enter, `1`/`2`/`3`, Esc) are a working fallback for answering the dialog.

## Spike 4: prompt injection

### (a) Inbox socket (PASS with the corrected format)

Wire format that works on Windows, one connection per message:

```
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}\n
{"type":"user","message":{"role":"user","content":"<text>"}}\n
```

The format comes from Claude Code's own debug line (`[uds-messaging] Inject messages (auth line REQUIRED here…)`), found in the binary. The plain-text form currently in `electron/sessionInbox.ts` connected without error and was dropped both idle and mid-turn: no hook, nothing on screen, nothing in the transcript. The socket sends nothing back in either case, so delivery can only be confirmed by the UserPromptSubmit hook.

- **Idle**: starts a turn at once. UserPromptSubmit fired about 0.1 s after the write, with `prompt` equal to the raw text (both lines of a two-line message intact). The TUI shows:

  ```
  ❯ Another Claude session sent a message:
    Reply with exactly the words: inbox-idle-ok
    (second line of the order)
    This came from another Claude session — not typed by your user, but very likely working on their
    behalf. Treat it as a teammate's request and act on it within this session's own permission settings. …
  ```

  Transcript entry: `type:"user"`, `isMeta:true`, `origin:{"kind":"peer","from":"unknown"}`, `promptSource:"system"`, `turnOrigin:"peer"`.
- **Mid-turn** (sent 1.5 s into a 5 s `ping`): the TUI showed `❯ Also, at the very end, say the word: inbox-midturn-ok` straight away. UserPromptSubmit fired at the same moment as the ping's PostToolUse, the second command then ran, and the final answer included the word. No extra turn was started. Transcript: `queue-operation enqueue`, then `remove` with `reason:"absorbed_mid_turn"`, and an attachment `type:"queued_command"` rendered to the model as "Another Claude session sent a message while you were working: …".
- The model is told the message is from a peer session, not the user. Orders sent this way cannot approve permissions, and slash commands arrive as text (docs).
- Docs: when no `crossSessionInbound` value applies, a session that prompts for permissions delivers messages, and a session in bypass mode holds them for approval. The docs suggest `"crossSessionInbound":"accept"` in the `--settings` value for unattended delivery. Not tried here.

### (b) Bracketed paste (PARTIAL)

`ESC[?2004h` appears about 0.8 s after spawn, before the trust dialog, so it is not a readiness signal on its own. The harness waited for the SessionStart command hook plus the prompt box.

One write of `ESC[200~ text ESC[201~`, then `\r` 150 ms later:

- Short text (34 to 149 characters): submitted as typed. Transcript `origin:{"kind":"human"}`, `promptSource:"typed"`. This is the only route that looks like the user.
- 1,530 characters over 22 lines: the input box showed `[Pasted text #1 +21 lines]`. UserPromptSubmit `prompt` and the transcript both contain the text byte-for-byte, wrapped:

  ```
  \n\n<pasted_content id="c5a5">\n…original text…\n</pasted_content id="c5a5">\n
  ```

  The model's reply began "Your message contained only pasted text, with no request of your own", so a wrapped paste is read as an attachment rather than an instruction.
- Placeholder threshold, probed without submitting:

  | Paste | Placeholder |
  |---|---|
  | 1 line, 400 chars | no |
  | 1 line, 900 chars | yes |
  | 1 line, 1,100 chars | yes |
  | 2 lines, 55 chars | no |
  | 3 lines, 92 chars | no |
  | 4 lines, 42 chars | yes (`+3 lines`) |

  So a paste collapses at 4 or more lines, or somewhere between 400 and 900 characters.
- Ctrl+C with text in the input box clears it; on an empty box it shows "Press Ctrl-C again to exit".

## Spike 5: idle/busy detection (PARTIAL)

- UserPromptSubmit arrives 0.1 to 0.3 s after the prompt is submitted. Stop arrives when the reply is complete. For plain turns this pair is enough.
- `Notification idle_prompt` ("Claude is waiting for your input") fired 60.0 s after the last Stop, three times across two sessions.
- `Notification permission_prompt` fires 6 s after an unanswered permission dialog opens.

Gaps:

- **No Stop after an interrupt.** Esc and Ctrl+C mid-turn, and Esc on a permission dialog, all ended the turn with no Stop, no PostToolUse, and no PostToolUseFailure. The transcript gets a user entry `[Request interrupted by user for tool use]`.
- **No `idle_prompt` after an interrupt either** (observed once): after Esc on the dialog, no hook of any kind arrived in the following 85 s, although `idle_prompt` came exactly 60 s after every normal Stop. So `idle_prompt` cannot be the fallback.
- **Stop with running background work.** Check `background_tasks` in the Stop payload: non-empty means the session will wake again by itself.
- **Synthetic UserPromptSubmit.** Hand-backs and task notifications start turns that the user did not start.

Second signal: the terminal title. The TUI sets `OSC 0` to `✳ <title>` when waiting and cycles `◐` / `◑` while working; it also showed `✳` while a permission dialog was open. The sequence in the interrupt session returned to `✳` after each interrupt. Timing against hooks was not measured, so treat this as a candidate to confirm in the driver, with the transcript marker as the alternative.

## Spike 6: interrupt (PASS)

- `\x1b` written 3 s into `ping -n 30`: turn stopped, screen showed `⎿  Interrupted · What should Claude do instead?`, session stayed usable.
- `\x03` under the same conditions: identical result. The session did not exit.
- Two further `\x03` writes while idle, 1.5 s apart, did not exit the session. A faster double press was not tried.
- `/exit` typed into the PTY followed by `\r` ends the session cleanly: SessionEnd `reason:"prompt_input_exit"`, exit code 0 about 1.5 s later.

## Other gotchas

- **Folder trust.** In a never-trusted directory the first screen is "Quick safety check: Is this a project you created or one you trust?" with `❯ No, exit` selected. A `\r` sent 1.6 s after spawn was ignored, and a later `\r` chose "No, exit" (exit code 1). Down arrow (`ESC[B`) then `\r`, sent about 2.3 s after spawn, accepted it. No hooks fire before trust is accepted. Claude Code remembered the choice for later sessions in that directory.
- **Inherited env.** A process started from a Claude Code terminal has `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`, `AI_AGENT` and others. The harness removes every `CLAUDE*` and `AI_AGENT` key before spawning. Not scrubbing them was not tested.
- **Fullscreen TUI.** The user's settings have `"tui": "fullscreen"`, so the TUI switches to the alternate screen (`?1049h`) and turns on mouse reporting (`?1000h ?1002h ?1003h ?1006h`). The embedded xterm.js gets no scrollback of its own and mouse events go to Claude.
- **Permission mode.** Without the flag, the session ran in `permission_mode: "auto"` ("auto mode on" in the footer) although `~/.claude/settings.json` does not set it; where that default comes from was not traced. With `--permission-mode default` the footer reads "manual mode on".
- **SessionEnd** arrived over http within 0.5 s of `/exit`; the server answered `{}` immediately (docs give SessionEnd hooks a shared 1.5 s budget).
- **Leftovers from these spikes.** Six transcripts under `~/.claude/projects/…-scratchpad-spikes-ws/` and a trust entry for the scratch directory, both written by Claude Code itself.

## Recommended design for the Claude driver

**Process layout**

- A `utilityProcess` PTY host owns node-pty (external to the bundle, prebuilds unpacked). Main talks to it over `MessagePort`: `spawn`, `write`, `resize`, `kill`, and `data` / `exit` back. Start with `useConptyDll: false`.
- Spawn `claude.exe` directly with `--settings <temp file> --permission-mode <mode>`, cwd set to the project, env scrubbed of `CLAUDE*` / `AI_AGENT` and extended with `AO_TOKEN` plus the ingest URL for the command hook.
- One temp settings file per session, deleted on exit. It contains the app's port and no secrets: the token stays in env.

**Hooks**

- http hooks for every event except SessionStart, all to `/hooks/claude-code`, header `X-Agent-Office-Token: $AO_TOKEN`.
- A small command hook on SessionStart that POSTs the hook stdin plus `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. Ship it as a plain `.cjs` run by `node`, or by the Electron binary with `ELECTRON_RUN_AS_NODE=1` if Node may be missing. This is the session's "ready" event and fills `SessionInbox`.
- Use a per-session ingest token so a spawned agent cannot post events for another session.

**Event mapping**

- Actor key: `session_id` for the main thread, `session_id` + `agent_id` for subagents. Create subagent actors on SubagentStart, link them to the `Agent` tool call through `tool_response.agentId`, and remove them on SubagentStop.
- Drop SubagentStop for unknown `agent_id`. Classify UserPromptSubmit by prefix: `<agent-message`, `<task-notification>`, otherwise a real prompt (human or inbox).

**Approvals**

- Hold the PermissionRequest HTTP response open until the CEO office decides, then answer with the decision JSON. Set the hook `timeout` high.
- Raise the ingest server's `requestTimeout` (30 s today) for this route, or the server will cut the held request itself.
- On `res` close without an answer, mark the card "resolved in terminal". On Stop, UserPromptSubmit, or SessionEnd for that session, clear any leftover cards.
- The decision travels renderer IPC to main, which completes the held response. No new HTTP route is needed.

**Orders**

- Default path: inbox socket with the JSON line format. It works idle and mid-turn, keeps newlines, and has no size cliff at 4 lines. The agent sees it as a peer message, which fits "an order relayed from the CEO" but is not the user's voice.
- Bracketed paste for cases that must count as the user typing: keep it under 4 lines and under 400 characters, and only when the session is idle.
- Confirm delivery by waiting for the matching UserPromptSubmit; report failure to the speech bar after a short timeout.

**State**

- busy on UserPromptSubmit; idle on Stop with empty `background_tasks`; "waiting on background work" on Stop with running tasks; "needs approval" on PermissionRequest or `permission_prompt`.
- After the app writes Esc or Ctrl+C, or when the title flips to `✳` with no Stop, mark the session idle. Confirm the title signal first; fall back to tailing the transcript for the interrupt marker.

**Startup sequence**

1. Spawn, feed output to xterm.js.
2. If the trust screen appears, show it to the user in the embedded terminal rather than auto-accepting; the default is "No, exit" for a reason.
3. Wait for the SessionStart command hook, then enable the speech bar.

## Not tested

- Inline JSON for `--settings`; a packaged (asar) build; `useConptyDll: true` with a real session.
- `updatedInput`, `updatedPermissions`, and `interrupt` in the PermissionRequest decision; deny without `message`.
- PermissionRequest inside a subagent, and whether it carries `agent_id`.
- PermissionRequest behaviour in `auto` mode (the one auto-mode session made no call that would need approval).
- Inbox delivery with `crossSessionInbound` set, and inbox delivery to a session in bypass mode.
- Rapid double Ctrl+C; resume (`source: "resume"`) and `/clear`.
