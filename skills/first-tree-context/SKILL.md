---
name: first-tree-context
version: 0.8.4
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Context Tree concept and writing-principles guide. Covers what a Context Tree is, the source-system boundary, authorship read-discipline, Double Test, Node Shape, and hard rules for durable tree content. Use `first-tree-read` for task-scoped tree reads before acting. For source-backed write / update / reflect / capture requests, use `first-tree-write`; it owns the operational workflow and write rules.
---

# First Tree — Context

Read this skill when you need the Context Tree concept model or the
writing principles that govern durable tree content. It is the operating
guide for authorship: a few principles, a small set of hard rules, and
the judgment guidelines that turn source material into correct edits.

Use `first-tree-read` for task-scoped tree reads before acting. Use
`first-tree-write` for the operational workflow of taking a specific
source artifact to a chosen tree target, including the write rules for
that workflow. This skill remains the concept and reference guide; it is
not a mandatory dependency for source-backed write tasks.

## What A Context Tree Is

A Context Tree is a Git repository with a recursive `NODE.md` index
that holds a team's **durable decisions, constraints, ownership, and
cross-domain relationships**. It is the persistent counterpart to the
in-the-moment context built in a chat: a chat goes away; the tree
carries forward what the next agent needs to act correctly across
many months and many repos.

Three objects shape every tree task:

- **source / workspace root** — where humans and agents do the work
- **tree repo** — the Git repo that stores the durable record
- **binding** — the metadata that links the workspace to the tree

Tree files:

- `NODE.md` at each directory describes the domain and indexes children
- leaf `*.md` files capture one decision, constraint, or relationship
- `members/<id>/NODE.md` is one member's responsibilities and review scope
- frontmatter (`title`, `owners`, optional `soft_links`, `lastReviewed`,
  `decisionLocksCode`) plus the body — see "Node Shape" below

## The Source-System Boundary

The single most common failure mode is using the tree as a second wiki
— every API signature, every config file, every refactor goes in. The
tree then rots faster than the code and becomes a trap.

> If the information would rot when the next refactor lands, it does
> not belong in the tree.

| Belongs in the tree                                                | Stays in the source repo                         |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| A choice between alternatives and why the alternatives lost        | Function signatures, types, class hierarchies    |
| A constraint that shapes future implementation across repos        | Step-by-step implementation walkthroughs         |
| An ownership change or clarified review path                       | API request / response shapes                    |
| A current constraint that resulted from a deprecation              | Test fixtures, snapshot data, build / CI config  |
| A new relationship between two domains                             | Bug fixes that do not change a public contract   |
| Rationale that would not be obvious from the diff alone            | Refactors that preserve behaviour                |
| A decision as it stands today (current state + present-tense rationale) | Historical narrative of how we got here (lives in `git log`) |

## Reading the Tree

This skill's read discipline is for authorship: before you write a tree
update, make sure the draft does not contradict existing context. Use
`first-tree-read` when the task is "read the relevant tree context before
acting" for a feature, path, bug, owner, or repo area.

Before writing, read:

- the target node you expect to edit
- the parent domain `NODE.md`
- every `soft_links` neighbour that may constrain the edit
- ownership-adjacent `members/<id>/NODE.md` files when review scope or
  ownership affects the edit

You do not need to re-read material already in your working context. The
contract is "no surprises": the written node must respect the current
tree model, neighbouring decisions, and source-system boundary.

## Writing the Tree

Writing is **source-driven** — a specific PR, design doc, meeting note,
or pasted text motivates a specific edit. Without a source there is
no write task; stop and ask the user for one.

### Hard Rules

These are non-negotiable. They are short on purpose — when in doubt,
follow them.

1. **Default to not writing.** A node nobody reads is worse than a
   missing node: a missing node is a question, a noisy node is a trap.
   Apply the Double Test (below) and if it does not pass cleanly,
   write nothing and tell the user why.
2. **Read before you write — unless you already know it.** Before
   drafting any edit, read every related tree node — the target node,
   every `soft_links` neighbour, the parent domain `NODE.md`, and any
   ownership-adjacent `members/<id>/NODE.md` — that you do not
   already have in your working context, and confirm the draft does
   not contradict an existing decision. The source artefact has the
   same rule: if you are the agent that just shipped the source PR
   (or just authored the doc / note), you already have it end-to-end
   and do not need to re-read; otherwise read it in full — PR diff +
   linked issue + review comments, or the doc end-to-end. The point
   is "no surprises", not "always re-read".
