---
name: first-tree-seed
version: 0.1.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Initial-seeding skill for a freshly-minted Context Tree. Use exactly once per tree, right after Cloud onboarding finishes provisioning the workspace and the tree repo is still empty. Two phases. Phase 1 — structural-only deep read (filesystem walk → first-line meta reads → surgical content reads) that proposes a top + second-level domain skeleton from observed source signals, gets the user's approval, and lands as PR1. Phase 2 — parallel sub-agents (one per approved top-level domain) read code deeply within their assigned subtree, draft initial leaf nodes under a time budget, and return a coverage report so the user knows what was and was not extracted; the main agent consolidates everything into PR2. Use this skill only for the very first content pass on an empty tree — `first-tree-context` owns every subsequent incremental tree write from a specific source PR / doc / note.
---

# First Tree — Seed

Read this skill **before** drafting the first content into a freshly
provisioned Context Tree. It owns the one-time bootstrap from "Cloud
just gave me an empty tree repo" to "the tree has real top + second
level structure plus initial leaf nodes drawn from the bound source
repos". Every subsequent write — one PR at a time, one decision at a
time — belongs to `first-tree-context`, not here.

## When To Use This Skill

| Use `first-tree-seed`                                                 | Use a different skill                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cloud onboarding finished; the tree repo is empty (no top-level dirs) | The tree already has a domain structure → `first-tree-context` (incremental write)                   |
| First content pass on the bound sources                               | Audit drift between merged code and an existing tree → `first-tree-sync`                             |
| Triggered by the Web kickoff prompt at the end of onboarding          | Workspace is unbound → surface to a human (binding is a web-console operator action, not an agent's) |

The skill is **single-shot per tree**. If a previous seed already
landed (PR1 merged), do not re-run; route any further work through
`first-tree-context` or `first-tree-sync`.

## Required Reading

Before drafting anything, load these two skills. The hard rules they
carry govern every node this skill writes — seed does not invent its
own rules, it observes the existing ones during a special lifecycle
phase.

1. **`../first-tree/SKILL.md`** — pre-task hygiene (workspace binding,
   tree HEAD freshness, role-fork), communication principles, daemon
   invariants. Run the three pre-task checks before any tier-0 read.
2. **`../first-tree-context/SKILL.md`** — the Context Tree operating
   guide. Carries the source-system boundary, the Double Test, the
   Content Model (what / why / who), Node Shape, Hard Rules 1–9.
   **Every node this skill creates must satisfy those hard rules.**

## Trigger

Cloud onboarding's kickoff step injects a prompt into the first chat
that names this skill. The injection arrives because the tree the
operator just provisioned is detectably empty — typically signalled by
"no `NODE.md` at the tree root" or "the tree dir has only the default
`.git/` plus an empty README".

The skill **does not auto-fire** from any other context. If a human or
another agent invokes it on a non-empty tree, refuse with a one-line
explanation and point at `first-tree-context` or `first-tree-sync`.

Self-check before starting:

- `<workspaceRoot>/.first-tree/workspace.json` exists with non-empty
  `tree` + `sources` (workspace is bound).
- `<workspaceRoot>/<manifest.tree>/NODE.md` does **not** exist (tree
  is empty). Stop if it does.
- `<workspaceRoot>/<manifest.sources[i]>` is present on disk for every
  declared source. If a source is missing, surface to user and stop —
  do not seed from a partial workspace.

## The Two Phases

```
Phase 1 — Structure  (~3–10 min, main agent only)
  └─ Tiered structural read of every bound source
  └─ Propose top + second-level domain skeleton
  └─ User approves checklist
  └─ Create NODE.md stubs + members/<owner> + raw-context
  └─ PR1 on chore/seed-phase1-structure

User merges PR1 ────────────────────────────────────────────────

Phase 2 — Content    (parallel; ~10–20 min wall-clock)
  └─ Dispatch one sub-agent per approved top-level domain
  └─ Each sub-agent: deep-read its subtree, draft leaves, report coverage
  └─ Main agent: consolidate + cross-check + collect escalations
  └─ PR2 on chore/seed-phase2-content
```

The hand-off point between phases is the merge of PR1. Do not start
Phase 2 work before the user has signed off on the structure — the
sub-agent fan-out is expensive and Phase 2 inherits Phase 1's
structural decisions.

---

## Phase 1 — Structure

**Goal:** produce a top + second-level domain skeleton that reflects
the team's concern axes (not the codebase's directory layout), drawn
from observable signals across all bound source repos.

