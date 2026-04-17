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
| `first-tree-skill-cli/sync.md` | Authoritative product/architecture context for `first-tree sync` |
| `skills/first-tree/SKILL.md` | User-facing tree skill workflow |
| `skills/first-tree/references/onboarding.md` | Repo, shared-tree, and workspace onboarding model |
| `skills/first-tree/references/source-workspace-installation.md` | Binding model and source/workspace contract |
| `skills/first-tree/references/upgrade-contract.md` | Installed layout and upgrade invariants |
| `docs/maintainer-architecture.md` | Local file-level architecture map for this source repo |
| `docs/maintainer-thin-cli.md` | Implementation touchpoints for `src/cli.ts` and command adapters |
| `docs/maintainer-build-and-distribution.md` | Packaging surfaces and release checklist in this repo |
| `docs/maintainer-testing.md` | Concrete validation commands and targeted test entrypoints |
| `docs/design-sync.md` | Local implementation touchpoints for the sync feature |

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
| `assets/breeze/` | Breeze runtime assets (Phase 1+ placeholder) |

## Engine Surface

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Top-level umbrella dispatcher for `first-tree <product> <command>` |
| `src/products/tree/cli.ts` | Tree product dispatcher (lazy-loaded) |
| `src/products/breeze/cli.ts` | Breeze product dispatcher stub (Phase 1+) |
| `src/products/tree/engine/init.ts` | High-level onboarding wrapper plus low-level tree bootstrap |
| `src/products/tree/engine/inspect.ts` | Root classification before onboarding |
| `src/products/tree/engine/bind.ts` | Binding a source/workspace root to an existing tree |
| `src/products/tree/engine/workspace-sync.ts` | Binding child repos to a shared tree |
| `src/products/tree/engine/publish.ts` | Tree publish flow and local source refresh |
| `src/products/tree/engine/upgrade.ts` | Installed-skill / tree upgrade behavior |
| `src/products/tree/engine/verify.ts` | Tree verification |
| `src/products/tree/engine/sync.ts` | Drift detection, proposal generation, and apply flow |
| `src/products/tree/engine/runtime/binding-state.ts` | `source.json`, `tree.json`, and `bindings/` schema |
| `src/products/tree/engine/runtime/local-tree-config.ts` | Local tree config helpers (delegates to `source.json`) |
| `src/products/tree/engine/runtime/source-repo-index.ts` | Generated `source-repos.md` index plus root tree repo guidance |
| `src/products/tree/engine/runtime/source-integration.ts` | Managed `AGENTS.md` / `CLAUDE.md` source integration block |
| `src/products/tree/engine/workspace.ts` | Child repo / submodule discovery |

## Validation

| Path | Coverage |
| --- | --- |
| `tests/init.test.ts` | Tree bootstrap and init wrapper behavior |
| `tests/cli-e2e.test.ts` | End-to-end CLI smoke coverage across repo, workspace, publish, and review workflows |
| `tests/publish.test.ts` | Publish orchestration |
| `tests/sync.test.ts` | Sync behavior and apply flow |
| `tests/thin-cli.test.ts` | Thin CLI smoke coverage |
| `tests/skill-artifacts.test.ts` | Skill export and doc integrity |
| `tests/upgrade.test.ts` | Upgrade behavior |
| `tests/verify.test.ts` | Verification behavior |

## Notes

- Keep decision-grade knowledge in the bound Context Tree under
  `first-tree-skill-cli/`.
- Keep root `README.md` and `AGENTS.md` short and distribution-focused.
- Keep shipped user knowledge in `skills/first-tree/references/`.
- Keep runtime metadata changes synchronized across tree nodes, local docs,
  tests, and code.
