---
name: first-tree-seed
version: 0.2.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: One-time bootstrap for a brand-new, still-unseeded Context Tree. When the team has no tree yet, creates and binds the repo with `first-tree tree init` (Step 0); then delivers an initial top + second-level domain skeleton drawn from the bound source repos (PR1, user approves), then initial leaf-node content for each approved domain with explicit coverage reporting (PR2). Use right after onboarding, before any domain structure exists. Refuses on any already-seeded tree. Do not use to write an incremental update from a specific PR / doc / note — that is `first-tree-write`. Do not use for broad maintenance or drift-audit work on an existing tree.
---

# First Tree — Seed

Read this skill **before** drafting the first content into a new Context
Tree. It owns the one-time bootstrap from "the team has no tree yet (or a
freshly created empty one)" to "the tree has real top + second level
structure plus initial leaf nodes drawn from the bound source repos" —
including creating the repo itself with `first-tree tree init` when none
exists (Step 0). Every subsequent write — one PR at a time, one decision
at a time — belongs to `first-tree-write`, not here.

## When To Use This Skill

| Use `first-tree-seed`                                                 | Use a different skill                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The team has no tree yet, **or** a bound tree with no domain structure (no top-level dirs) | The tree already has a domain structure → `first-tree-write` (incremental source-driven write)       |
| First content pass on the bound sources                               | Broad maintenance or drift-audit work on an existing tree                                            |
| Invoked by name — by a human, an agent, or an onboarding kickoff prompt (see Trigger + Step 0) | Not an org admin, or `gh` unauthenticated, and the team has no tree — Step 0 can't create it; surface the gap to a human |

The skill is **single-shot per tree**. If a previous seed already
landed (PR1 merged), do not re-run; route any further work through
`first-tree-write` or a focused maintenance task.

## Required Reading

Before drafting anything, load this skill. The hard rules it carries
govern every node this skill writes — seed does not invent its own
rules, it observes the existing ones during a special lifecycle phase.

1. **`../first-tree-write/SKILL.md`** — the Context Tree operating
   guide. Carries the source-system boundary, the Double Test, the
   Content Model (what / why / who), Node Shape, Hard Rules 1–9.
   **Every node this skill creates must satisfy those hard rules.**

## Trigger

This skill runs whenever a human or another agent invokes it. **Step 0
below is the gate** — it resolves whether the team already has a Context
Tree, creates one with `first-tree tree init` when they do not, and
confirms the tree is still unseeded before Phase 1 begins. The prompt's
origin is not the gate; the tree's state is.

Once the seed has landed (PR1 merged), Step 0's already-seeded check
fires and the skill refuses; route subsequent source-driven work through
`first-tree-write`, or handle maintenance with a focused, explicitly-scoped
task.

## Step 0 — Ensure an unseeded tree exists (three states; stop on refuse)

Before reading any source, resolve which of three states the team's
Context Tree is in and act accordingly.

**A — No tree yet.** The workspace is not bound to a tree: either
`<workspaceRoot>/.first-tree/workspace.json` has no non-empty `tree`
field, or the team has no `context_tree` binding. This is the
agent-driven creation path — create the tree with the user's local `gh`:

```bash
first-tree tree init --title "<team display name>"
```