### Tiered exploration

Read in three tiers; escalate from one to the next only when the prior
tier left a specific question unanswered.

| Tier | Action                                                                                                                                                                                                                                                                                                            | Cost                  | Yields                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| 0    | Filesystem walk over every bound source. List directories and well-known meta files. Filter out build artefacts (`node_modules`, `dist`, `build`, `.next`, `.turbo`, `.venv`, `target`, `.git`). Count file extensions, package boundaries, presence of `docs/`, `infra/`, `terraform/`, `k8s/`, `.github/workflows/`. | seconds, even on 10k+ files | monorepo shape, package boundaries, docs hierarchy, ops signals, file-type distribution |
| 1    | First-line / first-paragraph reads of meta files surfaced by Tier 0: top `README.md`, every `packages/*/README.md`, `docs/*.md` first H1, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `package.json` description fields, `gh repo view --json description,topics,homepageUrl`. | 1–3 min total across all sources | one-sentence description per observed concept; product positioning; ops/contrib focus   |
| 2    | Surgical content read of a **specific** file that Tier 0+1 left ambiguous (e.g. `packages/foo/` exists, README is empty → read `packages/foo/src/index.ts` head 30 lines). Triggered per uncertainty, not as a blanket sweep.                                                                                       | 1–3 min per question, 0 if not needed | answer one structural question |

**Tier 2 is targeted, not exhaustive.** If you cannot articulate the
specific question Tier 2 will answer, do not do Tier 2 — you have
enough already. Sub-agents are allowed at this tier when multiple
independent Tier-2 questions exist, but the default is "main agent
reads in-line".

### From observations to domain candidates

Aggregate observations across all sources, then abstract:

- **Top-level domain candidates** describe a concern axis the team
  reasons about: e.g. `system/` for technical reality, `product/` for
  product intent, `customer/` for who is served, `marketing/` for how
  they are reached, `team-practice/` for working agreements, `goal/`
  for organisation-level direction.
- **No archetype templates.** Do not load a pre-baked "SaaS default"
  or "OSS default" set. Every candidate must be justified by a
  signal observed in the bound sources. A domain that the sources do
  not motivate is a domain that does not belong.
- **Second-level domain candidates** under each top-level emerge from
  the same observations. For `system/`, package boundaries and docs
  organisation are the strongest signals. For `product/` and
  `customer/`, README positioning and marketing-site content are the
  strongest signals.
- **Supporting structure is automatic, not a candidate.** Always
  create `members/<owner>/NODE.md` (owner = most-active recent
  contributor of the largest source) and `raw-context/NODE.md` (the
  intake bucket for meeting notes and explorations). These are
  scaffolding, not concern axes; do not put them in the user
  checklist.

The `first-tree-context` hard rule "add a directory only when ≥3
leaves are present or expected" applies as written. Phase 1 may open
a domain when ≥3 leaves are **foreseeable**; Phase 2's job is to
land them. There is no separate "provisional" lifecycle — a domain
that ends Phase 2 with 0 leaves is ordinary `first-tree-sync` work
later.

### User confirmation

Present the candidate skeleton as a markdown checklist in chat,
grouped by recommendation strength, with one-line evidence per item.
Example:

```
Based on a structural read of N source repo(s), here is the proposed
top + second-level skeleton:

system/                       [recommended ON]
 ├─ architecture.md           ← evidence: docs/architecture.md exists
 ├─ cli/                      ← evidence: apps/cli/ + docs/cli-reference.md
 └─ cloud/                    ← evidence: packages/server/ + packages/web/

product/                      [recommended ON, weak signal]
 └─ evidence: README L1-3 frames a product positioning

team-practice/                [recommended ON]
 └─ evidence: CONTRIBUTING.md + AGENTS.md describe team workflow

customer/                     [recommended OFF]
 └─ evidence: no marketing site repo, no user-facing positioning

Reply with the domains you want to open (default: all "ON"). You can
add custom domains the signals did not surface.
```

Wait for the user's reply. Default behavior on plain "ok" / "yes" is
"create everything marked ON, skip everything marked OFF". The user
may toggle individual items, drop the OFF defaults entirely, or add
their own top-level domains.

### What to write

After the user confirms, create on the seed branch:

- `<tree>/NODE.md` — root index, with `## Active Domains`,
  `## Members`, `## Raw Context` sections enumerating what was opened.
  Description paragraph drawn verbatim from the most-authoritative
  source README first paragraph, or summarised in ≤30 words if that
  paragraph is too long.
