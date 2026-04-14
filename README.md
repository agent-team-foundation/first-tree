# first-tree

first-tree - The living source of truth for your team. Give your agent superpowers with just a skill.

`first-tree` publishes the `first-tree` CLI and bundles the canonical
`first-tree` skill used to bootstrap and maintain Context Tree repos. A
Context Tree is a **Git-native knowledge layer** for decisions, ownership, and
cross-domain relationships that agents and humans keep current together.

## Quick Start For Agents

Paste one of these into your agent (Claude Code, Codex, or any agent you are using) from the root you want to onboard. You only need to decide whether your team needs a new tree or should join an existing one. The agent should inspect the current folder and decide whether it is onboarding a single repo or a multi-repo workspace.

If you are the first person on your team to set up a Context Tree:
```text
Use the latest first-tree CLI (https://github.com/agent-team-foundation/first-tree). First run `first-tree inspect --json` to determine whether the current folder is a single repo or a multi-repo workspace. If it is a multi-repo workspace, treat it as one workspace and create a single shared Context Tree for all repos in the current folder by default, rather than creating one tree per repo. Then install the skill in the current repo or workspace root and complete the onboarding process by creating the appropriate new Context Tree setup for this team.
```

If your team already has a Context Tree:
```text
Use the latest first-tree CLI (https://github.com/agent-team-foundation/first-tree). First run `first-tree inspect --json` to determine whether the current folder is a single repo or a multi-repo workspace. If it is a multi-repo workspace, treat it as one workspace and connect all repos in the current folder to the same shared Context Tree by default, rather than binding each repo to its own separate tree. Then install the skill in the current repo or workspace root and complete the onboarding process by connecting this repo or workspace to the existing shared Context Tree at `https://github.com/<your-organization>/<your-tree-repo-name>`.
```

## Install And Run

The npm package and installed CLI command are both `first-tree`.

- One-off use without installing globally:

  ```bash
  npx -p first-tree first-tree inspect --json
  npx -p first-tree first-tree init
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

## Onboarding Modes

`first-tree` now models onboarding with three explicit concepts:

- `source/workspace root` — the repo or folder where local agent integration is installed
- `tree repo` — the Git repo that stores `NODE.md`, domains, members, and decisions
- `binding` — the metadata that connects a source/workspace root to a tree repo

That model supports three first-class onboarding paths.

### Single Repo + Dedicated Tree

This remains the default for a normal Git repo:

```bash
first-tree init
```

The CLI:

- installs `.agents/skills/first-tree/` and `.claude/skills/first-tree/` in the source/workspace root
- adds `FIRST_TREE.md`
- updates `AGENTS.md` / `CLAUDE.md`
- creates or reuses a sibling `<repo>-tree` checkout
- installs the bundled `first-tree` skill in that tree repo if it is missing
- scaffolds the dedicated tree repo there
- writes binding metadata locally and in the tree repo

### Existing Shared Tree

If the user already has a shared Context Tree, bind to it instead of creating a
new sibling:

```bash
first-tree bind --tree-path ../org-context --tree-mode shared
```

Or let `init` do the same thing as a high-level wrapper:

```bash
first-tree init --tree-path ../org-context --tree-mode shared
```

If the tree is remote-only, pass `--tree-url`; `bind` / `init` will clone a
local checkout, ensure the tree repo has the bundled skill installed, and then
write the binding metadata in both locations.

### Workspace Root + Shared Tree

When the current root is a parent folder or root repo that contains child repos
or submodules, use one shared tree for all of them:

```bash
first-tree init --scope workspace --tree-path ../org-context --tree-mode shared --sync-members
```

Or create a new shared tree automatically:

```bash
first-tree init --scope workspace --sync-members
```

The workspace root gets its own local skill integration plus
`.first-tree/source.json` (with workspace members). Each discovered child repo is then bound as a
`workspace-member` to the same tree via `first-tree workspace sync`.

### Explicit Tree Bootstrap

If you are already inside the tree repo itself, use:

