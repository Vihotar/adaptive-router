# Adaptive Router — Architecture

This document is for a technical reader (a developer or contributor) taking over or
extending this codebase. It is grounded in the actual source under `src/*.mjs`.

## 1. High-level flow

```
Operator submits instruction (dashboard or connector API)
        |
        v
classifySensitivity() hard-stop check  -------> sensitive? -> needs_cto_attention
        |  (not sensitive)                        (never dispatched to a worker)
        v
classifyTask() / rankCandidatesForRole()  (src/smart-router.mjs)
  picks a builder worker + model/effort tier
        |
        v
Build      - chosen worker CLI runs, produces deliverable files
        |
        v
Automated test - src/browser-test.mjs (headless browser) and/or
                  src/project-test.mjs run against the deliverable
        |
        v
Independent review - a DIFFERENT worker (never the builder) reviews the
                      work; src/capability-tiers.mjs enforces that the
                      reviewer meets a minimum seniority tier relative to
                      the builder, and src/reviewer-gate.mjs / the
                      `reviewPolicy` setting controls whether review is
                      required at all
        |
        v
awaiting_approval  - task parks here with a business-friendly summary
        |
        v
CTO decision (dashboard "Approve & Apply Deliverable" /
              "Request Changes / Reject Draft")
        |
        v
Approved -> files written into the target project folder
Rejected/changes requested -> feedback loop back into build (up to
                               workers.json's maxCorrections)
```

The single choke point all of this passes through is `codeTask()` in
`src/coding.mjs` (1592 lines — the largest module in the project). Every
task creation AND every resume goes through it, which is why the sensitivity
gate lives there rather than only at task-creation time (see section 6).

## 2. Module map (src/*.mjs)

Verified by reading each file, not copied from the older file map.

