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
- **Each team has its own colour** (theme `teams.colors`): the branch sign, the HUD legend, the manager's
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
  branch. The "Waiting on you" panel still lists every waiting agent, grouped by team.
- **Office-wide orders** (see below) lift the branch rule: workers may use the nearest station
  anywhere, bring memos straight to the HQ inbox and use the corridors. The mode shows a green
  "Office-wide task in progress" pill. It ends when every team that received the order has gone `idle`/`done`,
  after a timeout (`officeWideMinutes`, default 10), or when you click the pill. Workers then walk home.

### CEO speech bar
At the bottom of the window: pick **Whole office** or one team, type, press **Enter** (Esc leaves
the field). The CEO says it in a speech bubble and a sealed order envelope flies to the manager(s).
For the whole office a PA banner also runs across the top. The result shows as a toast.

Orders are **off by default**: the app starts read-only. Turn on **Allow CEO orders** in the tray.
Orders go to a session's Claude Code inbox socket (named pipe / unix socket, see
`docs/claude-code-hooks-notes.md`). The socket path and token come from the hook adapter (milestone 2),
are kept in memory only and are never written to disk or logged. Until that adapter exists, sends fail
with "not connected (install the Claude Code hook — milestone 2)". The bar is hidden in overlay mode.

Apart from that opt-in, the app only watches agents and never controls them.

## Setup

Requires **Node 22.12+** (Electron 44).

```sh
npm install
npm run dev          # starts the app; first run creates the config + token
npm run simulate     # in another terminal: fake teams so you can watch without a real agent
npm test             # roster, world/pathfinding, corridors, movement rules, orders, session inbox
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
- Every request must carry the token in the **`X-Agent-Office-Token` header**. The token is never accepted in the URL.
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
  - `HttpAdapter`: owns a route such as `/hooks/claude-code`, receives the tool's raw payload, and returns a JSON response. That response is where approve/deny decisions will go in the future.
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
(zoom floor 0.5×; wheel to zoom, drag to pan, double-click to refit, click a team in the legend to jump to it).

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
electron/   main process: window, tray, config, ingest server, adapters, theme protocol
shared/     event format, theme format, IPC contract
src/        renderer: Phaser scene, characters, roster, HUD
themes/     bundled themes
scripts/    simulate.ts, map generator
docs/       research notes (hooks, art direction)
```

## Roadmap
1. ✅ Window, office placeholder scene, event format, generic endpoint, simulator
   ✅ Dynamic branches per session, A* pathfinding, sealed CEO office
   ✅ Corridor + construction animation when a team arrives, demolition when it leaves
   ✅ Team colours + distinct managers, branch-confined workers, memo relay via managers, CEO speech bar UI + gated `sendOrder` plumbing
2. Claude Code hook adapter + install snippet, real order delivery (fills the session inbox registry)
3. Claude Code transcript watcher (zero setup), prison theme
4. Real pixel art
5. (Later) approve/deny permission requests from your office
