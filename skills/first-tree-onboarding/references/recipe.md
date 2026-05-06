# Onboarding Recipe — 5 Steps

Run onboarding in this exact order. Each step has a concrete CLI call and a
check that must pass before continuing.

## Step 0: Inspect

Before doing anything else, classify the current root:

```bash
first-tree tree inspect --json
```

Read the `role` field. Use `references/role-decisions.md` to choose the
binding mode for steps 2–3.

If `role` is `tree-repo`, the user is already inside the tree repo. Stop and
ask whether they meant to onboard a source repo. Onboarding does not run
inside the tree repo itself.

If `role` is `source-repo-bound` or `workspace-root-bound`, a binding already
exists. Run `first-tree tree skill upgrade` to refresh shipped skills, then
skip to step 4 (daemon) and step 5 (agents) — there is nothing to bind, but
the daemon still needs to be installed or checked.

## Step 1: Choose The Daemon Mode

Ask the user one question:

> Do you want the GitHub Scan daemon running on your local machine (`local`)
> or in a hosted environment (`cloud`)?

`local` is the only mode implemented today. If the user says `cloud`, tell
them it is on the roadmap but not available yet, and continue with `local`.

Do not start the daemon yet — that is step 4. Step 1 is a decision, not an
action.

## Step 2: Import Repos

If `role` is `unbound-source-repo`, this step is a no-op — there is one repo,
and it will be bound in step 3.

If `role` is `unbound-workspace-root`, run:

```bash
first-tree tree workspace sync --dry-run --json
```

Confirm the discovered child repos match what the user expects. Then run the
real sync as part of step 3 (tree init handles it).

The current CLI does not auto-generate initial tree content from child-repo
code. After step 3 lands the tree scaffolding, ask the user whether they want
to draft NODE.md content from the child repos manually before continuing.

## Step 3: Init Or Bind The Tree

Two paths.

### 3a — Create A New Tree

The user does not have an existing tree:

```bash
# Single repo with its own dedicated tree
first-tree tree init --tree-mode dedicated

# Workspace with a new shared tree
first-tree tree init --scope workspace --tree-mode shared --workspace-id <id>
```

`tree init` infers `--scope` from the inspect role unless you pass it
explicitly. The default `--tree-path` is a sibling directory named
`<repo>-tree` for dedicated trees.

### 3b — Bind To An Existing Tree

The user already has a tree, either as a local checkout or a remote URL:

```bash
# Local checkout
first-tree tree init --tree-path ../org-context --tree-mode shared

# Remote URL — init will clone into a temporary path under .first-tree/tmp/
first-tree tree init --tree-url git@github.com:acme/org-context.git --tree-mode shared
```

Pass `--scope workspace` if the current root is a workspace.

### Verification

After step 3, run:

```bash
first-tree tree inspect --json
first-tree tree verify --tree-path <tree-root>
```

`role` must now be `source-repo-bound` or `workspace-root-bound`. `verify`
must exit 0. If it does not, stop and report the failures — do not continue
to step 4 with a broken binding.

## Step 4: Start The Daemon

```bash
first-tree github scan install --allow-repo <owner/repo>[,...]
```

`install` checks `gh auth status`, writes `~/.first-tree/github-scan/config.yaml`
if absent, and starts the daemon (launchd on macOS).

`--allow-repo` is required and accepts a comma-separated allowlist. Glob
patterns like `owner/*` work. Use the smallest allowlist that covers the
user's intent — start with the bound repo only.

If `install` fails because `gh auth status` is unhealthy, stop and ask the
user to run `gh auth login` themselves. Do not store credentials.

After install:

```bash
first-tree github scan status
first-tree github scan doctor
```

`doctor` should report `required auth scope: ok` and `lock: present`. If
either fails, do not proceed.

## Step 5: Set Up Agent Templates

`tree init` already wrote two default agent templates into the tree:

- `.first-tree/agent-templates/developer.yaml`
- `.first-tree/agent-templates/code-reviewer.yaml`

Ask the user which roles they actually want:

- developer — handles code-related PRs and issues (default on)
- code-reviewer — focuses on PR review (default on)
- designer / qa — schemas only; bodies are stubs today

If the user wants to drop a template, delete the file. If the user wants to
add a new role, create a new YAML file in the same directory using
`developer.yaml` as the schema reference. See
`references/agent-templates.md` for the field reference.

Do not invoke any agent runtime in this step — onboarding writes
configuration, it does not start agents.

## Done

The onboarding flow ends with:

- a binding present in `<source>/AGENTS.md` or `<source>/CLAUDE.md`
- a tree at `<tree-root>` that passes `tree verify`
- the GitHub Scan daemon running and reporting `lock: present`
- agent templates the user has approved

Hand off to the user with a one-line summary that includes the tree path and
the daemon status. Do not loop back into onboarding for a healthy install.
