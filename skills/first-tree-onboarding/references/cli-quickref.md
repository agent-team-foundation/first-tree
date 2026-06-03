# Onboarding CLI Quick Reference

Every command this skill calls, grouped by phase (see SKILL.md for the state machine). All accept `--help` for full flags.

## Phase A — Status

```bash
first-tree tree status --json
```

Always the first call. Walks up from cwd looking for
`<workspaceRoot>/.first-tree/workspace.json`. JSON output is the
`WorkspaceStatus` shape — see [`recipe.md` §Reading status output](recipe.md) for the full schema.
The fields onboarding consumes most are `workspaceRoot`,
`manifest.tree`, `manifest.sources`, `boundSources[]`,
`unboundGitSiblings[]`, and `missingBoundSources[]` (declared-but-not-cloned
sources). If no `workspace.json` is found anywhere up the path,
`status` exits 1 with "No First Tree workspace found"; route to Phase B
(new workspace) or Phase A.5 (legacy 0.5.x → W1 migration).

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
# Lone source repo path — pre-create the workspace dir, move the source
# repo inside it, then run init from there. W1 requires source + tree
# as siblings under the workspace root, and init only writes
# workspace.json when scope is workspace AND the tree is an immediate
# child of cwd.
#   Step 1: from the source repo's parent dir
mkdir <workspace-name>
mv <source-repo> <workspace-name>/

#   Step 2: cd into the workspace and init
cd <workspace-name>
first-tree tree init --scope workspace \
  --tree-path ./<tree-name> \
  --tree-mode dedicated \
  --workspace-id <slug>
# Or for an existing remote tree:
first-tree tree init --scope workspace \
  --tree-path ./<tree-name> \
  --tree-url <url> \
  --tree-mode shared \
  --workspace-id <slug>

# Workspace-level init (cwd is already the workspace root; tree is a
# child of cwd). Same shape, default --tree-path inferred.
first-tree tree init --scope workspace --tree-mode shared --workspace-id <slug>
first-tree tree init --scope workspace --tree-url <url> --tree-mode shared --workspace-id <slug>
```

`init` writes the workspace-root framework (skills under
`.agents/skills/` + `.claude/skills/`, framework `AGENTS.md` /
`CLAUDE.md`), scaffolds or clones the tree, and writes
`<workspaceRoot>/.first-tree/workspace.json` listing every immediate-
child git repo as a source. It does not recurse into nested git repos,
and it does not install per-source skill/framework files — agents launch
at the workspace root and read the workspace-rooted install. After init,
surface `unboundGitSiblings[]` from a fresh `first-tree tree status` and
ask the user which to add to `workspace.json.sources`.

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

## Phase D — GitHub automation rule layer

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

## workspace.json schema (for read + hand-repair)

For lone-single-repo onboarding the canonical path is **not** to
hand-create the manifest — use the Phase B recipe above (`mkdir
<workspace>` + `mv <source>` + `init --scope workspace`). That recipe
writes the manifest directly and avoids any legacy state.

Hand-create `<workspaceRoot>/.first-tree/workspace.json` only when
recovering from a corrupted manifest in an existing workspace (e.g.
the file went missing but the layout still matches the manifest's
shape). The schema is two fields and strict on each:

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

- `first-tree tree publish` — that is a release flow, not onboarding.
- The `gh api` commands printed by `first-tree tree automation install --tier 2`
  — those stay manual.
- Any direct edit of the managed First Tree framework blocks in the
  workspace root's `AGENTS.md` / `CLAUDE.md` — let the CLI manage state.
  If the block looks wrong, re-run `tree init`.
- `migrate-to-w1 --yes` without first reviewing `--dry-run` output. The
  promote step is destructive.
