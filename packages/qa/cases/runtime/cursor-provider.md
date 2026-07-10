---
id: runtime-cursor-provider
description: Validate the Cursor runtime provider end to end — external cursor-agent CLI, local credentials, sandbox/safety posture, and per-turn settlement.
areas: [runtime]
surfaces: [client, cli, server, web]
---

# Cursor Runtime Provider

## Goal

Confirm that an agent bound to the `cursor` runtime provider behaves correctly across its four cross-surface concerns:
external-CLI resolution, local-credential handling, safety posture, and per-turn settlement. This is a
provider/auth + cross-surface change, so select it whenever cursor runtime behavior, cursor auth, or cursor safety
posture is in scope. Do not select it for claude-code / codex validation, or for web/API-only work that never drives a
cursor turn.

## Checklist

### External CLI (no bundled binary)

- Confirm First Tree resolves the Cursor CLI from PATH / well-known install dirs under BOTH names — `agent` (preferred)
  and `cursor-agent` — with no bundled binary.
- Confirm the capability probe is install-only: it reports `cursor` as installed when the binary is resolvable WITHOUT
  launching it, running login, or spawning a session; a logged-out cursor still probes as installed.
- Confirm the web setup card and CLI surface the correct installer for a `missing` or `error` cursor entry —
  `curl https://cursor.com/install -fsS | bash` (NOT an `npm install -g` line) plus `cursor-agent login`.

### Local credential handling

- With cursor logged out (no `CURSOR_API_KEY`, no `cursor-agent login`), send one message and confirm the turn settles as
  a terminal, non-retryable failure with a durable in-chat notice that names the re-login command `cursor-agent login`,
  and that First Tree never reads or writes cursor's own credential store.
- With cursor authenticated, confirm a minimal one-turn interaction reaches a real assistant reply.
- Confirm an invalid `--model` and a usage/quota-limit exit also settle terminal (not an infinite retry), each with a
  durable notice.

### Safety posture

- Confirm the per-turn spawn is `agent -p --output-format stream-json --trust --force --sandbox disabled [--model …]
  [--resume …]`, prompt delivered via stdin, and that no MCP approval flags are passed in v1.
- Confirm suspend/shutdown terminate the active cursor child with a bounded SIGTERM→SIGKILL escalation and never delete
  the agent home.

### Per-turn settlement

- Confirm a successful turn emits `token_usage` (provider `cursor`), the full aggregated `assistant_text` from the
  result, and `turn_end: success`, invokes the turn-completion hook (clears the per-chat trigger), and that tool calls
  (`edit` / `write` / `read` / `shell`) surface with file refs that appear in the Context view's IO accounting.
- Confirm a no-result crash AFTER a tool side effect settles terminal (never replays the tool effect), while a
  no-result crash with no side effects is retryable.
- Confirm the auth/model/quota classification survives stderr that arrives after process exit (the settlement waits for
  full stdio drain before classifying).

## Evidence

Credible evidence can include the resolved binary path + `agent --version` output, the capability snapshot entry for
`cursor`, a stream-json turn transcript, the emitted session events (`token_usage` / `assistant_text` / `tool_call` /
`turn_end` / structured provider-retry `error`), the durable chat notice text, the Context view IO rows, and the spawn
argv. Do not paste `CURSOR_API_KEY`, session tokens, cookies, or any cursor credential material into the report.

## Expected Result

For real cursor agent behavior the run must reach `one-turn-ready`: `agent` / `cursor-agent` resolves in the run cell and
completes a minimal authenticated turn with correct settlement events. A logged-out / unauthenticated cursor, a missing
Linux-compatible binary, or an unbridgeable credential is `BLOCKED` for runtime behavior, not product `FAIL`. Terminal
auth/model/quota settlement with a durable notice is the expected product behavior, not a failure.
