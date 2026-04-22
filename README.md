# first-tree

**A Git-native knowledge layer for your team — and a three-tool suite that keeps it alive.**

`first-tree` publishes the `first-tree` CLI and its bundled agent skills. A
Context Tree is the living source of truth for decisions, ownership, and
cross-domain relationships that humans and agents maintain together —
`first-tree` is the toolkit that lets agents build, tend, and react to it.

---

## The Three Tools

```
┌──────────────────────────────────────────────────────────────────────┐
│                         first-tree (umbrella CLI)                    │
├──────────────┬───────────────────────────┬───────────────────────────┤
│    tree      │        gardener           │          breeze           │
│  toolkit     │     maint. agent          │     local daemon          │
├──────────────┼───────────────────────────┼───────────────────────────┤
│  init, bind, │ reviews source PRs/issues │ watches gh notifications  │
│  workspace,  │ and sync PRs; can run as  │ → labels / routes / drafts│
│  publish,    │ a workflow or daemon.     │ replies for PRs, issues,  │
│  verify, ... │                           │ discussions, reviews.     │
└──────────────┴───────────────────────────┴───────────────────────────┘
                           │
                   ┌───────┴────────┐
                   │ first-tree     │  ← umbrella skill:
                   │    skill       │    methodology, references,
                   │                │    routing into the product skills
                   └────────────────┘
```

| Tool | What it is | When to reach for it |
|------|------------|----------------------|
| **[tree](src/products/tree)** | CLI toolkit for `first-tree tree inspect/status/init/bootstrap/bind/integrate/workspace/publish/verify/upgrade/...` | You want an agent to create, maintain, or bind a Context Tree repo. |
| **[gardener](src/products/gardener)** | Maintenance agent for drift sync, source-repo verdict comments, sync-PR review responses, and optional push-mode workflow / pull-mode daemon orchestration | You want the tree to stay coherent as code changes without asking a human to drive it. |
| **[breeze](src/products/breeze)** | Local inbox daemon that takes over your `gh` login and turns GitHub notifications into a triaged, optionally auto-handled queue | You want an agent sitting on your GitHub notifications so you don't have to. |

Every product ships:
- an operational handbook at `skills/<name>/SKILL.md` (loaded into agents),
- a lazy CLI dispatcher at `src/products/<name>/cli.ts`,
- its own semver'd `VERSION` file, independent from the npm package version.

The umbrella `first-tree` skill at [`skills/first-tree/`](skills/first-tree/)
is the single entry point an agent reads first — it teaches the Context Tree
methodology and routes to the three product skills above. The CLI also exposes
one **maintenance namespace** — `first-tree skill ...` — for skill
installation, diagnosis, and repair. It is not a fourth product.

---

## Install And Run

The npm package and installed CLI command are both `first-tree`.

- One-off use without installing globally:

  ```bash
  npx first-tree tree inspect --json
  npx first-tree tree init
  ```

  For automation, hooks, or CI templates, prefer the more explicit form:

  ```bash
  npx -p first-tree first-tree tree inspect --json
  ```

- Global install:

  ```bash
  npm install -g first-tree
  first-tree tree init
  ```

- Show the installed CLI version:

  ```bash
  first-tree --version
  ```

- Show the command list:

  ```bash
  first-tree --help
  ```

---

## Quick Start For Agents

Paste one of these into Claude Code, Codex, or any agent — from the root you
want to onboard:

**First person on the team:**

```text
Use the latest first-tree CLI (https://github.com/agent-team-foundation/first-tree).
Run `first-tree tree inspect --json` to classify the current folder, then install
the skill and onboard this repo or workspace by creating a new Context Tree.
```

**Joining an existing tree:**

```text
Use the latest first-tree CLI (https://github.com/agent-team-foundation/first-tree).
Run `first-tree tree inspect --json`, install the skill, and onboard this repo
or workspace to the existing shared tree at
https://github.com/<your-org>/<your-tree-repo>.
```

---

## Onboarding Modes

`first-tree` models onboarding with three explicit concepts:

- **source / workspace root** — the repo or folder that gets local agent integration
- **tree repo** — the Git repo that stores `NODE.md`, domains, members, decisions
- **binding** — metadata that links a source to a tree

Four first-class paths:

