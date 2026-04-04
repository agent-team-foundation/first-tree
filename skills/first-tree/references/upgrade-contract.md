# Upgrade Contract

This file describes the current installed-layout contract and the compatibility
rules we keep for legacy `skills/first-tree-cli-framework/` and
`.context-tree/` repos.

## Canonical Source

- `skills/first-tree/` is the only source of truth.
- `references/` contains explanatory material.
- `assets/framework/` contains the shipped runtime payload.
- The distributable `first-tree` package must carry the canonical skill inside
  the package itself.
- The source repo does not keep a root `.context-tree/`, `docs/`, mirror skill
  directories, or a bundled repo snapshot.

## Installed Layout

The current installed layout in a user repo is:

```text
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
```

The tree content still lives outside the skill:

- `NODE.md`
- `AGENTS.md`
- `members/`

## Command Intent

- `context-tree init`
  - when run in a source/workspace repo, creates or reuses a sibling dedicated
    tree repo by default
  - installs the skill into the target tree repo
  - renders top-level tree scaffolding from the skill templates
  - writes progress state to `skills/first-tree/progress.md`
- `context-tree verify`
  - checks progress state from the installed skill
  - validates root/frontmatter/agent markers
  - runs node and member validators
- `context-tree upgrade`
  - compares the installed skill payload version to the skill bundled with the
    currently running `first-tree` package
  - refreshes the installed skill payload without overwriting tree content
  - migrates repos that still use the previous
    `skills/first-tree-cli-framework/` path onto `skills/first-tree/`
  - migrates legacy `.context-tree/` repos onto the installed skill layout
  - preserves user-authored sections such as the editable part of `AGENTS.md`

## Compatibility Rules For Legacy Trees

- `context-tree init` never creates a new `.context-tree/`.
- `context-tree init --here` preserves the explicit in-place bootstrap path for
  already-created tree repos.
- Default dedicated-tree-repo creation is local-only. The CLI may create a new
  sibling git repo on disk, but it must not clone the source repo or depend on
  network access.
- Normal `context-tree init` and `context-tree upgrade` flows do not clone the
  source repo or require network access.
- `context-tree verify` may still read a legacy
  `skills/first-tree-cli-framework/...` or `.context-tree/...` layout in an
  existing user repo so the repo can be upgraded in place.
- `context-tree upgrade` must migrate either legacy layout onto
  `skills/first-tree/` and remove the old directory afterward.
- When both layouts are present, prefer the installed skill layout.
- Existing repos may still have a legacy `AGENT.md`; `init` and `upgrade`
  must not silently overwrite it, and follow-up tasks should direct users to
  rename it to `AGENTS.md`.

## Invariants

- Templates, workflows, prompts, helper scripts, and explanatory references
  must stay aligned.
- If a change affects installed payload contents, bump
  `assets/framework/VERSION` so packaged upgrades can detect it.
- Ownership behavior must stay identical across layout changes.
- The tree remains decision-focused; execution detail stays in source systems.
- A path migration is incomplete if task text, docs, tests, and runtime assets
  disagree about where the framework lives.
