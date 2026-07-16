---
name: first-tree-write
version: 0.9.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Source-driven Context Tree write workflow. Use when a concrete source artifact such as a PR/MR, forge Issue, design doc, meeting note, review thread, or pasted source material should be reflected into the Context Tree. If no source artifact is available, there is no write task; ask the user for one.
---

# First Tree Write

Use this skill when a specific source artifact should be reflected into the
Context Tree. The generated `AGENTS.md` / `CLAUDE.md` Context Tree Policy is
the baseline for what belongs in the tree; this skill applies that policy to a
source-backed write.

Use `first-tree-read` for task-scoped tree reads before acting, except when the
source is a current-session Audit finding whose exact snapshot context is
already loaded. Use this skill only for source artifact -> tree edit work.

## Source Gate

Writing is source-driven. Acceptable sources include:

- a PR/MR, forge Issue, commit discussion, or review thread;
- a design doc, meeting note, decision note, or pasted source material;
- a source repo change you just completed, when its design decision now needs
  durable tree context;
- an evidence-backed `context-tree-audit` finding from the current session that
  records the exact audited tree HEAD and scope, path, generated-policy rule,
  current source evidence, confidence, intended replacement or canonical
  placement, and risk, and comes from an Audit request that explicitly granted
  Maintenance mutation authority.

If no concrete source artifact exists, stop and ask for one. Do not invent
ad-hoc tree edits from memory or from a broad request like "update the tree".
When the source repo or issue lives on GitHub or GitLab, choose the matching
forge CLI (`gh` or `glab`) and use PR/MR language accordingly.

An Audit finding is valid only for its recorded tree HEAD. Before any target
selection, worktree creation, or mutation, fetch the bound upstream default
branch and require its exact remote HEAD to equal the finding's audited HEAD.
If it advanced, do not apply the old finding. Re-run Audit validation, target
and source-evidence reads on a new exact snapshot, or fail closed without a
tree diff or pull request.

For an Audit finding, repeat that fetch and exact remote-HEAD comparison after
drafting and verification, immediately before any push or PR/MR creation. If
the default branch advanced during authoring, do not publish. Safely remove the
unpublished Audit-origin worktree and local branch, then re-run Audit on a new
exact snapshot or stop with no remote branch and no PR/MR.

Implementation-only material usually produces no tree write. Refactors,
function signatures, API shapes, request/response examples, build config,
fixtures, and one-off bug fixes stay in source repos unless the source also
establishes a durable decision, constraint, ownership change, or cross-domain
relationship.

## Workflow

1. **Read the source artifact.** If you authored the source in this chat and
   still have it in working context, you may rely on that context. Otherwise
   read the artifact end to end: PR/MR diff plus linked Issue/review comments,
   or the document/note in full.
2. **Apply the Double Test.** A candidate belongs only when it both establishes
   or changes a decision future agents must respect and remains durable if the
   triggering commit or PR/MR is rewritten. If nothing passes, write nothing
   and explain why.
3. **Select the smallest target.** Prefer editing an existing node. Add a leaf
   only for a distinct decision with its own rationale/constraints. Add a
   directory only when the domain shape justifies it; new top-level domains
   require explicit human-owner approval.
4. **Read surrounding tree context.** Before drafting, read the target node,
   parent `NODE.md`, relevant `soft_links` targets, and ownership-adjacent
   member content when it affects the edit. You do not need to re-read nodes
   already in working context; the requirement is no surprises.
5. **Draft the edit.** Capture current truth and present-tense rationale.
   Rewrite superseded claims in place; do not append timeline updates. Keep
   canonical content in one place and use normal-to-normal `soft_links` when a
   cross-domain reader needs navigation.
6. **Verify and publish.** Run `first-tree tree verify --tree-path <tree>`
   before commit. Non-zero exit blocks the PR/MR. For an Audit finding, commit
   only that verified tree state, verify the committed tree again, then perform
   the second exact-head check above before pushing that branch and creating
   the draft PR/MR with its head explicitly bound to the published branch.
