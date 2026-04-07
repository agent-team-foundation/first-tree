# first-tree

Shared context for agent teams.

`first-tree` publishes the `first-tree` CLI and bundles the canonical
`first-tree` skill used to bootstrap and maintain Context Tree repos. A
Context Tree is a Git-native knowledge layer for decisions, ownership, and
cross-domain relationships that agents and humans keep current together.

## Quick Start For Agents

Paste this into your agent from the root of your source or workspace repo:

```text
Install and use the latest `first-tree` CLI in this source/workspace repo.
Run `first-tree init`, follow the dedicated tree repo workflow it creates,
read the onboarding guide and `.first-tree/progress.md`, draft the initial
Context Tree from the codebase, run `first-tree verify` in the dedicated tree
repo, and tell me what still needs to be filled in before publish.
```

The agent will:

- install `.agents/skills/first-tree/` and `.claude/skills/first-tree/`
- add `FIRST_TREE.md` plus the managed `FIRST-TREE-SOURCE-INTEGRATION:`
  section to `AGENTS.md` and `CLAUDE.md`
- create or reuse a sibling dedicated tree repo, usually `<repo>-tree`
- read the onboarding guide and checklist
- draft initial domains and members from the real codebase
- run `first-tree verify` in the dedicated tree repo when the checklist is
  complete

If you also want the agent to publish the tree repo and open the source-repo
PR, append: `Then run first-tree publish --open-pr.`

## Install And Run

The npm package and installed CLI command are both `first-tree`.

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

Recommended manual path from your source or workspace repo:

```bash
cd my-app
npx first-tree init
cd ../my-app-tree
first-tree help onboarding
```

When the onboarding checklist is complete:

```bash
first-tree verify
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

## How first-tree Works Today

`first-tree` uses a two-repo workflow by default.

- The current source/workspace repo is not the Context Tree. It carries only
  local skill integration, the `FIRST_TREE.md` index, the managed
  `FIRST-TREE-SOURCE-INTEGRATION:` section, and local checkout state in
  `.first-tree/local-tree.json`.
- The actual tree content lives in a sibling dedicated tree repo, normally
  named `<repo>-tree`. Existing bound `*-context` repos are still reused.
- Never create `NODE.md`, `members/`, or tree-scoped `AGENTS.md` /
  `CLAUDE.md` in the source/workspace repo. Those files belong only in the
  dedicated tree repo.

After `first-tree publish` succeeds, treat the checkout recorded in
`.first-tree/local-tree.json` as the canonical local working copy for the
tree. The bootstrap checkout can be deleted when you no longer need it.

```text
<source-repo>/                         # source/workspace repo
  .agents/skills/first-tree/           # lightweight installed skill
  .claude/skills/first-tree/           # symlink to .agents/skills/first-tree
  FIRST_TREE.md                        # symlink to references/about.md
  AGENTS.md                            # has FIRST-TREE-SOURCE-INTEGRATION block
  CLAUDE.md                            # has FIRST-TREE-SOURCE-INTEGRATION block
  .first-tree/local-tree.json          # local-only checkout guidance
  ... your normal source code ...

<source-repo>-tree/                    # dedicated tree repo
  .first-tree/
    VERSION
    progress.md
    bootstrap.json
  NODE.md
  AGENTS.md
  CLAUDE.md
  members/
    NODE.md
    <member-id>/
      NODE.md
  ... your domains ...
```

The package carries the bundled canonical skill, so `init` and `upgrade`
install from the package payload instead of cloning this source repo at
runtime.

## What Is A Context Tree

A Context Tree is a Git repository where every directory is a domain and every
file is a node. Each node captures decisions, designs, and cross-domain
relationships: the knowledge that would otherwise scatter across PRs, docs,
issues, chats, and people's heads.

Key properties:

- Nodes are markdown files. Each directory has a `NODE.md` that describes the
  domain. Leaf `.md` files capture specific decisions or designs.
- Every node has an owner. Owners are declared in YAML frontmatter and approve
  changes to their nodes.
- The tree is organized by concern, not by repo or team. An agent working on
  "add SSO" should find auth context in one place.
- The tree is never a snapshot. When decisions change, the tree updates.
  Stale nodes are bugs.

## What Belongs In The Tree

The tree should hold information an agent needs to decide on an approach, not
to execute it.

- Yes: "Auth spans four repos: backend issues JWTs, frontend uses Better Auth,
  extension uses OAuth popup, desktop uses localhost callback."
- No: the function signature of `auth_service.verify()` or the exact body of
  a migration. That belongs in code.

The rule of thumb is simple: keep the what, why, ownership, and cross-domain
connections in the tree. Keep execution detail in source systems.

## Tree Structure

```text
my-org-tree/
  NODE.md              # root - lists all domains
  engineering/
    NODE.md            # architecture, infra, tooling
  product/
    NODE.md            # strategy, roadmap, research
  marketing/
    NODE.md            # positioning, campaigns
  members/
    NODE.md            # people and agents
    alice/
      NODE.md          # individual member node
