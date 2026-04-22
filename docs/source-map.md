# Context Tree Source Map

This is the maintainer entrypoint for the `first-tree` source repo.

Read canonical decisions from the bound Context Tree first. Use the repo-local
docs below only for source-repo implementation details.

## Read First

| Path | Why it matters |
| --- | --- |
| `first-tree-skill-cli/repo-architecture.md` | Canonical layer model plus the boundary between tree knowledge and source-repo docs |
| `first-tree-skill-cli/thin-cli-shell.md` | Command-surface contract for the thin CLI shell |
| `first-tree-skill-cli/build-and-distribution.md` | Packaging and release invariants |
| `first-tree-skill-cli/validation-surface.md` | Validation philosophy and coverage expectations |
| `first-tree-skill-cli/sync.md` | Authoritative product/architecture context for `first-tree gardener sync` |
| `src/products/manifest.ts` | Single source of truth for the CLI namespace set: products (`tree`, `breeze`, `gardener`) plus maintenance (`skill`) |
| `skills/first-tree/SKILL.md` | User-facing entry-point skill: methodology + routing to product skills |
| `skills/tree/SKILL.md` | Operational handbook for the `first-tree tree` CLI |
| `skills/breeze/SKILL.md` | Operational handbook for the `first-tree breeze` CLI |
| `skills/gardener/SKILL.md` | Operational handbook for the `first-tree gardener` CLI |
| `skills/first-tree/references/onboarding.md` | Repo, shared-tree, and workspace onboarding model |
| `skills/first-tree/references/source-workspace-installation.md` | Binding model and source/workspace contract |
| `skills/first-tree/references/upgrade-contract.md` | Installed layout and upgrade invariants |
| `docs/architecture/overview.md` | Local file-level architecture map for this source repo |
| `docs/architecture/thin-cli.md` | Implementation touchpoints for `src/cli.ts` and command adapters |
| `docs/architecture/versioning.md` | Local contract for VERSION files, package version reporting, and release-layer boundaries |
| `docs/build/distribution.md` | Packaging surfaces and release checklist in this repo |
| `docs/testing/overview.md` | Concrete validation commands and targeted test entrypoints |
| `docs/design/sync.md` | Local implementation touchpoints for the sync feature |

## Runtime Payload

| Path | Purpose |
| --- | --- |
| `assets/tree/manifest.json` | Tree runtime asset contract |
| `assets/tree/VERSION` | Version marker for tree installs |
| `assets/tree/templates/` | Generated tree scaffolds |
| `assets/tree/workflows/` | CI templates |
| `assets/tree/prompts/` | Review prompt payload |
| `assets/tree/examples/` | Agent integration examples |
| `assets/tree/helpers/` | Shipped helper scripts and TS utilities |
| `assets/breeze/dashboard.html` | SSE dashboard served by the breeze daemon HTTP server |

## Engine Surface

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Top-level umbrella dispatcher for `first-tree <namespace> <command>`; reads from the namespace manifest |
| `src/products/manifest.ts` | Namespace manifest (kind, name, description, lazy entrypoint, auto-upgrade, asset/skill flags) |
| `src/products/tree/cli.ts` | Tree product dispatcher (lazy-loaded) |
| `src/products/tree/README.md` | Maintainer/product-local overview for the tree product |
| `src/products/breeze/cli.ts` | Breeze product dispatcher (lazy-loaded) |
| `src/products/breeze/README.md` | Maintainer/product-local overview for the breeze product |
| `src/products/gardener/cli.ts` | Gardener product dispatcher (lazy-loaded) |
| `src/products/gardener/README.md` | Maintainer/product-local overview for the gardener product |
| `src/meta/skill-tools/cli.ts` | Skill maintenance-namespace dispatcher (lazy-loaded) |
| `src/meta/skill-tools/README.md` | Maintainer/meta overview for the skill maintenance namespace |
| `src/products/breeze/engine/` | Breeze business logic: `commands/`, `runtime/`, `daemon/`, `bridge.ts`, `statusline.ts` |
| `src/products/gardener/engine/` | Gardener business logic: `commands/`, `runtime/`, `daemon/`, `sync.ts`, `comment.ts`, `respond.ts`, `install-workflow.ts` |
| `src/products/gardener/engine/sync.ts` | Drift detection, proposal generation, and apply flow (moved from tree namespace) |
| `src/products/tree/engine/init.ts` | High-level onboarding wrapper plus low-level tree bootstrap |
| `src/products/tree/engine/inspect.ts` | Root classification before onboarding |
| `src/products/tree/engine/bind.ts` | Binding a source/workspace root to an existing tree |
| `src/products/tree/engine/workspace-sync.ts` | Binding child repos to a shared tree |
| `src/products/tree/engine/publish.ts` | Tree publish flow and local source refresh |
| `src/products/tree/engine/upgrade.ts` | Installed-skill / tree upgrade behavior |
| `src/products/tree/engine/verify.ts` | Tree verification |
| `src/products/tree/engine/runtime/binding-state.ts` | `source.json`, `tree.json`, and `bindings/` schema |
| `src/products/tree/engine/runtime/local-tree-config.ts` | Local tree config helpers (delegates to `source.json`) |
| `src/products/tree/engine/runtime/source-repo-index.ts` | Generated `source-repos.md` index plus root tree repo guidance |
| `src/products/tree/engine/runtime/source-integration.ts` | Managed `AGENTS.md` / `CLAUDE.md` source integration block |
| `src/products/tree/engine/workspace.ts` | Local child-repo discovery for workspace roots |

## Validation

| Path | Coverage |
| --- | --- |
| `tests/tree/init.test.ts` | Tree bootstrap and init wrapper behavior |
| `tests/e2e/cli-e2e.test.ts` | End-to-end CLI smoke coverage across repo, workspace, publish, and review workflows |
| `tests/tree/publish.test.ts` | Publish orchestration |
| `tests/gardener/sync.test.ts` | Sync behavior and apply flow |
| `tests/gardener/sync-golden-snapshot.test.ts` | Sync golden-snapshot coverage |
| `tests/e2e/thin-cli.test.ts` | Thin CLI smoke coverage |
| `tests/tree/skill-artifacts.test.ts` | Skill export and doc integrity |
| `tests/tree/upgrade.test.ts` | Upgrade behavior |
| `tests/tree/verify.test.ts` | Verification behavior |

## Notes

- Keep decision-grade knowledge in the bound Context Tree under
  `first-tree-skill-cli/`.
- Keep root `README.md` and `AGENTS.md` short and distribution-focused.
- Keep shipped user knowledge in `skills/first-tree/references/` (shared
  across all four skills; individual product skills have no `references/`
  of their own).
- Keep runtime metadata changes synchronized across tree nodes, local docs,
  tests, and code.
