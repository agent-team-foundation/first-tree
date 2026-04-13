# Context Tree Source Map

This is the maintainer reading index for the current `first-tree` architecture.

## Read First

| Path | Why it matters |
| --- | --- |
| `skills/first-tree/SKILL.md` | User-facing skill workflow |
| `skills/first-tree/references/onboarding.md` | Repo, shared-tree, and workspace onboarding model |
| `skills/first-tree/references/source-workspace-installation.md` | Binding model and source/workspace contract |
| `skills/first-tree/references/upgrade-contract.md` | Installed layout and upgrade invariants |
| `docs/maintainer-architecture.md` | High-level maintainer model |
| `docs/maintainer-thin-cli.md` | Thin CLI shell responsibilities |
| `docs/maintainer-build-and-distribution.md` | Build, pack, and publish contract |
| `docs/maintainer-testing.md` | Validation workflow |

## Runtime Payload

| Path | Purpose |
| --- | --- |
| `assets/framework/manifest.json` | Runtime asset contract |
| `assets/framework/VERSION` | Version marker for tree installs |
| `assets/framework/templates/` | Generated tree scaffolds |
| `assets/framework/workflows/` | CI templates |
| `assets/framework/prompts/` | Review prompt payload |
| `assets/framework/examples/` | Agent integration examples |
| `assets/framework/helpers/` | Shipped helper scripts and TS utilities |

## Engine Surface

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Thin command parser and dispatcher |
| `src/engine/init.ts` | High-level onboarding wrapper plus low-level tree bootstrap |
| `src/engine/inspect.ts` | Root classification before onboarding |
| `src/engine/bind.ts` | Binding a source/workspace root to an existing tree |
| `src/engine/workspace-sync.ts` | Binding child repos to a shared tree |
| `src/engine/publish.ts` | Tree publish flow and local source refresh |
| `src/engine/upgrade.ts` | Installed-skill / tree upgrade behavior |
| `src/engine/verify.ts` | Tree verification |
| `src/engine/runtime/binding-state.ts` | `source.json`, `workspace.json`, `tree.json`, and `bindings/` schema |
| `src/engine/runtime/local-tree-config.ts` | `.first-tree/local-tree.json` contract |
| `src/engine/runtime/source-repo-index.ts` | Generated `source-repos.md` index plus root tree repo guidance |
| `src/engine/runtime/source-integration.ts` | Managed `AGENTS.md` / `CLAUDE.md` source integration block |
| `src/engine/workspace.ts` | Child repo / submodule discovery |

## Validation

| Path | Coverage |
| --- | --- |
| `tests/init.test.ts` | Tree bootstrap and init wrapper behavior |
| `tests/cli-e2e.test.ts` | End-to-end CLI smoke coverage across repo, workspace, publish, and review workflows |
| `tests/publish.test.ts` | Publish orchestration |
| `tests/thin-cli.test.ts` | Thin CLI smoke coverage |
| `tests/skill-artifacts.test.ts` | Skill export and doc integrity |
| `tests/upgrade.test.ts` | Upgrade behavior |
| `tests/verify.test.ts` | Verification behavior |

## Notes

- Keep root `README.md` and `AGENTS.md` short and distribution-focused.
- Keep shipped user knowledge in `skills/first-tree/references/`.
- Keep runtime metadata changes synchronized across docs, tests, and code.