7. **Prepare the PR/MR.** One source artifact maps to one tree PR/MR. Keep the
   description focused on the source and the tree nodes changed; do not put
   PR/MR IDs, source links, or audit trails into node bodies. An Audit-originated
   tree PR/MR must be created as draft and left draft for independent
   `context-tree-review`; Writer does not mark it ready.

## Write Rules

- **Default to not writing.** A missing node is a question; a noisy node is a
  trap. The source carries the burden of proof.
- **No code detail in nodes.** Tree prose records the decision and rationale,
  not the implementation.
- **No history.** Nodes state what is true now and why. Past states live in
  `git log` and non-normal archive/supporting material, not normal nodes.
- **No Source section.** Do not add `## Source`, `Shipped in #123`, inline PR/MR
  citations, or delivery-history prose to node bodies.
- **No actionable future work in normal nodes.** Put follow-up work in an
  issue, source artifact, or human decision.
- **Do not unilaterally edit `owners`.** Ownership changes go through humans.
- **Respect drift authority.** Follow the generated policy's code-vs-tree drift
  rule, including the human-gated flag that reverses the default for a node.

## Authoring Judgment

The generated Context Tree Policy is the baseline; this section keeps the
write-time judgment details close to the workflow that uses them.

### Source-System Boundary

If the information would rot when the next refactor lands, it does not belong
in the tree. The policy's source-system boundary table is the canonical guide;
use the worked examples below to calibrate source-backed authoring.

### Content Model

Every node carries What, Why, and Who. What and Why go in the body; Who lives
in frontmatter. Course-corrections are often the canonical Why: if a design
moved from one approach to another because a constraint surfaced in review or
discussion, record the surviving constraint, not the story of who corrected
whom.

### Node Shape Reminder

Required frontmatter:

```yaml
---
title: "Short noun phrase"
owners: [alice, bob]
---
```

Prefer body sections in this order, omitting any that do not apply:

1. `## Decision` — the current durable claim.
2. `## Rationale` — why this choice; why alternatives lost.
3. `## Constraints` — what future implementation must respect.
4. `## Cross-Domain` — relationship prose when `soft_links` alone is not
   enough.

A concise node that captures the decision clearly is better than a long node
that mirrors source detail.

### Worked Examples

In the examples below, **"Trigger: …"** labels what prompted the
tree-write (a PR/MR, a meeting note, a report). The labels are
meta-narration in this skill — they are not a body section template;
no `## Trigger` / `## Source` heading goes into the actual node.

Some examples split `Belongs:` into `Belongs (What):` and `Belongs
(Why):` to make the Content Model distinction concrete; others
keep a single `Belongs:` line where the distinction is not
load-bearing. Both forms describe the same underlying boundary —
what survives in the node vs what stays in the source repo. The
split is teaching emphasis, not a separate convention.

**Trigger: PR/MR adding a new caching layer.**
Belongs: "Service X owns the cache; other services read through Service
X's SDK"; "we chose Redis over Memcached because of pubsub support".
Does not belong: the cache key format, the eviction policy class, the
retry constants.

**Trigger: meeting note "we are moving billing to a new repo".**
Belongs: workspace map gets a new repo; ownership for billing shifts;
the `billing/` ↔ `platform/` boundary is updated.
Does not belong: migration timeline, release-day playbook, per-PR/MR
checklist.

**Trigger: a reviewer's nit about variable naming.**
Belongs: nothing. Naming is implementation detail.

