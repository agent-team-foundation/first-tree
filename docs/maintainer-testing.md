# Testing

Use this reference when validating framework behavior or changing the testing
surface.

## Core Checks

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
```

### What Each Check Covers

- `pnpm validate:skill` verifies the canonical skill structure and sync rules.
- `pnpm typecheck` catches TypeScript boundary and import issues.
- `pnpm test` runs unit tests plus repo-local helper tests that support
  maintainer tooling.
- `pnpm build` checks the thin CLI bundle.

## Targeted Unit Tests

Examples:

```bash
pnpm test -- skills/first-tree/tests/rules.test.ts
pnpm test -- skills/first-tree/tests/verify.test.ts
pnpm test -- skills/first-tree/tests/skill-artifacts.test.ts
pnpm test -- skills/first-tree/tests/thin-cli.test.ts
```

If a future refactor changes these paths again, keep the command semantics and
coverage expectations documented here.

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

- Update this reference whenever core test entrypoints or packaging boundaries
  change.
- If a maintainer would need oral history to know which checks matter, that
  knowledge belongs here.
