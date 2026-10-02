# Phase B feasibility spikes: hosting Codex through `codex app-server` (2026-10-02)

Environment: Windows 11 Home 10.0.26200, Node 24, Codex CLI 0.160.0 (`@openai/codex` from npm, native `codex.exe`).
No model turn succeeded in these spikes: every turn that was started ran in a scratch `CODEX_HOME` with no login.

Scripts are in `scripts/spikes/codex/`:

| File | Purpose |
|---|---|
| `rpc.cjs` | Minimal JSON-RPC client for `codex app-server` over stdio: finds `codex.exe`, spawns it without a shell, logs every message both ways, answers server requests, kills its own process tree |
| `harness.cjs` | Logged-out scenarios: `probe`, `login`, `thread`, `sandbox` |
| `logged-in-check.cjs` | Everything that needs an account: approval, steer, interrupt, resume, optional subagent. **Not run** (see below) |
| `generated/` | `codex app-server generate-ts --out …` output: 96 top-level files (shared and legacy v1 types) and 639 in `v2/` |
| `logs/*.log` | One JSON line per message (`t` ms, `dir` `->` `<-` `!!` stderr `--` harness note). Git-ignored (`*.log`) |

Run: `node scripts/spikes/codex/harness.cjs <scenario> [--home default] [--root <scratch dir>]`. Without `--home default`
the harness sets `CODEX_HOME` to `<root>/codex-home`. Only `probe` and `sandbox` (read-only calls and ephemeral threads)
were run against the real `~/.codex`.

## Summary

| # | Spike | Result |
|---|---|---|
| 1 | Protocol surface from generated TS | PASS: every method the driver needs exists in the stable (non-experimental) surface |
| 2 | Handshake, account, models, login flow, logged-out errors | PASS |
| 3 | Spawning on Windows without a shell | PASS for a console parent. Console-window behaviour under Electron is UNTESTED |
| 4 | Sandbox and approval configuration on Windows | PARTIAL: values and defaults confirmed; `workspace-write` silently becomes read-only unless the Windows sandbox is configured; what a turn does under each policy is UNTESTED |
| 5 | Item to world-activity mapping | DESIGN (from types): `commandActions` separates read / list / search from generic exec |
| 6 | Rich chat feed | DESIGN (from types): `ChatItem` proposal below |
| 7 | Resume and persistence | PASS for a thread with one failed turn; with real history UNTESTED |
| 8 | `turn/steer`, `turn/interrupt` | UNTESTED with a live turn; request and error shapes confirmed |

## Changes to the plan

1. **The account state changed during the spikes.** At 13:37 `~/.codex` held only `tmp/`. At 13:40 the Codex desktop
   app (26.930.21537, under `%LOCALAPPDATA%\OpenAI\Codex`) populated it, including `auth.json`, and `account/read` on
   the default home now returns `{"type":"chatgpt","planType":"free"}`. The spikes did not log in; `auth.json` was not
   read. So `logged-in-check.cjs` can be run now. It was not run, because it spends the account's allowance and was
   specified as a step for after login.
2. **There is no TUI, so there is no terminal to embed.** `codex app-server` is JSON-RPC over stdio. `DriverContext.pty`
   is unused, and `SessionManager.attach()` has nothing to return. A Codex session needs the chat view (spike 6) in
   Phase B, not Phase E, or at least a plain event log pane. `SessionInfo` needs a field saying which surface a session
   has (`terminal` or `chat`).
3. **One app-server process can host every Codex session.** Threads are multiplexed by `threadId` on one connection
   (`thread/loaded/list` returned four loaded threads). An idle app-server with no thread loaded used 45 MB; the
   desktop app's three `codex.exe` processes were at 47 to 98 MB. With memory tight, use one shared process per
   app, with one `AgentDriver` per thread on top of it.
4. **`workspace-write` is not honoured on Windows unless the Windows sandbox is configured.** In a fresh home the
   server answered `sandbox: {"type":"readOnly"}` to a `workspace-write` request, with no error or warning. The driver
   must read the `sandbox` field of the `thread/start` response and call `windowsSandbox/readiness`.
5. **The default home carries the desktop app's configuration.** Every thread started there launches three MCP
   servers (`codex_apps`, `cua_repl`, `node_repl`), has computer-use and browser plugins enabled, and runs a `notify`
   program at the end of each turn. `--disable plugins --disable apps -c mcp_servers.node_repl.enabled=false` on the
   command line removed the MCP start-ups without touching `config.toml`.
6. **`PermissionMode` does not map one to one.** Codex has two axes, `approvalPolicy` and sandbox mode. See the table
   in the driver design.
7. **The app can run the login itself.** `account/login/start` returns an `authUrl`, and no browser window opened in the
   spike. The app opens it with `shell.openExternal` and waits for `account/login/completed`. No terminal is involved.
8. **Free plan: four models, one 30-day usage window.** `model/list` depends on the account; logged out it returns
   the full catalogue of eight.
9. **Orders are easier than with Claude.** `turn/start` and `turn/steer` both answer the request, so delivery is
   confirmed without a timeout, and approvals are answered on the same pipe. No HTTP route, hook, or socket is needed.

## Spike 1: protocol surface (PASS)

`codex app-server` options that matter: `--listen stdio://` (default; also `unix://`, `ws://IP:PORT`, `off`),
`-c key=value`, `--enable/--disable <feature>`. Subcommands: `daemon`, `proxy`, `generate-ts`, `generate-json-schema`.

Generated with `codex app-server generate-ts --out scripts/spikes/codex/generated`. The top-level files are shared
types plus the legacy v1 surface (`ExecCommandApprovalParams`, `ApplyPatchApprovalParams`, `GetAuthStatusParams`,
`getConversationSummary`, `gitDiffToRemote`). Implement against `v2/` only. Method names come from
`generated/ClientRequest.ts`, `ServerRequest.ts`, `ServerNotification.ts` and `ClientNotification.ts`.

`generate-ts --experimental` adds 63 client methods (`thread/queue/*`, `turn/settings/update`, `collaborationMode/list`,
`process/*`, `project/*`, `remoteControl/*`, …) and extra fields on `ThreadStartParams`, `TurnStartParams`,
`ThreadResumeParams` and `CommandExecutionRequestApprovalParams` (`availableDecisions`, `additionalPermissions`).
They need `capabilities.experimentalApi: true`; without it the server answers
`{"error":{"code":-32600,"message":"collaborationMode/list requires experimentalApi capability"}}`. Nothing in this
document needs them, except plan mode (see the permission table).

### Client requests

