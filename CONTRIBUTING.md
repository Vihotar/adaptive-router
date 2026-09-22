# Contributing to Adaptive Router

Thank you for your interest in contributing! Adaptive Router is an experimental project and welcomes contributions that improve reliability, cross-platform support, documentation, and test coverage.

## Development Setup

**Prerequisites:** Node.js ≥ 22, Git, at least one supported AI worker CLI.

```bash
git clone https://github.com/Vihotar/adaptive-router.git
cd adaptive-router

# No npm install needed — zero external dependencies
node router.mjs doctor  # verify worker availability
npm test                # run the full test suite
```

## Running Tests

```bash
npm test
```

Tests use simulated worker responses — no API quota is consumed. All 348 tests should pass (minus known pre-existing failures documented in `docs/known-issues.md`).

## Project Structure

```
router.mjs          # CLI entry point
src/
  server.mjs        # HTTP server, REST API, SSE streaming
  coding.mjs        # Main task orchestration loop
  smart-router.mjs  # Task classification and worker ranking
  workers.mjs       # Worker adapter implementations
  sensitivity.mjs   # Credential/sensitive instruction detection
  capability-tiers.mjs  # Model tier registry
  connector.mjs     # External API (REST + MCP)
  web/              # Dashboard frontend
src/web/
  index.html        # Dashboard UI
  app.js            # Dashboard frontend logic
test/               # Automated tests (Node.js test runner)
fixtures/           # Test fixtures
docs/               # Architecture and technical documentation
specialists.json    # 131 specialist persona definitions
workers.json        # Worker configuration
```

## Code Style

- ES Modules (`import`/`export`) throughout
- No external npm dependencies — use Node.js built-ins only
- Prefer explicit error handling over silent swallowing
- All worker communication is subprocess-based (spawn, not API calls)

## Types of Contributions Welcome

- **Bug fixes** — especially cross-platform issues (Linux/macOS support)
- **New worker adapters** — for other AI CLI tools
- **Test coverage** — additional test cases for edge cases
- **Documentation** — setup guides, architecture explanations
- **Performance improvements** — token efficiency, startup time

## Types of Changes Requiring Discussion First

Before submitting a PR that:
- Adds an npm dependency
- Changes the core routing architecture
- Adds a new major feature

...please open an issue first to discuss the approach.

## Submitting a Pull Request

1. Fork the repository
2. Create a feature branch: `git checkout -b fix/my-fix`
3. Make your changes with clear commit messages
4. Ensure `npm test` passes
5. Open a PR with a description of what changed and why

## Reporting Bugs

Use GitHub Issues. Include:
- Node.js version (`node --version`)
- OS and version
- Which workers are installed and their versions (`node router.mjs doctor`)
- Steps to reproduce
- What you expected vs what happened

## Security Issues

Please do **not** open a public GitHub issue for security vulnerabilities. See [`SECURITY.md`](SECURITY.md) for the responsible disclosure process.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
