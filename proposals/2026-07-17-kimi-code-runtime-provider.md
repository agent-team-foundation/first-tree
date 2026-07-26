# Kimi Code Runtime Provider Proposal

**Status:** Implemented; local full-stack E2E passed, ref-based formal QA pending
**Date:** 2026-07-17
**Scope:** Product, runtime integration, authentication boundary, validation, and rollout

## Summary

Add **Kimi Code** as a first-class First Tree runtime provider with provider id
`kimi-code`. First Tree runs Kimi through the pinned
`@botiverse/kimi-code-sdk` package, reuses the operator's existing Kimi Code
login and configuration under `~/.kimi-code`, and translates Kimi session
events into First Tree's provider-neutral event, delivery, retry, replay-safety,
and Context Tree I/O contracts.

The first release deliberately does not add a Kimi login flow to First Tree.
Kimi's SDK exposes OAuth device authorization, while First Tree's current
runtime-auth decision permits only official browser OAuth with a localhost
callback. Operators authenticate with the official `kimi` CLI and then start
or resume Kimi agents in First Tree.

## Research Findings

### First Tree provider contract

A new provider must preserve these existing system decisions:

- One runtime provider owns an agent session; configuration is a discriminated
  union keyed by `runtimeProvider`.
- Capabilities describe runtime availability and optional version metadata.
  They are not an alternate authentication channel.
- Provider output is normalized into session events and chat delivery; terminal
  failure notices are posted before runtime acknowledgement.
- Retry, failure classification, replay safety, suspend, shutdown, and local
  runtime ownership remain provider-neutral.
- Context Tree reads and writes are reported using normalized tool file refs.
- The provider may launch local processes but must not add a host sandbox.
- Provider configuration and capability payloads remain forward/backward wire
  compatible while clients roll independently.
- First Tree runtime authentication currently supports official browser OAuth
  with a localhost callback. Device-code login is an explicitly rejected
  system path until that decision is revisited.

Cursor is the closest recent cross-surface precedent for provider registration,
configuration, capability display, UI selection, CLI creation, event
translation, Context Tree observability, and QA coverage. Kimi differs at the
execution boundary: it is an in-process SDK integration rather than a stdout
parser around a separately installed CLI.

### Raft / Slock integration practice

Raft (formerly Slock) does not integrate Kimi through ACP. It consumes the
Kimi Node SDK directly because direct sessions expose mid-session steering and
structured lifecycle events.

The Botiverse package is a pinned distribution of the official Kimi SDK with
two integration patches used by Raft:

- `roleAdditional` adds a standing system-role fragment when sessions are
  created or resumed. Kimi reapplies it after compaction, which makes it the
  correct location for First Tree's output and chat-context contracts.
- `LocalKaos.withEnv()` and `LocalKaos.withCwd()` provide session-local process
  environment and working-directory injection without mutating the daemon's
  global environment.

Version `0.26.0-botiverse.2` contains both patches and the corrected bundled
TypeScript declarations. First Tree pins this exact prerelease rather than a
range so a mirror resync cannot silently change the runtime boundary.

The public SDK surface used by this proposal is:

```text
createKimiHarness
  -> createSession / resumeSession
  -> Session.onEvent
  -> Session.prompt / cancel / close
  -> Session.getUsage

LocalKaos.create
  -> withCwd
  -> withEnv
```

Kimi events include assistant and thinking deltas, tool lifecycle events,
turn completion, usage, and stable error codes. Built-in tool names relevant to
First Tree are `Read`, `Write`, `Edit`, `Bash`, `Grep`, and `Glob`.

## Product Design

### User promise

An operator with Kimi Code already configured on the client computer can:

1. select **Kimi Code** when creating or editing an agent;
2. optionally provide an exact Kimi model id, or leave it blank to use the
   local Kimi default;
3. start and resume chats using the same First Tree workflow as other local
   providers;
4. see assistant text, thinking, tool activity, token usage, terminal failures,
   and Context Tree I/O in existing product surfaces.

### Capability and setup experience

Kimi appears as a bundled runtime because First Tree ships the SDK dependency.
It does not require a separately discoverable `kimi` executable to run.

When Kimi reports `auth.login_required` or a provider authentication error,
First Tree explains that the operator must install/run the official Kimi Code
CLI on the same client computer, execute `/login`, and retry. First Tree never
prints, copies, or stores Kimi tokens.

### Configuration

The Kimi provider configuration is intentionally narrow:

```ts
{
  kind: "kimi-code";
  model: string;
}
```

An empty model delegates model selection to the local Kimi configuration.
There is no First Tree reasoning-effort control in V1 because Kimi's thinking
configuration is provider-specific and should not be misrepresented as the
Codex/Claude control.

### Explicit non-goals

- No device-code authentication inside First Tree.
- No token import, token proxy, or cloud-side credential storage.
- No host sandbox added around Kimi tools.
- No Kimi-specific chat UI or alternate delivery path.
- No landing-trial support; landing trials remain bound to the Codex
  app-server contract.
- No per-session First Tree MCP injection until the public Kimi SDK exposes a
  supported per-session MCP configuration surface. Operator-level Kimi MCP
  configuration continues to work.

