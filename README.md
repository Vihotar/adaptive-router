# Adaptive Router — Version 1.1

## New: a real coding task on a disposable website

Double-click **Start Coding Task.cmd** and type **Add a contact form to the test website.** Or use:

```powershell
node router.mjs code "Add a contact form to the test website."
```

V1.1 starts from the small Sample Shop website in `fixtures/test-site/`. The selected worker receives its current code and produces edits. The router applies those edits to actual HTML, CSS and JavaScript files in a new isolated project revision. It executes that website in fresh sandboxed Chrome and checks the form's labels, required fields, invalid email handling, successful demo submission, mobile layout and absence of JavaScript errors or external requests. The trusted tests are outside the files the worker can edit. No generated code runs in Node or a shell.

Test failures go back to the builder automatically. A passing version goes to an independent AI, preferably Antigravity. Review findings also trigger corrections and another browser test. The final tested and reviewed version waits for your approval, which records local acceptance only.

This release supports one deliberately small coding task: adding a contact form to this disposable website. It does not accept arbitrary repository paths, run package-install scripts, send email, deploy or connect example.com. The form shows **Demo only: message not sent.** A real email/backend connection would be separate approved work.

### Availability and fallback

- Builder order: **Codex → Claude Code → Antigravity**.
- Reviewer order: **Antigravity → Claude Code → Codex**, excluding **every worker that contributed code** to this task.
- Missing commands, failed sign-in, quota/network failures, timeouts and unusable worker responses are recorded, then the next eligible worker is tried. An unsuccessful worker is skipped for the rest of that run.
- Claude Code has a response-only adapter and is auto-detected if its native command is installed and signed into a Claude subscription. No runnable Claude command was found during this setup, so it is skipped here. Its adapter has not been verified against a live Claude session. No new account or paid API connection was added.
- If no independent reviewer remains, the tested code is saved as `waiting_for_reviewer`; it is never self-approved. Retry a waiting task with `node router.mjs resume-code TASK-ID` after a worker is available. This rechecks availability and retains saved code. A task waiting for a builder can be resumed the same way.

`node router.mjs code-demo` exercises the real loop with a deliberate first-version submission-handler fault. Normal `code` tasks do not inject faults. Per-version browser test reports and mobile screenshots are stored beside the code and independent reviews. Failover is covered by local simulations; that is distinct from a live provider-quota outage.

Browser dependencies are recorded in `browser-runtime.json` using the tools already installed on this computer. They need updating if those installations move. No browser testing service or running dashboard is required.

The original text-draft workflow below remains available as `node router.mjs ask`. Its original fixed routing is separate from the new coding workflow's fallback selection.

---

## Original text-draft workflow

Give one business instruction. Codex turns it into a short plan and prepares the work. Antigravity checks the result independently. If it finds a fixable problem, the router sends its feedback to Codex and asks Antigravity to check the next version. A passing result is saved for **your approval**.

This version prepares **local drafts in new test folders**. It does not connect to example.com or edit an existing business project.

## Give it a task

Double-click **Start Adaptive Router.cmd** in this folder. When asked what you would like done, type an instruction, for example:

> Draft a short English checklist for responding to a new customer enquiry. Include confirming the request, preparing a quotation, agreeing delivery, and following up. Save it as customer-checklist.md. Do not contact anyone.

The terminal shows progress and prints the location of `APPROVAL.md` when the result is ready. Open that file to see the result summary, independent review and links to the deliverables.

You can also run these commands in a terminal in this folder:

```powershell
node router.mjs ask "Draft a short customer enquiry checklist in English. Do not contact anyone."
node router.mjs list
node router.mjs status TASK-ID
```

Each instruction is a new task. Provide the relevant business facts in the instruction. V1 does not import existing projects, attachments, accounts or private business systems. If the request lacks essential details, it stops and asks for them; submit a new instruction including your answers.

## Approve or reject a result

Read the deliverables linked from the task's `APPROVAL.md`, then use the command shown in that file:

```powershell
node router.mjs approve TASK-ID
node router.mjs reject TASK-ID "Explain what needs to change"
```

Approval records your acceptance of that exact local draft. **It never deploys, sends a message, spends money, deletes important data, changes an account or service, or alters a database.** Those actions are not implemented in V1. Requests to perform them stop for human attention. Approving a draft is not approval to perform an external action.

If someone changes the deliverable files after review, approval is refused until a new reviewed result is produced. A failed or unreviewed task cannot be approved. A rejection is recorded; submit a revised instruction to start new work.

## How the router chooses workers

The rules are deliberately simple and visible in `workers.json`:

| Work | Worker | Why |
| --- | --- | --- |
| Understand the instruction and list small jobs | Codex | Enabled for planning |
| Prepare the complete draft and apply corrections | Codex | Enabled for building |
| Independently review the complete draft | Antigravity | Enabled for review; must differ from the builder |
| Claude Code | Disabled | Reserved for a later adapter |
| Cline | Enabled | Lower-cost worker for routine tasks |

The router selects an enabled worker with the required role and an installed adapter, using its configured priority. With today's two workers, there is one eligible choice per role. It does not claim to predict which model is smartest or cheapest. If a required worker is missing, signed out, unavailable or out of quota, the task stops and records the problem. It does not silently substitute the builder for its own reviewer.

The plan can contain up to five jobs. V1 sends the related jobs together to Codex, which returns the complete set of deliverables. It does not launch a team of concurrent agents.

## How review and correction work

Antigravity receives the original instruction, the plan and the actual complete draft. It checks accuracy, completeness and safety and returns one of three decisions:

- **Pass:** bring the result to you for approval.
- **Changes requested:** send concrete issues back to Codex, then independently review the new version.
- **Blocked:** stop because human input is needed.

The router allows at most two correction rounds, then stops for human attention. Each worker call has a three-minute limit. A missing, malformed or contradictory review never counts as a pass.

Antigravity's review is a content/code inspection. Generated programs are **not executed**, so a review is not proof that generated software runs correctly. The router's own tests are separate from testing generated deliverables.

## Where work is kept

Each task gets its own folder under `.router/tasks/TASK-ID/`:

- `task.json`: instruction, status, routing decision and result summary.
- `events.jsonl`: time-stamped task, worker, correction, failure and approval history.
- `plan.json`: understood goal and jobs.
- `build-N/` and `review-N/`: separate worker workspaces, exact requests, responses and logs.
- `deliverables-N/`: a new folder for each version; earlier versions are retained.
- `manifest-N.json` and `review-N.json`: the files' fingerprint and corresponding review.
- `APPROVAL.md`: the result presented for your decision.
- `approval.json`: your decision, if one has been recorded.

These local records can contain your instructions and results. They are excluded from Git, along with downloaded tools. The worker applications also retain their normal local runtime logs.

## Safety built into V1

- No production target, deployment command, external-action adapter or automatic application of drafts to existing projects.
- Codex uses its read-only mode with shell, browser, app connectors, plugins, hooks and delegation disabled for these calls. It proposes file contents in its response; the router saves them.
- Antigravity receives a separate disposable workspace. A hook inside that workspace blocks its action tools before execution. The router verifies that the hook ran and refuses a review that attempted a blocked action.
- A single router lock prevents simultaneous writers. Each revision goes into a new folder; the reviewer never edits the builder's deliverables.
- Only small text deliverables are accepted: Markdown, text, JSON, HTML, CSS and JavaScript. Absolute paths, parent-directory paths, hidden files, Windows device names and duplicate file names are rejected.
- Existing account sign-ins are used. API-key environment variables are not passed to workers; no API provider is connected. Normal subscription quotas still apply. The router does not buy credits or change billing.

If a terminal was interrupted, check that no worker is still running before starting another task. `node router.mjs unlock` removes the lock only when the recorded router process is no longer running. Previous task records remain; a new instruction starts a fresh attempt. There is no automatic crash-resume or retry loop.

## Check the installation or repeat the tests

```powershell
node router.mjs doctor
npm test
node router.mjs demo
```

`demo` is a **live** dummy quotation test using both workers. It deliberately replaces the first draft's total with 999, logs that test fault, and requires Antigravity to identify it before Codex corrects it. It still stops for your approval. This is not a real customer quote.

`npm test` runs local automated tests with simulated worker responses. It covers routing, the correction loop, approvals, failures, changed files, path safety, locking and timeouts. It does not use model quota. The live safety checks are available as `node scripts/check-reviewer.mjs` and `node scripts/check-write-block.mjs`.

Node.js, Git and Codex must remain installed. Antigravity CLI is kept locally at `.tools/agy.exe`. Its existing account sign-in was used; no API key was added. On another computer, install/sign in to the official worker CLIs first. This folder is not a portable bundle of credentials. The router creates its review hooks locally for each call; no global hook registration is needed.

## Add later, only when needed

- Claude Code adapter when quota is available; keep the existing task/review/approval flow.
- Carefully scoped access to real projects, executable tests, and applying accepted changes.
- Per-worker live availability, quotas, cost tracking and richer task-based selection.
- Resume an interrupted task or incorporate human revision feedback into an existing task.

There is intentionally no dashboard, server, background scheduler or production connection in V1.

Implementation references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Antigravity headless mode](https://antigravity.google/docs/cli/headless/), and [Antigravity hooks](https://antigravity.google/docs/hooks/). Actual Windows behavior was checked with the installed CLIs.
