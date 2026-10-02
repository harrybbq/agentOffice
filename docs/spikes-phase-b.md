# Phase B feasibility spikes: hosting Codex through `codex app-server` (2026-10-02)

Environment: Windows 11 Home 10.0.26200, Node 24, Codex CLI 0.160.0 (`@openai/codex` from npm, native `codex.exe`).
Account: free ChatGPT plan, logged in through the Codex desktop app part-way through (see change 1).
The logged-out spikes ran in a scratch `CODEX_HOME`. The live spikes ran against the default home in a scratch
working directory: three threads, eight short turns on `gpt-6-luna` at low reasoning effort. Together with an earlier
five-turn run of the same script (last section), the usage meter went from 0 % to 1 %.

Scripts are in `scripts/spikes/codex/`:

| File | Purpose |
|---|---|
| `rpc.cjs` | Minimal JSON-RPC client for `codex app-server` over stdio: finds `codex.exe`, spawns it without a shell, logs every message both ways, answers server requests, kills its own process tree |
| `harness.cjs` | Logged-out scenarios: `probe`, `login`, `thread`, `sandbox` |
| `logged-in-check.cjs` | Everything that needs an account: approval, decline, file change, steer, interrupt, web search, sandbox escalation, resume, optional subagent |
| `generated/` | `codex app-server generate-ts --out …` output: 96 top-level files (shared and legacy v1 types) and 639 in `v2/` |
| `logs/*.log` | One JSON line per message (`t` ms, `dir` `->` `<-` `!!` stderr `--` harness note). Git-ignored (`*.log`) |

Run: `node scripts/spikes/codex/harness.cjs <scenario> [--home default] [--root <scratch dir>]`. Without `--home default`
the harness sets `CODEX_HOME` to `<root>/codex-home`. Of the harness scenarios, only `probe` and `sandbox` (read-only
calls and ephemeral threads) were run against the real `~/.codex`. `logged-in-check.cjs` always uses the real home.

## Summary

| # | Spike | Result |
|---|---|---|
| 1 | Protocol surface from generated TS | PASS: every method the driver needs exists in the stable (non-experimental) surface |
| 2 | Handshake, account, models, login flow, logged-out errors, a real turn on the free plan | PASS |
| 3 | Spawning on Windows without a shell | PASS for a console parent. Console-window behaviour under Electron is UNTESTED |
| 4 | Sandbox and approval configuration on Windows | PASS, with two traps: `workspace-write` silently becomes read-only unless the Windows sandbox is configured, and `on-request` only asks when a command has to leave the sandbox |
| 5 | Item to world-activity mapping | PARTIAL: `commandExecution`, `fileChange`, `webSearch` seen live; `commandActions` only ever said `unknown`; subagents UNTESTED |
| 6 | Rich chat feed | PASS for assistant text, command output, file changes and web search; reasoning and plan streams did not occur |
| 7 | Resume and persistence | PASS, with one trap: resume does not restore the thread's sandbox |
| 8 | `turn/steer`, `turn/interrupt` | PASS |

## Changes to the plan

1. **The account state changed during the spikes, and the free plan works.** At 13:37 `~/.codex` held only `tmp/`.
   At 13:40 the Codex desktop app (26.930.21537, under `%LOCALAPPDATA%\OpenAI\Codex`) populated it, including
   `auth.json`, and `account/read` on the default home returns `{"type":"chatgpt","planType":"free"}`. The spikes
   did not log in and did not read `auth.json`. Eight real turns then ran without any plan error.
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
10. **`on-request` asks far less than Claude's `default` mode.** A command that fits inside the sandbox runs with no
    approval at all. Only a command that failed in the sandbox and is retried outside it raises an approval. So the
    app's `default` mode should map to `untrusted` + `workspace-write` (see the permission table).
11. **`thread/resume` restores the approval policy of the last turn but not the sandbox.** A thread started with
    `workspace-write` came back as `readOnly`. Pass `sandbox` and `approvalPolicy` again on every resume.
12. **An interrupt leaves the running command card open.** `turn/completed` arrives with `status: "interrupted"`,
    but no `item/completed` is sent for the command that was running. The driver has to close open items itself.

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

- `PlanType` (`generated/PlanType.ts`) includes `"free"`, and the backend reports `ordinaryUsageAllowed: true` and one
  window of 43,200 minutes (30 days). There is no secondary (short) window and no credits.
- The free plan runs turns. Thirteen short turns (the eight here plus five from the earlier run; about 320,000 input
  tokens in total, roughly 85 % of them cached, and under 1,000 output tokens) moved `usedPercent` from 0 to 1.
  `account/rateLimits/updated` follows every model response with the same `rateLimits` object, so the app can show
  usage without polling.
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

### A real turn (default home, free plan)

`thread/start {cwd, sandbox: "workspace-write", approvalPolicy: "on-request", developerInstructions}` picked
`gpt-6-luna`. `<W>` is the scratch working directory and `<T>` the thread id. Token-usage and rate-limit
notifications and most text deltas are left out of the excerpts from here on.

