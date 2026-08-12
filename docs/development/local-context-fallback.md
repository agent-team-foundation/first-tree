# Local Context Fallback

> Status: draft design proposal. This document records the current decisions
> and the questions that must be resolved before implementation.

## Decided rules

1. **Fallback only.** Local Context exists only for a Team that has no online
   Context Tree repository configured. A configured online binding remains the
   canonical Team Context Tree.
2. **Team-wide on one local Client.** Agents for the same Team, running under
   the same active First Tree Client on one computer, read and write one shared
   directory. The directory is keyed by immutable Team ID, never Team or Agent
   display name.
3. **Isolation remains.** Different Teams, local Clients, and computers do not
   share Local Context. V0 does not synchronize files across computers.
4. **One directly shared mutable tree.** V0 does not maintain revisions,
   snapshots, persistent proposals, an event history, automatic merges, or
   rollback data. Agent workspaces reference the same canonical directory
   rather than receiving per-Agent copies.
5. **No Git dependency.** Creating, reading, validating, and updating Local
   Context must work when `git` is not installed. Git detection and installation
   are deferred to a separate design discussion.
6. **Keep the Context Tree content model, not its Git storage backend.** The
   directory contains ordinary Context Tree files (`NODE.md`, domain nodes,
   leaves, and `members/`) and must pass the existing structural validator.
   This keeps later import into an online repository a file-level operation
   rather than a content conversion.
7. **Human approval still gates shared truth.** An Agent must receive explicit
   human approval for the intended Context Tree change before it mutates the
   shared directory. A local draft or chat suggestion is not active Context.
8. **Client-local lifecycle.** Local Context moves with the active local Client
   during Client switching, is restored with that Client on the same computer,
   and is removed by `computer reset`. It is not server persistence.
9. **No database change in V0.** The fallback uses local filesystem state and
   the existing Team identity and binding response. It does not add a server
   table, migration, queue, or approval record.

## Open questions

| Question | Recommended V0 default |
| --- | --- |
| What is the final filesystem path? | Use `$FIRST_TREE_HOME/data/local-context/<teamId>/` as the tree root. Keep locks and temporary files outside that root so a later import copies only Context Tree content. |
| How does an Agent workspace reference a tree outside the workspace? | Extend the trusted generated workspace binding with an explicit local-tree mode and absolute runtime-owned path. Do not infer the path and do not depend on a symlink whose cross-platform behavior differs. |
| What happens when the binding request is unavailable or invalid? | Distinguish `bound`, authoritative `unbound`, and `unknown`. Never create Local Context from `unknown`. Whether an existing local tree remains writable or becomes read-only during `unknown` is still a product decision; read-only is the safer default against split-brain. |
| What is the minimum concurrency contract? | Use one short-lived, Team-scoped writer lock plus precondition hashes for touched files. Decide whether readers must also take a shared lock for multi-file consistency. |
| What happens if a process exits during a multi-file update? | Do not introduce history or a transaction journal in V0. Validate a temporary candidate before mutation, use atomic replacement per file, and let `doctor` detect an invalid final tree for manual repair. This accepts a small crash window. |
| How is Local Context promoted after an online binding appears? | Stop local writes, keep the directory intact, and present an explicit import/diff workflow. Never copy, merge, archive, or delete it silently. |
| How strongly should approval be enforced? | Reuse tracked Chat approval and Agent workflow rules in V0. A runtime-verifiable approval receipt would require a separate server-side design and is out of scope. |

## Problem

First Tree currently treats a Context Tree as an optional online Git repository.
When a Team has not configured that repository, its Agents start without shared
durable context. Keeping separate notes in each Agent workspace does not solve
the problem: Agents on the same Team would diverge and later tasks would not
know which copy to trust.

Local Context is a temporary, computer-local bridge for that unbound state. It
provides one shared Context Tree directory without making Git, a forge account,
or cross-device synchronization an onboarding prerequisite.

## Goals

- Let a Team's local Agents share durable Context when `git` is unavailable.
- Preserve the ordinary Context Tree file and validation model.
- Keep the implementation smaller than a local version-control system.
- Prevent obvious cross-Team access and silent concurrent overwrites.
- Make later migration to an online Context Tree explicit and reviewable.

