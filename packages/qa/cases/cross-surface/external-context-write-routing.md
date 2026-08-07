---
id: external-context-write-routing
description: Validate connected Codex and Claude Code routing from durable or implementation-only source artifacts into the guarded external Context Tree write workflow.
areas: [cross-surface]
surfaces: [cli, codex, claude-code, server, github, gitlab]
---

# External Context Source-Artifact Write Routing

## Goal

Confirm that a connected external Codex or Claude Code session sees the
always-visible source-artifact routing contract before Skill selection. A
concrete artifact that changes a durable decision, constraint, owner, or
cross-domain relationship must route into `first-tree-write` and produce a
cross-linked draft Tree PR/MR through the existing live authority path. An
implementation-only artifact must stop with an explicit no-write decision and
must not create Tree remote state.

This case owns live provider behavior across SessionStart, Skill discovery,
source-forge publication, guarded Tree authoring, and provider artifacts.
Deterministic tests own canonical-asset projection, bundle parity, activation
envelope size, and forbidden generic Team paths; they cannot satisfy this case.

## Preconditions

- Use the formal isolated Docker plus temporary-worktree QA cell. Keep product
  source unchanged and store all run artifacts outside it.
- Bridge to supported host installations of both Codex and Claude Code with
  throwaway provider homes. Record exact provider, First Tree CLI, Plugin, and
  candidate artifact versions.
- Prepare disposable, provider-accessible source and Context Tree repositories
  for a staging Team. Use the provider-neutral setup prompt to bind an ordinary
  project directory that contains the disposable source checkout but is not
  itself required to be a repository or Team resource. Enable the external
  Plugin and verify live connected SessionStart independently for both
  providers. Also prepare a Codex pathless session for manual activation.
- Configure a current active Context Reviewer and usable forge identity so the
  official external Write preflight can succeed. Use disposable branches and
  repositories only; do not reuse production source or Tree artifacts.
- Prepare two source changes with unambiguous outcomes:
  - **durable:** changes a current cross-domain constraint or decision and has
    a clear smallest normal Tree-node target;
  - **implementation-only:** changes internal implementation without changing
    a durable decision, constraint, ownership, or cross-domain relationship.
- Capture redacted SessionStart output, Skill-load/tool traces, CLI preflight
  receipts, forge state, PR/MR bodies, and branch lists. Never retain tokens,
  private prompts, provider session credentials, or unredacted private URLs.

## Operate

Run the following matrix from fresh connected sessions:

| Provider | Durable artifact | Implementation-only artifact |
| --- | --- | --- |
| Codex | required | required |
| Claude Code | required | required |

For each provider:

1. Start inside the bound disposable project and capture the connected
   SessionStart envelope before prompting the agent. For the Codex pathless
   cell, verify SessionStart is a no-op, invoke the manual `first-tree` Skill,
   and capture its connected activation block instead.
2. Ask the session to read relevant Team Context, then implement and publish
   the assigned source change as a concrete PR/MR. Do not explicitly request a
   Tree update; the durable branch must rely on the connected standing route.
3. For the durable artifact, observe the post-publication routing decision,
   `first-tree-write` load, Double Test, target and linked-node reads, the exact
   write plan and a new user confirmation before any Tree worktree/file change, initial
   and pre-publication hidden `context write-preflight` calls, Tree verification,
   and draft Tree PR/MR creation.
4. For the implementation-only artifact, observe the routing/Double Test
   decision and inspect the Tree repository and forge after completion.
5. Inspect both source and Tree forge artifacts, cross-links, draft state,
   branch heads, and provider traces. Leave source unmerged during the draft
   assertion.
6. In the durable path only, merge the disposable source artifact through an
   authorized test operator, resume the provider session, and verify that it
   reconciles the Tree change against merged source truth before marking the
   Tree PR/MR ready. Do not merge the Tree PR/MR as part of this case.
7. Change source-repository Team-resource registration and verify that it does
   not affect Context authority. Then reset all disposable provider, project,
   source repository, Team, branch, and forge state
   before the next matrix cell.

## Observe

- Each connected envelope contains the full source-artifact routing facts:
  durable trigger, implementation-only exclusion, no-artifact gate, and
  source-first paired lifecycle. Disabled, unavailable, and needs-admin
  sessions do not receive that contract or Tree authority.
- Both providers load the same projected Write workflow after the durable
  source PR/MR exists. Provider differences are limited to provider name and
  guarded adapter mechanics; neither accepts a Team id from prompt/model input
  or falls back to a Managed workspace path.
- Before the new user confirmation, the durable path creates no authoring
  worktree, changed Tree file, branch, commit, push, or PR/MR. This gate applies
  to single-Team and multi-Team BYO sessions alike.
- After confirmation, the durable path creates exactly one Tree branch and one cross-linked draft
  Tree PR/MR from the smallest correct diff in the CLI-returned exclusive BYO
  worktree. The provider does not construct a HOME path or run `git worktree add`
  itself. It runs live preflight before
  authoring and again before every push and PR/MR creation; SessionStart alone
  is never treated as mutation authority.
- Interrupt or hide the first `write-worktree` result after the durable journal
  becomes active. Repeating the same exact confirmed command and querying
  `write-status` must return the same operation id/path without creating a
  second worktree. Repeating `write-finish` after a lost success response must
  remain a safe no-op.
- Publishing the source PR/MR is not described as automatically transferring
  permission to another repository. The observed Write intent is the standing
  classification of that concrete durable artifact.
- Before source merge, the Tree artifact remains draft. After source merge it
  is reconciled against merged source truth before becoming ready.
- The implementation-only path explains why the artifact fails the durable
  write filter and creates no Tree branch, push, PR/MR, or hidden remote
  mutation. The preceding task-scoped Tree read still occurs.
- Reviewer readiness, forge identity, exact SCOPE route receipt, immutable
  snapshot, and live authority failures remain fail-closed; no alternate Team
  or cached authority is used. Source-repository registration is not an
  authority input.
- An unfinished write journal/worktree blocks local Client switching. Finishing
  the operation removes/prunes the worktree under the same organization
  mutation lock without deleting the shared bare repository.

## Expected Result

`PASS`: all four live provider/artifact combinations satisfy the observations,
including guarded draft Tree publication for durable artifacts and zero Tree
remote mutation for implementation-only artifacts.

`FAIL`: a reproducible product defect skips durable routing, writes for an
implementation-only artifact, treats SessionStart as mutation authority,
infers another Team, bypasses live preflight/Reviewer/forge identity, loses
draft/source-first ordering, or produces provider-divergent policy behavior.

`BLOCKED`: either real provider bridge, staging Team binding, disposable forge
repositories, current Reviewer, provider identity, or complete isolated
product harness cannot be prepared.

`INCONCLUSIVE`: only source, unit tests, mocks, generated bundle inspection, or
an incomplete subset of the four live matrix cells was observed.

## Evidence

Keep the exact target commit and built artifact digests; provider, CLI, and
Plugin versions; redacted connected SessionStart envelopes; Skill-load and
adapter command traces; source and Tree PR/MR URLs and bodies; draft/ready
transitions; cross-links; before/after branch lists; redacted initial and
pre-publication preflight receipts; Tree verification output; and reset logs.
Store all evidence in the temporary QA run directory outside the product
repository.
