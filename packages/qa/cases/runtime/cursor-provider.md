---
id: cursor-provider
description: Validate the Cursor Agent CLI runtime provider end to end — external binary, in-product login, real turns, free-form model, and Context Tree I/O evidence.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# Cursor Runtime Provider

## Goal

Confirm that an agent bound to the `cursor` provider runs real turns through the external Cursor Agent CLI with the
canonical runtime posture, that credential and configuration failures surface through the existing recovery paths, and
that cross-surface behavior (capability cards, model input, client switch, Context Tree I/O) matches the shipped
contract. Deterministic parser/handler behavior is covered by product tests; this case validates the live judgment
slices those tests cannot prove.

Use this case when the cursor handler, capability probe, runtime-auth dispatch, or provider selection surfaces change.
Pair it with the runtime-provider readiness case when the same run must also prove that existing Claude Code / Codex
agents on the client keep probing, binding, and completing turns — that cross-provider regression question belongs to
that case and the run-local plan, not this one.

## Preconditions

- Run in the isolated QA run cell selected by the plan (Docker + temporary git worktree; never the operator checkout).
- The run cell host has the official external Cursor CLI installed (`cursor-agent` or `agent`); First Tree must not
  bundle, download, or install it for you — if it is absent, exercise only the install-hint branch and mark live
  branches `BLOCKED`.
- A Cursor account the run may authenticate on that host. Login state is host-OS-user-scoped; do not copy credential
  files between users or machines, and do not read Cursor IDE storage.
- Do not modify the tested product object; config and fixtures change only inside the run cell.

## Checklist

- Capability: with the CLI absent, the computer card shows setup-incomplete for Cursor with the official installer
  command (`curl https://cursor.com/install -fsS | bash`) and no npm install copy; after installing and re-probing, the
  entry turns `ok` with a `path` runtime source. Detection must never launch the binary or judge login state.
- Provider selection: a new agent can be created on `cursor` only when the bound client advertises it; the binding is
  immutable afterwards, matching the other providers.
- Auth recovery: with the CLI logged out, a real turn fails as a credential failure; the chat surfaces a durable
  runtime notice plus a "Log in to Cursor" action before the delivery is acked. Driving the login runs the provider's
  official browser OAuth on the host (`<binary> login`); progress rides `pendingAuth` / `lastAuthError` on the
  capability entry, and after success a fresh turn completes. First Tree must never see or store the token.
- Real turn posture: during an authenticated turn, verify the spawned process runs from the agent workspace root with
  the canonical arguments (`-p --output-format stream-json --sandbox disabled --force`, plus `--model` only when the
  operator set one and `--resume` only with a stream-confirmed session id) — no `--trust`, `--workspace`,
  `--approve-mcps`, or prompt text in argv. A follow-up message in the same chat must resume the same Cursor session id.
- Free-form model: set an exact model id through Web (free-form input with the `auto` hint — no reasoning-effort
  control for Cursor), confirm it round-trips and reaches the next turn's spawn; an id the provider rejects must fail
  visibly as a configuration failure with no silent fallback, and recover after an explicit config change.
- Context Tree I/O: in a chat whose agent has a bound Context Tree, have the agent read a tree node via shell and edit
  a tree file; the Context tab must record repo-qualified read/write evidence for both the native edit path and the
  shell-read path (`git_status_delta` may carry the write). This is the regression slice the old prototype missed.
- Client switch: with a Cursor turn in flight, a local client switch/logout drain must detect the running
  `cursor-agent`/`agent` process (First Tree env envelope scoped) and fail closed rather than moving root state.

## Expected Result

`PASS` means the live branches above were exercised with real product evidence: an authenticated Cursor turn completed
end to end under the canonical posture, credential failure surfaced the durable notice + login action and recovered
in-product, model config round-tripped (including the visible rejection branch when available), and Context Tree I/O
evidence appeared for both edit and shell-read paths.

`FAIL` means a reproducible product issue: e.g. prompt in argv, a synthetic session id sent to `--resume`, a terminal
failure acked without a durable chat notice, silent model fallback, missing Context Tree I/O evidence, or a drain that
misses a live Cursor process.

`BLOCKED` means the CLI, account, entitlement, network, or run-cell topology (e.g. no desktop browser for OAuth)
prevented a live branch — never a product `FAIL`. `INCONCLUSIVE` means turns ran but the evidence cannot distinguish
the claimed behavior (e.g. cannot observe the spawned argv in the run cell).

## Evidence

Keep the capability snapshots (before/after install and login), the spawned process argv/cwd observation, the failing
turn's runtime notice and the login action, the session id continuity across two turns, the model config write/readback
and rejection surface, Context tab I/O rows, and the drain classification result. Redact tokens, account identifiers,
and private chat content; never copy Cursor credential files into artifacts.