| Scenario | Command |
|----------|---------|
| Single repo + new dedicated tree | `first-tree tree init` |
| Single repo + existing shared tree | `first-tree tree init --tree-path ../org-context --tree-mode shared` |
| Workspace root + shared tree | `first-tree tree init --scope workspace` (pass `--tree-path` / `--tree-url` to reuse an existing shared tree; run `first-tree tree workspace sync` later after adding new repos) |
| You're inside the tree repo itself | `first-tree tree bootstrap --here` |

When the current root is a workspace, the workspace root gets local integration
plus `.first-tree/source.json` (with workspace members), and
`first-tree tree init --scope workspace` binds currently discovered child repos
as `workspace-member`s to the same shared tree by default. Run
`first-tree tree workspace sync` later after adding new child repos.

See [`skills/first-tree/references/onboarding.md`](skills/first-tree/references/onboarding.md)
for the full guide, and run `first-tree tree help onboarding` to print it.

---

## What Lives Where

```text
<source-repo-or-workspace>/
  .agents/skills/{first-tree,tree,breeze,gardener}/
  .claude/skills/{first-tree,tree,breeze,gardener}
  WHITEPAPER.md
  AGENTS.md
  CLAUDE.md
  .first-tree/
    source.json              # includes workspace members for workspace roots
  … your code …

<tree-repo>/
  .agents/skills/{first-tree,tree,breeze,gardener}/
  .claude/skills/{first-tree,tree,breeze,gardener}
  .first-tree/
    VERSION
    progress.md
    tree.json
    bindings/<source-id>.json
    bootstrap.json
  source-repos.md
  NODE.md
  AGENTS.md
  CLAUDE.md
  members/NODE.md
  … tree domains …
```

The source/workspace root is never a tree — it never contains `NODE.md`,
`members/`, or tree-scoped `AGENTS.md` / `CLAUDE.md`. Source-side state lives
under `.first-tree/source.json`; tree-side state lives under
`.first-tree/tree.json` and `.first-tree/bindings/<source-id>.json`. The
default dedicated tree repo name is `<repo>-tree`, while shared tree setups
continue to work cleanly for multi-repo workspaces.

---

## Commands

| Command | What it does |
| --- | --- |
| `first-tree tree inspect` | Classify the current folder and report existing bindings / child repos |
| `first-tree tree status` | Human-friendly alias for `inspect` |
| `first-tree tree init` | High-level onboarding wrapper for single repos, shared trees, and workspace roots |
| `first-tree tree bootstrap` | Canonical low-level tree bootstrap for an explicit tree checkout |
| `first-tree tree bind` | Lower-level binding primitive for cases where you need explicit `--mode` control |
| `first-tree tree integrate` | Install local skill integration and source-integration files without mutating the tree repo |
| `first-tree tree workspace sync` | Bind newly added child repos to the same shared tree, or rerun workspace-member binding manually |
| `first-tree tree publish` | Publish a dedicated tree repo or shared tree repo to GitHub and refresh locally bound source/workspace repos |
| `first-tree tree verify` | Run verification checks against a tree repo |
| `first-tree tree upgrade` | Refresh installed source/workspace integration or tree metadata from the current package |
| `first-tree tree generate-codeowners` | Generate `.github/CODEOWNERS` from tree ownership frontmatter |
| `first-tree tree review` | Run the Claude Code PR review helper for a tree repo in CI |
| `first-tree tree invite` | Invite a new member to the Context Tree (human, personal_assistant, or autonomous_agent) |
| `first-tree tree join` | Accept an invite and join a Context Tree |
| `first-tree tree inject-context` | Output a Claude Code SessionStart hook payload from the root `NODE.md` |
| `first-tree tree help onboarding` | Print the full onboarding guide |
| `first-tree gardener sync` | Detect drift between a tree repo and its bound source repos; supports `--propose` and `--apply`. Moved from `first-tree tree sync`. |
| `first-tree gardener comment` | Review a source-repo PR or issue against the tree and post a structured verdict comment; scan mode sweeps every configured `target_repo` |
| `first-tree gardener respond` | Fix a tree-repo sync PR based on reviewer feedback |
| `first-tree gardener install-workflow` | Scaffold the push-mode GitHub Actions workflow in a codebase repo |
| `first-tree gardener start` | Launch the pull-mode gardener daemon in the background |
| `first-tree gardener status` | Report gardener daemon PID, schedule, and last-run state |
| `first-tree gardener run-once` | Execute both gardener sweeps inline and exit |
| `first-tree gardener stop` | Stop the pull-mode gardener daemon |
| `first-tree breeze install` | Check prerequisites, create `~/.breeze/config.yaml`, and start the daemon |
| `first-tree breeze start` | Launch the breeze daemon in the background |
| `first-tree breeze status` | Print daemon/runtime status for the current breeze profile |
| `first-tree breeze watch` | Open the live TUI inbox and activity feed |
| `first-tree breeze poll` | Poll GitHub notifications once without requiring the daemon |
| `first-tree skill install` | Install the four shipped skills under `.agents/skills/*` and `.claude/skills/*` |
| `first-tree skill upgrade` | Wipe and reinstall the four shipped skills from the current package |
| `first-tree skill list` | Print the four shipped skills with their installed status and version |
| `first-tree skill doctor` | Diagnose whether the four shipped skills are installed and healthy |
| `first-tree skill link` | Idempotently repair the `.claude/skills/*` alias symlinks |