| Method | Params (`generated/v2/`) | Result |
|---|---|---|
| `initialize` | `InitializeParams` (top level): `{clientInfo:{name,title,version}, capabilities}`. `title` and `capabilities` are `T \| null`, not optional | `InitializeResponse`: `{userAgent, codexHome, platformFamily, platformOs}` |
| `thread/start` | `ThreadStartParams`: `model?, cwd?, approvalPolicy?, approvalsReviewer?, sandbox?: SandboxMode, config?, baseInstructions?, developerInstructions?, ephemeral?` | `ThreadStartResponse`: `{thread, model, modelProvider, cwd, approvalPolicy, approvalsReviewer, sandbox: SandboxPolicy, reasoningEffort, …}` |
| `thread/resume` | `ThreadResumeParams`: `threadId` plus the same overrides, `excludeTurns?` | `ThreadResumeResponse`: as start, plus `turnsBackwardsCursor`, `itemsBackwardsCursor`, `collaborationMode` |
| `thread/list` | `ThreadListParams`: `cursor?, limit?, sortKey?, sortDirection?, sourceKinds?, archived?, cwd?: string \| string[], searchTerm?` | `ThreadListResponse`: `{data: Thread[], nextCursor, backwardsCursor}` |
| `thread/read` | `ThreadReadParams`: `{threadId, includeTurns?}` | `{thread}` |
| `thread/turns/list`, `thread/items/list` | `ThreadTurnsListParams`: `{threadId, cursor?, limit?, sortDirection?, itemsView?}` | pages of `Turn` / `ThreadItem` |
| `thread/unsubscribe` | `{threadId}` | `{status: "unsubscribed" \| "notSubscribed" \| "notLoaded"}` |
| `thread/loaded/list` | `{}` | `{data: string[]}` |
| `turn/start` | `TurnStartParams`: `{threadId, input: UserInput[], cwd?, approvalPolicy?, sandboxPolicy?: SandboxPolicy, model?, effort?, summary?, outputSchema?, clientUserMessageId?}`. Overrides apply to "this turn and subsequent turns" | `TurnStartResponse`: `{turn: Turn}` |
| `turn/steer` | `TurnSteerParams`: `{threadId, input: UserInput[], expectedTurnId, clientUserMessageId?}` | `TurnSteerResponse`: `{turnId}` |
| `turn/interrupt` | `TurnInterruptParams`: `{threadId, turnId}` | `{}` |
| `account/read` | `GetAccountParams`: `{refreshToken?}` | `GetAccountResponse`: `{account: Account \| null, requiresOpenaiAuth}` |
| `account/login/start` | `LoginAccountParams`: `{type:"chatgpt"}`, `{type:"chatgptDeviceCode"}`, `{type:"apiKey",apiKey}`, … | `LoginAccountResponse`: `{type:"chatgpt",loginId,authUrl}` or `{type:"chatgptDeviceCode",loginId,verificationUrl,userCode}` |
| `account/login/cancel` | `{loginId}` | `{status: "canceled" \| "notFound"}` |
| `account/logout` | none | `{}` |
| `account/rateLimits/read` | none | `GetAccountRateLimitsResponse` |
| `model/list` | `ModelListParams`: `{cursor?, limit?, includeHidden?}` | `ModelListResponse`: `{data: Model[], nextCursor}` |
| `windowsSandbox/readiness` | none | `{status: "ready" \| "notConfigured" \| "updateRequired"}` |
| `windowsSandbox/setupStart` | `{mode: "elevated" \| "unelevated", cwd?}` | `{started}`, then notification `windowsSandbox/setupCompleted {mode, success, error}` |
| `config/read` | `{includeLayers?, cwd?}` | `{config}` (effective config, snake_case keys) |

`UserInput` (`v2/UserInput.ts`): `{type:"text", text, text_elements: []}` (`text_elements` is required), `image`,
`localImage`, `skill`, `mention`.

### Server requests (the client must answer; `generated/ServerRequest.ts`)

| Method | Params | Response |
|---|---|---|
| `item/commandExecution/requestApproval` | `CommandExecutionRequestApprovalParams`: `{kind: "command" \| "writeStdin", threadId, turnId, itemId, startedAtMs, approvalId?, reason?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, networkApprovalContext?}` | `{decision}` with `CommandExecutionApprovalDecision`: `"accept" \| "acceptForSession" \| "decline" \| "cancel" \| {acceptWithExecpolicyAmendment} \| {applyNetworkPolicyAmendment}` |
| `item/fileChange/requestApproval` | `FileChangeRequestApprovalParams`: `{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}`. The diff is on the `fileChange` item with the same `itemId` | `{decision}`: `"accept" \| "acceptForSession" \| "decline" \| "cancel"` |
| `item/permissions/requestApproval` | `PermissionsRequestApprovalParams`: `{threadId, turnId, itemId, cwd, reason, permissions}` | `{permissions: GrantedPermissionProfile, scope: "turn" \| "session"}` |
| `item/tool/requestUserInput` | `ToolRequestUserInputParams`: `{threadId, turnId, itemId, questions[], isBlocking}` (marked EXPERIMENTAL) | `{answers: {[questionId]: {answers: string[]}}}` |
| `mcpServer/elicitation/request` | `McpServerElicitationRequestParams` | `{action: "accept" \| "decline" \| "cancel", content, _meta}` |
| `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate` | only with dynamic tools, external auth, or `requestAttestation: true` | not needed |
| `applyPatchApproval`, `execCommandApproval` | legacy v1 | not used with v2 threads |

### Notifications (`generated/ServerNotification.ts`)

- Thread: `thread/started {thread}`, `thread/status/changed {threadId, status}`, `thread/closed {threadId}`,
  `thread/name/updated`, `thread/tokenUsage/updated {threadId, turnId, tokenUsage}`, `thread/compacted`.
  `ThreadStatus` is `{type:"notLoaded"} | {type:"idle"} | {type:"systemError"} | {type:"active", activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[]}`.
- Turn: `turn/started {threadId, turn}`, `turn/completed {threadId, turn}` with `Turn.status`
  `"completed" | "interrupted" | "failed" | "inProgress"` and `Turn.error: TurnError | null`,
  `turn/plan/updated {threadId, turnId, explanation, plan: {step, status: "pending"|"inProgress"|"completed"}[]}`,
  `turn/diff/updated {threadId, turnId, diff}`, `error {error: TurnError, willRetry, threadId, turnId}`.
- Items: `item/started {item, threadId, turnId, startedAtMs}`, `item/completed {item, threadId, turnId, completedAtMs}`.
- Deltas: `item/agentMessage/delta`, `item/reasoning/summaryTextDelta` (`summaryIndex`), `item/reasoning/summaryPartAdded`,
  `item/reasoning/textDelta` (`contentIndex`), `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`,
  `item/fileChange/patchUpdated {changes}`, `item/plan/delta` (EXPERIMENTAL), `item/mcpToolCall/progress {message}`.
  All carry `{threadId, turnId, itemId}`. `item/fileChange/outputDelta` is documented as no longer emitted.
- Requests: `serverRequest/resolved {threadId, requestId}`.
- Account: `account/login/completed {loginId, success, error}`, `account/updated {authMode, planType}`,
  `account/rateLimits/updated`.
- Other: `warning {threadId, message}`, `configWarning`, `deprecationNotice`, `mcpServer/startupStatus/updated`,
  `windows/worldWritableWarning`, `windowsSandbox/setupCompleted`, `model/rerouted`.

`ThreadItem` (`v2/ThreadItem.ts`) variants: `userMessage`, `hookPrompt`, `agentMessage` (`text`, `phase: "commentary" | "final_answer" | null`),
`functionCallOutput`, `plan`, `reasoning` (`summary[]`, `content[]`), `commandExecution`, `fileChange`, `mcpToolCall`,
`dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`, `webSearch`, `imageView`, `sleep`, `imageGeneration`,
`enteredReviewMode`, `exitedReviewMode`, `contextCompaction`.

## Spike 2: handshake, account, login, logged-out errors (PASS)

### Wire format

One JSON object per line. There is no `"jsonrpc":"2.0"` member in either direction. Notifications carry an extra
top-level `emittedAtMs`. Application errors used code `-32600`, and one invalid parameter `-32602`. Responses contain fields that the stable
generated types do not list (`workspaceRouting`, `environments`, `activePermissionProfile`, `multiAgentMode`,
`runtimeWorkspaceRoots`, `canAcceptDirectInput`), so parse leniently.

```
-> {"method":"initialize","id":1,"params":{"clientInfo":{"name":"agent_office_spike","title":"Agent Office (spike)","version":"0.0.0"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}
<- {"id":1,"result":{"userAgent":"agent_office_spike/0.160.0 (Windows 10.0.26200; x86_64) WindowsTerminal (agent_office_spike; 0.0.0)","codexHome":"C:\\Users\\Harry\\.codex","platformFamily":"windows","platformOs":"windows"}}
-> {"method":"initialized"}
<- {"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"DESKTOP-P3PUI07","installationId":"…","environmentId":null},"emittedAtMs":1790944960149}
```

