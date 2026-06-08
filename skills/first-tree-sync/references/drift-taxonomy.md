# Drift Taxonomy

Every finding produced by sync must be classified into exactly one of these
six categories. The category drives the fix workflow — see
`references/fix-workflow.md`.

## `tree-stale`

The tree node states a fact that _was_ true but is no longer. The code side
moved; the tree did not.

**Signals:** the tree references a function / file / path that the code
shows has been renamed, removed, or restructured. The tree's claim was
correct at some prior commit.

**Example:** tree node says "Auth middleware lives at `src/middleware/auth.ts`"
but the code shows it was moved to `src/auth/middleware.ts` two months ago.

**Fix bias:** code is the ground truth → update the tree.

## `tree-wrong`

The tree node states a fact that was never correct, independent of any code
movement.

**Signals:** the tree's claim cannot be traced to any commit; or it
contradicts the code at the time the node was written.

**Example:** tree node says "All endpoints return JSON" but a PR from before
the node was written introduced a streaming endpoint that returns NDJSON.

**Fix bias:** correct the tree, but check ownership — the original author
may have meant something subtler.

## `tree-outdated`

The tree node was correct, but a more recent decision supersedes it. The old
decision is not "wrong" — it has just been replaced.

**Signals:** a newer tree node, RFC, or merged PR discusses the same area
and reaches a different conclusion.

**Example:** tree node says "We use Postgres" but a migration RFC merged
last quarter switched the relevant service to ClickHouse.

**Fix bias:** rewrite the node **in place** to the new current state.
Carry forward the *rationale* for the new decision (under
"Rationale") — but do not add a "Superseded by…" footer, a
"Previously…" section, or a `> YYYY-MM-DD update:` banner. The old
state stays in `git log` and any `raw-context/` source for the
change; the node itself is single-state. See
`first-tree-context` Hard Rule 8 ("No history").

## `code-not-synced`

The code side has something the tree does not register. Split into two
subtypes because the fix shape is fundamentally different — registration
vs authorship.

### `code-not-synced/structural`

The tree's **skeleton** does not yet cover a piece of source structure
that demonstrably exists. The fix is registration, not authorship — a
stub node, a list entry, or a registry update. No decision is being
invented.

**Signals:**

- source structure has no entry in the relevant tree routing surface:
  a root section such as `## Domains`, a subsystem index, a source
  registry, a member node, or an equivalent domain `NODE.md`
- `.gitmodules` lists a submodule path whose subdir name is not in
  `workspace.json.sources` (the W1 manifest at
  `<workspaceRoot>/.first-tree/workspace.json`)
- `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` declares a
  decision-relevant dependency (framework, runtime, datastore) that is
  absent from `.first-tree/org.yaml`'s `techStackConstraints`
- a newly cloned source repo at `<workspaceRoot>/<name>` is not yet
  in `workspace.json.sources` (detect by comparing the `sources` array
  in `<workspaceRoot>/.first-tree/workspace.json` against `ls -d
  <workspaceRoot>/*/` that are git repos)
- an active contributor (commits within the last 6 months) is not
  present under `members/`

**Example:** the source repo's top-level `packages/` directory exists
but the tree has no domain routing entry, subsystem index entry, or
equivalent node that registers it. Sync adds the smallest skeleton entry
in the relevant routing section and, if needed, an empty
`packages/NODE.md` stub with `title` and `owners: []` frontmatter — no
body prose.

**Fix bias:** auto-fix with the smallest correct skeleton edit. Do not
draft decision content for the new node — that is
`first-tree-context`'s job on a follow-up source pointer.

### `code-not-synced/substantive`

A merged PR / doc / `AGENTS.md` section establishes a decision,
constraint, or rationale that the tree does not record. Adding this
requires **authorship**, not registration — the "default to not writing"
filter and node-shape rules from `first-tree-context` apply.

**Signals:**

- a new RFC / decision doc lands under `docs/rfcs/`, `docs/decisions/`,
  `adr/`, or similar, with no tree counterpart
- `AGENTS.md` / `CLAUDE.md` grows a new section that explains a policy,
  red line, workflow, or constraint, and the tree is silent on it
- a merged PR's body or commit message states a constraint or ownership
  rule not yet captured anywhere in the tree

**Example:** the source repo's `AGENTS.md` adds a new section on the
agent's memory-management policy; no tree node references it. Sync emits
a finding with the section heading and line range as `sourcePointer`,
and routes to `first-tree-context`. Sync never drafts the substance itself.

**Fix bias:** always hand off to `first-tree-context` with the source
pointer. Sync surfaces what should be written and stops. See
`references/boundary.md`.

## `cross-domain-broken`

A `soft_links` reference between domains is broken — the target was
renamed, removed, or moved out of the tree.

**Signals:** `tree verify` reports a broken `soft_links` target, or a
`NODE.md` references a sibling that no longer exists.

**Example:** `members/alice/NODE.md` has `soft_links: [auth/middleware]`
but `auth/middleware/NODE.md` was renamed to `auth/handlers/`.

**Fix bias:** repair the link. If the target genuinely went away, decide
whether to drop the link or replace with the new target.

## `ownership-stale`

The tree's frontmatter `owners:` list does not match the code-side reality.
A maintainer left, ownership was redistributed, or the node never had the
right owners.

**Signals:** the listed owner has not touched the code area for >6 months;
PRs in the area are reviewed by a different team; the user (in conversation)
disagrees with the listed owner.

**Example:** `auth/NODE.md` lists `[bob]` but Bob left the team and Carol
has been the de-facto reviewer for three months.

**Fix bias:** update via owner-review, not unilaterally. Ownership changes
are a high-trust operation — flag for human approval rather than auto-PR.

## Classification Rules

- A finding fits **exactly one** category. If two seem to fit, pick the
  more specific one (`tree-outdated` over `tree-stale`, `ownership-stale`
  over `tree-wrong`, `code-not-synced/substantive` over
  `code-not-synced/structural` when the gap requires authoring decision
  prose).
- If you cannot classify, the finding is not yet a drift — it is a
  question. Ask the user before reporting it.
- "The tree could be more detailed" about an existing topic is **not**
  drift. Use `first-tree-context` to deepen existing nodes. But a missing
  skeleton entry for source structure that demonstrably exists **is**
  drift — that is `code-not-synced/structural` and sync fixes it.
- Use `code-not-synced/structural` for registration (skeleton, stub,
  list entry, frontmatter). Use `code-not-synced/substantive` only when
  the fix requires composing decision prose, rationale, or constraints.

## Code Is The Ground Truth

For `tree-stale`, `tree-wrong`, `tree-outdated`, and `cross-domain-broken`,
default to merged code on the default branch as the higher-confidence
source — the proposal calls this "已合入代码上位".

The exception is a tree node whose frontmatter explicitly declares
`decisionLocksCode: true`. That is a deliberate "tree wins, escalate to a
human" marker. Treat any drift on such a node as `needs-human` regardless
of category. (This frontmatter key is reserved by the proposal but the
validator does not parse it yet — read it as plain frontmatter.)
