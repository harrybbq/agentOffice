# Agent Office

A desktop app that shows AI agents at work as little characters in a themed scene, driven by real events from the agents.

- **Office theme (default):** you are the CEO. Each Claude Code session is a manager with a team, and its subagents are desk workers.
- **Prison theme:** you are the warden, sessions are guards, and subagents are prisoners.

Characters walk to where the work happens:

| Activity | Where they go |
|---|---|
| Reading files | Filing cabinet |
| Editing | Typing at their desk |
| Web fetch | Printer ("copying") |
| Screenshot | Photo booth |
| Blocked on a permission request | Workers bring a memo to their manager's office; the manager carries it to **your** reception |

When a subagent starts, its manager hands over a folder at a free desk. When it finishes, it carries a report back to the manager.

### Who may go where
- **Each team has its own colour** (theme `teams.colors`): the branch sign, the session list, the manager's
  clipboard and collar, and a collar + chest badge on every worker of that team. Each manager also has a
  **distinct face** (hairstyle, hair colour, skin tone), picked deterministically per team and kept unique
  among live managers where possible. Body colour = provider, as before.
- **Workers stay in their branch.** They only use stations in their own branch (a station type the
  branch lacks sends them to their desk) and never walk into corridors, other branches or the HQ.
- **Only managers come to CEO reception.** A waiting worker takes its memo to its manager's office and
  waits there. The manager picks the memo(s) up, walks the corridors to the HQ inbox (memo + count
  badge), and waits there while anyone in its team is waiting. It then goes home. The manager's own
  activity meanwhile is collapsed to the latest event and done afterwards. A manager that is waiting
  itself goes to the inbox directly. Managers use corridors and the HQ but never walk through another
  branch. The CEO inbox still lists every waiting agent.
- **Office-wide orders** (see below) lift the branch rule: workers may use the nearest station
  anywhere, bring memos straight to the HQ inbox and use the corridors. The mode shows a green
  "Office-wide task in progress" pill. It ends when every team that received the order has gone `idle`/`done`,
  after a timeout (`officeWideMinutes`, default 10), or when you click the pill. Workers then walk home.

### The window
The app is your main window onto the agents, not only a viewer:

- **Sessions (left).** Hosted sessions grouped by provider, each with its team colour, folder and
  state dot (starting, needs attention, idle, working, waiting for permission, exited), a badge for
  pending requests and `+N` for its subagents. **New session** opens a dialog: provider, folder
  (type or paste a path, or **Browse…**), permission mode, optional title and model. A session
  without a title of its own is named after its model ("Opus 5.5"; "Claude Code" until the model
  is known), with the folder added when two sessions would share a name ("Opus 5.5 · api"). The
  manager and the branch sign in the world carry the same name. Sessions that
  run outside the app are listed under **Observed**.
- **World (centre).** The office. Click a session to focus its branch; double-click the world or
  use the corner button to fit the whole office again.
- **Order bar (under the world).** Pick **Everyone**, a provider or one session, type, press
  **Enter** (**Shift+Enter** adds a line, Esc leaves the field). The CEO says it in a speech
  bubble and a sealed order envelope flies to the manager(s). For more than one session a PA
  banner also runs across the top. The result shows above the bar ("Delivered to 2", or who
  failed and why). Orders are **on by default**; turn them off (and on again) with **Orders: on/off**
  in the status bar, or **Allow CEO orders** in the tray.
- **Panel (right, or under the world in a narrow window).** Two tabs. **Terminal** is the
  selected session's real terminal, with **Interrupt** and **Stop** (asks first). **Events** is
  the live event log, filterable by activity and by the selected session. Drag the splitter to
  resize, double-click it to reset; the dock button moves the panel between right and bottom.
