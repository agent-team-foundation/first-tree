---
name: first-tree-sync
version: 0.6.1
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Audit and repair drift between merged code and the Context Tree in both directions — tree→code (does code still support tree facts?) and code→tree (does the tree register everything code now contains?). Use when the tree may be stale, wrong, outdated, or missing coverage for recent code changes; after a large merge; before release; or on a freshly onboarded tree. Sync owns broad drift discovery, structural skeleton repair, and substantive write hand-off across one tree. Use `first-tree-write` instead — not this skill — when the user has already named a specific PR / doc / note as the source material.
---

# First Tree Sync

Read this first:

- `../first-tree-context/SKILL.md` — the Context Tree operating guide
  (concepts, source-system boundary, read + writing-rules sections). Under the
  simplify-context-skill pass, the `functions` / `maintenance` /
  `structure` references were folded back into this single file, so
  loading the SKILL.md is enough.

## What This Skill Does

Compare a Context Tree against the source repo(s) it describes in **both
directions**:

- **tree→code** — for each tree node, does the code still support it?
  (catches `tree-stale`, `tree-wrong`, `tree-outdated`, `cross-domain-broken`,
  `ownership-stale`)
- **code→tree** — for each piece of source structure, does the tree
  register it? (catches `code-not-synced`)

Classify every gap, then route each finding to auto-fix,
`first-tree-write` handoff, needs-human, or skip.

Two phases, in order:

1. **audit** — produce a `drifts[]` list. Read-only, human-paced. Combines
   a tree→code pass (Phase 1–3) with a code→tree sweep (Phase 4).
2. **fix** — for each drift, decide auto-fix /
   `first-tree-write` handoff / needs-human / skip and act on that
   decision.

Each phase has a dedicated reference; follow them in order.

## When To Use This Skill

| Use this skill                                       | Use a different skill                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| User asks "is the tree up to date?"                  | User has a specific PR / doc to reflect into the tree → `first-tree-write`             |
| Audit drift since a release                          | Repo is unbound → surface to a human (workspace binding is an operator action)        |

## The Six Drift Types

```
tree-stale                   — tree node was true; code moved
tree-wrong                   — tree node never matched code
tree-outdated                — node's claim no longer matches the current decision
code-not-synced/structural   — code structure exists; tree skeleton does not register it
code-not-synced/substantive  — code decision/constraint exists; tree does not record it
cross-domain-broken          — soft_links target gone or wrong
ownership-stale              — owners list no longer matches reality
```

`code-not-synced` has two subtypes because the fix shape is different:
structural gaps need registration (sync handles), substantive gaps need
authorship (`first-tree-write` handles, using `first-tree-context` rules). See
`references/drift-taxonomy.md`.

Definitions, signals, and worked examples in
[references/drift-taxonomy.md](references/drift-taxonomy.md).

## How To Run

| Phase                         | Reference                                                    |
| ----------------------------- | ------------------------------------------------------------ |
| Find drift                    | [references/audit-workflow.md](references/audit-workflow.md) |
| Repair drift                  | [references/fix-workflow.md](references/fix-workflow.md)     |
| Choose sync vs source-driven write | [references/boundary.md](references/boundary.md)             |

The CLI / filesystem surface this skill uses today:

CLI examples in this skill use the canonical prod binary `first-tree` for
readability. Substitute the channel-correct binary from AGENTS / current
channel (`first-tree` on prod, `first-tree-staging` on staging,
`first-tree-dev` on dev) before running them.

- **Workspace binding** — read `<workspaceRoot>/.first-tree/workspace.json`
  directly (the schema is `{ tree: "<dir>", sources: ["<dir>", ...] }`).
  The `<binName> tree status` CLI that used to wrap this read was
  retired in 2026-06 along with the rest of the `tree` namespace; the
  manifest is small JSON, just `cat` / `jq` it. Walk up from cwd to
  find the workspace root.
- `first-tree tree verify` — run from inside the tree subdir to
  surface broken `soft_links` and structure issues. (The only
  surviving `tree` subcommand.)
- `git log <ref>..HEAD -- <path>` — recent-change sweep over each
  bound source repo.
- `gh pr create` — open the auto-fix tree PR.

There is no `first-tree tree audit` command. The audit phase reads code
and tree manually; the fix phase opens PRs via `gh`.

## Hard Rules

- **Code is the ground truth** for `tree-stale`, `tree-wrong`,
  `tree-outdated`, `cross-domain-broken`. Override only when the node has
  `decisionLocksCode: true` in frontmatter, in which case the drift is
  always `needs-human`.
- **One drift = one PR (when auto-fixed).** Do not bundle unrelated
  findings.
- **Ownership changes are always `needs-human`.** Never auto-fix
  `owners:` lists.
- **Audit produces a list; fix takes actions.** Do not write tree updates
  inside the audit phase.
- **Sync may add structural skeletons; substantive content goes through
  `first-tree-write`.** `code-not-synced` splits into two subtypes (see
  `references/drift-taxonomy.md`):
  - **structural** — new dir / submodule / dependency / member that the
    tree's skeleton does not yet register. Sync may auto-fix with a stub
    node or registry entry.
  - **substantive** — new decision / constraint / rationale (e.g. a new
    AGENTS.md section, a merged RFC). Sync surfaces the source pointer
    and hands off to `first-tree-write`, which loads `first-tree-context`
    and applies the "default to not writing" filter.

  Sync never composes decision prose from code. "The tree could say more"
  about an existing topic is not drift — that is `first-tree-write`'s job.

## References

- [drift-taxonomy.md](references/drift-taxonomy.md) — six drift types with
  definitions, signals, and examples
- [audit-workflow.md](references/audit-workflow.md) — how to discover
  drift; output shape of `drifts[]`
- [fix-workflow.md](references/fix-workflow.md) — auto-fix vs needs-human
  vs skip routing; PR mechanics
- [boundary.md](references/boundary.md) — sync vs source-driven write
  decision table and hand-off rules