```
-> {"method":"turn/start","id":7,"params":{"threadId":"<T>","input":[{"type":"text","text":"Run the command: node -e \"console.log('ao-codex')\"","text_elements":[]}],"effort":"low","approvalPolicy":"on-request"}}
<- {"id":7,"result":{"turn":{"id":"01a0fcb0-283c-…","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"active","activeFlags":[]}}}
<- {"method":"turn/started","params":{"threadId":"<T>","turn":{"id":"01a0fcb0-283c-…","status":"inProgress",…}}}
<- {"method":"item/started","params":{"item":{"type":"userMessage","id":"01a0fcb0-2e9a-…","clientId":null,"content":[{"type":"text","text":"Run the command: …","text_elements":[]}]},"threadId":"<T>","turnId":"…","startedAtMs":1790945799843}}
<- {"method":"item/completed","params":{"item":{"type":"userMessage",…},…}}
<- {"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_0fbb81cd…","text":"","phase":"commentary","memoryCitation":null,"delivery":null,"questions":null},…}}
<- {"method":"item/agentMessage/delta","params":{"threadId":"<T>","turnId":"…","itemId":"msg_0fbb81cd…","delta":"I"}}   (one per token, about 20 ms apart)
<- {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_0fbb81cd…","text":"I’ll run the requested command.","phase":"commentary",…},…}}
<- {"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-3f0bbc6f-…","pluginId":null,"scriptPath":null,"command":"\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"node -e \\\"console.log('ao-codex')\\\"\"","cwd":"<W>","processId":"93390","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"unknown","command":"node -e \"console.log('ao-codex')\""}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"<T>","turnId":"…","startedAtMs":…}}
<- {"method":"item/commandExecution/outputDelta","params":{"threadId":"<T>","turnId":"…","itemId":"exec-3f0bbc6f-…","delta":"ao-codex\n"}}
<- {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-3f0bbc6f-…",…,"status":"completed",…,"aggregatedOutput":"ao-codex\n","exitCode":0,"durationMs":116},…}}
<- {"method":"thread/tokenUsage/updated","params":{"threadId":"<T>","turnId":"…","tokenUsage":{"total":{"totalTokens":13265,"inputTokens":13203,"cachedInputTokens":5888,"cacheWriteInputTokens":0,"outputTokens":62,"reasoningOutputTokens":0},"last":{…},"modelContextWindow":258400}}}
<- {"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex",…,"primary":{"usedPercent":0,"windowDurationMins":43200,"resetsAt":1793537731},…,"planType":"free",…}}}
<- {"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_0fbb81cd…5c","text":"","phase":"final_answer",…},…}}
<- {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_0fbb81cd…5c","text":"ao-codex","phase":"final_answer",…},…}}
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"idle"}}}
<- {"method":"turn/completed","params":{"threadId":"<T>","turn":{"id":"01a0fcb0-283c-…","items":[{"type":"agentMessage","id":"msg_0fbb81cd…5c","text":"ao-codex","phase":"final_answer",…}],"itemsView":"summary","status":"completed","error":null,"startedAt":1790945798,"completedAt":1790945808,"durationMs":10499}}}
```

- **No approval was requested.** The sandbox ran the command (see spike 4).
- `turn/start` answers in about 12 ms with an empty in-progress turn. Everything else arrives as notifications.
- `turn/completed.turn.items` holds only the final message (`itemsView: "summary"`). Build the chat from
  `item/started` and `item/completed`, not from the turn object.
- Commands are wrapped in PowerShell (`powershell.exe -Command "…"`). `commandActions[].command` holds the inner
  command, which is the one to show.
- Server request ids start at **0** (`"id":0`). Treat `0` as a valid id.
- `thread/start` returns the rollout path at once (`~/.codex/sessions/2026/10/02/rollout-…-<threadId>.jsonl`).

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

## Spike 4: sandbox and approvals on Windows (PASS, with two traps)

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
- What the policies did in real turns on native Windows (elevated sandbox, `gpt-6-luna`):

  | Policy for the turn | Request | Result |
  |---|---|---|
  | `on-request` + `workspaceWrite` | `node -e "console.log('ao-codex')"` | Ran in the sandbox. **No approval request** |
  | `untrusted` + `workspaceWrite` | `node -e "console.log('ao-declined')"` | `item/commandExecution/requestApproval` before anything ran |
  | `untrusted` + `workspaceWrite` | create `ao-note.txt` with the patch tool | `item/fileChange/requestApproval` |
  | `on-request` + `readOnly` | `node -e "require('fs').writeFileSync('ao-escalate.txt','ok')"` | Ran in the sandbox first and failed with `EPERM` (exit 1). The model then asked to run it outside the sandbox: `requestApproval` with a `reason`. After `accept` it ran and the file was written |
  | `never` + `workspaceWrite` | a 25 s `node -e` timer | Ran in the sandbox, no request |

  So `on-request` means "ask when the sandbox is in the way", not "ask before commands". The read-only sandbox did
  block a write inside the working directory, so the sandbox works natively.
- The escalation, as exchanged:

