# Changelog

All notable changes to Adaptive Router will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-09-22

### Initial Open Source Release

This is the first public release of Adaptive Router, open-sourced from a personal productivity tool.

### Features at Release

- **Intelligent task routing** — classifies task difficulty/risk and selects worker + model tier
- **Multi-worker support** — Codex (ChatGPT), Claude Code, Antigravity (Gemini), Cline
- **Independent review enforcement** — reviewer is always a different worker than builder; seniority rules enforced
- **Sensitivity hard-stop gate** — credentials/account access/payment instructions refused at dispatch
- **Human approval gate** — no files written without explicit approval
- **Specialist persona system** — 131 specialist personas matched to task context
- **Automated browser testing** — headless Chrome (Playwright) test loop for web deliverables
- **Failover routing** — automatic escalation when a worker is unavailable
- **Cline multi-provider routing** — Gemini, NVIDIA NIM, OpenRouter provider fallback chain
- **Connector API** — Bearer-authenticated REST + MCP endpoint
- **Multi-project concurrency** — different projects run concurrently; same-project tasks serialized
- **CTO Attention / Inbox** — persistent disk-backed list of items requiring human decision
- **Office View** — live multi-project worker activity dashboard
- **Worker health tracking** — Healthy / Degraded / Cooldown state per worker
- **Token tracking** — usage tracking with record → warning → flag escalation
- **Restart safety** — orphaned task recovery, PID endpoint, graceful shutdown

### Known Limitations at Release

- Windows is the primary tested platform
- Planning AI (conversational planning mode) is stubbed
- 18 pre-existing test failures (pilot specialist-routing and environment-assumption tests)
- Cline stdin piping has known issues on some Windows builds

[0.1.0]: https://github.com/Vihotar/adaptive-router/releases/tag/v0.1.0
