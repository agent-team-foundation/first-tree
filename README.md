<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.png">
    <img src="assets/banner-light.png" alt="first-tree" width="100%">
  </picture>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#commands"><strong>Commands</strong></a> &middot;
  <a href="#migration-notes"><strong>Migration</strong></a> &middot;
  <a href="./docs/onboarding.md"><strong>Onboarding</strong></a> &middot;
  <a href="https://github.com/agent-team-foundation/first-tree/discussions"><strong>Discussions</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/first-tree"><img src="https://img.shields.io/npm/v/first-tree?style=for-the-badge&color=FFD700&label=npm" alt="npm version"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/agent-team-foundation/first-tree/ci.yml?style=for-the-badge&label=CI" alt="CI"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-green?style=for-the-badge" alt="License: Apache 2.0"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/stargazers"><img src="https://img.shields.io/github/stars/agent-team-foundation/first-tree?style=for-the-badge&color=blueviolet" alt="GitHub stars"></a>
</p>

# first-tree

**Shared Context for Agent Teams.** A Git-native knowledge layer your team and
your agents both read from and write to, shaped around durable decisions,
ownership, and cross-repo context.

Humans and agents need the _same_ level of context to ship together.
`CLAUDE.md` per repo drifts quickly. Search tools help, but they do not become
the source of truth. `first-tree` is the missing layer: a tree of markdown
nodes in Git where every node has an owner, agents can propose updates after
tasks, and your team can review those updates like normal code changes.

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

## The Current Surface

```text
┌──────────────────────────────────────────────────────────┐
│                  first-tree (umbrella CLI)               │
├───────────────────────────┬──────────────────────────────┤
│           tree            │         github scan          │
│      context layer        │    GitHub chief of staff     │
├───────────────────────────┼──────────────────────────────┤
│ inspect / init / bind /   │ install / start / watch /    │
│ workspace / verify /      │ poll / run / cleanup /       │
│ publish / tree skill ...  │ statusline / doctor          │
└───────────────────────────┴──────────────────────────────┘

Canonical shipped skills in the current proposal:

  skills/first-tree
  skills/first-tree-onboarding
  skills/first-tree-sync
  skills/first-tree-write
  skills/first-tree-github-scan
```

| Surface                      | What it is                                                                                                        | Current workspace status                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`first-tree tree`**        | The Context Tree layer. This is where onboarding, inspection, validation, publishing, and skill maintenance live. | The tree lifecycle surface is implemented in this workspace: `inspect`, `status`, `init`, `bootstrap`, `bind`, `integrate`, `workspace sync`, `verify`, `publish`, `upgrade`, and the maintenance helpers are live. |
| **`first-tree github scan`** | The GitHub inbox runtime. This is the new public home for the old `breeze` behavior.                              | Fully wired to [`packages/github-scan/`](./packages/github-scan/README.md), with fail-closed tree binding checks at the CLI entry and the tree repo handed through to the runtime.                                  |
| **`skills/`**                | Canonical skill payload source for the proposal's five shipped skills.                                            | Present in this repo and copied into the built package. `first-tree tree skill ...` now installs, upgrades, lists, diagnoses, and repairs these canonical payloads.                                                 |

## Why first-tree

|                                               | CLAUDE.md per repo | Search / wiki tools | **first-tree** |
| --------------------------------------------- | ------------------ | ------------------- | -------------- |
| Humans can read it                            | yes                | yes                 | yes            |
| Agents can read it deterministically          | partial            | partial             | yes            |
| Agents can propose updates                    | rare               | rare                | yes            |
| Works across repos                            | weak               | strong              | strong         |
| Ownership is attached to nodes                | rare               | inconsistent        | yes            |
| Can drive GitHub automation with tree context | no                 | no                  | yes            |

## Current Workspace Note

This repository is already on the latest fetched `agent-team-foundation/first-tree`
`main`, and it now carries the proposal-aligned pnpm workspace plus the
`2026-05-01` CLI and skill restructure surface.

That means:

- the public command names now follow the proposal
- `packages/github-scan` is the most complete runtime today and is exposed as
  `first-tree github scan`
- the canonical five-skill payloads now live under `skills/`
- the tree lifecycle surface now has real `init`, `bootstrap`, `bind`,
  `integrate`, `workspace sync`, `verify`, `publish`, `codeowners`,
  `claude-hook`, `inject`, `upgrade`, `review`, and
  `tree skill ...` commands
- new trees scaffold default agent-template files and an org-config placeholder
- `github scan` now routes agents through the shipped First Tree skill set,
  while deeper sync/write orchestration remains an area for future refinement

## Quickstart