```
<- {"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-02807fff-…","command":"\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"node -e \\\"require('fs').writeFileSync('ao-escalate.txt','ok')\\\"\"","cwd":"<W>","processId":"47172","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"unknown","command":"node -e \"require('fs').writeFileSync('ao-escalate.txt','ok')\""}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},…}}
<- {"method":"item/commandExecution/outputDelta","params":{"threadId":"<T>","turnId":"…","itemId":"exec-02807fff-…","delta":"node:fs:2483\r\n    return binding.writeFileUtf8(\r\n …Error: EPERM: operation not permitted, open '<W>\\ao-escalate.txt'\r\n …"}}
<- {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-02807fff-…",…,"status":"failed",…,"aggregatedOutput":"node:fs:2483\r\n…","exitCode":1,…},…}}
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}
<- {"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-c9c88d68-…",…,"processId":null,"source":"agent","status":"inProgress",…},…}}
<- {"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"<T>","turnId":"01a0fcb2-2d78-…","itemId":"exec-c9c88d68-…","startedAtMs":1790945940764,"environmentId":"local","reason":"May I run the requested command outside the sandbox to write ao-escalate.txt?","command":"\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"node -e \\\"require('fs').writeFileSync('ao-escalate.txt','ok')\\\"\"","cwd":"<W>","commandActions":[{"type":"unknown","command":"node -e \"require('fs').writeFileSync('ao-escalate.txt','ok')\""}],"proposedExecpolicyAmendment":["node","-e","require('fs').writeFileSync('ao-escalate.txt','ok')"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["node","-e","require('fs').writeFileSync('ao-escalate.txt','ok')"]}},"cancel"]}}
-> {"id":0,"result":{"decision":"accept"}}
<- {"method":"serverRequest/resolved","params":{"threadId":"<T>","requestId":0}}
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"active","activeFlags":[]}}}
<- {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-c9c88d68-…",…,"processId":"45828","source":"unifiedExecStartup","status":"completed",…,"aggregatedOutput":null,"exitCode":0,"durationMs":87},…}}
```

- A declined command (`untrusted`, answered `{"decision":"decline"}`):

```
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}
<- {"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-5a352668-…",…,"processId":null,"source":"agent","status":"inProgress",…},…}}
<- {"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"<T>","turnId":"01a0fcb0-7ae5-…","itemId":"exec-5a352668-…","startedAtMs":1790945822448,"environmentId":"local","command":"\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"node -e \\\"console.log('ao-declined')\\\"\"","cwd":"<W>","commandActions":[{"type":"unknown","command":"node -e \"console.log('ao-declined')\""}],"proposedExecpolicyAmendment":["node","-e","console.log('ao-declined')"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["node","-e","console.log('ao-declined')"]}},"cancel"]}}
-> {"id":0,"result":{"decision":"decline"}}
<- {"method":"serverRequest/resolved","params":{"threadId":"<T>","requestId":0}}
<- {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-5a352668-…",…,"status":"declined",…,"aggregatedOutput":null,"exitCode":null,"durationMs":null},…}}
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"active","activeFlags":[]}}}
<- {"method":"item/completed","params":{"item":{"type":"agentMessage",…,"text":"I’m not allowed to run the command.","phase":"final_answer",…},…}}
<- {"method":"turn/completed","params":{"threadId":"<T>","turn":{…,"status":"completed","error":null,…,"durationMs":4231}}}
```

  - `decline` is honoured although `availableDecisions` listed only `accept`, the exec-policy amendment and `cancel`.
    The command never ran, the turn carried on, and the model reported the refusal. `cancel` was not tried.
  - Every request was bracketed by `thread/status/changed` with `activeFlags: ["waitingOnApproval"]` and followed by
    `serverRequest/resolved`, also when the app itself answered.
  - The request repeats `command`, `cwd` and `commandActions`, so a card can be built from the request alone. `reason`
    is present only for an escalation. `availableDecisions` arrived although `experimentalApi` was off.
  - The declined command is **not** in the thread's history afterwards: `thread/turns/list` shows only the user
    message and the answer for that turn.
- A file-change approval (`untrusted`). The request carries no diff; the `fileChange` item with the same `itemId`,
  sent 2 ms earlier, does:

```
<- {"method":"item/started","params":{"item":{"type":"fileChange","id":"exec-dfff31bd-…","changes":[{"path":"<W>\\ao-note.txt","kind":{"type":"add"},"diff":"agent office\ncodex spike\n"}],"status":"inProgress"},"threadId":"<T>","turnId":"01a0fcb0-8bc2-…","startedAtMs":1790945825532}}
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}
<- {"method":"item/fileChange/requestApproval","id":1,"params":{"threadId":"<T>","turnId":"01a0fcb0-8bc2-…","itemId":"exec-dfff31bd-…","startedAtMs":1790945825534,"reason":null,"grantRoot":null}}
-> {"id":1,"result":{"decision":"accept"}}
<- {"method":"serverRequest/resolved","params":{"threadId":"<T>","requestId":1}}
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"active","activeFlags":[]}}}
<- {"method":"item/completed","params":{"item":{"type":"fileChange","id":"exec-dfff31bd-…","changes":[{"path":"<W>\\ao-note.txt","kind":{"type":"add"},"diff":"agent office\ncodex spike\n"}],"status":"completed"},…,"completedAtMs":1790945828090}}
<- {"method":"turn/diff/updated","params":{"threadId":"<T>","turnId":"01a0fcb0-8bc2-…","diff":"diff --git a/ao-note.txt b/ao-note.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..57a5bbc05711d5a3fe25c024cfbc26b963a77616\n--- /dev/null\n+++ b/ao-note.txt\n@@ -0,0 +1,2 @@\n+agent office\n+codex spike\n"}}
```

  - `changes[].path` is absolute. For an added file, `changes[].diff` is the **new file's content**, not a unified
    diff. `turn/diff/updated` has the unified diff of the whole turn, with paths relative to the working directory;
    it was sent three times with the same content. The shape of `diff` for an `update` was not observed.
  - The file was on disk after the turn with the two lines asked for.
- `thread/shellCommand` "runs unsandboxed with full access" by its own doc comment. Never expose it.

## Spike 5: items to world activities (PARTIAL)

