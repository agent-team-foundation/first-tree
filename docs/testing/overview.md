# Testing

Authoritative decision node: `first-tree-skill-cli/validation-surface.md` in
the bound Context Tree.

Use this local reference when you need the concrete commands and file
entrypoints for validating work in this source repo.

## Release Gate

A single command — `pnpm release:check` — is the "green means shippable"
gate. CI runs exactly this command, and `prepublishOnly` reruns it before
`npm publish` so a local mistake cannot accidentally publish a broken
tarball. The gate chains seven steps in order; any one failure aborts.

```bash
pnpm release:check
```

It composes:

1. `pnpm version:check` — `package.json`, `assets/tree/VERSION`,
   `src/products/tree/VERSION`, and `skills/first-tree/VERSION` agree.
2. `pnpm validate:skill` — canonical skill layout + alias symlinks + no
   legacy artifacts in any of the four skill payloads.
3. `pnpm typecheck` — `tsc --noEmit` across the TypeScript graph.
4. `pnpm test` — all unit + e2e suites (vitest). Release-only suites
   (`tests/dist/`, `tests/release/`) are env-gated and skip here.
5. `pnpm build` — `tsdown` produces `dist/cli.js` and
   `dist/breeze-statusline.js`.
6. `pnpm test:dist` — runs the real built binary: `--version`, per-namespace
   `--help`, statusline latency, bundle does not reference `src/`.
7. `pnpm test:release` — `pnpm pack` + `npm install <tarball>` in a clean
   temp dir; asserts the published files list (allowlist + blocklist), the
   bin shebang, the installed CLI's version and namespace help, the four
   bundled skills + references on disk, and absence of maintainer-only
   directories.

### Env-gated release suites

The heavy release-only suites are gated so the default `pnpm test` stays
fast:

- `FIRST_TREE_DIST_TESTS=1` enables `tests/dist/*` (used by `test:dist`).
- `FIRST_TREE_RELEASE_TESTS=1` enables `tests/release/*` (used by
  `test:release`).

You rarely need to set them by hand — `pnpm test:dist` and
`pnpm test:release` wire the flags for you.

## Individual Checks

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm test:dist         # requires a prior `pnpm build`
pnpm test:release      # packs + installs the tarball in a temp dir
```

### What Each Check Covers

- `pnpm validate:skill` verifies the canonical skill structure and sync rules.
- `pnpm typecheck` catches TypeScript boundary and import issues.
- `pnpm test:e2e` runs maintainer smoke tests that execute real CLI workflows in
  temporary repos and workspaces, including shared-tree binding plus mocked
  publish/review flows.
- `pnpm test` runs unit tests plus repo-local helper tests that support
  maintainer tooling.
- `pnpm build` emits the thin CLI bundle and the statusline bundle.
- `pnpm test:dist` smoke-tests the built binary against real `node` invocations.
- `pnpm test:release` publishes the repo into a tarball, installs it clean,
  and drives the installed CLI end-to-end.

## Targeted Unit Tests

Examples:

```bash
pnpm test:e2e
pnpm test -- tests/tree/skill-artifacts.test.ts
pnpm test -- tests/e2e/thin-cli.test.ts
pnpm test -- tests/tree/verify.test.ts
pnpm test -- tests/tree/sync.test.ts
```

If a future refactor changes these paths again, keep the command semantics and
coverage expectations aligned with the tree node.

## Packaging Check

```bash
pnpm pack
```

Useful for manual tarball inspection. For automated coverage,
`pnpm test:release` already runs `pnpm pack` + `npm install` and asserts
the package contents; you shouldn't need to run `pnpm pack` by hand unless
you're diagnosing a specific packaging regression.

## Repo-Only Evals

The end-to-end eval harness is intentionally not part of the distributed skill.
It lives under root `evals/` for `first-tree` maintainers working in this
source repo. Use `evals/README.md` when you need to run or update it.

## Change Discipline

- Update this local reference whenever concrete test entrypoints change.
- If the validation philosophy or coverage contract changes, update the tree
  node first and then sync this file.