## Technical Design

### Registration and packaging

- Add `kimi-code` to the shared runtime-provider schema and runtime-config
  union.
- Add a bundled capability probe with the pinned SDK version.
- Add the exact SDK dependency to the client and CLI packaging boundary and
  externalize it in the CLI bundle, matching existing SDK packaging.
- Register a `KimiCodeHandler` in the provider registry.
- Add provider labels/defaults to CLI, server, shared, and web exhaustive maps.

### Session lifecycle

The handler prepares the same First Tree agent home, config cache, resources,
skills, `AGENTS.md` briefing, Context Tree binding, and provider environment as
other handlers.

For a new runtime session it creates a Kimi session with:

- `workDir` set to the prepared workspace;
- `permission: "yolo"`, matching First Tree's existing local autonomous agent
  execution model;
- optional `model` only when the configured value is non-empty;
- no redundant `additionalDirs` for declared source repositories or the bound
  Context Tree inside the agent workspace: `workDir` already grants access to
  those descendants, and the agent-managed repo model allows them to be absent
  until the agent materializes them. Only a configured external tree that
  already exists as a directory is supplied as an additional root;
- `roleAdditional` containing the First Tree runtime-output contract and current
  chat context;
- a session-local `LocalKaos` configured with First Tree's environment and
  working directory.

For a resumed runtime it re-derives the same validated external roots and passes
the same `roleAdditional` and `LocalKaos` so configuration changes do not
disappear across reconnects. The Kimi session id is persisted as First Tree's
provider session id. If resume succeeds but permission/model initialization
fails, the handler closes both the returned session and its harness before
propagating the error so Session Manager can retry or stop without leaking
provider resources.

Only one prompt turn runs at a time. Messages and live injects that arrive
during a turn remain in the existing First Tree ordered queue and are submitted
as the next prompt. V1 does not expose Kimi steering as a new chat semantic.

Suspend cancels an active turn, waits for it to settle, and closes the session
handle while preserving the provider session id. Shutdown additionally closes
the harness. Neither operation acknowledges queued work prematurely.

### Event translation

- Assistant deltas are buffered and emitted as one normalized
  `assistant_text` event per completed response segment.
- Thinking deltas become normalized `thinking` events.
- Tool start/progress/result events become `tool_call` lifecycle events with a
  stable tool-use id, arguments, result preview, status, and Context Tree file
  refs.
- `Read`, `Grep`, and `Glob` are replay-safe reads. `Write`, `Edit`, and
  unproven `Bash` commands mark the attempt unsafe before the side effect.
- Replay safety is monotonic within an attempt: a later read-only tool cannot
  downgrade an earlier write/unknown-tool effect back to replay-safe.
- Shell commands use the shared read-only classifier. Context Tree writes also
  receive git-status-delta evidence so writes remain observable if Kimi's tool
  payload is incomplete.
- Kimi usage maps to First Tree input/output/cache token fields.
- Kimi error codes are retained on translated errors for the shared retry and
  operator-hint classifiers.
- A successful turn emits `turn_end`, forwards delivery, completes the delivery
  token, and acknowledges only after the existing terminal condition is met.
- A failed turn uses `ProviderAttempt`, shared failure classification, retry
  policy, terminal failure notice, and replay-safety gates.

### Context Tree observability

Kimi uses capitalized built-in tool names that overlap Claude's names, so the
server must interpret them only when `runtimeProvider === "kimi-code"` (or in
the existing Claude provider set). New source values distinguish Kimi reads and
writes in observability:

- `kimi_read_tool`
- `kimi_write_tool`

`Bash` is handled by the existing shared shell-command derivation.

### Compatibility and failure handling

Old clients reject an unsupported `kimi-code` configuration cleanly. New
clients preserve unknown capability fields and continue using the current
provider routing contract. A missing bundled SDK is a client installation
failure, not an installable runtime capability.

Stable Kimi errors are mapped as follows:

| Kimi code | First Tree behavior |
|---|---|
| `auth.login_required`, `provider.auth_error` | terminal auth hint; operator logs in with official CLI |
| `provider.rate_limit` | retryable subject to shared limits before side effects; unsafe attempts stop |
| `provider.connection_error` | retryable subject to shared limits |
| `model.not_configured`, `model.config_invalid` | terminal configuration hint |
| unknown SDK/runtime error | shared unknown/fatal classification and notice |

## Test Design

### Unit tests

- Runtime schema accepts `kimi-code`, defaults model to empty, and rejects
  unsupported reasoning-effort fields.
- Capability registry reports bundled status and the pinned SDK version.
- Handler creates and resumes sessions with the expected cwd, environment,
  validated external directories, role contract, model omission/override, and
  permission mode; declared but unmaterialized in-workspace repos do not block
  SDK session creation.
- Assistant, thinking, tool, usage, error, and turn-end events translate to the
  expected normalized session events.
- Kimi reads are replay-safe; writes and unsafe shell commands are unsafe before
  retry decisions and remain unsafe even when later tools are read-only.
