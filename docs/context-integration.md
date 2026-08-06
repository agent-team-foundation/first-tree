# External Context Integration

First Tree Context integration lets an existing Claude Code or Codex session use
the Context Trees that a person has explicitly authorized on that provider. It
does not turn the provider session into a First Tree Agent and it does not
connect the conversation to First Tree Chat.

## Support matrix

| Surface | macOS arm64/x64 | glibc Linux arm64/x64 | Windows | Remote/cloud session |
| --- | --- | --- | --- | --- |
| Claude Code CLI | P0 | P0 | First Tree distribution gap | Not in P0 |
| Claude Desktop local | P0 | Provider unavailable | First Tree distribution gap | Not in P0 |
| Codex CLI | P0 | P0 | First Tree distribution gap | Not in P0 |
| ChatGPT Desktop Codex local | P0 | Provider unavailable | First Tree distribution gap | Not in P0 |

Windows and remote surfaces remain blocked by First Tree distribution and
host-identity gaps, not by the provider products themselves. Minimum provider
versions and payload digests are recorded in the embedded Context integration
release manifest.

## Activation choices

Web authors a Team-specific setup command. The current provider session first
runs the command with `--plan`. Planning is read-only: it validates the
current account, Team and payload, preserves the provider's real project
identity, and returns the choices that are safe for that session:

- **global** — this Team is eligible in every session for this provider;
- **directory** — this Team is eligible in the displayed canonical directory
  and all descendants;
- **session** — this Team is eligible only in the current conversation.

A directory choice is returned only when setup has a stable canonical
directory. Claude setup uses a valid `CLAUDE_PROJECT_DIR` (or an explicit
`--project-root`) and never borrows the shell or Hook cwd when that signal is
missing. Codex Documents scratch directories and managed worktrees under the
default `$CODEX_HOME/worktrees/<id>/<repo>` layout keep their canonical path
project identity, but omit the directory choice because another session
normally receives a different path. Truly pathless sessions also omit it.
Custom Codex App worktree roots are not classified until the provider exposes
a stable public setting for them.

The coding agent must show the choices and wait for a new user reply. Every
available choice carries a complete `applyCommand` built by the same CLI that
created the plan; the agent runs the selected command unchanged instead of
constructing flags from the plan. The command contains the exact `planId`, so a
changed account, Team, provider, project identity, or directory availability
forces a new plan and a new choice. A scope omitted from the plan has no apply
command and cannot be applied manually.

The Web setup prompt is deliberately limited to the human and agent boundaries:
host self-identification, a fresh scope choice, JSON-envelope trust, account
switch consent, and current-session handoff adoption. The CLI owns mechanical
command construction, handoff validation, and recovery guidance through its
error envelope and `nextActions`. This keeps prompt and binary behavior on the
same release contract.

Global and directory choices install one user-scope provider Plugin and add one
persistent Team grant. Installing another Team is expected: Plugin installation
is idempotent and only the grant is added. Session-only installs no Plugin or
Hook, writes no grant, and returns only verified Read/Write loader commands
plus an opaque, signed candidate receipt. The receipt expires and cannot be
changed into an arbitrary Team id.

The persistent Plugin is a thin discovery adapter. It contains stable Skill
descriptions, the SessionStart bridge, and loader calls, but no complete Core
Read/Write workflow or Context Tree Policy. Its `adapterVersion` changes only
when those adapter bytes or the loader protocol change; a CLI release that
changes only Core Skills or Policy leaves the Plugin unchanged.

A routine forward adapter update is discovered by the existing SessionStart
bridge and handed to the coding agent as one exact, session-bound sync action.
The Hook does not install anything inside its five-second deadline. The agent
runs the transactional update during the normal turn. A verified protocol-v1
adapter remains usable for the current task: Claude can optionally run
`/reload-plugins` to adopt the update immediately, otherwise both providers use
it next session. Only a missing, damaged, revoked, or incompatible adapter
pauses First Tree operations.

