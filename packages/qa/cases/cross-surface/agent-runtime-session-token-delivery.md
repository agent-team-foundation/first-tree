---
id: agent-runtime-session-token-delivery
description: Verify runtime-session tokens are delivered through the per-agent token file, read fresh for each HTTP request, and never recovered from stale env snapshots.
areas: [cross-surface]
surfaces: [server, client, cli]
---

# Agent Runtime Session Token Delivery

## Goal

Verify the real product loop where each `agent:bind` mints a fresh runtime-session token, persists it to the per-agent
token file, and makes every agent-scoped HTTP call read the current file value. The case also checks that stale
`FIRST_TREE_RUNTIME_SESSION_TOKEN` environment snapshots cannot override the file and cannot act as a fallback.

## Preconditions

- Use an isolated run cell with candidate server, candidate CLI/daemon, task-local `FIRST_TREE_HOME`, and real WebSocket
  registration.
- Do not use operator staging/prod homes or credential stores.
- Redact token plaintext. Record only token file path, size, mtime, sha256, and whether the server DB hash changed.

## Operate

- Start a candidate server with runtime-session enforcement disabled, then bootstrap a candidate CLI/daemon with a
  task-local home and bind one test agent.
- Observe the first bind minting a token and writing the per-agent token file.
- Run an agent-scoped CLI command with a bogus `FIRST_TREE_RUNTIME_SESSION_TOKEN` env value and a valid
  `FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE`.
- Rotate the token through a reconnect/rebind and run a second agent-scoped CLI command without restarting the agent
  subprocess.
- Repeat the command after deleting the token file and after replacing it with an empty file.
- Repeat the relevant HTTP checks with runtime-session enforcement enabled.

## Observe

- Each successful bind writes a non-empty per-agent token file and updates server runtime-session metadata.
- Agent-scoped HTTP after a rebind uses the new file token without requiring the long-lived agent subprocess to restart.
- A bogus `FIRST_TREE_RUNTIME_SESSION_TOKEN` env value does not override a valid token file for CLI calls.
- Missing or empty token files put the CLI in token-less mode rather than falling back to the stale env value; with
  enforcement disabled those requests are accepted with a legacy warning, and with enforcement enabled they fail as
  missing-token requests.
- With enforcement enabled, a stale non-matching runtime-session token is rejected as invalid, while a missing file is
  rejected as missing.

## Expected Result

`PASS` when real daemon/CLI/server evidence shows per-bind token rotation, atomic token-file persistence, fresh file reads
for each agent-scoped HTTP request, no env-token fallback, and the expected enforcement=false/true outcomes.

`FAIL` when agent-scoped HTTP uses a stale env snapshot, fails after token rotation despite the file containing the current
token, falls back to env after a missing/empty file, or does not distinguish invalid-token and missing-token failures under
hard enforcement.

`BLOCKED` when setup, auth, provider, DB, or isolated-home preconditions prevent validation.

`INCONCLUSIVE` when evidence is partial, unstable, or not attributable to the candidate refs.
