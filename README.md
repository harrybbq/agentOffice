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
| Blocked on a permission request | They bring a memo to **your** inbox and wait there |

When a subagent starts, its manager hands over a folder at a free desk. When it finishes, it carries a report back to the manager.

The app is **read-only**: it watches agents and never controls them.

## Setup

Requires **Node 22.12+** (Electron 44).

```sh
npm install
npm run dev          # starts the app; first run creates the config + token
npm run simulate     # in another terminal: fake teams so you can watch without a real agent
```

`npm run simulate -- --teams 3 --speed 2 --once` changes the number of teams, the speed, and whether it loops.

### Tray menu
Show/hide, always on top, overlay mode (transparent and click-through), theme, copy/regenerate token, open config folder, quit.

**Ctrl+Shift+O** toggles overlay mode at any time.

### Config & security
Config file:
- Windows: `%APPDATA%\agent-office\config.json`
- macOS: `~/Library/Application Support/agent-office/config.json`
- Linux: `~/.config/agent-office/config.json`

It holds `{ token, port, theme, alwaysOnTop, overlay }`.

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

A theme is a folder in `themes/` (bundled) or in `<config dir>/themes/` (yours). Adding one needs no code changes.

```
themes/my-theme/
  theme.json     roles, provider skins, activity -> location table, prop names
  map.json       Tiled map (orthogonal JSON)
  sprites/       optional sprite sheets
```

**`map.json`** is made with [Tiled](https://www.mapeditor.org/) and saved as JSON with embedded tilesets.
- It needs an object layer named **`locations`**, containing point objects whose *class/type* is the location type.
- These types are required:
  - `boss_seat`
  - `manager_seat` (one per concurrent team)
  - `desk` (many)
  - `inbox` (memo slots)
  - `entrance`
- Any other type, such as `printer` or `yard`, is free-form and referenced from `theme.json`.
- An optional **`furniture`** object layer holds rectangles with `color`/`label` properties. They are drawn as placeholders when there is no tile art.

**`theme.json`** is described by the types in `shared/theme.ts`. The key parts:
- `roles.boss|manager|worker`: a label, plus either a `placeholder` (procedurally drawn character: accessory + accent colour) or a `sprite` sheet.
- `providers`: one skin per provider (`claude-code`, `codex`, ...), usually a body `tint`. `default` is required, and `human` is used for you. Characters follow the Prison Architect style: the body is drawn white and tinted with the provider colour, and the role is shown by silhouette/accessory.
- `activities`: maps each activity to a location type, or to `home` (own desk/seat) or `manager` (the manager's seat), with an optional animation and speech-bubble verb.

See `themes/office/` for a complete example and `docs/art-direction.md` for the art spec.

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
2. Claude Code hook adapter + install snippet
3. Claude Code transcript watcher (zero setup), prison theme
4. Real pixel art
5. (Later) approve/deny permission requests from your office
