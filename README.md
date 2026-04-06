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
`first-tree init` install local source/workspace integration and create a
sibling dedicated tree repo. By default that repo is named `<repo>-tree`;
existing bound `*-context` repos are still reused.

```bash
cd my-app
npx first-tree init
cd ../my-app-tree
first-tree publish --open-pr
```

If you want the initial bootstrap to draft `members/*/NODE.md` from the
repository's contributor history, opt in explicitly:

```bash
npx first-tree init --seed-members contributors
```

If you already created a dedicated tree repo yourself, initialize it in place:

```bash
mkdir my-org-tree && cd my-org-tree
git init
first-tree init --here
```

Only use `--here` after you have already switched into the dedicated tree repo.
Do not use it inside the source/workspace repo unless you intentionally want
that repo itself to become the Context Tree.

- `first-tree init` installs `.agents/skills/first-tree/` and
  `.claude/skills/first-tree/` plus a `FIRST_TREE.md` symlink to
  `.agents/skills/first-tree/references/about.md` in the current
  source/workspace repo, appends a managed
  `FIRST-TREE-SOURCE-INTEGRATION:` section to root `AGENTS.md` and `CLAUDE.md`,
  then creates `NODE.md`, tree-scoped `AGENTS.md`, tree-scoped `CLAUDE.md`,
  `members/NODE.md`, and a checklist in the dedicated tree repo at
  `.first-tree/progress.md`.
- `first-tree init --seed-members contributors` also seeds
  `members/*/NODE.md` in the target tree repo from GitHub contributors when
  available, and falls back to local git history otherwise.
- Never create `NODE.md`, `members/`, or tree-scoped `AGENTS.md` /
  `CLAUDE.md` in the source/workspace repo. Those files live only in the
  dedicated `*-tree` repo; existing `*-context` repos are still supported.
- After drafting the initial tree version, run `first-tree publish --open-pr`
  from the dedicated tree repo. That command creates or reuses the GitHub
  `*-tree` repo, keeps working with older `*-context` repos, records the
  published tree GitHub URL back in the source/workspace repo, refreshes the
  ignored local tree checkout config, and opens a PR instead of merging
  automatically.
- After `first-tree publish` succeeds, treat the checkout recorded in
  `.first-tree/local-tree.json` as the canonical local working copy for the
  tree. The bootstrap checkout can be deleted when you no longer need it.
- `first-tree verify` checks both the progress checklist and deterministic
  tree validation. It is expected to fail until the required onboarding tasks
  are complete.
- `first-tree upgrade` refreshes the installed skill from the currently
  running `first-tree` npm package. In a source/workspace repo it refreshes
  only the local installed skill, the `FIRST_TREE.md` symlink, plus the
  `FIRST-TREE-SOURCE-INTEGRATION:` section; use `--tree-path` to upgrade the
  dedicated tree repo's `.first-tree/` metadata. To force the newest published
  package for a one-off upgrade, run `npx first-tree@latest upgrade`.

The package carries the bundled canonical skill, so `init` and `upgrade`
install from the package payload instead of cloning this source repo at
runtime.

## Commands

| Command | What it does |
| --- | --- |
| `first-tree init` | Install source/workspace integration locally and create or refresh a dedicated tree repo; by default source/workspace repos use `<repo>-tree`, while existing bound `*-context` repos are still reused; use `--here` only when you are already inside the dedicated tree repo, and `--seed-members contributors` to draft member nodes from contributor history |
| `first-tree publish` | Publish a dedicated tree repo to GitHub, record its URL and local checkout guidance back in the source/workspace repo, and optionally open the source-repo PR |
| `first-tree verify` | Run verification checks against the current tree |
| `first-tree upgrade` | Refresh the installed skill from the current `first-tree` npm package; in a source/workspace repo it updates only local integration, while tree repos also get follow-up tasks |
| `first-tree help onboarding` | Print the onboarding guide |
| `first-tree --help` | Show the available commands |
| `first-tree --version` | Print the installed CLI version |

## Package And Command

- The npm package is `first-tree`.
- The installed CLI command is also `first-tree`.
- The installed skill directories inside a user tree are
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/` in a
  source/workspace repo.
- In this source repo, those same two paths are tracked symlink aliases back
  to `skills/first-tree/` so local agents can resolve the latest bundled skill
  without a copied mirror.
- Dedicated tree repos keep their local CLI metadata under `.first-tree/`.
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
- `.agents/skills/first-tree/` and `.claude/skills/first-tree/` in this repo
  are local symlink entrypoints to that canonical source for agent tooling.
- `first-tree init` installs that bundled skill into `.agents/skills/first-tree/`
  and `.claude/skills/first-tree/` inside source/workspace repos, and writes
  `.first-tree/` metadata only inside dedicated tree repos.
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
