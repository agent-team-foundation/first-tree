# Context Tree Source Map

This file is the fast index for the canonical single-skill architecture.

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
| `src/init.ts` / `src/verify.ts` / `src/upgrade.ts` | Command implementations for install, verify, and upgrade |
| `src/commands/` | Stable command entrypoints the CLI imports |
| `src/runtime/asset-loader.ts` | Canonical path constants plus legacy-layout detection for user-repo migration |
| `src/runtime/installer.ts` | Copy and template-render helpers |
| `src/runtime/upgrader.ts` | Upstream clone/version helpers |
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
| `progress.md` | Generated in user repos to track unfinished setup or upgrade tasks |

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

- The source repo intentionally contains no root `.context-tree/`, `docs/`,
  mirror skills, or bundled repo snapshot.
- Legacy `.context-tree/...` paths still matter only for migrating existing
  user repos; the compatibility logic lives in `src/runtime/asset-loader.ts`
  and `src/upgrade.ts`.
- If you change `references/` or `assets/framework/`, run `pnpm validate:skill`.