---

## Package And Command

- The npm package is `first-tree`.
- The installed CLI command is also `first-tree`.
- The CLI dispatches into three products: `tree`, `breeze`, `gardener`.
- The CLI also exposes one maintenance namespace: `skill`.
  Run `first-tree --help` for the routing.
- The published package ships **four skill payloads**, each with the same
  name in the package and when installed into a user repo:
  - `skills/first-tree/` — the umbrella entry-point `first-tree` skill (methodology, references, routing).
  - `skills/tree/`, `skills/breeze/`, `skills/gardener/` — one operational handbook per product CLI.
- In this source repo, `.agents/skills/first-tree/` and `.claude/skills/first-tree/`
  (plus the three product equivalents) are tracked symlink aliases back to the
  four `skills/<name>/` payloads, so local agents resolve the same skills the
  package ships.
- `npx first-tree <namespace> <command>` is the recommended human-facing
  one-off entrypoint.
- For automation, hooks, and CI templates, prefer the more explicit
  `npx -p first-tree first-tree <namespace> <command>` form.

---

## Canonical Documentation

User-facing references ship under `skills/first-tree/references/` and get
copied into user repos by `first-tree tree init` / `first-tree tree bind`:

- Methodology overview: `skills/first-tree/references/whitepaper.md`
- Onboarding guide: `skills/first-tree/references/onboarding.md`
- Source/workspace install contract:
  `skills/first-tree/references/source-workspace-installation.md`
- Upgrade and layout contract:
  `skills/first-tree/references/upgrade-contract.md`

Decision-grade design knowledge for this project lives in the bound Context Tree
under `first-tree-skill-cli/`, not in this repo:

- Canonical architecture: `first-tree-skill-cli/repo-architecture.md`
- Canonical sync design: `first-tree-skill-cli/sync.md`

Repo-local maintainer notes live in:

- `docs/source-map.md`
- `docs/architecture/overview.md`
- `docs/architecture/thin-cli.md`
- `docs/architecture/versioning.md`
- `docs/build/distribution.md`
- `docs/testing/overview.md`
- `docs/design/sync.md`

These are implementation-only and never ship.

---

## Repository Layout (For Contributors)

```text
src/
  cli.ts                  # umbrella dispatcher
  products/
    manifest.ts           # single source of truth for product/meta registration
    tree/                 # tree product (CLI + engine)
    breeze/               # breeze product (CLI + engine + daemon)
    gardener/             # gardener product (CLI + engine)
  meta/
    skill-tools/          # `first-tree skill ...` maintenance commands
  shared/
    version.ts            # shared VERSION/package readers
assets/
  tree/                   # runtime assets installed into user repos
  breeze/                 # breeze dashboard HTML
skills/
  first-tree/             # umbrella skill (methodology + routing)
  tree/ breeze/ gardener/ # per-product operational handbooks
tests/
  tree/ breeze/ gardener/ meta/ e2e/     # grouped by product
docs/                     # maintainer-only implementation notes
evals/                    # maintainer-only evaluation harness
```

See [`AGENTS.md`](AGENTS.md) (== `CLAUDE.md`) for maintainer rules, and
[`docs/source-map.md`](docs/source-map.md) for the annotated file map.

---

## Developing

```bash
pnpm install --frozen-lockfile
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
pnpm pack            # when package contents change
```

Evals live in [`evals/`](evals) — see `evals/README.md`.

## Contributing And Security

- GitHub issue forms for bugs and feature requests.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) for local setup and validation expectations.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community expectations.
- [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## License

Apache 2.0
