---
title: "Source/Workspace Installation Contract"
owners: []
---

# Source/Workspace Installation Contract

This reference defines what it means to "install and use first-tree" in an
existing source or workspace repository.

## Core Boundary

- The current source/workspace repo is **not** the Context Tree.
- The current source/workspace repo carries only:
  - `.agents/skills/first-tree/` and `.claude/skills/first-tree/` — the
    lightweight installed skill payload (SKILL.md, VERSION, references/).
    No engine, no assets, no helpers, no scripts.
  - `FIRST_TREE.md` — symlink to `.agents/skills/first-tree/references/about.md`
  - A managed `FIRST-TREE-SOURCE-INTEGRATION:` block in `AGENTS.md` and
    `CLAUDE.md`
  - `.first-tree/local-tree.json` — local-only config recording where the
    dedicated tree repo lives on disk
- `NODE.md`, `members/`, and tree-scoped `AGENTS.md` / `CLAUDE.md` content
  belong only in a dedicated `*-tree` repo. Existing bound `*-context` repos
  are still supported and should be reused.
- The dedicated tree repo keeps its CLI metadata under `.first-tree/`. It does
  NOT install a copy of the `first-tree` skill — it holds tree content only.
- If a task changes decisions, rationale, ownership, or constraints, update
  the dedicated tree repo rather than copying that material into the source
  repo.

## What Lives Where After Install

```text
<source-repo>/                         # source/workspace repo
  .agents/skills/first-tree/           # lightweight skill (read-only)
    SKILL.md
    VERSION                            # major.minor (e.g. "0.2")
    references/                        # principles, ownership, onboarding, etc.
  .claude/skills/first-tree            # symlink to .agents/skills/first-tree
  FIRST_TREE.md                        # symlink to references/about.md
  AGENTS.md                            # has FIRST-TREE-SOURCE-INTEGRATION block
  CLAUDE.md                            # has FIRST-TREE-SOURCE-INTEGRATION block
  .first-tree/local-tree.json          # local-only, gitignored
  ... your normal source code ...

<source-repo>-tree/                    # sibling dedicated tree repo
  .first-tree/
    VERSION                            # major.minor
    progress.md
    bootstrap.json                     # source repo path for publish
  NODE.md                              # root tree node
  AGENTS.md
  CLAUDE.md
  members/
    NODE.md
    <member-id>/
      NODE.md
  ... your domains ...
```

## Helper Invocation

User repos do NOT contain helper scripts anymore. The CLI provides
subcommands that wrap each helper. Workflows and hook commands invoke them
via npx:

| Helper | CLI command |
|---|---|
| Inject session context (Claude Code SessionStart hook) | `npx -p first-tree first-tree inject-context --skip-version-check` |
| Generate `.github/CODEOWNERS` from tree ownership | `npx -p first-tree first-tree generate-codeowners` |
| Run Claude Code PR review (CI) | `npx -p first-tree first-tree review` |
| Verify the tree | `npx -p first-tree first-tree verify` |

The `--skip-version-check` flag suppresses the silent auto-upgrade check
on every invocation. Use it for latency-sensitive callers like the
SessionStart hook (which runs at the start of every Claude Code session).

## Agent Decision Rule

- Treat "install and use first-tree" in a source/workspace repo as a two-repo
  workflow: local skill integration in the current repo plus tree bootstrap
  in a sibling `*-tree` repo.
- If the source/workspace repo is already bound to a legacy `*-context` repo,
  keep reusing that repo name instead of silently switching it to `*-tree`.
- Do not run `first-tree init --here` in the source/workspace repo unless the
  user explicitly says that repo itself should become the Context Tree.
- If you cannot create the sibling repo locally, cannot push it to GitHub, or
  cannot record or refresh the local tree checkout state yet, pause and report
  the blocker. Do not fall back to creating `NODE.md`, `members/`, or
  tree-scoped `AGENTS.md` / `CLAUDE.md` in the source/workspace repo.

## Default Agent Workflow

When an agent is asked to install first-tree for a source/workspace repo, the
default workflow is:

1. Run `first-tree init` from the current source/workspace repo.
   You may add `--seed-members contributors` to draft initial
   `members/*/NODE.md` files from repository contributor history during the
   bootstrap.
2. Switch into the sibling dedicated tree repo named `<repo>-tree` by default.
   If the source/workspace repo is already bound to `<repo>-context`, switch
   into that existing repo instead.
3. Draft the first tree version from the real codebase, docs, and ownership
   signals.
4. Read `.first-tree/progress.md` as the source of truth for the
   onboarding checkpoint, report setup/integration progress separately from
   tree-content baseline coverage, and ask whether to continue the first-pass
   full-tree expansion.
5. If the user confirms, expand the tree with wave-based parallel sub-tasks or
   subagents, usually one per top-level domain, while the main agent keeps
   ownership of the root `NODE.md`, cross-domain `soft_links`, and the final
   `first-tree verify` pass.
6. Run `first-tree publish --open-pr` from the dedicated tree repo. It will:
   create or reuse the GitHub `*-tree` repo in the same owner/org as the
   source repo, continue supporting older `*-context` repos, push the tree,
   record the published tree URL back in the source/workspace repo, refresh
   the ignored local tree checkout config, and open the source-repo PR.
7. After publish succeeds, treat the checkout recorded in
   `.first-tree/local-tree.json` as the canonical local working copy for the
   tree. The bootstrap checkout can be deleted when you no longer need it.

If the dedicated tree repo was initialized manually with `first-tree init --here`
and publish cannot infer the source repo, pass `--source-repo PATH`.

## Routine Work After Publish

- Start routine work by reading `.first-tree/local-tree.json` in the current
  source/workspace repo and resolving the recorded `localPath`.
- If that recorded checkout exists locally, update it before you read the
  tree.
- If the recorded checkout is missing but the tree has already been published,
  create a temporary clone inside `.first-tree/tmp/` in the current
  source/workspace repo, use it for the task, and delete it before finishing.
- Fall back to the sibling bootstrap checkout (`*-tree` by default, or legacy
  `*-context`) only before publish has recorded the GitHub URL and local tree
  config.
- At task close-out, always ask whether the tree needs updating.
- If the task changed decisions, constraints, rationale, or ownership, send
  the tree PR first and then send the source/workspace code PR.
- If the task changed only implementation detail, skip the tree PR and send
  only the source/workspace code PR.

## Verification And Upgrade

- Do not run `first-tree verify` in the source/workspace repo. Verify the
  dedicated tree repo instead, for example
  `first-tree verify --tree-path ../my-repo-tree`.
- Running `first-tree upgrade` in the source/workspace repo wipes the
  installed skill payload and reinstalls the lightweight version from the
  bundled package, refreshes the `FIRST_TREE.md` symlink and the
  `FIRST-TREE-SOURCE-INTEGRATION:` block, updates `.claude/settings.json`'s
  SessionStart hook command if it still references a legacy
  `inject-tree-context.sh` path, and overwrites any
  `.github/workflows/{validate,pr-review,codeowners}.yml` files that match
  shipped templates.
- Run `first-tree upgrade --tree-path ../my-repo-tree` to upgrade the
  dedicated tree repo itself. If the source/workspace repo is still bound to
  `../my-repo-context`, use that actual legacy path instead. Dedicated tree
  repos keep their progress and version markers under `.first-tree/`.
- The upgrade command is a no-op when the installed major.minor matches the
  bundled CLI's major.minor. CLI patch updates (e.g. `0.2.4` → `0.2.5`) ship
  via npm and never require touching user repos.
