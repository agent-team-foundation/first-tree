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

The current installed layout in a source/workspace repo is:

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
FIRST_TREE.md
```

For a source/workspace repo, the local integration stops there. It should also
carry a managed `FIRST-TREE-SOURCE-INTEGRATION:` section in root `AGENTS.md`
and `CLAUDE.md`, but it must not contain tree content.

The current dedicated tree repo layout is:

```text
.first-tree/
  VERSION
  progress.md
  bootstrap.json
NODE.md
AGENTS.md
members/
```

The dedicated tree repo does **not** need local `.agents/skills/first-tree/`
or `.claude/skills/first-tree/` copies. Tree content still lives outside the
metadata directory:

- `NODE.md`
- `AGENTS.md`
- `CLAUDE.md`
- `members/`
- `.first-tree/bootstrap.json` when `first-tree init` was run from a separate
  source/workspace repo and the publish workflow needs to remember that source
  repo path

## Command Intent

- `first-tree init`
  - when run in a source/workspace repo, creates or reuses a sibling dedicated
    tree repo by default
  - installs the skill into the source/workspace repo without creating tree
    files there
  - creates `FIRST_TREE.md` in the source/workspace repo as a symlink to the
    installed `references/about.md` entrypoint
  - upserts the managed `FIRST-TREE-SOURCE-INTEGRATION:` section in root
    `AGENTS.md` and `CLAUDE.md`
  - does **not** install the skill into the target tree repo
  - renders top-level tree scaffolding only in the target tree repo
  - renders both `AGENTS.md` and `CLAUDE.md` in the target tree repo
  - may optionally seed `members/*/NODE.md` from repository contributor history
    when `--seed-members contributors` is set
  - writes dedicated-tree metadata to `.first-tree/`, including
    `.first-tree/progress.md`
- `first-tree verify`
  - checks progress state from the installed tree metadata
  - validates root/frontmatter/agent markers
  - runs node and member validators
  - must reject source/workspace repos that carry only local integration
- `first-tree publish`
  - is the explicit second-stage command for publishing a dedicated tree repo
    to GitHub after local bootstrap
  - reads dedicated-tree bootstrap metadata from
    `.first-tree/bootstrap.json` when available
  - may create or reuse the GitHub `*-tree` repo, continue supporting older
  `*-context` repos, push tree commits, record the published tree repo URL back
  in the source/workspace repo, refresh the ignored local checkout config, and
  optionally open the source-repo PR
- `first-tree upgrade`
  - compares the installed skill payload version to the skill bundled with the
    currently running `first-tree` package
  - refreshes the current install metadata without overwriting tree content
  - when run in a source/workspace repo, refreshes only the local installed
    skill, the `FIRST_TREE.md` symlink, plus the
    `FIRST-TREE-SOURCE-INTEGRATION:` section
  - when run in a dedicated tree repo, refreshes only `.first-tree/`
  - migrates repos that still use the previous `skills/first-tree/` path onto
    `.agents/skills/first-tree/` and `.claude/skills/first-tree/`
  - migrates legacy `.context-tree/` repos onto the installed skill layout
  - preserves user-authored sections such as the editable part of `AGENTS.md`

## Compatibility Rules For Legacy Trees

- `first-tree init` never creates a new `.context-tree/`.
- Default dedicated-tree repo naming uses `*-tree`, but existing bound
  `*-context` repos remain supported and should be reused.
- `first-tree init --here` preserves the explicit in-place bootstrap path for
  already-created tree repos.
- Default dedicated-tree-repo creation is local-only. The CLI may create a new
  sibling git repo on disk, but it must not clone the source repo or depend on
  network access.
- Source/workspace repos must never receive `NODE.md`, `members/`, or
  tree-scoped `AGENTS.md` / `CLAUDE.md` from default init flows.
- Normal `first-tree init` and `first-tree upgrade` flows do not clone the
  source repo or require network access.
- `first-tree verify` may still read a legacy
  `.claude/skills/first-tree/...`, `.agents/skills/first-tree/...`,
  `skills/first-tree/...`, or
  `.context-tree/...` layout in an existing user repo so the repo can be
  repaired or upgraded in place.
- `first-tree upgrade` must migrate either legacy layout onto
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/`, and remove
  old skill directories afterward.
- When both current and legacy layouts are present, prefer the
  `.agents/skills/first-tree/` layout.
- Existing repos may still have a legacy `AGENT.md`; `init` and `upgrade`
  must not silently overwrite it, and follow-up tasks should direct users to
  rename or merge it into `AGENTS.md`.
- Existing repos that predate the mirrored `CLAUDE.md` template should receive
  follow-up tasks directing users to add or update `CLAUDE.md`.

## Invariants

- Templates, workflows, prompts, helper scripts, and explanatory references
  must stay aligned.
- If a change affects installed payload contents, bump
  `assets/framework/VERSION` so packaged upgrades can detect it.
- Ownership behavior must stay identical across layout changes.
- The tree remains decision-focused; execution detail stays in source systems.
- A path migration is incomplete if task text, docs, tests, and runtime assets
  disagree about where the framework lives.
