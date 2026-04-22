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
pnpm test -- tests/gardener/sync.test.ts
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

## Agent-E2E Tier

A separate, out-of-band tier exercises the agent-facing behaviour of
the shipped `SKILL.md` files and CLI `--help` output via a real Claude
Code subprocess. It is intentionally **not** part of `release:check`:
LLM flake would create noisy red PRs, and every run costs money.

```bash
pnpm test:agent
```

Requires the Claude Code CLI (`claude`) on PATH plus
`FIRST_TREE_AGENT_TESTS=1` (the script sets the flag). The tier uses a
real `claude -p` subprocess for both the judge and the agent runs, so
auth goes through whatever the local `claude` binary is configured for:

- **Local, Claude Code subscription** — zero extra setup and no
  per-token cost; the subscription covers every judge call and every
  agent run.
- **CI / no subscription** — set `ANTHROPIC_API_KEY`; the `claude` CLI
  automatically uses the key instead of an OAuth token. This is how
  the scheduled workflow runs.

Without either the `claude` binary or the env flag, every test in the
tier skips cleanly.

### Suites

- `tests/agent-e2e/skill-quality.test.ts` — LLM judge scores each of the
  four `SKILL.md` files on clarity / completeness / actionability
  (≥4/5, regression check against `baselines/skill-quality.json`).
- `tests/agent-e2e/command-discovery.test.ts` — spawns a real Claude
  subprocess against six intent prompts and asserts the correct
  `first-tree <ns> <cmd>` was invoked.
- `tests/agent-e2e/path-disambiguation.test.ts` — three scenarios that
  verify the agent picks the right command among source-repo vs
  dedicated-tree vs workspace contexts.
- `tests/agent-e2e/anti-hallucination.test.ts` — three negative tests
  that assert the agent does **not** fabricate plausible-but-fake verbs
  (`tree owner-set`, `tree stats`, `breeze ack`, etc.).
- `tests/agent-e2e/help-self-sufficiency.test.ts` — LLM judge on
  `first-tree <ns> --help` for all four namespaces (baseline in
  `baselines/help-quality.json`).

### When it runs

- **Weekly cron** via `.github/workflows/agent-e2e.yml` (Monday 07:00 UTC),
  so SKILL.md or prompt drift caused by a recent merge shows up early in
  the week without gating individual PRs.
- **Manual dispatch** — run via GitHub Actions → "Agent E2E" before a
  release, optionally filtering with a vitest name pattern.
- **Locally** — `ANTHROPIC_API_KEY=… pnpm test:agent`.

### Baselines

Stage A (skill quality) and Stage E (help quality) use pinned baselines
that maintainers hand-bump. To seed or update them:

```bash
ANTHROPIC_API_KEY=… pnpm test:agent
# Review the printed scores; if acceptable, commit updated baseline
# files under tests/agent-e2e/baselines/.
```

Never update a baseline automatically on a passing run — regressions
should be an explicit human sign-off.

## Repo-Only Evals

The full end-to-end bug-fix eval harness is intentionally not part of
the distributed skill. It lives under root `evals/` for `first-tree`
maintainers working in this source repo. Use `evals/README.md` when
you need to run or update it. Agent-e2e (above) is cheaper and
behaviour-focused; evals are higher-fidelity and fix-a-real-bug
focused.

## Change Discipline

- Update this local reference whenever concrete test entrypoints change.
- If the validation philosophy or coverage contract changes, update the tree
  node first and then sync this file.
