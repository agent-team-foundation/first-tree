<!-- Context: runs under /schedule or /loop for automated tree maintenance -->

**UNATTENDED=true** -- do not prompt the user.

## What this does

Runs two maintenance steps in sequence:
1. `first-tree gardener sync` -- detect source drift and open tree-update PRs
2. `gardener` review -- review open PRs on the tree repo for context fit

## Step 1: Run sync

Read and execute `.claude/commands/first-tree-sync.md` as a runbook.
If it exits with an error, log the error and continue to Step 2.

## Step 2: Run gardener

Check if `.claude/commands/gardener-manual.md` exists.
- If yes -> read and execute it as a runbook.
- If no -> log "⏭ gardener not installed. Skipping context review."

## Summary

Log a one-line summary: "Sync: <N> PRs opened. Gardener: <N> items reviewed."