- **CEO inbox.** Permission requests with **Allow** / **Deny** (Deny takes an optional reason
  that the agent sees). Each card leads with one plain sentence ("Opus 5.5 wants to run the tests
  (`npm test`)."), made from fixed templates in `shared/permissionText.ts`, never by a model. A
  request to be careful with has an amber badge ("Careful: Installs software"), a dangerous one a
  red badge ("Deletes files") and a slower Allow: click **Allow anyway**, or press **A** twice. The
  raw tool name, command and input are under **Details**. With the list focused: arrows move, **A** allows, **D** denies, **E**
  shows the full request, Enter opens that session's terminal. Requests that only a terminal can
  answer are listed below, with a link to it.
- **Status bar.** Connection, running sessions, pending requests, event count, **Orders: on/off**
  (the same switch as the tray's Allow CEO orders), light / dark interface, panel toggle, and **Quit**
  (asks first; closing the window only hides the app to the tray, and quitting stops the hosted sessions).

| Shortcut | Does |
|---|---|
| Ctrl+N | New session |
| Ctrl+1 … Ctrl+9 | Select that session and focus its terminal |
| Ctrl+` | Show / hide the panel |
| Ctrl+K or / | Focus the order bar (inside a terminal, Ctrl+K and / go to the agent) |
| Ctrl+Shift+O | Overlay mode (world only, click-through) |

**In the terminal.** Every other key goes to the agent. **Shift+Enter** inserts a new line in the
agent's input. **Ctrl+V** pastes (as a bracketed paste, so a multi-line paste is not submitted).
**Ctrl+Shift+C**, or Ctrl+C with a selection, copies. Claude Code's fullscreen interface handles
the mouse itself (its own selection, paste on right-click, the wheel scrolls its transcript);
hold **Shift** while dragging for the terminal's own selection. In a program that doesn't use the
mouse, right-click copies the selection or pastes. While the window is hidden (tray, minimised)
its terminals are detached, so a throttled window never slows an agent down; they come back with
the current screen when you show it.

## Hosted sessions

The app can launch agents itself and be your main window onto them. It hosts **Claude Code** in an
embedded terminal (described first) and **Codex** in a chat view (see [Codex](#codex)).
Antigravity is listed as a provider but has no driver yet.

**How a session is launched.** You pick a provider and a folder. The main process then:

1. resolves the official `claude` executable from a fixed table (the renderer never supplies a
   command, arguments or environment),
2. writes two temporary files to `<config dir>/sessions/`: `<session id>.settings.json` (hooks)
   and `<session id>.briefing.md` (what the session is told about the app),
3. starts `claude --settings <settings file> --permission-mode <mode> --append-system-prompt-file
   <briefing file>` (plus `--model` / `--resume` if you chose them) in a pseudo-terminal, with the
   folder as working directory, and
4. shows that terminal in the app. It is the real Claude Code TUI: typing in the pane is typing
   in your own terminal.

**Your settings files are never modified.** Not `~/.claude/settings.json`, not the project's
`.claude/`. Everything the app needs is in the temporary files. Claude Code *adds* the hooks of the
settings file to your own. That file holds the app's port and a script path but no secret, and both
files are deleted when the session ends (leftovers of a crash are removed at the next start). Claude Code itself still
writes what it always writes: its transcript, and its record that you trusted the folder.

**What the temporary file injects.** A deny rule for the `ListAgents` and `SendMessage` tools
plus `isolatePeerMachines: true`, so a hosted session cannot discover or message your other
Claude Code sessions. This isolates the hosted session's *outbound* side only: orders from the
app still arrive (the inbox is inbound, and `crossSessionInbound` is deliberately left unset),
and another local session could still address a hosted session by name. A full inbound lockdown
(`crossSessionInbound: "refuse"` with orders typed into the terminal instead) is a possible
future "strict isolation" option; it is not built. And `type: "http"` hooks for UserPromptSubmit, PreToolUse,
PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, SubagentStart, SubagentStop
and SessionEnd, all posting to the app's `/hooks/claude-code`, and one `type: "command"` hook on
SessionStart (`hook/claude-session-start.cjs`, run with `node`, which must be on your PATH). The
command hook exists because SessionStart cannot be an http hook and because only a command hook can
read the session's inbox endpoint. Observation hooks time out after 5 s, so a dead app never stalls
Claude.

**What the session knows.** The briefing is about 200 words appended to Claude's system prompt:
it was started from Agent Office, it manages a team (named as the session was at launch), its subagents show
up as workers, permission requests also appear in your CEO inbox, orders from the order bar
may arrive as a cross-session message starting with `[CEO order via Agent Office]`, and
cross-session messaging tools are disabled. It is context
only and asks for no change in behaviour. The template is `electron/drivers/claudeBriefing.ts`.

**Session states.** `starting` → `idle` once SessionStart arrives. If it doesn't within about 4 s
the session shows `needs-attention`: Claude Code is asking something only the terminal can answer,
usually "do you trust this folder?" or a login. Answer it in the pane; the app never accepts folder
trust for you. Then `busy` while a turn runs, `waiting-permission` while a request is pending, back
to `idle` on Stop, and `exited` when the process ends. Claude Code sends no Stop after Esc or
Ctrl+C, so after an interrupt the app reads the terminal title (`✳` = waiting for input) and
settles on `idle` about 2.5 s later.

**Permission flow.** When Claude Code needs approval it calls the PermissionRequest hook and the
app holds that HTTP request open (the hook's timeout is one hour). A card appears in your office
and the blocked agent walks over with a memo. Claude Code shows its own dialog in the terminal at
the same time; whichever is answered first wins.

- You decide in the app: the held request is answered with allow, or deny plus your message, and
  the terminal prints "Allowed by PermissionRequest hook".
- You answer in the terminal, press Esc, or the hook times out: Claude Code closes the connection
  and the card disappears ("resolved elsewhere").
- Sessions you did not start from the app get an empty answer at once, so their own terminal
  dialog decides. They show up in the office but cannot be approved from it.

**Orders.** With **Allow CEO orders** on, the order bar delivers text to one session, to every
session of a provider, or to the whole office. Delivery uses the session's Claude Code inbox socket
(a named pipe on Windows), reported by the SessionStart hook and kept in memory only. The agent
sees an order as a message from another session, not as you typing: Claude Code shows it as
"Another Claude session sent a message" with its usual caution about such messages, it cannot
approve a permission, and a slash command arrives as plain text. The first line of an order is
`[CEO order via Agent Office]`, which the briefing explains. For anything that needs your own
authority, type it in the session's terminal. An idle session confirms an order through
its UserPromptSubmit hook within a few seconds; a busy session queues it and picks it up between
tool calls, which the app reports as delivered. If a session has no inbox socket, a short order is
typed into its terminal instead (without the tag: there it is your own typing), and only while it
is idle.

**Security rules.**

- Approving a permission and sending an order travel over the app's internal IPC only. **No HTTP
  route does either**, because every agent the app launches can reach the HTTP port.
- Each hosted session gets its own random ingest token. It is accepted on `/hooks/claude-code`
  only, and only as that session; it cannot post to `/events`, open `/ws`, or speak for another
  session. It is revoked when the session ends. The global token in `config.json` is never given
  to an agent.
- An inbox endpoint is only accepted from a hosted session's own token. Inbox tokens and session
  tokens are never written to disk, logged, or sent to the renderer.
- The renderer chooses a provider id and a folder. The folder must exist; model and resume ids are
  checked against a strict pattern; the permission mode is one of `default`, `acceptEdits`, `plan`.
- Agents run in a separate terminal host process. Stopping a session kills its whole process tree,
  and quitting the app (or the app dying) takes every hosted agent down with it.
- `CLAUDE*` and `AI_AGENT` environment variables are removed before launching, so a session never
  inherits the identity of a Claude Code terminal the app was started from.

`npx electron scripts/e2e-phase-a.cjs` (after `npx electron-vite build`) runs the whole flow against
the real CLI in a scratch folder: start, permission approved from the registry, an order over the
inbox socket, an interrupt, stop. It uses one short real session.

### Codex

Codex has no terminal UI to embed. The app hosts it through **`codex app-server`**, Codex's own
JSON-RPC interface over stdio, and shows the session in a chat view instead of a terminal
(`SessionInfo.surface` is `chat`). Protocol notes and measurements: `docs/spikes-phase-b.md`.

**How it runs.** One `codex app-server` process serves every Codex session of the app; each
session is one Codex thread on it. The process is started the first time Codex is needed (the
provider list, or a new session), by spawning the native `codex.exe` of the npm package directly:
no shell, no console window, `CLAUDE*`, `AI_AGENT` and `CODEX_*` variables removed (a `CODEX_HOME`
you set yourself is kept). It uses your normal Codex home, so it shares the login, the thread
history, and the plugins and MCP servers of the Codex desktop app. `~/.codex/config.toml` is never
written. Quitting the app closes the server and kills its process tree; if the app dies, the
server sees its input close and exits by itself. If the server crashes it is restarted with a
backoff (1 s, 2 s, 5 s, 15 s, 30 s): the session shows `needs-attention` with a notice, loses the
turn that was running, and reconnects to its thread when the server is back.

**Login.** The provider list shows whether Codex is logged in, the plan, and the usage of the
rate-limit window, and is updated when either changes. **Log in** starts Codex's own ChatGPT login:
the app-server returns a login address, the app opens it in your browser (only an `https` address
on `auth.openai.com` or `chatgpt.com` is ever opened), and the list updates when the login
completes. Starting a session while logged out is refused with "Not logged in to Codex — use Log
in". A login done in the Codex CLI or desktop app counts too: it is the same Codex home.

**Permission modes.** Codex has an approval policy and a sandbox instead of Claude's modes:

| Mode in the app | Approval policy | Sandbox | Effect |
|---|---|---|---|
| `default` | `untrusted` | `workspace-write` | every command and file change asks first |
| `acceptEdits` | `on-request` | `workspace-write` | work inside the folder runs unasked; Codex asks only to leave the sandbox |
| `plan` | `on-request` | `read-only` | nothing is written unless you approve leaving the sandbox |

Both are sent with every turn and again on resume, because a resumed thread forgets them. If the
server answers with another sandbox than requested (on Windows `workspace-write` silently becomes
read-only until the Windows sandbox is set up in Codex), the chat shows a warning.

**Approvals.** Codex asks on the same pipe (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval`, and yes/no questions of
plugins). Each becomes a card in the CEO inbox, like Claude's: "Command: node -e …" (the command
itself, not the PowerShell wrapper Codex runs it in) or "Create / Edit / Delete: path (+N more)"
with the diff, the path as seen from the session's folder.
Allow answers `accept`; deny answers `decline`, and the turn goes on with the model knowing it was
refused. Codex's answer has no field for a reason, so a deny message is sent into the running turn
right after the decision. A card disappears ("resolved elsewhere") when Codex withdraws the request
or the turn ends. There is no "always allow" from the app. Questions the inbox can't express (a
form, a link to open, a multiple-choice question from the model) are declined with a notice in the
chat.