## Non-goals

- Git history, branches, commits, merges, or a Git-compatible object model.
- Automatic conflict resolution or rollback.
- Cross-computer or cross-user synchronization.
- Replacing an online Context Tree binding.
- Strong isolation between processes running as the same operating-system user.
- Server-side persistence or a new database-backed approval workflow.
- Installing or managing Git.

## Storage model

The proposed canonical tree is a direct child of Client-owned data:

```text
$FIRST_TREE_HOME/
├── data/
│   └── local-context/
│       ├── <team-id-a>/          # Context Tree root for Team A
│       │   ├── NODE.md
│       │   ├── members/
│       │   └── <domain>/
│       └── <team-id-b>/          # independent Context Tree root for Team B
└── state/
    └── local-context/
        ├── <team-id-a>.lock      # runtime coordination, not tree content
        └── <team-id-b>.lock
```

The path is global relative to Agent workspaces, not global across Teams or
local Clients. Every Agent receives the path from trusted runtime state derived
from its own Team identity. User input, display names, repository names, and the
current user's default Team must not select the directory.

No runtime marker, lock, temporary candidate, or approval record belongs inside
the Context Tree root. This keeps the root directly portable to a future Git
repository and prevents operational files from appearing as durable context.

Recommended permissions are owner-only for the Local Context and state roots.
This protects against other operating-system users; it does not isolate Agents
that intentionally share the same local Client account.

## Mode resolution

Binding resolution must stop collapsing all non-bound outcomes into `null`.
The runtime needs three explicit results:

| Result | Meaning | Local behavior |
| --- | --- | --- |
| `bound` | The server returned a valid Team Context Tree binding. | Use the online tree. Do not initialize or mutate Local Context. |
| `unbound` | The server authoritatively returned no repository for this Team. | Create the Team directory lazily if needed and use Local Context. |
| `unknown` | The request failed or the response was invalid. | Do not create a new local tree. Behavior for an existing local tree remains an open question. |

Once a runtime successfully observes `bound`, it must not fall back to Local
Context merely because a later request fails. Doing so would create two
simultaneously writable sources of truth.

## Workspace integration

The global directory is canonical. A per-Agent workspace must not clone or
copy it. The generated binding and briefing should tell Context-aware tooling:

- the mode is `local` rather than `git`;
- the Team ID from which the path was derived;
- the absolute runtime-owned tree path; and
- that Git pull, branch, worktree, and forge workflows do not apply.

The current `workspace.json` schema accepts only an immediate tree subdirectory
and intentionally contains no tree mode. The implementation therefore needs an
explicit contract change rather than disguising the global directory as an
ordinary per-Agent Git checkout. The exact shape is an open question above.

## Read flow

1. Resolve the Agent's Team-scoped binding state.
2. Select Local Context only after an authoritative `unbound` result.
3. Resolve and containment-check the Team directory from trusted runtime state.
4. Read the same directory used by every local Agent for that Team.
5. Validate the tree when it is first initialized, after a write, and from
   `doctor` when diagnosing local state.

`tree verify --tree-path` already validates a filesystem directory without
requiring it to be a Git checkout. `tree tree`, however, currently discovers
its root through Git and reports branch information. Local mode needs an
explicit filesystem-root input that skips both Git-root discovery and pull or
branch behavior.

## Write flow

The write path remains deliberately small and does not create persistent local
versions:

1. Read the intended target files and retain their content hashes in the
   active task.
2. Show the human the exact intended change and obtain explicit approval.
3. Build the approved change in a disposable temporary copy and run the
   ordinary Context Tree validator against it.
4. Acquire the Team-scoped writer lock.
5. Re-read the touched files. If any precondition hash changed while approval
   was pending, release the lock and require a new diff and approval.
6. Replace changed files using temporary sibling files and atomic rename. File
   additions and removals happen under the same lock.
7. Verify the shared tree, release the lock, and delete the disposable copy.

Waiting for a human must never hold the writer lock. The lock prevents two
Agents from writing simultaneously; precondition hashes prevent an older
approved change from silently overwriting a newer one.

