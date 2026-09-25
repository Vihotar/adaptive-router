# Adaptive Router

**Experimental AI task router — route coding and business tasks across multiple AI worker CLIs with human approval gates, independent review, and zero npm dependencies.**

> [!NOTE]
> **Project Status: Early-stage / Experimental (v0.1.0)**
> Adaptive Router is functional and tested, but it is an early-stage project designed for personal/team productivity use. It is not a production SaaS service. Expect rough edges, especially around worker setup.

---

## What Is Adaptive Router?

Adaptive Router (AR) is a local, single-user Node.js dashboard that:

1. Takes a plain-English task instruction.
2. **Routes it intelligently** to one of several AI worker CLIs (Codex/ChatGPT, Claude Code, Antigravity/Gemini, Cline) based on task complexity, sensitivity, and worker availability.
3. Has a **different AI worker independently review** the result before presenting it to you.
4. Applies the result to a target project folder only after an **explicit human approval click**.

All state is stored as plain JSON files. There is no database, no cloud service, and **zero npm dependencies**.

---

## The Problem It Solves

When you use multiple AI coding tools, you're constantly:
- Deciding which tool to use for which task
- Copying outputs between tools for review
- Manually verifying that generated code is correct before applying it
- Tracking which tasks were approved and which weren't

Adaptive Router automates this workflow. It selects the right AI worker, gets an independent review, and requires your sign-off before anything touches your real files.

---

## Core Capabilities

- **Intelligent routing** — classifies task difficulty/risk and selects the appropriate worker and model tier (Fast / Standard / Flagship)
- **Independent review enforcement** — the reviewer is always a different worker than the builder; a lower-capability worker cannot review a higher-capability builder's work
- **Sensitivity hard-stop** — instructions touching credentials, account access, payment processing, or system commands are refused at dispatch and never reach any AI worker
- **Human approval gate** — no file is written to a project until you click Approve
- **Specialist persona system** — 131 specialist personas matched to task context (e.g. `security-ai-generated-code-auditor`, `marketing-seo-specialist`)
- **Automated browser testing** — headless Chrome test loop for web deliverables via Playwright
- **Failover routing** — if a worker fails (quota, timeout, unavailable), the next eligible worker is automatically tried
- **Connector API** — Bearer-authenticated REST + MCP endpoint for external integration (e.g., ChatGPT custom connector)
- **Multi-project support** — run tasks on different projects concurrently; same-project tasks are serialized
- **Full audit trail** — every task, decision, correction, and approval is logged to disk
- **Worker health tracking** — Healthy / Degraded / Cooldown state per worker

---

## Architecture

```
User submits instruction (dashboard or connector API)
        │
        ▼
Sensitivity gate ────────────────────────► sensitive? → stopped, needs human attention
        │ (safe)
        ▼
classifyTask() / rankCandidatesForRole()
  picks builder worker + model tier
        │
        ▼
Build  — chosen worker CLI runs, produces deliverable files
        │
        ▼
Automated test — browser test (Playwright) and/or project test
        │
        ▼
Independent review — a DIFFERENT, equally-capable worker reviews
        │
        ▼
awaiting_approval — task parks here for the human to decide
        │
        ▼
Approve → files written to project folder
Reject → feedback loop (up to workers.json maxCorrections)
```

**Key modules:**

| File | Responsibility |
|------|---------------|
| `router.mjs` | CLI entry point and command dispatch |
| `src/server.mjs` | HTTP server, REST API, SSE event streaming |
| `src/coding.mjs` | Main task orchestration loop (`codeTask()`) |
| `src/smart-router.mjs` | Task classification and worker ranking |
| `src/sensitivity.mjs` | Credential/sensitive instruction detection |
| `src/workers.mjs` | Worker adapter implementations (Codex, Claude, Antigravity, Cline) |
| `src/capability-tiers.mjs` | Model tier registry and reviewer qualification rules |
| `src/specialists.mjs` | Specialist persona matching |
| `src/connector.mjs` | External connector API (REST + MCP) |
| `src/browser-test.mjs` | Playwright headless browser testing |
| `src/web/` | Dashboard frontend (HTML, CSS, vanilla JS) |

See [`docs/architecture.md`](docs/architecture.md) for a detailed technical breakdown.

---

## Requirements / Prerequisites

- **Node.js ≥ 22** (`node --version`)
- **Git** (for version tracking)
- **At least one AI worker CLI installed and signed in:**

| Worker | CLI | Provider |
|--------|-----|----------|
| Codex | `codex` CLI | OpenAI / ChatGPT Pro subscription |
| Claude Code | `claude` CLI | Anthropic Claude subscription |
| Antigravity | `agy` CLI | Google Gemini account |
| Cline | `cline` CLI | Configures against Gemini API, NVIDIA NIM, or OpenRouter |

Workers that are not installed are automatically skipped. AR will not fail if a worker is missing — it routes to the next available one.

- **Optional: Cloudflare tunnel** (`cloudflared`) — only needed if you want to connect an external tool (e.g. ChatGPT) to the connector API.

---

## Installation

```bash
git clone https://github.com/Vihotar/adaptive-router.git
cd adaptive-router
```

