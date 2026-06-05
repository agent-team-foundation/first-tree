---
name: first-tree-context
version: 0.6.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Context Tree operating guide. Covers what a Context Tree is, the source-system boundary, how to read the tree before acting, and how to write tree updates from a specific source (PR / doc / note). Load before any task that reads or writes context — including when the user pastes a PR / doc / note and says "reflect this in the tree", "update the tree from this", or "write this decision to the tree". For drift audits with no specific source attached, use `first-tree-sync`.
---

# First Tree — Context

Read this skill **before** any task that reads or writes the Context
Tree. It is the operating guide every agent shares: a few principles,
a small set of hard rules, and the judgment guidelines that turn them
into correct edits. There is no step-by-step workflow on purpose —
write is not a five-step procedure, it is a few hard rules plus
judgment.

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
- leaf `*.md` files capture one decision, constraint, or supersession
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
| A deprecation, supersession, or "we used to do X, now we do Y"     | Test fixtures, snapshot data, build / CI config  |
| A new relationship between two domains                             | Bug fixes that do not change a public contract   |
| Rationale that would not be obvious from the diff alone            | Refactors that preserve behaviour                |

## Reading the Tree

**Read the tree before you act on any instruction** — even ones that
look like pure code, CLI, or review work. In this org an instruction
is underspecified on its own; the tree supplies the background,
requirements, and constraints that make acting on it correct.

How to read:

- Start at the tree's root `NODE.md`. If the root also contains an
  `AGENT.md`, read that too — it carries org-wide rules every agent
  must follow before acting.
- Map the tree's structure with whatever exploration tool fits — `ls`,
  `Read` on `NODE.md`, or `Grep` for a keyword — then `Read` the
  specific nodes your task touches.
- Follow `soft_links` to neighbouring domains; they exist exactly so
  you don't have to re-derive a cross-domain decision.
- Read **eagerly, not lazily** — acting before reading is the #1
  source of advice that conflicts with reality. On scope shift to a
  new domain, repo, or owner, read those nodes first; in doubt,
  re-read.
- Where the tree's requirements or constraints **conflict with the
  instruction, the tree wins** — follow it and surface the conflict to
  the user. (Local memory is the opposite: it yields to the instruction.)

## Writing the Tree

Writing is **source-driven** — a specific PR, design doc, meeting note,
or pasted text motivates a specific edit. Without a source, there is
no write task; the right tool is then `first-tree-sync`.

### Hard Rules

These are non-negotiable. They are short on purpose — when in doubt,
follow them.

1. **Default to not writing.** A node nobody reads is worse than a
   missing node: a missing node is a question, a noisy node is a trap.
   Apply the Double Test (below) and if it does not pass cleanly,
   write nothing and tell the user why.
2. **Read before you write.** Before drafting any edit, read every
   related tree node — the target node, every `soft_links` neighbour,
   the parent domain `NODE.md`, and any ownership-adjacent
   `members/<id>/NODE.md` — and read the motivating source artefact
   in full (PR diff + linked issue + review comments, or the doc
   end-to-end). Confirm the draft does not contradict an existing
   decision before editing.
3. **Smallest correct edit.** Editing an existing node beats adding
   a leaf; adding a leaf beats opening a new domain. Opening a new
   top-level domain is a high-bar move that needs explicit
   justification.
4. **No diffs, no code detail.** Tree nodes capture the durable
   decision and the rationale, not implementation detail. Function
   signatures, class names, request shapes, retry constants live in
   the source repo. The tree records *what was decided and why*; the
   diff lives in the source PR.
5. **Every change links its source.** A tree node with no link back
   to its motivating PR / doc / note has no provenance and cannot be
   audited. Add the link.
6. **`first-tree tree verify` must pass before commit.** Non-zero
   exit blocks the commit. Fix the structure problem before opening
   a PR; do not paper over it.
7. **Ownership changes go through humans.** Do not unilaterally edit
   `owners`. Flag the change to the listed owner and let them decide.
8. **`decisionLocksCode: true` reverses the default.** Most drift
   resolves by updating the tree to match the code. A node carrying
   `decisionLocksCode: true` reverses that — the tree wins and any
   code drift escalates to a human. Set the flag only on explicit
   human instruction.

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

### Where Each Fact Goes

| Situation                                  | Where it goes                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| The decision belongs to an existing domain | Update that domain's `NODE.md` or add a leaf in that domain                           |
| The decision spans two domains             | Add a leaf in the more-specific domain; add a `soft_links` entry from the broader one |
| The decision is genuinely new              | Add a new domain directory with its own `NODE.md` (high-bar move)                     |
| Ownership change                           | Update `members/`, not a domain leaf                                                  |

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
  (see Hard Rule 8).

Body sections, in this order, omit any you do not need:

1. **Decision** — one paragraph stating the durable claim.
2. **Rationale** — why this decision; why the alternatives lost.
3. **Constraints** — what the decision implies for future implementations.
4. **Cross-Domain** — explicit references to other domains, when more
   context than `soft_links` is useful.
5. **Source** — link back to the PR, design doc, or note that
   motivated the node.

A six-line node that captures the decision cleanly beats a sixty-line
node that buries it. Tree readers scan, they do not study.

### Worked Examples

**Source: PR adding a new caching layer.**
Belongs: "Service X owns the cache; other services read through Service
X's SDK"; "we chose Redis over Memcached because of pubsub support".
Does not belong: the cache key format, the eviction policy class, the
retry constants.

**Source: meeting note "we are moving billing to a new repo".**
Belongs: workspace map gets a new repo; ownership for billing shifts;
the `billing/` ↔ `platform/` boundary is updated.
Does not belong: migration timeline, release-day playbook, per-PR
checklist.

**Source: a reviewer's nit about variable naming.**
Belongs: nothing. Naming is implementation detail.

**Source: a security review report.**
Belongs: constraints that came out of it ("session tokens must be
HMAC-signed before storage"); the accountable owner.
Does not belong: the specific vulnerabilities or how they were patched.

## CLI Surface

The Context-management CLI you actually depend on while reading or
writing is small. Today only one command is operationally required:

- `first-tree tree verify` — validate frontmatter and node structure;
  the Hard Rule 6 gate that must pass before any commit.

A simplified CLI surface (a structural `list`, a `verify`, and an
`upgrade`) is the design target; until that lands, map the tree with
standard tooling (`ls`, `Read`, `Grep`) and rely on `tree verify` as
the write gate. Everything else (opening PRs, fetching code, reading
the workspace binding) goes through standard tools (`git`, `gh`,
`Read`, etc.).

## Hand-Off

- Drift audit with no specific source attached → `first-tree-sync`
  (still owns broad audit; will be revisited separately).
- Binding an unbound repo / workspace to a tree → operator action,
  not an agent task.