`commandExecution.commandActions` (`v2/CommandAction.ts`) is a best-effort parse of the shell command, one entry per
piped command: `{type:"read", command, name, path}`, `{type:"listFiles", command, path}`,
`{type:"search", command, query, path}`, `{type:"unknown", command}`. The approval request carries the same list.
So reads and searches done through the shell can be told apart from generic execution, by the types. In the live
turns every command was a `node -e …` and was classified `[{"type":"unknown","command":"node -e …"}]`; a `read`,
`listFiles` or `search` action was not provoked, so that half of the mapping is still from types only.

Seen live: `commandExecution` (with `source: "unifiedExecStartup"` for a command that ran, and `source: "agent"` with
`processId: null` for one waiting on approval), `fileChange`, `webSearch`, `agentMessage`, `userMessage`. Not seen:
`reasoning`, `plan`, `mcpToolCall`, `collabAgentToolCall`.

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

Subagents (all from types; **UNTESTED**, no sub-agent turn was run):

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

## Spike 6: feeding a rich chat view (PASS for the streams that occurred)

| Chat element | Start / end | Streaming |
|---|---|---|
| User message | `item/started` + `item/completed` `userMessage` (echo of `turn/start` / `turn/steer` input; `clientId` returns `clientUserMessageId`) | none |
| Assistant text | `item/started` `agentMessage` (empty text), `item/completed` with the full `text` and `phase` | `item/agentMessage/delta {itemId, delta}` |
| Reasoning | `item/started` / `item/completed` `reasoning` (`summary[]`, `content[]`) | `item/reasoning/summaryPartAdded {summaryIndex}`, `item/reasoning/summaryTextDelta {summaryIndex, delta}`, `item/reasoning/textDelta {contentIndex, delta}` (raw reasoning, only if the model exposes it) |
| Command card | `item/started` `commandExecution` (`command`, `cwd`, `commandActions`, `status:"inProgress"`), `item/completed` with `aggregatedOutput`, `exitCode`, `durationMs`, `status` | `item/commandExecution/outputDelta {itemId, delta}` (stdout and stderr merged), `item/commandExecution/terminalInteraction {stdin}` |
| File change card | `item/started` / `item/completed` `fileChange` (`changes: {path, kind: add|delete|update(move_path), diff}[]`, `status`; for `add`, `diff` is the file content) | `item/fileChange/patchUpdated {itemId, changes}` replaces the change list; `turn/diff/updated {diff}` is the whole turn's unified diff |
| Web search card | `item/started` (empty) / `item/completed` `webSearch` (`query`, `action: search|openPage|findInPage`, `results: {type, domain, title, url, snippet, ref_id}[]`) | none |
| MCP / tool card | `mcpToolCall` (`server`, `tool`, `arguments`, `result`, `error`, `durationMs`) | `item/mcpToolCall/progress {message}` |
| Plan / todo list | `turn/plan/updated {explanation, plan: {step, status}[]}` (whole list each time). A `plan` item with free text also exists | `item/plan/delta` (experimental; its doc says deltas may not add up to the final text) |
| Approval card | server request `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`, keyed to the card by `itemId`; closed by the app's answer or `serverRequest/resolved` | none |
| Notices | `error` (`willRetry`), `warning`, `thread/compacted`, `turn/completed` with `status: "failed" | "interrupted"`, `model/rerouted` | none |
| Usage | `thread/tokenUsage/updated {tokenUsage: {total, last, modelContextWindow}}`, `account/rateLimits/updated` | none |

Observed in the live turns (`gpt-6-luna`, `effort: "low"`):

- **Assistant text streams token by token.** `item/started` with `text: ""`, then one `item/agentMessage/delta` per
  token about every 20 ms (`"I"`, `"’m"`, `" not"`, `" allowed"`, …), then `item/completed` with the full text. A
  turn has a `phase: "commentary"` message before tool calls ("I’ll run the requested command.") and a
  `phase: "final_answer"` message at the end.
- **Command output streams in chunks**, not lines: one `item/commandExecution/outputDelta` held a whole 20-line Node
  stack trace, with `\r\n` line ends. `item/completed` repeats everything in `aggregatedOutput` with `exitCode` and
  `durationMs`.
- **No reasoning at all**: no `reasoning` item and no `item/reasoning/*` notification in eight turns, and
  `reasoningOutputTokens: 0`. Whether a higher `effort` or `summary` setting produces them is untested.
  `TurnStartParams.summary` (`"auto" | "concise" | "detailed" | "none"`) selects the summary style.
- **No plan**: `turn/plan/updated` never fired for these one-step tasks.
- **Web search works on the free plan** and needs no approval and no sandbox network access. `item/started` arrives
  empty, and `item/completed` has the query and the results:

```
<- {"method":"item/started","params":{"item":{"type":"webSearch","id":"exec-a94fe6ff-…","query":"","action":null,"results":null},"threadId":"<T>","turnId":"…","startedAtMs":1790945868515}}
<- {"method":"item/completed","params":{"item":{"type":"webSearch","id":"exec-a94fe6ff-…","query":"Electron utilityProcess","action":{"type":"search","query":"Electron utilityProcess","queries":null},"results":[{"type":"text_result","domain":"www.electronjs.org","ref_id":"turn0search0","snippet":"* `allowLoadingUnsignedLibraries` boolean (optional) macOS - With this flag, …","title":"utilityProcess | Electron","url":"https://www.electronjs.org/docs/latest/api/utility-process"},{"type":"text_result","domain":"github.com","ref_id":"turn0search1",…},…]},…}}
```

  So the web card can only show "searching…" until the item completes (1.6 s here).
