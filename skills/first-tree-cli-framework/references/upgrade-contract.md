# Upgrade Contract

This file describes the intended contract for the single-skill refactor and the
compatibility rules we keep while the repo is migrating.

## Canonical Source

- `skills/first-tree-cli-framework/` is the only source of truth.
- `references/` contains explanatory material.
- `assets/framework/` contains the shipped runtime payload.
- The distributable `first-tree` package must carry the canonical skill inside
  the package itself.
- The source repo does not keep a root `.context-tree/`, `docs/`, mirror skill
  directories, or a bundled repo snapshot.

## Installed Layout

The end-state installed layout in a user repo is:

```text
skills/
  first-tree-cli-framework/
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
- `AGENT.md`
- `members/`

## Command Intent

- `context-tree init`
  - installs the skill into the target repo
  - renders top-level tree scaffolding from the skill templates
  - writes progress state to `skills/first-tree-cli-framework/progress.md`
- `context-tree verify`
  - checks progress state from the installed skill
  - validates root/frontmatter/agent markers
  - runs node and member validators
- `context-tree upgrade`
  - compares the installed skill payload version to the skill bundled with the
    currently running `first-tree` package
  - refreshes the installed skill payload without overwriting tree content
  - migrates legacy `.context-tree/` repos onto the installed skill layout
  - preserves user-authored sections such as the editable part of `AGENT.md`

## Compatibility Rules During Migration

- `context-tree init` only installs the skill layout; it never creates a new
  `.context-tree/`.
- Normal `context-tree init` and `context-tree upgrade` flows do not clone the
  source repo or require network access.
- `context-tree verify` may still read a legacy `.context-tree/...` layout in
  an existing user repo so the repo can be upgraded in place.
- `context-tree upgrade` must migrate a legacy `.context-tree/` repo onto the
  installed skill layout and remove the legacy directory afterward.
- When both layouts are present, prefer the installed skill layout.

## Invariants

- Templates, workflows, prompts, helper scripts, and explanatory references
  must stay aligned.
- If a change affects installed payload contents, bump
  `assets/framework/VERSION` so packaged upgrades can detect it.
- Ownership behavior must stay identical across layout changes.
- The tree remains decision-focused; execution detail stays in source systems.
- A path migration is incomplete if task text, docs, tests, and runtime assets
  disagree about where the framework lives.
