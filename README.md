# first-tree

Thin distribution package for the canonical `first-tree-cli-framework` skill
and the `context-tree` CLI.

## Package Name vs Command

- The npm package is `first-tree`.
- The installed CLI command is `context-tree`.
- `npx first-tree init` is the quickest one-off entrypoint.
- `npm install -g first-tree` adds `context-tree` to your PATH for repeated use.

## What This Repo Ships

- `src/` keeps the thin CLI shell that parses commands and dispatches to the bundled skill.
- `skills/first-tree-cli-framework/` is the canonical source for framework behavior, shipped templates, maintainer references, and validation logic.
- `evals/` is maintainer-only developer tooling for the source repo. It is intentionally not part of the published package.

## Quick Start

If you are starting a brand-new tree, create a git repo first:

```bash
mkdir my-org-tree && cd my-org-tree
git init
npx first-tree init
```

If you already have the command on your PATH:

```bash
context-tree init
```

The installed package carries the canonical bundled skill, and
`context-tree init` / `context-tree upgrade` install from that bundled copy
instead of cloning this source repo at runtime.

## Commands

| Command | What it does |
| --- | --- |
| `context-tree init` | Bootstrap a new context tree in the current git repo |
| `context-tree verify` | Run verification checks against the current tree |
| `context-tree upgrade` | Refresh the installed framework skill from the current `first-tree` package and write follow-up tasks |
| `context-tree help onboarding` | Print the onboarding guide |

## Runtime And Maintainer Prerequisites

- User trees: the onboarding guide targets Node.js 18+.
- This source repo: use Node.js 22 and pnpm 10 to match CI and the checked-in package manager version.

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
live in `skills/first-tree-cli-framework/`.

- User-facing overview: `skills/first-tree-cli-framework/references/about.md`
- User onboarding: `skills/first-tree-cli-framework/references/onboarding.md`
- Maintainer entrypoint: `skills/first-tree-cli-framework/references/source-map.md`

If you are maintaining this repo, start with the source map instead of relying
on root-level prose.

## Contributing And Security

- See `CONTRIBUTING.md` for local setup, validation expectations, and where changes should live.
- See `SECURITY.md` for vulnerability reporting guidance.

## License

Apache 2.0
