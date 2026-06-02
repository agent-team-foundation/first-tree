# Onboarding Recipe (per-phase deep walkthrough)

This file is the deep reference behind the SKILL.md phase summaries. SKILL.md is the source of truth for "what the agent does"; this file is the reference for "exact commands and their outputs". Read SKILL.md first.

## Phase A — Pre-flight

### Commands

```bash
first-tree tree status --json
first-tree --version
gh auth status
```

### Reading status output

`tree status --json` returns the W1 workspace report when a workspace
exists up the path, or falls back to the legacy `inspect` reporter
during the W1 transition. The W1 shape is:

```json
{
  "workspaceRoot": "<absolute-path>",
  "manifest": {
    "tree": "<immediate-subdir-name>",
    "sources": ["<source-1>", "<source-2>"]
  },
  "treePath": "<workspaceRoot>/<manifest.tree>",
  "treePresent": true,
  "treeRemoteUrl": "https://github.com/<owner>/<tree-repo>",
  "boundSources": [
    { "name": "<source-1>", "path": "<workspaceRoot>/<source-1>", "present": true,  "remoteUrl": "https://github.com/<owner>/<source-1>" },
    { "name": "<source-2>", "path": "<workspaceRoot>/<source-2>", "present": false }
  ],
  "unboundGitSiblings": [
    { "name": "<sibling>", "path": "<workspaceRoot>/<sibling>", "remoteUrl": "https://github.com/<owner>/<sibling>" }
  ],
  "missingBoundSources": [
    { "name": "<source-2>", "path": "<workspaceRoot>/<source-2>", "present": false }
  ]
}
```

`missingBoundSources` is the subset of `boundSources` whose `present`
is `false` (declared by the manifest but not cloned locally). It is an
array of objects, not strings — read `name` for the subdir name and
look up the corresponding `boundSources[?].remoteUrl` when prompting
the user to clone.

The legacy fallback shape is the `inspect` JSON with `role` etc. — see
[`role-decisions.md`](role-decisions.md) for the legacy mapping.

### Path computation

```text
workspace_root  = workspaceRoot                                       (W1)
tree_root       = workspaceRoot + "/" + manifest.tree                 (W1)
source_roots[]  = workspaceRoot + "/" + s for s in manifest.sources   (W1)
```

For unmigrated workspaces (legacy fallback), compute the tree root from
`binding.treeRepoName` and `rootPath` as before, then go to Phase A.5 to
migrate before doing anything else.

### Exit gate

You should know:

- Whether the workspace is W1, legacy-bound, unbound, or "stop and ask".
- `workspaceRoot` + `tree_root` (W1) OR a "needs binding" / "needs migration" flag.
- Whether `gh` is authenticated.
- The CLI version.

If `tree status` says cwd is the tree subdir (under `workspaceRoot/manifest.tree`), stop. Tell the user, do not advance.

## Phase A.5 — Migrate legacy multi-mode workspace

Only runs when Phase A reported a legacy `role: *-bound` shape (no
`workspace.json` present yet).

### Commands

```bash
# Always preview first
first-tree tree migrate-to-w1 --dry-run

# Run the migration
first-tree tree migrate-to-w1
# OR, for single-repo Case B/C promote, with a pre-chosen name
first-tree tree migrate-to-w1 --workspace-name <name>
# OR scripted (only after a clean dry-run review)
first-tree tree migrate-to-w1 --yes

# Confirm post-migration shape
first-tree tree status --json
```

### What the migration does

- Writes `<workspaceRoot>/.first-tree/workspace.json`.
- Strips `.first-tree/source.json`, per-source skill payloads under
  `.agents/skills/` and `.claude/skills/`, `WHITEPAPER.md`, and the
  managed `<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->` block from
  each source repo's `AGENTS.md` / `CLAUDE.md`.
- Strips `.first-tree/bindings/`, `.first-tree/bootstrap.json`,
  `.first-tree/tree.json`, and `source-repos.md` from the tree repo.
- Deletes the legacy `.first-tree-workspace` marker file last.

No git operations are performed. Every change is left as a dirty
working-tree edit for the user to commit. The migration is idempotent
and resumable — if a previous run partially failed, re-running detects
the surviving legacy artifacts (via `workspace.json` plus marker /
bindings / source.json signals) and finishes the cleanup.

### Single-repo promote (Case B/C)

When the legacy layout is a single source repo + sibling tree dir at the
same parent (no workspace dir), the migrate command first prompts to
create `<parent>/<source>-workspace/` (or `--workspace-name`) and `mv`
both repos into it. The promote is the only destructive step; it
prompts before running unless `--yes` is passed. After promote, the
cleanup flow above runs normally.

