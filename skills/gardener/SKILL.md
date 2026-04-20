---
name: gardener
description: Operate the `first-tree gardener` CLI — an automated maintenance agent that responds to reviewer feedback on Context Tree sync PRs, posts structured verdict comments on source-repo PRs/issues, and (push mode) installs a GitHub Actions workflow that replaces the long-running gardener service with event-driven per-PR sync. Use whenever a task involves reviewing, responding to, or resolving feedback on tree sync PRs, gating source-repo PRs/issues against a Context Tree, or setting up automatic tree-issue creation from a codebase's CI.
---

# Gardener — Operational Skill

This skill is the operational handbook for the `gardener` product. If you
have not yet loaded the `first-tree` entry-point skill, load that first —
it explains the toolkit layout and how the four skills relate. This skill
covers *how* to drive the `first-tree gardener` CLI.

## Two Operating Modes

Gardener supports two deployment shapes that share the same verdict and
issue-filing logic:

| Mode | How it runs | When to use |
|---|---|---|
| **Push (workflow)** | `.github/workflows/first-tree-sync.yml` in the codebase repo fires per-PR; no daemon. | You (or your agent) can land a workflow file in the codebase. Lowest latency, zero infra. |
| **Pull (service)** | A `first-tree gardener` process polls target repos from outside. | The codebase repo is third-party or you otherwise can't push workflow files. |

Both modes open the same tree-repo issue on merge and post the same
verdict comment shape on open/updated PRs. The only difference is the
trigger. For the push-mode installer + auth + troubleshooting walkthrough,
see [`../first-tree/references/workflow-mode.md`](../first-tree/references/workflow-mode.md).

## When To Use This Skill

Load this skill when the task involves any of:

- Installing the push-mode sync workflow in a codebase repo (the user
  owns the codebase and wants event-driven, per-PR tree sync without
  running a service)
- Responding to reviewer feedback on a Context Tree sync PR
- Posting a structured verdict comment on a source-repo PR or issue that
  tests cross-domain alignment with a Context Tree
- Running gardener in CI as an automated maintainer
- Diagnosing why gardener skipped a PR (self-review guard, sync-PR filter)

Gardener is designed for agents, not humans. Every subcommand is
idempotent and guarded against acting on its own prior comments.

## Core Concepts

- **Sync PR** — a PR opened against a tree repo by automation (commonly
  by `first-tree tree sync`) to propagate a decision; gardener's
  `respond` subcommand fixes these based on reviewer feedback.
- **Source-repo PR/issue** — a PR or issue opened on an application repo
  that gardener's `comment` subcommand evaluates against the bound
  Context Tree and annotates with a structured verdict.
- **Self-loop guard** — gardener skips any PR where only it has reviewed,
  so an automated response cannot trigger another automated response.
- **Sync-PR filter (for `comment`)** — gardener does not comment on
  first-tree sync PRs themselves; use `respond` for those.

## CLI Commands

| Command | Purpose |
|---|---|
| `first-tree gardener respond` | Acknowledge reviewer feedback on a sync PR (placeholder reply only — does not yet edit, commit, or push; see [#160](https://github.com/agent-team-foundation/first-tree/issues/160)) |
| `first-tree gardener comment` | Review a source-repo PR/issue against the tree and post a structured verdict comment. On a MERGED PR with a prior gardener marker, also creates a tree-repo issue; pass `--assign-owners` to auto-assign NODE owners on that issue. |
| `first-tree gardener install-workflow` | Scaffold `.github/workflows/first-tree-sync.yml` in the caller's codebase repo so per-PR events drive the sync flow — the push-mode entry point. |

For full options on any command, run `first-tree gardener <command> --help`.

## Typical Flows

### Install the push-mode workflow in a codebase repo

Agent-driven path. Before running anything, walk the user through the
preflight in [`../first-tree/references/workflow-mode.md`](../first-tree/references/workflow-mode.md)
(confirm consent, tree-repo slug, codebase-repo slug). Then:

```bash
npx -p first-tree first-tree gardener install-workflow \
  --tree-repo <OWNER>/<TREE_REPO_NAME>
```

Set the `TREE_REPO_TOKEN` secret (see the workflow-mode reference for
the quick `gh auth token` path and its caveats, or the scoped-PAT
fallback). Commit the generated workflow file and open a PR. On every
PR merge thereafter the workflow files a tree-repo issue assigned to
the NODE owners.

### Respond to feedback on a sync PR

```bash
npx -p first-tree first-tree gardener respond --pr 123 --repo owner/tree-repo
```

Add `--dry-run` to preview the proposed changes without editing the PR.

> **Current behavior (placeholder reply only):** `respond` bumps the
> attempts marker and posts an acknowledgement reply, but does **not**
> yet edit `NODE.md`, commit, or push. Wiring the real edit orchestrator
> is tracked in [#160](https://github.com/agent-team-foundation/first-tree/issues/160)
> and is sequenced after the respond refactor in
> [#162](https://github.com/agent-team-foundation/first-tree/issues/162).

### Comment on a source-repo PR or issue (pull-mode invocation)

```bash
npx -p first-tree first-tree gardener comment --pr 42 --repo owner/app-repo
npx -p first-tree first-tree gardener comment --issue 7 --repo owner/app-repo
```

Add `--assign-owners` to have merged-PR tree issues auto-assigned to
the NODE owners resolved from the tree's `CODEOWNERS`. Push-mode
workflows set this flag by default; pull-mode deployments can opt in
per-invocation.

## Recommended Invocation

```bash
npx -p first-tree first-tree gardener <command>
```

This always runs the latest published version.

## Guards And Idempotency

Gardener refuses to act when:

- Only it has reviewed the PR (self-loop guard) — prevents infinite
  response loops
- The target PR is itself a `first-tree:sync` PR on a tree repo — use
  `respond` there, not `comment`
- Required inputs (`--pr`, `--issue`, `--repo`) are missing

All subcommands are safe to re-run; re-running does not duplicate
comments or re-trigger edits.

## Related Skills

- `first-tree` — entry-point skill: methodology, references, routing.
  Load this first.
- `tree` — load if the task also requires direct reads or writes against
  the tree repo (gardener operates *on* PRs; tree tools operate *on* the
  tree itself).
- `breeze` — load if gardener is being invoked from the breeze daemon's
  dispatch pipeline rather than manually.