From this repository:

```bash
pnpm install
pnpm --filter first-tree build
node apps/cli/dist/index.js tree inspect --json
node apps/cli/dist/index.js tree help onboarding
node apps/cli/dist/index.js github scan --help
```

From the published package:

```bash
npx -p first-tree first-tree tree inspect --json
npx -p first-tree first-tree github scan --help
```

## Quick Start For Agents

Paste one of these into Codex, Claude Code, or another coding agent.

**First repo / first tree:**

```text
Use the latest first-tree CLI.
Run `first-tree tree inspect --json` to classify the current folder, then
walk me through the proposal-aligned onboarding flow for this repo.
```

**Joining an existing shared tree:**

```text
Use the latest first-tree CLI.
Run `first-tree tree inspect --json`, then help me connect this repo to an
existing shared Context Tree and explain any missing port-back behavior.
```

**Checking the GitHub automation runtime:**

```text
Use the latest first-tree CLI.
Run `first-tree github scan --help`, then explain which commands are ready to
use today and which ones require an existing tree binding.
```

## Commands

### `first-tree tree`

| Command                              | What it does                                                  | Status                                                   |
| ------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------- |
| `first-tree tree inspect`            | Classify the current folder and report first-tree metadata    | implemented                                              |
| `first-tree tree status`             | Human-friendly alias for `inspect`                            | implemented                                              |
| `first-tree tree help onboarding`    | Print the current onboarding narrative                        | implemented                                              |
| `first-tree tree init`               | Proposal-aligned onboarding entrypoint                        | implemented                                              |
| `first-tree tree bootstrap`          | Low-level tree bootstrap for an explicit tree checkout        | implemented                                              |
| `first-tree tree bind`               | Bind a source repo or workspace to an existing tree repo      | implemented                                              |
| `first-tree tree integrate`          | Install local tree integration without mutating the tree repo | implemented                                              |
| `first-tree tree workspace sync`     | Bind newly added child repos to the shared tree               | implemented                                              |
| `first-tree tree verify`             | Validate a tree repo                                          | implemented                                              |
| `first-tree tree upgrade`            | Refresh integration and tree metadata                         | implemented                                              |
| `first-tree tree publish`            | Publish a tree repo and refresh bound repos                   | implemented                                              |
| `first-tree tree codeowners`         | Generate `.github/CODEOWNERS` from ownership data             | implemented                                              |
| `first-tree tree claude-hook`        | Install the Claude Code hook wiring                           | implemented                                              |
| `first-tree tree inject`             | Emit the SessionStart payload from `NODE.md`                  | implemented                                              |
| `first-tree tree review`             | Run the tree PR review helper                                 | implemented                                              |
| `first-tree tree skill <subcommand>` | Proposal replacement for the old top-level `skill` namespace  | implemented for install, upgrade, list, doctor, and link |

### `first-tree github scan`

| Command group                                                                                                                                         | What it does                                                          | Status      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------- |
| `install`, `start`, `stop`, `status`, `doctor`, `watch`, `poll`, `run`, `daemon`, `run-once`, `cleanup`, `statusline`, `status-manager`, `poll-inbox` | Proposal-aligned GitHub scan surface backed by `packages/github-scan` | implemented |

Fail-closed binding behavior:

- `install`, `start`, `run`, `daemon`, `run-once`, and `poll` require a bound
  tree repo from `.first-tree/source.json`, or an explicit
  `--tree-repo <owner/repo>` override.
- `status`, `doctor`, `stop`, `cleanup`, `watch`, and hook/internal entrypoints
  can still run without a tree binding so diagnosis is not blocked.

## Migration Notes

The public command path changes introduced by the proposal are:

| Old path                           | New path                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `first-tree breeze <subcommand>`   | `first-tree github scan <subcommand>`                                                                                                                        |
| `first-tree skill <subcommand>`    | `first-tree tree skill <subcommand>`                                                                                                                         |
| `first-tree gardener <subcommand>` | retired; the old gardener logic is split across `first-tree-sync` and `first-tree-write`, with `github scan` only routing notifications into those workflows |

For deeper notes, port-back status, and contributor guidance, see
[docs/cli-restructure-migration.md](./docs/cli-restructure-migration.md).

## Repository Layout

```text
assets/               banner and README visual assets
apps/
  cli/                published `first-tree` CLI package
packages/
  github-scan/        internal implementation for `first-tree github scan`
skills/               canonical shipped skill payloads
docs/
  cli-restructure-migration.md
  skill-topology.md
  onboarding.md
  source-map.md
```

## Open Source Docs

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SUPPORT.md](./SUPPORT.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