The `initialize` response took 0.1 to 0.2 s (1.9 s the first time a new home was used). `clientInfo.name` becomes the
thread's `originator` and the `originator` query parameter of the login URL. Closing stdin makes the server exit with
code 0 (23 ms later in one measurement).

### Logged out (scratch home)

```
-> {"method":"account/read","id":2,"params":{"refreshToken":false}}
<- {"id":2,"result":{"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}}
-> {"method":"account/rateLimits/read","id":3}
<- {"error":{"code":-32600,"message":"codex account authentication required to read rate limits"},"id":3}
```

`model/list` works logged out and returns the whole catalogue: `gpt-6.1-sol` (default), `gpt-6-astra`, `gpt-6-sol`,
`gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`. One entry, shortened:

```json
{"id":"gpt-6-luna","model":"gpt-6-luna","upgrade":null,"upgradeInfo":null,"availabilityNux":null,"displayName":"GPT-6-Luna","description":"Fast and affordable model for easier tasks.","modelSpecialty":null,"hidden":false,
 "supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast responses with lighter reasoning"},{"reasoningEffort":"medium",…},{"reasoningEffort":"high",…},{"reasoningEffort":"xhigh",…},{"reasoningEffort":"max",…}],
 "defaultReasoningEffort":"medium","inputModalities":["text","image"],"supportsPersonality":false,"multiAgentVersion":"v2","additionalSpeedTiers":[],"serviceTiers":[],"defaultServiceTier":null,"availableAccessPrograms":{"cyber":["standard"]},"isDefault":true}
```

(`isDefault` is from the logged-in list; logged out, `gpt-6.1-sol` is the default.)

### Logged in (default home, read-only calls)

```
<- {"method":"account/updated","params":{"authMode":"chatgpt","planType":"free"},"emittedAtMs":1790944960690}
<- {"id":2,"result":{"account":{"type":"chatgpt","email":"<redacted>","planType":"free"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"…","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"NO_CONSTRAINT"}}}
<- {"id":3,"result":{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","limitName":null,"normalModelSlug":null,"primary":{"usedPercent":0,"windowDurationMins":43200,"resetsAt":1793536961},"secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":null},"individualLimit":null,"spendControlReached":false,"planType":"free","rateLimitReachedType":null},"rateLimitsByLimitId":{"codex":{…}},"rateLimitResetCredits":{"availableCount":0,"credits":[]},"accountId":"…","rateLimitUpsell":null}}
```

- `PlanType` (`generated/PlanType.ts`) includes `"free"`, and the backend reports `ordinaryUsageAllowed: true`, 0 % used,
  one window of 43,200 minutes (30 days). Whether a turn is accepted on the free plan is the first thing to verify.
- `model/list` logged in returns four models: `gpt-6-luna` (default), `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`.
- `account/read` took 0.5 s (it refreshed the account and emitted `account/updated` first).

### Login flow (scratch home; nobody logged in)

```
-> {"method":"account/login/start","id":3,"params":{"type":"chatgpt"}}
<- {"id":3,"result":{"type":"chatgpt","loginId":"545f859d-1234-4cd4-ae4d-7038db293ca5","authUrl":"https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=…&code_challenge_method=S256&state=…&scope=openid+profile+email+offline_access+api.connectors.read+api.connectors.invoke&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=agent_office_spike"}}
   (4 s later: no new top-level window; netstat shows 127.0.0.1:1455 LISTENING)
-> {"method":"account/login/cancel","id":5,"params":{"loginId":"545f859d-…"}}
<- {"id":5,"result":{"status":"canceled"}}
<- {"method":"account/login/completed","params":{"loginId":"545f859d-…","success":false,"error":"Login server error: Login was not completed","onboardingEntrypoint":null}}
   (port 1455 no longer listening; a second cancel returns {"status":"notFound"})
```

- The response is immediate (2 ms). The server starts a local callback server on **fixed port 1455** and does not open
  a browser: no window appeared, judged by comparing top-level window titles before and 4 s after. That check would
  miss a tab opened in a background browser window, so treat "does not open a browser" as likely, not proven.
- Completion is signalled by `account/login/completed {loginId, success, error}`. On logout the server sent
  `account/updated {"authMode":null,"planType":null}`, and on the logged-in home `account/updated` arrived with
  `authMode:"chatgpt"`, so a successful login should produce both. The success path was not exercised.
- Cancel works and frees the port.
- Device code flow, which needs no local port:

```
-> {"method":"account/login/start","id":7,"params":{"type":"chatgptDeviceCode"}}
<- {"id":7,"result":{"type":"chatgptDeviceCode","loginId":"7ab47199-…","verificationUrl":"https://auth.openai.com/codex/device","userCode":"A5ZY-R3EK3"}}
-> {"method":"account/login/cancel","id":8,"params":{"loginId":"7ab47199-…"}}
<- {"id":8,"result":{"status":"canceled"}}
<- {"method":"account/login/completed","params":{"loginId":"7ab47199-…","success":false,"error":"Login was not completed","onboardingEntrypoint":null}}
```

  This one took 0.7 s (a request to OpenAI).

### `thread/start` and a turn while logged out

`thread/start` succeeds without a login. It also opens a model connection in the background straight away (stderr:
`failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses`).

`turn/start` is accepted too, and the failure arrives 15.6 s later, after ten retries:

```
-> {"method":"turn/start","id":13,"params":{"threadId":"01a0fca4-011e-…","input":[{"type":"text","text":"Reply with the single word: ok","text_elements":[]}]}}
<- {"id":13,"result":{"turn":{"id":"01a0fca4-0146-…","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
<- {"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"active","activeFlags":[]}}}
<- {"method":"turn/started","params":{"threadId":"…","turn":{"id":"01a0fca4-0146-…","status":"inProgress",…,"startedAt":1790945001}}}
<- {"method":"item/started","params":{"item":{"type":"userMessage","id":"01a0fca4-020f-…","clientId":null,"content":[{"type":"text","text":"Reply with the single word: ok","text_elements":[]}]},"threadId":"…","turnId":"…","startedAtMs":1790945002013}}
<- {"method":"item/completed","params":{"item":{"type":"userMessage",…},"threadId":"…","turnId":"…","completedAtMs":1790945002014}}
<- {"method":"error","params":{"error":{"message":"Reconnecting... 2/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}},"additionalDetails":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, …","misalignment":null},"willRetry":true,"threadId":"…","turnId":"…"}}
   … 3/5, 4/5, 5/5 …
<- {"method":"warning","params":{"threadId":"…","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: …"}}
   … "Reconnecting... 1/5" to "5/5" over https …
<- {"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"systemError"}}}
<- {"method":"error","params":{"error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, …","codexErrorInfo":{"httpConnectionFailed":{"httpStatusCode":401}},"additionalDetails":null,"misalignment":null},"willRetry":false,"threadId":"…","turnId":"…"}}
<- {"method":"turn/completed","params":{"threadId":"…","turn":{"id":"01a0fca4-0146-…","items":[],"itemsView":"notLoaded","status":"failed","error":{"message":"unexpected status 401 Unauthorized: …","codexErrorInfo":{"httpConnectionFailed":{"httpStatusCode":401}},"additionalDetails":null,"misalignment":null},"startedAt":1790945001,"completedAt":1790945017,"durationMs":15613}}}
```

Consequences:

- Check `account/read` before starting a session and refuse with "not signed in to Codex" rather than letting a turn
  fail after 15 s.
