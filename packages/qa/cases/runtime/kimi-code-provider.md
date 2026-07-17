---
id: kimi-code-provider
description: Validate the bundled Kimi Code SDK provider end to end — host login reuse, real turns and resume, model override, failure recovery, and Context Tree I/O.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# Kimi Code Runtime Provider

## Goal

Confirm that an agent bound to `kimi-code` runs real turns through the pinned bundled SDK, reuses the host operator's
Kimi Code configuration without exposing credentials, and preserves First Tree's provider-neutral delivery, retry,
resume, event, and Context Tree contracts.

Use this case when the Kimi handler, SDK version, capability probe, provider selection, model control, failure
classification, or Context Tree Kimi-tool derivation changes.

## Preconditions

- Run in the isolated QA run cell selected by the plan (Docker plus a temporary source worktree; never mutate the
  operator checkout or production data).
- The client process runs as an OS user with a valid official Kimi Code login under `~/.kimi-code`. The test may check
  login usability through a real turn but must not read, print, copy, or archive credential contents.
- If login is absent or expired, install the official `@moonshot-ai/kimi-code` CLI, run `kimi`, and use `/login` on the
  same host user. First Tree must not run the SDK's device-code login itself.
- Use disposable source and Context Tree fixtures. Do not ask the live provider to modify the product checkout.

## Checklist

- Capability: the connected client advertises `kimi-code` as `ok`, `runtimeSource: bundled`, version
  `0.26.0-botiverse.2`, and no runtime path. Re-probing must not launch a Kimi turn, check auth, or make a provider
  request.
- Provider selection: Web and CLI can create a Kimi Code agent only on a client advertising the capability. The agent
  config defaults to an empty model and has no reasoning-effort field.
- Auth boundary: with the host logged out, a real turn classifies `auth.login_required` or `provider.auth_error` as a
  credential failure, posts the durable runtime notice before ACK, and tells the operator to run the official `kimi`
  CLI then `/login`. No First Tree browser/device auth action is offered and no token enters product logs or data.
- Session construction: observe that the SDK session receives the agent workspace as `workDir`, `permission: yolo`,
  session-local cwd/env through `LocalKaos`, and First Tree's output plus chat-context contract in `roleAdditional`.
  Declared source/tree paths inside the workspace are covered by `workDir` and must not be passed as `additionalDirs`
  while absent; an existing explicitly external tree may be passed as an additional root. An unset model is omitted;
  an explicit exact model id is passed through.
- Real turn: ask Kimi to read a disposable fixture, write a deterministic marker to a disposable file, and report the
  marker. Verify assistant, thinking-presence, tool lifecycle, token-usage, and successful turn-end events plus the
  expected file contents.
- Resume: suspend the chat, send a follow-up, and confirm First Tree calls SDK resume with the persisted Kimi session id,
  reapplies `roleAdditional`, cwd/env, validated external roots, and yolo permission, then completes the second turn in
  context. A permission/model initialization failure after SDK resume must close both the resumed session and harness.
- Failure and replay: prove a transient connection/rate error retries only before visible/unsafe output. After `Write`,
  `Edit`, or an unproven `Bash`, a failure must stop as unsafe replay rather than repeat the side effect; a later
  read-only tool must not downgrade that unsafe state.
- Context Tree I/O: a Kimi `Read`/`Grep`/`Glob` under the bound tree records `kimi_read_tool`; `Write`/`Edit` records
  `kimi_write_tool`; a proven read-only `Bash` records `shell_command`; repo/path evidence is qualified and writes may
  carry `git_status_delta` evidence.
- MCP boundary: if the agent config contains First Tree-managed MCP servers, the runtime emits one explicit unsupported
  diagnostic and continues. Operator-global Kimi MCP config may still load; do not claim First Tree injected it.
- Shutdown: suspend cancels and closes the active session while preserving its id; daemon shutdown also closes the
  harness and leaves queued delivery recoverable.

## Expected Result

`PASS` requires a real authenticated First Tree/Kimi two-turn run, persisted session-id continuity, deterministic
disposable file evidence, normalized events and Context Tree rows, and verified auth/failure boundaries.

`FAIL` means a reproducible product violation such as device OAuth launched by First Tree, credentials exposed, model
silently changed, missing standing role contract on resume, unsafe side effects replayed, terminal failure ACKed without
the durable notice, or absent Context Tree evidence.

`BLOCKED` means the Kimi account, credential, provider entitlement/network, or isolated run-cell topology prevented a
live branch. Mocked SDK unit tests do not turn a blocked live branch into PASS. `INCONCLUSIVE` means the turn ran but
the retained evidence cannot distinguish the claimed behavior.

## Evidence

Keep sanitized capability snapshots, agent config readback, session id before/after resume, event-kind sequence and
token totals, disposable input/output hashes, Context Tree I/O rows, failure/retry events, and relevant client logs.
Never keep tokens, credential files, account identifiers, private prompt bodies, or raw provider payloads containing
secrets.