```

Every node has frontmatter:

```yaml
---
title: "Auth Architecture"
owners: [alice, bob]
soft_links: [/infrastructure/deployments]
---
```

- `title`: display name for the node
- `owners`: who can approve changes; `owners: []` inherits from the parent and
  `owners: [*]` means anyone
- `soft_links`: cross-references to related nodes in other domains
- member nodes also require `type`, `role`, and `domains`

## Commands

| Command | What it does |
| --- | --- |
| `first-tree init` | Install source/workspace integration locally and create or refresh a dedicated tree repo; by default source/workspace repos use `<repo>-tree`, while existing bound `*-context` repos are still reused; use `--here` only when you are already inside the dedicated tree repo, and `--seed-members contributors` to draft member nodes from contributor history |
| `first-tree publish` | Publish a dedicated tree repo to GitHub, record its URL and local checkout guidance back in the source/workspace repo, and optionally open the source-repo PR |
| `first-tree verify` | Run verification checks against the current tree; it fails if onboarding checklist items remain unchecked |
| `first-tree upgrade` | Refresh the installed skill from the current `first-tree` npm package; in a source/workspace repo it updates only local integration, while tree repos also get follow-up tasks |
| `first-tree generate-codeowners` | Generate `.github/CODEOWNERS` from tree ownership frontmatter |
| `first-tree review` | Run the Claude Code PR review helper for a tree repo in CI |
| `first-tree inject-context` | Output a Claude Code SessionStart hook payload from the root `NODE.md` |
| `first-tree help onboarding` | Print the full onboarding guide |
| `first-tree --help` | Show the available commands |
| `first-tree --version` | Print the installed CLI version plus bundled skill version |

## Package And Command

- The npm package is `first-tree`.
- The installed CLI command is also `first-tree`.
- The published package keeps its bundled canonical source under
  `skills/first-tree/`.
- In this source repo, `.agents/skills/first-tree/` and
  `.claude/skills/first-tree/` are tracked symlink aliases back to
  `skills/first-tree/` so local agents resolve the same `first-tree` skill
  that ships in the package.
- Dedicated tree repos keep their local CLI metadata under `.first-tree/`.
- `npx first-tree init` is the quickest one-off entrypoint.
- `npm install -g first-tree` adds `first-tree` to your PATH for repeated
  use.

## Runtime And Maintainer Prerequisites

- User trees: the onboarding guide targets Node.js 18+.
- `first-tree publish` expects GitHub CLI (`gh`) to be installed and
  authenticated.
- This source repo uses Node.js 22 and pnpm 10 to match CI and the checked-in
  package manager version.

## What This Repo Ships

This repo is the open-source CLI/package source for `first-tree`, not a sample
user tree.

- `src/` keeps the thin CLI shell that parses commands and dispatches to the
  bundled behavior.
- `skills/first-tree/` is the canonical source for the shipped skill,
  references, and user-facing framework knowledge.
- `assets/framework/` contains templates, helpers, workflows, and prompts that
  are packaged with the CLI.
- `.agents/skills/first-tree/` and `.claude/skills/first-tree/` in this repo
  are local symlink entrypoints to that canonical source for agent tooling.
- `evals/` is maintainer-only developer tooling for the source repo and is
  intentionally not part of the published package.

## Canonical Documentation

User-facing references ship in `skills/first-tree/references/` and are copied
to user repos via `first-tree init`. Maintainer-only references live in
`docs/` and never ship.

- User-facing overview: `skills/first-tree/references/about.md`
- User onboarding: `skills/first-tree/references/onboarding.md`
- Source/workspace install contract:
  `skills/first-tree/references/source-workspace-installation.md`
- Ownership model:
  `skills/first-tree/references/ownership-and-naming.md`
- Upgrade layout contract:
  `skills/first-tree/references/upgrade-contract.md`
- Maintainer entrypoint: `docs/source-map.md`

If you are maintaining this repo, start with `docs/source-map.md` instead of
relying on root-level prose.

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

## Contributing And Security

- Use the GitHub issue forms for bug reports and feature requests so maintainers
  get reproducible context up front.
- See `CONTRIBUTING.md` for local setup, validation expectations, and where
  changes should live.
- See `CODE_OF_CONDUCT.md` for community expectations.
- See `SECURITY.md` for vulnerability reporting guidance.

## License

Apache 2.0