- `error` notifications with `willRetry: true` are progress, not failure. Only `turn/completed` ends a turn.
- After a failed turn the thread status is `systemError`, not `idle`. Resuming the thread in a new process reported
  `idle`. Whether a new `turn/start` is accepted in `systemError` was not tried.
- The user's own message is echoed as a `userMessage` item, so the chat view can wait for the echo instead of adding
  the message optimistically.

## Spike 3: spawning on Windows (PASS from a console parent)

Resolution chain of the npm install:

```
%APPDATA%\npm\codex.cmd
  -> node %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js
    -> %APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe
```

- `codex.js` only picks the platform package (`@openai/codex-win32-x64`, an optional dependency), sets
  `CODEX_MANAGED_BY_NPM=1` and `CODEX_MANAGED_PACKAGE_ROOT=<…\@openai\codex>`, and spawns `codex.exe` with inherited stdio.
- Spawn `codex.exe` directly: `spawn(exe, ['app-server'], {stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: false})`.
  `findCodexExecutable()` in `rpc.cjs` does the lookup the same way `findClaudeExecutable()` does. The server behaved
  the same with and without the two env vars; set them anyway, since they tell Codex how it was installed.
- Do not copy the exe. Its siblings are used at run time: `bin\codex-code-mode-host.exe`, `codex-path\rg.exe`,
  `codex-resources\codex-command-runner.exe`, `codex-resources\codex-windows-sandbox-setup.exe`.
- `codex.exe` is a console-subsystem binary (PE subsystem 3), 327 MB. A GUI parent that spawns it without
  `windowsHide: true` gets a console window, so the flag is required. **UNTESTED**: the harness ran from a terminal,
  so nothing here shows whether a window flashes under Electron, or whether the shell commands Codex runs
  (PowerShell children of a windowless parent) open windows of their own. Check both from the app.
