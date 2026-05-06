---
name: first-tree-sync
version: 0.4.0-alpha.1
cliCompat:
  first-tree: ">=0.4.0 <0.5.0"
description: Audit and repair drift between merged code and the Context Tree. Use when the tree may be stale, wrong, outdated, or missing coverage for recent code changes; after a large merge; before release; or when a GitHub notification was routed `route=sync`. Sync owns broad drift discovery and classification across one tree. Use `first-tree-write` instead when the user already gave you a specific PR / doc / note to write into the tree.
---

# First Tree Sync

Read these first:

- `../first-tree/SKILL.md`
- `../first-tree/references/functions.md`
- `../first-tree/references/maintenance.md`

## What This Skill Does

Compare a Context Tree against the source repo(s) it describes, classify
every disagreement into one of six drift types, and route each finding to
auto-fix, needs-human, or skip.

Two phases, in order:

1. **audit** — produce a `drifts[]` list. Read-only, human-paced.
2. **fix** — for each drift, decide auto-fix / needs-human / skip and act
   on that decision.

Each phase has a dedicated reference; follow them in order.

## When To Use This Skill

| Use this skill                                       | Use a different skill                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| User asks "is the tree up to date?"                  | User has a specific PR / doc to reflect into the tree → `first-tree-write`           |
| Audit drift since a release                          | Repo is unbound → `first-tree-onboarding` first                                      |
| GitHub Scan agent routed a notification `route=sync` | Notification needs a label / comment only → `first-tree-github-scan` keeps ownership |

## The Six Drift Types

```
tree-stale            — tree node was true; code moved
tree-wrong            — tree node never matched code
tree-outdated         — superseded by a newer decision
code-not-synced       — code change has no tree counterpart
cross-domain-broken   — soft_links target gone or wrong
ownership-stale       — owners list no longer matches reality
```

Definitions, signals, and worked examples in
[references/drift-taxonomy.md](references/drift-taxonomy.md).

## How To Run

| Phase                         | Reference                                                    |
| ----------------------------- | ------------------------------------------------------------ |
| Find drift                    | [references/audit-workflow.md](references/audit-workflow.md) |
| Repair drift                  | [references/fix-workflow.md](references/fix-workflow.md)     |
| Decide between sync and write | [references/boundary.md](references/boundary.md)             |

The CLI surface this skill uses today:

- `first-tree tree inspect --json` — confirm the binding
- `first-tree tree verify` — surface broken `soft_links` and structure issues
- `git log <ref>..HEAD -- <path>` — recent-change sweep
- `gh pr create` — open the auto-fix tree PR

There is no `first-tree tree audit` command yet. The audit phase reads code
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
- **Sync does not introduce new decision content.** "The tree could say more"
  is not drift — that is `first-tree-write`'s job. The narrow exception is a
  purely additive structural fix needed to reflect code or workspace reality
  that already exists (for example, registering a newly bound repo in
  `source-repos.md`).

## References

- [drift-taxonomy.md](references/drift-taxonomy.md) — six drift types with
  definitions, signals, and examples
- [audit-workflow.md](references/audit-workflow.md) — how to discover
  drift; output shape of `drifts[]`
- [fix-workflow.md](references/fix-workflow.md) — auto-fix vs needs-human
  vs skip routing; PR mechanics
- [boundary.md](references/boundary.md) — sync vs write decision table
  and hand-off rules
