---
name: first-tree-write
version: 0.4.0-alpha.1
cliCompat:
  first-tree: ">=0.4.0 <0.5.0"
description: Write Context Tree updates from explicit source material — code PRs, design docs, meeting notes, raw text. Use when the user gives you a concrete source and wants the right durable tree change drafted, linked, and reviewed. This skill is source-driven and targeted; use `first-tree-sync` instead for broad drift audits with no specific source.
---

# First Tree Write

Read these first:

- `../first-tree/SKILL.md`
- `../first-tree/references/anti-patterns.md`
- `../first-tree/references/maintenance.md`

## What This Skill Does

Take one specific source — a PR, a doc, a note — and produce zero, one,
or a small set of tree changes that capture what's durable and decision-
relevant. The output is a tree-repo PR linked to the source.

## When To Use This Skill

| Use this skill                                               | Use a different skill                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| User pastes a PR link and says "reflect this in the tree"    | User asks "is the tree up to date?" → `first-tree-sync`                       |
| User pastes a meeting note about a decision                  | Repo is unbound → `first-tree-onboarding` first                               |
| User pastes raw text and asks for the tree implication       | A GitHub notification needs only a label / comment → `first-tree-github-scan` |
| GitHub Scan agent classifies a notification as `route=write` | Audit drift since a release → `first-tree-sync`                               |

## The Default Stance

Default to **not writing**. The tree compresses expensive context; a
node nobody reads is worse than a missing node. If the source does not
clearly establish a decision, constraint, ownership change, or
cross-domain relationship, write nothing and tell the user why.

## How To Run

| Phase                         | Reference                                                |
| ----------------------------- | -------------------------------------------------------- |
| Decide what is tree-worthy    | [references/what-belongs.md](references/what-belongs.md) |
| Draft the update              | [references/workflow.md](references/workflow.md)         |
| Shape the tree node           | [references/node-shape.md](references/node-shape.md)     |
| Decide between write and sync | [references/boundary.md](references/boundary.md)         |

The CLI surface this skill uses today:

- `first-tree tree inspect --json` — confirm the binding
- `first-tree tree verify --tree-path <path>` — gate the final commit
- `gh pr create` — open the tree-repo PR

There is no `first-tree tree write-node` or `tree open-tree-pr` command
yet — write builds the file edits + commit + PR with `gh` and standard
git.

## Hard Rules

- **Source-driven only.** No source means no write task. Send the user
  to `first-tree-sync` if they want broad audit.
- **Default to not writing.** Apply both decision and durability tests
  before drafting anything (see `references/what-belongs.md`).
- **No diffs in the tree.** Capture decisions and rationale, not code
  detail. The diff lives in the source PR.
- **Smallest correct edit.** Bias hard toward editing existing nodes.
  Adding a new domain is a high-bar move.
- **Verify before commit.** `first-tree tree verify` must exit 0 before
  opening the tree PR.
- **Link the source.** Every tree change must link back to the PR / doc
  / note that motivated it.
- **Do not chain into other skills.** Finish the write task; suggest
  follow-ups in the PR body if you noticed adjacent drift.

## References

- [what-belongs.md](references/what-belongs.md) — judgment filter; the
  decision/durability tests and worked examples
- [workflow.md](references/workflow.md) — five-step recipe (read source,
  identify tree-worthy content, choose smallest edit, draft, verify and
  link)
- [node-shape.md](references/node-shape.md) — frontmatter rules, body
  structure, and a worked example
- [boundary.md](references/boundary.md) — write vs sync decision table
  and hand-off mechanics