If readers must never observe the middle of a multi-file update, all local tree
read commands must cooperate with a shared/exclusive lock. Whether V0 accepts
that additional locking is an open question. Without it, every individual file
replacement is atomic, but a reader can briefly observe a mixture of old and
new files.

## Failure and recovery behavior

| Condition | Behavior |
| --- | --- |
| Git is absent | No effect in Local mode; no Git command is invoked. |
| Team directory is missing after authoritative `unbound` | Create the minimal approved tree scaffold lazily. |
| Local tree fails validation before a write | Refuse the write and direct the operator to `doctor` or manual repair. |
| A touched file changed while approval was pending | Refuse the stale write and produce a new diff. |
| Another writer holds the Team lock | Wait for a bounded period or fail with a retryable message; never bypass the lock. |
| Process exits before replacement starts | The canonical directory is unchanged; remove abandoned temporary files later. |
| Process exits during a multi-file replacement | V0 may leave a structurally invalid tree. `doctor` detects it and requires manual repair; there is no automatic rollback. |
| Online binding appears | Stop local writes and enter the explicit migration handoff. |
| Binding state is `unknown` | Never initialize Local Context; existing-tree behavior remains pending. |

## Online migration boundary

The online binding remains Team authority. After it is observed:

1. Stop new Local Context writes.
2. Keep the local directory unchanged and clearly marked as local-only in the
   product surface.
3. Compare the directory with the online tree through an explicit migration
   workflow when Git support is available.
4. Let a human review and approve the resulting online change.
5. Retain or remove the local directory only through an explicit operator
   action after the online result is confirmed.

V0 does not define the Git installation path or implement this import. It only
preserves a clean standard tree directory so that the later workflow has a
well-defined input.

## Client lifecycle integration

`data/local-context` is local Client state. Client switching must park and
restore it in the same transaction boundary as workspaces and other Context
state. A switch must not move the directory while a Local Context write lock is
held. `computer reset` removes it with the rest of local Client state and must
report that the unsynchronized Context will be lost.

First Tree never copies the directory to another computer implicitly.

## Current implementation gaps

The following existing contracts need revision before this design can ship:

- [`resolveAgentContextTreeBinding`](../../packages/client/src/runtime/bootstrap.ts)
  returns the same `null` result for an authoritative unbound response, an
  invalid response, and a request failure.
- [`workspace.json`](../../packages/shared/src/schemas/workspace-manifest.ts)
  names only an immediate tree subdirectory and has no local tree mode or
  external runtime-owned path.
- managed bootstrap writes a workspace tree binding only when an online
  binding resolves.
- the [generated Agent briefing](../../packages/client/src/runtime/templates/agent-briefing.ejs)
  assumes an Agent-managed Git checkout at `<workspace>/context-tree`.
- [`tree tree`](../../apps/cli/src/commands/tree/tree.ts) requires a Git root
  even with `--no-pull`; only
  [`tree verify --tree-path`](../../apps/cli/src/commands/tree/verify.ts)
  already accepts a plain directory.
- [Client switching](../../apps/cli/src/core/client-switch.ts) currently moves
  `data/workspaces` and `data/byo`, but not a `data/local-context` root.
- the read and write Skills assume Git freshness, branches, and reviewable
  forge changes; they need a local-mode path that preserves human approval
  without pretending a Git workflow exists.

## Acceptance criteria

V0 is complete only when all of the following hold:

- A clean machine without Git can initialize, read, validate, and update Local
  Context after an authoritative unbound result.
- Two Agents for the same Team and Client resolve the same canonical directory
  and observe each other's approved changes.
- Agents from different Teams never resolve the same directory.
- A binding request failure does not create a local tree.
- A configured online binding prevents Local Context mutation.
- Two concurrent writers cannot silently overwrite one another.
- Validation failure prevents a planned write from starting.
- `tree tree` and `tree verify` work against the Local Context path without
  invoking Git.
- Client switch parks and restores the directory; `computer reset` removes it
  with an explicit data-loss warning.
- No database migration or server-side persistence is added.

## Deferred work

- Git capability detection and installation guidance.
- Importing Local Context into a new or existing online Context Tree.
- Cross-computer synchronization.
- Durable version history, rollback, merge support, or crash journals.
- Runtime-verifiable approval receipts.
