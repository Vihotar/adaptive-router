# Known Issues — Adaptive Router v0.1.0

This document lists known operational and architectural limitations for the v0.1.0 release.

---

## Known Behavioral & Platform Limitations

### 1. Headless Browser Verification Requires Local Runtime Setup

Automated browser acceptance checks (for web deliverables with `index.html`) require `browser-runtime.json` pointing to a local Playwright installation and Chromium/Chrome binary. If `browser-runtime.json` is not present, browser checks are marked as `skipped` / `unavailable`, and static deliverable checks continue. Run `node router.mjs doctor` to inspect runtime configuration.

### 2. Cline stdin Piping (Windows)

Some builds of the Cline CLI on Windows do not reliably accept interactive piped stdin when spawned via Node. AR works around this by writing the task instruction to a temporary manifest file in Cline's working directory (`.adaptive-router-cline-task-*.md`) and passing a concise reference command line. This is handled transparently in `src/workers.mjs`.

### 3. Planning AI Stub

The conversational planning endpoint (`POST /api/plan` / `POST /api/planning/chat`) is a foundational interface stub:
```
Planning AI unavailable: conversational planning provider is not configured.
```
Planning workflows can proceed directly to task execution via `node router.mjs code "..."` or the Launch New Task modal in the dashboard.

### 4. Cloudflare Tunnel Manual Execution

The automated tunnel start endpoint (`POST /api/tunnel/start`) returns a status notice directing operators to run the standalone tunnel script (`scripts/start-tunnel.cmd` or `cloudflared tunnel --url http://localhost:3210`). The status endpoint (`GET /api/tunnel/status`) reliably detects active tunnels via the `.mcp_tunnel_url` state file.

### 5. Platform Compatibility (Windows-Primary)

Adaptive Router was developed and tested primarily on Windows 11. While core routing logic and Node.js code are cross-platform, deployment on Linux or macOS may require adjusting:
- Worker CLI path detection (`where` vs `which`)
- Windows-specific cmd escaping in `src/workers.mjs`
- File system path conventions

Contributions and PRs for cross-platform enhancements are welcome.