- `<tree>/members/<owner>/NODE.md` — owner identity + `## Recent
  Contributors` list (top 5 from `git log --since='6 months ago'`).
- `<tree>/raw-context/NODE.md` — one-paragraph statement of purpose
  ("intake for meeting notes, explorations, and material not yet
  promoted to a durable domain").
- For each approved top-level domain: a `<tree>/<domain>/NODE.md`
  stub with `title`, `owners`, one-paragraph statement of what the
  domain covers, and a `## Leaves` section listing the approved
  second-level entries (or "(none yet — Phase 2 will populate)" when
  the domain is opened without a second-level skeleton).
- For each approved second-level entry: a sub-`NODE.md` stub or a
  placeholder `.md` file, again with `title`, `owners`, and a
  one-paragraph charter — no leaf content yet.

Every node carries `title` + `owners` frontmatter (required by
`first-tree tree verify`). Use the workspace's primary owner as the
default `owners` value; the user reassigns ownership in Phase 2 or
later. Set `lastReviewed` to today; do not set `decisionLocksCode`
(it defaults false).

### PR1

- Branch: `chore/seed-phase1-structure`
- Show the diff to the user before push.
- Commit message: `chore: seed initial tree structure from <N> source repo(s)`
- PR title: `Seed Phase 1 — initial tree structure`
- PR body: enumerate which top + second-level domains were opened
  and which were proposed-but-skipped (one line each, with the
  user's reason if given). Do not list the source PRs / commits — the
  audit trail is `git log`.
- Run `first-tree tree verify --tree-path <tree>` locally before
  opening the PR. Non-zero exit blocks (`first-tree-context` Hard
  Rule 5).
- Stop after the PR is open. Do **not** start Phase 2 work until the
  user has explicitly merged PR1.

---

## Phase 2 — Content

**Goal:** populate each approved top-level domain with initial leaf
nodes drawn from a real read of the bound source code, under a time
budget, with explicit coverage reports surfacing what was and was not
extracted.

### Trigger

The user signals merge of PR1 in chat (or the agent observes the
PR1 branch removed from the remote and merged into `main`). The
main agent then dispatches Phase 2.

### Sub-agent dispatch

Spawn one sub-agent per approved top-level domain (not per
second-level — second-level is the sub-agent's working surface, not
its scope). Domains too large for one sub-agent (deep nested package
trees with many packages) may be split by second-level on the main
agent's judgement, with a note in the PR2 body explaining the split.

All sub-agents work in parallel on the same git branch
`chore/seed-phase2-content`, each writing only into its assigned
subtree path. Their working paths are disjoint by construction;
git-level conflicts are not expected. The main agent serialises any
needed cross-cutting commits at the end.

### Sub-agent contract

Each sub-agent receives:

- The path of its assigned subtree (e.g. `<tree>/system/`).
- The Phase 1 stub it inherits (NODE.md text + the second-level
  entries already laid out, if any).
- The list of bound sources and their on-disk paths.
- The time budget (default 15 minutes wall-clock; the main agent
  may set a lower budget for thin domains).
- The hard rules from `first-tree-context` (loaded by reference).

The sub-agent's authority within its assigned subtree:

| Action                                                                                                                                | Authority      |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Restructure inside its subtree (split / merge second-level, add third-level, rewrite NODE.md descriptions, adjust internal soft_links) | full           |
| Add new sub-domain branches (new sub-directories) under its assigned top-level                                                        | full           |
| Modify a sibling domain or a parent NODE.md                                                                                           | **forbidden**  |
| Create a new top-level domain                                                                                                         | **forbidden**  |
| Modify `members/`, `raw-context/`, or other supporting structures                                                                     | **forbidden**  |

Forbidden actions become entries in the sub-agent's
**escalations list**, returned to the main agent: "I observed N
decisions that suggest a new top-level domain `security/`; I did not
create it." The main agent aggregates these for the user.

### Stopping discipline

Sub-agents **do not chase completeness**. Stop when any of these
holds, whichever comes first:

- Time budget exhausted.
- Three consecutive code reads produced no new candidate leaf (the
  domain's high-value veins are mined out).
- Twelve leaves have been drafted in this domain (a single seed pass
  should not create a sixty-leaf domain — defer the rest).

### Mandatory coverage report

Every sub-agent returns, alongside its drafted nodes, a structured
coverage report:

```
## Coverage in <subtree>

Read:
- <path> (full)
- <path> (sampled)
- <path> (first paragraph)

Skipped (budget / out-of-scope):
- <path> — reason
- <path> — reason

Leaves created: N (see commits <sha-range>)

Known gaps:
- <one-line description of an unread area worth flagging>
- <one-line description of an open question worth flagging>

Escalations (forbidden actions surfaced for main agent):
- <one-line description>
```

The main agent stitches every sub-agent's coverage report into the
PR2 description so the user can see, at merge time, exactly what was
and was not covered — and decide whether to accept, manually fill, or
re-run seed with a focused prompt.

### Main agent consolidation

After all sub-agents return:

1. Resolve naming inconsistencies across subtrees (different
   sub-agents may have named the same cross-cutting concept
   differently — normalise to one name).
2. Verify `soft_links` references resolve. Where a sub-agent linked
   to a sibling subtree's leaf that does not exist, drop the link
   and surface as a known gap.
3. Aggregate escalations into a single section in the PR2 body
   ("Sub-agents flagged the following as out of their scope; user to
   decide whether to act now or later").
4. Run `first-tree tree verify --tree-path <tree>` from a clean
   checkout of `chore/seed-phase2-content`. Non-zero blocks.

### PR2

- Branch: `chore/seed-phase2-content`
- One commit per sub-agent (preserve domain boundaries for review),
  plus one consolidation commit at the end.
- PR title: `Seed Phase 2 — initial leaves across <N> domain(s)`
- PR body sections, in order:
  1. **Coverage report** — concatenated coverage reports from every
     sub-agent.
  2. **Escalations** — items sub-agents flagged as out of scope.
  3. **Known gaps** — the union of all per-domain known gaps.
  4. **Next steps** — point the user at `first-tree-context` for any
     follow-up writes and `first-tree-sync` for periodic drift audits.

After PR2 opens, the seed skill is done. Subsequent writes are owned
by `first-tree-context`; subsequent drift audits by
`first-tree-sync`.

---

## Hard Rules

These are inherited from `first-tree-context` and listed here only to
make them visible at the seed-specific surface.

- **Smallest correct edit.** A six-line NODE.md that captures the
  domain's charter beats a sixty-line one that buries it. Phase 1
  stubs are short on purpose; Phase 2 leaves are short on purpose.
- **No diffs, no code detail in nodes.** Function signatures,
  request shapes, retry constants stay in the source repo. The tree
  records the durable decision and the rationale.
- **No PR references in node bodies.** The audit trail for "which
  PR delivered this seed" lives in `git log`. Nodes carry their
  present-tense claim alone.
- **No history.** Nodes state current truth. Past states live in
  `git log`. Do not preface a node with "Originally we…" or
  "Update 2026-XX-XX:".
- **`first-tree tree verify` must pass before PR1 and PR2 land.**
  Hard Rule 5 from `first-tree-context`. Non-zero exit blocks the
  commit.
- **Ownership changes go through humans.** Phase 1 sets `owners` to
  the workspace's primary owner as the default; reassignment is the
  user's job, not the agent's.
- **Do not invent.** If a fact is not in the read signals, leave it
  out. A missing node is a question; a fabricated node is a trap.

## What This Skill Does NOT Do

- Bind the workspace or provision the tree repo — those are
  operator actions taken from the web console before this skill is
  ever invoked.
- Install GitHub automation (validate workflows, rulesets,
  CODEOWNERS) — out of scope. If the team wants those, they are
  separate follow-on workflows after seed lands.
- Touch `AGENTS.md` / `CLAUDE.md` managed blocks at the tree root —
  those are owned by the CLI runtime.
- Generate content beyond what the signals support. If a candidate
  domain has weak evidence and the user does not opt it in, leave it
  out.
- Run twice on the same tree. If PR1 has already merged, hand off
  to `first-tree-context` or `first-tree-sync`.

## References

- [`../first-tree/SKILL.md`](../first-tree/SKILL.md) — pre-task
  hygiene, communication principles, CLI namespace map
- [`../first-tree-context/SKILL.md`](../first-tree-context/SKILL.md)
  — Context Tree operating guide, Hard Rules 1–9, Node Shape,
  source-system boundary
- [`../first-tree-sync/SKILL.md`](../first-tree-sync/SKILL.md) —
  ongoing drift audit, owned hand-off back into
  `first-tree-context`