3. **Smallest correct edit.** Default to editing an existing node;
   only add a new leaf or directory when it meets the criteria in
   *When to Add vs. Edit* below. Top-level domains additionally
   require explicit human-owner approval.
4. **No diffs, no code detail.** Tree nodes capture the durable
   decision and the rationale, not implementation detail. Function
   signatures, class names, request shapes, retry constants live in
   the source repo. The tree records *what was decided and why*; the
   diff lives in the source PR.
5. **`first-tree tree verify` must pass before commit.** Non-zero
   exit blocks the commit. Fix the structure problem before opening
   a PR; do not paper over it.
6. **Ownership changes go through humans.** Do not unilaterally edit
   `owners`. Flag the change to the listed owner and let them decide.
7. **`decisionLocksCode: true` reverses the default.** Most drift
   resolves by updating the tree to match the code. A node carrying
   `decisionLocksCode: true` reverses that — the tree wins and any
   code drift escalates to a human. Set the flag only on explicit
   human instruction.
8. **No history — capture current state, not how we got here.** A
   node states what is true *now* and why; it does not narrate prior
   states. Past states live in `git log` (and, if your tree has a
   raw archive domain such as `raw-context/`, there too). When a
   decision changes, **rewrite the node in place** to the new
   current state — do not append a `> 2026-XX-XX update:` banner, a
   "previously we…" / "originally…" / "since 5/29…" paragraph, or a
   "Superseded by X" footer. The only history that belongs is
   rationale (*why* the current state was chosen over alternatives,
   including, when essential, why the prior approach is
   insufficient), and that lives in the **Rationale** section as a
   present-tense argument, not a timeline.
9. **No PR references — record the decision, not its delivery.** A
   tree node captures the durable claim and its rationale, not the
   PR / commit / issue that delivered it. Do not add a `## Source`
   section linking to the triggering PR, an inline `(#1234)` /
   `[apps#1234]` citation, a `Shipped in #X` annotation, or any
   PR-id reference inside the node body. The audit trail for "which
   PR landed this decision" lives in `git log` and the source repo's
   own PR history; the node lives by its present-tense claim alone.
   This rule applies to all body content (Decision / Rationale /
   Constraints / Cross-Domain). It does **not** affect: `soft_links`
   between tree nodes (those are tree-internal navigation, not PR
   references), or the meta-narration in this skill's own Worked
   Examples (where the "Trigger: …" labels are part of the *skill
   text* describing what prompted a write, not a section template
   for the node itself).

### The Double Test (judgment filter)

Before drafting, apply both questions to every candidate fact in the
source:

1. **Decision question.** Does this source establish or change
   something a future agent must respect when making cross-domain
   choices?
2. **Durability question.** If the underlying PR or commit were
   rewritten, would the decision still stand?

The candidate belongs in the tree **only when both answers are yes**.

- Decision question fails → the source is execution detail, not a
  shared constraint. Leave it in the source repo.
- Durability question fails → the source captures *how something was
  done this time*, not *what was decided*. Pinning it creates a node
  that goes stale on the next refactor.

### Content Model — what / why / who

Every node carries content along three axes. Two go in the body; one
goes in frontmatter:

- **What** — the decision, design choice, or constraint, **as it
  stands today**. High-level: the durable claim, not the
  implementation; current state, not a timeline of prior states.
  When the design ends up somewhere the first draft did not — a
  different architectural choice, an extra constraint, a
  course-correct on the initial proposal — **the new direction
  is the What.** Write it as the durable claim of the design,
  not as "what we changed to" or "what the reviewer asked for".
  When the decision later changes again, rewrite *What* in place
  to reflect the new state; do not preserve the old state
  alongside it (`git log`, and any raw-archive domain your tree
  may have, are where prior states live). The Source-System
  Boundary table above is the canonical guide for which "whats"
  belong.
