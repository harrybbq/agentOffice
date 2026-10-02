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
  (type or paste a path, or **Browse…**), permission mode, optional title and model. Sessions that
  run outside the app are listed under **Observed**.
- **World (centre).** The office. Click a session to focus its branch; double-click the world or
  use the corner button to fit the whole office again.
- **Order bar (under the world).** Pick **Everyone**, a provider or one session, type, press
  **Enter** (**Shift+Enter** adds a line, Esc leaves the field). The CEO says it in a speech
  bubble and a sealed order envelope flies to the manager(s). For more than one session a PA
  banner also runs across the top. The result shows above the bar ("Delivered to 2", or who
  failed and why). Orders are **off by default**: turn on **Allow CEO orders** in the tray.
- **Panel (right, or under the world in a narrow window).** Two tabs. **Terminal** is the
  selected session's real terminal, with **Interrupt** and **Stop** (asks first). **Events** is
  the live event log, filterable by activity and by the selected session. Drag the splitter to
  resize, double-click it to reset; the dock button moves the panel between right and bottom.
- **CEO inbox.** Permission requests with **Allow** / **Deny** (Deny takes an optional reason
  that the agent sees). With the list focused: arrows move, **A** allows, **D** denies, **E**
  shows the full request, Enter opens that session's terminal. Requests that only a terminal can
  answer are listed below, with a link to it.
- **Status bar.** Connection, running sessions, pending requests, event count, light / dark
  interface, panel toggle.

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

The app can launch agents itself and be your main window onto them. Phase A hosts **Claude Code**;
Codex and Antigravity are listed as providers but have no driver yet.

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
it was started from Agent Office, it manages the team named after the session, its subagents show
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

## Setup

Requires **Node 22.12+** (Electron 44).

```sh
npm install
npm run dev          # starts the app; first run creates the config + token
npm run simulate     # in another terminal: fake teams so you can watch without a real agent
npm test             # roster, world/pathfinding, corridors, movement rules, orders, session inbox, hosted sessions
```

`npm run simulate -- --teams 3 --speed 2 --once` changes the number of teams, the speed, and whether it loops.

### Tray menu
Show/hide, always on top, overlay mode (transparent and click-through), theme, **Allow CEO orders**, copy/regenerate token, open config folder, quit.

**Ctrl+Shift+O** toggles overlay mode at any time.

### Config & security
Config file:
- Windows: `%APPDATA%\agent-office\config.json`
- macOS: `~/Library/Application Support/agent-office/config.json`
- Linux: `~/.config/agent-office/config.json`

It holds `{ token, port, theme, alwaysOnTop, overlay, allowOrders, officeWideMinutes }`.

For testing, `AGENT_OFFICE_USER_DATA=<dir>` runs a second, isolated instance with its own config, and
`AGENT_OFFICE_SHOW_INACTIVE=1` shows the window without taking focus. In dev builds,
`__agentOfficeDev.officeWide(true|false)` in devtools toggles office-wide mode.

- The ingest server listens on **127.0.0.1 only** (default port 47821).
- Every request must carry a token in the **`X-Agent-Office-Token` header**: the global one from the config file, or a hosted session's own (which only reaches `/hooks/claude-code`, see [Hosted sessions](#hosted-sessions)). A token is never accepted in the URL.
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
            hosted sessions (sessions.ts, drivers/, permissions.ts, ptyHost.ts = terminal host process)
hook/       the SessionStart command hook injected into hosted Claude Code sessions
shared/     event format, theme format, IPC contract
src/        renderer: the React shell (src/ui: sessions, terminal, CEO inbox, order bar) and the
            Phaser world (scene, characters, roster)
themes/     bundled themes
scripts/    simulate.ts, map generator, e2e-phase-a.cjs (hosted-session check against the real CLI)
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
