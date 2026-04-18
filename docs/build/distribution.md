# Build And Distribution

Authoritative decision node: `first-tree-skill-cli/build-and-distribution.md`
in the bound Context Tree.

Use this local reference when touching package wiring, build surfaces, or the
release checklist in this repo.

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

Inspect the tarball contents before merging packaging changes.

## Local Packaging Surfaces

- `package.json` defines package metadata, scripts, and import aliases.
- `tsconfig.json` defines TypeScript compile boundaries.
- `tsdown.config.ts` defines the build entry and asset loaders.
- `vitest.config.ts` defines unit-test entrypoints, and
  `vitest.eval.config.ts` defines the repo-only maintainer eval entrypoint.
- `.github/workflows/ci.yml` is the thin CI shell for repo validation.
- `assets/tree/VERSION` marks the shipped tree product payload version.
- `src/products/tree/VERSION` mirrors the tree product version for `--version`.
- `src/products/breeze/VERSION`, `src/products/gardener/VERSION`, and
  `src/meta/skill-tools/VERSION` mirror the other namespace versions for
  `first-tree --version`.

## Release Checklist

- If package contents or install/upgrade behavior changed, run `pnpm pack`.
- Inspect the tarball to confirm it includes `dist/`, `skills/first-tree/`,
  `skills/breeze/`, `assets/`, and the shipped
  `src/products/{tree,breeze,gardener}/VERSION` plus
  `src/meta/skill-tools/VERSION`
  runtime metadata files used by `first-tree --version`, while excluding
  repo-only sources such as `docs/`, `tests/`, the rest of `src/`, and
  `evals/`.
- If you changed anything copied into user repos, bump
  `assets/tree/VERSION` and sync the upgrade docs/tests in the same change.
