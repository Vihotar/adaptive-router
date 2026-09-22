# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

Adaptive Router is an early-stage project. Only the latest release receives security fixes.

## Security Model

Adaptive Router runs **locally on your machine** and is designed to never expose credentials to AI workers. Key security properties:

- **No API keys required.** Workers are invoked via their local CLI tools using existing subscription sign-ins. No API key is ever passed to a worker subprocess.
- **Sensitivity gate.** Instructions involving credentials, account access, payment processing, or system-level commands are hard-stopped before dispatch and never reach any AI worker.
- **Credential-field sanitization.** The connector API (`src/connector.mjs`) strips fields matching `/token|password|secret|apikey.../i` from all responses before they leave the process.
- **Connector token security.** The connector bearer token protects `http://localhost:3210` — it is auto-generated, never logged, and only exposed via the `/api/connector/token` localhost-only endpoint.
- **Human approval gate.** No file is written to a project without an explicit human approval action.
- **Reviewer independence.** The reviewing worker is always different from the builder. The reviewer workspace blocks action tools via a pre-invocation hook.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

If you discover a security issue, please report it privately:

1. Email the maintainer directly (see GitHub profile for contact).
2. Include a description of the issue, steps to reproduce, and potential impact.
3. Allow reasonable time (up to 14 days) to assess and patch before any public disclosure.

We take security reports seriously and will respond promptly.

## Known Limitations

- **Localhost only.** AR is not designed for multi-user or public-facing deployment. If you expose it via tunnel (cloudflared), the connector bearer token is the only protection — keep it secret and rotate it regularly using the dashboard's connector settings.
- **Windows-primary.** Security testing has been done primarily on Windows. Linux/macOS behavior, especially around subprocess isolation, may differ.
- **AI worker trust boundary.** The content of AI worker responses is treated as untrusted data (not instructions). However, AR does apply worker-generated file changes to your project on approval — review deliverables carefully before approving.
