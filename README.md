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
embedded terminal (described first), **Codex** in a chat view (see [Codex](#codex)) and Google's
**Antigravity** CLI in the same chat view (see [Antigravity](#antigravity)).

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

### Antigravity

Google's Antigravity CLI (`agy`) has no interface the app could embed either, so the app hosts it
headless and shows the session in the same chat view as Codex. Protocol notes, measurements and
what was verified with the real binary: `docs/spikes-phase-c.md`.

**How it runs.** One `agy` process per session: `agy --input-format stream-json --output-format
stream-json --add-dir <session folder> --disable-slash-commands --log-file <session folder>\agy.log
--model <model> [--conversation <id>] --dangerously-skip-permissions`, started in your project
folder without a shell and without a console window, with `CLAUDE*`, `AI_AGENT`, `CODEX_*`,
`ANTIGRAVITY_*`, `AGY_*`, `GEMINI_*` and `AO_*` variables removed and agy's self-updater switched
off. The process stays alive for the whole session and takes one prompt per turn on its input. It
uses your normal agy sign-in and keeps its conversations in your agy history (`~/.gemini`), which
the app never writes to. Each session uses about 130 MB idle and 190 MB while working (plus about
45 MB for the board bridge once the session has used the board), and counts towards the limit of
eight live sessions like any other.

**The session folder.** Everything the app adds lives in `<config dir>/agy-sessions/<session id>/`,
never in your project and never in `~/.gemini`: `.agents/hooks.json` (two hooks), a copy of
`hook/agy-hook.cjs` next to it, and with the office board `.agents/mcp_config.json` plus a copy of
`hook/agy-board-mcp.cjs`. agy loads them because the folder is passed with `--add-dir`. No file in
it holds a secret: the hook's token and the board's token are in the process environment only. The
folder is deleted when the session ends (leftovers of a crash at the next start). The hooks run
with `node`, which must be on your PATH (as for the Claude Code hook).

**Why `--dangerously-skip-permissions`, and what replaces agy's own checks.** In headless mode agy
cannot ask you anything: a command that needs approval is refused on the spot ("soft-deny") and the
turn ends. A hook that answers `allow` does not change that, and agy takes its permission rules
only from your own `settings.json`, which the app must not touch. The one way to let a hosted
session run a command at all is the flag that lifts agy's checks. With it, **the app is agy's
permission system**: agy asks the app's `PreToolUse` hook before every tool call, and that hook
is the only gate. It fails closed: `deny`, a crashed hook and an answer without a decision all
block the call (verified with the real binary). Four things keep it honest:

1. **No gate, no session.** Before agy is started with the flag, the app asks agy itself, without
   quota (`agy -p /hooks`), which hooks it would load for this session's folder. Unless the answer
   lists the app's `PreToolUse` hook, for every tool, from this session's own `hooks.json`, with
   exactly the app's command, the session is refused ("Antigravity did not load Agent Office's
   approval hook…") and the flagged process is never spawned. The same check runs before every
   wake, reopen and respawn.
2. **The hook says no when it cannot ask.** `hook/agy-hook.cjs` posts the tool call to the app on
   127.0.0.1 and prints the app's answer. If the app is not reachable, answers late, answers with
   anything but a well-formed `allow` or `deny`, or the script fails in any way, it prints `deny`.
   It passes nothing else through (no permission overrides, no rewritten arguments).
3. **The gate cannot be edited from inside.** The policy refuses every tool call that reads or
   changes the session folder or the app's data folder: by path argument (links resolved), and for
   commands by the path written anywhere in them, whatever the quoting (`"…"`, `^`, backticks,
   `%APPDATA%`, `$env:APPDATA`, `~`). A command that only smells of it gets a card marked "May
   touch Agent Office's own files". Before every turn and every tool call the app compares a hash
   of the hook files with what it wrote; a difference stops the session with a notice.
4. **The hook's token opens one door.** Each session gets its own token, valid on `/hooks/agy`
   only and only as that session; that route takes questions and never a decision. The global
   token, a Claude session's token and a board token are refused there. Tokens are never written
   to a file or logged. A question is only accepted for a tool call agy itself announced on its
   output, once per call, so a command that posts to the route with the session's token gets no
   card.

What this cannot do: a command you approve runs with your rights and can do anything, as with every
agent. A card is the place to stop it.

**Permission modes** are the app's own rules (`electron/drivers/agyPolicy.ts`); agy's `--mode` flag
is not used:

| Mode in the app | Reads in the folder | File edits in the folder | Commands | Web, browser, other MCP tools, unknown tools |
|---|---|---|---|---|
| `default` | allowed | ask | ask | ask |
| `acceptEdits` | allowed | allowed | ask | ask |
| `plan` | allowed | refused ("plan mode: read-only") | refused | ask |

Anything outside the session's folder asks, with the usual risk badge; so does a secrets file and
an agent's own settings (`.agents/`, `.gemini/`, …), also in `acceptEdits`. The office board's own
tools never ask. Sub-agents, workflows and scheduled tasks are refused in every mode: the app
could not check what they do. In `plan` the session is told so in its briefing.

**Approvals.** A call that has to ask becomes a card in the CEO inbox, like the other providers':
"Command: …", "Create / Write / Edit: path" with the content, "MCP: server · tool", a browser or
web card with a caution badge. The hook's answer is held open until you decide (the app sets the hook's
timeout to one hour and agy reports it as such; holds of up to 15 seconds were seen working,
longer ones were not tried). Allow runs the call; deny refuses it, and your
message is the reason the model reads. A card disappears ("resolved elsewhere") when the turn
ends, is interrupted, or the process dies. There is no "always allow".

**Chat, orders, interrupt.** What you type in the chat box is a real user turn; orders from the
order bar arrive the same way (target: the session, `provider:antigravity` = "All Antigravity", or
everyone). agy takes one prompt per turn, so a prompt sent while a turn runs is **queued**: the
chat says so, and it starts when the running turn ends. (Handing it into the running turn through
the hook before the model's next call worked in the one real turn that tried it;
`AGENT_OFFICE_AGY_STEER=inject` switches that on.) The chat is built from agy's event stream plus
the hook's payload, which carries what the stream leaves out: a file card shows the new content as
a diff. agy has no interrupt on its pipe: **Interrupt** kills the process tree (the running command
and its children with it), marks what was open as interrupted, and loads the same conversation
into a new process after the gate check; that takes about five seconds. Stop closes agy's input
and kills what is left.

**Resume.** The conversation id agy reports at start is saved with the session; waking or
reopening it starts agy with `--conversation <id>`. agy answers an unknown id with a warning and a
*new* conversation, so the app compares the ids and treats a mismatch as "the saved conversation
no longer exists". A resumed session's earlier messages are not shown in the chat (the agent has
them; the app does not read agy's files). There is no "Resume previous…" list for Antigravity.

**Signing in.** The app cannot start agy's sign-in (there is no login command and no address to
open). The provider row shows: *Open a terminal, run `agy`, choose the personal Google sign-in (not
the Google Cloud project option), then come back*, with **Check again**, which asks agy
(`agy models`, no quota) whether it is signed in now. agy does not report a plan name, so none is
shown.

**Quota.** The free plan is small: one turn with a few tool calls uses about 2 % of the **week**
(every model call sends about 13,000 tokens of fixed prompt, uncached). A session uses the
cheapest model (`gemini-3.8-flash-low`) unless you name one, and the provider row shows the weekly
meter (`agy -p /usage`, read after each turn, at most once a minute, at no cost).

**What the world shows.** Commands are `exec` (`read` for a plain look such as `git status`), file
tools `write` / `read`, web and browser tools `web` (`capture` for screenshots), a pending card
`waiting`, the end of a turn `idle`. The team is named after its model ("Gemini 3.8 Flash").

`npx electron scripts/e2e-phase-c.cjs` runs the flow against the real `agy` on your account, in a
scratch folder, with at most five short turns (`--free` sends none): a command and a file creation
allowed from the inbox, a command denied with a message, an interrupt with the respawn, a follow-up
turn, then a restart and resume. It also watches for console windows.
`AGENT_OFFICE_AGY_SPAWN=<script.cjs>` (unpackaged builds) runs that script with `node` in place of
`agy` (`tests/fixtures/fake-agy.cjs` is one), to drive the real window without a model or quota.

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

## Approvals: what you are asked about

Set in the CEO inbox ("Ask me about"), with the inbox's mute button, or in the tray. Rules: `shared/approvals.ts`.

| Level | What happens |
|---|---|
| **Only dangerous things** (default) | Every request is allowed for you and listed under "Handled for you". A dangerous request is **not done and does not block the team**: it is refused for now with a fixed "held for the user" message, saved under **Held for you**, and the team carries on with its other work. Approve it and the team is told and may do it (its retry is let through once, within 30 minutes); dismiss it and nothing happens. |
| Important things only | Routine work inside the project (reading and editing files, tests, builds, read-only and local git commands, web lookups, helper agents) is allowed for you. Everything else comes to you and the team waits. |
| Everything | Every request comes to you. |

Dangerous = deleting folders, force-pushing, discarding uncommitted work, running downloaded code, administrator
rights, secrets files, agent settings (the red badge; see `shared/permissionText.ts`). A dangerous request is never
allowed without you, in any level. The decision is made by fixed rules on the request as the card would show it,
never by a model. Held requests live in memory: they are gone when the app closes or the session ends.

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

## Inspector

Click a character (a manager or one of its workers) to see what it is doing. The inspector is
**read-only**: it shows, it never controls an agent, and it is not a way to approve anything.

What it shows (`shared/inspector.ts`, `AgentDetails`):

- **Task**: a manager's last prompt as a one-line preview (anything token-shaped is blanked out), or
  its newest office-board claim when that is newer. A worker's task is the description its manager
  gave it when it started it.
- **Status**: what it is doing right now (activity + detail), the session's state for a hosted
  manager, and, when it is blocked on you, the question it is waiting on and its risk.
- **Runtime**: when it started, when it was last active, and the time it spent working (everything
  except idle; waiting for your answer counts as working time).
- **Tokens**: input, output, cached, the total, and how full the context is. Where they come from:

  | Provider | Source | Notes |
  |---|---|---|
  | Claude Code | The session's transcript under `~/.claude/projects` (hooks carry no usage). Read after Stop / SubagentStop / PostToolUse, at most every 2 s, only the bytes that were appended | Workers have their own transcript (`<session>/subagents/agent-<id>.jsonl`). The context window size is not known, so there is no "context used" bar, only the number. A resumed conversation counts its earlier turns too |
  | Codex | `thread/tokenUsage/updated` (the thread's running total, the last request, the model's context window) | Cached input is shown apart from input; reasoning is part of output |
  | Antigravity | The `usage` of each `result` (a running total of the conversation) | The context size is the input of the last model call |

  The transcript format is Claude Code's own and may change: lines the app does not understand are
  skipped, and an agent whose transcript yields nothing simply shows no tokens. Only files inside
  `~/.claude/projects` are opened, only numbers and the model name are taken from them, and nothing
  is ever written there.
- **Tools used**: how many times each activity started (`read`, `write`, `exec`, `web`, …).
- **Files changed** by that agent, newest first, relative to the session's folder.
- **Activity log**: the last 30 things it did, newest first.
- **Workers** of a manager: the ones running and the ones that finished in the last 10 minutes.

It works for every character: hosted sessions and their workers have everything above; sessions the
app did not start (external Claude Code terminals, `/events`, the simulator) have fewer fields.
A finished agent can be inspected for 10 minutes. While the panel is open the main process pushes
updates for that one agent, at most once per second and only when something changed.

Some activities carry a stable detail text, so a theme can send a character to its own station
(`shared/details.ts`): `planning: …` (a plan or to-do list is being written), `secrets: …` (the file
looks like a secrets or agent-settings file), `question: …` (the agent asked you something and
waits), `checking the board`, `delegating`.

`npx electron scripts/e2e-inspector.cjs` checks it against a real Claude Code session on `haiku`
(one turn: one subagent, one new file), through the real IPC bridge.

## Progress bars

Every hosted session (a branch) has a progress bar, and so has every order that went to two or
more sessions at once (`shared/progress.ts`, `electron/progress.ts`).

**No invented percentages.** A bar is filled only when there is a real count behind it; its tooltip
says which:

| Bar | Count | From |
|---|---|---|
| Plan | steps completed / steps | the agent's own to-do list: Claude Code's task tools (`TaskCreate`, `TaskUpdate`, `TaskList`) and `TodoWrite`, Codex's `turn/plan/updated`. Only the manager's list counts, not a worker's |
| Helpers | helpers finished / helpers spawned | used when there is no plan but the manager started workers during this run |
| Working | none: moving stripes | the session is busy (or waits on a permission) and nothing can be counted. Antigravity has no plan tool, so this is its only bar |

A new prompt starts a new run. When a turn ends with every step done, the bar stays at 100 % for
8 s and then goes away. A turn that was interrupted or failed, or that ended with steps left, keeps
its bar where it was, greyed, until the next prompt. Nothing is saved: a session that is asleep has
no bar.

Where a branch's bar shows: under its sign in the world (also in overlay mode), under its row in
the sidebar (with "3/7"), in the terminal / chat header (with the step in progress), and in the
Inspect tab of its manager (the step list with check marks).

**An order** to everyone or to a provider gets one bar at the top of the world: the order's text,
"2 of 4 teams done", and an overall bar that is the average of the teams (a team with a count
contributes its fraction; a team without one counts 0 while it works and 1 when it is done; a team
that failed is left out). Expanded, it has one row per team with that team's own bar; a click
selects the team. A team is done when its manager goes idle after the order, and failed when the
order could not be delivered, the turn was cut short or the session ended. A finished order says so
for a moment and then fades (the main process keeps it 30 s, and at most 5 orders).

The payload shapes of Claude Code's task tools as they were seen, and the limits, are in
`docs/progress-notes.md`.
## Live preview

A pane to the left of the office shows the web app a session's team is building, updating as they
work. It is collapsed to a narrow rail until you open it, follows the selected session (the pin
keeps it on one), and is hidden in overlay mode. An empty pane offers what applies to the session:

- **Found localhost:5173 — Open**: an address a server printed in the session's terminal or command
  output. It is only offered while something answers there.
- **Serve this folder**: the folder has an `index.html` (also `public/`, `dist/`, `build/`, `docs/`,
  `www/`, `site/`). The app serves the session's folder itself and reloads the page whenever a file
  in it changes.
- **Run a script**: the `dev` / `start` / `serve` / `preview` / `storybook`… scripts of the folder's
  `package.json`. The app runs `npm run <name>` as its own background process, shows the address it
  prints, keeps its output under "Preview log", and kills it when the preview stops, the session
  ends or the app quits.
- **Or type an address.**

The toolbar has the address, Reload, the widths Fit / Desktop 1280 / Tablet 768 / Phone 390 (a width
wider than the pane is scaled down to fit), "Open in my browser" and Stop. The dot is amber while
starting, green when live (it pulses when the page changed), red when nothing answers.

What keeps this safe (`electron/preview/`, contract in `shared/preview.ts`):

- Only pages **on this computer** are ever shown: `http(s)://localhost | 127.0.0.1 | [::1]` with a
  port, no credentials, and never the app's own ports. The main process checks every address; the
  page's content security policy (`frame-src`) allows nothing else either.
- The page runs in a sandboxed frame of another origin: it cannot reach the app, its bridge or the
  clipboard, and gets no camera, notification or other permission. A link to a web site is stopped
  and opened in the system browser instead (one every few seconds at most); the frame goes back to
  its page.
- The app's own server binds 127.0.0.1 on a random port, answers GET/HEAD only, checks the `Host`
  header, serves no dotfiles (`.env`, `.git`), no folder listings and nothing outside the session's
  folder once links and junctions are resolved, and refuses requests other web pages make in the
  background.
- The renderer never supplies a command: `Run a script` passes a script **name**, which must be in
  that folder's `package.json` and consist of plain characters.

Not covered: a page that forbids framing (`X-Frame-Options`) or an `https://localhost` server with
a self-signed certificate cannot be shown in the pane ("Open in my browser" is offered); frames a
previewed page embeds from other sites stay empty; the app's own server has no range requests.

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
- Every request must carry a token in the **`X-Agent-Office-Token` header**: the global one from the config file, or a hosted session's own (which only reaches `/hooks/claude-code`, see [Hosted sessions](#hosted-sessions); a hosted Antigravity session's only reaches `/hooks/agy`, see [Antigravity](#antigravity)). The one exception is `/mcp`, the [office board](#office-board)'s tools, which takes a session's board token as `Authorization: Bearer` and nothing else. A token is never accepted in the URL.
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

**Stations** (all optional, all in `theme.json`; a theme without them behaves as before). A station is
just a location type on your map (plus whatever furniture or art stands there); these three tables say
what it is called, who goes there and when:

```jsonc
"stationLabels": {                       // the floating tag above every location of that type
  "vault":  { "title": "Vault", "subtitle": "Secure storage", "color": "#78909c" },
  "desk":   { "title": "Desks", "subtitle": "Editing", "once": true }
},
"stationRules": [                        // checked before "activities"; the first match wins
  { "detail": "^planning:\\s*", "location": "whiteboard", "verb": "Planning", "anim": "work" },
  { "activity": "read", "detail": "\\.env$", "location": "vault" }
],
"idle": { "location": "lounge", "afterMs": 45000 }
```

- `stationLabels`: location type → `{ title, subtitle?, color?, once? }`. The tag is pinned to the top
  edge of the furniture next to the location (or floats above the location when the map has none
  there). `color` is the tag's dot (`#rrggbb`; default: that furniture's colour). `once: true` shows
  one tag per building for the type instead of one per location: use it for `desk` and for the
  `inbox` slots. The key order is the priority when tags would overlap; zoomed out, only titles show,
  and further out nothing (the station under the pointer always shows in full, with who is there).
  The same titles name the stations in the agent inspector.
- `stationRules`: `{ activity?, detail, location, anim?, verb? }`. `detail` is a case-insensitive regular
  expression (at most 200 characters; an invalid one is skipped with a console warning) tested against
  the event's detail; `activity` limits the rule to one activity. The first matching rule wins, otherwise
  the `activities` table applies. `location` is a location type, `home` or `manager`, and the scope rules
  above still hold (a worker never leaves its branch for a rule). When the pattern matches at the start
  of the detail, the matched part is left out of the speech bubble because the rule's `verb` says it
  (`planning: the API` reads "Planning · the API"). A rule for `waiting` only changes the verb and
  animation: where a waiting character goes is fixed (manager's office, then the inbox).
  The adapters write these details (see `shared/details.ts`): `planning: …`, `secrets: …`,
  `checking the board`, `question: …` (a `waiting` event), `delegating`.
- `idle`: managers and workers with nothing to do for `afterMs` walk to the nearest location of that
  type inside their own branch and go back to work with their next activity.
- An optional `noticeboard` location in `hq.json` is where notes for the office board fly to.

See `themes/office/` (generated by `scripts/gen-office-map.cjs`) and `docs/art-direction.md`.

## Project layout

```
electron/   main process: window, tray, config, ingest server, adapters, theme protocol,
            hosted sessions (sessions.ts, drivers/, permissions.ts, ptyHost.ts = terminal host process),
            the office board (board.ts = model, boardMcp.ts = its MCP tools, boardProject.ts = which repository)
            session restore (sessionStore.ts = sessions.json, windowState.ts = the window position)
            the inspector (agentStats.ts = per-agent stats + the watch, transcriptUsage.ts = Claude token
            usage from transcripts, adapters/claudeInspect.ts = what the hooks say about workers and files)
            the progress bars (progress.ts = the tracker, adapters/claudePlan.ts = Claude's to-do list from its hooks)
            the live preview (preview/: manager.ts, staticServer.ts, detect.ts, runner.ts, guard.ts)
hook/       the SessionStart command hook injected into hosted Claude Code sessions; the approval
            hook and the board bridge copied into each hosted Antigravity session's folder
shared/     event format, theme format, IPC contract
src/        renderer: the React shell (src/ui: sessions, terminal, CEO inbox, order bar) and the
            Phaser world (scene, characters, roster)
themes/     bundled themes
scripts/    simulate.ts, map generator, e2e-phase-a.cjs (hosted-session check against the real CLI),
            e2e-phase-b.cjs / e2e-phase-c.cjs (the same for Codex and for Antigravity),
            e2e-board.cjs (office board check against real Claude Code and Codex sessions),
            e2e-restore.cjs (kill the app with a request pending, bring the session back),
            e2e-inspector.cjs (the inspector against a real Claude Code session, over the real IPC)
docs/       research notes (hooks, art direction)
```

## Roadmap
1. ✅ Window, office placeholder scene, event format, generic endpoint, simulator
   ✅ Dynamic branches per session, A* pathfinding, sealed CEO office
   ✅ Corridor + construction animation when a team arrives, demolition when it leaves
   ✅ Team colours + distinct managers, branch-confined workers, memo relay via managers, CEO speech bar UI + gated `sendOrder` plumbing
2. ✅ Phase A: hosted Claude Code sessions in an embedded terminal, hook adapter, permission
   requests answered from the app, real order delivery, the app shell (sessions, terminal, CEO inbox, order bar). ✅ Phase B: Codex in a chat view. ✅ Phase C: Antigravity (`agy`) in the chat view, with the app as its permission system. Next: an
   install snippet so sessions started in your own terminal report in too
3. Claude Code transcript watcher (zero setup), prison theme
4. Real pixel art
