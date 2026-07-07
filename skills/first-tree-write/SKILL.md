---
name: first-tree-write
version: 0.9.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Source-driven Context Tree write workflow. Use when a concrete source artifact such as a PR, issue, design doc, meeting note, review thread, or pasted source material should be reflected into the Context Tree. If no source artifact is available, there is no write task; ask the user for one.
---

# First Tree Write

Use this skill when a specific source artifact should be reflected into the
Context Tree. The generated `AGENTS.md` / `CLAUDE.md` Context Tree Policy is
the baseline for what belongs in the tree; this skill applies that policy to a
source-backed write.

Use `first-tree-read` for task-scoped tree reads before acting. Use this skill
only for source artifact -> tree edit work.

## Source Gate

Writing is source-driven. Acceptable sources include:

- a PR, issue, commit discussion, or review thread;
- a design doc, meeting note, decision note, or pasted source material;
- a source repo change you just completed, when its design decision now needs
  durable tree context.

If no concrete source artifact exists, stop and ask for one. Do not invent
ad-hoc tree edits from memory or from a broad request like "update the tree".

Implementation-only material usually produces no tree write. Refactors,
function signatures, API shapes, request/response examples, build config,
fixtures, and one-off bug fixes stay in source repos unless the source also
establishes a durable decision, constraint, ownership change, or cross-domain
relationship.

## Workflow

1. **Read the source artifact.** If you authored the source in this chat and
   still have it in working context, you may rely on that context. Otherwise
   read the artifact end to end: PR diff plus linked issue/review comments, or
   the document/note in full.
2. **Apply the Double Test.** A candidate belongs only when it both establishes
   or changes a decision future agents must respect and remains durable if the
   triggering commit or PR is rewritten. If nothing passes, write nothing and
   explain why.
3. **Select the smallest target.** Prefer editing an existing node. Add a leaf
   only for a distinct decision with its own rationale/constraints. Add a
   directory only when the domain shape justifies it; new top-level domains
   require explicit human-owner approval.
4. **Read surrounding tree context.** Before drafting, read the target node,
   parent `NODE.md`, relevant `soft_links` targets, and ownership-adjacent
   `members/<id>/NODE.md` files when they affect the edit. You do not need to
   re-read nodes already in working context; the requirement is no surprises.
5. **Draft the edit.** Capture current truth and present-tense rationale.
   Rewrite superseded claims in place; do not append timeline updates. Keep
   canonical content in one place and use normal-to-normal `soft_links` when a
   cross-domain reader needs navigation.
6. **Verify.** Run `first-tree tree verify --tree-path <tree>` before commit.
   Non-zero exit blocks the PR.
7. **Prepare the PR.** One source artifact maps to one tree PR. Keep the PR
   description focused on the source and the tree nodes changed; do not put PR
   IDs, source links, or audit trails into node bodies.

## Write Rules

- **Default to not writing.** A missing node is a question; a noisy node is a
  trap. The source carries the burden of proof.
- **No code detail in nodes.** Tree prose records the decision and rationale,
  not the implementation.
- **No history.** Nodes state what is true now and why. Past states live in
  `git log` and, when present, raw/archive material.
- **No Source section.** Do not add `## Source`, `Shipped in #123`, inline PR
  citations, or delivery-history prose to node bodies.
- **No actionable future work in normal nodes.** Put follow-up work in an
  issue, source artifact, or human decision.
- **Do not unilaterally edit `owners`.** Ownership changes go through humans.
- **Respect `decisionLocksCode: true`.** Normally code is ground truth when the
  tree drifts. This flag reverses that for the node; code drift escalates to a
  human. Set it only on explicit human instruction.

## Authoring Judgment

The generated Context Tree Policy is the baseline; this section keeps the
write-time judgment details close to the workflow that uses them.

### Source-System Boundary

If the information would rot when the next refactor lands, it does not belong
in the tree.

