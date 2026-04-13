# Design: `first-tree sync`

> Authoritative design document for the sync feature.
> Last updated: 2026-04-10

## Overview

`first-tree sync` detects when a Context Tree has drifted from the source repo(s) it describes, classifies each change using AI, and opens targeted pull requests to bring the tree back in line.

The goal is to keep trees current so downstream consumers (like gardener) operate on accurate context. Without sync, trees rot silently as the source code evolves.

## How it works — three phases

Sync runs in three progressive phases. Each phase includes all the work of the previous one.

### 1. Detect (default, no flags)

Check each bound source repo for new merged PRs since the last sync pin. Print a summary of what changed and how far the tree has drifted.

This is safe to run at any time — it is read-only and makes no changes.

### 2. Propose (`--propose`)

Detect + classify each source PR against the tree using AI. For every merged source PR, a Claude call determines whether the tree needs updating. Results are written to `.first-tree/proposals/`.

### 3. Apply (`--apply`)

Propose + create one tree PR per source PR. If gardener is installed on the tree repo, PRs are labeled for auto-merge. If not, the PR body includes a warning that manual review is required.

## Key design decisions

### One source PR maps to one tree PR

Tree PRs are not bundled. Each tree PR has clear scope, gets routed to the right owner via CODEOWNERS, and can be merged independently. This makes review tractable and rollback trivial.

### AI is required — no deterministic fallback

Classification requires the `claude` CLI. If it is not on PATH, sync exits with code 1 and prints install instructions. The reasoning: a bad tree update is worse than no tree update. Quality over availability.

### Classification is per-PR, not per-batch

Each merged source PR gets its own Claude call. This keeps the context window small, produces cleaner verdicts, and naturally maps to the one-PR-per-source-PR output model.

### Gardener is required for auto-merge

When gardener is installed on the tree repo, sync PRs receive an `auto-merge` label. When it is not installed, PRs are opened without the label and the PR body warns that manual review is needed.

### First run traces history

On first run (no existing sync pin), sync does not silently pin to HEAD. Instead it walks up to 500 commits back (or 6 months, whichever comes first) and generates proposals for the full history. The pin is only recorded after a successful apply.

### Only already-bound sources are processed

New repos must be bound first via `first-tree bind` or `first-tree workspace sync`. Auto-discovery of new source repos is not in scope for this feature.

### Multi-source support

A shared tree can bind multiple source repos. Each source gets its own `lastReconciledSourceCommit` pin stored in `.first-tree/bindings/<sourceId>.json`.

## Classification logic

For each merged source PR, the AI returns one of two verdicts:

| Verdict | Meaning | Action |
|---|---|---|
| **TREE_OK** | The tree already covers this change | No tree PR opened |
| **TREE_MISS** | The tree has no coverage for this area | New node proposed |

There is intentionally no TREE_STALE verdict. Since gardener is required on the source repo, every merged PR has already passed context-fit review before merge. A merged PR cannot contradict the tree — if it did, gardener would have flagged it pre-merge. The only question sync asks is: "did this PR introduce new knowledge the tree hasn't captured yet?"

The classification prompt biases toward TREE_MISS. A sparse tree (missing context) is more dangerous than a detailed one (extra context), because downstream consumers make worse decisions with gaps than with redundancy.

The AI evaluates the overall picture of each PR, not individual commits within it.

## End-to-end flow

Using the paperclip project as an example:

```
paperclip repo gets PRs merged
  -> sync schedule detects drift (hourly)
  -> AI classifies each merged PR against tree nodes
  -> one tree PR opened per source PR
  -> CI checks (typecheck, test, build, verify)
  -> gardener reviews for context-fit
  -> node owner approves
  -> squash merge -> tree is current
```

## Schedule and automation

Four commands manage the automation lifecycle:

| Command | What it does |
|---|---|
| `first-tree-sync-start` | Verifies bindings, gardener, MCP connector. Creates cloud schedule + local loop. |
| `first-tree-sync-stop` | Disables cloud schedule, stops local loop. |
| `first-tree-sync-schedule.md` | Coordinator runbook — runs sync then gardener in one slot to avoid rate-limit conflicts. |
| `first-tree-sync-loop.md` | `/loop` wrapper for the local path. |

**Dual-path execution:**

- **Local path:** Uses the `claude` CLI directly for classification.
- **Cloud path:** Uses an agent-as-classifier since the `claude` CLI is not available in cloud sandboxes.

## File layout

When sync is installed in a tree repo, these files are added:

```
.claude/commands/
  first-tree-sync.md           <- main runbook (dual-path: local gh + cloud MCP)
  first-tree-sync-schedule.md  <- coordinator: sync then gardener
  first-tree-sync-start.md     <- start automation
  first-tree-sync-stop.md      <- stop automation
  first-tree-sync-loop.md      <- /loop wrapper
```

## Apply output structure

When `--apply` runs, it produces the following artifacts in the tree repo:

- **TREE_MISS proposals** create a new `NODE.md` under `drift/<sourceId>/<path>/`.
- Intermediate directories receive auto-generated `NODE.md` files.
- The `drift/` directory is added to the root `NODE.md` domain listing.
- `generate-codeowners` runs after writing nodes to keep ownership in sync.
- Labels (`first-tree:sync`, `auto-merge`) are pre-created via `gh label create --force`.

## Schema changes

`BoundTreeReference` and `TreeBindingState` gained two new optional fields:

```typescript
lastReconciledSourceCommit?: string  // SHA the tree was last synced to
lastReconciledAt?: string            // ISO 8601 timestamp
```

Schema version bumped from 1 to 2. Version 1 files continue to parse correctly — the new fields are `undefined`, which all code paths handle gracefully.

## Relationship to gardener

Sync and gardener are complementary but independent:

- **Sync** proposes tree updates (opens PRs).
- **Gardener** reviews tree PRs for context-fit (reviews and approves).

Sync does not depend on gardener's code. It only checks whether gardener is installed (a file existence check) to decide whether to add the `auto-merge` label.

When both are installed, the coordinator runbook (`first-tree-sync-schedule.md`) runs them in sequence within a single schedule slot, avoiding rate-limit conflicts.

## Known limitations

1. **Cloud classification quality.** The cloud schedule path uses the agent itself as classifier (no `claude` CLI in sandbox). Classification quality may differ from the local path.
2. **History trace cap.** First-run history walk stops at 500 commits or 6 months, whichever comes first.
3. **Commit-to-PR matching.** Uses heuristics (merge commit SHA, PR number mentions in commit messages). Some commits may land in an "unlinked" group that requires manual triage.
4. **Code owner review not enforced by default.** The `require_code_owner_review` branch protection rule is not set automatically. Repo admins must enable it if owner review is a hard gate.
