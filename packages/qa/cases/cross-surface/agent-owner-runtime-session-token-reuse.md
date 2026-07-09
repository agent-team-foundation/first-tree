---
id: agent-owner-runtime-session-token-reuse
description: Verify an agent runtime-session token is reused by the current owner client across reconnects and shared chat sessions, while ownership loss still invalidates the token.
areas: [cross-surface]
surfaces: [server, client, cli]
---

# Agent Owner Runtime Session Token Reuse

## Goal

Verify the real product loop where a bound agent's current owner client reuses the same runtime-session token across
daemon reconnect/restart and multiple chat sessions. The case also checks that missing, empty, or stale local token files
self-heal by minting a new token, and that ownership loss or revoke remains fail-closed.

## Preconditions

- Use an isolated run cell with candidate server, candidate CLI/daemon, task-local `FIRST_TREE_HOME`, and real WebSocket
  registration.
- Do not use operator staging/prod homes or credential stores.
- Redact token plaintext. Record only token file path, size, mtime, sha256, and whether the server DB hash changed.

## Operate

- Start a candidate server with runtime-session enforcement disabled, then bootstrap a candidate CLI/daemon with a
  task-local home and bind one test agent.
- Observe the first bind minting a token and writing the per-agent token file.
- Restart or reconnect the same daemon with the same home and client id.
- Create or route work to two chats for the same agent so two `(agent, chat)` runtime sessions start or resume.
- Repeat the reconnect after deleting the token file, after writing an empty file, and after writing a stale non-matching
  token.
- Repeat the relevant HTTP checks with runtime-session enforcement enabled.
- Exercise an ownership-loss path available in the run cell, such as revoke, logout, disable, or runtime switch.

## Observe

- The first bind writes a non-empty per-agent token file and server metadata contains a runtime-session hash.
- Same-client reconnect presents the file token and receives `agent:bound` without a new `runtimeSessionToken`; server
  metadata and token file metadata stay stable.
- Both chat sessions perform agent-scoped HTTP without rotating the token or logging `Invalid agent runtime session`.
- Missing, empty, or stale token files self-heal on bind by minting and writing a fresh token, after which agent-scoped
  HTTP succeeds.
- A bogus `FIRST_TREE_RUNTIME_SESSION_TOKEN` env value does not override a valid token file for CLI calls.
- With hard enforcement enabled, a token from a revoked or old owner is rejected.

## Expected Result

`PASS` when real daemon/CLI/server evidence shows owner-client token reuse across reconnect and shared sessions,
self-heal for missing/stale files, no env-token override, and fail-closed behavior after ownership loss.

`FAIL` when same-owner reconnect or shared-session paths reproduce `Invalid agent runtime session`, rotate unexpectedly,
or continue accepting an old-owner token under hard enforcement.

`BLOCKED` when setup, auth, provider, DB, or isolated-home preconditions prevent validation.

`INCONCLUSIVE` when evidence is partial, unstable, or not attributable to the candidate refs.
