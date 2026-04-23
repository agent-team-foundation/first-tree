# Context Tree Onboarding

You are setting up a **Context Tree** — the living source of truth for an
organization. This guide explains the current `first-tree` onboarding model.

## Prerequisites

- Node.js 18+
- Git
- GitHub CLI (`gh`) if you want to run `first-tree tree publish`

## Core Model

`first-tree` now treats onboarding as three explicit things:

1. `source/workspace root` — the repo or folder where local agent integration lives
2. `tree repo` — the Git repo that stores `NODE.md`, domains, members, and decisions
3. `binding` — the metadata that connects the source/workspace root to the tree repo

That model supports all of these cases cleanly:

- a single repo with its own dedicated tree
- a repo that should reuse an existing shared tree
- a non-git workspace folder containing many repos
- a git workspace root repo containing many child repos or submodules

## Step 1: Inspect First

Run:

```bash
first-tree tree inspect --json
```

This tells the agent whether the current root is:

- a `tree-repo`
- a `source-repo`
- a `workspace-repo`
- a `workspace-folder`

It also reports discovered child repos / submodules plus any existing
`.first-tree/source.json`, `.first-tree/tree.json`,
and `.first-tree/bindings/` state.

## Step 2: Ask Whether The User Already Has A Tree

Before creating anything new, ask:

- do you already have a Context Tree?
- if yes, is it a local checkout path or a remote URL?

Either way the primary command is `first-tree tree init`. With no flags, `init`
creates a new sibling tree. With `--tree-path <path>` or `--tree-url <url>` it
binds to that existing tree instead. `init` delegates to `bind` and `bootstrap`
under the hood; reach for those primitives directly only when you need
explicit `--mode` control (e.g. binding a `workspace-member`).

## Step 3: Choose The Right Flow

### Case A: Single Repo + New Dedicated Tree

This is the default:

```bash
first-tree tree init
```

The CLI will:

- install the four shipped skills (`first-tree`, `tree`, `breeze`, `gardener`)
  under `.agents/skills/*` and `.claude/skills/*` in the source/workspace root
- create `WHITEPAPER.md`
- refresh `AGENTS.md` and `CLAUDE.md`
- create or reuse a sibling `<repo>-tree` checkout
- install the bundled first-tree skills in that tree repo if they are missing
- scaffold the tree repo there
- write binding metadata in both the source repo and the tree repo

### Case B: Single Repo + Existing Shared Tree

Reuse the existing tree instead of creating a new sibling repo:

```bash
first-tree tree init --tree-path ../org-context --tree-mode shared
```

If the user gives only a remote URL:

```bash
first-tree tree init --tree-url git@github.com:acme/org-context.git --tree-mode shared
```

`init` delegates to `bind` under the hood, which will clone a local checkout
if needed, then:

- install local skill integration in the current repo
- install the bundled first-tree skills in the tree repo if they are missing
- refresh `AGENTS.md` and `CLAUDE.md`
- write `.first-tree/source.json` (tree repo identity + published URL when known)
- write `.first-tree/tree.json` and `.first-tree/bindings/<source-id>.json`
- refresh the tree repo's `source-repos.md` index plus root repo-discovery guidance

If you need explicit `--mode` control (e.g. `standalone-source`,
`workspace-member`) that `init` normally infers, invoke the primitive
directly:

```bash
first-tree tree bind --tree-path ../org-context --tree-mode shared --mode standalone-source
```

### Case C: Workspace Root + Shared Tree

If the current root contains many child repos or submodules, onboard the whole
workspace with one shared tree:

```bash
first-tree tree init --scope workspace
```

Or bind to an existing shared tree:

```bash
first-tree tree init --scope workspace --tree-path ../org-context --tree-mode shared
```

The workspace root gets local integration plus `.first-tree/source.json` (with
workspace members). `first-tree tree init --scope workspace` also binds every
currently discovered child repo as a `workspace-member` to that same shared
tree by default. If new child repos appear later, rerun:

```bash
first-tree tree workspace sync
```

### Case D: Explicit Tree Bootstrap

If you have already switched into the tree repo itself:

```bash
first-tree tree bootstrap --here
```

Or from elsewhere:

```bash
first-tree tree bootstrap --tree-path ../org-context
```

Use this only for the tree repo. Do not use `--here` inside a source/workspace
repo unless the user explicitly wants that repo itself to become the tree.

## Step 4: Work Through The Task List

The tree repo keeps its progress checklist in `.first-tree/progress.md`.

When you bootstrap a tree repo, complete the checklist:

- fill in `NODE.md`
- create members under `members/`
- add project-specific guidance in `AGENTS.md`
- decide whether to keep expanding baseline coverage now

Treat `progress.md` as the source of truth for onboarding status. Report
setup/integration progress separately from tree-content baseline coverage.

## Step 5: Verify

Run verification against the tree repo:

```bash
first-tree tree verify
```

Or from a source/workspace root:

```bash
first-tree tree verify --tree-path ../my-org-tree
```