## Phase B — Bind (unbound → bound)

### Single repo (lone source repo, no parent workspace)

W1 requires source + tree as siblings under a workspace root. `init`
writes the `workspace.json` manifest only when scope is workspace AND
the tree resolves to an immediate child of cwd — so the source has to
already live inside the workspace root when init runs. The recipe is:
pre-create the workspace dir, move the source in, then init from
there.

```bash
# Step 1: pick a workspace dir name. Default = "<source-name>-workspace".
#         Ask the user if they have a preferred name.
WORKSPACE=<workspace-name>
TREE=<tree-name>            # e.g. "<workspace-name>-tree" or "context-tree"
SLUG=<workspace-slug>       # kebab-case identifier for workspace_id

# Step 2: from the source repo's parent directory, create the workspace
#         and move the source repo into it. The repo path changes —
#         warn the user before running the mv.
mkdir $WORKSPACE
mv <source-repo> $WORKSPACE/

# Step 3: cd into the new workspace and run init from there.
cd $WORKSPACE

# Dedicated tree (new tree scaffolded locally):
first-tree tree init --scope workspace \
  --tree-path ./$TREE \
  --tree-mode dedicated \
  --workspace-id $SLUG \
  --no-recursive

# Or, for an existing remote tree:
first-tree tree init --scope workspace \
  --tree-path ./$TREE \
  --tree-url <url> \
  --tree-mode shared \
  --workspace-id $SLUG \
  --no-recursive

# Step 4: verify
first-tree tree status --json                          # must report W1 shape
first-tree tree verify --tree-path ./$TREE             # must exit 0
```

`--no-recursive` is required here. Without it, init's workspace-scope
cascade would notice the freshly-scaffolded tree dir at cwd and try
to bind it as a source, which is wrong (the tree is `manifest.tree`,
not a `manifest.sources` entry). With `--no-recursive`, init binds
exactly the one source repo you placed at the workspace root.

After step 3, `$WORKSPACE/` is the W1 `workspaceRoot`,
`$WORKSPACE/.first-tree/workspace.json` exists with `manifest.tree =
"$TREE"` and `manifest.sources = ["<source>"]`, the source repo is
clean (no `.first-tree/source.json`, no legacy `bindings/`), and the
framework `AGENTS.md` / `CLAUDE.md` + skills land at the workspace
root.

If a user has already run `init` inside a lone source repo from a
previous (pre-W1) onboarding and ended up with a sibling tree, that
is a legacy multi-mode layout. Route through Phase A.5
(`migrate-to-w1`) — do not try to re-run this recipe over the
existing layout.

### Workspace root (multiple sibling source repos)

```bash
first-tree tree init --scope workspace --tree-mode shared --workspace-id <slug>
# OR clone an existing tree
first-tree tree init --scope workspace --tree-url <url> --tree-mode shared --workspace-id <slug>
```

After init, `first-tree tree status` will report the workspace + tree,
plus `unboundGitSiblings[]` for every other git repo at
`workspaceRoot`. Ask the user which to add to `workspace.json.sources`.
Adding is an in-place edit to the JSON file; there is no
`tree add-source` command.

### Verification

After init:

```bash
first-tree tree status --json                                          # must report W1 shape
first-tree tree verify --tree-path <workspaceRoot>/<manifest.tree>     # must exit 0
```

Verify output enumerates each check (NODE.md present, members/ present, .first-tree/ valid, etc.). All must pass.

## Phase B-refresh — Already bound

```bash
# Refresh shipped skill payloads (workspace root only)
first-tree tree skill upgrade

# Re-read status; surface drift to the user
first-tree tree status --json

# Verify the tree
first-tree tree verify --tree-path <workspaceRoot>/<manifest.tree>
```

`tree skill upgrade` is safe to rerun — it copies the latest shipped skill payloads from the CLI into `.agents/skills/` and `.claude/skills/` at the workspace root. (Per-source skill installs are gone in W1; agents launch at the workspace root and pick up the workspace-root install.)

If `tree status` shows `unboundGitSiblings[]` or `missingBoundSources[]`, surface those to the user and ask whether to bind / clone. Adding to `sources` is a one-line JSON edit; cloning a missing source is `git clone <remoteUrl> <name>` next to the tree (each `missingBoundSources[?]` is an object — read `name` for the subdir name, and look up the corresponding `boundSources[?].remoteUrl` for the URL).

## Phase C — Draft initial tree content

See [`content-drafting.md`](content-drafting.md). That file is the single source of truth for Phase C — extraction rules, confidence labels, delivery flow.

