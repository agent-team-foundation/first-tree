# Build And Distribution

Use this reference when touching package wiring, release behavior, or the
distributable contract of `first-tree`.

## Fast Validation

Run these commands from the repo root:

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
```

## Packaging Checks

When changing package contents, build wiring, or install/upgrade behavior, also
run:

```bash
pnpm pack
```

Inspect the tarball contents before merging packaging changes. The distribution
must be able to carry the canonical skill and the thin CLI shell without
requiring repo-local prose.

## Build Responsibilities

- `package.json` defines package metadata, scripts, and import aliases.
- `tsconfig.json` defines TypeScript compile boundaries.
- `tsdown.config.ts` defines the build entry and asset loaders.
- `vitest.config.ts` and `vitest.eval.config.ts` define the unit/eval test
  entrypoints.
- `.github/workflows/ci.yml` is the thin CI shell for repo validation.

These files are shell surfaces. Their meaning must be documented here or in
another skill reference, not only in the files themselves.

## Distribution Rules

- Do not introduce a second copy of the framework outside the skill.
- If the CLI needs bundled knowledge or payload files, ship the canonical skill
  with the package rather than copying that information into root docs.
- If packaging changes alter what gets installed into user repos, update
  `references/upgrade-contract.md`, tests, and validation commands together.