`tree init` creates the repo under the team's GitHub App installation
account, seeds a minimal valid tree (root `NODE.md`, a `members/` index,
and the creator's member node), pushes, and binds the org's
`context_tree` setting. It is **admin-only** and needs an authenticated
`gh`; if the caller is not an org admin, or `gh` is unauthenticated,
surface that exact gap and stop (binding a team tree is an admin action).
Take the team display name from the chat context / `first-tree agent
status`. After it succeeds the tree is bound and in state **B** — proceed.
(Make sure the local tree clone is at `<workspaceRoot>/<manifest.tree>` so
Phase 1 can read and write it; follow the Tree Location protocol in your
`AGENTS.md` / `CLAUDE.md` briefing if it is not already there.)

**B — Bound but unseeded.** The tree is bound and holds at most the
bootstrap set — a root `NODE.md`, a `members/` index, and creator member
node(s) — with **no top-level domain directory** yet. This is the normal
seed entry, whether the bootstrap came from Step 0's `tree init` above or
from an earlier provision. Proceed to Phase 1. Phase 1 layers the domain
skeleton + `raw-context` **on top of** whatever bootstrap nodes already
exist: **extend** the root `NODE.md` index and the `members/` tree rather
than recreating them (a bootstrap root node / members index is expected,
not a conflict).

**C — Already seeded.** The tree has one or more **top-level domain
directories** — any directory directly under `<workspaceRoot>/<manifest.tree>/`
other than `.git/`, `.first-tree/`, `.github/`, `members/`, and
dotfile-prefixed dirs. Refuse with a one-line explanation pointing at
`first-tree-write` for incremental source-driven writes, or ask for a
focused maintenance scope. Do **not** delete nodes to force a re-seed —
that is human-owned.

**In every state, also require all declared sources on disk.** Each source
clone lives at `<workspaceRoot>/<manifest.sourcesRoot>/<manifest.sources[i]>`
— the runtime writes `sourcesRoot: "source-repos"`, so the path is
`<workspaceRoot>/source-repos/<name>` (a legacy flat manifest omits
`sourcesRoot` and keeps sources at `<workspaceRoot>/<name>`). Every entry
must exist (each is a **bare** clone — see *Materialize source read
worktrees* below). A missing source means the workspace is
half-provisioned; surface to the user and stop. Do not seed from a partial
workspace.

### Materialize source read worktrees

Under the agent-managed repo model the declared sources are **bare**
clones (a git object store, no working tree) — you cannot `ls` or read
files at the clone path directly. Resolve each source's bare-clone path
from the manifest's `sourcesRoot` (do NOT hard-code it — the field is
optional):

- `sourcesRoot` present (current manifests, value `source-repos`):
  `<source-clone>` = `<workspaceRoot>/<sourcesRoot>/<source>`
  (e.g. `<workspaceRoot>/source-repos/<source>`)
- `sourcesRoot` absent (legacy flat manifest):
  `<source-clone>` = `<workspaceRoot>/<source>`

Before any structural read, materialize one read worktree per source off
its latest default branch, following the **Worktrees** protocol in your
`AGENTS.md` / `CLAUDE.md` briefing:

```bash
# for each <source> in manifest.sources, with <source-clone> resolved as above:
git -C <source-clone> fetch origin
git -C <source-clone> worktree add <workspaceRoot>/worktrees/seed-<source> origin/main
```

Every "read every bound source" / Tier 0–2 scan in Phase 1 operates on
these read worktrees, not the bare clone paths. Remove them
(`git -C <source-clone> worktree remove <path>`) once both PRs are open.

## The Two Phases

