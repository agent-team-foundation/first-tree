---
name: gardener
description: Operate the `first-tree gardener` CLI — an automated maintenance agent that responds to reviewer feedback on Context Tree sync PRs, posts structured verdict comments on source-repo PRs/issues, and (push mode) installs a GitHub Actions workflow that replaces the long-running gardener service with event-driven per-PR sync. Use whenever a task involves reviewing, responding to, or resolving feedback on tree sync PRs, gating source-repo PRs/issues against a Context Tree, or setting up automatic tree-issue creation from a codebase's CI.
---

# Gardener — Operational Skill

This skill is the operational handbook for the `gardener` product. If you
have not yet loaded the `first-tree` entry-point skill, load that first —
it explains the toolkit layout and how the four skills relate. This skill
covers *how* to drive the `first-tree gardener` CLI.

## Onboarding — short user prompts

The expected user onboarding shape is one short message naming a codebase
repo and a tree repo, e.g.:

> 监听 `https://github.com/<codebase-repo>` 这个 repo, tree 是
> `https://github.com/<tree-repo>`. update the latest first-tree CLI
> first, set up gardener + breeze for this scope, the rest of the check
> are after the onboarding

From that one line, branch on scenarios A–E below to pick the right
setup path, then run **Scenario F** to smoke-test the full pipeline end
to end. Do **not** pepper the user with config questions up front —
infer what you can, ask only when the inference is genuinely ambiguous.
Always finish by restarting the breeze daemon with the new
`--allow-repo` list so notifications flow.

### Step 0 — auto-detect the deployment mode

Before picking a scenario, resolve the source repo's permission level so
you don't guess push vs pull:

```bash
gh repo view <source-slug> --json viewerPermission -q .viewerPermission
```

- `ADMIN` / `MAINTAIN` / `WRITE` → go to **Scenario B** (push mode,
  lower latency, no daemon).
- `READ` / `TRIAGE` / `NONE` → go to **Scenario C** (pull mode, local
  daemon). The user cannot land a workflow file in the source repo;
  don't even suggest it.
- Command fails (repo not found, not logged in) OR returns
  `null`/empty → stop and ask the user. `null` on a public repo
  usually means `gh` isn't authenticated (the command "succeeds" but
  the viewer is anonymous); treat it the same as the fail branch, not
  as READ.

If the tree repo doesn't exist yet, run **Scenario A** first, then come
back to this step.

### The end-to-end pipeline (what onboarding is actually wiring)

Gardener + breeze together form a routing pipeline. Scenarios A–E below
each set up some subset of it; this overview is the target state every
scenario points at so you can tell the user what they're getting:

```
source-repo activity  (PR merges, new PRs)
        │
        ▼
gardener sync  ──►  detects drift between source and tree
        │
        ▼ (--open-issues mode, preferred for multi-owner trees)
one tree-repo issue per proposal, assigned to that node's owners
        │
        ▼
GitHub notification fires for each assignee
        │
        ▼
the assignee's breeze (on their own laptop) sees the notification
        │
        ▼
breeze dispatches to the right agent (gardener draft-node)
        │
        ▼
agent opens a tree PR  ──►  gardener-respond handles review feedback
```

**Key shape — GitHub assignment is the routing table.** If gardener
assigns `@bingran-you`, bingran's breeze picks it up. If it assigns
`@serenakeyitan`, her breeze does. No central queue, no shared server.
Each person runs their own breeze against their own notifications.

**Two handshake points the onboarding must actually verify:**

1. **NODE.md has `owners:` frontmatter** — without it, `sync --open-issues`
   falls back to the tree-repo default owner and labels the issue
   `needs-owner`. Fine for demos; not for steady-state routing.
2. **Each owner has breeze running locally with the tree repo in their
   `--allow-repo` list** — without it, the assignment notification fires
   and dies in the void. This is the "connect the pipes" step: you are
   not done with onboarding until breeze has surfaced at least one real
   gardener notification.

