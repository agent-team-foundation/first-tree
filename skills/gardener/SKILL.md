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
- Opening a tree issue from a merged source PR (so the tree catches up
  with a decision made in code)
- Running gardener in CI as an automated maintainer
- Diagnosing why gardener skipped a PR (self-review guard, sync-PR
  filter, opt-out config)

Gardener is designed for agents, not humans. Every subcommand is
idempotent and guarded against acting on its own prior comments.

## Core Concepts

- **Sync PR** — a PR opened against a tree repo by automation (commonly
  by `first-tree tree sync`) to propagate a decision; gardener's
  `respond` subcommand fixes these based on reviewer feedback.
- **Source-repo PR/issue** — a PR or issue opened on an application repo
  that gardener's `comment` subcommand evaluates against the bound
  Context Tree and annotates with a structured verdict.
- **Merged-PR → tree issue** — when `comment` sees a merged source PR
  that was never reviewed while open, it can open a tree issue so the
  tree picks up the decision retroactively. Gated by `TREE_REPO_TOKEN`.
- **State marker** — gardener embeds state in HTML comments at the top
  of its reviews: `<!-- gardener:state · reviewed=<sha> · verdict=… · severity=… · tree_sha=… -->`,
  a sibling `last_consumed_rereview` line, and a sibling
  `quiet_refresh_cid` line for rescan fast-path. Parsing is additive —
  legacy comments without newer fields degrade gracefully.
- **Self-loop guard** — gardener skips any PR where only it has
  reviewed, so an automated response cannot trigger another automated
  response.
- **Sync-PR filter (for `comment`)** — gardener does not comment on
  first-tree sync PRs themselves; use `respond` for those.

## CLI Commands

