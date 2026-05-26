# Onboarding CLI Quick Reference

Every command this skill calls, grouped by phase (see SKILL.md for the state machine). All accept `--help` for full flags.

## Phase A — Inspect

```bash
first-tree tree inspect --json
```

Always the first call. Reports `role`, `binding`, `rootPath`, etc.

## Phase B — Init And Bind

```bash
# Single repo, new dedicated tree
first-tree tree init --tree-mode dedicated

# Single repo, bind to local existing tree
first-tree tree init --tree-path ../org-context --tree-mode shared

# Single repo, bind to remote tree (CLI clones to .first-tree/tmp/)
first-tree tree init --tree-url <url> --tree-mode shared

# Workspace, new shared tree
first-tree tree init --scope workspace --tree-mode shared --workspace-id <id>

# Workspace, bind to existing shared tree
first-tree tree init --scope workspace --tree-path ../org-context --tree-mode shared
```

## Phase B (workspace) — Workspace Sync

```bash
# Discovery only
first-tree tree workspace sync --dry-run --json

# Real sync — bind newly added child repos
first-tree tree workspace sync
```

Use after step 3 to pick up child repos added since the last init.

## Phase B / Phase B-refresh — Skill Maintenance

```bash
first-tree tree skill install --root <path>   # write skills into a target root
first-tree tree skill upgrade                 # refresh from current package
first-tree tree skill list --json             # report version + cliCompat status
first-tree tree skill doctor                  # exit 1 on any failure
first-tree tree skill link                    # repair .claude symlinks
```

`tree skill upgrade` is safe to rerun. `doctor` is the fastest health probe.

## Phase B / F — Verification

```bash
first-tree tree verify                        # run from inside the tree repo
first-tree tree verify --tree-path <path>     # run from the source repo
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
re-launching after `stop`. `doctor` is the read-only health check.

## Phase D.5 — GitHub automation rule layer

```bash
first-tree tree upgrade --tree-path <tree_root>         # only if validate.yml is missing
first-tree tree automation install --tier 2 --tree-path <tree_root>
```

`tree automation install --tier 2` is the rule-layer helper. It may write
workflow files into the tree repo, but it never performs the printed
ruleset-changing `gh api` calls on the user's behalf.

## Phase C — Content drafting (no CLI; agent + git)

Phase C is agent-driven, not CLI-driven. The only commands invoked are `git -C <tree_root>` operations (`checkout -b`, `add`, `diff`, `commit`, `push`) plus `gh pr create`. See [`content-drafting.md`](content-drafting.md).

## What Onboarding Should NEVER Run

- `first-tree tree publish` — that is a release flow, not onboarding.
- `first-tree github scan run` / `daemon` / `run-once` — those are foreground
  loops for debugging, not the user-facing daemon path. Use `start` /
  `install` instead.
- The `gh api` commands printed by `first-tree tree automation install --tier 2`
  — those stay manual.
- Any direct edit of the managed First Tree blocks in `AGENTS.md` /
  `CLAUDE.md` — let the CLI manage state. If the block looks wrong, re-run
  `tree init` with the right flags.
