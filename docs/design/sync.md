# `first-tree gardener sync`

Authoritative decision node: `first-tree-skill-cli/sync.md` in the bound
Context Tree.

This repo-local file is intentionally thin. It tracks only source-repo
implementation touchpoints that do not belong in the tree.

> Moved from `first-tree tree sync` so all tree-maintenance runtime
> commands (`sync`, `comment`, `respond`) live under one product. The
> CLI at `first-tree tree sync` now prints a migration pointer and exits
> non-zero; slash commands (`/first-tree-sync*`) are unchanged and call
> the new entry point internally.

## Local Implementation Touchpoints

- `src/products/gardener/engine/sync.ts` — core detect/propose/apply implementation
- `src/products/gardener/engine/commands/sync.ts` — CLI adapter
- `tests/gardener/sync.test.ts` — sync behavior coverage
- `tests/gardener/sync-golden-snapshot.test.ts` — golden-snapshot coverage
- `assets/tree/claude-commands/first-tree-sync*.md` — installed runbooks
  and schedule payload (file names unchanged; internals call
  `first-tree gardener sync`)

## Change Checklist

- If product behavior, invariants, or classification rules change, update
  `first-tree-skill-cli/sync.md`.
- If installation surfaces or shipped runbooks change, update the runtime asset
  files here plus the relevant packaging/test docs in this repo.