```bash
first-tree init tree --here
```

## Inspect First

`first-tree inspect --json` is the agent-friendly way to classify the current
folder before modifying anything. It reports:

- whether the root is a tree repo, source repo, workspace repo, or workspace folder
- discovered child repos / submodules
- existing `source.json`, `tree.json`, and local checkout state

## What Lives Where

```text
<source-repo-or-workspace>/
  .agents/skills/first-tree/
  .claude/skills/first-tree
  FIRST_TREE.md
  AGENTS.md
  CLAUDE.md
  .first-tree/
    source.json              # .first-tree/source.json (includes workspace members for workspace roots)
  ... source code or workspace folders ...

<tree-repo>/
  .agents/skills/first-tree/
  .claude/skills/first-tree
  .first-tree/
    VERSION
    progress.md
    tree.json                # .first-tree/tree.json
    bindings/                # .first-tree/bindings/
      <source-id>.json
    bootstrap.json           # legacy compatibility for older publish flows
  source-repos.md            # generated index of bound source/workspace repos
  NODE.md
  AGENTS.md
  CLAUDE.md
  members/
    NODE.md
  ... your tree domains ...
```

The source/workspace root is not the tree. It should never contain `NODE.md`,
`members/`, or tree-scoped `AGENTS.md` / `CLAUDE.md`.

The tree repo stores canonical binding metadata in `.first-tree/bindings/` and
generates `source-repos.md` as the human/agent-friendly repo index, while
source/workspace roots keep local checkout guidance in `.first-tree/source.json`
plus their own source/workspace binding state.

## Commands

| Command | What it does |
| --- | --- |
| `first-tree inspect` | Classify the current folder and report existing bindings / child repos |
| `first-tree init` | High-level onboarding wrapper for single repos, shared trees, and workspace roots |
| `first-tree init tree` | Low-level tree bootstrap for an explicit tree checkout |
| `first-tree bind` | Bind the current repo/workspace root to an existing tree repo |
| `first-tree workspace sync` | Bind discovered child repos to the same shared tree |
| `first-tree publish` | Publish a tree repo to GitHub and refresh locally bound source/workspace repos with the published URL |
| `first-tree verify` | Run verification checks against a tree repo |
| `first-tree upgrade` | Refresh installed source/workspace integration or tree metadata from the current package |
| `first-tree generate-codeowners` | Generate `.github/CODEOWNERS` from tree ownership frontmatter |
| `first-tree review` | Run the Claude Code PR review helper for a tree repo in CI |
| `first-tree inject-context` | Output a Claude Code SessionStart hook payload from the root `NODE.md` |
| `first-tree help onboarding` | Print the full onboarding guide |

## Package And Command

- The npm package is `first-tree`.
- The installed CLI command is also `first-tree`.
- The published package keeps its bundled canonical source under
  `skills/first-tree/`.
- In this source repo, `.agents/skills/first-tree/` and
  `.claude/skills/first-tree/` are tracked symlink aliases back to
  `skills/first-tree/` so local agents resolve the same `first-tree` skill
  that ships in the package.
- `npx -p first-tree first-tree <command>` is the recommended one-off entrypoint.

## Canonical Documentation

User-facing references ship in `skills/first-tree/references/` and are copied
to user repos via `first-tree init` / `first-tree bind`. Maintainer-only
references live in `docs/` and never ship.

- User-facing overview: `skills/first-tree/references/about.md`
- User onboarding: `skills/first-tree/references/onboarding.md`
- Source/workspace install contract:
  `skills/first-tree/references/source-workspace-installation.md`
- Upgrade and layout contract:
  `skills/first-tree/references/upgrade-contract.md`
- Maintainer entrypoint: `docs/source-map.md`

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

- Use the GitHub issue forms for bug reports and feature requests.
- See `CONTRIBUTING.md` for local setup and validation expectations.
- See `CODE_OF_CONDUCT.md` for community expectations.
- See `SECURITY.md` for vulnerability reporting guidance.

## License

Apache 2.0