| Belongs in the tree                                                | Stays in the source repo                         |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| A choice between alternatives and why the alternatives lost        | Function signatures, types, class hierarchies    |
| A constraint that shapes future implementation across repos        | Step-by-step implementation walkthroughs         |
| An ownership change or clarified review path                       | API request / response shapes                    |
| A current constraint that resulted from a deprecation              | Test fixtures, snapshot data, build / CI config  |
| A new relationship between two domains                             | Bug fixes that do not change a public contract   |
| Rationale that would not be obvious from the diff alone            | Refactors that preserve behaviour                |
| A decision as it stands today (current state + present-tense rationale) | Historical narrative of how we got here (lives in `git log`) |

### Content Model — What / Why / Who

Every node carries content along three axes. Two go in the body; one goes in
frontmatter:

- **What** — the decision, design choice, or constraint as it stands today.
  Write the durable claim, not the implementation or a timeline of prior
  states. When the decision changes, rewrite the claim in place.
- **Why** — the surviving rationale behind the What: the constraints that won,
  the reasons each alternative lost, and design course-corrections translated
  into present-tense reasoning. A node without Why is a fact, not a decision
  record.
- **Who** — ownership, carried by `owners` frontmatter and
  `members/<id>/NODE.md` nodes. Do not put ownership in the body.

Course-corrections are often the canonical Why. If a design moved from one
approach to another because a constraint surfaced in review or discussion,
record the surviving constraint, not the story of who corrected whom. For
example, write "cache is per-tenant because multi-tenancy isolation is a hard
constraint", not "we first proposed a global cache and changed it after
review".

### When to Add vs. Edit

Default to edit, not add. A node earns its existence by being independently
usable: separately findable, ownable, or linkable. If none of those separate it
from an existing node, edit the existing node.

Add a leaf only when all three hold:

1. **Distinct identity** — a noun-phrase title that does not overlap any
   sibling. If the title needs an "and" to be complete, it is probably two
   decisions or belongs inside an existing leaf.
2. **Distinct anchor** — at least one of:
   - `owners` differ from the parent or siblings;
   - another domain would `soft_links` to this specific decision, not the
     surrounding domain;
   - the source naturally has its own Decision / Rationale / Constraints that
     cannot co-live with any existing leaf without mixing two unrelated topics.
3. **Passes the Double Test.**

If only one or two hold, edit the existing leaf. Add a directory only when
there are or are expected to be at least three leaves under it that share a
clear axis. Top-level domains additionally require explicit human tree-owner
approval because they reshape the team's mental model.

When a decision touches two domains, put the canonical leaf in the more
specific domain and link to it from the broader domain with `soft_links`.

## Node Shape Reminder

Required frontmatter:

```yaml
---
title: "Short noun phrase"
owners: [alice, bob]
---
```

Useful optional frontmatter:

```yaml
description: "One-sentence summary used by readers and generated indexes."
soft_links:
  - /other-domain/NODE.md
decisionLocksCode: false
```

Prefer body sections in this order, omitting any that do not apply:

1. `## Decision` — the current durable claim.
2. `## Rationale` — why this choice; why alternatives lost.
3. `## Constraints` — what future implementation must respect.
4. `## Cross-Domain` — relationship prose when `soft_links` alone is not
   enough.

A concise node that captures the decision clearly is better than a long node
that mirrors source detail.

## Worked Examples

In the examples below, **"Trigger: ..."** labels what prompted the tree write.
The label is skill narration, not a body section template; do not add
`## Trigger` or `## Source` to the node.

Some examples split `Belongs:` into `Belongs (What):` and `Belongs (Why):` to
make the Content Model distinction concrete. Both forms describe the same
boundary: what survives in the node vs. what stays in the source repo.

**Trigger: PR adding a new caching layer.**
Belongs: "Service X owns the cache; other services read through Service X's
SDK"; "we chose Redis over Memcached because of pubsub support".
Does not belong: the cache key format, the eviction policy class, the retry
constants.

**Trigger: meeting note "we are moving billing to a new repo".**
Belongs: workspace map gets a new repo; ownership for billing shifts; the
`billing/` <-> `platform/` boundary is updated.
Does not belong: migration timeline, release-day playbook, per-PR checklist.

