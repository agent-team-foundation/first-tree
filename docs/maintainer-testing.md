# Testing

Authoritative decision node: `first-tree-skill-cli/validation-surface.md` in
the bound Context Tree.

Use this local reference when you need the concrete commands and file
entrypoints for validating work in this source repo.

## Core Checks

```bash
pnpm validate:skill
pnpm typecheck
pnpm test:e2e
pnpm test
pnpm build
```

### What Each Check Covers

- `pnpm validate:skill` verifies the canonical skill structure and sync rules.
- `pnpm typecheck` catches TypeScript boundary and import issues.
- `pnpm test:e2e` runs maintainer smoke tests that execute real CLI workflows in
  temporary repos and workspaces, including shared-tree binding plus mocked
  publish/review flows.
- `pnpm test` runs unit tests plus repo-local helper tests that support
  maintainer tooling.
- `pnpm build` checks the thin CLI bundle.

## Targeted Unit Tests

Examples:

```bash
pnpm test:e2e
pnpm test -- tests/skill-artifacts.test.ts
pnpm test -- tests/thin-cli.test.ts
pnpm test -- tests/verify.test.ts
pnpm test -- tests/sync.test.ts
```

If a future refactor changes these paths again, keep the command semantics and
coverage expectations aligned with the tree node.

## Packaging Check

```bash
pnpm pack
```

Inspect the tarball when package contents or install/upgrade behavior changes.
The published package should include the thin CLI shell and canonical skill, but
not repo-only developer tooling such as root `evals/`.

## Repo-Only Evals

The end-to-end eval harness is intentionally not part of the distributed skill.
It lives under root `evals/` for `first-tree` maintainers working in this
source repo. Use `evals/README.md` when you need to run or update it.

## Change Discipline

- Update this local reference whenever concrete test entrypoints change.
- If the validation philosophy or coverage contract changes, update the tree
  node first and then sync this file.