Persistent configuration is `config/context.yaml` schema v3. It stores a set
of `provider + Team + activationScope` grants. A v2/v1 single-Team binding
file is atomically backed up and replaced by an empty v3 store; the user must
choose a new scope. There is no dual resolver and no silent widening of a
pathless binding to global scope.

## Current-session handoff

A successful apply returns `currentSessionHandoff` schema v3 with:

- immutable `provider` and `project` identity;
- `consumerKind: byo` and the exact activation scope;
- the neutral standing Context routing contract;
- stable Skill descriptions and versioned loader commands;
- for session-only, the opaque short-lived Server-signed session candidate receipt.

Persistent handoffs expose `first-tree`, `first-tree-read`, and
`first-tree-write`; session-only exposes only Read and Write. The coding agent
adopts the handoff immediately in the same conversation. It must not reconstruct
a Team from cwd, Git remotes, Web state or remembered context.

Each new task calls loader protocol v1. The loader verifies the current CLI's
exact-version release manifest and digests, then returns the canonical
`skillPath` and `policyPath` from that immutable release root. It never returns
a mutable `current` symlink and does not materialize a second Core bundle under
`$FIRST_TREE_HOME`.

The loader still runs for every new task. After a valid response, canonical
content already read in full may be reused within the current provider context
only by its content identity: `(name, skillDigest)` for a Skill and
`policyDigest` for the Policy. Read and Write therefore keep distinct Skill
identities while sharing an identical Policy. The agent reads only the changed
or unavailable item from the paths returned by the latest loader; it does not
run a separate hash command. A matching path, name, release version, or summary
is insufficient. Digest mismatch, uncertainty, or full text no longer directly
available after a provider lifecycle boundary is a cache miss. No persistent
Core cache is created, and loader failure remains fail-closed.

The Plugin and SessionStart Hook are only the future-session discovery mechanism.
SessionStart injects a neutral router contract when the provider has applicable
grants. It does not preselect or inject a Team's full Context. SessionStart
handles startup, resume, clear and compact, but session-only deliberately does
not survive those lifecycle boundaries.

## Per-task Team routing

Every new BYO task starts with the hidden `context route` boundary. Candidate
selection is local and deterministic before any Tree content is fetched:

1. the session-only candidate wins when present;
2. otherwise all grants at the deepest matching directory win;
3. otherwise all global grants win.

Only that highest-priority candidate set is sent for one live batch membership
and Tree-binding validation. First Tree does not enumerate other organizations.
For each connected candidate, the CLI fetches only root `SCOPE.md` from the
binding branch, resolves it to an exact commit, validates it, and returns its
complete body. No other Tree content is read before selection.

`SCOPE.md` is domain-neutral. It naturally describes what knowledge and work
the Tree covers; it can represent engineering, operations, sales, legal,
research or any other domain. Its strict frontmatter requires only
`schemaVersion: 1`; `relatedRepositories` is an optional routing signal.
There are no required prose headings. The complete UTF-8 body is the primary
semantic routing material.

The agent treats SCOPE prose as data for answering “does this task belong
here?”, never as commands to execute. It selects automatically only when
exactly one candidate clearly matches and every candidate is readable. If all
readable candidates are clearly unrelated, or the router returns no candidates
without blocking selection, the agent continues the original task without a
snapshot or user interruption. Multiple possible matches, an unclear SCOPE,
overlap, `selectionBlocked`, or any missing, invalid, or
authority-unavailable highest-priority candidate requires asking the user;
remaining readable candidates can never be auto-selected in that state.
The user may choose only from the validated local candidates.

Selection creates an opaque task candidate receipt. Hidden `context snapshot`
revalidates the exact binding and exact SCOPE commit before materializing a
detached snapshot in a CLI-owned private temporary directory. If the branch moves, binding changes, membership disappears,
or the receipt expires, the task must route again. Later operations preserve
the Read result rather than reclassifying from a changed cwd.