- Either Electron main or a `utilityProcess` can own the child; only `child_process` is needed, no native module.
- stderr carries human-readable log lines with ANSI colour codes. Keep it for diagnostics and never parse it.
- A second copy exists when the desktop app is installed: `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`
  (from `CODEX_CLI_PATH` in the user's config). Its version may differ from the npm one. Not tried.
- A `CODEX_HOME` under `%TEMP%` prints `WARNING: proceeding, even though we could not create PATH aliases: Refusing to
  create helper binaries under temporary dir`. Harmless for the spikes; it does not happen with the default home.
- The harness strips `CLAUDE*`, `AI_AGENT` and `CODEX_*` from the environment before spawning. Not stripping them was
  not tested.

## Spike 4: sandbox and approvals on Windows (PARTIAL)

Values (`v2/AskForApproval.ts`, `v2/SandboxMode.ts`, `v2/SandboxPolicy.ts`, `v2/ApprovalsReviewer.ts`):

- `approvalPolicy`: `"untrusted" | "on-request" | "never" | {granular: {sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations}}`.
- `sandbox` on `thread/start` and `thread/resume` (`SandboxMode`): `"read-only" | "workspace-write" | "danger-full-access"`.
- `sandboxPolicy` on `turn/start` (`SandboxPolicy`): `{type:"readOnly", networkAccess}`,
  `{type:"workspaceWrite", writableRoots, networkAccess, excludeTmpdirEnvVar, excludeSlashTmp}`,
  `{type:"dangerFullAccess"}`, `{type:"externalSandbox", networkAccess: "restricted" | "enabled"}`.
- `approvalsReviewer`: `"user"` (default) `| "auto_review" | "guardian_subagent"`. Keep `"user"`, or approvals never
  reach the app.
- `permissionProfile/list` returned `:read-only`, `:workspace`, `:danger-full-access` (the newer profile mechanism;
  selecting one by id is an experimental field).

What the server applied to `thread/start {cwd, ephemeral: true, …}` (`harness.cjs sandbox`):

| Asked | Scratch home, `windowsSandbox/readiness` = `notConfigured` | Scratch home with `-c windows.sandbox="unelevated"`, readiness = `ready` | Default home, readiness = `ready` (`[windows] sandbox = "elevated"`) |
|---|---|---|---|
| nothing | `on-request`, `readOnly`, profile `:read-only` | same | same |
| `read-only` + `on-request` | `readOnly`, `networkAccess:false` | same | same |
| `workspace-write` + `on-request` | **`readOnly`** | `workspaceWrite`, `writableRoots:[]`, `networkAccess:false` | `workspaceWrite`, same |
| `workspace-write` + `untrusted` / `never` | **`readOnly`**, policy as asked | `workspaceWrite` | `workspaceWrite` |
| `danger-full-access` + `on-request` | `dangerFullAccess` | `dangerFullAccess` | `dangerFullAccess` |

- Defaults with no overrides, in a directory Codex has not been told to trust: `approvalPolicy: "on-request"`,
  `approvalsReviewer: "user"`, `sandbox: readOnly`, no network. `config/read` shows `approval_policy` and
  `sandbox_mode` as `null` in both homes, so these are built-in defaults, not configuration.
- **Native Windows is supported; WSL is not needed.** The sandbox has two modes, set by `windows.sandbox` in
  `config.toml` or by `windowsSandbox/setupStart`:
  - `elevated`: a one-time setup that needs administrator rights. On this machine the desktop app ran it at 13:40;
    `~/.codex/.sandbox/setup_marker.json` names two local accounts (`CodexSandboxOffline`, `CodexSandboxOnline`), and
    the setup log shows read ACLs being granted to them across the user profile. A service
    (`codex-windows-sandbox-ser…`) is running.
  - `unelevated`: with only the config override and no setup step, readiness reported `ready` and `workspace-write`
    was honoured (third column). What it restricts was not examined.
- The old feature flags `experimental_windows_sandbox` and `elevated_windows_sandbox` are listed as `removed` by
  `experimentalFeature/list`; the `windows.sandbox` config key replaced them.
- Without a configured Windows sandbox, `workspace-write` degrades to read-only **silently**: same response shape, no
  `warning`, no `configWarning`.
- `approvalPolicy: "on-request"` is accepted natively with every sandbox mode. **UNTESTED**: what a turn does. From
  the type and field comments: with `on-request` the model runs commands inside the sandbox without asking and
  requests approval to go beyond it (`reason` on the request, for example network access); `untrusted` asks for
  anything not known to be safe; `never` does not ask. So under `on-request` a harmless command may raise no approval
  at all, which is why `logged-in-check.cjs` repeats the command with `untrusted` if `on-request` did not ask.
- `thread/shellCommand` "runs unsandboxed with full access" by its own doc comment. Never expose it.

## Spike 5: items to world activities (DESIGN, from types)

`commandExecution.commandActions` (`v2/CommandAction.ts`) is a best-effort parse of the shell command, one entry per
piped command: `{type:"read", command, name, path}`, `{type:"listFiles", command, path}`,
`{type:"search", command, query, path}`, `{type:"unknown", command}`. The approval request carries the same list.
So reads and searches done through the shell can be told apart from generic execution.

| Codex event | Activity | Detail |
|---|---|---|
| `item/started` `commandExecution`, every action is `read`, `listFiles` or `search` | `read` | `path`, or `query` for a search |
| `item/started` `commandExecution`, any action `unknown`, or no actions | `exec` | `command` |
| `item/started` `fileChange` | `write` | first `changes[].path`, plus "+n" for more |
| `item/started` `webSearch` | `web` | `action.url`, else `query` |
| `item/started` `mcpToolCall` with `readOnlyHint: true` | `read` | `server.tool` |
| `item/started` `mcpToolCall` otherwise, `dynamicToolCall` | `exec` (or `capture` when the tool name matches `CAPTURE_TOOL_PATTERN`) | `server.tool` |
| `item/started` `imageView` | `read` | `path` |
| `item/started` `imageGeneration` | `write` | |
| `agentMessage`, `reasoning`, `plan`, `userMessage`, `contextCompaction`, `sleep`, review-mode items | none | |
| any `…/requestApproval`, `item/tool/requestUserInput`, or `thread/status/changed` with `waitingOnApproval` / `waitingOnUserInput` | `waiting` | summary of the request |
| request answered, or `serverRequest/resolved` | back to the activity of the item it belongs to | |
| `turn/completed` on the session's own thread (any status) | `idle` | |
| `turn/started` | none (the mapper's "thinking" state, as for a Claude prompt) | |
| `collabAgentToolCall` with `tool: "spawnAgent"` | first event for each `receiverThreadIds[]` entry, `parentId` = the sender's agent | `prompt` |
| `subAgentActivity` `kind: "completed"`, `agentsStates[id].status` in `completed` / `shutdown` / `errored`, or `thread/closed` for a child thread | `done` on the child | |
| `thread/closed` for the session's thread, process exit, `stop()` | `done` | |

Subagents (all from types; **UNTESTED**):

- `collabAgentToolCall` has `senderThreadId`, `receiverThreadIds` (for `spawnAgent`, the new agent's thread id),
  `prompt`, `model`, and `agentsStates: {[threadId]: {status: "pendingInit"|"running"|"interrupted"|"completed"|"errored"|"shutdown"|"notFound", message}}`.
  Tools: `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, `sendMessage`, `followupTask`, `interruptAgent`, `listAgents`.
- Subagents are real threads: `Thread.parentThreadId`, `Thread.agentNickname`, `Thread.agentRole`, and
  `Thread.source = {subagent: {thread_spawn: {parent_thread_id, depth, agent_path, agent_nickname, agent_role}}}`.
  `subAgentActivity` items carry `{kind: "started"|"interacted"|"interrupted"|"completed", agentThreadId, agentPath}`.
- World id: `subagentId(sessionId, childThreadId)`, display name `agentNickname`.
- Unknown: whether a child thread's `item/*` notifications arrive on the parent's connection with the child's
  `threadId` (which would give workers their own read / write / exec activity), or only the parent's
  `collabAgentToolCall` and `subAgentActivity` items do. `logged-in-check.cjs --subagent` records this.
- `thread/start` reported `multiAgentMode: "explicitRequestOnly"`, and the session preamble in the rollout says "Do
  not spawn sub-agents unless the user … explicitly" asks. Expect workers only when an order asks for them.

## Spike 6: feeding a rich chat view (DESIGN, from types)

| Chat element | Start / end | Streaming |
|---|---|---|
| User message | `item/started` + `item/completed` `userMessage` (echo of `turn/start` / `turn/steer` input; `clientId` returns `clientUserMessageId`) | none |
| Assistant text | `item/started` `agentMessage` (empty text), `item/completed` with the full `text` and `phase` | `item/agentMessage/delta {itemId, delta}` |
| Reasoning | `item/started` / `item/completed` `reasoning` (`summary[]`, `content[]`) | `item/reasoning/summaryPartAdded {summaryIndex}`, `item/reasoning/summaryTextDelta {summaryIndex, delta}`, `item/reasoning/textDelta {contentIndex, delta}` (raw reasoning, only if the model exposes it) |
| Command card | `item/started` `commandExecution` (`command`, `cwd`, `commandActions`, `status:"inProgress"`), `item/completed` with `aggregatedOutput`, `exitCode`, `durationMs`, `status` | `item/commandExecution/outputDelta {itemId, delta}` (stdout and stderr merged), `item/commandExecution/terminalInteraction {stdin}` |
| File change card | `item/started` / `item/completed` `fileChange` (`changes: {path, kind: add|delete|update(move_path), diff}[]`, `status`) | `item/fileChange/patchUpdated {itemId, changes}` replaces the change list; `turn/diff/updated {diff}` is the whole turn's unified diff |
| Web search card | `item/started` / `item/completed` `webSearch` (`query`, `action: search|openPage|findInPage`, `results`) | none |
| MCP / tool card | `mcpToolCall` (`server`, `tool`, `arguments`, `result`, `error`, `durationMs`) | `item/mcpToolCall/progress {message}` |
| Plan / todo list | `turn/plan/updated {explanation, plan: {step, status}[]}` (whole list each time). A `plan` item with free text also exists | `item/plan/delta` (experimental; its doc says deltas may not add up to the final text) |
| Approval card | server request `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`, keyed to the card by `itemId`; closed by the app's answer or `serverRequest/resolved` | none |
| Notices | `error` (`willRetry`), `warning`, `thread/compacted`, `turn/completed` with `status: "failed" | "interrupted"`, `model/rerouted` | none |
| Usage | `thread/tokenUsage/updated {tokenUsage: {total, last, modelContextWindow}}`, `account/rateLimits/updated` | none |

Whether reasoning summaries stream on the free plan's models, and the delta granularity, are to be verified with a
real turn. `TurnStartParams.summary` (`"auto" | "concise" | "detailed" | "none"`) selects the summary style.

### Proposed provider-agnostic chat model

Main process keeps a bounded list of `ChatItem` per session and sends `ChatEvent`s to the renderer. A renderer that
attaches late gets a `reset` with the current list, like `TerminalSnapshot` for terminals. Nothing in the type names a
provider's tool or method.

```ts
// Proposal only. Would live in shared/chat.ts.

export type ChatItemStatus = 'running' | 'done' | 'failed' | 'declined' | 'interrupted'

interface ChatItemBase {
  /** Unique within the session and stable across updates: the provider's item id where it has one
   *  (Codex ThreadItem.id, Claude tool_use_id / transcript uuid), otherwise app-generated. */
  id: string
  sessionId: string
  /** World agent that produced it: the session itself or one of its subagents (shared/sessions.ts subagentId). */
  agentId: string
  /** Provider turn id, when the provider has turns. Groups items and lets a turn be marked failed/interrupted. */
  turnId?: string
  /** Unix ms of the first event for this item. Items are ordered by arrival, not by ts. */
  ts: number
}

export type ChatItem = ChatItemBase &
  (
    | {
        kind: 'user'
        text: string
        /** typed in the app's chat box | CEO speech bar | sent while a turn was running | hand-backs, task notifications */
        origin: 'human' | 'order' | 'steer' | 'system'
      }
    | {
        kind: 'assistant'
        text: string
        /** True while deltas are still arriving. Providers that do not stream deliver one finished item. */
        streaming: boolean
        phase?: 'commentary' | 'final'
      }
    | {
        kind: 'reasoning'
        /** Summary parts (rendered collapsed). */
        summary: string[]
        /** Raw reasoning text, when the provider exposes it. */
        text?: string
        streaming: boolean
      }
    | {
        kind: 'command'
        command: string
        cwd?: string
        /** What the command is for, when the provider can tell. Drives the icon and the world activity. */
        intent: 'read' | 'search' | 'list' | 'exec'
        /** stdout + stderr, capped by the main process (keep the tail). */
        output: string
        outputTruncated: boolean
        exitCode: number | null
        durationMs?: number
        status: ChatItemStatus
      }
    | {
        kind: 'file-change'
        changes: Array<{
          path: string
          change: 'add' | 'delete' | 'update'
          movedTo?: string
          /** Unified diff, capped. Empty when the provider gives none. */
          diff: string
        }>
        status: ChatItemStatus
      }
    | {
        kind: 'web'
        action: 'search' | 'open' | 'find'
        query?: string
        url?: string
        status: ChatItemStatus
      }
    | {
        kind: 'tool'
        /** MCP server or tool namespace, if any. */
        server?: string
        tool: string
        /** Pretty-printed input, truncated (permissions.ts describeToolInput). */
        input: string
        result?: string
        error?: string
        progress?: string
        status: ChatItemStatus
      }
    | {
        kind: 'plan'
        explanation?: string
        steps: Array<{ text: string; status: 'pending' | 'in-progress' | 'completed' }>
      }
    | {
        kind: 'subagent'
        /** World id of the worker. */
        childAgentId: string
        action: 'spawn' | 'message' | 'wait' | 'close'
        name?: string
        prompt?: string
        status: ChatItemStatus
      }
    | {
        kind: 'approval'
        /** PermissionRequestInfo.id: the card is the same request the CEO office inbox shows. */
        requestId: string
        /** The command / file-change item this approval is about, if it is in the list. */
        subjectId?: string
        summary: string
        detail: string
        outcome: 'pending' | 'allowed' | 'denied' | 'resolved-elsewhere'
      }
    | {
        kind: 'notice'
        level: 'info' | 'warning' | 'error'
        /** "Reconnecting 2/5", "context compacted", "turn interrupted", "usage limit reached" */
        text: string
      }
  )

export type ChatStreamField = 'text' | 'summary' | 'output'

export type ChatEvent =
  /** Insert or replace by id (item started, item finished, plan replaced, approval outcome changed). */
  | { type: 'item'; item: ChatItem }
  /** Append to a string field of an existing item. `index` selects the summary part. */
  | { type: 'delta'; sessionId: string; itemId: string; field: ChatStreamField; index?: number; delta: string }
  | {
      type: 'turn'
      sessionId: string
      turnId: string
      status: 'started' | 'completed' | 'interrupted' | 'failed'
      error?: string
    }
  /** Full list: sent on attach, and after a resume rebuilt the history. */
  | { type: 'reset'; sessionId: string; items: ChatItem[] }
```

How each provider would fill it:

| `ChatItem` | Codex app-server | Claude Code (hooks, transcript) | Antigravity stream-json |
|---|---|---|---|
| `user` | `userMessage` item | `UserPromptSubmit.prompt`; `origin` from the prefix rules of Phase A spike 2 | the prompt the app sent |
| `assistant` | `agentMessage` + deltas | `Stop.last_assistant_message` (one finished item), or text blocks tailed from the transcript | assistant message events |
| `reasoning` | `reasoning` + summary deltas | thinking blocks from the transcript, if shown at all | thinking events, if emitted |
| `command` | `commandExecution`; `intent` from `commandActions` | `PreToolUse` / `PostToolUse` for Bash and PowerShell (`tool_response`, no live output); `intent: 'exec'` | shell tool call + result |
| `file-change` | `fileChange` (`diff` supplied) | Edit / Write / NotebookEdit; diff built from `tool_input` old and new strings | edit tool call |
| `web` | `webSearch` | WebSearch / WebFetch | web tool call |
| `tool` | `mcpToolCall`, `dynamicToolCall` | every other tool (Read, Grep, Glob map to `command`-less `tool`, or to `command` with `intent: 'read' | 'search'`) | other tool calls |
| `plan` | `turn/plan/updated` | TodoWrite / task tools input | none known |
| `subagent` | `collabAgentToolCall`, `subAgentActivity` | `SubagentStart` / `SubagentStop`, `Agent` tool call | none known |
| `approval` | `…/requestApproval` server requests | `PermissionRequest` hook | PreToolUse hook |
| `notice` | `error`, `warning`, `thread/compacted`, failed / interrupted turn | `Notification`, interrupt, `SessionEnd` | error events |

The Claude column is a mapping on paper; for Claude the terminal stays the primary surface, and the chat list would be
a secondary log without streaming text.

## Spike 7: resume and persistence (PASS for an empty thread)

- Thread ids are UUIDv7 (`01a0fca4-011e-74c3-996a-dd3ded22601e`). `Thread.sessionId` equals the id for a root thread.
  The id fits the session manager's `resume` pattern (`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`).
- Storage, under `CODEX_HOME` (default `~/.codex`):
  - `sessions/YYYY/MM/DD/rollout-<local time>-<threadId>.jsonl` (also returned as `Thread.path`, marked UNSTABLE).
    Lines are `{timestamp, ordinal, type, payload}` with types `session_meta`, `event_msg`, `response_item`,
    `turn_context`, `world_state`.
  - SQLite: `state_5.sqlite` and `thread_history_1.sqlite` (the thread reported `historyMode: "paginated"`), plus
    `goals_1`, `memories_1`, `queue_1`, `logs_2`.
- A thread was not listed until after its first turn: `thread/list` 3 ms after `thread/start` returned `data: []`,
  and the same call after the turn returned the thread. That fits lazy persistence, but indexing lag was not ruled out. `ephemeral: true` threads are never written.
- `thread/list` output (one entry, paths shortened to `<S>`):

```json
{"id":14,"result":{"data":[{"id":"01a0fca4-011e-74c3-996a-dd3ded22601e","environments":[{"environmentId":"local","cwd":"<S>\\ws","runtimeWorkspaceRoots":["<S>\\ws"]}],"extra":null,
"sessionId":"01a0fca4-011e-74c3-996a-dd3ded22601e","forkedFromId":null,"parentThreadId":null,"preview":"Reply with the single word: ok","ephemeral":false,"section":null,"sectionEnteredAt":null,"projectId":null,
"historyMode":"paginated","modelProvider":"openai","model":"gpt-6.1-sol","reasoningEffort":null,"createdAt":1790945001,"updatedAt":1790945001,"recencyAt":1790945001,"status":{"type":"systemError"},
"path":"<S>\\codex-home\\sessions\\2026\\10\\02\\rollout-2026-10-02T13-43-21-01a0fca4-011e-74c3-996a-dd3ded22601e.jsonl","cwd":"<S>\\ws","cliVersion":"0.160.0","originator":"agent_office_spike","source":"vscode",
"canAcceptDirectInput":null,"threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"daybreakEnabled":null,"turns":[]}],
"nextCursor":null,"backwardsCursor":"2026-10-02T12:43:21.762Z"}}
```

  - Timestamps are Unix **seconds**. `turns` is always empty in a list. In a new process the same entry has
    `status: {"type":"notLoaded"}` and `environments: null`.
  - **Threads started through the app-server are recorded with `source: "vscode"`**, and `thread/list {}` with no
    filter returns them, so on the default home the list also holds the user's own CLI and desktop-app threads. To
    list only the app's threads, filter on `originator` (the `clientInfo.name`) on the client side. The server-side
    filter is refused: `{"error":{"code":-32602,"message":"originator filtering is not supported by the local app-server"}}`.
    `cwd` matches the exact folder only (the parent folder returned nothing).
  - `thread/turns/list {threadId, limit, sortDirection: "asc", itemsView: "full"}` returned the turn with its items,
    status and error, without resuming the thread.
- Resume after a restart, in a new `codex app-server` process:

```
-> {"method":"thread/resume","id":3,"params":{"threadId":"01a0fca4-011e-74c3-996a-dd3ded22601e","cwd":"<S>\\ws"}}
<- {"method":"deprecationNotice","params":{"summary":"Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.","details":null}}
<- {"method":"thread/status/changed","params":{"threadId":"01a0fca4-011e-…","status":{"type":"idle"}}}
<- {"id":3,"result":{"thread":{…,"status":{"type":"idle"},"turns":[{"id":"01a0fca4-0146-…","items":[{"type":"userMessage",…}],"itemsView":"full","status":"failed","error":{…},"startedAt":1790945001,"completedAt":1790945017,"durationMs":15613}]},
   "model":"gpt-6.1-sol","modelProvider":"openai","cwd":"<S>\\ws","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"readOnly","networkAccess":false},"activePermissionProfile":{"id":":read-only","extends":null},
   "collaborationMode":{"mode":"default","settings":{"model":"gpt-6.1-sol","reasoning_effort":null,"developer_instructions":null}},
   "turnsBackwardsCursor":"{\"requestedThreadId\":\"01a0fca4-011e-…\",\"rolloutOrdinal\":1,\"includeAnchor\":true,\"scope\":{\"kind\":\"turns\"}}","itemsBackwardsCursor":"{…}"}}
-> {"method":"thread/resume","id":4,"params":{"threadId":"00000000-0000-7000-8000-000000000000"}}
<- {"error":{"code":-32600,"message":"no rollout found for thread id 00000000-0000-7000-8000-000000000000"},"id":4}
```

  - Resume with `{threadId, excludeTurns: true}` and page history with `thread/turns/list` (`itemsView: "full"`) to
    rebuild the chat list. Resume returns the thread's saved approval policy and sandbox, and accepts overrides.
  - `thread/read {threadId, includeTurns: true}` returns the same turns without loading the thread, with the same
    deprecation notice.
- UNTESTED: resuming a thread that has real assistant and tool items, resuming while the desktop app has the same
  thread open, and `thread/fork`.

## Spike 8: `turn/steer` and `turn/interrupt` (UNTESTED with a live turn)

From `v2/TurnSteerParams.ts`, `v2/TurnInterruptParams.ts`, `v2/CodexErrorInfo.ts` and the error shapes observed.

- `turn/steer {threadId, input: UserInput[], expectedTurnId}` adds user input to the turn that is running.
  `expectedTurnId` is required: "The request fails when it does not match the currently active turn." The result is
  `{turnId}`. The `turnTrigger` comment on `TurnStartParams` ("Ignored when this request steers an already-active
  turn") suggests that `turn/start` during an active turn may itself act as a steer. Do not rely on that; send
  `turn/steer` when the driver knows a turn is active and fall back to `turn/start` on the "no active turn" error.
- Steering is refused for review and compaction turns: `codexErrorInfo: {activeTurnNotSteerable: {turnKind: "review" | "compact"}}`.
- With no active turn (observed):

```
-> {"method":"turn/steer","id":11,"params":{"threadId":"01a0fca4-011e-…","expectedTurnId":"no-such-turn","input":[{"type":"text","text":"steer with no turn","text_elements":[]}]}}
<- {"error":{"code":-32600,"message":"no active turn to steer"},"id":11}
-> {"method":"turn/interrupt","id":12,"params":{"threadId":"01a0fca4-011e-…","turnId":"no-such-turn"}}
<- {"error":{"code":-32600,"message":"no active turn to interrupt"},"id":12}
```

- `turn/interrupt {threadId, turnId}` returns `{}`. Expected, not observed: the turn ends with `turn/completed` and
  `turn.status: "interrupted"`, running command items end with a non-`completed` status, and pending approval
  requests are closed with `serverRequest/resolved`. If that holds, Codex has none of Claude's "no Stop after an
  interrupt" problem.
- Unknown: whether a steer is delivered while the turn is blocked on an approval; when the model sees a steer
  (between tool calls, as with Claude's inbox, or sooner); whether a steered message appears as a `userMessage` item
  in the same turn.
- The user's config has `[desktop] followUpQueueMode = "steer"`, and the experimental surface has `thread/queue/*`
  for queued follow-ups: the desktop app offers both "steer now" and "queue for after this turn".

## To verify after the user logs in

The user is logged in now (free plan), so this is one command:

```
node scripts/spikes/codex/logged-in-check.cjs
node scripts/spikes/codex/logged-in-check.cjs --only account          # no model use at all
node scripts/spikes/codex/logged-in-check.cjs --subagent              # adds one turn that asks for a sub-agent
```

It uses the default home, a scratch working directory, five short turns, and harmless commands
(`node -e "console.log('ao-codex')"` and a 25 s `node -e` timer). It answers every approval with `accept`. Output goes
to `scripts/spikes/codex/logs/logged-in*.log` and a summary is printed at the end. It starts the desktop app's three
MCP servers for its one thread (see change 5).

1. **Does the free plan run a turn at all**, and with which default model (`gpt-6-luna` expected)?
2. `on-request` on native Windows with `workspace-write`: does `node -e …` raise
   `item/commandExecution/requestApproval`, or run in the sandbox without asking? If it does not ask, the script
   repeats with `untrusted`.
3. The approval request as sent (fields present, `commandActions`, `proposedExecpolicyAmendment`), the effect of
   `accept`, and whether `serverRequest/resolved` and `thread/status/changed … waitingOnApproval` are emitted.
4. Item and delta sequence of a normal turn: `agentMessage` deltas, reasoning summary deltas, command output deltas,
   exit code.
5. `turn/steer` mid-command: the response, whether the turn id stays the same, whether a `userMessage` item appears,
   whether the final answer reflects the steer; the error for a wrong `expectedTurnId`.
6. `turn/interrupt` mid-command: final `turn.status`, how long it takes, state of the command item, and whether the
   thread takes another turn afterwards.
7. Resume in a second process with real history: `thread/turns/list` item types.
8. With `--subagent`: whether child threads' notifications arrive on the same connection.

Not covered by the script, to check when the driver exists: `decline` and `cancel` decisions, `acceptForSession`,
file-change approvals, a turn after `systemError`, steer during a pending approval, console windows under Electron,
and running next to the desktop app on the same thread store.

## Proposed driver design

**Process layout**

- `CodexServer` (one per app, started on the first Codex session, stopped after the last): owns the `codex.exe
  app-server` child, the line reader, request ids, and the `initialize` / `initialized` handshake with
  `clientInfo.name = "agent_office"`. It routes notifications and server requests to drivers by `params.threadId`.
  It can live in the main process; a `utilityProcess` is only worth it if JSON parsing of output deltas shows up in
  profiles.
- `CodexDriver implements AgentDriver` (one per session): one thread on the shared server. It ignores `ctx.pty`.
- Spawn: `findCodexExecutable()` as in `rpc.cjs`, `windowsHide: true`, no shell, env scrubbed, the shim's two env
  vars set. Arguments: `app-server`, plus overrides that keep the desktop app's tools out of hosted sessions
  (`--disable plugins --disable apps -c mcp_servers.<name>.enabled=false`), if the user wants hosted sessions bare.
- Stop: `thread/unsubscribe` per session; when no session is left, close stdin (the server exits with code 0), then
  `taskkill /T /F` on our own pid as the fallback.
- Server exit: every Codex session goes to `exited`; pending approvals are cleared as `resolved-elsewhere`.

**Probe**

- `available` when the exe is found and `codex.exe --version` runs.
- Not signed in is a second condition: `account/read` returning `account: null`. Report it as a reason
  ("not signed in"), and offer sign-in from the app through `account/login/start` + `shell.openExternal(authUrl)` +
  `account/login/completed`, with `account/login/cancel` behind a Cancel button. Device code is the fallback if port
  1455 is taken.

**`AgentDriver` mapping**

| Interface | Codex |
|---|---|
| `start()` | `account/read` (refuse if logged out), then `thread/start {cwd, model?, approvalPolicy, sandbox, developerInstructions: briefing}` or `thread/resume {threadId: start.resume, excludeTurns: true, …}`. Compare the returned `sandbox` with what was asked |
| `providerSessionId` | `thread.id` |
| `state` | `starting` until the thread response; `idle` on `thread/status/changed idle` and `turn/completed`; `busy` on `turn/started` or `active` with no flags; `waiting-permission` while a server request is pending or `activeFlags` is non-empty; `needs-attention` on `systemError` or a logged-out account; `exited` on server exit or stop |
| `canReceiveOrders` | `idle` (`turn/start`) and `busy` (`turn/steer`). `waiting-permission`: unknown until verified |
| `sendPrompt(text)` | no active turn: `turn/start {threadId, input:[{type:"text", text: taggedOrder(text), text_elements: []}]}` gives `{ok: true, queued: false}` on the response. Active turn: `turn/steer {threadId, expectedTurnId, input}` gives `{ok: true, queued: true}`. On "no active turn to steer", retry as `turn/start`. A JSON-RPC error becomes `{ok: false, reason: error.message}` |
| `answerPermission(id, decision)` | The registry entry holds the JSON-RPC request id. Allow: `{decision: "accept"}`. Deny: `{decision: "decline"}`. Codex's decision has no message field, so a deny message would have to follow as a steer |
| `interrupt()` | `turn/interrupt {threadId, turnId}` with the id from `turn/started` |
| `stop()` | interrupt if busy, `thread/unsubscribe`, then `onExit(0)` |

**Permissions**

- A server request stays open until answered; there is no timeout field in the protocol. Add the card to
  `PermissionRegistry` with `toolName` `"Command"` or `"File change"`, `summary` from `command` or the item's paths,
  `detail` from the command, cwd, `reason`, and the item's diffs.
- `serverRequest/resolved` for a request the app has not answered, `turn/completed`, and server exit all resolve the
  card as `resolved-elsewhere`.
- `acceptForSession` gives an "allow for this session" button later. `proposedExecpolicyAmendment` would give
  "always allow commands like this"; leave it out at first.
- `item/tool/requestUserInput` (the model asks the user a question) is a second kind of blocking request that
  `PermissionRequestInfo` does not model. Until it does, answer with empty `answers` and show a notice.
- Approvals and orders stay on renderer IPC and the app-server pipe. There is no HTTP involvement at all.

**`PermissionMode` to Codex**

| `PermissionMode` | `approvalPolicy` | `sandbox` | Notes |
|---|---|---|---|
| `default` | `on-request` | `read-only` | Codex's own default. Reading runs free; writing or network needs an approval |
| `acceptEdits` | `on-request` | `workspace-write` | Edits and commands inside the folder run without asking, which is wider than Claude's `acceptEdits` (commands still ask there). Needs the Windows sandbox; if the response says `readOnly`, tell the user and offer `windowsSandbox/setupStart` |
| `plan` | `on-request` | `read-only` | Plus the `plan` collaboration mode, which is on the experimental surface (`collaborationMode/list`, `ModeKind = "plan" | "default"`). Without it, a developer instruction is the only way to ask for a plan |

`never` and `danger-full-access` are not offered. `untrusted` (ask for nearly everything) could back a stricter mode.

**World events**

- The table in spike 5, in a `CodexItemMapper` with the same shape as `ClaudeHookMapper`: `spawn`, item start / end,
  `waiting` / resume, `end`.
- Root agent id = app session id; subagents = `subagentId(sessionId, childThreadId)`.

**Chat**

- The driver turns notifications into `ChatEvent`s (spike 6) and the session manager fans them out to an attached
  renderer, as it does for terminal data. On resume, rebuild from `thread/turns/list`.

## Open questions

1. Should hosted Codex sessions share `~/.codex` with the desktop app as is (its plugins, MCP servers, `notify`
   program, and thread list), or run bare with the overrides from change 5? Sharing the home is required for the
   login either way.
2. Is the Phase B scope "chat pane for Codex", or a plain activity log first and the rich view in Phase E as planned?
3. `acceptEdits` on Codex also lets sandboxed commands run unasked. Accept that, or map `acceptEdits` to something
   narrower with the `granular` policy?
4. Should the app trigger the Windows sandbox setup itself when it is missing, or only explain how? (`elevated` raises
   a UAC prompt and changes ACLs across the user profile; `unelevated` needs nothing.)
5. Does the free plan's allowance make a hosted Codex session useful in practice? `account/rateLimits/read` gives the
   numbers for a usage readout in the sidebar.
6. `codex app-server daemon` and `proxy` (a shared local daemon that the CLI's `codex agents` also uses) were not
   explored. They could let the app see sessions it did not start.
7. Pin the protocol to the installed CLI version? The surface is marked experimental, and fields outside the stable
   generated types are already on the wire. Regenerating types in CI against the user's installed version is cheap.

## Not tested

- Any successful model turn: items, deltas, approvals, steer, interrupt, subagents (see "To verify").
- A successful login through `account/login/start`, and login while the desktop app holds port 1455.
- Console-window behaviour when spawned from Electron; a packaged build.
- `--listen ws://` and `unix://` transports; the daemon.
- `windowsSandbox/setupStart`; what the `unelevated` sandbox restricts.
- Whether the bare overrides remove the tools as well as the MCP start-up notifications.
- Two app-server processes on one home at the same time with live turns (the desktop app's own `codex.exe` processes
  were running during every default-home spike, with no visible conflict for read-only calls and ephemeral threads).

## Leftovers from these spikes

- Nothing was written to `~/.codex` by the harness beyond what `codex` itself does on start (log and state database
  writes). The twelve threads started there were `ephemeral` and no turn ran.
- The scratch home and working directory are under the session scratchpad (`…\scratchpad\codex-spike`), outside the repo.
- `scripts/spikes/codex/generated/` is untracked (735 files). Decide whether to commit it or regenerate on demand.

## Logged-in results (2026-10-02, free ChatGPT plan, codex-cli 0.160.0) — VERIFIED

Ran `node scripts/spikes/codex/logged-in-check.cjs` (5 short turns, default CODEX_HOME, scratch cwd).

- **Free plan runs turns.** `account/read` → `{type:"chatgpt", planType:"free"}`; model `gpt-6-luna`;
  `rateLimits.primary` = one 30-day window (`windowDurationMins: 43200`), still 0 % used after 5 turns.
- **`approvalPolicy: "on-request"` + `workspaceWrite` did NOT ask** for `node -e …` (ran sandboxed, no request).
  **`approvalPolicy: "untrusted"` raised `item/commandExecution/requestApproval`** (server request, `id` on the
  same pipe) with `command`, `cwd`, `commandActions`, `proposedExecpolicyAmendment`,
  `availableDecisions: ["accept", {acceptWithExecpolicyAmendment…}, "cancel"]`. Answering `accept` ran it;
  lifecycle: `thread/status/changed` (waiting on approval) → `serverRequest/resolved` → item completed.
  => Agent Office "default" permission mode should map to `untrusted` if the user wants to approve commands
  from the CEO inbox; `on-request` only asks when the sandbox would be exceeded.
- **Streaming:** `item/started` / `item/completed`, `item/agentMessage/delta` (4 per short answer),
  `item/commandExecution/outputDelta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `turn/completed`.
- **`turn/steer` works mid-command:** same turn id, a second `userMessage` item appears, and the final answer
  honoured the steer. A wrong `expectedTurnId` → error -32600.
- **`turn/interrupt` works:** turn ends `status: "interrupted"` ~1.6 s later; the next turn runs normally.
- **Resume in a new process works** (`thread/list` with cwd filter → `thread/resume` → `thread/turns/list`
  returns full items). **Resume resets policy**: response showed `approvalPolicy: "never"`, sandbox `readOnly`
  → the driver must pass approvalPolicy/sandbox again on resume / every `turn/start`.
- Commands are wrapped as `powershell.exe -Command "<cmd>"`; `commandActions[].command` has the inner command
  (use it for the card summary). `commandActions.type` was `unknown` for `node -e` (expected).
- Each thread start/resume launches the desktop app's MCP servers (`node_repl`, `codex_apps`, `cua_repl`).
- Harmless stderr noise on exit after an interrupt (`UnknownProcessId`, `failed to record rollout items`).

Still unverified: fileChange approvals + diff payload, webSearch, subagent (collab) threads, plan mode.