**Trigger: a reviewer's nit about variable naming.**
Belongs: nothing. Naming is implementation detail.

**Trigger: a security review report.**
Belongs: constraints that came out of it ("session tokens must be HMAC-signed
before storage"); the accountable owner.
Does not belong: the specific vulnerabilities or how they were patched.

**Trigger: course-correction during design — partway through, a reviewer says
"no, the cache should be per-tenant, not global; multi-tenancy was the whole
point of last quarter's work."**
Belongs (What): "cache is keyed per-tenant".
Belongs (Why): the multi-tenancy constraint that ruled global caching out,
written as a current constraint ("multi-tenancy isolation is a hard constraint;
a shared cache violates it"). The correction is the canonical Why; without it,
the next agent reading the cache code alone has no way to re-derive the
constraint.
Does not belong: "we originally proposed a global cache, then switched after
review" — that is timeline narration. State the surviving constraint, not the
path to it.

**Trigger: a constraint surfaces during design — partway through, somebody
points out "this also has to work offline-first for the mobile client; we
cannot assume connectivity."**
Belongs (What): "writes are offline-first; the client buffers and reconciles on
reconnect".
Belongs (Why): "the mobile client operates without connectivity for hours at a
time; designs requiring server round-trips do not satisfy this constraint."
This is the canonical Why a future reader will need — no amount of reading the
source repo alone would surface the offline-first requirement, because it lives
only in somebody's head until the design phase forces it out and the node
records it.
Does not belong: "the first cut of the design didn't consider offline, then we
added it after a teammate flagged the mobile case" — that is timeline
narration. Record the surviving constraint, not the path that surfaced it.

**Trigger: design-phase direction picked between options — the candidates were
A and B; the chosen direction is "B, because A would block the auth-rewrite
landing next quarter."**
Belongs (What): the decision to go with B, stated as the durable claim of the
design.
Belongs (Why): the cross-domain interaction with the upcoming auth-rewrite,
named as a present-tense constraint ("the auth-rewrite in `/auth/NODE.md`
constrains this domain to B-shaped designs"). This is the kind of constraint
that only surfaces when somebody carrying the broader org context weighs in
during design — and exactly the Why nobody will reconstruct from the code six
months from now.
Does not belong: "option A was considered and rejected because..." as
historical narration. Phrase the surviving constraint, not the past-tense
rejection.

**Trigger: PR that flips a policy default — e.g. "approvals required" goes from
1 to 0.**
Belongs: the current rule stated as fact ("approvals required = 0"); the
current rationale (why 0 is the right number now), present-tense.
Does not belong: a `> 2026-XX-XX update:` banner, a "previously we required 1
approval" sentence, a "since 5/29..." paragraph, or a "Superseded by..." footer.
Rewrite the relevant node in place to the new current state. The old state
stays only in `git log` and any raw/archive material.

**Trigger: an existing tree node already carries a `## Source` section that
lists the PRs which delivered the decision.**
Pattern: the `## Source` body section is forbidden, but the section often hides
substantive content — open follow-ups, known gaps, deferred items, surviving
rationale — that was tacked onto the bottom of the PR audit trail. Do not just
delete the section.

- **Delete:** the PR-id list, "Shipped in #X" / "Landed in #Y" annotations,
  and PR-by-PR audit-trail framing.
- **Move to a GitHub Issue:** any actionable work item the section carried: a
  pending fix, deferred migration, unresolved question, or known gap. Active
  tree nodes do not carry `## Work` or `## Future Work` sections.
- **Fold into body sections:** any current-state architectural fact or
  surviving rationale. Fold it into Decision / Rationale / Constraints /
  Cross-Domain as a present-tense statement.

The audit trail itself stays in `git log`; actionable work moves to issues;
durable current-state claims and rationale stay in the node body.

## CLI Surface

Examples use `first-tree`; substitute the channel-correct binary from the
generated briefing when running in staging or dev.

The write gate is:

```bash
first-tree tree verify --tree-path <tree>
```

Everything else uses standard tools: `git` for branches/commits, `gh` for
GitHub reads and PRs, and native file reads/edits for Markdown.