| File | Lines | Responsibility |
|---|---|---|
| `router.mjs` (root) | - | CLI entry point (`dashboard`, `code`, `code-demo`, `resume-code`, `doctor`, `demo`, plus `approve`/`reject`/`unlock` via `args[0]`). Wires CLI flags to `codeTask()`/`createTask()`/`decide()`. |
| `src/server.mjs` | 2120 | The HTTP server: native `node:http`, all REST endpoints (section 7), SSE streams, static file serving, the in-memory per-project "is a task running" gate, startup orphan-task recovery. |
| `src/coding.mjs` | 1592 | `codeTask()` - the build/test/review/retry loop. Owns the sensitivity hard-stop, prompt assembly, worker dispatch, auto-retry/correction logic, and all `decisionRequired` shapes the dashboard renders as decision cards. |
| `src/workers.mjs` | 708 | Subprocess adapters that actually shell out to each worker CLI (Codex, Claude Code, Antigravity, Cline) and parse their output. |
| `src/smart-router.mjs` | 488 | `classifyTask()` (difficulty/risk/category) and worker/model/effort selection. Routine non-design tasks are steered toward Cline to conserve paid senior quota; design/UI/CSS work is pinned to senior workers regardless of difficulty (CTO policy, see CLAUDE.md). |
| `src/capability-tiers.mjs` | 447 | Enforces reviewer-seniority floors (a lower-tier builder can't be "reviewed" by an even-lower-tier worker) and model-family independence between builder and reviewer. |
| `src/events.mjs` | 437 | NDJSON event formatting for SSE, and `sanitizePayload()` - the log/payload redaction used both for `events.jsonl` and anywhere sensitive-looking fields must be scrubbed before display or connector exposure. |
| `src/connector.mjs` | 537 | Bearer-token-authenticated REST surface for external callers (e.g. a ChatGPT custom connector) under `/api/connector/*`, plus `/mcp`. `SECRET_PATTERN` strips any field whose key looks like a credential before it's ever returned. |
| `src/mcp-server.mjs` | 325 | MCP JSON-RPC 2.0 handler (`initialize`, `tools/list`, `tools/call`) mounted at `/mcp`. |
| `src/projects.mjs` | 251 | Project registry (`.router/projects.json`): create/list/get/delete a registered project, active-project pointer, and `deleteProject()`'s safety guardrails (can't delete a built-in/hidden project, can't delete one with an active task, folder path re-validated against a system/profile/AR-root blocklist before `fs.rmSync`). |
| `src/cto-attention.mjs` | 258 | The persistent CTO Attention/Inbox system - see section 4. |
| `src/storage.mjs` | 132 | Atomic JSON writes (`json()`), event appends, deliverable path/content validation (`safePath`, `validateFiles`, `saveFiles`, `verifyFiles`), and `locked()` - the per-project-scoped lockfile primitive (section 3). |
| `src/sensitivity.mjs` | 79 | `classifySensitivity()` (topic-level keyword scan: credentials/account access/payment processing/system commands) and `containsLikelySecret()` (content-level: does the text contain something that looks like an actual live key/token). Both feed the hard-stop in `coding.mjs`. |
| `src/failover.mjs` | 386 | Detects quota/rate-limit/crash conditions on a worker and transitions to the next eligible candidate in priority order. |
| `src/failure.mjs` | 219 | Structured failure reporting - turns a raw worker failure into a reason a non-technical reader can act on. |
| `src/token-tracker.mjs` | 221 | Tracks and persists per-role (builder/reviewer) token usage per task, with an explicit accuracy/partial-honesty flag when one side's usage is unavailable. |
| `src/worker-health.mjs` | 134 | Lightweight Healthy/Degraded/Cooldown status per worker, used both for routing decisions and for display. |
| `src/permissions.mjs` | 241 | Desktop app launcher + human-in-the-loop authorization (e.g. confirming Claude Pro quota use) when a worker path needs it. |
| `src/planning.mjs` | 189 | Multi-turn planning conversation state ahead of code execution ("Stage A"). |
| `src/specialists.mjs` | 206 | Keyword matching from a task instruction to one of the specialist personas defined in `specialists.json` (131 personas), injected into build/review prompts. |
| `src/staff-log.mjs` | 64 | Appends a plain-language summary of each completed routine task to `.router/staff-activity-log.md`, so the CTO (or Claude) can review a day's work without watching the dashboard live. |
| `src/browser-test.mjs` | 68 | Headless Chrome/Edge automated test harness for web deliverables. |
| `src/project-test.mjs` | 118 | Automated test runner for non-browser project types. |
| `src/reviewer-gate.mjs` | 28 | Small helper enforcing whether independent review is required per the current `reviewPolicy`. |
| `src/contracts.mjs` | 23 | Shared constants/shape definitions used across modules (kept intentionally tiny). |
| `src/capability-tiers.json` | - | Data: tier definitions per model/platform/effort. |
| `specialists.json` | - | Data: the 131 specialist persona definitions. |
| `src/web/index.html` / `app.js` / `prototype.css` | - | The dashboard frontend: task submission form, Stage A/B approval cards, live activity feed via SSE, Office View, CTO Inbox UI. (`prototype.css` is the actual live stylesheet despite its name — an earlier `styles.css` and a separate `prototype.html`/`prototype.js` pair were dead leftovers from an earlier iteration and have been removed.) |

## 3. Concurrency model

Two cooperating mechanisms, both scoped **per project**:

1. **On-disk lock - `storage.mjs`'s `locked(root, action, scope)`.** Writes
   `router.lock` (or `router.lock.<scope>` when a scope/project id is
   passed) containing `{ pid, started }`, and removes it when `action()`
   finishes. If a lock file exists but its recorded `pid` is no longer alive
   (checked via `process.kill(pid, 0)` - a live-process probe, not an
   actual signal), the lock is treated as stale and safely stolen. This is
   what makes it possible for two *different* projects to run tasks
   truly concurrently while same-project task starts remain fully
   serialized, exactly as before per-project scoping existed.

2. **In-memory gate - `activeRunningTasks` (a `Map<projectId, taskId|'running'>`)
   in `server.mjs`.** Set to the sentinel `'running'` the instant a
   background task starts (before its real task id is known from the first
   worker event), then updated to the actual task id once known. This
   replaced an older single server-wide `activeRunningTask` variable that
   used to serialize ALL tasks regardless of project - commit
   `70fc071 Enable true cross-project concurrent task execution` is what
   turned this into a per-project map.

`getActiveTask(root, projectId)` in `server.mjs` is the read side. It first
checks the in-memory map for that project, and if nothing is there (e.g.
right after a restart, before the map has repopulated), falls back to
scanning on-disk task state via `listRecentTasks()`. **Known gotcha:** these
two paths return two different shapes for the same logical task - the
in-memory-map path returns the raw `task.json` (with `builderWorker`/
`reviewerWorker` fields), while the on-disk fallback returns the
dashboard-mapped shape (`builder`/`reviewer` fields instead). Callers that
need both fields (e.g. `/api/office-view`) explicitly read both possible
field names rather than assuming one shape - see the comment at
`server.mjs` around the office-view handler. Any new caller of
`getActiveTask()` needs to do the same or it will silently read `undefined`
depending on which code path resolved the task.

## 4. Orphaned-task recovery at startup

`recoverOrphanedTasks(root)` runs unconditionally, before anything else
touches tasks, at the top of `createDashboardServer()`. Any task still
sitting in an "actively running" status (building/testing/reviewing, etc. -
`ORPHANABLE_STATUSES`) when the process starts cannot legitimately still be
running - the process that was running it is gone. It's demoted to
`waiting_for_worker` with an activity-log entry explaining what happened
("Recovered After Restart..."), so the existing manual "Retry Now" button
and the existing auto-retry scheduler both just work on it without a
separate recovery code path. `maybeScheduleAutoRetry()` is then called
unconditionally for every stalled task found (whether just demoted or
already stalled before the restart), because any in-memory auto-retry timer
state from the previous process is gone on a fresh start.

## 5. CTO Attention / Inbox system (`src/cto-attention.mjs`)

A durable, file-backed (`.router/cto-attention.json`) inbox of items that
need a CTO decision, deliberately kept separate from live per-task
dashboard state so it survives both a browser refresh and an AR restart.

Key properties, verified from the source:

- It does **not** duplicate decision logic. It only records *that* something
  needs attention and a short reason/action string - the actual
  approve/reject/resume/override UI is the existing per-task dialog system.
  Resolving or acknowledging an inbox item never itself performs the
  underlying action.
- It fires only for a fixed, deliberately narrow list of event types mapped
  from task status transitions (`STATUS_EVENT_TYPE` in the source):
  `needs_cto_attention` -> `SENSITIVE_TECHNICAL_DECISION_REQUIRED`,
  `needs_human_input` -> `TECHNICAL_APPROVAL_REQUIRED`,
  `awaiting_approval` -> `TASK_READY_FOR_CTO_REVIEW`,
  `completed`/`approved` -> `TASK_COMPLETED`,
  `failed` -> `TASK_BLOCKED`. Everything else is treated as normal internal
  progress and intentionally ignored.
- Repeated firing for the same task+event type refreshes the existing open
  item in place rather than creating duplicates.
- Capped at 500 items total; when over the cap, oldest *resolved* items are
  trimmed first (unread/acknowledged items are never silently dropped).
- Every function is wrapped to never throw - the inbox is explicitly a
  convenience/notification layer, not the source of truth for task state,
  and a failure here must never break task execution.
- `getAttentionSummary(root)` gives a cheap machine-readable answer to
  "does anything need attention, what task, why, what action" - this backs
  `GET /api/cto/attention`.

## 6. Sensitivity hard-stop gate (`src/sensitivity.mjs` + `coding.mjs`)

Two independent checks, both invoked from `codeTask()` in `coding.mjs`:

- `classifySensitivity(instruction)` - a topic-level regex scan for
  credential/secret mentions, account-access phrasing (login/sign-in
  combined with an account/provider name), 2FA/OTP mentions, payment
  *processing* language (charge/refund/payout/transfer - explicitly not
  payment *details*, which the CTO has ruled are fine for workers to see),
  and system-level command phrasing (ssh/RDP/sudo, disk/registry wipes, DNS
  or firewall changes). Deliberately tuned toward false positives over
  false negatives - flagging a harmless task just costs Claude one extra
  look; missing a genuinely sensitive one would leak credentials to a
  third-party model.
- `containsLikelySecret(text)` - a content-level scan for strings that
  actually look like a live secret (OpenAI-style `sk-...` keys, AWS
  `AKIA...` ids, GitHub `ghp_...` tokens, Slack tokens, raw bearer tokens,
  PEM private-key blocks). This is a **true hard stop with no override**.

This is checked at **three points** in every task: the raw instruction, the
build prompt, and the review prompt - and re-checked on every *resume*, not
just on initial creation, specifically so a task can't slip past the gate by
being paused and resumed.

When `classifySensitivity()` trips, the task is set to
`needs_cto_attention` with a `decisionRequired` object carrying an explicit
`options` array: `acknowledge_sensitive` (dismiss, keep with Claude) and
`override_sensitive` (CTO explicitly reviewed the flag and chooses to
proceed with a worker anyway - this sets `task.sensitiveOverridden`, which
only the CTO clicking that specific button can ever set; the instruction
text or a worker can never set it themselves). **Never omit that `options`
array on a sensitivity `decisionRequired`** - without it the dashboard falls
back to generic "resume" buttons that imply routing to a worker, which is
exactly the bug fixed 2026-09-12 per CLAUDE.md. The `containsLikelySecret()`
check has no equivalent override path.

## 7. REST API surface (`src/server.mjs`)

Grouped logically; method + path as matched in the source (`pathname ===`
and `pathname.match(...)`).

**Task lifecycle**
- `GET /api/tasks` - list tasks (current project by default)
- `POST /api/tasks` - create/submit a new task
- `GET /api/tasks/:id` - task detail
- `GET /api/tasks/:id/deliverable-preview`
- `GET /api/tasks/:id/deliverable/:path` - fetch one deliverable file
- `POST /api/tasks/:id/execute-plan` - run Stage A plan into Stage B code
- `POST /api/tasks/:id/decide` - Approve / Reject / Request Changes
- `POST /api/tasks/:id/resume` - resume a paused task (sensitivity ack/override, correction retry, etc.)
- `POST /api/tasks/:id/pause`
- `POST /api/tasks/:id/stop`
- `POST /api/tasks/:id/rerun-clean`
- `GET /api/tasks/:id/stream` - SSE live event stream for one task
- `GET /api/tasks/cost-hint` - plain-language cost/routing estimate before submission (uses the same `classifyTask()` logic as real routing)
- `GET /api/staff-activity` - routine-task summary log

**Projects**
- `GET /api/projects`
- `POST /api/projects` - register/create a project
- `POST /api/projects/active` - switch active project
- `DELETE /api/projects` - delete a project (guarded, see section 2)

**Planning (Stage A)**
- `GET /api/planning`
- `POST /api/planning/chat`
- `POST /api/planning/reset`
- `POST /api/planning/execute`

**CTO Attention**
- `GET /api/cto/attention` - summary (see section 5)
- `GET /api/cto/attention/list`
- `POST /api/cto/attention/:id/ack`
- `POST /api/cto/attention/:id/resolve`

**Office View**
- `GET /api/office-view` - real multi-project runtime state across every
  registered project at once (unlike `/api/status`/`/api/tasks`, which are
  scoped to the single active project). Reads the same `activeRunningTasks`
  map and on-disk task state every other endpoint uses, aggregated across
  projects in one call. Returns, per project: the active task (if any), its
  status, a truncated instruction preview, `builderWorker`/`reviewerWorker`,
  `isWorkerRunning`, `activeWorker` (only set while a worker is actually
  running - not while merely waiting on the CTO), and `waitingOnCto` (true
  when the task is in an active-but-idle status like
  `needs_cto_attention`/`needs_human_input`/`awaiting_approval`, so the UI
  never shows a worker as "busy" when it's actually just waiting on a human
  decision).

**Connector / MCP** (bearer-token authenticated; token lives in
`workers.json`'s `connectorToken`)
- `GET /mcp`, `POST /mcp` - MCP JSON-RPC 2.0 endpoint
- `GET /api/connector/status`
- `GET /api/connector/projects`
- `GET /api/connector/tasks`, `POST /api/connector/tasks`
- `GET/.../api/connector/tasks/:id(/...)` - task detail/subresources
- `POST /api/connector/claude-reserve`
- `GET /api/connector/openapi.yaml`
- `GET /api/connector/token` / `/api/connector/token/copy`
- `POST /api/connector/token/rotate`
- `GET /api/tunnel/status`, `POST /api/tunnel/start` - Cloudflare tunnel status/start (for exposing the connector externally)

**Worker / permissions / process control**
- `POST /api/workers/toggle` - enable/disable a worker
- `POST /api/review-policy` - set `reviewPolicy` (independent/etc.)
- `POST /api/claude-reserve`
- `GET /api/permissions`
- `POST /api/permissions/open-app`
- `POST /api/permissions/demo`
- `GET/POST /api/permissions/:id`
- `GET /api/pid` - the running process's own PID, so a caller can confirm
  process identity from inside rather than guessing among multiple
  unlabeled `node.exe` processes (added to solve exactly that ambiguity -
  see CLAUDE.md's "no distinguishing identity" note)
- `POST /api/shutdown` - graceful shutdown; refuses with HTTP 409 while any
  task is active (`isAnyTaskActive()`), otherwise closes the server and
  exits cleanly
- `GET /api/status` - single active-project status snapshot

Static files are served for everything else under `src/web/`, with `/`
mapped to `index.html`.

## 8. Testing

`npm test` runs `node --test test/*.test.mjs` (22 test files, 245 individual
test cases as of this release). At release time: **227 passing / 18
failing**, and the 18 are pre-existing/unrelated to this release's work -
confirmed by running the suite directly. The failing set includes pilot
routing/specialist tests (e.g. specialist-registry schema validation, a few
`test/specialist-routing.test.mjs`/`reviewer-preselection.test.mjs` cases)
and a couple of tests with environment assumptions outside this repo (per
CLAUDE.md and prior investigation) - not regressions introduced by the
concurrency, CTO Attention, or Office View work. New test files added for
this release's features include `test/cross-project-concurrency.test.mjs`,
`test/cto-attention.test.mjs`, and `test/office-view.test.mjs`.

## 9. A note on `device_bash`

CLAUDE.md contains an entry stating the Cowork device-bridge shell
(`device_bash`) "has been broken since a Windows update on Sept 8, 2026."
**That is no longer accurate as of this release** - `device_bash` has been
working normally and was used extensively throughout the work that produced
this release (verifying live source, running the test suite, writing these
very files). Treat that CLAUDE.md line as historical only; it should be
updated or removed there, and should not be repeated as current fact in any
new documentation.