```
Phase 1 — Structure  (~3–10 min, main agent only)
  └─ Tiered structural read of every bound source
  └─ Propose top + second-level domain skeleton
  └─ User approves checklist
  └─ Create NODE.md stubs + members/<owner> + raw-context
  └─ PR1 on chore/seed-phase1-structure

User merges PR1 ────────────────────────────────────────────────

Phase 2 — Content    (parallel; ~10–20 min wall-clock per batch)
  └─ Allocate sub-agents (cap 6 concurrent; split big top-levels,
     merge thin ones, batch dispatch when total work units > 6)
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
| 0    | Filesystem walk over every bound source's read worktree (see *Materialize source read worktrees*): **one listing pass per source** (a single `find`-style enumeration, depth-capped at 3–4 levels on huge repos), not repeated re-walks. List directories and well-known meta files. Filter out build artefacts (`node_modules`, `dist`, `build`, `.next`, `.turbo`, `.venv`, `target`, `.git`). Count file extensions, package boundaries, presence of `docs/`, `infra/`, `terraform/`, `k8s/`, `.github/workflows/`. | seconds, even on 10k+ files | monorepo shape, package boundaries, docs hierarchy, ops signals, file-type distribution |
| 1    | First-line / first-paragraph reads of meta files surfaced by Tier 0: top `README.md`, every `packages/*/README.md`, `docs/*.md` first H1, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `package.json` description fields, `gh repo view --json description,topics,homepageUrl` (skip silently on **any** failure — 4xx, missing token, no network, no `gh` binary; READMEs are the fallback). | 1–3 min total across all sources | one-sentence description per observed concept; product positioning; ops/contrib focus   |
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
  for organisation-level direction. On a well-factored monorepo the
  concern axes and the package layout may largely coincide — that is
  fine. The rule guards against blindly mirroring directories, not
  against agreeing with a good layout; what matters is that each
  candidate is justified as a concern the team reasons about, even
  when the directory of the same name happens to exist.
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
  checklist as toggles — but **do compute the primary owner now**
  (one `git log` per source, seconds) and show the derived name in
  the confirmation message, so the user confirms structure and owner
  in one round-trip instead of being asked twice.
- **ON / OFF marking rule.** Mark a candidate **ON** when ≥ 2
  independent signals support it, or one strong structural signal
  (a dedicated package, repo, or docs section). Mark it
  **ON, weak signal** when exactly one soft signal supports it (a
  README phrase, a single doc) — recommended but flagged so the user
  knows the evidence is thin. Mark it **OFF** when you considered it
  (because it is a common concern axis) but found no signal in the
  sources; listing OFF candidates shows the user what was looked at
  and rejected, which is itself information.

The `first-tree-write` hard rule "add a directory only when ≥3
leaves are present or expected" applies as written. Phase 1 may open
a domain when ≥3 leaves are **foreseeable**; Phase 2's job is to
land them. There is no separate "provisional" lifecycle — a domain
that ends Phase 2 with 0 leaves is ordinary follow-up maintenance
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
 └─ evidence: README L1-3 frames a product positioning (single soft
              signal — flagged so you know the evidence is thin)

team-practice/                [recommended ON]
 └─ evidence: CONTRIBUTING.md + AGENTS.md describe team workflow

customer/                     [recommended OFF]
 └─ evidence: no marketing site repo, no user-facing positioning

Proposed primary owner: gandy (412 commits in the last 6 months) —
say so if someone else should own the seed.

Reply with the domains you want to open (default: all "ON"). You can
add custom domains the signals did not surface.
```

Wait for the user's reply. Default behavior on plain "ok" / "yes" is
"create everything marked ON, skip everything marked OFF". The user
may toggle individual items, drop the OFF defaults entirely, or add
their own top-level domains. **Accept free-form replies** — the
box-drawing layout above is for reading, not a form the user must
echo back. "open system and ops, skip customer, also add compliance"
is a complete answer; interpret it and restate the final set in one
line before writing.

**This user-checklist step is what satisfies `first-tree-write`'s
"top-level domains require explicit human-owner approval" rule.**
The main agent proposes candidates with evidence; the human is the
one who actually opens each one. Without an explicit "yes" from the
user, do not create any top-level domain — even ones marked
"recommended ON".

### What to write

After the user confirms, create on the seed branch:

- `<tree>/NODE.md` — root index, with `## Active Domains`,
  `## Members`, `## Raw Context` sections enumerating what was opened.
  Description paragraph drawn verbatim from the most-authoritative
  source README first paragraph, or summarised in ≤30 words if that
  paragraph is too long.
- `<tree>/members/<owner>/NODE.md` — see frontmatter spec below.
  Body has the owner's identity line plus a `## Recent Contributors`
  list (top 5 from `git log --since='6 months ago'`).
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

### Frontmatter shape

Domain and leaf nodes carry the standard shape:

```yaml
---
title: "<noun phrase>"   # default = directory name titlecased (e.g. system/ → "System")
owners: [<primary owner>] # one entry; user reassigns later
---
```

Member nodes carry the extended shape required by
`first-tree tree verify`'s member validator:

```yaml
---
title: "<github handle>"
owners: [<github handle>]
type: human                # or "agent" — agents only when seeding an agent-team workspace
role: "Owner"              # neutral default; user adjusts to "Engineer" / "Product" / etc.
domains:                   # non-empty; default = the list of top-level domains opened in Phase 1
  - <domain-1>
  - <domain-2>
---
```

Notes on defaults:

- **Primary owner** = the most-active recent contributor across the
  bound sources, computed from `git log --since='6 months ago'
  --format='%aN <%aE>' | sort | uniq -c | sort -rn | head -1`. Use
  the GitHub handle when `gh repo view` resolves the email; fall
  back to the `%aN` author name otherwise. Compute this **during
  Phase 1 exploration** and surface it in the confirmation checklist
  (see above) — the user's reply to that checklist is the owner
  confirmation; do not ask a second time unless the derivation was
  ambiguous (e.g. two contributors within ~10% of each other).
- **Member-node `role`** defaults to `"Owner"` because seed does
  not know the real role. Validator only requires non-empty; the
  user adjusts later.
- **Member-node `domains`** defaults to the list of opened
  top-level domain names (one entry per opened domain). Validator
  requires non-empty.
- Do **not** set `lastReviewed`. That field marks owner-reviewed
  state and is written only after a real owner review;
  stamping it on a bootstrap node makes unreviewed content look
  reviewed and hides it from future audits.
- Do **not** set `decisionLocksCode` (defaults false).

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
  opening the PR. Non-zero exit blocks (`first-tree-write` Hard
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

The user **re-pings the chat** after merging PR1 — that ping is the
only sanctioned start signal. The agent does **not** poll the remote,
the inbox, or any other source between phases; the seed skill is not
running between PR1 and PR2. When the ping arrives, run a fresh
self-check that PR1's structure is actually on the tree's default
branch before dispatching sub-agents — protects against the case
where the user pinged before merging, or merged a different branch.
Resolve the default branch name dynamically rather than hard-coding
`main` (some tree repos use `master` / `trunk`):

```bash
git -C <tree> fetch origin
DEFAULT=$(git -C <tree> symbolic-ref refs/remotes/origin/HEAD | sed 's|^refs/remotes/origin/||')
git -C <tree> ls-tree "origin/$DEFAULT" -- <top-level>  # for each approved domain
```

### Sub-agent allocation

Phase 2 must balance parallelism against three costs: token spend,
main-agent consolidation complexity, and the user's PR2 review
burden. The allocation policy below caps each batch at 6 concurrent
sub-agents and uses queue-batched dispatch so no approved domain is
deferred.

**No sub-agent dispatch available?** Some runtimes give the seeding
agent no sub-agent / task-dispatch tool (and sub-agents themselves
never get one — do not design nested fan-out). Fall back to
**sequential self-dispatch**: the main agent works through the same
queue one unit at a time, under the same per-unit contract — subtree
scope, time budget, stopping discipline, and a coverage report per
unit. Wall-clock is slower; the outputs and the PR2 shape are
identical. Everything below that says "sub-agent" applies to a
self-dispatched unit unchanged, except the parallel-write-safety
rules, which become trivial. **In sequential mode, still defer all
git commits until after the consolidation pass** — name normalisation
and the soft_links resolution check happen across every unit's
output and may rewrite earlier drafts; committing per-unit inline
would force consolidation fixes into extra commits and blur the
per-unit `git log` boundaries that PR2 review depends on.

**Concurrency cap: 6 sub-agents per batch.** Empirical limit.
Beyond this, wall-clock savings flatten while token cost and
consolidation overhead grow. Adjust in a future skill version if
real usage proves the number too low or too high.

**Default allocation: one sub-agent per approved top-level domain.**
When the user approved N ≤ 6 top-level domains and none meet the
split criteria below, dispatch one sub-agent per top-level. The
sub-agent's scope is the whole top-level subtree; second-level
entries are its working surface, not separate units.

**Split a top-level into multiple sub-agents** (one per second-level
under it). Splitting is a **cost decision**: split when the projected
work for one sub-agent exceeds what its budget can absorb. The
structural test is only the **eligibility filter** — a split needs
natural seams to split along. Both must hold:

1. *Eligibility:* the top-level has **≥ 3 second-level entries**
   opened in Phase 1 (fewer means no clean seams; an over-budget
   2-entry domain gets a bigger budget, not a split).
2. *Cost:* any of these indicators says one sub-agent's budget is
   not enough:
   - Source aggregate signal weight for this top-level ≥ 30 files
     of Tier-1 meta material to read (like the 6-cap, an empirical
     threshold — adjust in a future skill version if real usage
     proves it wrong).
   - A source repo / package is **dedicated to one specific
     second-level** (e.g. `apps/cli/` maps naturally to
     `system/cli/`). The mapping is then 1 source package →
     1 sub-agent.
   - The main agent's estimate of total work would push a single
     sub-agent past the 20-minute budget. Estimate it mechanically:
     ~1 min per Tier-1 meta file in scope, plus ~2–3 min per open
     Tier-2 question carried over from Phase 1, plus ~2 min per
     expected leaf for drafting.

Each split sub-agent's authority shrinks to its assigned
second-level path. It cannot touch sibling second-levels under the
same top-level — those belong to their own sub-agents and the
authority table's "modify a sibling domain's files = forbidden" rule
applies between split siblings, not just between top-level
siblings.

**Merge multiple thin top-levels into one sub-agent** when each
top-level has ≤ 2 source signals (counted as distinct Tier-1 meta
hits — the files / `gh` fields that motivated the domain in Phase 1)
AND ≤ 1 leaf expected **to be drafted by Phase 2 in this seed run**
(not "ever"). Weigh the **commit-boundary cost** before merging: a
merged pair lands as one commit spanning two domains, which blurs
the per-domain review boundary PR2 otherwise preserves. Merge only
when both domains are thin enough that the combined commit is still
trivially reviewable; when in doubt, run the thin domain as its own
quick work unit instead. A merged sub-agent's authority covers
**both assigned top-level paths in full** — the
"sibling = forbidden" rule applies between work units, not inside a
merged unit's pair. Surface the pairing in the PR2 body so the user
sees why one commit spans two domains.

**Batched dispatch when total work units > 6.** Maintain a queue of
work units (one per top-level, plus split children, minus merged
pairs). Fan out the first 6; as any sub-agent returns its drafts +
coverage report, immediately dispatch the next from the queue.
Continue until the queue is empty. **No work unit is deferred to
"Known Gaps" — every approved domain is seeded eventually**, just
across multiple waves. Wall-clock for a queue of ~12 ends up roughly
2× a single batch's runtime, not a linear blow-up, because the
slowest sub-agent in batch N gates the start of batch N+1 only if
its slot is the last to free.

Record the actual allocation (splits, merges, batches) in the PR2
body so the user can see why each commit covers the subtree it does
— and so they can spot if the main agent split or merged something
they would have left alone.

### Parallel write safety

Sub-agents run in parallel and may touch the filesystem simultaneously.
To keep them out of `.git/index.lock` contention and out of each
other's commit history, enforce two invariants:

1. **Sub-agents write files only.** They use Read / Write / Edit
   against `<tree>/<assigned-subtree>/` paths but do **not** call
   `git add`, `git commit`, `git push`, or any other git-mutating
   command. Their disjoint sub-paths guarantee filesystem-level safety.
2. **The main agent serialises every git operation.** After all
   sub-agents return their drafts + coverage reports, the main agent
   runs the consolidation pass (below), then groups files by
   sub-agent and lands one commit per sub-agent (`git add
   <sub-path>/... && git commit -m "..."`) on
   `chore/seed-phase2-content`. This keeps domain boundaries visible
   in `git log` without ever risking concurrent index writes.

### Sub-agent contract

Each sub-agent receives:

- The path of its assigned subtree (e.g. `<tree>/system/`).
- The Phase 1 stub it inherits (NODE.md text + the second-level
  entries already laid out, if any).
- The list of bound sources and their on-disk paths.
- The time budget (default 15 minutes wall-clock; the main agent
  may set a lower budget for thin domains).
- The hard rules from `first-tree-write` (loaded by reference).
- The **leaf shape target**: **up to ~60 lines** per leaf, structured
  as `## Decision` / `## Rationale` / `## Constraints` (matching
  `first-tree-write`'s node shape; omit a section you don't need).
  Shorter is better when the signal is thin — a six-line node that
  captures the decision cleanly beats a sixty-line node that buries
  it; do not pad to hit a length. Consistently longer is a smell
  that implementation detail is leaking in; push it back to the
  source repo and keep the durable claim.

The sub-agent's authority within its assigned subtree:

| Action                                                                                                                                | Authority      |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Restructure inside its subtree (split / merge second-level, add third-level, rewrite NODE.md descriptions, adjust internal soft_links) | full           |
| Add new sub-domain branches (new sub-directories) under its assigned top-level                                                        | full           |
| Write `soft_links:` entries that **point into** sibling subtrees (read-only cross-domain reference; target file is not modified)      | full           |
| Modify a sibling domain's files or a parent NODE.md                                                                                   | **forbidden**  |
| Create a new top-level domain                                                                                                         | **forbidden**  |
| Modify `members/`, `raw-context/`, or other supporting structures                                                                     | **forbidden**  |
| Run any `git` command (`add` / `commit` / `push` / `checkout` / ...) — the main agent serialises git ops                              | **forbidden**  |

Forbidden actions become entries in the sub-agent's
**escalations list**, returned to the main agent: "I observed N
decisions that suggest a new top-level domain `security/`; I did not
create it." The main agent aggregates these for the user.

### Stopping discipline

Sub-agents **do not chase completeness**. Stop when any of these
holds, whichever comes first:

- **Time budget exhausted.** Wall-clock since dispatch ≥ assigned
  budget (default 15 min).
- **Three consecutive Read / Grep tool calls returned no new
  candidate leaf.** One tool call = one stop-check tick; an
  exploratory `Grep` that turns up nothing counts the same as a
  `Read` of a file that has nothing tree-worthy. After three ticks
  in a row, the domain's high-value veins are mined out.
- **Twelve leaves drafted in this domain.** Empirical cap from
  observing real seed runs; not a hard architectural limit. A single
  seed pass should not create a sixty-leaf domain — defer the rest
  to `first-tree-write` writes after the user has reviewed PR2.
  Adjust in a future skill version if real usage shows the number is
  consistently too low or too high.

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

Use exactly three read-depth tags, so reports aggregate cleanly
across sub-agents:

- `(full)` — the entire file was read.
- `(sampled)` — representative sections / head reads, not the whole
  file.
- `(first paragraph)` — only the first paragraph or first H1 block.

The main agent stitches every sub-agent's coverage report into the
PR2 description so the user can see, at merge time, exactly what was
and was not covered — and decide whether to accept, manually fill, or
re-run seed with a focused prompt.

### Main agent consolidation

After all sub-agents return:

1. Resolve naming inconsistencies across subtrees (different
   sub-agents may have named the same cross-cutting concept
   differently — normalise to one name).
2. Verify `soft_links` references resolve — mechanically, not by
   eyeball, and with the **same criteria `tree verify` enforces**: a
   valid target is either an existing `.md` file, or an existing
   directory that contains a `NODE.md`. A bare `test -e` is not
   enough — a directory without `NODE.md` (or a non-markdown file)
   exists on disk but still fails verify. Extract every
   `soft_links:` entry from every drafted node and check:

   ```bash
   # entries are tree-root-relative, e.g. /system/cli.md
   t="<tree>${entry}"
   { [ -f "$t" ] && case "$t" in *.md) true;; *) false;; esac; } \
     || [ -f "$t/NODE.md" ] \
     || echo "DANGLING: ${src} -> ${entry}"
   ```

   Where a sub-agent linked to a target that fails this check, drop
   the link and surface it as a known gap.
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
  4. **Next steps** — point the user at `first-tree-write` for any
     follow-up source-driven writes and describe any broad maintenance
     gaps as focused follow-up tasks.

After PR2 opens, the seed skill is done. Subsequent writes are owned
by `first-tree-write`; subsequent maintenance uses focused tasks with
explicit scope.

### Recovery path: PR1 merged, Phase 2 abandoned

A user may merge PR1 and then never come back for Phase 2 (life
happens, the team is busy, the kickoff agent crashed). The tree
ends up with real structure but zero leaves. **This is not a
re-seed condition** — the seed self-check sees a populated tree
(`<tree>/<domain>/NODE.md` files exist) and refuses. Instead:

- Future writes go through `first-tree-write` one source at a
  time, exactly as they would on any other live tree.
- A team that wants to back-fill the missing leaf content can ask for
  a focused maintenance pass with explicit source scopes; any actual
  writes still go through `first-tree-write` one source at a time.

Communicate this fallback to the user in PR1's body so the choice
is visible: "If you merge PR1 without coming back for Phase 2, the
tree is fully usable but empty; later writes go through
`first-tree-write` or a focused maintenance follow-up."

---

## Hard Rules

These are inherited from `first-tree-write` and listed here only to
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
  Hard Rule 5 from `first-tree-write`. Non-zero exit blocks the
  commit.
- **Ownership changes go through humans.** Phase 1 sets `owners` to
  the workspace's primary owner as the default; reassignment is the
  user's job, not the agent's.
- **Do not invent.** If a fact is not in the read signals, leave it
  out. A missing node is a question; a fabricated node is a trap.

## What This Skill Does NOT Do

- Run the Cloud one-click **server** bootstrap. When the team has no tree
  (Step 0 state A), seed creates and binds it with `first-tree tree init`
  (the user's local `gh`), not the server `/initialize` path — the two
  coexist. Seed does not write the workspace-root `workspace.json`; that
  stays a runtime concern.
- Install GitHub automation (validate workflows, rulesets,
  CODEOWNERS) — out of scope. If the team wants those, they are
  separate follow-on workflows after seed lands.
- Touch `AGENTS.md` / `CLAUDE.md` managed blocks at the tree root —
  those are owned by the CLI runtime.
- Generate content beyond what the signals support. If a candidate
  domain has weak evidence and the user does not opt it in, leave it
  out.
- Run twice on the same tree. If PR1 has already merged, hand off
  to `first-tree-write` or a focused maintenance task.

## References

- [`../first-tree-write/SKILL.md`](../first-tree-write/SKILL.md)
  — Context Tree operating guide, Hard Rules 1–9, Node Shape,
  source-system boundary