See **Scenario F — try it end-to-end** below for the smoke test, then
**Scenario G — review the draft-node PR** for closing the loop.

### Scenario A — fresh: no tree repo yet

Detected when the user hasn't given a tree slug, or the slug 404s.

1. `first-tree tree init` — scaffold a new tree in cwd.
2. Create a GitHub repo (`gh repo create ...`), push, bind locally.
3. Populate `.claude/gardener-config.yaml` with the codebase slug under
   `target_repos`.
4. Continue with Scenario B or C depending on push access.

### Scenario B — user owns the codebase (push mode, preferred)

Step 0 returned ADMIN / MAINTAIN / WRITE for the source repo.

1. Confirm `ANTHROPIC_API_KEY` is available (ask user to paste into their
   shell env if not already exported).
2. `first-tree gardener install-workflow --tree-repo <tree>` inside the
   codebase repo.
3. Walk through `skills/first-tree/references/workflow-mode.md` for
   `TREE_REPO_TOKEN` + `ANTHROPIC_API_KEY` secret setup (audit-log
   caveats must be surfaced before `gh secret set`).
4. Open the workflow PR for human review.

### Scenario C — user does not own the codebase (pull mode)

Step 0 returned READ / TRIAGE / NONE for the source repo, or the user
explicitly said they can't push.

**Pick a routing mode before running any command:**

| Command | What it does | When to use |
|---|---|---|
| `first-tree gardener sync --open-issues` (operator-run) | Opens one **issue** per drift proposal on the tree repo, assigned to that node's owners. Breeze on the owner's laptop picks it up → dispatches to `gardener draft-node` → draft-node opens the fix PR. Today this is an operator-run step — run it manually (or on a cron) from the tree repo; it isn't wired into the `gardener start` daemon. | **Default for multi-owner trees.** This is the only mode that exercises the draft-node dispatch — it uses GitHub assignment as the distributed queue each owner's local breeze pulls from. Scenario F validates this path. |
| `first-tree gardener start --sync-apply` | Tells the pull-mode daemon's scheduled sync sweep to open one **PR** directly on the tree repo with all drift fixes batched together. No issue, no assignment step. | Solo trees, quick-sync demos, or when you want drift fixed automatically without the issue-first routing hop. Scenario F does not apply (no assignment step to observe). |

Once you've picked a routing mode:

1. `export ANTHROPIC_API_KEY=...` in the shell that will start the daemon
   (launchd inherits env at bootstrap time, not at run time).
2. Start the gardener daemon from inside the tree repo:
   - issue-first routing: `first-tree gardener start --tree-path . --code-repo <source> --assign-owners` (then run `first-tree gardener sync --open-issues` manually or on a cron)
   - batched PR routing: `first-tree gardener start --tree-path . --code-repo <source> --assign-owners --sync-apply`