- File changes: see spike 4. `item/fileChange/patchUpdated` did not fire for a one-file patch.
- Message ids differ by item kind: `msg_…` for assistant messages, `exec-<uuid>` for commands, file changes and web
  searches, UUIDv7 for user messages and turns.

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

## Spike 7: resume and persistence (PASS)

- Thread ids are UUIDv7 (`01a0fca4-011e-74c3-996a-dd3ded22601e`). `Thread.sessionId` equals the id for a root thread.
  The id fits the session manager's `resume` pattern (`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`).
- Storage, under `CODEX_HOME` (default `~/.codex`):
  - `sessions/YYYY/MM/DD/rollout-<local time>-<threadId>.jsonl` (also returned as `Thread.path`, marked UNSTABLE).
    Lines are `{timestamp, ordinal, type, payload}` with types `session_meta`, `event_msg`, `response_item`,
    `turn_context`, `world_state`.
  - SQLite: `state_5.sqlite` and `thread_history_1.sqlite` (the thread reported `historyMode: "paginated"`), plus
    `goals_1`, `memories_1`, `queue_1`, `logs_2`.
- In the logged-out scratch home a thread was not listed until after its first turn: `thread/list` 3 ms after
  `thread/start` returned `data: []`, and the same call after the turn returned the thread. That fits lazy
  persistence, but indexing lag was not ruled out. `ephemeral: true` threads are never written.
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
- With real history (default home, a thread of five turns, second `codex app-server` process):

