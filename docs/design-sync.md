# `first-tree sync`

Authoritative decision node: `first-tree-skill-cli/sync.md` in the bound
Context Tree.

This repo-local file is intentionally thin. It tracks only source-repo
implementation touchpoints that do not belong in the tree.

## Local Implementation Touchpoints

- `src/products/tree/engine/sync.ts` — core detect/propose/apply implementation
- `src/products/tree/engine/commands/sync.ts` — CLI adapter
- `tests/tree/sync.test.ts` — sync behavior coverage
- `assets/tree/claude-commands/first-tree-sync*.md` — installed runbooks
  and schedule payload

## Change Checklist

- If product behavior, invariants, or classification rules change, update
  `first-tree-skill-cli/sync.md`.
- If installation surfaces or shipped runbooks change, update the runtime asset
  files here plus the relevant packaging/test docs in this repo.
