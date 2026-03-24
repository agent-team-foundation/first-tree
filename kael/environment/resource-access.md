---
title: Resource Access Control
owners: []
soft_links:
  - /kael/platform/agent-security
---

# Resource Access Control

A single `ResourceAccessService` governs what the agent can access across all environments. It handles three resource types: **web URLs**, **shell commands**, and **file paths**.

## Check Pipeline

Every agent action that touches an external resource goes through this pipeline in order:

1. **Privacy deny list** (hard block) — sensitive paths like `.ssh/*`, `.env`, `*.key`, credentials files. No override possible.
2. **Session cache** — previously approved patterns (fast, in-memory)
3. **Database lookup** — persisted grants with expiry
4. **Auto-approval whitelist** — bare-name read-only commands (ls, cat, grep, etc.)
5. **User confirmation** — SSE dialog with scope options: deny, allow once, allow in workspace (7 days), always allow (7 days)

## Coverage by Environment

| Resource type | Desktop | Browser | Sandbox |
|---|---|---|---|
| Web URLs | Yes | Yes | Yes |
| Shell commands | Yes | N/A | Yes |
| File paths | Yes | N/A | Yes (S15) |

### Sandbox file paths (S15, implemented)

Sandbox file paths are checked against the static deny list — blocked if they match a credential pattern (`.claude/.credentials.json`, `.kael-env`, `.env`, `*.key`, etc.), silently approved otherwise. No user prompt for non-sensitive sandbox files, unlike desktop where un-granted file paths trigger the full permission dialog.

The deny list is a cross-environment concern defined in `resource_access_service.py`. Sandbox file paths use the `SANDBOX` resource type (distinct from `DESKTOP`) so the service can apply different policies per environment.

See [platform/agent-security/sandbox-credentials.md](../platform/agent-security/sandbox-credentials.md) for the full threat model.

## Limitations

Resource access checks happen at the **command level** — the backend inspects the command before sending it to the environment. This catches explicit URLs in commands but cannot prevent indirect network access (e.g., a library making HTTP calls at runtime).

E2B egress network policy (domain-based outbound filtering) is deferred — see [sandbox-credentials.md](../platform/agent-security/sandbox-credentials.md) for details.
