<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.png">
    <img src="assets/banner-light.png" alt="first-tree" width="100%">
  </picture>
</p>

<p align="center">
  <a href="#install-and-run"><strong>Quickstart</strong></a> &middot;
  <a href="https://first-tree.ai/"><strong>Website</strong></a> &middot;
  <a href="#commands"><strong>Commands</strong></a> &middot;
  <a href="https://github.com/agent-team-foundation/first-tree/discussions"><strong>Discussions</strong></a> &middot;
  <a href="https://discord.gg/J47j3RFgsB"><strong>Discord</strong></a> &middot;
  <a href="https://x.com/first_tree_ai"><strong>X</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/first-tree"><img src="https://img.shields.io/npm/v/first-tree?style=for-the-badge&color=FFD700&label=npm" alt="npm version"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/agent-team-foundation/first-tree/ci.yml?style=for-the-badge&label=CI" alt="CI"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-green?style=for-the-badge" alt="License: Apache 2.0"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/stargazers"><img src="https://img.shields.io/github/stars/agent-team-foundation/first-tree?style=for-the-badge&color=blueviolet" alt="GitHub stars"></a>
  <a href="https://discord.gg/J47j3RFgsB"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/first_tree_ai"><img src="https://img.shields.io/badge/Follow-%40first__tree__ai-000000?style=for-the-badge&logo=x&logoColor=white" alt="X / Twitter"></a>
  <a href="https://first-tree.ai/"><img src="https://img.shields.io/badge/Built%20by-Agent%20Team%20Foundation-blueviolet?style=for-the-badge" alt="Built by Agent Team Foundation"></a>
</p>

# first-tree

**Shared Context for Agent Teams.** A Git-native knowledge layer your team and your agents both read from and write to — kept alive by a context-aware review bot, and a chief-of-staff daemon that clears your GitHub inbox while you sleep.

Humans and agents need the *same* level of context to ship together. Notion is human-first with AI bolted on. CLAUDE.md per repo drifts within a week. Glean is search-shaped, not write-back. `first-tree` is the missing layer: a tree of markdown nodes in a Git repo where every node has an owner, agents propose updates after each task, and owners approve like a tiny PR.

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/claude-code-dark.svg"><img src="assets/logos/claude-code-light.svg" width="32" alt="Claude Code" /></picture><br/><sub>Claude Code</sub></td>
    <td align="center"><img src="assets/logos/openclaw.png" width="32" alt="OpenClaw" /><br/><sub>OpenClaw</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/codex-dark.svg"><img src="assets/logos/codex-light.svg" width="32" alt="Codex" /></picture><br/><sub>Codex</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg"><img src="assets/logos/cursor-light.svg" width="32" alt="Cursor" /></picture><br/><sub>Cursor</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/gemini-dark.svg"><img src="assets/logos/gemini-light.svg" width="32" alt="Gemini CLI" /></picture><br/><sub>Gemini CLI</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/github-dark.svg"><img src="assets/logos/github-light.svg" width="32" alt="GitHub" /></picture><br/><sub>GitHub</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/mcp-dark.svg"><img src="assets/logos/mcp-light.svg" width="32" alt="MCP" /></picture><br/><sub>MCP</sub></td>
  </tr>
</table>
</div>

---

## The Three Tools

```
┌──────────────────────────────────────────────────────────────────────┐
│                         first-tree (umbrella CLI)                    │
├──────────────┬───────────────────────────┬───────────────────────────┤
│    tree      │        gardener           │          breeze           │
│  toolkit     │     auto-maintainer       │     AI chief of staff     │
├──────────────┼───────────────────────────┼───────────────────────────┤
│  the         │ context-aware PR review   │ context-aware: hijacks    │
│  context     │ bot. keeps the tree       │ your GitHub @-mentions    │
│  layer       │ coherent as code changes; │ and review requests,      │
│  itself      │ flags drift, drafts       │ spawns agent runners that │
│              │ updates, reviews them.    │ actually fix issues and   │
│              │                           │ ship the work, clears     │
│              │                           │ your inbox while you      │
│              │                           │ sleep.                    │
└──────────────┴───────────────────────────┴───────────────────────────┘
```

| Tool | What it is | When to reach for it |
|------|------------|----------------------|
| **[tree](src/products/tree)** | The **context layer**. CLI toolkit (`first-tree tree init/inspect/bind/workspace/publish/verify/...`) for creating and tending a Context Tree — markdown nodes with owners, the living source of truth your team and your agents share. | You want one place that humans and agents both read and write — without notion drift, without `.cursorrules` rot. |
| **[gardener](src/products/gardener)** | The **context auto-maintainer**. A context-aware PR review bot that detects drift between your code and the tree, drafts updates, posts verdict comments, and answers reviewer feedback. Runs as a workflow or daemon. | You want the tree to stay coherent as code changes without anyone manually keeping it in sync. |
| **[breeze](src/products/breeze)** | The **AI chief of staff for GitHub**. Context-aware (it reads from the tree). Hijacks your @-mentions and review requests, spawns agent runners that actually fix issues and ship the work. Clears your inbox while you sleep. | You want an agent sitting on your GitHub notifications, reading your tree's context, and shipping work — not just summarizing it. |

Every product ships:
- an operational handbook at `skills/<name>/SKILL.md` (loaded into agents),
- a lazy CLI dispatcher at `src/products/<name>/cli.ts`,
- its own semver'd `VERSION` file, independent from the npm package version.

