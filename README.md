# first-tree

`first-tree` publishes the `context-tree` CLI and bundles the canonical
`first-tree` skill used to bootstrap and maintain Context Tree repos.

## Install And Run

- One-off use without installing globally:

  ```bash
  npx first-tree init
  ```

- Global install:

  ```bash
  npm install -g first-tree
  context-tree init
  ```

- Show the installed CLI version:

  ```bash
  context-tree --version
  ```

- Show the command list:

  ```bash
  context-tree --help
  ```

Although the npm package is named `first-tree`, the installed CLI command is
`context-tree`.

## Quick Start

Recommended workflow: start from your source or workspace repo and let
`context-tree init` create a sibling dedicated tree repo.

```bash
cd my-app
npx first-tree init
cd ../my-app-context
```

If you already created a dedicated tree repo yourself, initialize it in place:

```bash
mkdir my-org-context && cd my-org-context
git init
context-tree init --here
```

- `context-tree init` installs `.agents/skills/first-tree/` and
  `.claude/skills/first-tree/`, creates `NODE.md`, `AGENTS.md`,
  `members/NODE.md`, and writes a checklist to
  `.agents/skills/first-tree/progress.md`.
- `context-tree verify` checks both the progress checklist and deterministic
  tree validation. It is expected to fail until the required onboarding tasks
  are complete.
- `context-tree upgrade` refreshes the installed skill from the currently
  running `first-tree` npm package. To force the newest published package for a
  one-off upgrade, run `npx first-tree@latest upgrade`.

The package carries the bundled canonical skill, so `init` and `upgrade`
install from the package payload instead of cloning this source repo at
runtime.

## Commands

| Command | What it does |
| --- | --- |
| `context-tree init` | Create or refresh a dedicated context tree repo; use `--here` to initialize the current repo in place |
| `context-tree verify` | Run verification checks against the current tree |
| `context-tree upgrade` | Refresh the installed skill from the current `first-tree` npm package and write follow-up tasks |
| `context-tree help onboarding` | Print the onboarding guide |
| `context-tree --help` | Show the available commands |
| `context-tree --version` | Print the installed CLI version |

## Package Name vs Command

- The npm package is `first-tree`.
- The installed CLI command is `context-tree`.
- The installed skill directories inside a user tree are
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/`.
- The published package keeps its bundled canonical source under
  `skills/first-tree/`.
- When maintainer docs say "the `first-tree` skill", they mean that bundled
  skill directory, not the npm package name.
- `npx first-tree init` is the quickest one-off entrypoint.
- `npm install -g first-tree` adds `context-tree` to your PATH for repeated
  use.

## Runtime And Maintainer Prerequisites

- User trees: the onboarding guide targets Node.js 18+.
- This source repo: use Node.js 22 and pnpm 10 to match CI and the checked-in
  package manager version.

## What This Repo Ships

- `src/` keeps the thin CLI shell that parses commands and dispatches to the
  bundled skill.
- `skills/first-tree/` is the canonical source for framework behavior, shipped
  templates, maintainer references, and validation logic.
- `context-tree init` installs that bundled skill into `.agents/skills/first-tree/`
  and `.claude/skills/first-tree/` inside user repos.
- `evals/` is maintainer-only developer tooling for the source repo. It is
  intentionally not part of the published package.

## Developing This Repo

Run these commands from the repo root:

```bash
pnpm install --frozen-lockfile
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
```

When package contents or install/upgrade behavior changes, also run:

```bash
pnpm pack
```

## Canonical Documentation

All framework documentation, maintainer guidance, and shipped runtime assets
live in `skills/first-tree/`.

- User-facing overview: `skills/first-tree/references/about.md`
- User onboarding: `skills/first-tree/references/onboarding.md`
- Maintainer entrypoint: `skills/first-tree/references/source-map.md`

If you are maintaining this repo, start with the source map instead of relying
on root-level prose.

## Contributing And Security

- Use the GitHub issue forms for bug reports and feature requests so maintainers
  get reproducible context up front.
- See `CONTRIBUTING.md` for local setup, validation expectations, and where
  changes should live.
- See `CODE_OF_CONDUCT.md` for community expectations.
- See `SECURITY.md` for vulnerability reporting guidance.

## License

Apache 2.0
