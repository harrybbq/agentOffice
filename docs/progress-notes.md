# Progress bars: where the numbers come from

Notes for `shared/progress.ts`, `electron/progress.ts` and `electron/adapters/claudePlan.ts`.
Recorded on 2026-10-02 with Claude Code 2.1.284 (`--model haiku`), one hosted session, on Windows.

## The rule

A bar is determinate only when there is a real count behind it:

| kind | count | source |
| --- | --- | --- |
| `plan` | steps completed / steps | the agent's own to-do list (below) |
| `workers` | helpers finished / helpers spawned in this run | world events of the session's subagents |
| `working` | none: an indeterminate bar | the session is busy or waits on a permission |
| `idle` | none: no bar | |

Nothing is estimated from time, tokens or tool calls.

## Claude Code: which tool writes the plan

The hosted TUI (2.1.284) used the **task tools**. `TodoWrite` was not called in either turn, also
when the prompt offered it by name ("TodoWrite, or TaskCreate and TaskUpdate, whichever you have").
The reader still takes `TodoWrite` (the shape `planningSummary` in `claude-code-hooks.ts` already
assumes: `tool_input.todos[]` with `content`, `status`, `activeForm`; the whole list every time),
because other versions and non-interactive runs of Claude Code use it. **That path is covered by tests with the documented shape
only; it has not been seen live.**

A plain request ("Make a todo list with exactly three steps… Do them one by one, updating the list
as you go") made haiku do the work **without any list tool**: the bar was `working` (indeterminate)
for the whole turn, then idle. So a determinate bar depends on the model choosing to keep a list.

### Payloads seen (hooks, main thread)

All of them are ordinary `PreToolUse` / `PostToolUse` hooks; the task tools need no permission.

`TaskCreate`: the id is only in the response.

```
PreToolUse  TaskCreate tool_input    {"subject":"Create c.txt","description":"Create a new file named c.txt in the current folder","activeForm":"Creating c.txt"}
PostToolUse TaskCreate tool_response {"task":{"id":"1","subject":"Create c.txt"}}
```

`TaskUpdate`: by id; statuses are `pending`, `in_progress`, `completed`.

```
PreToolUse  TaskUpdate tool_input    {"taskId":"1","status":"in_progress"}
PostToolUse TaskUpdate tool_response {"success":true,"taskId":"1","updatedFields":["status"],"statusChange":{"from":"pending","to":"in_progress"}}
```

`TaskList`: the whole list as Claude holds it.

```
PreToolUse  TaskList tool_input    {}
PostToolUse TaskList tool_response {"tasks":[{"id":"1","subject":"Create c.txt","status":"completed","blockedBy":[]},{"id":"2","subject":"Create d.txt","status":"completed","blockedBy":[]},{"id":"3","subject":"List the folder","status":"completed","blockedBy":[]}]}
```

Ids were `"1"`, `"2"`, `"3"` (strings), numbered in the order of creation. The three tasks were
created with three separate calls, so the bar goes 0/1, 0/2, 0/3 before the first step starts.

Not seen, and handled by assumption: `TaskUpdate` with `status: "deleted"` (removes the task),
`TaskUpdate` with a new `subject`, a `TaskCreate` response without an id (the next number is used),
`TaskGet` (ignored). Unknown fields are ignored; a payload that cannot be read leaves the list as it
was last known.

### What the bar did (the second turn)

```
+0.2s  busy  working 0/0
+5.1s  busy  plan 0/1
+5.4s  busy  plan 0/2
+5.9s  busy  plan 0/3
+7.8s  busy  plan 0/3  current "Create c.txt"
+10.3s busy  plan 1/3
+11.7s busy  plan 1/3  current "Create d.txt"
+14.1s busy  plan 2/3
+15.3s busy  plan 2/3  current "List the folder"
+18.1s busy  plan 3/3
+21.3s idle  plan 3/3  finished          (Stop hook; held for 8 s)
+29.2s idle  idle
```

`current` is empty between "completed" and the next "in_progress": for a moment no step is in
progress, and the bar does not pretend one is.

## How a turn ends

- Claude: the `Stop` hook means the turn ran to its end. After Esc there is no `Stop`: the session
  goes idle through the terminal title, and the tracker reads "idle without Stop" as interrupted.
- Codex: `turn/completed` carries `status` (`completed` / `interrupted` / `failed`).
  `turn/plan/updated` is the whole list each time (`plan: [{step, status}]`, statuses `pending`,
  `inProgress`, `completed`).
- Antigravity: the `result` event's status. No plan tool is known, so its bar is only ever
  `working`.

## Recording the shapes again

Start the app with `AGENT_OFFICE_HOOK_LOG=<file>`: every hook of a plan / to-do tool of a hosted
Claude session is appended to that file (name, input, response), one JSON object per line. Nothing
is written without the variable. (`electron/drivers/claude.ts`, `logPlanHook`.)

## Known limits

- A list left unfinished by an earlier prompt stays on the bar in the next run until that run writes
  its own list (Claude Code shows its own to-do list the same way). An unrelated prompt that keeps
  no list therefore shows the old count, live, until the turn ends.
- Only the main thread's list counts. Tasks a subagent creates or updates are ignored, also when
  Claude shares one task list across a team.
- Helpers are counted per run: a helper that was spawned before the last prompt is not counted, and
  its finishing is not either.
- A session the app only observes (not hosted) has no bar.
- An order's row turns `done` when its manager goes idle after the order and no helper of that run
  is still working. A Claude manager that is woken again afterwards (a task notification) does not
  reopen the row.
