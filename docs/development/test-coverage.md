# Test coverage

Local unit-test coverage is available for the main source packages:

- `apps/cli`
- `packages/server`
- `packages/client`
- `packages/shared`
- `packages/web`

Run the full local coverage pass from the repository root:

```bash
pnpm coverage
```

Each package writes reports under its own `coverage/` directory:

- `coverage/index.html` - browsable HTML source coverage
- `coverage/lcov.info` - LCOV data for external tools
- `coverage/coverage-summary.json` - machine-readable totals used by the summary script

After `pnpm coverage` finishes, print a package-by-package summary and weighted total:

```bash
pnpm coverage:summary
```

Coverage output is generated state and is ignored by `.gitignore`. This local coverage entry does not set CI thresholds or upload artifacts.
