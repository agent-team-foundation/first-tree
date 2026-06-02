# Onboarding CLI Quick Reference

Every command this skill calls, grouped by phase (see SKILL.md for the state machine). All accept `--help` for full flags.

## Phase A — Status

```bash
first-tree tree status --json
```

Always the first call. Walks up from cwd looking for
`<workspaceRoot>/.first-tree/workspace.json`. JSON output includes
`workspaceRoot`, `manifest.tree`, `manifest.sources`, `boundSources[]`,
`unboundGitSiblings[]`, `missingLocally[]`. If no workspace.json is
found the output describes the legacy `inspect` `role` (back-compat
during the W1 transition); in that case go to Phase A.5.

## Phase A.5 — Migrate legacy multi-mode workspace

```bash
# Preview
first-tree tree migrate-to-w1 --dry-run

# Run, prompting before any destructive `mv`
first-tree tree migrate-to-w1

# Run with a pre-chosen workspace name (Case B/C single-repo promote)
first-tree tree migrate-to-w1 --workspace-name <name>

# Skip the promote prompt (use only after a clean dry-run review)
first-tree tree migrate-to-w1 --yes
```

Converts legacy `.first-tree-workspace` marker + tree `bindings/` + per-source `source.json` layouts to W1. Idempotent and resumable — if a previous run partially failed, re-running detects the surviving legacy artifacts and finishes the cleanup.

The migration leaves dirty working-tree edits in the tree and each source repo. No git operations are performed; the user commits.

## Phase B — Init

```bash
# Lone source repo, scaffold a new sibling tree (dedicated mode)
first-tree tree init --tree-mode dedicated

# Lone source repo, clone an existing tree as sibling (shared mode)
first-tree tree init --tree-url <url> --tree-mode shared

# Workspace-level init (cwd is the workspace root; tree is a child of cwd)
first-tree tree init --scope workspace --tree-mode shared --workspace-id <slug>
first-tree tree init --scope workspace --tree-url <url> --tree-mode shared --workspace-id <slug>
```

`init` writes the workspace-root framework (skills under
`.agents/skills/` + `.claude/skills/`, framework `AGENTS.md` / `CLAUDE.md`),
scaffolds or clones the tree, and writes
`<workspaceRoot>/.first-tree/workspace.json` when cwd is the workspace
root and the tree resolves to an immediate child. After init, surface
`unboundGitSiblings[]` from a fresh `first-tree tree status` and ask
the user which to add to `workspace.json.sources`.

## Phase B / Phase B-refresh — Skill Maintenance

```bash
first-tree tree skill install                 # install all five shipped skills at workspace root
first-tree tree skill upgrade                 # refresh from current package
first-tree tree skill list --json             # report version + cliCompat status
first-tree tree skill doctor                  # exit 1 on any failure
first-tree tree skill link                    # repair .claude symlinks at workspace root
```

`tree skill upgrade` is safe to rerun. `doctor` is the fastest health probe.

## Phase B / F — Verification

```bash
first-tree tree verify                                       # run from inside the tree subdir
first-tree tree verify --tree-path <workspaceRoot>/<tree>    # run from anywhere
```

`verify` exits 0 only if the tree's structure is intact. Onboarding must not
proceed past step 3 without a clean verify.

## Phase D — GitHub Scan Daemon

```bash
first-tree github scan install --allow-repo <owner/repo>[,...]
first-tree github scan start --allow-repo <owner/repo>[,...]
first-tree github scan status
first-tree github scan doctor
first-tree github scan stop
```

`install` does both first-run setup and daemon start. `start` is for
re-launching after `stop`. `doctor` is the read-only health check. Pull
the `<owner/repo>` values from `boundSources[].remoteUrl` in the status
output.

## Phase D.5 — GitHub automation rule layer

```bash
first-tree tree upgrade --tree-path <workspaceRoot>/<tree>     # only if validate.yml is missing
first-tree tree automation install --tier 2 --tree-path <workspaceRoot>/<tree>
```

`tree automation install --tier 2` is the rule-layer helper. It may write
workflow files into the tree repo, but it never performs the printed
ruleset-changing `gh api` calls on the user's behalf.

## Phase C — Content drafting (no CLI; agent + git)

Phase C is agent-driven, not CLI-driven. The only commands invoked are
`git -C <workspaceRoot>/<tree>` operations (`checkout -b`, `add`,
`diff`, `commit`, `push`) plus `gh pr create`. See
[`content-drafting.md`](content-drafting.md).

## workspace.json schema (for manual repair)

When `tree init` can't write the file (lone single-repo case where the
tree is not an immediate child of cwd), create
`<workspaceRoot>/.first-tree/workspace.json` by hand. The schema is two
fields and strict on each:

```json
{
  "tree": "<immediate-subdir-name-of-tree-repo>",
  "sources": ["<immediate-subdir-name-of-source-repo>", "..."]
}
```

- `tree` must be a single immediate subdir name. No path separators, no
  dotfiles, no `.` or `..`.
- `sources` entries follow the same rule. The tree name must not appear
  in `sources`. Duplicates are rejected.

After hand-editing, `first-tree tree status --json` should immediately
report the new manifest.

## What Onboarding Should NEVER Run

- `first-tree github scan run` / `daemon` / `run-once` — those are foreground
  loops for debugging, not the user-facing daemon path. Use `start` /
  `install` instead.
- The `gh api` commands printed by `first-tree tree automation install --tier 2`
  — those stay manual.
- Any direct edit of the managed First Tree framework blocks in the
  workspace root's `AGENTS.md` / `CLAUDE.md` — let the CLI manage state.
  If the block looks wrong, re-run `tree init`.
- `migrate-to-w1 --yes` without first reviewing `--dry-run` output. The
  promote step is destructive.