The umbrella `first-tree` skill at [`skills/first-tree/`](skills/first-tree/) is the single entry point an agent reads first — it teaches the Context Tree methodology and routes to the three product skills above. The CLI also exposes one **maintenance namespace** — `first-tree skill ...` — for skill installation, diagnosis, and repair. It is not a fourth product.

---

## Why first-tree

| | CLAUDE.md per repo | Notion / Glean | `.cursorrules` | **first-tree** |
|---|---|---|---|---|
| Humans can read it | ✓ | ✓ | partial | ✓ |
| Agents can read it | ✓ | search-only | ✓ | ✓ |
| Agents can write back | partial | ✗ | ✗ | ✓ (PR-style) |
| Survives across repos | ✗ (drifts) | ✓ | ✗ | ✓ |
| Owner-per-node accountability | ✗ | ✗ | ✗ | ✓ |
| Stays current as code changes | ✗ (manual) | ✗ (manual) | ✗ (manual) | ✓ (gardener) |
| Acts on GitHub notifications | ✗ | ✗ | ✗ | ✓ (breeze) |

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

Paste one of these into Claude Code, Codex, or any agent — from the root you want to onboard:

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

**Driving one full gardener → breeze cycle end-to-end:**

Paste this as-is — the agent will ask you which repos to target before running anything, so there's nothing to fill in up front.

```text
I want to set up first-tree — a Context Tree that tracks decisions across
my source repos. It ships two agents: gardener (detects drift and drafts
tree updates) and breeze (a local daemon that dispatches gardener on
GitHub notifications).

Latest release: https://github.com/agent-team-foundation/first-tree/releases/latest

Install the CLI, then run `first-tree tree help onboarding` to load the
onboarding narrative. Before running any setup command, ask me which
source repo (owner/name) and which tree repo (owner/name) to target, and
wait for my answers — do not infer from the current working directory.
Once I've confirmed both, walk me through setup (which includes
`first-tree skill install`, at which point the full skill reference also
becomes available at `.agents/skills/first-tree/references/onboarding.md`),
then trigger one drift event end-to-end so I can watch: source PR → tree
issue → breeze pickup → draft-node PR.
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

When the current root is a workspace, the workspace root gets local integration plus `.first-tree/source.json` (with workspace members), and `first-tree tree init --scope workspace` binds currently discovered child repos as `workspace-member`s to the same shared tree by default. Run `first-tree tree workspace sync` later after adding new child repos.

See [`skills/first-tree/references/onboarding.md`](skills/first-tree/references/onboarding.md) for the full guide, and run `first-tree tree help onboarding` to print it.

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

The source/workspace root is never a tree — it never contains `NODE.md`, `members/`, or tree-scoped `AGENTS.md` / `CLAUDE.md`. Source-side state lives under `.first-tree/source.json`; tree-side state lives under `.first-tree/tree.json` and `.first-tree/bindings/<source-id>.json`. The default dedicated tree repo name is `<repo>-tree`, while shared tree setups continue to work cleanly for multi-repo workspaces.

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
| `first-tree gardener comment` | Review a source-repo PR or issue against the tree and post a structured verdict comment; scan mode sweeps every configured `target_repo`. Requires `ANTHROPIC_API_KEY` in the environment — without it the CLI skips without posting. Override the model with `GARDENER_CLASSIFIER_MODEL` (default: `claude-haiku-4-5`). |
| `first-tree gardener respond` | Fix a tree-repo sync PR based on reviewer feedback |
| `first-tree gardener install-workflow` | Scaffold the push-mode GitHub Actions workflow in a codebase repo |
| `first-tree gardener start` | Launch the pull-mode gardener daemon in the background |
| `first-tree gardener status` | Report gardener daemon PID, schedule, and last-run state |
| `first-tree gardener run-once` | Execute both gardener sweeps inline and exit |
| `first-tree gardener stop` | Stop the pull-mode gardener daemon |
| `first-tree breeze install --allow-repo owner/repo` | Check prerequisites, create `~/.breeze/config.yaml`, and start the daemon |
| `first-tree breeze start --allow-repo owner/repo` | Launch the breeze daemon in the background |
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
- The CLI also exposes one maintenance namespace: `skill`. Run `first-tree --help` for the routing.
- The published package ships **four skill payloads**, each with the same name in the package and when installed into a user repo:
  - `skills/first-tree/` — the umbrella entry-point `first-tree` skill (methodology, references, routing).
  - `skills/tree/`, `skills/breeze/`, `skills/gardener/` — one operational handbook per product CLI.
- In this source repo, `.agents/skills/first-tree/` and `.claude/skills/first-tree/` (plus the three product equivalents) are tracked symlink aliases back to the four `skills/<name>/` payloads, so local agents resolve the same skills the package ships.
- `npx first-tree <namespace> <command>` is the recommended human-facing one-off entrypoint.
- For automation, hooks, and CI templates, prefer the more explicit `npx -p first-tree first-tree <namespace> <command>` form.

---

## Canonical Documentation

User-facing references ship under `skills/first-tree/references/` and get copied into user repos by `first-tree tree init` / `first-tree tree bind`:

- Methodology overview: `skills/first-tree/references/whitepaper.md`
- Onboarding guide: `skills/first-tree/references/onboarding.md`
- Source/workspace install contract: `skills/first-tree/references/source-workspace-installation.md`
- Upgrade and layout contract: `skills/first-tree/references/upgrade-contract.md`

Decision-grade design knowledge for this project lives in the bound Context Tree under `first-tree-skill-cli/`, not in this repo:

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

See [`AGENTS.md`](AGENTS.md) (== `CLAUDE.md`) for maintainer rules, and [`docs/source-map.md`](docs/source-map.md) for the annotated file map.

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
