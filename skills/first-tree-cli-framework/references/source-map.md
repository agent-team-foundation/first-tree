# Context Tree Source Map

This file is the fast index for the new single-skill architecture.

## Read First

| Path | Why it matters |
| --- | --- |
| `SKILL.md` | Trigger conditions, workflow, and validation contract |
| `references/about.md` | Product framing for what Context Tree is and is not |
| `references/onboarding.md` | The onboarding narrative that `help onboarding` and `init` surface |
| `references/principles.md` | Decision-model reference |
| `references/ownership-and-naming.md` | Ownership contract |
| `references/upgrade-contract.md` | Installed layout and upgrade semantics |

## CLI Surface

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Top-level command dispatch |
| `src/commands/help.ts` | Help topic routing |
| `src/init.ts` / `src/verify.ts` / `src/upgrade.ts` | Existing command implementations while the refactor converges |
| `src/commands/` | Stable command entrypoints the CLI imports |
| `src/runtime/asset-loader.ts` | Canonical path constants and layout detection |
| `src/runtime/installer.ts` | Copy and template-render helpers |
| `src/runtime/upgrader.ts` | Upstream version resolution |
| `src/runtime/adapters.ts` | Agent-integration path helpers |

## Runtime Payload

The installed skill payload lives under `assets/framework/`.

| Path | Purpose |
| --- | --- |
| `assets/framework/manifest.json` | Runtime asset contract |
| `assets/framework/VERSION` | Version marker for installed payloads |
| `assets/framework/templates/` | Generated scaffolds |
| `assets/framework/workflows/` | CI templates |
| `assets/framework/prompts/` | Review prompt payload |
| `assets/framework/examples/` | Agent integration examples |
| `assets/framework/helpers/` | Shipped helper scripts and TypeScript utilities |

## Validation Surface

| Path | Coverage |
| --- | --- |
| `src/rules/` | Task generation after `init` |
| `src/validators/` | Deterministic tree and member validation |
| `tests/init.test.ts` | Init scaffolding behavior |
| `tests/verify.test.ts` | Verification and progress gating |
| `tests/rules.test.ts` | Task generation text |
| `tests/asset-loader.test.ts` | Layout detection and path precedence |
| `tests/generate-codeowners.test.ts` | Ownership helper behavior |
| `tests/run-review.test.ts` | Review helper behavior |
| `tests/skill-artifacts.test.ts` | Skill export, snapshot, and mirror integrity |

## Compatibility Notes

- `docs/` and root `.context-tree/` are temporary exported mirrors while the
  repo transitions to a single canonical skill.
- `references/repo-snapshot/` is a portable artifact, not the source of truth.
- If you change `references/` or `assets/framework/`, run
  `bash ./skills/first-tree-cli-framework/scripts/sync-skill-artifacts.sh`.