**Trigger: a security review report.**
Belongs: constraints that came out of it ("session tokens must be
HMAC-signed before storage"); the accountable owner.
Does not belong: the specific vulnerabilities or how they were patched.

**Trigger: course-correction during design — partway through, a
reviewer says "no, the cache should be per-tenant, not global;
multi-tenancy was the whole point of last quarter's work."**
Belongs (What): "cache is keyed per-tenant".
Belongs (Why): the multi-tenancy constraint that ruled global caching
out, written as a *current* constraint ("multi-tenancy isolation is a
hard constraint; a shared cache violates it"). The correction is the
canonical Why — without it, the next agent reading the cache code
alone has no way to re-derive the constraint.
Does not belong: "we originally proposed a global cache, then switched
after review" — that is timeline narration. State the
surviving constraint, not the path to it.

**Trigger: a constraint surfaces during design — partway through,
somebody points out "this also has to work offline-first for the
mobile client; we cannot assume connectivity."**
Belongs (What): "writes are offline-first; the client buffers and
reconciles on reconnect".
Belongs (Why): "the mobile client operates without connectivity for
hours at a time; designs requiring server round-trips do not satisfy
this constraint." This is the canonical Why a future reader will need
— no amount of reading the source repo alone would surface the
offline-first requirement, because it lives only in somebody's head
until the design phase forces it out and the node records it.
Does not belong: "the first cut of the design didn't consider
offline, then we added it after a teammate flagged the mobile case"
— that is timeline narration. Record the surviving
constraint, not the path that surfaced it.

**Trigger: design-phase direction picked between options — the
candidates were A and B; the chosen direction is "B, because A would
block the auth-rewrite landing next quarter."**
Belongs (What): the decision to go with B, stated as the durable
claim of the design.
Belongs (Why): the cross-domain interaction with the upcoming
auth-rewrite, named as a present-tense constraint ("the auth-rewrite
in `/auth/NODE.md` constrains this domain to B-shaped designs"). This
is the kind of constraint that only surfaces when somebody carrying
the broader org context weighs in during design — and exactly the Why
nobody will reconstruct from the code six months from now.
Does not belong: "option A was considered and rejected because…" as
historical narration. Phrase the surviving constraint, not the
past-tense rejection.

**Trigger: PR/MR that flips a policy default — e.g. "approvals required"
goes from 1 to 0.**
Belongs: the *current* rule stated as fact ("approvals required = 0");
the *current* rationale (why 0 is the right number now), present-tense.
Does not belong: a `> 2026-XX-XX update:` banner, a "previously we
required 1 approval" sentence, a "since 5/29…" paragraph, a
"Superseded by…" footer. **Rewrite the relevant node in place** to
the new current state. The old state stays only in `git log` (and
any raw-archive domain your tree may have).

**Trigger: an existing tree node already carries a `## Source`
section that lists the PRs/MRs which delivered the decision.**
Pattern: the `## Source` body section is forbidden, but the section often
hides *substantive* content — open
follow-ups, known gaps, deferred items, surviving rationale — that
was tacked onto the bottom of the PR/MR audit trail. Do not just
delete the section.
- *Delete*: the PR/MR-id list, the "Shipped in #X" / "Landed in #Y"
  annotations, the review-request audit-trail framing.
- *Move to a forge Issue*: any actionable work item the section
  carried (a pending fix, a deferred migration, an unresolved
  question, a known gap) — open a present-tense Issue in the
  relevant repo with its matching CLI (`gh` for GitHub, `glab` for GitLab),
  dropping the PR/MR id. Active tree nodes do not carry `## Work` or
  `## Future Work` sections; actionable work lives in Issues (see the
  team-practice node for the team's own rule on this).
- *Fold into body sections*: any current-state architectural fact
  (e.g. "the rollback path lives at X") or surviving rationale
  (e.g. "we chose Postgres because the team was familiar with it")
  — fold it into the relevant Decision / Rationale / Constraints /
  Cross-Domain section as a present-tense statement.
The audit trail itself stays in `git log`; the actionable work
moves to Issues; the durable current-state claims and rationale
stay in the node body.

## CLI Surface

CLI examples in this skill use the canonical prod binary `first-tree` for
readability. Substitute the channel-correct binary from AGENTS / current
channel (`first-tree` on prod, `first-tree-staging` on staging,
`first-tree-dev` on dev) before running them.

The Context-management CLI you actually depend on while reading or
writing is small. Today only one command is operationally required:

- `first-tree tree verify` — validate frontmatter and node structure;
  the write gate that must pass before any commit.

A simplified CLI surface (a structural `list`, a `verify`, and an
`upgrade`) is the design target; until that lands, map the tree with
standard tooling (`ls`, `Read`, `Grep`) and rely on `tree verify` as
the write gate. Everything else (opening PRs/MRs, fetching code, reading
the workspace binding) goes through standard tools (`git`, `gh`,
`glab`, `Read`, etc.).
