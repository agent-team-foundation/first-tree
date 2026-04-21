---
name: tree
description: Operate the `first-tree tree` CLI — inspect, bind, init, verify, publish, upgrade, sync, workspace, review, generate-codeowners, inject-context. Use whenever you need to read/write a Context Tree repo, onboard a repo or workspace to an existing tree, or manage tree ownership, publishing, and CI integration.
---

# Tree — Operational Skill

This skill is the operational handbook for the `tree` product. If you have
not yet loaded the `first-tree` entry-point skill, load that first — it
explains *what* a Context Tree is and *why* you would use one. This skill
covers *how* to drive the `first-tree tree` CLI.

## When To Use This Skill

Load this skill when the task involves any of:

- Running a `first-tree tree <command>` subcommand
- Onboarding a repo, a shared tree, or a workspace root to a Context Tree
- Writing or verifying `NODE.md` files, `soft_links`, or ownership frontmatter
- Publishing a tree repo to GitHub or refreshing bound source/workspace repos
- Wiring Context Tree CI (CODEOWNERS, PR review, SessionStart hooks)

## Core Concepts

The tree CLI centers on three concepts:

- **source / workspace root** — a repo (or a workspace of repos) whose work
  should consult a Context Tree
- **tree repo** — the repository that stores the `NODE.md` + leaf-node files
- **binding** — the relationship that wires a source/workspace root to a
  specific tree repo

Most commands accept or classify one of these three shapes.

## Default Onboarding Workflow

1. Run `first-tree tree inspect --json`.
2. Ask whether the user already has a Context Tree.
3. If they do, use `first-tree tree bind`.
4. If they do not, use `first-tree tree init`.
5. If the current root is a workspace, run `first-tree tree workspace sync` so
   all discovered local child repos bind to the same shared tree.

During `bind` / `init`, the CLI also ensures the tree repo has the bundled
`first-tree` skill installed and refreshes binding metadata in both locations.

## CLI Commands

| Command | Purpose |
|---|---|
| `first-tree tree inspect` | Classify the current folder and report bindings / locally discovered child repos |
| `first-tree tree status` | Alias for `inspect` (human-friendly name) |
| `first-tree tree init` | High-level onboarding wrapper for single repos, shared trees, and workspace roots |
| `first-tree tree bootstrap` | Low-level tree bootstrap for an explicit tree checkout |
| `first-tree tree bind` | Bind the current repo/workspace root to an existing tree repo |
| `first-tree tree workspace sync` | Bind discovered local child repos to the same shared tree |
| `first-tree tree verify` | Validate a tree repo: frontmatter, owners, soft_links, members, progress |
| `first-tree tree upgrade` | Refresh the installed skill payloads or tree metadata from the bundled package |
| `first-tree tree publish` | Publish a tree repo to GitHub and refresh any explicit or locally discoverable source/workspace repos |
| `first-tree tree review` | CI helper: run Claude Code PR review against tree changes |
| `first-tree tree generate-codeowners` | Regenerate `.github/CODEOWNERS` from tree ownership |
| `first-tree tree invite` | Invite a new member to the Context Tree (human, personal_assistant, or autonomous_agent) |
| `first-tree tree join` | Accept an invite and join a Context Tree |
| `first-tree tree inject-context` | Output a Claude Code SessionStart hook payload from `NODE.md` |
| `first-tree tree help onboarding` | Show the onboarding narrative |

For full options on any command, run `first-tree tree <command> --help`.

## Recommended Invocation

```bash
npx first-tree tree <command>
```

This is the recommended human-facing one-off invocation. The CLI auto-checks for
updates on every invocation; pass `--skip-version-check` to suppress the
check for latency-sensitive callers like SessionStart hooks.

To refresh source/workspace integration or tree metadata from the current
package:

```bash
npx first-tree tree upgrade
```

If you only need to wipe and reinstall the four shipped skill payloads under
`.agents/skills/*` and `.claude/skills/*`, use `npx first-tree skill upgrade`
instead.

## Ownership

- Every directory has a `NODE.md` declaring `owners` in its frontmatter.
- Empty `owners: []` inherits from the parent.
- `owners: [*]` means anyone may edit.
- Otherwise only the listed owners may approve changes.

Ownership model and node-naming rules: see the
`ownership-and-naming.md` reference in the `first-tree` entry-point skill.

## Related Skills

- `first-tree` — entry-point skill: methodology, references, and routing
  between product skills. Load this first.
- `breeze` — load if the task involves the breeze daemon or notifications.
- `gardener` — load if the task involves any tree-maintenance runtime:
  drift sync (`gardener sync`), verdict comments on source-repo PRs
  (`gardener comment`), or responses to sync-PR review feedback
  (`gardener respond`).