That's it. There are no npm packages to install — AR has zero external dependencies.

### Verify your setup

```bash
node router.mjs doctor
```

This checks which workers are available, their sign-in status, and the configured model tiers.

---

## Configuration

### `workers.json`

The main configuration file. Edit it to enable/disable workers and set routing parameters:

```json
{
  "workers": [
    { "id": "codex",      "enabled": true,  "roles": ["plan","build","review"], "priority": 10, "adapter": "codex" },
    { "id": "antigravity","enabled": true,  "roles": ["review","build"],        "priority": 30, "adapter": "antigravity" },
    { "id": "claude-code","enabled": false, "roles": ["build","review"],        "priority": 20, "adapter": "claude" },
    { "id": "cline",      "enabled": true,  "roles": ["build"],                 "priority": 35, "adapter": "cline",
      "providerOrder": ["gemini","nvidia","openrouter"] }
  ],
  "maxCorrections": 2,
  "workerTimeoutSeconds": 600,
  "claudeReserve": true,
  "reviewPolicy": "independent"
}
```

**Key settings:**
- `enabled` — set `false` to exclude a worker from routing
- `priority` — lower number = higher preference (10 is tried before 30)
- `claudeReserve` — when `true`, Claude Code is reserved for direct use and not routed to for routine tasks
- `maxCorrections` — maximum feedback/correction rounds per task (default: 2)
- `reviewPolicy` — `"independent"` requires a different worker for review (strongly recommended)

### `browser-runtime.json` (auto-generated)

When browser testing is used, AR generates `browser-runtime.json` pointing to your local Playwright and Chrome installations. This file is machine-specific and excluded from git. AR will attempt to locate these automatically.

### Connector API Token (auto-generated)

When the connector API is first used, AR generates a random 64-character bearer token and stores it in `workers.json`. Retrieve it from the running dashboard at:
```
http://localhost:3210/api/connector/token
```
This token authenticates external access to the connector API (e.g., ChatGPT). It is never logged or exposed in API responses.

---

## How to Run

### Start the dashboard

```bash
# Start and open in browser
node router.mjs dashboard --port 3210 --open

# Or use the npm script shortcut
npm run dashboard
```

The dashboard opens at `http://localhost:3210`.

**Windows quick-start:** double-click `scripts/start-adaptive-router.cmd`. It checks if AR is already running and opens the browser, or starts it fresh.

### Run a task from the command line

```bash
node router.mjs ask "Draft a brief customer onboarding checklist. Save it as onboarding.md."
```

### Check task status

```bash
node router.mjs list
node router.mjs status TASK-ID
node router.mjs approve TASK-ID
node router.mjs reject TASK-ID "Please make it shorter and more actionable."
```

### Run the demo (live test)

```bash
node router.mjs demo
```

Runs a sample coding task to add a contact form to the bundled test website, exercising builder generation, automated validation, and independent review.

### Run automated tests

```bash
npm test
```

Automated test suite covering routing, correction loops, approvals, failure reporting, path safety, access control, concurrency, and more. No API quota is used — tests use simulated worker responses.

---

## Example: Coding Task Workflow

```bash
# Run a real coding task against the bundled sample website
node router.mjs code "Add a contact form with email validation to the sample shop."
```

AR will:
1. Select a builder worker and model tier
2. Give the worker the current website code
3. Run headless browser tests (form labels, validation, mobile layout, no JS errors)
4. Have an independent reviewer audit the code
5. Present the result for your approval

Failed tests → automatic retry with feedback. Passing tests + review → waits for your click.

---

## Known Limitations

- **Windows-first.** AR was developed and tested on Windows. It should work on Linux/macOS but some worker adapter paths and subprocess handling may need adjustment. PRs welcome.
- **CLI-only workers.** Workers must be installed locally as CLI tools. There is no direct API-key mode (by design — this prevents accidental billing surprises).
- **No multi-user support.** This is a single-user local tool. There is no authentication, no user accounts, and no multi-tenancy.
- **No cloud deployment.** AR binds to localhost only. Use `cloudflared` for controlled external access.
- **Cline integration is experimental.** The Cline worker path has known limitations with stdin piping on some Windows builds (see `src/workers.mjs` comments).
- **Simulated worker fixtures.** The automated test suite runs against simulated worker responses to test routing, safety, and approval logic without consuming paid subscription or API quota.

---

## Project Status

Adaptive Router is an **experimental, early-stage open-source project** (v0.1.0). It was built as a personal productivity tool and is being open-sourced because it contains potentially useful patterns for developers building AI orchestration systems.

It is functional and has a passing automated test suite, but:
- It has not been battle-tested at scale
- Some features are stubs (planning AI, tunnel configuration)
- Windows is the primary tested platform

Feedback, bug reports, testing, and contributions are welcome through GitHub Issues and Discussions. Future development will focus on community contributions and maintenance rather than aggressive feature expansion.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to set up a development environment and submit changes.

---

## Security

See [`SECURITY.md`](SECURITY.md) for the security policy and how to report vulnerabilities.

---

## License

MIT — see [`LICENSE`](LICENSE).

Third-party software notices and licenses are documented in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