Quick gate check before starting:

```bash
TREE=$(first-tree tree status --json | jq -r '.workspaceRoot + "/" + .manifest.tree')

grep -F "The living source of truth for your organization" $TREE/NODE.md
grep -F "Default bootstrap member node" $TREE/members/owner/NODE.md
grep -E '^\s*industry:\s*""' $TREE/.first-tree/org.yaml
```

Do not check `$TREE/.first-tree/progress.md` — that file is the CLI's bootstrap checklist; `tree verify` fails when any line in it is unchecked, so it must remain fully ticked.

## Phase D — Daemon

```bash
gh auth status                                        # must succeed
first-tree github scan install --allow-repo <owner>/<repo>
first-tree github scan doctor
```

`install` performs first-run setup AND starts the daemon (launchd on macOS, systemd unit on Linux). `start` is only used to relaunch after `stop`.

Pull each `<owner>/<repo>` from `boundSources[].remoteUrl` in the status output. Start narrow — onboarding's job is to bind one repo, not configure org-wide policy.

If `gh auth status` fails:

```text
Stop here. Tell user:
  "GitHub Scan needs `gh` authenticated. Run:
     gh auth login
   Then re-run /first-tree-onboarding to resume."
```

Do not store credentials, do not bypass with PATs typed in chat.

`--allow-repo` accepts comma-separated values and glob patterns (`owner/*`).

## Phase D.5 — GitHub automation rule layer

```bash
TREE=<workspaceRoot>/<manifest.tree>

test -f $TREE/.github/workflows/validate.yml || \
  first-tree tree upgrade --tree-path $TREE

first-tree tree automation install --tier 2 --tree-path $TREE
```

Interpret the output in three buckets:

- `stage: write_rule_layer` — Tier 2 workflow files were written locally, or they exist locally but are not yet on the remote default branch. This is still safe rule-layer prep. Show the tree diff and follow the normal push / PR confirmation rule. Do **not** run any printed `gh api` commands.
- `stage: create_ruleset` — the workflow files are on the default branch, but the GitHub ruleset does not exist yet. Print the command, explain that GitHub documents `enforcement: evaluate` as Enterprise-only, and let the user run it manually if they choose.
- `stage: activate_ruleset` — the ruleset exists but is not yet active. Again: print, explain, user runs it.
- `stage: configured` — Tier 2 is already active. Record that in the wrap-up summary.

Always tell the user:

- Tier 0 (`validate.yml`) is installed by default.
- Tier 1 AI PR review is not installed by this skill; it belongs to `first-tree cloud`.
- Tier 2 is optional and rule-based; the onboarding skill can prepare files and explain the rollout, but hard-to-reverse policy changes stay manual.
- The current parity target for "proper automation similar to `first-tree-context`" is documented in [`github-automation.md`](github-automation.md). Use that file when you need the exact workflow roles, ruleset assumptions, App/secrets names, or rollout sequence.

## Phase E — Agent templates

`tree init` already wrote two defaults into `<workspaceRoot>/<manifest.tree>/.first-tree/agent-templates/`:

- `developer.yaml`
- `code-reviewer.yaml`

For details (schema, add/drop rules, role customization), see [`agent-templates.md`](agent-templates.md).

This phase is mostly a confirmation step. The only reason to write/edit YAML here is if the user wants a custom role beyond the two defaults.

## Phase F — Wrap-up

```bash
first-tree tree skill doctor                  # from workspace root
first-tree github scan doctor                 # only if Phase D ran
first-tree tree status --json                 # final confirmation
```

If any doctor exits non-zero, **do not** print the success summary. Print the failures and stop.

The success summary template is in SKILL.md Phase F. Fill it from `tree status` output and the recorded daemon state.

GitHub automation lines are mandatory:

```text
GitHub Actions: validate.yml installed (Tier 0, rule-based)
AI PR review:  not installed by this skill. Enable via your first-tree cloud deployment / onboarding flow.
Owners gate:   <skipped | pending via `first-tree tree automation install --tier 2 --tree-path <tree_root>` | configured>
```

## What this skill never runs

- `first-tree github scan run` / `daemon` / `run-once` — foreground/debug loops. Use `install` (which starts the launchd service) and `doctor` instead.
- The `gh api` commands printed by `first-tree tree automation install --tier 2` — those are user-run only.
- Direct edits to the workspace root's managed First Tree framework block in `AGENTS.md` / `CLAUDE.md`. Re-run `tree init` if the block looks wrong.
- `migrate-to-w1 --yes` without first reviewing `--dry-run` output. The promote step is destructive.
- `gh repo delete` or any destructive remote ops.
