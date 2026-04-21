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

If the answer is yes, prefer `first-tree tree bind` over creating a new sibling tree
repo.

## Step 3: Choose The Right Flow

### Case A: Single Repo + New Dedicated Tree

This is the default:

```bash
first-tree tree init
```

The CLI will:

- install `.agents/skills/first-tree/` and `.claude/skills/first-tree/` in the source/workspace root
- create `WHITEPAPER.md`
- refresh `AGENTS.md` and `CLAUDE.md`
- create or reuse a sibling `<repo>-tree` checkout
- install the bundled `first-tree` skill in that tree repo if it is missing
- scaffold the tree repo there
- write binding metadata in both the source repo and the tree repo

### Case B: Single Repo + Existing Shared Tree

Reuse the existing tree instead of creating a new sibling repo:

```bash
first-tree tree bind --tree-path ../org-context --tree-mode shared
```

Or:

```bash
first-tree tree init --tree-path ../org-context --tree-mode shared
```

If the user gives only a remote URL:

```bash
first-tree tree bind --tree-url git@github.com:acme/org-context.git --tree-mode shared
```

`bind` will clone a local checkout if needed, then:

- install local skill integration in the current repo
- install the bundled `first-tree` skill in the tree repo if it is missing
- refresh `AGENTS.md` and `CLAUDE.md`
- write `.first-tree/source.json` (includes tree localPath)
- write `.first-tree/tree.json` and `.first-tree/bindings/<source-id>.json`
- refresh the tree repo's `source-repos.md` index plus root repo-discovery guidance

### Case C: Workspace Root + Shared Tree

If the current root contains many child repos or submodules, onboard the whole
workspace with one shared tree:

```bash
first-tree tree init --scope workspace --sync-members
```

Or bind to an existing shared tree:

```bash
first-tree tree init --scope workspace --tree-path ../org-context --tree-mode shared --sync-members
```

The workspace root gets local integration plus `.first-tree/source.json` (with workspace members).
Then `first-tree tree workspace sync` binds every discovered child repo as a
`workspace-member` to that same shared tree.

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

## Step 6: Configure Modules (Optional)

`first-tree` ships two optional modules that live on top of the core
tree toolkit:

- **gardener** — automated review/response on source-repo PRs and sync
  PRs. Gardener subcommands (`gardener comment`, `gardener respond`)
  are **enabled by default** when invoked. To turn one off, write
  `.claude/gardener-config.yaml` in the tree repo with an explicit
  `enabled: false` for the relevant module:

  ```yaml
  target_repo: owner/app-repo          # source repo to review
  tree_repo: owner/tree-repo            # this tree repo (for attribution)
  modules:
    comment:
      enabled: false                    # disable scan/verdict on source PRs
    respond:
      enabled: false                    # disable feedback handling on sync PRs
  ```

  Omitting the file or omitting a `modules.<name>.enabled` key leaves
  that subcommand enabled — invoking `first-tree gardener <command>`
  will still run. The opt-out is explicit `enabled: false`.

  **Operational guidance:** the safest way to keep a new tree quiet
  while it's still skeletal is to simply not invoke `gardener` (and not
  configure `breeze` to invoke it for you) until the tree has enough
  content to give useful verdicts. Noisy comments on an empty tree
  train reviewers to ignore them.

- **breeze** — local notification daemon that dispatches gardener on
  real GitHub events. Only needed if you want gardener to react to
  review requests and assignments in real time. See the `breeze` skill
  for setup.

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
- Resolve the recorded `localPath`.
- If the checkout is missing but the tree has been published, create a temporary
  clone under `.first-tree/tmp/`.
- At task close-out, always ask whether the tree needs updating.

## Sample Tasks After Onboarding

A few common things an agent does after the tree is live. These are
examples, not a required sequence — pick what fits the task at hand.

### Propose tree updates from a code change

From the tree repo:

```bash
first-tree tree sync                         # detect drift between source + tree
first-tree tree sync --apply                 # open tree PRs for each drift group
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