```
-> {"method":"thread/list","id":2,"params":{"limit":10,"cwd":"<W>"}}
<- {"id":2,"result":{"data":[{"id":"01a0fcb0-7a8c-…","preview":"Run the command: node -e \"console.log('ao-declined')\"\nIf you are not allowed to run it, say so in one line and stop.",…,"model":"gpt-6-luna","reasoningEffort":"low","createdAt":1790945819,"updatedAt":1790945819,"recencyAt":1790945866,"status":{"type":"notLoaded"},"path":"C:\\Users\\Harry\\.codex\\sessions\\2026\\10\\02\\rollout-2026-10-02T13-56-59-01a0fcb0-7a8c-….jsonl","cwd":"<W>","cliVersion":"0.160.0","originator":"agent_office_spike","source":"vscode",…,"turns":[]},{"id":"01a0fcb0-27ea-…",…}],"nextCursor":null,"backwardsCursor":"2026-10-02T12:56:59.278Z"}}
-> {"method":"thread/resume","id":3,"params":{"threadId":"01a0fcb0-7a8c-…","excludeTurns":true}}
<- {"method":"thread/status/changed","params":{"threadId":"01a0fcb0-7a8c-…","status":{"type":"idle"}}}
<- {"id":3,"result":{"thread":{…,"status":{"type":"idle"},…,"turns":[]},"model":"gpt-6-luna",…,"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"readOnly","networkAccess":false},"activePermissionProfile":{"id":":read-only","extends":null},"reasoningEffort":"low","collaborationMode":{"mode":"default","settings":{"model":"gpt-6-luna","reasoning_effort":"low","developer_instructions":null}},…,"turnsBackwardsCursor":"{…}","itemsBackwardsCursor":"{…}"}}
<- {"method":"thread/tokenUsage/updated","params":{"threadId":"01a0fcb0-7a8c-…","turnId":"…","tokenUsage":{"total":{"totalTokens":120160,…},…}}}
-> {"method":"thread/turns/list","id":4,"params":{"threadId":"01a0fcb0-7a8c-…","limit":20,"sortDirection":"asc","itemsView":"full"}}
<- {"id":4,"result":{"data":[
     {"id":"01a0fcb0-7ae5-…","items":[userMessage, agentMessage],"itemsView":"full","status":"completed",…},                               (the declined command is absent)
     {"id":"01a0fcb0-8bc2-…","items":[userMessage, fileChange, agentMessage],"status":"completed",…},
     {"id":"01a0fcb0-a1d6-…","items":[userMessage, agentMessage, commandExecution, userMessage, agentMessage],"status":"completed",…},      (the steered turn)
     {"id":"01a0fcb1-1c66-…","items":[userMessage, agentMessage, commandExecution],"status":"interrupted",…},
     {"id":"01a0fcb1-34ab-…","items":[userMessage, webSearch, agentMessage],"status":"completed",…}],
   "nextCursor":null,"backwardsCursor":"{…}"}}
```

  - **The sandbox is not restored.** The thread was started with `workspace-write`, and its last turn set
    `approvalPolicy: "never"`. Resume returned `approvalPolicy: "never"` (the last turn's override) and
    `sandbox: readOnly` (the default). Pass both again on `thread/resume`.
  - `excludeTurns: true` gives no deprecation notice and `turns: []`. `thread/turns/list` with `itemsView: "full"`
    returns complete items (text, command output, exit codes, diffs), enough to rebuild the chat list.
  - Resume replays the last `thread/tokenUsage/updated`.
  - In the list, `updatedAt` stayed at the creation time; `recencyAt` moved with the last turn. Sort by `recencyAt`.
  - History differs from the live stream in two places: a declined command is missing, and the command that was
    running when the turn was interrupted is recorded as `status: "failed"`, `exitCode: -1`.
- UNTESTED: resuming while the desktop app has the same thread open, running a turn after a resume, `thread/fork`.

## Spike 8: `turn/steer` and `turn/interrupt` (PASS)

### Steer

A turn ran a 25 s command. The steer was sent 1.5 s after the command item started:

```
<- {"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-e1a7b85c-…",…,"status":"inProgress",…},"threadId":"<T>","turnId":"01a0fcb0-a1d6-…",…}}                  t = 15.6 s
-> {"method":"turn/steer","id":10,"params":{"threadId":"<T>","expectedTurnId":"01a0fcb0-a1d6-…","input":[{"type":"text","text":"Also: end your final answer with the exact word steered-ok.","text_elements":[]}]}}   t = 17.2 s
<- {"id":10,"result":{"turnId":"01a0fcb0-a1d6-…"}}                                                                                                   1 ms later
-> {"method":"turn/steer","id":11,"params":{"threadId":"<T>","expectedTurnId":"00000000-0000-7000-8000-000000000000","input":[{"type":"text","text":"ignored","text_elements":[]}]}}
<- {"error":{"code":-32600,"message":"expected active turn id `00000000-0000-7000-8000-000000000000` but found `01a0fcb0-a1d6-…`"},"id":11}
<- {"method":"item/commandExecution/outputDelta","params":{…,"itemId":"exec-e1a7b85c-…","delta":"slow-done\n"}}                                    t = 40.7 s
<- {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-e1a7b85c-…",…,"status":"completed",…,"aggregatedOutput":"slow-done\n","exitCode":0,"durationMs":25116},…}}
<- {"method":"item/started","params":{"item":{"type":"userMessage","id":"01a0fcb1-1687-…","clientId":null,"content":[{"type":"text","text":"Also: end your final answer with the exact word steered-ok.","text_elements":[]}]},"threadId":"<T>","turnId":"01a0fcb0-a1d6-…",…}}   t = 40.8 s
<- {"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a0fcb1-1687-…",…},…}}
<- {"method":"item/completed","params":{"item":{"type":"agentMessage",…,"text":"slow-done steered-ok","phase":"final_answer",…},…}}
<- {"method":"turn/completed","params":{"threadId":"<T>","turn":{"id":"01a0fcb0-a1d6-…",…,"status":"completed","error":null,…,"durationMs":31314}}}
```

- `turn/steer` is acknowledged at once with the same `turnId`: no new turn, one `turn/started`, one `turn/completed`.
- The model sees the steer **after the running tool call finishes**, not during it. The steer shows up as a second
  `userMessage` item in the same turn at that moment, and the final answer obeyed it. This matches Claude's inbox
  behaviour ("absorbed between tool calls"), with the difference that delivery is observable.
- The running command was not disturbed.
- A wrong `expectedTurnId` is refused with a message that names the active turn. With no active turn the error is
  `no active turn to steer` (below).
- Steering is refused for review and compaction turns, by the types:
  `codexErrorInfo: {activeTurnNotSteerable: {turnKind: "review" | "compact"}}`. Not provoked.

### Interrupt

```
<- {"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-3fb4c1ac-…",…,"processId":"95398","status":"inProgress",…},"threadId":"<T>","turnId":"01a0fcb1-1c66-…",…}}   t = 46.8 s
-> {"method":"turn/interrupt","id":13,"params":{"threadId":"<T>","turnId":"01a0fcb1-1c66-…"}}                                                       t = 48.367 s
<- {"id":13,"result":{}}                                                                                                                             t = 48.418 s
<- {"method":"thread/status/changed","params":{"threadId":"<T>","status":{"type":"idle"}}}
<- {"method":"turn/completed","params":{"threadId":"<T>","turn":{"id":"01a0fcb1-1c66-…","items":[],"itemsView":"notLoaded","status":"interrupted","error":null,"startedAt":1790945860,"completedAt":1790945866,"durationMs":6134}}}   t = 48.419 s
```

- The turn ended 52 ms after the request, with `status: "interrupted"`, `error: null` and the thread back to `idle`.
  Unlike Claude there is a clear end-of-turn signal after an interrupt.
- **No `item/completed` was sent for the running command.** The history later shows it as `status: "failed"`,
  `exitCode: -1`, `durationMs: 6818`. The driver must close every open item of a turn when `turn/completed` arrives.
- The thread took the next turn straight away (the web-search turn started 54 ms later and completed normally).
- When the server shut down afterwards, stderr had `exec_command failed: UnknownProcessId { process_id: 95398 }`.
  Whether the child `node` process was killed at the interrupt or ran to its 25 s end was not checked.

### With no active turn (logged-out run)

```
-> {"method":"turn/steer","id":11,"params":{"threadId":"01a0fca4-011e-…","expectedTurnId":"no-such-turn","input":[{"type":"text","text":"steer with no turn","text_elements":[]}]}}
<- {"error":{"code":-32600,"message":"no active turn to steer"},"id":11}
-> {"method":"turn/interrupt","id":12,"params":{"threadId":"01a0fca4-011e-…","turnId":"no-such-turn"}}
<- {"error":{"code":-32600,"message":"no active turn to interrupt"},"id":12}
```

- Still unknown: whether a steer is delivered while the turn is blocked on an approval, and whether `turn/start`
  during an active turn acts as a steer (the `turnTrigger` comment on `TurnStartParams` hints at it). The driver
  should send `turn/steer` when it knows a turn is active and fall back to `turn/start` on "no active turn to steer".
- The user's config has `[desktop] followUpQueueMode = "steer"`, and the experimental surface has `thread/queue/*`
  for queued follow-ups: the desktop app offers both "steer now" and "queue for after this turn".

## Live verification with the logged-in account

Run as three invocations against the default home, with the bare server arguments from change 5, working directory
`…\scratchpad\codex-live\ws-logged-in`:

```
node scripts/spikes/codex/logged-in-check.cjs --root <scratch> --only account,approval
node scripts/spikes/codex/logged-in-check.cjs --root <scratch> --only decline,filechange,steer,interrupt,websearch,resume
node scripts/spikes/codex/logged-in-check.cjs --root <scratch> --only escalate
```

Logs: `logs/logged-in-1-on-request.log`, `logged-in-2-main.log`, `logged-in-resume.log`, `logged-in-3-escalate.log`.
The first of these also contains lines from another run of the script that was writing `logged-in.log` at the same
time (thread `01a0fcaf-0735-…`); the excerpts in this document are from thread `01a0fcb0-27ea-…`.
Without `--only` the script runs all seven turns in one thread. `--only account` uses no model.

| Question | Answer |
|---|---|
| Does the free plan run a turn? | Yes. Eight turns, no plan or limit error. Default model `gpt-6-luna` |
| Free-tier limits | One 30-day window, no short window, no credits. 0 % to 1 % over thirteen short turns |
| Does `on-request` ask for `node -e "console.log(…)"`? | No. It runs in the sandbox |
| When does `on-request` ask? | When a command failed in the sandbox and the model retries it outside (`reason` set) |
| Approval accepted | Command ran (`exitCode: 0`); file change applied |
| Approval declined | Item `status: "declined"`, turn continues, model reports it |
| Approval lifecycle signals | `waitingOnApproval` flag before, `serverRequest/resolved` after, every time |
| File-change payload | On the `fileChange` item, not on the request. `add` carries file content; unified diff in `turn/diff/updated` |
| Web search on free | Works; results on `item/completed` |
| Steer | Same turn, absorbed after the running tool call, visible as a `userMessage` item |
| Interrupt | `turn/completed` `interrupted` in 52 ms; running command gets no `item/completed` |
| List and resume after restart | Works; sandbox must be passed again |

Still to verify, when the driver exists: `cancel` and `acceptForSession` decisions, a `decline` on a file change, a
`fileChange` `update` diff, reasoning and plan streams at higher effort, sub-agents (`--subagent`), commands that
classify as `read` / `search`, a turn after `systemError`, steer during a pending approval, whether an interrupt
kills the child process, console windows under Electron, and running next to the desktop app on the same thread.

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
| `start()` | `account/read` (refuse if logged out), then `thread/start {cwd, model?, approvalPolicy, sandbox, developerInstructions: briefing}` or `thread/resume {threadId: start.resume, excludeTurns: true, approvalPolicy, sandbox, …}` (resume does not restore the sandbox). Compare the returned `sandbox` with what was asked |
| `providerSessionId` | `thread.id` |
| `state` | `starting` until the thread response; `idle` on `thread/status/changed idle` and `turn/completed`; `busy` on `turn/started` or `active` with no flags; `waiting-permission` while a server request is pending or `activeFlags` is non-empty; `needs-attention` on `systemError` or a logged-out account; `exited` on server exit or stop |
| `canReceiveOrders` | `idle` (`turn/start`) and `busy` (`turn/steer`, verified). `waiting-permission`: unknown, so `false` for now |
| `sendPrompt(text)` | no active turn: `turn/start {threadId, input:[{type:"text", text: taggedOrder(text), text_elements: []}]}` gives `{ok: true, queued: false}` on the response. Active turn: `turn/steer {threadId, expectedTurnId, input}` gives `{ok: true, queued: true}`. On "no active turn to steer", retry as `turn/start`. A JSON-RPC error becomes `{ok: false, reason: error.message}` |
| `answerPermission(id, decision)` | The registry entry holds the JSON-RPC request id (which can be `0`). Allow: `{decision: "accept"}`. Deny: `{decision: "decline"}` (verified: the turn continues and the model is told). Codex's decision has no message field, so a deny message would have to follow as a steer |
| `interrupt()` | `turn/interrupt {threadId, turnId}` with the id from `turn/started`. `turn/completed` with `interrupted` follows; close the turn's open items then |
| `stop()` | interrupt if busy, `thread/unsubscribe`, then `onExit(0)` |

**Permissions**

- A server request stays open until answered; there is no timeout field in the protocol. Add the card to
  `PermissionRegistry` with `toolName` `"Command"` or `"File change"`, `summary` from `command` or the item's paths,
  `detail` from the command, cwd, `reason`, and the item's diffs.
- `serverRequest/resolved` for a request the app has not answered, `turn/completed`, and server exit all resolve the
  card as `resolved-elsewhere`. `serverRequest/resolved` also follows the app's own answer, so ignore it for
  requests already answered.
- For a file change, take `summary` and `detail` from the `fileChange` item with the request's `itemId` (it arrives
  just before the request); the request itself has no paths or diff.