Do not run `first-tree tree verify` in a source/workspace root without pointing it
at a tree checkout.

## Step 6: Set Up Gardener And Breeze

Once the tree is bound (Steps 1–5), set up the two agents that keep it
alive:

- **gardener** — detects drift between source code and the tree,
  posts verdicts on source-repo PRs, and drafts tree updates.
- **breeze** — a local daemon that polls your GitHub notifications
  and dispatches gardener when something relevant happens.

Drive this agent-led, not user-led: ask the user the questions
below, verify, then install.

**Prerequisites** — confirm before starting:
- `gh` CLI authed (`gh auth status`)
- `jq` installed
- Node ≥ 22
- `ANTHROPIC_API_KEY` exported locally (gardener's classifier)

### 6.1 Ask The User

1. What source repo should gardener track? (`owner/name`)
2. What tree repo stores `NODE.md`? (`owner/name`) — this is usually
   the repo the user just bound in Steps 1–5, but confirm, don't assume.
3. Are they watching the source repo on GitHub? (required — breeze polls
   notifications; no watch means no notifications means nothing
   dispatches)

Do not infer any of these from the current working directory. If any
answer is missing or ambiguous, stop and re-ask.

### 6.2 Verify Watch Status

First, confirm the user's active `github.com` `gh` token has the
`notifications` scope — without it `/subscription` returns 404 for
every repo, whether watching or not. Scope the check to the active
`github.com` account; a bare `gh auth status | grep notifications`
can false-positive on multi-host or multi-account setups where
another stored account has the scope:

```bash
gh auth status --active --hostname github.com 2>&1 | grep -i 'notifications'
```

If the scope is missing, instruct the user to run:

```bash
gh auth refresh -h github.com -s notifications
```

This is interactive and opens a browser for consent. Wait for the
user to confirm before proceeding.

Once the scope is present, check the subscription:

```bash
gh api /repos/<source-repo>/subscription
# 200 → watching
# 404 → not watching
```

If 404: tell the user to open `https://github.com/<source-repo>` and
click **Watch → All Activity**. Do not proceed until confirmed.

### 6.3 Install

```bash
first-tree breeze install --allow-repo <source-repo>,<tree-repo>
```

This creates `~/.breeze/config.yaml` (if absent) and starts the breeze
daemon. Breeze will now watch notifications on those repos and invoke
gardener as needed.

### 6.4 Verify End-To-End

Do the short manual trigger first, then optionally run a real source-PR
trigger to prove the full automatic chain.

**6.4.a — Manual trigger (fast, ~1 min).** Fires gardener directly, so
you can confirm credentials and the tree side of the chain without
waiting on GitHub's notification delivery:

```bash
TREE_REPO_TOKEN=$(gh auth token) \
  first-tree gardener sync --tree-path <tree-path> \
    --open-issues --assignee <your-gh-login>
```

Expect, in order:

1. Tree issue filed on the tree repo (labeled
   `first-tree:sync-proposal`).
2. Breeze activity log records the pickup
   (`first-tree breeze status`).
3. Draft-node PR opened against the tree repo.

Report each step to the user as it happens. If any step is silent for
more than a couple of minutes, check `first-tree breeze doctor`.

**6.4.b — Real source-PR trigger (optional, ~5 min).** This is what the
end-to-end pitch promises: a source-repo PR flows through breeze into a
draft-node PR on the tree repo, no manual gardener invocation. Only do
this once 6.4.a is green — it adds GitHub's notification latency on top
of everything else, so if 6.4.a is broken, this step will just look
silent.

1. Run the whole block from inside the source-repo checkout so every
   command hits the smoke repo, not your current cwd:

   ```bash
   cd <source-repo-checkout>
   git checkout -b first-tree-smoke/drift-demo
   echo "# drift demo $(date -u +%FT%TZ)" >> README.md
   git commit -am "chore: first-tree drift-demo smoke"
   git push -u origin first-tree-smoke/drift-demo
   gh pr create --repo <source-repo> --fill --head first-tree-smoke/drift-demo
   ```

2. Watch breeze pick it up:

   ```bash
   first-tree breeze watch        # live TUI: status board + activity feed
   # or: first-tree breeze status # one-shot snapshot
   ```

   Within one GitHub polling cycle (default 60 s), a new entry for the
   smoke PR should appear. Breeze classifies it under its task-kind
   taxonomy (`review_request`, `comment`, `mention`, `assigned_*`, etc.)
   — which kind depends on how the PR notifies you (self-authored PRs
   come in via the participation channel, not as a review request).
   What matters is that a row for the new PR shows up; the exact kind
   is informational.

3. Confirm gardener responded on the source PR:

   ```bash
   gh pr view <pr-url> --repo <source-repo> --comments
   ```

   A gardener verdict comment should be present (or a
   `first-tree:skipped` label if the classifier deemed the PR off-topic
   — still a successful chain).

4. Merge or close the smoke PR to clean up. If the PR was merged, a
   draft-node PR will appear on the tree repo; reviewing it is Scenario
   G in the gardener skill.

If breeze never picks up the PR, walk the real gates in order:

- **No source-PR notification at all.** `gh api /notifications` should
  list the smoke PR. If it doesn't, the gh auth context isn't seeing it
  — check `gh auth status` and confirm you're authed as the user who
  opened the PR. Breeze polls `/notifications?participating=true`, so
  the notification has to exist on the user's timeline for breeze to
  see it. (Source-repo watch subscription is *not* the gate here: PR
  authorship alone triggers participation.)
- **Notification exists, breeze shows nothing.** The source repo is
  probably outside the breeze allowlist. `first-tree breeze status`
  prints the active `--allow-repo` scope; re-run `breeze install
  --allow-repo <source>,<tree>` if it's missing.
- **Breeze picked it up but no gardener action.** Check
  `first-tree breeze doctor` for runtime + auth errors.

### Opting Modules Out (Rare)

Gardener's `comment` and `respond` subcommands are **enabled by
default** once invoked. To silence one while the tree is still
skeletal, write `.claude/gardener-config.yaml` in the tree repo:

```yaml
target_repo: owner/app-repo          # source repo to review
tree_repo: owner/tree-repo            # this tree repo (for attribution)
modules:
  comment:
    enabled: false
  respond:
    enabled: false
```

Only explicit `enabled: false` disables a module; missing keys leave
it on.

The safest way to keep a new tree quiet while it's still skeletal is
simply not to invoke gardener until the tree has enough content for
useful verdicts. Noisy comments on an empty tree train reviewers to
ignore them.

### Pitfalls

- `gardener install` is **not** a command. Use `breeze install` to run
  gardener locally via breeze, or see `workflow-mode.md` if you want
  to run gardener as a GitHub Actions workflow on the source repo
  (requires write access and extra secrets — not recommended for
  first-time setup).
- Pull-based dispatch silently no-ops without a GitHub watch
  subscription. Verify before claiming setup is complete.
- `gh api /repos/<repo>/subscription` returns 404 when the active
  `github.com` token lacks the `notifications` scope — which default
  `gh auth login` does **not** grant. Check scope with
  `gh auth status --active --hostname github.com 2>&1 | grep -i
  notifications` (scope the check to the active account — a bare
  `gh auth status` grep can false-positive on multi-host or
  multi-account setups). If missing, run
  `gh auth refresh -h github.com -s notifications`. Treat 404 as
  "not watching" only after the scope is confirmed present.
- `TREE_REPO_TOKEN` must be in the environment for every `gardener`
  invocation, not just at setup.

## Step 7: Publish

When the tree repo is ready:

```bash
first-tree tree publish
```

`publish` now treats the tree repo as primary:

- it creates or reuses the GitHub tree remote
- it pushes the tree commits
- it refreshes any locally bound source/workspace repos with the published tree URL
- if exactly one source/workspace repo is being refreshed, it can still open a PR there with `--open-pr`

For shared trees bound to multiple repos, `publish` refreshes all local bindings
but does not try to open many code PRs automatically.

## Routine Work After Publish

- Start from `.first-tree/source.json` in the current source/workspace root.
- If you are starting from the tree repo itself, use `source-repos.md` as the quick index of bound source/workspace repos and their GitHub URLs, while treating `.first-tree/bindings/` as the canonical machine-readable source of truth.
- First try the sibling checkout named by `tree.treeRepoName`.
- If that checkout is missing but the tree has been published, create or refresh
  a temporary clone under `.first-tree/tmp/`.
- At task close-out, always ask whether the tree needs updating.

## Sample Tasks After Onboarding

A few common things an agent does after the tree is live. These are
examples, not a required sequence — pick what fits the task at hand.

### Propose tree updates from a code change

From the tree repo:

```bash
first-tree gardener sync                         # detect drift between source + tree
first-tree gardener sync --apply                 # open tree PRs for each drift group
```

Runs against the bound source repo, groups changes by affected tree
domain, and opens one PR per group (plus a housekeeping PR that pins
the sync bookmark).

### Review a source-repo PR against the tree

From the tree repo, with `.claude/gardener-config.yaml` set up:

```bash
first-tree gardener comment --pr 42 --repo owner/app-repo
```

Or scan every open PR + issue on the bound source repo at once:

```bash
first-tree gardener comment
```

### Respond to reviewer feedback on a sync PR

```bash
first-tree gardener respond --pr 123 --repo owner/tree-repo
```

Add `--dry-run` to any of the above to preview without writing.

### Add a new member to a shared tree

Edit `members/<login>.md` in the tree repo, then regenerate CODEOWNERS:

```bash
first-tree tree generate-codeowners --check    # confirm what changes
first-tree tree generate-codeowners            # apply
```

## Further Reading

- `.agents/skills/first-tree/references/principles.md`
- `.agents/skills/first-tree/references/source-workspace-installation.md`
- `.agents/skills/first-tree/references/ownership-and-naming.md`
