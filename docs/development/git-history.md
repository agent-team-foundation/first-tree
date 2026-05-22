# Git history across the repo-merge boundary

In May 2026 the two source repos `agent-team-foundation/first-tree-hub` and
`agent-team-foundation/first-tree` were merged into a single repo published as
**`agent-team-foundation/first-tree`**. This file documents the merge anchors and
the conventions for traversing history across the merge boundary.

## Anchor commits

| Anchor | SHA | Meaning |
| --- | --- | --- |
| Legacy first-tree dev HEAD at merge time | `032569d9dbe5467d060ee9ac2c762dd92bdb409c` | Phase 1B completion on legacy `first-tree` repo (PR #436). This is the dev branch tip that was imported. |
| `merge --allow-unrelated-histories` commit | `267c5d951cac4d8e3b454444d43a61e208525672` | The merge commit in this repo that unified the two histories. T2.1 in the PR-1 plan. |
| Biome reformat | `a08c6688bd2f9d99e544feb13a97f2b85779e504` | One-shot `pnpm biome check --write .` applied to first-tree-sourced files (121 files), per D5 tooling decision. Listed in `.git-blame-ignore-revs`. T2.3 reformat commit. |

## Tracing history across the merge boundary

Because the merge used `git merge --allow-unrelated-histories`, all original
SHAs from the legacy `first-tree` repo are preserved in this repo's history.

* `git log --all --oneline | grep <legacy-sha>` will find an imported commit.
* `git log --follow path/to/file` traverses renames during T2.2 (`git mv` reloc).
* `git blame --follow path/to/file` traverses the same renames for line-by-line
  authorship.

If you are reading a file under `apps/cli/src/commands/tree/`,
`apps/cli/src/commands/github/`, `packages/github-scan/`, or `skills/first-tree*/`,
`--follow` and `--ignore-revs-file=.git-blame-ignore-revs` together give you the
real authorship and chronology, even though the file was relocated by the merge.

## `.git-blame-ignore-revs`

GitHub's Blame view honours this file automatically. Locally, run blame with:

```bash
git blame --ignore-revs-file=.git-blame-ignore-revs path/to/file
```

Or set it globally for this repo:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

The reformat commit `a08c6688` is currently the only entry. Add additional SHAs
here only for one-shot mechanical reformats / cross-tree renames that would
otherwise show up as the author of every line they touched.

## Cross-references

* PR-1 plan: see the workspace design doc `first-tree-repo-merge-phase2-4-design.md`.
* Original proposal: [`first-tree-context/proposals/first-tree-repo-merge.20260521.md`](https://github.com/agent-team-foundation/first-tree-context/blob/main/proposals/first-tree-repo-merge.20260521.md).
* Migration for end users coming from the old CLI names:
  * [from-first-tree-hub.md](../migration/from-first-tree-hub.md) — for users of the old `first-tree-hub` CLI.
  * [from-first-tree-v0.md](../migration/from-first-tree-v0.md) — for users of legacy `first-tree@0.4.x`.