- `acceptForSession` gives an "allow for this session" button later. `proposedExecpolicyAmendment` would give
  "always allow commands like this"; leave it out at first.
- `item/tool/requestUserInput` (the model asks the user a question) is a second kind of blocking request that
  `PermissionRequestInfo` does not model. Until it does, answer with empty `answers` and show a notice.
- Approvals and orders stay on renderer IPC and the app-server pipe. There is no HTTP involvement at all.

**`PermissionMode` to Codex**

| `PermissionMode` | `approvalPolicy` | `sandbox` | Notes |
|---|---|---|---|
| `default` | `untrusted` | `workspace-write` | **Recommended.** Verified: a plain `node -e` command and a patch inside the folder both raised an approval before anything ran, and ran after `accept`. This is the only combination that sends commands and edits to the CEO inbox the way Claude's `default` does |
| `acceptEdits` | `on-request` | `workspace-write` | Verified: commands inside the folder run without asking, which is wider than Claude's `acceptEdits` (commands still ask there). The model asks only to leave the sandbox |
| `plan` | `on-request` | `read-only` | Plus the `plan` collaboration mode, which is on the experimental surface (`collaborationMode/list`, `ModeKind = "plan" | "default"`). Without it, a developer instruction is the only way to ask for a plan. Verified for this pair: a write is refused by the sandbox (`EPERM`), then the model asks to run it outside, with a `reason` |

