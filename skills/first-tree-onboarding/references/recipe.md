# Onboarding Recipe (per-phase deep walkthrough)

This file is the deep reference behind the SKILL.md phase summaries. SKILL.md is the source of truth for "what the agent does"; this file is the reference for "exact commands and their outputs". Read SKILL.md first.

## Phase A — Pre-flight

### Commands

```bash
first-tree tree inspect --json
first-tree --version
gh auth status
```

### Reading inspect output

`tree inspect --json` returns at least:

```json
{
  "classification": "git-repo" | "workspace-root" | ...,
  "role": "unbound-source-repo" | "unbound-workspace-root" | "source-repo-bound" | "workspace-root-bound" | "tree-repo" | "unknown",
  "rootPath": "<absolute-path>",
  "binding": {
    "bindingMode": "standalone-source" | "shared-source" | "workspace-root" | "workspace-member" | null,
    "treeMode": "dedicated" | "shared" | null,
    "treeRepoName": "<name>" | undefined,
    "treeRemoteUrl": "<url>" | undefined,
    "workspaceId": "<id>" | undefined
  }
}
```

The `binding` block only appears when role is `*-bound`. For `unbound-*` and `unknown`, the only fields you can rely on are `classification`, `role`, `rootPath`.

### Path computation

```text
source_root          = rootPath
tree_repo_name       = binding.treeRepoName            (only if bound)
tree_remote_url      = binding.treeRemoteUrl           (only if bound and published)
tree_root_candidate  = dirname(source_root) + "/" + tree_repo_name
                       (only if bound; this is the dedicated-mode sibling)
tmp_clone_root       = source_root + "/.first-tree/tmp/" + tree_repo_name
                       (only used if no local checkout exists)
```

If `tree_root_candidate` exists and contains `.first-tree/`, that's `tree_root`. Otherwise resolve in Phase B (post-init) or fall back to `tmp_clone_root` after `git clone`.

### Exit gate

You should know:

- The `role`.
- `source_root` (absolute).
- Whether `gh` is authenticated.
- The CLI version.

If `role == "tree-repo"`: stop. Tell the user, do not advance.

## Phase B — Bind (unbound → bound)

### Single repo (`unbound-source-repo`)

```bash
first-tree tree skill install --root <source_root>
first-tree tree init --tree-mode dedicated
first-tree tree verify --tree-path <dirname(source_root)>/<source_repo_name>-tree
```

Default tree name = `<repo_name>-tree`. Override with `--tree-name <name>` if user has an existing tree dir name.

### Workspace root (`unbound-workspace-root`)

```bash
first-tree tree skill install --root <source_root>
# Discover children first (dry-run)
first-tree tree workspace sync --dry-run --json
# Confirm with user, then real init
first-tree tree init --scope workspace --tree-mode shared --workspace-id <slug> --no-recursive
first-tree tree verify --tree-path <dirname(source_root)>/<workspace_name>-tree
```

`--no-recursive` is the safe default — it onboards the workspace root only, not nested repos. Add `--recursive` only after explicit user confirmation.

### Bind to existing tree

User has an existing tree (URL or local path):

```bash
# Local path
first-tree tree init --tree-path <abs_path> --tree-mode shared

# Remote URL — CLI clones to .first-tree/tmp/
first-tree tree init --tree-url <url> --tree-mode shared
```

For workspace, prepend `--scope workspace --workspace-id <slug>`.

### Verification

After init:

```bash
first-tree tree inspect --json   # role must now be *-bound
first-tree tree verify --tree-path <tree_root>   # must exit 0
```

Verify output enumerates each check (NODE.md present, members/ present, .first-tree/ valid, etc.). All must pass.

## Phase B-refresh — Already bound

```bash
first-tree tree skill upgrade --root <source_root>
# Workspace only:
first-tree tree workspace sync
first-tree tree verify --tree-path <tree_root>
```

`tree skill upgrade` is safe to rerun — it copies the latest shipped skill payloads from the CLI into `.agents/skills/` and `.claude/skills/`. Re-fixes the WHITEPAPER.md symlink if the previous install was incomplete.

## Phase C — Draft initial tree content

See [`content-drafting.md`](content-drafting.md). That file is the single source of truth for Phase C — extraction rules, confidence labels, delivery flow.

Quick gate check before starting:

```bash
# Is Phase C needed? Any hit → run Phase C.
grep -F "The living source of truth for your organization" <tree_root>/NODE.md
grep -F "Default bootstrap member node" <tree_root>/members/owner/NODE.md
grep -E '^\s*industry:\s*""' <tree_root>/.first-tree/org.yaml
```

Do not check `<tree_root>/.first-tree/progress.md` — that file is the CLI's bootstrap checklist; `tree verify` fails when any line in it is unchecked, so it must remain fully ticked.

## Phase D — Daemon

```bash
gh auth status                                        # must succeed
first-tree github scan install --allow-repo <owner>/<repo>
first-tree github scan doctor
```

`install` performs first-run setup AND starts the daemon (launchd on macOS, systemd unit on Linux). `start` is only used to relaunch after `stop`.

If `gh auth status` fails:

```text
Stop here. Tell user:
  "GitHub Scan needs `gh` authenticated. Run:
     gh auth login
   Then re-run /first-tree-onboarding to resume."
```

Do not store credentials, do not bypass with PATs typed in chat.

`--allow-repo` accepts comma-separated values and glob patterns (`owner/*`). Start narrow — onboarding's job is to bind one repo, not configure org-wide policy.

## Phase D.5 — GitHub automation rule layer

```bash
test -f <tree_root>/.github/workflows/validate.yml || \
  first-tree tree upgrade --tree-path <tree_root>

first-tree tree automation install --tier 2 --tree-path <tree_root>
```

Interpret the output in three buckets:

- `stage: write_rule_layer` — Tier 2 workflow files were written locally, or they exist locally but are not yet on the remote default branch. This is still safe rule-layer prep. Show the tree diff and follow the normal push / PR confirmation rule. Do **not** run any printed `gh api` commands.
- `stage: create_ruleset` — the workflow files are on the default branch, but the GitHub ruleset does not exist yet. Print the command, explain that GitHub documents `enforcement: evaluate` as Enterprise-only, and let the user run it manually if they choose.
- `stage: activate_ruleset` — the ruleset exists but is not yet active. Again: print, explain, user runs it.
- `stage: configured` — Tier 2 is already active. Record that in the wrap-up summary.

Always tell the user:

- Tier 0 (`validate.yml`) is installed by default.
- Tier 1 AI PR review is not installed by this skill; it belongs to `first-tree-hub`.
- Tier 2 is optional and rule-based; the onboarding skill can prepare files and explain the rollout, but hard-to-reverse policy changes stay manual.
- The current parity target for "proper automation similar to `first-tree-context`" is documented in [`github-automation.md`](github-automation.md). Use that file when you need the exact workflow roles, ruleset assumptions, App/secrets names, or rollout sequence.

## Phase E — Agent templates

`tree init` already wrote two defaults into `<tree_root>/.first-tree/agent-templates/`:

- `developer.yaml`
- `code-reviewer.yaml`

For details (schema, add/drop rules, role customization), see [`agent-templates.md`](agent-templates.md).

This phase is mostly a confirmation step. The only reason to write/edit YAML here is if the user wants a custom role beyond the two defaults.

## Phase F — Wrap-up

```bash
first-tree tree skill doctor --root <source_root>
first-tree github scan doctor   # only if Phase D ran
first-tree tree inspect --json   # final confirmation
```

If any doctor exits non-zero, **do not** print the success summary. Print the failures and stop.

The success summary template is in SKILL.md Phase F. Fill it from inspect output and the recorded daemon state.

GitHub automation lines are mandatory:

```text
GitHub Actions: validate.yml installed (Tier 0, rule-based)
AI PR review:  not installed by this skill. Enable via your first-tree-hub deployment / onboarding flow.
Owners gate:   <skipped | pending via `first-tree tree automation install --tier 2 --tree-path <tree_root>` | configured>
```

## What this skill never runs

- `first-tree tree publish` — release flow, not onboarding. Tree publish is a separate user-driven action when they're ready to share.
- `first-tree github scan run` / `daemon` / `run-once` — foreground/debug loops. Use `install` (which starts the launchd service) and `doctor` instead.
- The `gh api` commands printed by `first-tree tree automation install --tier 2` — those are user-run only.
- Direct edits to managed First Tree blocks. Re-run the relevant CLI.
- `gh repo delete` or any destructive remote ops.
