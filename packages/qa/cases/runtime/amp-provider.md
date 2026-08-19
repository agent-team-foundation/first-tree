---
id: amp-provider
description: Validate the Amp CLI runtime provider end to end — private per-turn settings, host-local auth, mode, managed MCP isolation, resume, and Context Tree I/O.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# Amp Runtime Provider

## Goal

Confirm that an agent bound to the `amp` provider runs real turns through the external Amp CLI with the canonical
runtime posture (private threads, no remote-control terminal, prompt on stdin, MCP/permissions via a per-turn
runtime-owned settings file), that credential and configuration failures surface through existing recovery paths, and
that cross-surface behavior (capability cards, managed MCP, Amp mode, client switch, Context Tree I/O) matches the
shipped contract. Deterministic parser/handler behavior is covered by product tests; this case validates the live
judgment slices those tests cannot prove.

Use this case when the Amp handler, binary resolver, capability probe, runtime-auth dispatch, settings projection, mode
surface, or provider selection surfaces change. Pair it with the runtime-provider readiness case when the same run must
also prove that existing Claude Code / Codex / Cursor agents on the client keep probing, binding, and completing turns.

## Intended QA scope

- **Focused** (default for this feature PR): capability install/login branches available in the run cell, one
  authenticated two-turn Amp chat (new thread + resume), mode round-trip or rejection, managed MCP add then remove on
  consecutive turns, and observation that concurrent same-agent turns keep distinct settings pathnames across an MCP
  config change. Context Tree I/O and client-drain when the run cell can observe argv/process trees.
- **Full** (release / major-feature request): everything in focused, plus Windows fail-closed admission (Job Object
  message, no install invite), in-flight client switch/logout drain against a live Amp process, and remote HTTP/SSE MCP
  header projection without leaking secrets into argv/logs/evidence.

Running this case remains human-requested; it is not a CI gate.

## Preconditions

- Run in the isolated QA run cell selected by the plan (Docker + temporary git worktree; never the operator checkout).
- The run cell host has the official Amp CLI installed (`amp`, via Amp's published installer); First Tree must not
  bundle, download, or install it for you — if it is absent, exercise only the install-hint branch and mark live
  branches `BLOCKED`.
- An Amp account the run may authenticate on that host (`amp login` / host `AMP_API_KEY`). Login state is
  host-OS-user-scoped; do not copy credential files between users or machines, and do not archive Amp tokens.
- Use disposable source, MCP, and Context Tree fixtures. Provider tool calls must not modify the product checkout.
- Windows acceptance requires the product Job Object supervisor. Until it exists, the Windows branch must fail closed
  at capability (before install detection) and cannot PASS live Amp turns.

## Checklist

- Capability: with the CLI absent, the computer card shows setup-incomplete for Amp with the official installer
  guidance and no npm install copy; after installing and re-probing, the entry turns `ok` with a path runtime source.
  Detection must never launch the binary or judge login state. On Windows V1, capability stays unavailable with the Job
  Object message even when Amp is not installed (no `install.sh` invite).
- Provider selection: a new agent can be created on `amp` only when the bound client advertises it; afterwards the
  provider changes only via the explicit runtime-switch flow. Web exposes Amp modes (`(unset)`, `low`, `medium`,
  `high`, `ultra`) rather than free-form model ids.
- Auth recovery: with the CLI logged out, a real turn fails as a credential failure; the chat surfaces a durable
  runtime notice directing the operator to `amp login` / `AMP_API_KEY` before the delivery is acked. First Tree must
  never offer an in-product Amp OAuth Connect button, must never see or store the token, and must not copy Amp login
  URLs or one-time query material into durable error events or runtime notices.
- Real turn posture: during an authenticated turn, verify the spawned process runs from the agent workspace root with
  `amp --execute --stream-json --stream-json-thinking --no-remote-control-terminal --settings-file <unique-path>` plus
  `--visibility private` on new threads and `--mode <value>` only when configured — prompt text on stdin only, never in
  argv. Child env forces `AMP_REMOTE_CONTROL_TERMINAL=0`. A follow-up in the same chat must resume with
  `amp threads continue <T-uuid> …` using the stream-confirmed session id (never a synthetic `amp-pending-*` id; no
  `--visibility` on continue).
- Per-turn settings isolation: each turn's `--settings-file` is a unique mode-0600 path under the shared agent home
  (not a single shared `amp-runtime-settings.json`). While turn A is still running, a concurrent same-agent turn B
  (or a mid-flight MCP config transition that starts B) must not replace A's file contents — observe distinct pathnames
  and that A's snapshot still matches the payload used at A's spawn. After the child closes, the turn's settings file
  is removed. Secret MCP headers appear only inside that file, never on argv or in retained evidence.
- Managed MCP: configure a disposable local MCP server through First Tree, confirm the authenticated Amp turn can call
  one of its tools, then remove all managed servers for the next turn so the settings snapshot no longer lists them.
  Exercise remote HTTP/SSE mapping when suitable disposable endpoints are available. Do not inspect or archive literal
  secret headers.
- Amp mode: set `low` / `medium` / `high` / `ultra` through Web, confirm round-trip and that the next turn's argv carries
  `--mode <value>`; clearing mode omits `--mode`. An invalid leftover model id must fail closed as a configuration
  failure without spawning `--model` and without silent fallback.
- Context Tree I/O: in a chat whose agent has a bound Context Tree, have the agent read a tree node via shell and edit
  a tree file; the Context tab must record repo-qualified read/write evidence (`git_status_delta` may carry the write).
- Client switch: with an Amp turn in flight, a local client switch/logout drain must detect the running `amp` process
  (First Tree env envelope scoped) and fail closed rather than moving root state.

## Expected Result

`PASS` means the live branches above were exercised with real product evidence: an authenticated Amp turn completed
under the canonical posture, resume used a real `T-…` id, credential failure surfaced the durable notice without a
Connect button, managed MCP add/remove applied on consecutive turns, concurrent same-agent turns kept distinct
settings snapshots across an MCP config change, mode round-tripped (or rejected visibly), and Context Tree I/O /
drain evidence appeared when the run cell could observe them.

`FAIL` means a reproducible product issue: e.g. prompt or MCP secrets in argv, a shared settings pathname rewritten
under a live child, a synthetic session id sent to `threads continue`, remote-control terminal left enabled, silent
mode/model fallback, terminal failure acked without a durable chat notice, missing Context Tree I/O evidence, or a
drain that misses a live Amp process.

`BLOCKED` means the CLI, account, entitlement, network, Windows Job supervisor, or run-cell topology prevented a live
branch — never a product `FAIL`. `INCONCLUSIVE` means turns ran but the evidence cannot distinguish the claimed
behavior (e.g. cannot observe the spawned argv or settings pathnames in the run cell).

## Evidence

Keep sanitized capability snapshots (before/after install and login), spawned argv/cwd observations including the
unique `--settings-file` pathnames for concurrent turns, session id continuity across two turns, mode config
write/readback and rejection surface, sanitized settings shape/file mode with secrets redacted, MCP tool-call events,
Context tab I/O rows, and the drain classification result. Redact tokens, headers, account identifiers, and private
chat content; never copy Amp credential files into artifacts.
