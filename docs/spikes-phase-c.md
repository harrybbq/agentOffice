# Phase C feasibility spikes: hosting Google Antigravity CLI (`agy`) headless (2026-10-02)

Environment: Windows 11 Home 10.0.26200, Node 24.19, `agy` 1.2.14 (`%LOCALAPPDATA%\agy\bin\agy.exe`, installed by the
user with Google's installer part-way through). Account: a personal Google account on the free plan, signed in by the
user in the `agy` TUI part-way through (`authMethod=consumer` in agy's log). No Gemini API key, no Code Assist licence.

**Six real model turns were used, which is the whole budget, and four of them were wasted.** The first attempt at
`agy -p "/usage"` went through Git Bash, which rewrote the argument to `C:/Program Files/Git/usage`; agy no longer saw a
slash command and ran a model turn, four times (`/usage` twice, `/model`, `/help`). The two planned turns then ran
with a hook command that Windows quoting broke (see spike 3). So the stream format, multi-turn stdin, hook delivery
and the failure paths are verified, and **the answers of the approval hook (allow, hold, deny) are not**. One more turn
with the corrected script settles it: `node scripts/spikes/agy/check.cjs --only approvals --max-turns 1`.

Weekly quota for "Gemini Models" went from 100 % to 95.5 % over those six turns.

Scripts are in `scripts/spikes/agy/`:

| File | Purpose |
|---|---|
| `lib.cjs` | Finds `agy.exe`, spawns it without a shell (`windowsHide`), scrubbed env, NDJSON session class, JSONL logger, process-tree helpers |
| `probe.cjs` | Everything that costs no quota: version, login probe, print-mode slash commands, where `hooks.json` is discovered, custom agents, the idle process, mode flags, credentials |
| `check.cjs` | The turns: `preflight` (free), `approvals`, `second`, `resume` (free), and three optional ones (`terminate`, `steer`, `ask`). `--max-turns` (default 2) refuses to send more prompts |
| `hook.cjs` | The hook command: posts the hook payload to a local HTTP server and prints the held answer. Dependency-free |
| `mcp-board.cjs` | A 60-line MCP stdio server with one tool, standing in for the planned office board |
| `logs/*.log` | One JSON line per message (`t` ms, `dir` `->` stdin, `<-` stdout, `!!` stderr, `hk` hook, `--` note). Git-ignored (`*.log`) |

Run: `node scripts/spikes/agy/probe.cjs --root <scratch>` and `node scripts/spikes/agy/check.cjs --root <scratch>`.
Both create files only under `--root`. Neither writes to `~/.gemini`.

Sources: the official docs (each page also exists as Markdown: append `.md`, e.g.
`https://antigravity.google/docs/cli/headless.md`), `agy --help`, `agy changelog`, and the guide that ships inside the
binary (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/*.md`, written by agy on first run).

## Summary

| # | Item | Result |
|---|---|---|
| 1 | Install, version, credentials, login probe, usage, models | PASS |
| 2 | Headless streaming: event schema, text deltas, conversation ids, one long-lived process for many turns | PASS |
| 2b | Steer over stdin | PARTIAL: stdin is not read while a turn runs (one probe); a real prompt mid-turn UNTESTED |
| 2c | Interrupt | PARTIAL: no in-band interrupt exists; kill + `--conversation` works for an idle process; a kill mid-command UNTESTED |
| 3 | Headless without a hook soft-denies commands | PASS (observed four times) |
| 3b | `PreToolUse` hooks fire in headless mode, for every tool | PASS |
| 3c | Hooks, rules and MCP supplied per session, user's files untouched (`--add-dir`) | PASS |
| 3d | The hook's answers: `allow` runs a soft-denied command, a 15 s hold, `deny` with a message | **UNTESTED** (script ready) |
| 4 | Other hooks (`PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`) | UNTESTED; documented only |
| 5 | Sandbox on Windows | PARTIAL: flag and setting accepted; nothing ran inside it |
| 6 | Briefing per session | PASS with `AGENTS.md` in the `--add-dir` folder; hook injection UNTESTED |
| 7 | MCP per session | PASS: server started from the `--add-dir` folder's `.agents/mcp_config.json`; the tool call itself UNTESTED |
| 8 | Spawning on Windows | PASS from a console parent; under Electron UNTESTED |
| 9 | Mapping to `ChatItem`, world activities, `PermissionMode`, `permissionText` | Proposal, from the observed schema and the docs |
| 10 | Driver design | Proposal |

## Changes to the plan

1. **The hook is not only the approval bridge, it is the only way a command can run at all.** On Windows every
   `run_command` defaults to Ask, headless mode cannot ask, and the turn ends with an empty response
   (`denied_actions`). The alternatives are `--dangerously-skip-permissions` or writing the user's
   `settings.json`, both ruled out. If a hook `allow` turns out not to lift the soft-deny, Phase C needs a
   different plan (see open question 1).
2. **Hooks can be per session without touching anything of the user's.** `--add-dir <folder>` makes agy load
   `<folder>\.agents\hooks.json`, `<folder>\AGENTS.md`, `<folder>\.agents\mcp_config.json` and
   `<folder>\.agents\agents\*`. The project folder and `~/.gemini` stay untouched. There is no flag or env var that
   points at a hooks file or settings directory.
3. **A hook command must not contain a double quote on Windows.** agy runs `cmd /c <command>` with inner quotes
   backslash-escaped; `node "C:\…\hook.cjs"` reached Node as the literal argument `"C:\…\hook.cjs"`. Name the
   script relative to `hooks.json` (the hook's working directory): `node hook.cjs PreToolUse`.
4. **A broken hook fails closed.** Every tool call of the turn ended as `state: "ERROR"` with a `TOOL_ERROR`, nothing
   ran, the turn went on and the model reported it.
5. **The process is long-lived.** `agy --input-format stream-json --output-format stream-json` reads one prompt per
   line, runs one turn each, keeps one conversation. So: one process per session, like Claude, not one per turn.
   About 145 MB idle and 190 MB after two turns, per session. There is no shared server as with Codex.
6. **No interrupt and no approval on the pipe.** `control_request` / `control_response` are reserved and end the
   session with exit code 2. Interrupt is "kill the process, start it again with `--conversation <id>`".
7. **Two permission axes, and only one is per invocation.** `--mode accept-edits|plan` is a flag. `toolPermission`
   (`request-review`, `strict`, `proceed-in-sandbox`, `always-proceed`) is a `settings.json` key with no flag. The
   app's `PermissionMode` therefore has to live in the hook's own policy.
8. **The stream does not carry enough for a file-change card.** `tool_info.parameters` held only `CommandLine`, or
   only `TargetFile`: no file content and no diff. The content is in the hook payload (`toolCall.args`) and in the
   transcript file. So hooks are needed for the chat view too, not just for approvals.
9. **The free plan is small.** One turn with four tool calls cost 73,000 input tokens (five model calls of about
   14,000 tokens each, `cache_read_tokens: 0`) and 2.3 % of the week. Usage is readable at no cost with
   `agy -p /usage --output-format json`.
10. **The login cannot be driven from the app.** There is no login subcommand and no auth URL on a pipe. The user
    signs in once in the `agy` TUI. The first-run screen leads with a "Google Cloud Project ID / No licenses found"
    path that is the enterprise route; the app's instructions must say "choose the personal Google account sign-in".
11. **Every started process creates a conversation**, prompt or not (`init` arrives before the first prompt). The
    spikes left 13 in the user's agy history.
12. **Never pass a slash command to agy through a POSIX shell on Windows.** See the note at the top.

## Spike 1: install, version, auth, usage, models (PASS)

- Version `1.2.14`. `agy --version` takes 0.1 s. Install folder as documented: "registers the `agy` binary to your
  local user directory: `C:\Users\<username>\AppData\Local\agy\bin`" (https://antigravity.google/docs/cli/install).
  The installer did not put it on the `PATH` of already-open shells. One 191 MB file, no siblings.
- State under `~/.gemini`, all created by agy itself on first run: `antigravity-cli\` (`brain\<conversationId>\`,
  `conversations\<id>.db`, `conversation_summaries.db`, `cache\last_conversations.json`, `cli.log`, `log\`,
  `builtin\skills\`, `bin\webm_encoder.exe`, `updater\`) and `config\` (`mcp_config.json`, empty;
  `projects\default-cli-project.json`). `settings.json` does not exist until the user changes a setting.
- **Credentials are in Windows Credential Manager**, target `LegacyGeneric:target=gemini:antigravity`
  (`cmdkey /list`). Docs: "attempts to access your operating system's native secure keyring (such as Apple Keychain,
  Linux Secret Service/D-Bus, or Windows Credential Manager)". They are not under `~/.gemini`: with `USERPROFILE`
  and `HOME` pointed at an empty scratch folder, `agy models` still listed models.
- **Login probe without a model turn: `agy models`.** 1.5 s.
  - Logged out: exit 1, stderr `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`
  - Logged in: exit 0, one `slug<TAB>label` line per model.
  - The existence of the Credential Manager target is a faster hint, but says nothing about validity.
- Logged out, `cli.log` says `error getting token source: You are not logged into Antigravity.` The binary contains
  `Error: authentication required. Run '%s' to log in, then retry.` A logged-out stream-json start was **not
  run** (the login arrived first); the docs say it "exits with an `authentication required` error instead of hanging".
- **Login** is interactive only: run `agy` in a terminal, a browser opens, sign in. `/logout` in the TUI removes the
  credential. There is no `agy login`.
- **Models** (`agy models`, free plan): `gemini-3.8-flash-high|medium|low`, `gemini-3.7-flash-high|medium|low`,
  `gemini-3.6-flash-high|medium|low`, `gemini-3.1-pro-high|low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`. The changelog (1.1.12) says `models` takes `--output-format json`; 1.2.14 answers
  `flags provided but not defined: -output-format`. Parse the tab-separated text.
- **Current model** (what a run uses when `--model` is omitted): `agy -p /model --output-format json`. Note
  `is_default: false` although nobody chose a model: the first turn's transcript shows agy itself recording "changed
  setting `Model Selection` from None to Gemini 3.8 Flash (High)". What `is_default` means is not documented, so the
  new-session dialog should label this "current", not "default":

```json
{"conversation_id":"","status":"SUCCESS","response":"gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"command":{"name":"model","data":{"id":"gemini-3.8-flash-high","label":"Gemini 3.8 Flash (High)","effort":"high","is_default":false}}}
```

  `/effort` gives `{"adjustable":true,"current":"high","available":["low","medium","high"]}`. `--effort` accepts
  `low|medium|high|max` by `--help`.
- **Usage, machine-readable, no quota**: print mode answers some slash commands itself, "without starting an agent
  turn, spending quota, or leaving a conversation behind" (changelog 1.1.11). `agy -p /usage --output-format json`, 3 s:

```json
{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t98%\t2026-10-09T14:46:26Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-09T14:50:05Z\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,…,"total_tokens":0},
 "command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit. Quota is consumed proportionally to the cost of the tokens. …",
  "groups":[{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","description":"You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours.","window":"weekly","remaining_fraction":0.9824175834655762,"reset_time":"2026-10-09T14:46:26Z"}]},
            {"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-10-09T14:50:05Z"}]}]}}}
```

  - With `--output-format stream-json` the same data arrives as `{"event":"command_result","command":{…}}` followed
    by a `result` event.
  - Two weekly buckets on the free plan, one for Gemini models and one for Claude and GPT models. Paid plans add a
    five-hour window by the docs (https://antigravity.google/docs/plans).
  - The plan name is not in the output. `/credits` fails on the free plan: exit 1,
    `/credits failed: retrieving credits: no credits info found`.
- Print mode answers `/agents /changelog /config /credits /effort /help /hooks /model /permissions /skills /usage`
  (the list `-p /help` prints). `/config` returns every setting with its value, which is how the app can read
  `toolPermission` and `enableTerminalSandbox` without opening `settings.json`.
- **Cost of the six turns**, from `/usage`:

  | Turns | Model | Input tokens | Weekly quota left |
  |---|---|---|---|
  | before | | | 100 % |
  | 4 accidental (one model call each, command soft-denied) | `gemini-3.8-flash-high` | about 12,150 each | 98.24 % |
  | turn 5: four tool calls, five model calls | `gemini-3.8-flash-low` | 73,069 | 95.98 % |
  | turn 6: one tool call, two model calls | `gemini-3.8-flash-low` | 32,459 | 95.48 % |

  Every model call carried about 13,400 tokens of fixed prompt and `cache_read_tokens` was 0 throughout.

## Spike 2: headless streaming (PASS; steer and interrupt PARTIAL)

Flags (`agy --help`, 1.2.14): `--print/-p/--prompt`, `--output-format text|json|stream-json`,
`--input-format text|stream-json`, `--continue/-c`, `--conversation <id>`, `--mode accept-edits|plan`, `--model`,
`--effort`, `--agent`, `--add-dir` (repeatable), `--sandbox`, `--project`, `--new-project`, `--print-timeout`,
`--json-schema`, `--log-file`, `--disable-slash-commands`, `--remote-control`, `--dangerously-skip-permissions`.
`--print-timeout` defaults to `0s` ("0 waits until the turn completes"); the web docs still say five minutes.

### Process model: one process, many turns (PASS)

`agy --input-format stream-json --output-format stream-json` with stdin held open. Docs: "Use `--input-format
stream-json` to maintain a single, continuous conversation process … Each prompt executes a full turn and emits its
own `result` event" (https://antigravity.google/docs/cli/headless). Input, one line per prompt:

```json
{"event":"user","message":{"content":"Run this shell command and wait until it has finished …"}}
```

`content` is a string or `[{"type":"text","text":"…"}]`; "`text` is the only supported block type". No `-p`.

Observed, with `<W>` the project folder and `<C>` the conversation id `23759cc1-7aa2-461c-b426-59c744d413ac`:

```
   spawn agy.exe --input-format stream-json --output-format stream-json --add-dir <session> --model gemini-3.8-flash-low --disable-slash-commands --log-file <file>      cwd <W>
<- {"event":"init","conversation_id":"<C>","init":{"model":"gemini-3.8-flash-low","cwd":"<W>","tools":["ask_custom_permission","ask_permission","ask_question",…58 names…,"write_to_file"],"permission_mode":"request-review"}}      t = 2.4 s, before any prompt
-> {"event":"user","message":{"content":"Do these four steps in order, …"}}
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":0,"state":"DONE","step_type":"user_input"}}                                                   0.15 s later
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":2.0011477,"usage":{"input_tokens":13413,"output_tokens":131,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13544}}}
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \"console.log('ao-one')\""}}}}
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.2177175,"tool_info":{"name":"run_command","parameters":{"CommandLine":"node -e \"console.log('ao-one')\""},"error":{"type":"TOOL_ERROR","message":"JSON hook \"jsonhook__agent-office_PreToolUse_0_0\" failed: command failed: exit status 1, stderr: …"}}}}
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"<W>\\ao-note.txt"}}}}
<- {"event":"step_update","step_update":{…,"step_index":8,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"text":"hi"},"ServerName":"office","ToolName":"board_post"}}}}
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":9,"state":"ACTIVE","step_type":"agent_response","text_delta":"All"}}
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":9,"state":"ACTIVE","step_type":"agent_response","text_delta":" four steps failed during pre-tool execution because the `Pr"}}                     0.1 s later
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":9,"state":"DONE","step_type":"agent_response","text_delta":"eToolUse` hook could not find `hook.cjs`; the only office code word told was `ao-rules-3`.\n","duration_seconds":5.615802,"usage":{…}}}
<- {"event":"result","result":{"conversation_id":"<C>","status":"SUCCESS","response":"All four steps failed during pre-tool execution because the `PreToolUse` hook could not find `hook.cjs`; the only office code word told was `ao-rules-3`.\n","duration_seconds":21.8339505,"num_turns":1,"usage":{"input_tokens":73069,"output_tokens":496,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":73565}}}
-> {"event":"user","message":{"content":"Run this shell command and wait until it has finished …"}}                                                                  same process, 5 s later
<- {"event":"step_update","step_update":{"conversation_id":"<C>","step_index":10,"state":"DONE","step_type":"user_input"}}
   …
<- {"event":"result","result":{"conversation_id":"<C>","status":"SUCCESS","response":"The command failed to execute due to a pre-tool hook failure: …","duration_seconds":32.9389607,"num_turns":2,"usage":{"input_tokens":105528,…}}}
```

- **`init` arrives 2.4 to 4.4 s after the spawn, before any prompt**, with the conversation id, the tool list and
  `permission_mode`. `model` is present only when `--model` was passed. `--mode` and `--sandbox` do not show in it.
- The second prompt ran in the same process and the same conversation: `step_index` went on from 10, `num_turns: 2`.
  `result.usage`, `num_turns` and `duration_seconds` are cumulative, `response` is per turn (as documented).
- **`state` has a third value, `ERROR`**, for a failed tool step. The docs name only `ACTIVE` and `DONE`.
- **Text arrives as deltas**: `agent_response` `ACTIVE` events with `text_delta` fragments about 25 ms apart,
  then a `DONE` with the last fragment. A model call that only emits a tool call gives a single `DONE` with no
  `text_delta`, so "assistant item with empty text" must not be shown.
- `step_index` skips numbers (0, 1, 2, 4, 6, 8, 9): each tool step id appears once as `ACTIVE` and once as `DONE` or
  `ERROR`; the odd indices in between are the model responses. Use `step_index` as the item id.
- **Tool parameters are a subset.** `run_command` showed only `CommandLine` (the transcript has `Cwd`,
  `WaitMsBeforeAsync`, `toolAction`, `toolSummary` too); `write_to_file` showed only `TargetFile` (no `CodeContent`).
  Shell commands are passed bare, with no PowerShell wrapper; one accidental turn showed the model writing
  PowerShell (`Get-Item … ; Test-Path …`), so PowerShell is the shell on Windows.
- **No thinking in the stream.** `thinking_tokens` was 0 on `gemini-3.8-flash-low`. The accidental turns on
  `…-flash-high` did think (500 to 600 thinking tokens, and the transcript has a `thinking` field), but they ran
  with `--output-format json`, so whether thinking has its own `step_type` in the stream is UNTESTED. The docs list
  `user_input`, `agent_response`, `tool`, `checkpoint`; the changelog calls `step_type` a "closed-vocabulary"
  discriminator. No `checkpoint` step appeared.
- A successful tool step was never seen (every call was blocked). From the docs: `DONE` with
  `tool_info.output` (`"hello_headless_demo\r\n"`) and `duration_seconds`. Whether command output streams while
  the command runs is UNTESTED; the documented shape has it only on `DONE`.
- Subagents (docs only): steps "carry `subagent_info` instead, listing each subagent under `subagents` (with
  `type_name`, `role`, `conversation_id`, `log_uri`, and `workspace_uris`)".
- Closing stdin ends an idle session with exit 0 in 0.15 to 0.45 s.
- stderr was empty in normal runs. What appeared: `warning: ignoring unsupported stream input message event "…"`,
  `warning: conversation "…" not found`, and in print mode the soft-deny notice (spike 3).

### Resume (PASS for loading; context after resume from the docs)

- `--conversation <id>` in a new process: `init.conversation_id` equals the id asked for, no warning, 4.4 s.
- **An unknown id is not an error.** stderr gets `warning: conversation "00000000-0000-4000-8000-000000000000" not
  found` and `init` carries a **new** conversation id. Compare the ids.
- `--continue` takes the last conversation of the cwd from `~/.gemini/antigravity-cli/cache/last_conversations.json`
  (a map of absolute folder to conversation id; seen on disk).
- A turn after a resume was not run (budget). The documented example
  (`agy -p "Summarize what we discussed" --conversation …`) is the official behaviour.
- History on disk: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`, one step per line:

```json
{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-02T14:57:06Z","content":"<USER_REQUEST>\nDo these four steps …\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-02T15:57:06+01:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (Low). …\n</USER_SETTINGS_CHANGE>"}
{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"…","tool_calls":[{"name":"run_command","args":{"CommandLine":"\"node -e \\\"console.log('ao-one')\\\"\"","Cwd":"\"<W>\"","WaitMsBeforeAsync":"5000","toolAction":"\"Running node command\"","toolSummary":"\"Run node command ao-one\""}}]}
{"step_index":2,"source":"MODEL","type":"GENERIC","status":"ERROR","error":"JSON hook \"jsonhook__agent-office_PreToolUse_0_0\" failed: …","created_at":"…","content":"Created At: …\nEncountered error in step execution: …"}
{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"…","tool_calls":[{"name":"write_to_file","args":{"CodeContent":"\"hello\\n\"","Description":"\"Create ao-note.txt with hello\"","Overwrite":"true","TargetFile":"\"<W>\\\\ao-note.txt\"","toolAction":"\"Creating note file\"","toolSummary":"\"Create ao-note.txt\""}}]}
{"step_index":9,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"…","content":"All four steps failed …"}
```

  - Argument values are JSON-encoded strings inside the JSON (decode twice). `toolSummary` and `toolAction` are
    short human-readable labels the model writes for each call. `PLANNER_RESPONSE` also has `thinking`.
  - `transcript_full.jsonl` sits beside it. A hook payload names the file in `transcriptPath`.
  - This is enough to rebuild a chat list after a resume. The format is not a documented contract.
- `~/.gemini/antigravity-cli/conversation_summaries.db` (SQLite) has a `conversation_summaries` table:
  `conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, source, project_id,
  agent_name, parent_conversation_id, nesting_depth, killed, last_user_input_time, …`. It is what a `history(cwd)`
  would read. There is no CLI command that lists conversations (`/resume` is TUI only). Not a documented contract
  either; the safe source is the app's own record of the ids it started.

### Steer (PARTIAL)

- Docs: "Wait until you receive the `result` event for the current prompt before writing the next one." Nothing
  official says what happens otherwise.
- Probe: `{"event":"future_thing"}` was written to stdin while the final answer of turn 6 was streaming. The warning
  for it appeared 289 ms later, in the same millisecond as that turn's `result` event. That fits "stdin is read one
  line per turn": a prompt written mid-turn would wait in the pipe and run as the **next turn**, which is a queue
  and not a steer. The gap was short, so this is an indication, not a proof. A real prompt mid-turn was not sent
  (`check.cjs --only steer`, two turns).
- The TUI has a setting for this (`queuedMessages`: `queue`, the default, or `send-immediately` "to interrupt the
  agent"; changelog 1.2.14). `agy -p /config` shows `queuedMessages  queue`. Whether print mode honours it is unknown.
- A steer through a hook is documented: a `PreInvocation` hook may return
  `{"injectSteps":[{"userMessage":"…"}]}`, and the hook fires before every model call, so between tool calls. UNTESTED.

### Interrupt (PARTIAL)

- **There is no in-band interrupt.** Unsupported input, from the docs: "`control_request` or `control_response`
  events: `ERROR` result, session ends, exit 2". The documented statuses include `CANCELED` and `INTERRUPTED`
  ("for example, `SIGINT`"), but Node cannot deliver SIGINT to a windowless child on Windows.
- Killing the process tree (`taskkill /T /F`): agy exited with code 1, its `conhost.exe` and the MCP server child
  were gone 1.5 s later. The process was idle at that moment, because the command it was meant to be running had
  already been blocked by the broken hook. **A kill in the middle of a command, and what happens to that
  command's own child processes, is UNTESTED.**
- The killed conversation loaded again with `--conversation` (same id, 14 transcript steps). The changelog adds:
  "Fixed resuming a conversation whose history had a missing step, for example after a crash or an interrupted
  write" (1.2.14).
- A soft stop through hooks is documented: `PostInvocation` may return `{"terminationBehavior":"terminate"}`
  ("Forces the loop to terminate"), and `PreToolUse` can deny whatever is asked next. It acts at the next model-call
  boundary, not inside a running command. UNTESTED (`check.cjs --only terminate`).

## Spike 3: approvals (PARTIAL)

### Permission settings

- `toolPermission` in `~/.gemini/antigravity-cli/settings.json` (https://antigravity.google/docs/settings):
  - `request-review` (default): "Prompts for your approval before running write, bash, or web tools."
  - `proceed-in-sandbox`: "Automatically runs terminal commands if they are sandboxed; otherwise prompts for review."
  - `strict`: "Prompts for all non-read tools".
  - `always-proceed`: "Runs all tools without prompting".
- It has **no command-line flag**. Per invocation there are only `--dangerously-skip-permissions` (the docs:
  "`permission_mode` is `request-review` by default (and `always-proceed` under `--dangerously-skip-permissions`)"),
  `--sandbox`, and `--mode`.
- `--mode` is the second axis (https://antigravity.google/docs/cli/modes): `default` "Pauses for interactive diff
  review before modifying or creating files"; `accept-edits` "Automatically approves file edits and creations";
  `plan` "Prepends the `/plan` instruction prefix". "Tool permission rules … continue to govern shell commands
  (`run_command`) across all execution modes." `--mode` did not change `init.permission_mode` (probe).
- Fine-grained rules `permissions.allow|ask|deny` of `action(target)` strings (`command(git)`,
  `command(regex:npm run (build|lint|test))`, `write_file(src/)`, `read_url(google.com)`, `mcp(server/tool)`), also
  `settings.json` only. "Deny > Ask > Allow". On Windows "commands that can't be cleanly split into separate words
  require an exact match" (https://antigravity.google/docs/permissions).
- Windows is on the older permission system: "On **Windows**, Antigravity continues to use the previous permission
  system." Defaults there: commands Ask, workspace files allowed, web Ask, MCP Ask.
- A private `settings.json` is honoured when `USERPROFILE` and `HOME` point at a scratch home, and the login still
  works there: `init.permission_mode` came back as `strict` and `proceed-in-sandbox`. It is not usable for hosted
  sessions, because every command the agent runs would inherit the fake home (git, npm, ssh would lose their config).

### What headless does without a hook: soft-deny (PASS)

Docs: "A tool that requires approval it can't obtain is soft-denied: the run continues, exits `0`, and prints a
notice to `stderr` naming the tool and how to allow it. Reading and writing files inside your active workspace is
auto-allowed; actions such as shell commands default to **Ask** and are soft-denied in headless mode unless you
grant them." Observed four times (the accidental turns), with `--output-format json`:

```json
{"conversation_id":"3e7e6c75-cf44-409c-aa51-365924bd538e","status":"SUCCESS","response":"","duration_seconds":4.5616131,"num_turns":1,"usage":{"input_tokens":12149,"output_tokens":677,"thinking_tokens":529,"cache_read_tokens":0,"total_tokens":12826},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}
```

```
stderr: jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.
```

- Exit code 0, `status: "SUCCESS"`, **empty `response`**: the turn ended at the denial, with no final message
  (three transcript steps: the request, the tool call, the error). So a soft-deny looks like a turn that produced
  nothing. `denied_actions` is the signal.
- The error the model is given: `permission check failed for command "…": user denied permission to run command: …
  Do not attempt to circumvent this denial by rephrasing the command, using alternative tools/scripts (e.g. python,
  sh, curl), or accessing the same target resource. Proceed without performing this action.`

### Hooks: configuration (PASS for loading and firing)

Docs: https://antigravity.google/docs/hooks and the copy inside the binary (`…/agy-customizations/docs/hooks.md`).

```json
{
  "agent-office": {
    "PreToolUse":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node hook.cjs PreToolUse", "timeout": 120 }] }],
    "PostToolUse":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node hook.cjs PostToolUse", "timeout": 120 }] }],
    "PreInvocation":  [{ "type": "command", "command": "node hook.cjs PreInvocation", "timeout": 120 }],
    "PostInvocation": [{ "type": "command", "command": "node hook.cjs PostInvocation", "timeout": 120 }],
    "Stop":           [{ "type": "command", "command": "node hook.cjs Stop", "timeout": 120 }]
  }
}
```

- Top-level keys are hook names; `enabled: false` switches one off. Tool events are grouped under a `matcher` (a
  regular expression on the tool name; `""` or `"*"` is all); the other three are flat lists. Only `type: "command"`
  exists: "no HTTP or prompt hooks yet". "Hooks run synchronously and block the agent loop".
- `timeout` is in seconds, default `30`. `600` was accepted and listed as `timeout_seconds: 600`. Whether a hook
  may really block that long, and what a timeout does to the tool call, is UNTESTED. No upper limit is documented.
- Locations: workspace `.agents/hooks.json`; global `~/.gemini/config/hooks.json` or inside
  `~/.gemini/antigravity-cli/settings.json`; a plugin's `hooks.json`. The changelog of the desktop app also says "A
  Markdown agent can list hook files in its front matter with a `hooks:` entry"; not confirmed for the CLI.
- **What is loaded, checked with `agy -p /hooks --output-format json` (no quota)**:

  | Layout | Loaded |
  |---|---|
  | no `hooks.json` anywhere | none |
  | `<cwd>\.agents\hooks.json` | yes |
  | cwd is two levels below the folder that has `.agents\hooks.json`, no `.git` | no |
  | **cwd is the project, `--add-dir <session>` with `<session>\.agents\hooks.json`** | **yes** |
  | cwd is the session folder, the project comes in through `--add-dir` | yes |
  | `USERPROFILE` redirected, `<home>\.gemini\config\hooks.json` | yes |

  The answer names the source file of each hook:
  `{"command":{"name":"hooks","data":{"hooks":[{"name":"ao-side","enabled":true,"source":"<session>\\.agents\\hooks.json","actions":[{"event":"PreToolUse","matcher":"*","type":"command","command":"…","timeout_seconds":600},…]}]}}}`.
  No workspace-trust step got in the way in print mode (the TUI has a trust dialog; `/config` shows an empty
  `trustedWorkspaces`).
- **Hooks fire in headless stream-json mode, from the `--add-dir` folder, for every tool**: `run_command`,
  `write_to_file` (which headless would have auto-allowed) and `call_mcp_tool` each failed with
  `JSON hook "jsonhook__agent-office_PreToolUse_0_0" failed`. In the stream the tool step goes `ACTIVE` first
  (with its parameters) and the hook runs after that: the `ERROR` came 0.05 to 0.1 s later.
- **Windows execution**: "run via `sh -c` on Unix, `cmd /c` on Windows. `~` is expanded to the home directory. The
  working directory is set to the directory containing `hooks.json`" (embedded doc). Confirmed by the failure: Node
  resolved its argument against `<session>\.agents\`.
- **The quoting trap.** Command `node "C:\…\scripts\spikes\agy\hook.cjs" PreToolUse` produced
  `Error: Cannot find module '<session>\.agents\"C:\Users\…\hook.cjs"'`: the quotes arrived as part of the argument.
  Spawning `cmd` with `['/c', command]` from Node reproduces the identical error, and the same emulation, run from a
  folder with a space in its path, gives:

  | Command | Result |
  |---|---|
  | `node "C:\…\hook.cjs" PreToolUse` | fails, as under agy |
  | `node hook.cjs PreToolUse` (script next to `hooks.json`) | works |
  | `node C:\path\without\spaces\hook.cjs PreToolUse` | works |
  | `.\hook.cmd PreToolUse`, with `hook.cmd` = `@"%AO_NODE%" "%~dp0hook.cjs" %*` | works |
  | `hook.cmd PreToolUse` | works only when `NoDefaultCurrentDirectoryInExePath` is not set |

  The last three rows are from the emulation only, not from agy itself.
- The hook process inherits agy's environment: `node` was found through `PATH`, and the MCP server child had the
  harness's `AO_AGY_HOOK_URL` and `AO_AGY_HOOK_TOKEN`. The binary also contains `ANTIGRAVITY_CONVERSATION_ID=%s`
  next to the hook runner's error text, so hooks probably get the conversation id in their environment (not observed).
- A failing hook does not end the session. Each tool call became a `TOOL_ERROR`, the model was told, the turn
  finished with `status: "SUCCESS"`. (Changelog of the desktop app: "A failing custom hook no longer ends the
  session; it is now reported as an error and the conversation continues.")

### Hooks: payloads and answers (documented; the answers UNTESTED)

All payload keys are camelCase. Common fields: `conversationId`, `workspacePaths`, `transcriptPath`,
`artifactDirectoryPath`, `modelName`.

`PreToolUse`, stdin:

```json
{"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","Cwd":"/workspace/project","WaitMsBeforeAsync":5000}},"stepIdx":19,
 "conversationId":"ec33ebf9-0cba-4100-8142-c61503f6c587","workspacePaths":["/workspace/project"],
 "transcriptPath":"~/.gemini/antigravity-cli/brain/ec33ebf9-…/.system_generated/logs/transcript.jsonl",
 "artifactDirectoryPath":"~/.gemini/antigravity-cli/brain/ec33ebf9-…","modelName":"gemini-3.6-flash-medium"}
```

stdout:

```json
{"decision":"deny","reason":"Denied from the Agent Office CEO desk."}
```

- `decision` is required: `"allow"` "Automatically allows the tool execution"; `"deny"` "Hard blocks execution
  immediately"; `"ask"` "Prompts you for approval, but respects 'Always Allow' settings"; `"force_ask"` "Always
  prompts you for approval, ignoring cached permissions"; `"deny_unless_prior_grant"` (web docs only).
- `reason`: "The explanation shown to the agent or to you for the decision."
- `permissionOverrides`: "A list of resource strings (for example, `["read_file(/path)", "command(args)"]`) to
  override default tool permissions"; the embedded doc says "Temporary permission grants".
- `overwrite` (embedded doc only): key-value pairs merged into the tool call's arguments before it runs.
- An empty decision is tolerated (changelog 1.0.15: "safely handling empty decision strings returned by pre-tool
  hooks"); what it then does is not stated.
- Tool argument names by tool (docs): `run_command` `CommandLine, Cwd, WaitMsBeforeAsync, RunPersistent`;
  `write_to_file` `TargetFile, Overwrite, CodeContent, Description`; `replace_file_content` `TargetFile,
  TargetContent, ReplacementContent, StartLine, EndLine, …`; `multi_replace_file_content` `TargetFile,
  ReplacementChunks[]`; `view_file` `AbsolutePath, StartLine, EndLine`; `list_dir` `DirectoryPath`; `find_by_name`
  `SearchDirectory, Pattern`; `grep_search` `SearchPath, Query`; `search_web` `query, domain`; `read_url_content`
  `Url`; `ask_permission` `Action, Target, Reason`; `ask_question` `questions[]`; `invoke_subagent`
  `Subagents[{Prompt, Role, TypeName, Workspace}]`; `call_mcp_tool` `ServerName, ToolName, Arguments` (observed).
- "Tool names are derived by lowercasing the step type and removing the `CORTEX_STEP_TYPE_` prefix."

**Not verified, and each of these decides the design:**

| Question | Why it is open |
|---|---|
| Does `allow` run a command that headless would soft-deny? | The docs say `allow` "Automatically allows the tool execution"; nothing says it outranks the headless Ask |
| Can the hook hold for 15 s, or for minutes? | `timeout` is configurable; behaviour past it unknown |
| What does the model do after `deny` + `reason`? | Expected: the reason reaches the model (it did for the hook failure text) |
| What does `ask` do in headless? | Expected: soft-deny |
| Is `stepIdx` equal to the stream's `step_index`? | Needed to pin the approval card to the tool card |
| Whose `conversationId` does a subagent's tool call carry? | Needed to attribute the request to a worker |

`node scripts/spikes/agy/check.cjs --only approvals --max-turns 1` answers the first three and the fifth in one
turn: the hook holds the first command for 15 s and allows it, allows a file write, denies the second command with
a message, allows an MCP call. `--only ask` is a separate turn.

## Spike 4: other hooks (UNTESTED; documented)

| Event | stdin (besides the common fields) | stdout |
|---|---|---|
| `PostToolUse` | `toolCall {name, args}`, `stepIdx`, `error` ("exit status 1" when the tool failed) | `{}` |
| `PreInvocation` (before each model call) | `invocationNum` (0-based), `initialNumSteps` | `{"injectSteps":[{"ephemeralMessage":"…"} \| {"userMessage":"…"} \| {"toolCall":{"name","args"}}]}` |
| `PostInvocation` (after each model call) | same as `PreInvocation` | `injectSteps`, `terminationBehavior`: `"force_continue"` \| `"terminate"` \| `""` |
| `Stop` (the loop ends) | `executionNum`, `terminationReason` (`"model_stop"`, `"max_steps_exceeded"`, `"error"`), `error`, `fullyIdle` | `decision`: `"continue"` re-enters the loop, anything else lets it stop; `reason` |

- The run registered all five and the stream shows no sign of the other four; their commands were broken in the
  same way, so whether they fired is unknown.
- **Are they redundant with stream-json?** For the world view, yes: `user_input`, tool `ACTIVE` / `DONE` / `ERROR`
  and `result` give thinking, activity and idle. They are not redundant for three things:
  - `PreToolUse`: approvals, and the full tool arguments (file content) that the stream leaves out.
  - `PreInvocation`: briefing and steering (`injectSteps`).
  - `PostInvocation`: the soft stop (`terminationBehavior: "terminate"`).
- Changelog notes: "Fixed `PostToolUse` hooks firing on non-tool steps such as user input and model responses"
  (1.1.9); "Fixed stop hooks that always block hanging the agent forever; after a configurable number of consecutive
  continuations, the hook can no longer block" (1.1.9).

## Spike 5: sandbox on Windows (PARTIAL)

- CLI docs: "the CLI uses native operating system features (`nsjail` on Linux, `sandbox-exec` on macOS, and
  `AppContainer` on Windows)" (https://antigravity.google/docs/cli/features). The sandbox page lists only Linux and
  macOS in its technology table and describes Windows separately: the sandbox is off by default, "None of the
  presets turn the sandbox on", and it is labelled "Enable Sandbox Mode (Preview)". The desktop app's changelog has
  "File and network sandboxing on Windows are now supported."
- Settings: `enableTerminalSandbox: true` and `toolPermission: "proceed-in-sandbox"`; or the flag `--sandbox`
  ("Turns the sandbox on for the session, overriding `settings.json`").
- `proceed-in-sandbox` natively: sandboxed commands run without asking; a command that has to leave the sandbox
  asks (and is soft-denied headless). On Windows the escape rule is `unsandboxed(prefix)`. The sandbox mounts the
  workspace read-write, blocks "sensitive files such as `.env`", and has no network unless a `read_url(domain)`
  rule allows the domain.
- Observed: `--sandbox` is accepted and agy logs `Print mode: enabling terminal sandbox for this session`; a private
  `settings.json` with `proceed-in-sandbox` gives `init.permission_mode: "proceed-in-sandbox"`. No setup step, no
  administrator prompt, no warning. **No command ran in it**, so what it restricts on this machine is unknown.
- For the app: `--sandbox` is the one sandbox control that is per invocation. `proceed-in-sandbox` is not reachable
  without the user's `settings.json`.

## Spike 6: instructions per session (PASS for rules files)

- There is no `--append-system-prompt`. The mechanisms are rules files, custom agents and hook injection.
- **`<session>\AGENTS.md`, with `<session>` passed through `--add-dir`: works.** The file said "The office code word A
  is ao-rules-3", and the answer included `ao-rules-3`. `AGENTS.md` and `GEMINI.md` need no frontmatter and are
  "continuously active (`always_on`)"; files in `.agents/rules/*.md` need `trigger:` frontmatter or are "silently
  discard[ed]" (https://antigravity.google/docs/rules). Limits: 24,000 bytes per file, 20,000 tokens for all rules.
- Custom agent: `<folder>\.agents\agents\<name>\agent.md` (YAML frontmatter `name`, `description`, optional `tools`,
  `model`, `rules:`, `excludeDefaultComponents`; the body is the system prompt), selected with `--agent <name>`.
  `agy --add-dir <folder> agents` listed the agent (`ao-office`); `agy agents` with that folder as the cwd listed
  nothing. Running a turn with `--agent` is UNTESTED, and a custom agent replaces the default one rather than adding
  to it, so `AGENTS.md` is the better fit for a short briefing.
- `PreInvocation` with `{"injectSteps":[{"ephemeralMessage":"…"}]}` at `invocationNum === 0` is the documented way to
  add "a transient system message". UNTESTED.
- The user's own rules still apply (`~/.gemini/AGENTS.md`, the project's `AGENTS.md`): rules are "cumulative rather
  than replacement-based".

## Spike 7: MCP per session (PASS for loading)

- Config: `{"mcpServers":{"<name>":{"command":"node","args":["…"],"env":{…},"cwd":"…"}}}` for stdio, or
  `"serverUrl"` (+ `headers`) for HTTP ("Legacy fields like `url` or `httpUrl` aren't supported"). Also `disabled`,
  `disabledTools`. Global `~/.gemini/config/mcp_config.json`, workspace `.agents/mcp_config.json`
  (https://antigravity.google/docs/mcp). `agy mcp add|remove|list|enable|disable` edits the global file.
- **`<session>\.agents\mcp_config.json`, with `<session>` passed through `--add-dir`: the server was started.**
  - Not at start-up: an idle session did not launch it. It started with the first turn.
  - Its working directory was the project (agy's cwd) and it inherited agy's environment plus the `env` block.
  - agy first sent `server/discover` (protocol `2026-07-28`), got "method not found", then `initialize` with
    `protocolVersion: "2025-11-25"`, client `antigravity-client v1.0.0`, capabilities `elicitation`, `roots`; then
    `tools/list`.
  - `agy mcp list` does not show workspace servers ("No MCP servers configured.").
- The model calls MCP tools through one built-in tool:
  `call_mcp_tool {"ServerName":"office","ToolName":"board_post","Arguments":{"text":"hi"}}`. That is the tool name a
  `PreToolUse` matcher sees. The call was blocked by the broken hook, so a completed MCP call is UNTESTED.
- MCP calls default to Ask (`mcp(server/tool)` rules), so headless they need the hook's `allow` as well.

## Spike 8: spawning on Windows (PASS from a console parent)

- Executable: `%LOCALAPPDATA%\agy\bin\agy.exe` (also try `AGY_PATH`, `~/.local/bin/agy`, `PATH`). A Go binary,
  console subsystem (PE subsystem 3), 191 MB. No shim, no runtime siblings.
- `spawn(exe, args, {cwd, env, stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: false})`. Arguments go as an
  array; nothing needs quoting.
- Process tree of an idle session: `agy.exe` (144 MB) and one `conhost.exe` child. With an MCP server, one more
  child. The "language server" that agy's log mentions runs inside the same process.
- **UNTESTED**: a console window under Electron (the harness ran from a terminal, where `windowsHide` hid the
  `conhost`), and whether the shell commands the agent runs open windows (no command ran).
- Environment: the harness removes `CLAUDE*`, `AI_AGENT`, `CODEX_*`, `ANTIGRAVITY_*`, `AGY_*`, `GEMINI_*`,
  `GOOGLE_GEMINI_*` and sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` (documented in the troubleshooting page; the
  self-updater otherwise runs in the background and takes a lock under `~/.gemini/antigravity-cli/updater/`).
  - `GEMINI_API_KEY` only matters together with `modelProvider: "gemini"` in settings; remove it anyway.
  - `AGY_ADC_AUTH` switches to Application Default Credentials; remove it.
  - Whatever is left is inherited by hooks, MCP servers and the agent's commands.
- Exit codes: `0` clean end (stdin closed); `1` error, also after `taskkill`; `2` unsupported stream message
  (`control_request`, a CLI slash command); `3` a turn that ended on a model or agent error, with an
  `AGY_ERROR: {...}` JSON line on stderr (changelog 1.2.6 and 1.2.10; "multi-turn `stream-json` sessions still warn
  and continue").
- Pass `--disable-slash-commands`: otherwise a prompt that starts with `/` is expanded as a skill or slash command,
  and a CLI-handled one ends the stream session with exit 2.
- Pass `--log-file <per-session file>`: the default `~/.gemini/antigravity-cli/cli.log` is shared, and a given
  `--log-file` is overwritten by each start.

## Spike 9: mapping to the app's models (proposal)

### (a) Stream and hook events to `ChatItem`

| Source | `ChatItem` | Notes |
|---|---|---|
| `step_update` `user_input` `DONE` | `user` | The stream has no text; use the prompt the driver sent. `origin` from the driver |
| `agent_response` `ACTIVE` / `DONE` with `text_delta` | `assistant`, `streaming` until `DONE`; `delta` events on `text` | Create the item on the first `text_delta`; a `DONE` without any text is a tool-call response and gives no item |
| `tool` `run_command` | `command` (`command` = `CommandLine`, `intent: 'exec'`) | `output` from `tool_info.output` on `DONE`; `exitCode` unknown (not in the stream); `cwd` from the hook's `Cwd` |
| `tool` `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` | `file-change` (`path` = `TargetFile`) | `change: 'add'` for `write_to_file` when the file did not exist, else `'update'`. `diff` built by the driver from the hook's `CodeContent` / `TargetContent` + `ReplacementContent`; empty if the hook did not see it |
| `tool` `view_file`, `list_dir`, `find_by_name`, `grep_search` | `command` with `intent` `read` / `list` / `search` and a synthetic command text, or `tool` | Same choice as for Claude's Read / Glob / Grep |
| `tool` `search_web`, `read_url_content`, `open_browser_url`, `read_browser_page` | `web` (`search` with `query`; `open` with `Url`) | |
| `tool` `call_mcp_tool` | `tool` (`server` = `ServerName`, `tool` = `ToolName`, `input` = `Arguments`) | |
| `tool` `invoke_subagent`, `send_message`, `manage_subagents`; `subagent_info` | `subagent` (`spawn`, `message`, `close`) | `childAgentId` = `subagentId(sessionId, subagent.conversation_id)` |
| any other `tool` (`schedule`, `manage_task`, `generate_image`, `browser_*`, …) | `tool` | |
| `tool` state `ERROR` | the item's `status: 'failed'`, `error` text | `'declined'` when the driver itself answered `deny` |
| `PreToolUse` hook held open | `approval` (`subjectId` = the tool item, by `stepIdx`) | |
| `ask_question`, `ask_permission` tool calls | `notice`, or an approval card for `ask_permission` | Changelog: headless "the agent settles a choice itself where it would otherwise ask" |
| `result` | `turn` event: `SUCCESS` completed, `ERROR` failed (`error`), `CANCELED` / `INTERRUPTED` interrupted | `denied_actions` gives a `notice` |
| stderr `warning: …`, `AGY_ERROR: {…}` | `notice` | |
| thinking | `reasoning` | Only if the stream turns out to carry it (UNTESTED). The transcript has it |
| plan | none | `--mode plan` produces a plan as an artifact; no stream shape seen |

Item id: `step_index` of the conversation (stable, unique per conversation).

### (b) To world activities

| Event | Activity |
|---|---|
| `user_input` | none (the mapper's "thinking" state) |
| tool `ACTIVE`: `view_file`, `list_dir`, `find_by_name`, `grep_search`, `read_resource`, `list_resources` | `read` |
| tool `ACTIVE`: `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit`, `generate_image` | `write` |
| tool `ACTIVE`: `run_command`, `send_command_input`, `command_status`, `manage_task`, `notebook_execution`, `call_mcp_tool`, `run_workflow`, `schedule` | `exec` |
| tool `ACTIVE`: `search_web`, `read_url_content`, `open_browser_url`, `read_browser_page`, other `browser_*` | `web` |
| tool `ACTIVE`: `capture_browser_screenshot`, `capture_browser_console_logs` | `capture` |
| a `PreToolUse` request waiting for the CEO | `waiting`; back to the tool's activity when answered |
| tool `ACTIVE`: `invoke_subagent` | spawn one worker per `subagent_info.subagents[]`, `parentId` = the session |
| `result` (any status) | `idle` |
| process exit, `stop()` | `done` |

### (c) `PermissionMode` to agy

`toolPermission` stays whatever the user has (normally `request-review`). The mode is `--mode` plus the hook's policy:

| `PermissionMode` | Flags | Hook policy for `PreToolUse` |
|---|---|---|
| `default` | none | Ask the CEO for `run_command`, `send_command_input`, the file-writing tools, `call_mcp_tool`, `read_url_content`, browser tools, `invoke_subagent`, `ask_permission`. Allow the read tools at once when the path is inside the workspace, else ask |
| `acceptEdits` | `--mode accept-edits` | As `default`, but file-writing tools inside the project folder are allowed at once |
| `plan` | `--mode plan` | Deny every write and command with the reason "plan mode: describe the change instead". Needed because, by the changelog, "non-interactive runs now proceed through plan review automatically" |

- This matches the decision "ask before commands, approvals go to the CEO inbox", and it also asks for edits in
  `default`, which Claude's `default` does and headless agy would not.
- Writes into the session folder (`hooks.json`, `hook.cjs`, `AGENTS.md`) are denied in every mode (see the design).
- `always-proceed` and `--dangerously-skip-permissions` are not offered.
- All of it depends on the UNTESTED hook `allow`.

### (d) Approvals to `shared/permissionText.ts`

`plainPermission({who, tool, input, cwd})` already has the cases; the driver maps:

| agy tool | `tool` | `input` |
|---|---|---|
| `run_command` | `Command` | `{command: args.CommandLine}`; `cwd` = `args.Cwd` |
| `send_command_input` | `Command` | `{command: "input to a running command"}` |
| `write_to_file`, new file | `Create` | `{file_path: args.TargetFile}` |
| `write_to_file` with `Overwrite`, existing file | `Write` | `{file_path: args.TargetFile}` |
| `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` | `Edit` | `{file_path: args.TargetFile}` |
| `view_file`, `list_dir`, `find_by_name`, `grep_search` (outside the workspace) | `Read` | `{file_path: args.AbsolutePath ?? args.DirectoryPath ?? args.SearchDirectory ?? args.SearchPath}` |
| `read_url_content`, `open_browser_url` | `WebFetch` | `{url: args.Url}` |
| `search_web` | `WebSearch` | `{query: args.query}` |
| `call_mcp_tool` | `mcp` | `{server: args.ServerName, tool: args.ToolName}` |
| `invoke_subagent` | `Agent` | `{description: args.Subagents[0].Role}` |
| `ask_permission` | `Permissions` | `{wants: ["<Action> <Target>"]}` built from `args.Action` and `args.Target`, with `args.Reason` in the card detail |
| `browser_*`, `click_browser_pixel`, `execute_browser_javascript` | `mcp` | `{server: "browser", tool: name}`: the existing screen/browser wording and `caution` apply |

- `CommandLine` is the bare command, so `innerCommand()` has nothing to strip.
- `permissionText.ts`'s `AGENT_CONFIG` pattern covers `.claude`, `.codex`, `.gemini` but not `.agents`; a write to a
  project's `.agents\hooks.json` should be `danger` too. That file belongs to another task, so it is only noted here.
- `PermissionRequestInfo.detail`: the command and cwd, or the path plus the new content / replacement text from
  `toolCall.args`, truncated by `describeToolInput`.

## Spike 10: proposed driver design

**Process**

- `AgyDriver implements AgentDriver`, `surface: 'chat'`, one `agy.exe` per session:
  `agy --input-format stream-json --output-format stream-json --add-dir <session dir> --disable-slash-commands
  --log-file <session dir>\agy.log [--model <slug>] [--mode accept-edits|plan] [--conversation <id>]`, cwd = the
  session's folder, env scrubbed as in spike 8 plus `AO_AGY_HOOK_URL` and `AO_AGY_HOOK_TOKEN`. `ctx.pty` is unused.
- Session dir, owned by the app (for example `<userData>\agy-sessions\<sessionId>\`), written before the spawn and
  deleted after exit:

  ```
  AGENTS.md                 the Agent Office briefing
  .agents\hooks.json        PreToolUse (matcher "*"), PostToolUse, PreInvocation, PostInvocation; commands ".\hook.cmd <Event>"
  .agents\hook.cmd          @"%AO_NODE%" "%~dp0hook.cjs" %*      (AO_NODE = the Electron exe, with ELECTRON_RUN_AS_NODE=1)
  .agents\hook.cjs          the forwarder (scripts/spikes/agy/hook.cjs)
  .agents\mcp_config.json   the office board server, later
  ```

- Memory: about 145 to 190 MB per session. With memory tight, cap the number of live agy sessions, or stop idle
  ones and resume on the next prompt (`--conversation`, 2.5 to 4.5 s to `init`).

**Probe and login**

- `available`: the exe exists and `agy --version` runs. `account.loggedIn`: `agy models` exits 0 (cache the result;
  re-check when a start fails). The model list for the new-session dialog comes from the same call.
- Sign-in from the app: open a terminal pane (the app already has the pty host) running plain `agy`, with a line of
  guidance above it: "Choose the personal Google account sign-in, not the Google Cloud project path". Poll
  `agy models` every few seconds until it exits 0, then close the pane. `ProviderDefinition.login()` does this.
- `usage`: `agy -p /usage --output-format json` after each turn and on a slow timer:
  `usedPercent = (1 - remaining_fraction) * 100` of the bucket for the session's model family, `resetsAt` =
  `reset_time`, `windowMinutes = 10080`. `account.plan` is not available.

**`AgentDriver` mapping**

| Interface | agy |
|---|---|
| `start()` | Probe the login, write the session dir, spawn, wait for `init`. With `start.resume`, compare `init.conversation_id` to it and fail with "conversation not found" if they differ, then rebuild the chat list from `transcript.jsonl` |
| `providerSessionId` | `init.conversation_id` |
| `state` | `starting` until `init`; `busy` from the prompt's `user_input` step to `result`; `waiting-permission` while a `PreToolUse` request is held; `idle` after `result`; `needs-attention` when the login probe fails; `exited` on process exit |
| `canReceiveOrders` | `idle`; `busy` too, once one of the steer routes is verified |
| `sendPrompt(text)` idle | Write `{"event":"user","message":{"content":taggedOrder(text)}}`. `{ok: true, queued: false}` when the `user_input` step arrives (0.05 to 0.15 s) |
| `sendPrompt(text)` busy | Hold the text in the driver and return `{ok: true, queued: true}`. Deliver it at the next `PreInvocation` hook as `injectSteps: [{userMessage}]` if that works (UNTESTED); otherwise write it to stdin after `result`, as the next turn |
| `answerPermission(id, decision)` | Resolve the held hook response: allow gives `{"decision":"allow"}`, deny gives `{"decision":"deny","reason": message ?? DEFAULT_DENY_MESSAGE}`. The deny message travels in the answer; no follow-up steer is needed |
| `interrupt()` | Set a stop flag (pending and later `PreToolUse` requests are denied, `PostInvocation` answers `terminate`); if no `result` arrives within a few seconds, kill the process tree, mark open items `interrupted`, emit `turn interrupted`, and respawn with `--conversation` on the next prompt |
| `stop()` | Close stdin (exit 0 within half a second when idle); `taskkill /T /F` after a timeout; remove the session dir |

**The approval bridge**

- `hook.cjs` reads the payload from stdin and POSTs it to the ingest server
  (`http://127.0.0.1:<port>/agy/hook/<Event>`, header `x-ao-token: <per-session token>`). **That request is the
  question.** The main process registers it in `PermissionRegistry` (`add()` with `onResolved` and the request's abort
  signal) and keeps the HTTP response open. The decision arrives only through `PermissionRegistry.decide()`, which
  only renderer IPC calls. The held response then carries the answer back, and `hook.cjs` prints it. This is the
  Claude `PermissionRequest` design with a script in between, because agy has command hooks only.
- There is no HTTP route that takes a decision. An agent that knows the token (it can read its environment and the
  session dir) can only ask more questions.
- A forged question must not produce a card: accept a `PreToolUse` request only if the stream has shown a tool step
  `ACTIVE` with the same tool name (and the same `stepIdx`, if that holds) that is not yet `DONE`, and only one
  request per step.
- The policy of spike 9 (c) runs in the main process, not in the script: the script forwards everything.
- If the app cannot be reached, `hook.cjs` answers `deny` for `PreToolUse` and `{}` for the rest. A crashed or
  missing hook blocks the tool as well (observed).
- `hooks.json` `timeout`: a large value, so the CEO can take minutes. When agy gives up first, the HTTP request is
  aborted and the registry resolves the card as `resolved-elsewhere`.
- **The session dir is a workspace, so the agent may write to it.** It could replace `hook.cjs` with one that prints
  `allow`. Guards:
  - the policy denies every tool call whose target path is inside the session dir, and every command that names it;
  - the driver hashes `hooks.json`, `hook.cmd` and `hook.cjs` at each `PreToolUse` and stops the session on a change;
  - a command approved by the CEO can still do it, as with any agent that is allowed to run commands.
  If the hooks are removed altogether, commands fall back to the soft-deny, which fails closed; edits inside the
  project would then go through unasked.
- `PostToolUse` closes the tool card with the full arguments; `PreInvocation` carries the briefing fallback and
  steers; `PostInvocation` carries the stop flag. No `Stop` hook is needed (`result` says the same).

**What stays impossible or weak**

- Interrupting inside a running command without killing the process.
- Approvals and steering on the stdio pipe (reserved `control_request`).
- A login started and completed by the app.
- Live command output, exit codes and diffs from the stream alone.
- Setting `toolPermission` or permission rules per session.
- Avoiding one empty conversation per process start in the user's agy history.
- On the free plan, more than a few dozen tool-using turns a week.

## Open questions

1. **Does a `PreToolUse` `allow` lift the headless soft-deny?** One turn answers it (`--only approvals`). If it does
   not, the candidates are, in this order: `allow` plus `permissionOverrides: ["command(<the exact command>)"]`;
   a private home (`USERPROFILE`) with `toolPermission: "always-proceed"` and the hook as the only gate, at the price
   of a fake home for the agent's commands; `--dangerously-skip-permissions` with the hook as the only gate (a
   broken hook fails closed, a removed one does not). The last two change the risk and need the user's decision.
2. How long may a hook block? Is there a ceiling on `timeout`, and does the model retry after a timeout?
3. Is the free plan enough for this provider at all? 2.3 % of the week for one four-tool turn; no prompt caching was
   seen. Should the new-session dialog default to a `…-low` model and show the remaining quota?
4. Should hosted agy sessions ask for file edits in `default` mode (as proposed), given that agy itself would not?
5. Is one 150 to 190 MB process per session acceptable, or should idle sessions be stopped and resumed?
6. Should the app read agy's `conversation_summaries.db` and `transcript.jsonl` (undocumented formats) for the
   history list and for rebuilding a chat after resume, or keep its own records only?
7. The 13 conversations the spikes left in the user's agy history: delete them? The CLI has no delete command; the
   TUI's `/resume` picker has Ctrl+Delete.

## Not tested

- The hook answers (`allow`, a 15 s hold, `deny` with a reason, `ask`), `permissionOverrides`, `overwrite`.
- Any tool that actually ran: command output in the stream, a file edit, an MCP call, web tools.
- `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` payloads; briefing and steer injection; the soft stop.
- A real prompt written to stdin mid-turn; a kill in the middle of a command and a turn after resuming from it.
- A turn after `--conversation`; `--continue`.
- A logged-out start of a stream-json session; the sign-in flow itself (the user did it in a terminal).
- Thinking in the stream; `checkpoint` steps; subagents (`subagent_info`, whose `conversationId` a hook reports).
- `--mode plan` and `--mode accept-edits` in a turn; `--agent`; `--sandbox` with a command; `--json-schema`.
- Console windows when spawned from Electron; a packaged build; the `hook.cmd` shim under agy itself.
- Exit code 3 and the `AGY_ERROR` line; hitting the quota limit.

## Leftovers from these spikes

- **13 conversations in the user's agy history** (`~/.gemini/antigravity-cli/brain/` and `conversations/`), all with
  scratch folders as their workspace:
  - 4 accidental turns: `3e7e6c75-cf44-409c-aa51-365924bd538e`, `02562ec8-d6e6-4612-80db-3d34e19e9bd7`,
    `66a2cf94-659a-49e8-b5a5-8075f72330e1`, `d96cf029-e293-4bcc-9c7f-69a085d3836b`.
  - the two planned turns: `23759cc1-7aa2-461c-b426-59c744d413ac`.
  - 8 empty ones from idle starts (`0afc51a7…`, `46e2d821…`, `40a8a486…`, `c1172011…`, `e9501698…`, `ba743690…`,
    `fea01786…`, `ffd25559…`).
- `~/.gemini` itself did not exist before; agy created it on its first run (`agy models` while logged out). The
  spikes wrote no file there. No `settings.json`, no global `hooks.json`, no MCP server was added.
- `~/.gemini/antigravity-cli/cache/last_conversations.json` has two entries for scratch folders.
- The scratch root (`…\scratchpad\agy-spike`, outside the repo) holds the project and session folders, two scratch
  homes with their own `.gemini`, and agy log files. `ao-note.txt` was never written.
- 4.5 % of the week's Gemini quota.

## Approval hook in headless mode — VERIFIED 2026-10-02 (1 turn)

`node scripts/spikes/agy/check.cjs --only approvals --max-turns 1`

- **FAIL: a PreToolUse hook `allow` does NOT lift the headless soft-deny.** The hook fired, was held 15 s, returned
  `{"decision":"allow"}`, and agy still ended the step with `state: "ERROR"`,
  `permission check failed … user denied permission to run command`, `denied_actions: [RunCommand]`. agy's stderr:
  "a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an
  allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with
  --dangerously-skip-permissions".
- **PASS: holding the hook 15 s works** (agy waited; step duration 15.1 s).
- **PASS: `PreInvocation` → `{"injectSteps":[{"ephemeralMessage": …}]}` reaches the model** — usable for the briefing
  and for the board digest, cheaper than an AGENTS.md in the session folder.

Consequence: the app must BE agy's permission system. agy's own permission checks are lifted (per-session
`permissions.allow`, if `--add-dir` honours a `.agents/settings.json`; otherwise `--dangerously-skip-permissions`) and
the PreToolUse hook is the only gate, failing closed. Must verify with permissions lifted: hook `deny` blocks, an
unreachable/failing hook blocks, hook `allow` runs. Fallback: agy's TUI in a PTY (approvals in the terminal).

## The gate with agy's checks lifted — VERIFIED 2026-10-02 (1 turn): PASS

- `--add-dir <session>/.agents/settings.json` (or `config.json`, or `<cwd>/.agents/settings.json`) with
  `permissions.allow` / `toolPermission` is **not honoured** (`/config` and `/permissions` unchanged;
  `scripts/spikes/agy/probe-settings.cjs`, zero quota). So the only per-session way to lift agy's own checks is the
  `--dangerously-skip-permissions` flag.
- With that flag, the PreToolUse hook is the only gate, and it **fails closed in every case tested**
  (`check.cjs --only gate`, four commands in one turn):

| Hook answer | Result |
|---|---|
| `{"decision":"allow"}` | command ran, output `ao-allow` |
| `{"decision":"deny","reason":…}` | step `ERROR`: "tool call denied by pre-tool hook: <reason>" |
| hook process exits 1 with no output | step `ERROR` ("JSON hook …"), command did not run |
| `{}` (no decision) | step `ERROR`: "tool call denied by pre-tool hook" |

  The model reported `1: ao-allow, 2: REFUSED, 3: REFUSED, 4: REFUSED` and did not retry.
- Design consequence: the agy driver starts sessions with the flag AND refuses to start unless `/hooks` (free) lists
  the app's PreToolUse hook for that session folder; the hook script denies when the app can't be reached; the
  session folder is guarded against writes by the agent (deny in the hook + hash check before each turn).
- Cost note: that single turn used 67.6k input tokens.