3. **Start breeze with the full allow-list:**
   ```bash
   first-tree breeze start --allow-repo <tree-slug>,<source-slug>
   ```
   The `--allow-repo` flag is **required** — breeze silently scans
   nothing without it. If the daemon is already running with a different
   allowlist, `first-tree breeze start` now fails loudly (#293); stop it
   first (`first-tree breeze stop`) then re-start with the merged csv.
4. `first-tree gardener status` + `first-tree breeze status` to confirm
   both are live, then run **Scenario F** to watch the full chain
   execute on a real (or synthetic) drift.

> **No watch-subscription requirement for routing.** Breeze uses
> `/notifications?participating=true` (per #290), so the tree-repo
> issue's assignee receives the notification directly from the
> assignment — they don't need to Watch the tree repo. Watching a
> third-party source repo you aren't directly participating on is a
> no-op under this filter. Pull-mode **gardener** itself doesn't
> consume GitHub notifications; `gardener sync` polls source activity
> via `gh` directly on its own schedule.

### Scenario D — add a repo to an existing setup

Detected when `~/.gardener/config.json` already exists or `target_repos`
in the tree's gardener-config.yaml is non-empty.

1. Append the new slug to `target_repos` in
   `.claude/gardener-config.yaml`.
2. Push mode: run `install-workflow` in the new codebase if the user
   owns it; pull mode: `gardener stop && gardener start` with the added
   `--code-repo`.

### Scenario E — reset / something broken

User describes missing comments or stale notifications.

1. `gardener status` + tail the latest log under `~/.gardener/logs/`.
2. Verify `ANTHROPIC_API_KEY` is in the launchd plist
   (`plutil -p ~/.gardener/launchd/com.first-tree.gardener.<user>.plist`).
3. `gardener stop && gardener start ...` with the same args. Restart
   breeze with `breeze start --allow-repo ...` after.

### Scenario F — try it end-to-end (the "connect the pipes" step)

Runs after A/B/C/D so the user can watch **one full cycle** execute:
drift detected → issue filed on tree → breeze notification → draft-node
dispatch → fix PR opened → Scenario G review. Don't skip this on the
first onboarding — it's the only way to verify routing actually works
before the user walks away thinking it does.

**The chain Scenario F proves is wired:**

```
source drift → [gardener sync] → tree-repo issue → GitHub notification
→ [owner's breeze] → [gardener draft-node] → tree-repo PR → Scenario G
```

Every arrow is a place that can silently drop the message. Each step
below names the checkpoint so you know exactly where the break is.

1. **Preconditions** — `TREE_REPO_TOKEN` set on the shell; at least one
   NODE.md in the tree has `owners:` frontmatter naming a GitHub login;
   breeze is installed on the laptop owned by that login; that breeze
   has both the tree and source repos in its `--allow-repo` list. No
   GitHub watch subscription is required — the assignee receives a
   participating notification from the assignment itself.
2. **Seed a synthetic drift** — if no real drift exists, make a small
   change in the source repo and land it (a merged PR with a commit
   message that mentions something not yet in the tree is enough).
3. **Dry-run the sync in the tree repo**:
   ```bash
   cd <tree-path>
   first-tree gardener sync --open-issues --dry-run
   ```
   **Expect:** `would open issue on <tree-slug>: "[gardener] <title>"`
   with the right assignees listed. If it says `[needs-owner]`, the
   affected node's `owners:` frontmatter is empty — fix that first, or
   the routing step (5) has nowhere to go.
4. **Run it for real**:
   ```bash
   first-tree gardener sync --open-issues
   ```
   **Expect:** `✒ opened issue on <tree-slug>: <url> (assignees: @<login>)`.
   Open the URL in the browser and confirm the assignees match the
   NODE.md frontmatter. **Checkpoint:** the issue exists on GitHub with
   a `<!-- gardener:sync-proposal ... -->` marker in the body and a
   `### Proposed node content` section.
5. **Watch breeze deliver the notification** — on the assignee's laptop,
   within the poll interval (default 30s), `~/.breeze/inbox.json` gets
   a new entry for the issue and the Claude Code statusline announces
   it. **Checkpoint:** `first-tree breeze inbox` lists the new issue.
   If nothing appears: check `first-tree breeze status`, confirm the
   `--allow-repo` list, confirm `gh auth status` user matches the
   assignee.
6. **Let the draft-node dispatch run** — breeze reads the issue body,
   sees the `<!-- gardener:sync-proposal` marker, and invokes
   ```bash
   first-tree gardener draft-node --issue <n> --tree-repo <slug>
   ```
   under the hood. draft-node copies the `### Proposed node content`
   into the tree at the right NODE.md path and opens a PR named
   `first-tree/draft-node-<proposal_id>` against the tree repo.
   **Checkpoint:** a new PR exists on the tree repo, linked from the
   issue (`Closes <tree-slug>#<n> on merge.`), and breeze has labeled
   the issue `breeze:done`. See Scenario G for what that PR looks like
   and how to review it.

If any step fails, the pipeline isn't connected — fix that step before
telling the user onboarding is done. The most common breaks are (a)
breeze isn't running with the tree repo in `--allow-repo`, (b) the
NODE.md has no `owners:`, or (c) the assignee's `gh auth status` login
doesn't match the login in `owners:`.

### Scenario G — review the draft-node PR (close the loop)

After Scenario F lands, a tree PR branch named
`first-tree/draft-node-<proposal_id>` appears on the tree repo. This is
where the human reviews the machine-drafted NODE.md before it merges.

1. **Open the PR** — the breeze task comment links to it; otherwise list
   the tree repo's open PRs and look for a `[gardener] draft <node>`
   title or a `first-tree/draft-node-<proposal_id>` head branch.
2. **Read the diff** — the PR body links back to the source issue
   (`Closes <tree-slug>#<n> on merge.`) and shows the source SHA or
   source PR. The NODE.md content was copied verbatim from the issue
   body; draft-node does not synthesize or summarize.
3. **Edit in-place** — push fixups to the same branch if the proposal
   needs correction; do **not** rewrite the tree by hand in a separate
   PR. Keeping edits on the draft-node branch preserves the link to the
   original proposal for later audits.
4. **Merge** — squash-merge via `gh pr merge --squash`. The tree issue
   closes automatically via the `Closes` directive.
5. **Re-run sync** — next sync of that source SHA should report no
   drift on that node. If it still does, the proposal didn't address
   all drift spans; open a fresh proposal rather than amending.

If `draft-node` skips because the issue body has no `### Proposed node
content` section (common on merged-PR variants), hand-edit the tree
from the issue's summary links instead.

### Always: restart breeze last

After any scenario, restart breeze with the full `--allow-repo` list so
gardener-filed tree issues and PR comments surface in the Claude Code
statusline. **Never use `--allow-repo all`** — it reopens the
2026-04-21 stranger-repo incident.

## Two Operating Modes

Gardener supports two deployment shapes that share the same verdict and
issue-filing logic:

| Mode | How it runs | When to use |
|---|---|---|
| **Push (workflow)** | `.github/workflows/first-tree-sync.yml` in the codebase repo fires per-PR; no daemon. | You (or your agent) can land a workflow file in the codebase. Lowest latency, zero infra. |
| **Pull (daemon)** | `first-tree gardener start` launches a long-running daemon that polls every configured source repo on a timer. | The codebase repo is third-party or you otherwise can't push workflow files. Also the right choice when you want drift detection (`gardener sync`) on a schedule. |

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
  by `first-tree gardener sync`) to propagate a decision; gardener's
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

### Primary (start here — humans)

These are the commands you invoke directly to set gardener up or check on it.
Everything else is driven by these, by breeze, or by CI.

| Command | Purpose |
|---|---|
| `first-tree gardener install-workflow` | Scaffold `.github/workflows/first-tree-sync.yml` in a codebase repo — the push-mode entry point. Per-PR events drive the sync flow; no daemon required. |
| `first-tree gardener start` | Launch the pull-mode daemon in the background. Writes `~/.gardener/config.json` from `--tree-path` + repeated `--code-repo` args, then boots a launchd job (macOS) or detached process. Schedules: `--gardener-interval` (default 5m), `--sync-interval` (default 1h). `--assign-owners` and `--sync-apply` wire their downstream flags. |
| `first-tree gardener stop` | Tear down the launchd job (macOS) or SIGTERM the PID in `~/.gardener/state.json`. Idempotent. |
| `first-tree gardener status` | Print the recorded PID + uptime, configured schedule, and last outcome + next-due time per sweep. Read-only. |
| `first-tree gardener run-once` | Run both sweeps inline, no daemon. Useful for cron-style deployments or exercising the pipeline before leaving a daemon running. |

### Agent commands (called by the daemon, breeze, or CI — not normally by humans)

These are the units of work. You can still invoke them manually for one-off
runs or dry-runs, but the normal trigger is `start`, push-mode workflow, or
breeze's notification dispatch.

| Command | Purpose |
|---|---|
| `first-tree gardener sync` | Detect drift between the tree and its bound source repos. Writes proposals under `.first-tree/proposals/`, edits tree files, commits to a new branch in the tree repo, and opens a PR labeled `first-tree:sync`. Phases: `--propose` detects + writes proposals, `--apply` also writes new tree files and opens the PR, default is detect-only. Moved from `first-tree tree sync`. |
| `first-tree gardener comment` | Review a source-repo PR or issue against the tree and post a structured verdict comment. Scan mode (no `--pr`/`--issue`) walks every **open** PR and issue. The merge→tree-issue branch only fires on a single MERGED PR with a prior gardener marker (single-item invocation), and requires `TREE_REPO_TOKEN`. Pass `--assign-owners` to auto-assign NODE owners on the tree issue. |
| `first-tree gardener respond` | Acknowledge reviewer feedback on a sync PR (Phase 5: real edit orchestrator for `parent_subdomain_missing` + planner seam — see [#160](https://github.com/agent-team-foundation/first-tree/issues/160) / [#219](https://github.com/agent-team-foundation/first-tree/issues/219); unsupported patterns fall back to a placeholder reply). |
| `first-tree gardener draft-node` | Consume a tree-repo issue carrying the `gardener:sync-proposal` marker (filed by `sync --open-issues` or `comment` on a merged PR), copy the proposed NODE.md onto a deterministic `first-tree/draft-node-<proposal_id>` branch, and open a tree PR for human review. Invoked by breeze when the assignee is the breeze identity; not typically run by hand. Requires `TREE_REPO_TOKEN`. |
| `first-tree gardener daemon` | Foreground loop invoked by `start`. Not intended for direct human use. |

For full options on any command, run `first-tree gardener <command> --help`.

## Prerequisites

`gardener comment` fails closed without a classifier. Before running any
of the scan/single-item/pull/push-mode flows below, provision:

- `ANTHROPIC_API_KEY` — **required** for every shipped automation path.
  Without it the stock CLI refuses to post verdicts and exits 0 with
  `BREEZE_RESULT: status=skipped summary=no classifier injected`.
- `GARDENER_CLASSIFIER_MODEL` — **optional** override (default
  `claude-haiku-4-5`). Blank values are normalized to the default, so
  it's safe to leave the GitHub Actions secret unset.

See the per-mode flows below for where each automation entrypoint reads
these vars (shell env for scan/single-item/`run-once`, launchd plist
for pull-mode daemon on macOS, workflow `env:` block for push mode).

## Typical Flows

### Scan mode — review every open PR/issue across all bound source repos

```bash
export ANTHROPIC_API_KEY=sk-...        # required
# export GARDENER_CLASSIFIER_MODEL=... # optional; default claude-haiku-4-5
npx -p first-tree first-tree gardener comment
```

Run from inside a tree repo. Reads `.claude/gardener-config.yaml`, then
walks every **open** PR and issue on **every** configured source repo
(`target_repo` scalar + `target_repos` list, deduped), posting structured
verdict comments against the tree. Results are aggregated into a single
`BREEZE_RESULT` trailer with `repos=<n>`. Without `ANTHROPIC_API_KEY`
the stock CLI skips the sweep (`status=skipped summary=no classifier
injected`) and does not call `gh`.

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
prior gardener marker and `TREE_REPO_TOKEN` set. `ANTHROPIC_API_KEY`
must be present in the invoking shell or the run exits early with
`status=skipped summary=no classifier injected`.

### Pull-mode daemon — monitor many code repos on a schedule

Use this when push-mode workflows aren't an option or when you want
drift detection (`gardener sync`) to run on a timer in addition to
per-PR verdict comments.

```bash
export ANTHROPIC_API_KEY=sk-...        # required; forwarded into launchd plist
# export GARDENER_CLASSIFIER_MODEL=... # optional override
# 1. Bind the tree checkout first (if not already): `first-tree tree bind`
# 2. Start the daemon pointed at the tree + the code repos to watch.
npx -p first-tree first-tree gardener start \
  --tree-path ../my-org-tree \
  --code-repo my-org/web --code-repo my-org/api \
  --gardener-interval 5m \
  --sync-interval 1h \
  --assign-owners
```

What happens:
- `~/.gardener/config.json` is written with the supplied schedule.
- On macOS, a launchd plist `com.first-tree.gardener.<user>.plist`
  lives at `~/.gardener/launchd/` and is bootstrapped into the user
  domain. `ANTHROPIC_API_KEY` and (if set) `GARDENER_CLASSIFIER_MODEL`
  from the invoking shell are forwarded into the plist's
  `EnvironmentVariables` dict — launchd does not inherit shell env, so
  these must be exported before `gardener start`. On other platforms,
  a detached child process is spawned with the full parent env.
- The daemon ticks every ~30 s. Each tick checks whether
  `gardener-sweep` or `sync-sweep` is due and runs it as a subprocess
  (`gardener comment --merged-since 2×interval` and `gardener sync`
  respectively). Outcomes get written to `~/.gardener/state.json`.

Inspect and tear down:

```bash
npx -p first-tree first-tree gardener status     # last runs + next due
npx -p first-tree first-tree gardener run-once   # fire both sweeps inline
npx -p first-tree first-tree gardener stop       # launchctl bootout + SIGTERM
```

Set `--sync-apply` on `start` to have `sync-sweep` open tree PRs
automatically (`gardener sync --apply`); without it, the sweep stays in
detect-only mode.

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
fallback) **and** the `ANTHROPIC_API_KEY` secret on the codebase repo —
the generated workflow references both via
`secrets.ANTHROPIC_API_KEY` / `secrets.TREE_REPO_TOKEN` and falls back
to a skip if the classifier key is missing. `GARDENER_CLASSIFIER_MODEL`
is wired through as an optional secret; leave it unset to use the
default model. Commit the generated workflow file and open a PR. On
every PR merge thereafter the workflow files a tree-repo issue assigned
to the NODE owners.

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

Gardener reads a small set of env vars. `ANTHROPIC_API_KEY` is required
for every `gardener comment` invocation; `TREE_REPO_TOKEN` is required
only for the merge→issue branch.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | **Required** for `gardener comment`. The stock CLI instantiates the built-in Anthropic classifier from this key; if it is unset, `runComment` fails closed and emits `BREEZE_RESULT: status=skipped summary=no classifier injected` without touching `gh`. Forwarded into the launchd plist by `gardener start`; referenced as `secrets.ANTHROPIC_API_KEY` by the push-mode workflow generated by `install-workflow`. |
| `GARDENER_CLASSIFIER_MODEL` | Optional override for the classifier model (default `claude-haiku-4-5`). Blank/unset is normalized to the default, so it's safe to leave the GitHub Actions secret empty. |
| `BREEZE_SNAPSHOT_DIR` | Directory with pre-fetched `pr-view.json`, `pr.diff`, `issue-view.json`, `issue-comments.json`, `pr-reviews.json`, `subject.json`. Set by breeze-runner so gardener doesn't re-fetch. Also enables snapshot-mode idempotency checks in `respond` when `pr-commits.json` is present. |
| `TREE_REPO_TOKEN` | PAT with `repo` scope on the tree repo. Consumed **only** by `comment`'s merge→issue branch, for `gh issue create` and the follow-up marker PATCH. No fallback to `GH_TOKEN`/`GITHUB_TOKEN` — if unset, the merge→issue path silently skips and logs `skipped: token_absent`. |
| `COMMENT_LOG` | Path for JSONL run events from `comment` (default `$HOME/.gardener/comment-runs.jsonl`; falls back to `$TMPDIR` when `HOME` is unset). |
| `RESPOND_LOG` | Same shape for `respond` (default `$HOME/.gardener/respond-runs.jsonl`). |

## Guards And Idempotency

Gardener refuses to act when:

- `ANTHROPIC_API_KEY` is unset (no classifier injected — `comment`
  exits 0 with `status=skipped summary=no classifier injected` before
  calling `gh`)
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