- **Why** — the surviving rationale behind the *What*: the
  constraints that won, the reasons each alternative lost,
  recorded as present-tense constraint and reasoning. The design
  phase is where this rationale is **produced** (concerns weighed,
  alternatives considered, course-corrections introduced), but the
  node records the **outcome** of that process — not its
  chronology (Hard Rule 8). The final decision is the *What*; its
  surviving rationale is the *Why*. **A node without a Why is a
  fact, not a decision record.** Why-content is the most commonly
  lost axis — protect it deliberately during the rush to land a PR
  or close a meeting.
  - **Why is generated in the design phase, captured in the
    node.** The concerns, course-corrections, and dropped
    alternatives that shape the design are generated *during*
    design — the moment somebody flags "won't this break X?", the
    moment a first proposal is corrected, the moment an option is
    dropped because it conflicts with another domain. By the time
    the PR lands the design is settled, but the reasoning that
    settled it lives only in chat / review threads / meeting notes
    and decays fast. The node captures the *outcome* of those
    moments (the surviving constraints and reasons), not the
    moments themselves.
  - **Course-corrections are the canonical Why.** Each correction
    encodes two things at once: an alternative that was *actually
    pursued* (not abstractly considered), and the constraint or
    insight that ruled it out. Both are exactly the content that
    keeps the next agent from re-litigating the same path.
    Corrections surface in design-phase back-and-forth — chat
    threads, review comments, design meetings — and decay fast
    once the PR lands. Capture them while you still have them, but
    apply the **Double Test** (above) before pinning: not every
    review nit is a course-correction, and the surviving
    constraint still has to be durable across refactors.
  - **Translate corrections into present-tense rationale, not
    narration (i.e. timeline).** "The agent first proposed a
    global cache; the human said no" is a timeline (Hard Rule 8
    forbids it). "Cache is per-tenant because multi-tenancy
    isolation is a hard constraint" is the surviving Why. Keep
    the *constraint* the correction introduced; drop the *story*
    of how it happened.
  - Other rich sources: meeting discussions where a decision was
    reached; PR review threads that changed the design.
  - Self-check: "Six months from now, if a reader reads only the
    *What*, will they be tempted to re-litigate this decision?"
    If yes, the Why is under-documented — the most common gap is
    a concern or course-correction from the design phase that
    lived only in chat and never made it into the node.
- **Who** — ownership, carried by `owners` frontmatter and
  `members/<id>/NODE.md` nodes. **Do not put ownership in the body.**
  Changes here go through humans (Hard Rule 6).

### When to Add vs. Edit

**Default to edit, not add.** A node earns its existence by being
independently usable — separately findable, ownable, linkable. If none
of those separate from an existing node, edit; don't add. Tree bloat
(many overlapping leaves) is a worse failure mode than a missing leaf.

**Add a leaf** (new `.md` in an existing domain) only when **all three**
hold:

1. **Distinct identity** — a noun-phrase title that does not overlap
   any sibling. If the title needs an "and" to be complete, it is
   probably two decisions or belongs inside an existing leaf.
2. **Distinct anchor** — at least one of:
   - `owners` differ from the parent / siblings;
   - another domain would `soft_links` to *this specific decision*,
     not the surrounding domain;
   - the source naturally has its own Decision / Rationale /
     Constraints that cannot co-live with any existing leaf without
     mixing two unrelated topics.
3. **Passes the Double Test** (above).

If only one or two hold, edit the existing leaf — append to its
Decision / Constraints section, or extend its Rationale.

**Add a directory** (subdomain or top-level) only when there are or are
expected to be **≥ 3 leaves** under it that share a clear axis. Two
shapes:

- *Greenfield* — open a new domain because 3+ leaves are visibly
  landing there in the near term.
- *Restructure* — a domain has 3 cohesive leaves at the same level;
  promote the group into a subdomain. (A 4th leaf about to land is a
  natural trigger, but the gate is already met at 3.)

Below 3, flat leaves at the same level is fine — flat is cheap, and
premature splitting just adds cross-references.

**Top-level domains** carry one extra constraint on top of the ≥ 3
leaves rule: they must be **approved by a human tree owner**, because
they reshape the team's mental model — not just the organisation of
files. Agents do not open top-level domains on their own.

**Cross-domain placement.** When a decision touches two domains, the
leaf goes in the *more specific* domain; the broader domain links to
it via `soft_links`. The canonical content lives in one place and stays
discoverable from the other.

**Ownership changes** still go through `members/`, not a domain leaf
(Hard Rule 6).

### Node Shape

Required frontmatter (without both, `first-tree tree verify` fails):

```yaml
---
title: "Short noun phrase"
owners: [alice, bob]
---
```

- `title` — a noun phrase, not a sentence. Reuse the filename when
  you can.
- `owners` — GitHub handles or team names. Use `[*]` only when the
  node is intentionally open to anyone.

