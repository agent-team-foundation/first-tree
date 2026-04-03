# Agent Instructions for first-tree

This repo ships the canonical `first-tree-cli-framework` skill plus a thin
`context-tree` CLI. It is not a user context tree.

## Start Here

1. `skills/first-tree-cli-framework/SKILL.md`
2. `skills/first-tree-cli-framework/references/source-map.md`
3. The specific maintainer reference linked from the source map

## Rules

- Treat `skills/first-tree-cli-framework/` as the only canonical source of
  framework knowledge.
- Keep root CLI/package files thin. If a maintainer needs information to change
  behavior safely, move that information into the skill references.
- Keep shipped runtime assets generic.

## Validation

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
```
