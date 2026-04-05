# first-tree

`first-tree` publishes the `first-tree` CLI and bundles the canonical
`first-tree` skill used to bootstrap and maintain Context Tree repos.

## Install And Run

- One-off use without installing globally:

  ```bash
  npx first-tree init
  ```

- Global install:

  ```bash
  npm install -g first-tree
  first-tree init
  ```

- Show the installed CLI version:

  ```bash
  first-tree --version
  ```

- Show the command list:

  ```bash
  first-tree --help
  ```

The npm package and installed CLI command are both `first-tree`.

## Quick Start

Recommended workflow: start from your source or workspace repo and let
`first-tree init` installs local source/workspace integration and creates a
sibling dedicated tree repo.

```bash
cd my-app
npx first-tree init
cd ../my-app-context
first-tree publish --open-pr
```

If you already created a dedicated tree repo yourself, initialize it in place:

```bash
mkdir my-org-context && cd my-org-context
git init
first-tree init --here
```

Only use `--here` after you have already switched into the dedicated tree repo.
Do not use it inside the source/workspace repo unless you intentionally want
that repo itself to become the Context Tree.

- `first-tree init` installs `.agents/skills/first-tree/` and
  `.claude/skills/first-tree/` in the current source/workspace repo, appends a
  single `FIRST-TREE-SOURCE-INTEGRATION:` line to root `AGENTS.md` and
  `CLAUDE.md`, then creates `NODE.md`, tree-scoped `AGENTS.md`,
  `members/NODE.md`, and a checklist in the dedicated tree repo at
  `.agents/skills/first-tree/progress.md`.
- Never create `NODE.md`, `members/`, or tree-scoped `AGENTS.md` in the
  source/workspace repo. Those files live only in the dedicated `*-context`
  repo.
- After drafting the initial tree version, run `first-tree publish --open-pr`
  from the dedicated tree repo. That command creates or reuses the GitHub
  `*-context` repo, adds it back to the source/workspace repo as a git
  submodule, and opens a PR instead of merging automatically.
- After `first-tree publish` succeeds, treat the source repo's submodule
  checkout as the canonical local working copy for the tree. The temporary
  sibling bootstrap checkout can be deleted when you no longer need it.
- `first-tree verify` checks both the progress checklist and deterministic
  tree validation. It is expected to fail until the required onboarding tasks
  are complete.
- `first-tree upgrade` refreshes the installed skill from the currently
  running `first-tree` npm package. In a source/workspace repo it refreshes
  only the local installed skill plus the
  `FIRST-TREE-SOURCE-INTEGRATION:` line; use `--tree-path` to upgrade the
  dedicated tree repo. To force the newest published package for a one-off
  upgrade, run `npx first-tree@latest upgrade`.

The package carries the bundled canonical skill, so `init` and `upgrade`
install from the package payload instead of cloning this source repo at
runtime.

## Commands

| Command | What it does |
| --- | --- |
| `first-tree init` | Install source/workspace integration locally and create or refresh a dedicated context tree repo; use `--here` only when you are already inside the dedicated tree repo |
| `first-tree publish` | Publish a dedicated tree repo to GitHub, add it back to the source/workspace repo as a submodule, and optionally open the source-repo PR |
| `first-tree verify` | Run verification checks against the current tree |
| `first-tree upgrade` | Refresh the installed skill from the current `first-tree` npm package; in a source/workspace repo it updates only local integration, while tree repos also get follow-up tasks |
| `first-tree help onboarding` | Print the onboarding guide |
| `first-tree --help` | Show the available commands |
| `first-tree --version` | Print the installed CLI version |

## Package And Command

- The npm package is `first-tree`.
- The installed CLI command is also `first-tree`.
- The installed skill directories inside a user tree are
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/`.
- The published package keeps its bundled canonical source under
  `skills/first-tree/`.
- When maintainer docs say "the `first-tree` skill", they mean that bundled
  skill directory, not the npm package name.
- `npx first-tree init` is the quickest one-off entrypoint.
- `npm install -g first-tree` adds `first-tree` to your PATH for repeated
  use.

## Runtime And Maintainer Prerequisites

- User trees: the onboarding guide targets Node.js 18+.
- `first-tree publish` also expects GitHub CLI (`gh`) to be installed and
  authenticated against GitHub.
- This source repo: use Node.js 22 and pnpm 10 to match CI and the checked-in
  package manager version.

## What This Repo Ships

- `src/` keeps the thin CLI shell that parses commands and dispatches to the
  bundled skill.
- `skills/first-tree/` is the canonical source for framework behavior, shipped
  templates, maintainer references, and validation logic.
- `first-tree init` installs that bundled skill into `.agents/skills/first-tree/`
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
- Source/workspace install contract: `skills/first-tree/references/source-workspace-installation.md`
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