- Retryable Kimi errors retry only when replay-safe; terminal failures post a
  notice before acknowledgement.
- Resume permission/model initialization failures close the returned session and
  harness before propagating.
- Suspend/shutdown cancel and close the correct resources without losing the
  provider session id.
- Kimi tool refs produce Context Tree read/write events and shell commands use
  the shared classifier.
- Web and CLI provider maps render Kimi and keep provider-specific controls
  hidden.

### Repository validation

Run the repository-required gates:

```text
pnpm check
pnpm typecheck
pnpm test
```

Run focused client/shared/server/web tests while iterating, then repeat the full
gates after formatting.

### Real end-to-end validation

Use an isolated First Tree data/config directory while reusing only the host's
existing Kimi credential directory. Never print credential contents.

The live test must:

1. start the actual First Tree server and local client;
2. register the client and create a real `kimi-code` agent/chat through product
   APIs or UI;
3. send a prompt that asks Kimi to read and write a disposable file and report
   a deterministic marker;
4. observe the assistant text, tool events, usage/turn end, delivery completion,
   and persisted Kimi provider session id;
5. send a second prompt after suspend/resume and verify the same Kimi session is
   resumed;
6. confirm the disposable file content and relevant Context Tree I/O evidence;
7. retain sanitized logs and remove only test-owned temporary state.

If the host Kimi credential is expired, the test is **blocked**, not passed;
the operator-facing login recovery must still be verified. A mocked SDK test
does not count as this live gate.

### Formal QA case

Add a provider case under `packages/qa/cases/runtime/` covering capability,
configuration, live execution, resume, error recovery, Context Tree I/O, and
cleanup. Formal QA PASS requires the repository QA harness, not only the local
live smoke test.

## Rollout and Acceptance

The implementation is ready when:

- Kimi is selectable and configurable across supported product/CLI surfaces;
- the pinned SDK can execute and resume a real Kimi session through First Tree;
- all normal checks and tests pass;
- the live E2E gate passes with sanitized evidence;
- the formal QA case exists and is runnable;
- the source-backed Context Tree runtime-provider decision is updated and
  verifies successfully.

Rollout is additive and may be reverted by removing `kimi-code` from selection
while retaining persisted configuration parsing during a compatibility window.
Any future in-product Kimi login requires a separate product/security decision
that explicitly revisits the current prohibition on device-code OAuth.

## Validation Record (2026-07-17)

- `pnpm check` passed with only three pre-existing Biome warnings/info outside
  this change.
- `pnpm typecheck` passed for all seven packages and built the shared, client,
  server, and web artifacts as part of the dependency graph.
- Shared (617), Client (1599, 3 skipped), Server (2450 across 229 files), Web
  (1514), skill-evals (414), QA contract (4), and all 19 CLI test batches
  passed. After Docker Desktop recovered, the complete Server suite ran against
  its real testcontainers PostgreSQL fixture and included all 32 Context Tree
  I/O tests.
- A real authenticated Kimi handler run used the shipped SDK and the host's
  existing provider credential without reading it. Turn 1 completed
  `Write -> Read`; after suspend, turn 2 resumed the identical provider session
  id and completed `Read -> Write -> Read`. Both turns emitted assistant/tool/
  usage/turn-end events and wrote the exact disposable markers
  `FIRST_TREE_KIMI_E2E_OK` and `FIRST_TREE_KIMI_RESUME_OK`.
- A second full-stack run started an isolated Docker PostgreSQL database plus
  the built Server/Web and CLI daemon, completed dev-only HTTP authentication,
  exchanged a short connect code, registered the authenticated WebSocket
  client, created and server-push-bound a real `kimi-code` agent, and created a
  task chat through the HTTP API. Kimi returned `KIMI_E2E_OK`; the response was
  persisted as the second chat message and the daemon recorded a real provider
  session id. The provider turn completed in about 76.6 seconds.
- Packaging comparison against a clean `origin/main` worktree measured a
  4,077-byte compressed / 23,505-byte unpacked increase in the published First
  Tree CLI tarball. The externalized SDK itself is a 1,898,137-byte npm tarball
  and 8,185,165 bytes unpacked. A cold isolated install occupied about 14.6 MiB
  including transitive dependencies; this repository already supplies `zod`,
  so its practical incremental installed footprint is about 7.8 MiB plus the
  remaining small transitive packages.
- The repository-local Context Tree validator passed after the source-backed
  runtime and auth decisions were updated.
- Delivery-adversarial regressions cover unmaterialized workspace roots,
  monotonic unsafe replay across later reads, safe rate-limit retry, and cleanup
  after permission/model resume initialization failures.
- Docker is no longer a blocker. Formal QA is intentionally executed only after
  the candidate is committed; its status, tested ref, and sanitized evidence
  are run-local result-of-record artifacts rather than claims embedded here.

## Primary Sources

- Official Kimi Code repository: <https://github.com/MoonshotAI/kimi-code>
- Botiverse Kimi Code SDK mirror and integration notes:
  <https://github.com/botiverse/kimi-code-sdk>
- Published SDK package:
  <https://www.npmjs.com/package/@botiverse/kimi-code-sdk>
