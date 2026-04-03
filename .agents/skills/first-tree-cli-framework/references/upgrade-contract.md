# Upgrade Contract

This file describes the intended contract for the single-skill refactor and the
compatibility rules we keep while the repo is migrating.

## Canonical Source

- `skills/first-tree-cli-framework/` is the only source of truth.
- `references/` contains explanatory material.
- `assets/framework/` contains the shipped runtime payload.
- `docs/` and root `.context-tree/` are exported mirrors during the transition.

## Installed Layout

The end-state installed layout in a user repo is:

```text
skills/
  first-tree-cli-framework/
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

The tree content still lives outside the skill:

- `NODE.md`
- `AGENT.md`
- `members/`

## Command Intent

- `context-tree init`
  - installs the skill into the target repo
  - renders top-level tree scaffolding from the skill templates
  - writes progress state
  - wires an upstream remote for future upgrades
- `context-tree verify`
  - checks progress state
  - validates root/frontmatter/agent markers
  - runs node and member validators
- `context-tree upgrade`
  - compares the installed skill payload version to upstream
  - refreshes the installed skill payload without overwriting tree content
  - preserves user-authored sections such as the editable part of `AGENT.md`

## Compatibility Rules During Migration

- The CLI may temporarily read either:
  - `skills/first-tree-cli-framework/...`
  - legacy `.context-tree/...`
- When both layouts are present, prefer the installed skill layout.
- The legacy layout must be derivable from the canonical skill via
  `scripts/export-runtime-assets.sh`.
- `references/repo-snapshot/` may exist as a portable artifact until cleanup,
  but it is not authoritative.

## Invariants

- Templates, workflows, prompts, helper scripts, and explanatory references
  must stay aligned.
- Ownership behavior must stay identical across layout changes.
- The tree remains decision-focused; execution detail stays in source systems.
- A path migration is incomplete if task text, docs, tests, and runtime assets
  disagree about where the framework lives.