Optional frontmatter:

```yaml
description: "One-sentence summary used by the auto-index and llms.txt."
soft_links:
  - /other-domain/NODE.md
  - /another-domain/specific-leaf.md
lastReviewed: 2026-06-04
decisionLocksCode: false
```

- `description` — one sentence, consumed by the root index.
- `soft_links` — tree-internal references; the validator resolves them.
- `lastReviewed` — date an owner sanity-checked the node. Sync sets
  this; do not touch it during a write.
- `decisionLocksCode` — reverses the default conflict-resolution rule
  (see Hard Rule 7).

Body sections, in this order. These carry the *What* (Decision /
Constraints / Cross-Domain) and *Why* (Rationale) axes of the Content
Model; *Who* lives in frontmatter, not the body. Omit any section
you do not need:

1. **Decision** — one paragraph stating the durable claim.
2. **Rationale** — why this decision; why the alternatives lost.
3. **Constraints** — what the decision implies for future implementations.
4. **Cross-Domain** — explicit references to other domains, when more
   context than `soft_links` is useful.

There is no Source / Provenance / Shipped-in section. Per Hard Rule
9, the PR / commit / issue that delivered the decision does not
belong in the node — the audit trail lives in `git log`.

A six-line node that captures the decision cleanly beats a sixty-line
node that buries it. Tree readers scan, they do not study.

### Worked Examples

In the examples below, **"Trigger: …"** labels what prompted the
tree-write (a PR, a meeting note, a report). The labels are
meta-narration in this skill — they are not a body section template;
no `## Trigger` / `## Source` heading goes into the actual node (see
Hard Rule 9).

Some examples split `Belongs:` into `Belongs (What):` and `Belongs
(Why):` to make the Content Model distinction concrete; others
keep a single `Belongs:` line where the distinction is not
load-bearing. Both forms describe the same underlying boundary —
what survives in the node vs what stays in the source repo. The
split is teaching emphasis, not a separate convention.

**Trigger: PR adding a new caching layer.**
Belongs: "Service X owns the cache; other services read through Service
X's SDK"; "we chose Redis over Memcached because of pubsub support".
Does not belong: the cache key format, the eviction policy class, the
retry constants.

**Trigger: meeting note "we are moving billing to a new repo".**
Belongs: workspace map gets a new repo; ownership for billing shifts;
the `billing/` ↔ `platform/` boundary is updated.
Does not belong: migration timeline, release-day playbook, per-PR
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
after review" — that is timeline narration (Hard Rule 8). State the
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
— that is timeline narration (Hard Rule 8). Record the surviving
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

**Trigger: PR that flips a policy default — e.g. "approvals required"
goes from 1 to 0.**
Belongs: the *current* rule stated as fact ("approvals required = 0");
the *current* rationale (why 0 is the right number now), present-tense.
Does not belong: a `> 2026-XX-XX update:` banner, a "previously we
required 1 approval" sentence, a "since 5/29…" paragraph, a
"Superseded by…" footer. **Rewrite the relevant node in place** to
the new current state. The old state stays only in `git log` (and
any raw-archive domain your tree may have).

**Trigger: an existing tree node already carries a `## Source`
section that lists the PRs which delivered the decision.**
Pattern: the `## Source` body section is forbidden under Hard Rule
9, but the section often hides *substantive* content — open
follow-ups, known gaps, deferred items, surviving rationale — that
was tacked onto the bottom of the PR audit trail. Do not just
delete the section.
- *Delete*: the PR-id list, the "Shipped in #X" / "Landed in #Y"
  annotations, the "PR-by-PR audit trail" framing.
- *Move to a GitHub Issue*: any actionable work item the section
  carried (a pending fix, a deferred migration, an unresolved
  question, a known gap) — open a present-tense Issue in the
  relevant repo, dropping the PR id. Active tree nodes do not
  carry `## Work` or `## Future Work` sections; actionable work
  lives in Issues (see the team-practice node for the team's own
  rule on this).
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
  the Hard Rule 5 gate that must pass before any commit.

A simplified CLI surface (a structural `list`, a `verify`, and an
`upgrade`) is the design target; until that lands, map the tree with
standard tooling (`ls`, `Read`, `Grep`) and rely on `tree verify` as
the write gate. Everything else (opening PRs, fetching code, reading
the workspace binding) goes through standard tools (`git`, `gh`,
`Read`, etc.).
