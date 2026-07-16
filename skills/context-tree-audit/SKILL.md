---
name: context-tree-audit
description: Audit stored normal content on the bound Context Tree's current default branch when a human explicitly asks to audit the whole tree, a domain, or specific normal paths for drift, contradictions, duplication, density, metadata, placement, or relationship problems. Do not use for ordinary task reads, source-backed writes, Context Tree PR reviews, or empty-tree setup.
---

# Context Tree Audit

## Purpose

Audit a stable snapshot of stored normal content on the bound Context Tree's
current default branch and route each evidence-backed finding to the smallest
safe follow-up.

The workspace-generated `AGENTS.md` / `CLAUDE.md` Context Tree Policy is the
only content-policy and authority baseline. Apply it directly; do not recreate
its definitions or rules in this skill. If the policy or binding is missing,
stop and report the environment gap.

## Trigger Boundary

Use this skill only when a human explicitly asks for a broad stored-tree audit
or names a domain or set of normal paths to audit. This trigger is exclusive:
do not run `first-tree-read` first and expand a task-scoped read into an audit.

Do not use this workflow for a concrete source artifact that should be written
to the tree, a Context Tree pull request review, ordinary task context, or an
empty-tree setup. Those remain owned by their dedicated skills.

Choose the execution mode from the request:

- **Report-only (default):** a request to audit, inspect, or report grants
  read-only authority. Perform no commit, push, pull request, issue, tracked
  ask, or other external mutation; report findings and recommended routes in
  the completion response.
- **Maintenance:** select this only when the human explicitly asks to maintain,
  fix, or create follow-up artifacts. Mutation authority extends only to the
  requested artifact kinds. High-confidence local findings may produce one
  focused artifact per coherent finding group. Nothing is merged automatically.

## Stable Snapshot

1. Read `.first-tree/workspace.json` and the generated Tree Location section.
   Resolve the bound tree checkout, upstream, and default branch. Fail closed
   on a missing binding, repository mismatch, or ambiguous branch.
2. From the bound checkout, inspect `first-tree tree tree --help` before using
   its current selectors.
3. Fetch the bound upstream branch and resolve its exact remote HEAD SHA. If
   freshness cannot be confirmed because of network, permission, or remote
   identity failure, do not claim a current audit and do not create a semantic
   fix.
4. Create a uniquely named, agent-owned detached worktree at that exact SHA.
   Never switch or edit the main tree checkout and never reuse an unowned path.
5. Report the repository, branch, exact SHA, requested scope, and execution
   mode. Keep all discovery reads fixed to this snapshot.
6. In the registered, clean detached worktree, run the selected
   `first-tree tree tree --no-pull ...` command and confirm its HEAD is still
   the exact audited SHA. Never resolve the audit scope from the mutable main
   checkout after the snapshot exists.
7. In the detached worktree, run `first-tree tree verify --json` before any
   semantic node read. Record validator failures as mechanical findings and do
   not hide them inside semantic conclusions.
8. If validation passes, read only the scoped
   normal nodes plus the minimum parent, sibling, relationship, and source
   evidence needed to judge them under the generated policy.
9. Remove the detached worktree through `git worktree remove` when finished.
   Never use `--force`; a dirty snapshot is an integrity failure.

## Audit Workflow

Check the requested scope for stale or contradictory claims, duplicated
canonical truth, misplaced decisions, misleading metadata or relationships,
excessive density, and source-boundary violations. Do not treat model suspicion
as evidence.

Each finding must contain:

- `path`: the exact normal node or relationship;
- `policy`: the generated-policy rule that applies;
- `claim`: the current claim and concrete problem;
- `evidence`: verifiable current source, configuration, validator output,
  human decision, or related canonical normal content;
- `confidence`: `mechanical`, `strong`, `uncertain`, or `human-authority`;
- `action`: report, focused tree PR, issue or draft proposal, tracked human
  ask, or source-code escalation.

Tree history and forge discussion may help locate evidence, but delivery
history does not become normal-node prose. Apply the generated policy's
code-versus-tree drift authority exactly; never turn an authority conflict into
an automatic normal-content rewrite.

## Finding Routing

- In Report-only mode, record every finding and its recommended route in the
  response, including authority conflicts. Do not create an issue, proposal,
  tracked ask, branch, commit, or pull request.
- A local mechanical or strong semantic finding may become one small tree PR
  in Maintenance mode only after it becomes a concrete audit source artifact.
  Include the audited SHA and scope, exact finding group, current evidence,
  canonical-placement judgment, and risk. Then load `first-tree-write`; that
  skill rechecks freshness and owns target selection, drafting, verification,
  worktree, and PR discipline. Every Audit-originated tree PR is created as a
  draft and remains draft when Audit and Writer finish. Audit never edits the
  tree directly.
- Weak, broad, or cross-domain evidence does not change normal truth. Report it
  or, when Maintenance explicitly authorizes it, create a focused issue or
  draft proposal that names the missing evidence.
- In Maintenance mode, ownership, human-authority, or locked-decision conflicts
  use a tracked human ask only when the next step genuinely depends on that
  decision and the request authorizes follow-up actions. Otherwise report the
  blocker without mutation. Source implementation that conflicts with a locked
  decision is escalated to the source side, not repaired by changing the tree.
- No findings means report the exact audited SHA, scope, validator result, and
  evidence coverage. Do not claim correctness outside the inspected scope.

One pull request carries one coherent finding group. Do not turn a broad audit
into a tree-wide rewrite or a bundle of unrelated domain changes.

## Mutation Boundary

Audit owns discovery, evidence classification, and action selection. It does
not own a second authoring policy or pull request verdict workflow.

Never edit `owners` without explicit human authority, approve a pull request
created from this audit, merge, change repository governance, create a new CLI
surface, or claim scheduled execution. Any tree PR continues through
`context-tree-review`.

## Completion Report

Report the repository, default branch, exact audited SHA, scope, validator
result, findings grouped by confidence and action, artifacts actually created,
snapshot cleanup result, and any decision that blocks the next step. State
explicitly when the run was report-only or freshness could not be confirmed.
