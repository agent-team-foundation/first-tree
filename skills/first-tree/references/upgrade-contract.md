# Upgrade Contract

This file describes the installed-skill layout in user repos and how
`first-tree upgrade` refreshes it.

## Two Distribution Channels

The `first-tree` npm package ships two things:

1. **CLI tools** — engine, runtime, validators, helpers, templates, workflows.
   Bundled into `dist/cli.js` plus the `assets/framework/` runtime payload.
   Updated with every published version. Users invoke them via
   `npx -p first-tree first-tree <command>`. Auto-upgrades silently on every
   invocation unless `--skip-version-check` is passed.

2. **Skill payload** — `SKILL.md`, `references/`, and a `VERSION` file.
   Copied verbatim into user repos at `.agents/skills/first-tree/` by
   `first-tree init`. Updated only when the major or minor version of
   `first-tree` bumps (i.e., when the bundled skill changes). The user
   refreshes it explicitly by running `first-tree upgrade`.

The skill payload contains no executable code. It's pure knowledge: what
Context Tree is, the four core principles, the ownership model, the
onboarding narrative, and the install/upgrade contract you're reading now.
Everything else lives in the npm package and is invoked via the CLI.

## Versioning

Three-level: `major.minor.patch`.

- **major** — company-wide milestones; bumped only at major events
- **minor** — skill payload changes (this directory); a minor bump means
  `first-tree upgrade` will refresh the installed skill
- **patch** — CLI behavior changes (engine, helpers, templates); transparent
  via npm; no repo update needed

The installed skill's `VERSION` file tracks `major.minor` only (e.g., `0.2`).
The CLI's full version (`major.minor.patch`, e.g., `0.2.5`) lives in the
npm package's `package.json` and is shown by `first-tree --version` as
`0.2.5 (skills: 0.2)`.

`first-tree upgrade` is a no-op when the installed `major.minor` matches the
bundled CLI's `major.minor`. Patch differences never trigger a refresh.

## Installed Layout

In a source/workspace repo, `first-tree init` produces:

```text
.agents/
  skills/
    first-tree/
      SKILL.md
      VERSION                          # major.minor (e.g. "0.2")
      references/
        about.md
        principles.md                  # also symlinked at repo root
        ownership-and-naming.md        # also symlinked at repo root
        onboarding.md
        source-workspace-installation.md
        upgrade-contract.md            # this file
.claude/
  skills/
    first-tree -> ../../.agents/skills/first-tree
FIRST_TREE.md                          # symlink to references/about.md
```

The source/workspace repo also gets a managed
`FIRST-TREE-SOURCE-INTEGRATION:` block in root `AGENTS.md` and `CLAUDE.md`
plus a `.first-tree/local-tree.json` config that records the dedicated tree
repo location. It must NOT contain `NODE.md`, `members/`, or tree-scoped
`AGENTS.md` / `CLAUDE.md`.

In a dedicated tree repo, `first-tree init` produces:

```text
.first-tree/
  VERSION                              # major.minor
  progress.md
  bootstrap.json                       # source repo metadata for publish
NODE.md                                # root tree node
AGENTS.md
CLAUDE.md
members/
  NODE.md
```

The dedicated tree repo does **not** carry an installed skill — only the
`.first-tree/` metadata. Tree content lives outside that directory.

## Wipe-And-Replace Upgrade

`first-tree upgrade` is a wipe-and-replace operation. There is no
preservation, no migration logic, no merging — the installed skill payload
contains no user customization, so refreshing it is safe and simple.

When you run `first-tree upgrade` in a source/workspace repo:

1. Every known installed-skill location is removed:
   - `.agents/skills/first-tree/`
   - `.claude/skills/first-tree/` (the symlink)
   - `skills/first-tree/` (legacy in-repo location)
   - `.context-tree/` (oldest legacy location)
2. The lightweight skill payload from the bundled package is copied to
   `.agents/skills/first-tree/` and the `.claude/skills/first-tree/` symlink
   is recreated.
3. `.claude/settings.json` is checked: if its SessionStart hook still
   references one of the legacy `inject-tree-context.sh` paths, the command
   is rewritten to `npx -p first-tree first-tree inject-context --skip-version-check`.
4. Any `.github/workflows/{validate,pr-review,codeowners}.yml` files that
   exist are overwritten with the bundled templates so they pick up
   command-name and option changes.
5. The `FIRST_TREE.md` symlink and `FIRST-TREE-SOURCE-INTEGRATION:` block in
   `AGENTS.md` / `CLAUDE.md` are refreshed.
6. A short upgrade task list is written to `progress.md` describing what
   changed and what (if anything) the user needs to verify by hand.

The user's tree content (`NODE.md`, `members/`, leaf nodes) is **never**
touched. The user-authored portions of `AGENTS.md` / `CLAUDE.md` outside the
managed framework markers are preserved.

When you run `first-tree upgrade` in a dedicated tree repo, only the
`.first-tree/VERSION` file is refreshed.

## What Gets Preserved

- All tree content: `NODE.md`, `members/`, leaf nodes, soft links
- User content in `AGENTS.md` / `CLAUDE.md` outside the framework markers
- Root symlinks like `principles.md`, `ownership-and-naming.md`,
  `FIRST_TREE.md` — these still resolve because the targets in
  `references/` are recreated by the wipe-and-replace
- The `.first-tree/local-tree.json` checkout config in source/workspace repos
- User-authored CI workflows that don't match the shipped names

## Command Intent

- `first-tree init`
  - in a source/workspace repo: installs the lightweight skill, creates a
    sibling dedicated tree repo, links `FIRST_TREE.md`, adds the source
    integration markers
  - in a dedicated tree repo (`--here`): scaffolds NODE.md, AGENTS.md,
    CLAUDE.md, members/NODE.md, and `.first-tree/` metadata
  - never installs the skill into a dedicated tree repo
  - reuses existing `*-tree` and `*-context` sibling repos when already bound
- `first-tree verify`
  - reads from the current directory (or `--tree-path`)
  - rejects source/workspace repos that have only the local skill — those
    must be verified via the dedicated tree repo
- `first-tree publish`
  - is the second-stage command after `init` for source/workspace installs
  - creates or reuses the GitHub `*-tree` repo and pushes the local commits
  - records the published tree URL in the source repo
- `first-tree upgrade`
  - wipes and replaces the installed skill payload (see above)
  - no-op when installed `major.minor` matches CLI's `major.minor`
  - migrates legacy layouts (`.context-tree/`, `skills/first-tree/`) by
    deleting them as part of the wipe

## Invariants

- The installed skill is read-only knowledge for users. Local edits will be
  silently overwritten on the next `upgrade`. If you need to customize
  something, fork the upstream package or open an issue.
- A patch bump (`0.2.4` → `0.2.5`) never modifies a user repo — patch
  changes are CLI-only.
- A minor bump (`0.2.x` → `0.3.0`) means the next `first-tree upgrade` will
  rewrite the installed skill. It will also refresh shipped CI workflows and
  the SessionStart hook command if those still use legacy paths.
- The tree remains decision-focused; execution detail stays in source systems.