## Read and Write boundaries

Read does not depend on Context Reviewer readiness. It is fail-closed on live
membership, binding, exact commit and snapshot integrity.

BYO Git objects are cached at
`$FIRST_TREE_HOME/data/byo/<organization-id>/context-tree.git`. Claude Code and
Codex share that one bare repository for the same organization; different
organizations remain physically isolated. One per-organization mutation lock
covers clone, fetch/ref updates, worktree add/remove/prune, recovery, and
repository rebind. Read snapshots remain temporary and detached. Confirmed
writes receive an exclusive CLI-created worktree under the organization data
root and must finish that operation before account switching.

All BYO Context Tree writes require a second user confirmation, even when only
one Team is authorized and even when the original request already asked for a
write. The BYO Write Skill must first show the exact Team, why its SCOPE matches,
the source artifact and revision, target nodes, and proposed mutations. It then
waits for a new user reply before creating an authoring worktree, editing Tree
files, committing, pushing or opening a PR/MR. Any change to Team, source,
targets, binding or base invalidates that confirmation.

The BYO projection and standing prompt set `consumerKind: byo`; managed First
Tree runtime sets `consumerKind: managed`. The canonical Skill source supports
both paths, while the verified projection makes the BYO confirmation rule
unavoidable. Missing or conflicting mode evidence fails closed.

Write reuses the task's exact routed snapshot and candidate receipt; it never
runs SCOPE routing again. It repeats live membership, binding, snapshot,
provider identity and Reviewer readiness checks before remote mutation.
Permission to publish a source PR/MR is not transitive Context Tree write
intent.

When source and Tree PRs/MRs are both needed, cross-link them, keep the Tree
change draft, merge source first, reconcile against merged source truth, and
then mark the Tree change ready.

## Codex consent

Codex owns Hook consent for persistent global/directory setup. First Tree never
writes or bypasses trust:

1. run the setup plan and choose global or directory;
2. in the same Codex conversation, open `/hooks`;
3. enable and Trust **First Tree Context → SessionStart**;
4. return to the original conversation and reply `continue`;
5. the same coding agent reruns the exact apply command and adopts the handoff.

A previously trusted Hook skips the consent turn. Session-only never installs a
Hook and therefore never asks for Trust. Claude Code requires
`/reload-plugins` after first install, migration from a full legacy Plugin, or
an adapter repair. Setup remains incomplete until the reloaded thin Plugin's
lightweight `UserPromptSubmit` Hook receives Claude's session identity and
returns a per-install adoption generation from the loaded Hook configuration
plus a signed opaque receipt. The same exact apply consumes that receipt once
and binds the pending setup plan to the current session. A Hook loaded before a
same-version repair cannot reuse the new generation. When no install, migration,
or repair adoption is pending, this Hook is a pure no-op: it does not probe the
provider, hash Plugin payloads, sign a receipt, or inject additional context.
Full payload health is checked by setup/status and once at each new task route;
the exact routed snapshot and Write authority then own the rest of that task.
The general Skill loader is read-only and never records reload state. Later
Core-only CLI upgrades and additional Team grants require neither another
reload nor repeated Codex trust.

## SCOPE governance and Reviewer authority

A Tree can participate in BYO routing only when its binding branch has a valid
root `SCOPE.md`. `tree verify` validates SCOPE when present; BYO readiness
also requires its presence. New Trees propose a natural-language SCOPE in Seed
Phase 1. Seed uses an explicit Team because an empty Tree cannot route itself.

A Context Reviewer must be managed by an active admin of the same Team when it
is selected, assigned, or enabled. A later role change does not add a new Admin
gate to ordinary webhook dispatch, repair, publication, notes, or merge; those
paths retain their existing configured-Reviewer, trusted-run, binding,
runtime/session, and provider authority checks.

