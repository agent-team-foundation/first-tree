---
title: Agent Security
owners: []
soft_links:
  - kael/environment
  - kael/platform/auth
  - kael/platform/security
---

# Agent Security

How the system constrains agent behavior to protect user data, credentials, and external systems. The agent is treated as untrusted — it has powerful capabilities but operates under layered restrictions.

## Threat Model

The agent sees user messages, project files, persistent memory, conversation history, browser page content, and command output. It can execute code in a sandbox (with internet), control the user's browser, and run shell commands on the user's desktop.

A compromised agent (via prompt injection or model misbehavior) could attempt to:
- Exfiltrate user data to external systems
- Exfiltrate injected credentials from the sandbox
- Perform unauthorized actions in the user's browser or desktop
- Access sensitive files on the user's machine

An agent compromise does **not** give access to system-level secrets (`INTERNAL_API_KEY`, `JWT_SECRET_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `OAUTH_ENCRYPTION_KEY`) or other users' data. These secrets never enter the agent's context or the sandbox environment.

## Defense Layers

See individual files for details:

- **[context-filtering.md](context-filtering.md)** — what enters and is redacted from the agent's LLM context
- **[sandbox-credentials.md](sandbox-credentials.md)** — how credentials are injected into the sandbox and the associated risks
