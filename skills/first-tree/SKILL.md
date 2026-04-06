---
name: first-tree
description: Read and update the Context Tree — the living source of truth for cross-domain decisions, constraints, and ownership in this organization. Use whenever a task touches strategic choices, cross-domain relationships, or domain ownership, or whenever you need to know what's already been decided before acting.
---

# First Tree

This skill teaches you how to work with this repo's Context Tree and how to
invoke the `first-tree` CLI when you need to scaffold, verify, upgrade, or
publish the tree.

## What Is Context Tree

A Context Tree is a git-native, file-based knowledge base that captures **why**
decisions were made and **how** domains relate, not how things are executed.
Each domain is a directory containing a `NODE.md`. Each leaf decision is a
markdown file with frontmatter declaring `title`, `owners`, and optional
`soft_links` to related nodes.

Read `references/about.md` for the product framing and
`references/principles.md` for the four core principles you must follow when
reading or writing nodes.

## When To Use This Skill

Trigger this skill when you are asked to:

- Read or update any `NODE.md` or leaf node in the tree
- Make a decision that affects multiple domains
- Check ownership before editing a node
- Onboard a new member or domain
- Run `first-tree` CLI commands (init, verify, upgrade, publish, review,
  generate-codeowners, inject-context)
- Investigate why a particular decision was made

Do **not** use this skill for routine code edits that don't touch decisions,
constraints, or cross-domain relationships — those stay in source systems.

## Before Every Task

1. **Read the root `NODE.md`** to understand the domain map.
2. **Read the `NODE.md` of every domain relevant to your task.** If unsure
   which are relevant, start from root and follow the structure — it is
   organized by concern, not by repo or team.
3. **Follow `soft_links`.** If a node declares `soft_links` in its frontmatter,
   read those linked nodes too.
4. **Read leaf nodes that match your task.** `NODE.md` tells you what exists in
   each domain — scan it and read the leaves that are relevant.

Skipping this step produces decisions that conflict with existing ones. The
tree is already a compression of expensive cross-domain knowledge.

## During The Task

- **Decide in the tree, execute in source systems.** If your task involves a
  decision (not just a bug fix), update the relevant tree node before or
  alongside the code change.
- **Function signatures, DB schemas, API endpoints, ad copy — none of those
  belong in the tree.** The tree captures the *why* and *how things connect*.
- **Respect ownership.** Each node declares owners in its frontmatter. If your
  changes touch a domain you don't own, flag it — the owner needs to review.
  See `references/ownership-and-naming.md`.

## After Every Task

Always ask: **does the tree need updating?**

- Did you discover something the tree didn't capture — a cross-domain
  dependency, a new constraint, a decision future agents would need?
- Did you find the tree was wrong or outdated? That is a tree bug — fix it.
- Not every task changes the tree, but the question must always be asked.

## CLI Commands

The `first-tree` CLI is the canonical interface. You don't need to know how it
works internally — invoke it and read its output.

| Command | Purpose |
|---|---|
| `first-tree init` | Scaffold a new tree (or reuse a sibling dedicated tree repo from a source/workspace repo) |
| `first-tree verify` | Validate the tree: frontmatter, owners, soft_links, members, progress |
| `first-tree upgrade` | Refresh the installed skill from the bundled package |
| `first-tree publish` | Publish a dedicated tree repo to GitHub and link it back to the source repo |
| `first-tree review` | CI helper: run Claude Code PR review against tree changes |
| `first-tree generate-codeowners` | Regenerate `.github/CODEOWNERS` from tree ownership |
| `first-tree inject-context` | Output a Claude Code SessionStart hook payload from `NODE.md` |
| `first-tree help onboarding` | Show the onboarding narrative |

For full options, run `first-tree <command> --help`. The CLI is designed for
agents, not humans — its help output is exhaustive.

## Installing And Updating The CLI

The CLI lives in the `first-tree` npm package. The recommended invocation is:

```bash
npx -p first-tree first-tree <command>
```

This always runs the latest published version. The CLI auto-checks for
updates on every invocation; pass `--skip-version-check` to suppress the
check (used by latency-sensitive callers like the SessionStart hook).

To upgrade the bundled skill payload (this directory) when a new minor
version is released, run:

```bash
npx -p first-tree first-tree upgrade
```

This refreshes `SKILL.md`, `references/`, and `VERSION` from the package.
The CLI version is shown by `first-tree --version` as
`MAJOR.MINOR.PATCH (skills: MAJOR.MINOR)`.

## Versioning

Three-level: `major.minor.patch`.

- **major** — company-wide milestones; bumped only at major events
- **minor** — skill payload changes (this directory); bump triggers
  `first-tree upgrade` in user repos
- **patch** — CLI behavior changes; transparent via npm, no repo update needed

## Ownership And Editing

- Every directory has a `NODE.md` declaring `owners` in its frontmatter.
- Empty `owners: []` inherits from the parent.
- `owners: [*]` means anyone may edit.
- Otherwise only the listed owners may approve changes.
- The full model is in `references/ownership-and-naming.md`. CODEOWNERS is
  generated automatically by `first-tree generate-codeowners`.

## Files In This Skill

- `SKILL.md` — this file
- `VERSION` — installed skill payload version (major.minor)
- `references/about.md` — what Context Tree is, who it's for, why it exists
- `references/principles.md` — four core principles with examples
- `references/ownership-and-naming.md` — node naming and ownership model
- `references/onboarding.md` — onboarding narrative for new members
- `references/source-workspace-installation.md` — how source/workspace repos
  integrate with a dedicated tree repo
- `references/upgrade-contract.md` — installed layout and upgrade semantics

Everything else (engine, validators, helpers, templates, workflows) lives in
the `first-tree` npm package and is invoked via the CLI. You do not need to
read or edit any of that to use the tree.
