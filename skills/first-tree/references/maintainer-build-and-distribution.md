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
- `vitest.config.ts` defines unit-test entrypoints, and
  `vitest.eval.config.ts` defines the repo-only maintainer eval entrypoint.
- `.github/workflows/ci.yml` is the thin CI shell for repo validation.

These files are shell surfaces. Their meaning must be documented here or in
another skill reference, not only in the files themselves.

## Distribution Rules

- Do not introduce a second copy of the framework outside the skill.
- `package.json` must ship `skills/first-tree/` in the published
  package alongside the thin CLI build output.
- Keep repo-only developer tooling such as root `evals/` out of the published
  package unless it becomes part of the user-facing framework contract.
- If the CLI needs bundled knowledge or payload files, ship the canonical skill
  with the package rather than copying that information into root docs.
- Normal `first-tree init` / `first-tree upgrade` flows must install from
  the skill bundled in the running package, not by cloning the source repo.
- Default dedicated-tree-repo creation must stay local-only. It may create a
  sibling git repo on disk, but it must not require remote repo creation or
  source-repo cloning.
- `first-tree publish` is the explicit networked second-stage command for
  GitHub repo creation, source/workspace URL refresh, local checkout-config
  refresh, and optional source-repo PR opening. Keep that remote behavior
  there instead of expanding default `init`.
- If you change anything that gets copied into user repos, bump
  `assets/framework/VERSION` and keep the upgrade task text in sync.
- If packaging changes alter what gets installed into user repos, update
  `references/upgrade-contract.md`, tests, and validation commands together.
