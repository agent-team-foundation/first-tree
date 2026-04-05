# Upgrade Contract

This file describes the current installed-layout contract and the compatibility
rules we keep for legacy `skills/first-tree/` and `.context-tree/` repos.

## Canonical Source

- `skills/first-tree/` is the only source of truth.
- `references/` contains explanatory material.
- `assets/framework/` contains the shipped runtime payload.
- The distributable `first-tree` package must carry the canonical skill inside
  the package itself.
- The source repo does not keep a root `.context-tree/`, `docs/`, mirror skill
  directories, or a bundled repo snapshot.

## Installed Layout

The current installed layout in a source/workspace repo or dedicated tree repo
is:

```text
.agents/
  skills/
    first-tree/
      SKILL.md
      progress.md
      references/
      assets/
        framework/
          manifest.json
          VERSION
          templates/
          workflows/
          prompts/
          examples/
          helpers/
.claude/
  skills/
    first-tree/
      SKILL.md
      references/
      assets/
        framework/
          manifest.json
          VERSION
          templates/
          workflows/
          prompts/
          examples/
          helpers/
```

For a source/workspace repo, the local integration stops there. It should also
carry a single `FIRST-TREE-SOURCE-INTEGRATION:` line in root `AGENTS.md` and
`CLAUDE.md`, but it must not contain tree content.

For a dedicated tree repo, the tree content still lives outside the skill:

- `NODE.md`
- `AGENTS.md`
- `members/`
- `.agents/skills/first-tree/bootstrap.json` when `context-tree init` was run
  from a separate source/workspace repo and the publish workflow needs to
  remember that source repo path

The repo-owned `.agents/skills/first-tree/` path is the primary installed root
for progress state, workflow references, and helper scripts. The matching
`.claude/skills/first-tree/` path mirrors the same payload for Claude-facing
skill discovery and hooks.

## Command Intent

- `context-tree init`
  - when run in a source/workspace repo, creates or reuses a sibling dedicated
    tree repo by default
  - installs the skill into the source/workspace repo without creating tree
    files there
  - upserts the `FIRST-TREE-SOURCE-INTEGRATION:` line in root `AGENTS.md` and
    `CLAUDE.md`
  - installs the skill into the target tree repo
  - renders top-level tree scaffolding only in the target tree repo
  - writes progress state only to the dedicated tree repo at
    `.agents/skills/first-tree/progress.md`
- `context-tree verify`
  - checks progress state from the installed skill
  - validates root/frontmatter/agent markers
  - runs node and member validators
  - must reject source/workspace repos that carry only local integration
- `context-tree publish`
  - is the explicit second-stage command for publishing a dedicated tree repo
    to GitHub after local bootstrap
  - reads dedicated-tree bootstrap metadata from
    `.agents/skills/first-tree/bootstrap.json` when available
  - may create or reuse the GitHub `*-context` repo, push tree commits, add it
    back to the source/workspace repo as a git submodule, and optionally open
    the source-repo PR
- `context-tree upgrade`
  - compares the installed skill payload version to the skill bundled with the
    currently running `first-tree` package
  - refreshes the installed skill payload without overwriting tree content
  - when run in a source/workspace repo, refreshes only the local installed
    skill plus the `FIRST-TREE-SOURCE-INTEGRATION:` lines
  - migrates repos that still use the previous `skills/first-tree/` path onto
    `.agents/skills/first-tree/` and `.claude/skills/first-tree/`
  - migrates legacy `.context-tree/` repos onto the installed skill layout
  - preserves user-authored sections such as the editable part of `AGENTS.md`

## Compatibility Rules For Legacy Trees

- `context-tree init` never creates a new `.context-tree/`.
- `context-tree init --here` preserves the explicit in-place bootstrap path for
  already-created tree repos.
- Default dedicated-tree-repo creation is local-only. The CLI may create a new
  sibling git repo on disk, but it must not clone the source repo or depend on
  network access.
- Source/workspace repos must never receive `NODE.md`, `members/`, or
  tree-scoped `AGENTS.md` from default init flows.
- Normal `context-tree init` and `context-tree upgrade` flows do not clone the
  source repo or require network access.
- `context-tree verify` may still read a legacy
  `.claude/skills/first-tree/...`, `skills/first-tree/...`, or
  `.context-tree/...` layout in an existing user repo so the repo can be
  repaired or upgraded in place.
- `context-tree upgrade` must migrate either legacy layout onto
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/`, and remove
  old skill directories afterward.
- When both current and legacy layouts are present, prefer the
  `.agents/skills/first-tree/` layout.
- Existing repos may still have a legacy `AGENT.md`; `init` and `upgrade`
  must not silently overwrite it, and follow-up tasks should direct users to
  rename or merge it into `AGENTS.md`.

## Invariants

- Templates, workflows, prompts, helper scripts, and explanatory references
  must stay aligned.
- If a change affects installed payload contents, bump
  `assets/framework/VERSION` so packaged upgrades can detect it.
- Ownership behavior must stay identical across layout changes.
- The tree remains decision-focused; execution detail stays in source systems.
- A path migration is incomplete if task text, docs, tests, and runtime assets
  disagree about where the framework lives.
