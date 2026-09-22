# Known Issues — Adaptive Router v0.1.0

This document lists pre-existing known issues at the time of the v0.1.0 OSS release. These were present before the release and are not regressions.

## Test Suite Failures (Pre-Existing)

The following 18 test cases fail in the default test run. They are pre-existing and not blocking:

### Specialist Routing (Pilot Tests)

These tests use simulated live routing through the full Pilot task pipeline. They fail because the test environment does not have all worker CLIs available in CI, and the mocked responses in some edge cases don't match updated schemas.

- Pilot Test 3 — SEO task routing to Cline (Cline not available in most environments)
- Several other pilot routing tests that depend on specific worker availability

### Environment-Assumption Tests

These tests make assumptions about the local environment (file paths, installed tools) that don't hold in all configurations.

- Browser runtime detection tests (require Playwright + Chrome installed)
- Specialist instruction file loading tests with specific path assumptions

## Known Behavioral Limitations

### Cline stdin Piping (Windows)

Some builds of the Cline CLI on Windows do not accept piped stdin. AR works around this by writing the prompt to a temporary file in the Cline working directory. This is documented in `src/workers.mjs`. No fix is needed on AR's side — this is a Cline build limitation.

### Planning AI Stub

The conversational planning mode (`POST /api/plan`) returns an error:
```
Planning AI unavailable: conversational planning provider is not configured.
```
This is intentional — the planning AI API provider was not fully integrated in v0.1.0.

### Cloudflare Tunnel Configuration

The tunnel feature (`POST /api/tunnel/start`) returns:
```json
{ "started": false, "note": "Tunnel configuration not yet set..." }
```
Use the `scripts/start-tunnel.cmd` script instead, which invokes `cloudflared` directly.

### No macOS/Linux Testing

Adaptive Router was developed and tested on Windows. Linux/macOS may experience:
- Worker CLI path detection issues (`where`/`which` differences)
- Subprocess shell behavior differences
- Path separator handling edge cases

PRs for cross-platform fixes are welcome.
