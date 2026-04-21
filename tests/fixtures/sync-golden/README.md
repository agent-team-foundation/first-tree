# sync-golden fixtures

**Changing any file in this directory requires coordination with
[`repo-gardener`](https://github.com/agent-team-foundation/repo-gardener)
maintainers.**

These fixtures lock down the external-effects shape of
`gardener sync --apply` — the commit message, PR title, PR body,
labels, branch name pattern, and order of `git`/`gh` calls. Repo-gardener
shells out to `gardener sync --apply` on a schedule and parses these
surfaces. Any drift here silently changes what repo-gardener produces
in production.

## Fixtures

- `two-pr-apply.json` — happy path: two merged source PRs, two tree
  PRs created end-to-end.
- `zero-changes.json` — source HEAD already matches
  `lastReconciledSourceCommit`; sync short-circuits with "up to date"
  and creates nothing.
- `existing-pr.json` — a tree PR already exists for both source PRs
  (matched via `gh pr list --search`); sync skips push/create for both
  groups. Idempotency path.

## Updating

To regenerate after an **intentional**, coordinated change:

```
UPDATE_SYNC_GOLDEN=1 pnpm vitest run tests/tree/sync-golden-snapshot.test.ts
```

Review the fixture diff by hand in the same PR as the code change.
Never auto-regenerate in CI.