- Alternative for `default`: `on-request` + `read-only`, Codex's own default. It asks far less: nothing for commands
  that only read, and for a write only after the sandboxed attempt failed. Choose it if "trust the sandbox" is the
  intended behaviour.
- Both `workspace-write` rows need the Windows sandbox. If the `thread/start` response says `readOnly`, tell the user
  and offer `windowsSandbox/setupStart`.
- Untested: `untrusted` + `read-only` (whether an approved command then runs outside the sandbox or fails in it).
- `never` and `danger-full-access` are not offered.

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
5. Is the free plan's allowance enough in practice? Thirteen trivial turns cost 1 % of the 30-day window. Real coding
   turns are far larger. `account/rateLimits/updated` gives the numbers for a usage readout in the sidebar.
6. `codex app-server daemon` and `proxy` (a shared local daemon that the CLI's `codex agents` also uses) were not
   explored. They could let the app see sessions it did not start.
7. Pin the protocol to the installed CLI version? The surface is marked experimental, and fields outside the stable
   generated types are already on the wire. Regenerating types in CI against the user's installed version is cheap.

## Not tested

- Sub-agents, reasoning and plan streams, MCP tool calls, `cancel` / `acceptForSession` (see "Live verification").
- A successful login through `account/login/start`, and login while the desktop app holds port 1455.
- Console-window behaviour when spawned from Electron; a packaged build.
- `--listen ws://` and `unix://` transports; the daemon.
- `windowsSandbox/setupStart`; what the `unelevated` sandbox restricts.
- Whether the bare overrides remove the plugin tools as well as the MCP start-up notifications (the live turns ran
  with the overrides; shell, patch and web search all worked).
- Two app-server processes on one home at the same time with live turns (the desktop app's own `codex.exe` processes
  were running during every default-home spike, with no visible conflict for read-only calls and ephemeral threads).

## Leftovers from these spikes

- The harness wrote nothing to `~/.codex` beyond what `codex` itself does on start (log and state database
  writes); its twelve threads there were `ephemeral` and no turn ran.
- The live checks left **four threads in the user's real Codex history** (they show up in the desktop app and
  `codex resume`, originator `agent_office_spike`): `01a0fcaf-0735-7571-9cea-60fb756ce0b4` (the earlier run),
  `01a0fcb0-27ea-77c1-9acb-874a42b30573`, `01a0fcb0-7a8c-7c41-840c-875008468334`,
  `01a0fcb2-2d35-7c92-a9f3-e7c70d5f55c2`. Remove them with `codex delete <id>` or `codex archive <id>` if they are
  not wanted. `config.toml` was not changed.
- The scratch working directory holds `ao-note.txt` and `ao-escalate.txt`.
- The scratch home and working directory are under the session scratchpad (`…\scratchpad\codex-spike`), outside the repo.
- `scripts/spikes/codex/generated/` is untracked (735 files). Decide whether to commit it or regenerate on demand.

## Logged-in results (2026-10-02, free ChatGPT plan, codex-cli 0.160.0) — VERIFIED

This section is the first logged-in run, made with an earlier five-turn version of the script and without the bare
server arguments. The sections above hold the later, fuller runs and the JSON. Where they differ, the sections above
are the more detailed measurement.

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
- **`turn/interrupt` works:** turn ends `status: "interrupted"` ~1.6 s after the command started (the script waits
  1.5 s before interrupting; the turn ends about 50 ms after the request); the next turn runs normally.
- **Resume in a new process works** (`thread/list` with cwd filter → `thread/resume` → `thread/turns/list`
  returns full items). **Resume resets policy**: response showed `approvalPolicy: "never"`, sandbox `readOnly`
  → the driver must pass approvalPolicy/sandbox again on resume / every `turn/start`.
- Commands are wrapped as `powershell.exe -Command "<cmd>"`; `commandActions[].command` has the inner command
  (use it for the card summary). `commandActions.type` was `unknown` for `node -e` (expected).
- Each thread start/resume launches the desktop app's MCP servers (`node_repl`, `codex_apps`, `cua_repl`).
- Harmless stderr noise on exit after an interrupt (`UnknownProcessId`, `failed to record rollout items`).

Verified since (spikes 4 and 6): fileChange approvals and the diff payload, a declined approval, webSearch, and the
`on-request` escalation out of a read-only sandbox. Still unverified: subagent (collab) threads, plan mode.
