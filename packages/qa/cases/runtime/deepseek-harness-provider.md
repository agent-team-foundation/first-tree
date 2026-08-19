---
id: deepseek-harness-provider
description: Validate the DeepSeek Harness JSON-RPC runtime provider end to end — bundled npm runtime, host-local DEEPSEEK_API_KEY auth, model id, managed skills, resume, and Context Tree I/O.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# DeepSeek Harness Runtime Provider

## Goal

Confirm that an agent bound to the `deepseek-harness` provider runs real turns through the bundled
`dsh-jsonrpc-agent` subprocess driven by `@deepseek-ai/dsh-sdk-client`, with First Tree–owned
`cordis.yml`, host-local `DEEPSEEK_API_KEY` auth (no Connect / pendingAuth), managed skills under
`.agents/skills`, session persistence under `.first-tree/deepseek-harness-sessions`, and resume via harness
`sessionId`. Deterministic parser/handler behavior is covered by product tests; this case validates
the live judgment slices those tests cannot prove.

Use this case when the DeepSeek handler, binary resolver, capability probe, cordis template,
runtime-auth dispatch, model surface, or provider selection surfaces change. Pair it with the
runtime-provider readiness case when the same run must also prove that existing Claude Code / Codex /
Cursor agents on the client keep probing, binding, and completing turns.

## Intended QA scope

- **Focused** (default for this feature PR): capability install branches available in the run cell,
  one authenticated two-turn chat (new session + resume), free-form model round-trip, managed MCP
  fail-closed rejection when configured, and observation that cancel closes the harness subprocess.
  Context Tree I/O when the run cell can observe env/cwd.
- **Full** (release / major-feature request): everything in focused, plus Windows fail-closed
  admission (Job Object message, no install invite), in-flight client switch/logout drain against a
  live `dsh-jsonrpc-agent` process, and credential failure notice without retained key material.

Running this case remains human-requested; it is not a CI gate.

## Preconditions

- Run in the isolated QA run cell selected by the plan (Docker + temporary git worktree; never the operator checkout).
- The run cell host has the pinned DeepSeek Harness npm packages available to the First Tree client
  (the full `@deepseek-ai/*` closure: `dsh-sdk-jsonrpc-demo`, Cordis plugins, and SDK client). The
  portable CLI ships them via `bundleDependencies`; if they are absent from `node_modules`, exercise
  only the install-hint branch and mark live branches `BLOCKED`.
- A DeepSeek API key the run may use on that host (`DEEPSEEK_API_KEY`). Key state is host-scoped; do
  not copy credential files between users or machines.
- Use disposable source and Context Tree fixtures. Provider tool calls must not modify the product checkout.
- Windows acceptance requires the product Job Object supervisor. Until it exists, the Windows branch must
  fail closed at capability (before install detection) and cannot PASS live DeepSeek turns.

## Checklist

- Capability: with the bundled runtime absent, the computer card shows setup-incomplete for DeepSeek with
  npm install guidance for the pinned jsonrpc demo package and `DEEPSEEK_API_KEY` setup copy; after
  installing and re-probing, the entry turns `ok` with a bundled runtime source. Detection must never
  launch the binary or judge login state. On Windows V1, capability stays unavailable with the Job Object
  message even when packages are not installed (no npm install invite).
- Provider selection: a new agent can be created on `deepseek-harness` only when the bound client advertises it;
  afterwards the provider changes only via the explicit runtime-switch flow. Web exposes a free-form model
  id with unset defaulting to `deepseek-v4-flash`.
- Auth recovery: with `DEEPSEEK_API_KEY` unset, a real turn fails as a credential failure; the chat surfaces
  a durable runtime notice directing the operator to set `DEEPSEEK_API_KEY` before the delivery is acked.
  First Tree must never offer in-product OAuth Connect for DeepSeek and must not copy API key material into
  durable error events or runtime notices.
- Managed MCP fail-closed: configuring any managed MCP server must fail closed as configuration with a
  clear message — DeepSeek V1 does not pretend to support managed MCP.
- Real turn posture: during an authenticated turn, verify the client spawns `dsh-jsonrpc-agent` with First
  Tree's bundled `cordis.yml`, cwd at the agent workspace, env including `DSH_SESSION_ROOT` under
  `.first-tree/deepseek-harness-sessions`, `DSH_SKILLS_ROOT=.agents/skills`, and `DEEPSEEK_API_KEY` injected via
  child env. Prompt text rides the SDK only, never argv. A follow-up in the same chat must resume with the
  prior harness `sessionId` (never a synthetic `deepseek-harness-pending-*` id sent to persistence).
- Cancel: operator stop or client switch drain must close/kill the harness subprocess (no wire cancel).
- Context Tree I/O: in a chat whose agent has a bound Context Tree, have the agent read a tree node via
  shell and edit a tree file; the Context tab must record repo-qualified read/write evidence when observable.

## Expected Result

`PASS` means the live branches above were exercised with real product evidence: an authenticated DeepSeek
turn completed under the canonical posture, resume reused a real session id, credential failure surfaced
the durable notice without retained key material, managed MCP configuration failed closed visibly, cancel
closed the subprocess, and Context Tree I/O evidence appeared when the run cell could observe it.

`FAIL` means a reproducible product issue: e.g. prompt or API key in argv, a synthetic session id written
to persistence, managed MCP silently ignored, terminal failure acked without a durable chat notice, or a
drain that misses a live `dsh-jsonrpc-agent` process.

`BLOCKED` means packages, API key, network, Windows Job supervisor, or run-cell topology prevented a live
branch — never a product `FAIL`. `INCONCLUSIVE` means turns ran but the evidence cannot distinguish the
claimed behavior.

## Evidence

Keep sanitized capability snapshots (before/after install), spawned command/cwd/env observations,
session id continuity across two turns, model config write/readback, MCP fail-closed surface, credential
notice with secrets redacted, Context tab I/O rows, and the drain classification result. Redact API keys,
account identifiers, and private chat content; never copy credential files into artifacts.