| Command | Purpose |
|---|---|
| `first-tree gardener comment` | Review a source-repo PR or issue against the tree and post a structured verdict comment. Scan mode (no `--pr`/`--issue`) walks every **open** PR and issue. The merge→tree-issue branch only fires on a single MERGED PR with a prior gardener marker (single-item invocation), and requires `TREE_REPO_TOKEN`. Pass `--assign-owners` to auto-assign NODE owners on the tree issue. |
| `first-tree gardener respond` | Acknowledge reviewer feedback on a sync PR (Phase 5: real edit orchestrator for `parent_subdomain_missing` + planner seam — see [#160](https://github.com/agent-team-foundation/first-tree/issues/160) / [#219](https://github.com/agent-team-foundation/first-tree/issues/219); unsupported patterns fall back to a placeholder reply). |
| `first-tree gardener install-workflow` | Scaffold `.github/workflows/first-tree-sync.yml` in the caller's codebase repo so per-PR events drive the sync flow — the push-mode entry point. |

For full options on any command, run `first-tree gardener <command> --help`.

## Typical Flows

### Scan mode — review every open PR/issue across all bound source repos

```bash
npx -p first-tree first-tree gardener comment
```

Run from inside a tree repo. Reads `.claude/gardener-config.yaml`, then
walks every **open** PR and issue on **every** configured source repo
(`target_repo` scalar + `target_repos` list, deduped), posting structured
verdict comments against the tree. Results are aggregated into a single
`BREEZE_RESULT` trailer with `repos=<n>`.

### Scan mode with merged-PR sweep

```bash
npx -p first-tree first-tree gardener comment --merged-since 24h --assign-owners
```

Same as scan mode but also fetches PRs merged within the window (e.g.
`1h`, `24h`, `7d`, or an ISO-8601 timestamp) and routes them through the
same reviewer. Merged PRs with a prior gardener marker take the
merge→tree-issue branch when `TREE_REPO_TOKEN` is set — this is how the
gardener pull-mode daemon catches post-merge events without needing
GitHub webhooks. Without `--merged-since`, scan mode looks at open items
only; the merge→tree-issue branch still fires from single-item
invocations as before.

### Single-item mode — one PR or issue

```bash
npx -p first-tree first-tree gardener comment --pr 42 --repo owner/app-repo
npx -p first-tree first-tree gardener comment --issue 7 --repo owner/app-repo
```

The single-item form is what breeze-runner calls when dispatching on a
notification. Skips the scan; reviews exactly the one item. Also takes
the merge→tree-issue branch when pointed at a single MERGED PR with a
prior gardener marker and `TREE_REPO_TOKEN` set.

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

Single-PR only. There is no scan mode — discovery for respond lives in
breeze's notification poller. Add `--dry-run` to preview.

> **Current behavior (placeholder reply only):** `respond` bumps the
> attempts marker and posts an acknowledgement reply, but does **not**
> yet edit `NODE.md`, commit, or push. Wiring the real edit orchestrator
> is tracked in [#160](https://github.com/agent-team-foundation/first-tree/issues/160)
> with the Phase 5 scope proposal in
> [#219](https://github.com/agent-team-foundation/first-tree/issues/219).

### Dry-run everything

Both subcommands accept `--dry-run`, which prints every planned
`gh`/`git` call without executing it. Use this when introducing gardener
to a new repo or verifying config before a live run.

Add `--assign-owners` to have merged-PR tree issues auto-assigned to
the NODE owners resolved from the tree's `CODEOWNERS`. Push-mode
workflows set this flag by default; pull-mode deployments can opt in
per-invocation.

## Recommended Invocation

```bash
npx -p first-tree first-tree gardener <command>
```

This always runs the latest published version.

## Configuration

Gardener reads `.claude/gardener-config.yaml` from the tree repo
(resolved via `--tree-path`, default cwd):

```yaml
# Either form (or both) is accepted. Scan mode sweeps the deduped union
# in source order: scalar first, then list, then any extras the typed
# loader adds. Pick scalar when binding one source repo, list for fan-out.
target_repo: owner/app-repo          # source repo to review (scalar)
target_repos:                         # source repos to review (list)
  - owner/app-repo-frontend
  - owner/app-repo-backend
tree_repo: owner/tree-repo            # this tree repo (for attribution links)
modules:
  comment:
    enabled: true                     # set false to opt the tree out entirely
  respond:
    enabled: true
```

The `modules.<name>.enabled: false` knob is the opt-out: gardener exits
0 with a `skipped` status without calling `gh`.

## Environment

Gardener reads a small set of env vars. All are optional except
`TREE_REPO_TOKEN`, which is only needed for the merge→issue branch.

| Variable | Purpose |
|---|---|
| `BREEZE_SNAPSHOT_DIR` | Directory with pre-fetched `pr-view.json`, `pr.diff`, `issue-view.json`, `issue-comments.json`, `pr-reviews.json`, `subject.json`. Set by breeze-runner so gardener doesn't re-fetch. Also enables snapshot-mode idempotency checks in `respond` when `pr-commits.json` is present. |
| `TREE_REPO_TOKEN` | PAT with `repo` scope on the tree repo. Consumed **only** by `comment`'s merge→issue branch, for `gh issue create` and the follow-up marker PATCH. No fallback to `GH_TOKEN`/`GITHUB_TOKEN` — if unset, the merge→issue path silently skips and logs `skipped: token_absent`. |
| `COMMENT_LOG` | Path for JSONL run events from `comment` (default `$HOME/.gardener/comment-runs.jsonl`; falls back to `$TMPDIR` when `HOME` is unset). |
| `RESPOND_LOG` | Same shape for `respond` (default `$HOME/.gardener/respond-runs.jsonl`). |

## Guards And Idempotency

Gardener refuses to act when:

- Only it has reviewed the PR (self-loop guard) — prevents infinite
  response loops
- The target PR is itself a `first-tree:sync` PR on a tree repo — use
  `respond` there, not `comment`
- The module is disabled in `.claude/gardener-config.yaml`
- Required inputs (`--pr`, `--issue`, `--repo`) are missing
- `TREE_REPO_TOKEN` is unset on the merge→issue branch (skips that
  branch; other branches continue)

All subcommands are safe to re-run. Idempotency lives in the state
marker: the SHA in `reviewed=<sha>` tells gardener whether a PR has
already been reviewed at this revision, and the `tree_issue_created=<url>`
field prevents duplicate issue creation on a retry.

## Related Skills

- `first-tree` — entry-point skill: methodology, references, routing.
  Load this first.
- `tree` — load if the task also requires direct reads or writes against
  the tree repo (gardener operates *on* PRs; tree tools operate *on* the
  tree itself).
- `breeze` — load if gardener is being invoked from the breeze daemon's
  dispatch pipeline rather than manually.