**Chat and orders.** What you type in the chat box is a real user turn; while a turn is running it
is added to that turn (`turn/steer`) and the model reads it when its current tool call is done. It
is not gated by **Allow CEO orders**, like typing in a terminal. Orders from the order bar reach
Codex sessions the same way (target: the session, `provider:codex`, or everyone) and arrive as an
ordinary user message, without the `[CEO order via Agent Office]` line; the session's briefing
(sent as the thread's developer instructions, template in `electron/drivers/briefing.ts`) says so.
Delivery is confirmed by the server's answer, so there is no timeout. Interrupt ends the turn at
once; the command that was running is shown as interrupted. Codex does not always kill that
command: one that was only just being started (on Windows the sandbox takes a few seconds) can run
on to its end, and its card then shows the output and the real exit code. Whatever Codex still
reports about a turn that has ended never puts the session back to "working". Links in an answer
open in your system browser.

**Stop and resume.** Stopping a session unsubscribes from its thread; nothing is archived or
deleted, so the thread stays in your Codex history (`codex resume`, the desktop app). A session
started with a thread id to resume loads the thread's last turns into the chat. In the new-session
dialog, **Resume previous…** lists the conversations this app started in the chosen folder (the
exact folder; first prompt, model, how long ago), newest first; pick one and the session continues
it. Threads of the Codex CLI or the desktop app are not listed, and neither is one that a live
session already has open. The history Codex keeps differs a little from what was live: declined
commands and approval cards are not in it.

**What the world shows.** Commands are `exec` (or `read` when Codex recognises a read, listing or
search), file changes `write`, web searches `web`, plugin and MCP tools `exec` (`capture` for
screenshot tools), a pending approval `waiting`. Sub-agent threads become workers of the session;
that part is written from the protocol types and has not been seen running.

`npx electron scripts/e2e-phase-b.cjs` runs the flow against the real app-server on your account,
in a scratch folder, with four short turns: approval allowed, approval denied with a message, an
order in the middle of a turn, an interrupt, then a restart and resume. It also watches for console
windows while Codex and its commands run.

## Restoring sessions

Closing Agent Office stops the agents it hosts, but not your work with them: the next launch shows
the same sessions in the same places. This also holds when the app did not get to say goodbye (a
crash, a forced shutdown, a power cut), because the file is kept current while you work.

**What comes back.** Every session that was in the sidebar returns as a **sleeping** row: same
team, colour, title, folder, permission mode and model, but no process and no memory use. **Waking**
a row resumes the provider's own conversation (`claude --resume <id>`, Codex `thread/resume` with
the session's approval policy and sandbox sent again), so the agent has everything that was said
before. The session that was selected when the app closed is woken for you. A sleeping row takes no
orders ("asleep — wake it first"), is not on the office board and has no characters in the world
until it is woken.

If a session was working, waiting for your answer, or had subagents running when the app closed, it
carries a **"was interrupted" note** with the questions that were waiting, in plain words. The note
stays until you dismiss it or send that session its next prompt.

**Recent.** A session you stop (or that exits by itself) leaves the sidebar and goes to the Recent
list: the last 30, newest first. Reopening one resumes its conversation as a live session under its
old identity. Stopping a sleeping row does the same without starting anything. **Forget** removes a
sleeping row or a recent entry from Agent Office for good; the conversation itself stays in Claude
Code's or Codex's own history, which the app never deletes from.

**What to wake on launch** (`restore.mode` in `config.json`; the app offers the same choice):

| Mode | On launch |
| --- | --- |
| `last` (default) | wakes the session that was selected; the others sleep until you click them |
| `all` | wakes every session, one at a time (each one waits for the one before to be ready, at most 20 s), which costs the memory of all of them |
| `none` | everything sleeps |

**Limits.**
- A permission request **cannot** be restored as still waiting: it died with the process that
  asked. The note tells you what was asked; the resumed agent sees its last step as interrupted
  ("Interrupted · What should Claude do instead?") and you tell it whether to try again.
- **Subagents that were running are gone** and are not restarted. Ask the session to run them again.
- A command that was running is not continued either; only the conversation is.
- At most 8 sessions run at once, as before. Sleeping rows don't count towards that, but the sidebar
  holds 8 rows: when a ninth session is started, the sleeping row that was active longest ago moves
  to Recent (with its note).
- If the provider no longer has the conversation (you deleted it, or it was never written), the
  session ends with "The saved conversation no longer exists, so this session could not be resumed"
  and can't be woken again; forget it from Recent. A session that was closed before it ever reached
  a conversation is not remembered at all.
- After a hard kill, Claude Code may start its next session with the line "fullscreen renderer
  didn't finish starting last time … using the classic renderer". That is Claude Code's own
  recovery and goes away by itself.

**What is saved, and where.** `sessions.json` next to `config.json` (see [Config & security](#config--security)),
written atomically (temp file, then rename) about half a second after anything changes and once
more on quit. Per session: the app's id for it, provider, folder, title, permission mode, model, the
provider's conversation id, when it started and was last active, a one-line preview of your last
prompt (120 characters at most), whether it was interrupted, and the pending questions (10 at most:
the plain sentence, the tool name, the time). Plus which session was selected. The window's size,
position and maximised state are remembered in `config.json`, per display layout, and moved back
onto a screen that exists if the layout changed.

**What is never saved.** No tokens (the ingest token, session tokens, board tokens), no inbox socket
paths, no environment, no terminal contents, no chat transcript, no command output, no tool input
beyond the plain question. The preview and the questions are cut to one line and anything that
looks like a credential (API keys, bearer tokens, `password=…`, long random strings) is replaced
with `[hidden]` before it is written. A `sessions.json` that can't be read, or comes from another
version, is set aside as `sessions.json.bad` and the app starts with an empty list.

`npx electron scripts/e2e-restore.cjs [--codex]` checks all of this against the real agents in a
scratch folder: it starts a session, leaves a permission request pending, kills the whole process
tree, and has a new process bring the session back, wake it and ask it what it was doing (two short
Claude turns on Haiku; with `--codex` two short Codex turns as well).

## Office board

Teams that work in the same repository tell each other what they are doing, so no work is done
twice. The app keeps an **office board** in memory: for every hosted session (team) its status, the
files it changed in the last two hours, its claims ("I am doing X") and its notes. The board panel
in the window shows all of it, with author and age, and lets you delete any claim or note.

Sessions share a board only when they share a **project**: the git repository their folder belongs
to (`git rev-parse --git-common-dir`, so branches and worktrees of one repository count as one), or
the folder itself outside git. Teams in unrelated folders never see each other.

**How the board is fed.** By the app, not by what agents say: status from the session state; changed
files from Claude Code's `PostToolUse` of `Write` / `Edit` / `MultiEdit` / `NotebookEdit` and from
Codex's completed file changes. Files changed by a shell command are not seen. The user's prompt
never goes on the board: a team's task is whatever it claimed.

**How agents see it**, three ways:

| | Claude Code | Codex |
|---|---|---|
| A **digest** with each new prompt (at most 1,500 characters; only when something changed since the last one; only when another team shares the project, live or ended within the last 10 minutes) | the `UserPromptSubmit` hook's `additionalContext` (that hook gets a 2 s timeout) | a developer message added to the thread (`thread/inject_items`) before the turn starts; if that fails the turn starts without it |
| A **warning** before changing a file another team changed in the last 30 minutes | the edit is denied once with the warning as the reason; the retry goes through (main thread and subagents) | `default` mode: the change is declined once and the warning follows as a message; `acceptEdits`: no approval exists to decline, so the warning arrives right after the change started |
| **Tools** to read and write the board | MCP server `agent-office` (`--mcp-config`, added to your own servers), pre-allowed, so no permission prompt | MCP server `agent_office` in that thread's own config; no approval needed |

The tools: `board_read`, `board_claim {task, files?}`, `board_post {note}`, `board_release {task}`,
`board_handover {task, note, to?}`. A hand-over is passive: it releases the claim and leaves a note.
It never starts a turn in another session and never sends an order; the other team reads it with its
next prompt or `board_read`. The warning also shows on your approval card ("Backend changed this
file 3 min ago") when the agent tries again and the edit needs your approval.

**Limits.** A claim lasts 30 minutes after its holder was last active and is released when the
session ends. A note lasts an hour, a hand-over until another team claims the task (a day at most).
An ended session stays on the board for 10 minutes. Notes are one line of at most 400 characters,
tasks 120, 50 notes per project. Nothing is stored on disk: the board is empty after a restart.

**Settings** (the switches in the board panel, the tray's "Office board", or `board` in
config.json): `enabled` (default on) and `conflictMode`: `block-once` (default), `note` (never
block; the agent is told next to the result of its edit) or `off`. Switching the board off stops
digests and warnings for running sessions at once and their board tools answer "switched off";
sessions started while it is off get no board tools at all. The panel keeps showing who changed what.

**Safety.**
- Board text is information, never an instruction and never permission. The digest, `board_read` and
  every warning start with a fixed line written by the app, and each note is shown quoted with its
  author. Notes and tasks are reduced to one printable line (control characters, line breaks,
  zero-width and direction-override characters are removed) before they are stored.
- Warnings are built only from what the app observed (who changed which file when), never from
  what an agent wrote.
- The board's HTTP route (`POST /mcp` on the ingest server, same `Host` / `Origin` checks) can read
  the caller's own project's board and write the caller's own claims and notes. It cannot answer a
  permission request, send a prompt or an order, change settings, or remove anything but the
  caller's own claim: those stay on renderer IPC.
- Each session gets its own **board token**, a separate scope from its hook token: it only reaches
  `/mcp` (as `Authorization: Bearer`), the hook token and the global token do not. Tools take no
  identity argument, so an agent can only write as itself. The token lives in memory, is replaced
  on every start and resume and dies with the session. For Claude Code it is in the session's
  environment (`AO_BOARD_TOKEN`; the temp MCP config file names the variable only). For Codex it is
  part of the thread's config sent over the app-server's stdin; Codex does not write that config to
  its rollout file or databases (checked with `scripts/spikes/board/codex-persist-probe.cjs` and
  again after a real turn by `scripts/e2e-board.cjs`). The digest text itself is part of the
  thread's history, like any message.
- It is a coordination aid between your own agents, not a security boundary: an agent with a shell
  can read its own token and call the route directly, and then still only acts as itself.

`npx electron scripts/e2e-board.cjs` checks all of this against the real agents in a scratch git
repository: two Claude Code sessions on `haiku` (four short turns) and one Codex turn.

## Setup

Requires **Node 22.12+** (Electron 44).

```sh
npm install
npm run dev          # starts the app; first run creates the config + token
npm run simulate     # in another terminal: fake teams so you can watch without a real agent
npm test             # roster, world/pathfinding, corridors, movement rules, orders, session inbox, hosted sessions, office board
```

`npm run simulate -- --teams 3 --speed 2 --once` changes the number of teams, the speed, and whether it loops.

### Tray menu
Show/hide, always on top, overlay mode (transparent and click-through), theme, **Allow CEO orders**, **Office board**, copy/regenerate token, open config folder, quit.

**Ctrl+Shift+O** toggles overlay mode at any time.

### Config & security
Config file:
- Windows: `%APPDATA%\agent-office\config.json`
- macOS: `~/Library/Application Support/agent-office/config.json`
- Linux: `~/.config/agent-office/config.json`

It holds `{ token, port, theme, alwaysOnTop, overlay, allowOrders, officeWideMinutes, board, restore, window }` (`board`: see [Office board](#office-board); `restore` and `window`: see [Restoring sessions](#restoring-sessions)). The saved sessions are in `sessions.json` in the same folder.

For testing, `AGENT_OFFICE_USER_DATA=<dir>` runs a second, isolated instance with its own config, and
`AGENT_OFFICE_SHOW_INACTIVE=1` shows the window without taking focus. In dev builds,
`__agentOfficeDev.officeWide(true|false)` in devtools toggles office-wide mode. When the app is not
packaged, `AGENT_OFFICE_CODEX_SPAWN=<script.cjs>` runs that script with `node` in place of
`codex app-server` (`tests/fixtures/fake-codex-server.cjs` is one), to drive the real window
without a model or quota.

- The ingest server listens on **127.0.0.1 only** (default port 47821).
- Every request must carry a token in the **`X-Agent-Office-Token` header**: the global one from the config file, or a hosted session's own (which only reaches `/hooks/claude-code`, see [Hosted sessions](#hosted-sessions)). The one exception is `/mcp`, the [office board](#office-board)'s tools, which takes a session's board token as `Authorization: Bearer` and nothing else. A token is never accepted in the URL.
- Requests with a browser `Origin` header or an unexpected `Host` are rejected. This protects against malicious web pages and DNS rebinding.
- The token is 32 random bytes, generated on first run. Replace it any time from the tray (**Regenerate token**) or by editing the config file.

## Sending events (generic endpoint)

Every source is converted into one format:

```json
{ "agentId": "abc", "parentId": null, "provider": "my-tool", "displayName": "Builder",
  "activity": "read", "detail": "src/app.ts", "ts": 1759269000000 }
```

`activity` is one of `read | write | exec | web | capture | waiting | idle | done`.

**Lifecycle rules:**
- The first event for an `agentId` spawns its character.
- `parentId: null` makes the agent a manager (a new team). A `parentId` makes it a worker on that manager's team.
- `done` sends a worker back with its report, or ends a manager's session.
- `waiting` means the agent is blocked on you.

**HTTP**, with one event or an array:
```sh
curl -X POST http://127.0.0.1:47821/events \
  -H "Content-Type: application/json" \
  -H "X-Agent-Office-Token: <token>" \
  -d '{"agentId":"a1","parentId":null,"provider":"curl","displayName":"Me","activity":"web","detail":"example.com","ts":0}'
```

**WebSocket:** connect to `ws://127.0.0.1:47821/ws` with the same header and send one JSON event, or an array, per message.

## Writing an adapter

An adapter turns one source's native format into `AgentEvent`s. The scene never sees raw tool names.

- **External adapters** are scripts or tools that POST common-format events to `/events` or `/ws`. You can write them in any language, and the app needs no changes. This is the easiest route for new AI tools.
- **Built-in adapters** live in `electron/adapters/` and come in two kinds:
  - `HttpAdapter`: owns a route such as `/hooks/claude-code`, receives the tool's raw payload, and returns a JSON response. The response can be held open: that is how a hosted Claude Code session's permission request waits for your decision.
  - `BackgroundAdapter`: `start(sink)` / `stop()`, for things like tailing log files.

  Both call `sink.emit(event)`.

Mapping guidelines: file reads/searches → `read`; edits/writes → `write`; shell → `exec`; fetch/search → `web`; screenshots → `capture`; permission prompt → `waiting`; finished → `done`.

## Writing a theme

A theme is a folder in `themes/` (bundled) or `<config dir>/themes/` (yours). No code changes needed.

```
themes/my-theme/
  theme.json     roles, provider skins, activity -> location table, prop names
  hq.json        Tiled map: the boss's office + the memo inbox (one copy)
  branch.json    Tiled map: one team's branch (stamped out per active session)
  sprites/       optional sprite sheets
```

The scene lays out one **world**: the HQ plus one branch per active session on a grid of lots.
When a team appears, a 2-tile corridor is laid from an HQ `door` or an existing corridor (never from
another branch's door, so no branch becomes a thoroughfare) to the new lot, then the branch is built
(floor, walls, furniture, sign) and the team moves in.
Only buildings and built corridors are walkable. When a whole team has left, its branch is demolished
and corridors nobody else needs retract. Branches never move once placed. The camera fits everything
(zoom floor 0.3×; wheel to zoom, drag to pan, double-click to refit, click a team in the legend to jump to it).

Both maps are orthogonal [Tiled](https://www.mapeditor.org/) JSON (embedded tilesets), same tile size:
- **`locations`** object layer: point objects whose *class/type* is the location type.
  - `hq.json` needs `boss_seat`, `inbox` (memo slots) and `door` (on the map edge).
  - `branch.json` needs one `manager_seat`, `desk`s, `entrance` and `door`s. An optional
    `manager_inbox` point is where workers wait with memos (default: in front of the `manager_seat`).
  - Anything else (`printer`, `yard`, ...) is free-form and referenced from `theme.json`. Workers
    resolve stations only inside their own branch; managers fall back to the HQ. `inbox` is at the HQ
    and only managers go there (outside office-wide orders).
- **`walls`** object layer: rectangles nobody crosses. Characters use A* on a half-tile grid, so doors
  must be at least one tile wide. A room without a door is unreachable (the CEO office is sealed).
- **`furniture`** object layer (optional): rectangles drawn as placeholders when there is no tile art;
  properties `color`, `label`, `solid` (characters path around it). Keep location points out of solid rects.

**`theme.json`** (types in `shared/theme.ts`):
- `roles.boss|manager|worker`: a label plus a `placeholder` (procedural Prison-Architect-style
  character: accessory + accent colour) or a `sprite` sheet.
- `providers`: skin per provider (`claude-code`, `codex`, ...), usually a body `tint`. `default` is
  required; `human` is you. Body = provider colour; role = silhouette/accessory.
- `activities`: activity -> location type, or `home` (own desk/seat) / `manager` (manager's seat),
  with an optional animation and speech-bubble verb.
- `teams.colors` (optional): team colour palette (`#rrggbb`, 8–10 clearly distinct ones). Each
  team gets one, unique among live teams while the palette lasts. A built-in palette is used without it.
  Manager face variants apply to the procedural placeholder; sprite-sheet characters get a team pin.

See `themes/office/` (generated by `scripts/gen-office-map.cjs`) and `docs/art-direction.md`.

## Project layout

```
electron/   main process: window, tray, config, ingest server, adapters, theme protocol,
            hosted sessions (sessions.ts, drivers/, permissions.ts, ptyHost.ts = terminal host process),
            the office board (board.ts = model, boardMcp.ts = its MCP tools, boardProject.ts = which repository)
            session restore (sessionStore.ts = sessions.json, windowState.ts = the window position)
hook/       the SessionStart command hook injected into hosted Claude Code sessions
shared/     event format, theme format, IPC contract
src/        renderer: the React shell (src/ui: sessions, terminal, CEO inbox, order bar) and the
            Phaser world (scene, characters, roster)
themes/     bundled themes
scripts/    simulate.ts, map generator, e2e-phase-a.cjs (hosted-session check against the real CLI),
            e2e-board.cjs (office board check against real Claude Code and Codex sessions),
            e2e-restore.cjs (kill the app with a request pending, bring the session back)
docs/       research notes (hooks, art direction)
```

## Roadmap
1. ✅ Window, office placeholder scene, event format, generic endpoint, simulator
   ✅ Dynamic branches per session, A* pathfinding, sealed CEO office
   ✅ Corridor + construction animation when a team arrives, demolition when it leaves
   ✅ Team colours + distinct managers, branch-confined workers, memo relay via managers, CEO speech bar UI + gated `sendOrder` plumbing
2. ✅ Phase A: hosted Claude Code sessions in an embedded terminal, hook adapter, permission
   requests answered from the app, real order delivery, the app shell (sessions, terminal, CEO inbox, order bar). Next: Codex (B) and Antigravity (C) drivers, and an
   install snippet so sessions started in your own terminal report in too
3. Claude Code transcript watcher (zero setup), prison theme
4. Real pixel art