Any addition, edit, deletion or rename of root `SCOPE.md` pauses the Reviewer.
The Reviewer sends a tracked ask to its current admin manager containing the
Team, PR/MR, exact head, SCOPE digest, full proposed body and one approval
question. The manager's same-Team active-Admin authority is checked when the ask
is created and again when its answer is consumed. Rejection stops the run. A
changed head, changed digest or changed admin authority before answer
consumption invalidates approval and requires a new ask. An already consumed
exact-head approval is not revoked solely by a later manager role change. The
Reviewer never repairs SCOPE itself or silently chooses a replacement approver.

This admin gate is separate from the BYO writer's per-write confirmation: one
protects task targeting, the other protects the routing definition used by all
future BYO sessions.

## Status, repair, disable and recovery

`context status` reports provider compatibility, Plugin payload, Hook state,
the immutable project identity, every applicable highest-priority grant, and
each grant's live Team activation separately. After a standalone Claude repair,
it also reports the pending `/reload-plugins` adoption until the reloaded
Plugin's `UserPromptSubmit` Hook verifies the session and consumes that repair
obligation.

`context disable --provider ... --team ... --scope ...` removes exactly one
global or directory grant. Directory removal also requires its exact canonical
root. It preserves the shared Plugin, marketplace, credentials, other Team
grants and daemon. Already-read content cannot be removed from model memory;
disable affects future routing only.

Repair retains the provider-owned installation lifecycle and portable CLI
single-source invariant. Context mutation and local account switching share one
machine-state lock and a durable recovery journal. Do not edit provider caches
or Context state by hand.

`data/byo` belongs to the active local Client. Account switching parks and
restores it in the existing entry-level transaction; route, reload-observation,
write-plan, and repository journals validate `accountClientId`. An active or
incomplete BYO write blocks switching. `computer reset` and destructive purge
remove BYO repositories and the new account-scoped receipts/recovery state.

The Web bootstrap prompt keeps technical envelopes internal. It reports only
checking, installing/updating, required user action, and completion. The coding
agent may retry the same exact transient action a bounded number of times and
may run an exact CLI-provided reversible repair, but scope selection, account
switching, authentication/permission, Claude reload, Codex trust, destructive
reset, and changed plans remain explicit human decisions.

Activation failure never blocks ordinary Claude/Codex work and never falls back
to a lower-priority grant, another Team or cached authority. Authentication,
authorization, binding and typed disabled results do not retry. Explicit
routing may retry the same exact candidate only for bounded timeout/network/5xx
failures.

## Product boundaries

First Tree cannot provide hard isolation after one provider session has already
read content from multiple Teams; the model may retain earlier content.
Sensitive Teams should use separate provider sessions.

Session-only means no persistent grant, Plugin or Hook and no automatic future
activation. It does not promise continuity across clear, compact, resume, exit,
or a new session.

## Release qualification

Before production qualification, real Claude Code and Codex surfaces must
record evidence for:

1. global, directory and session-only setup;
2. dynamic setup choices for pathless, Codex scratch, default managed-worktree,
   and ordinary-project locations, plus `/hooks` consent and same-conversation
   continuation;
3. two or more real Teams with clear, overlapping, missing and non-matching
   SCOPE bodies;
4. a non-programming SCOPE and imperative text treated only as routing data;
5. membership revocation, binding movement, offline authority and scope-commit
   movement;
6. single- and multi-Team BYO writes with the mandatory new user confirmation;
7. SCOPE admin approval, rejection, changed head/digest and manager demotion;
8. v2 store backup and explicit reauthorization;
9. legacy full Plugin migration with the Claude reload gate, followed by a
   Core-only CLI upgrade that leaves adapter bytes and provider trust unchanged;
10. same-organization cross-provider repo reuse, cross-organization isolation,
    A→B→A Client switching, and active-write switch refusal;
11. concise bootstrap progress, bounded typed-error recovery, and unchanged
    human confirmation boundaries.

Unit tests and mock QA do not replace these real-provider checks.
