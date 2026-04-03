# Context Tree Source Map

This is the canonical reading index for the single-skill architecture. If a
maintainer needs information to safely change the framework or thin CLI, that
information should be discoverable from this file.

## Read First

| Path | Why it matters |
| --- | --- |
| `SKILL.md` | Trigger conditions, workflow, and validation contract |
| `references/about.md` | Product framing for what Context Tree is and is not |
| `references/onboarding.md` | The onboarding narrative that `help onboarding` and `init` surface |
| `references/principles.md` | Decision-model reference |
| `references/ownership-and-naming.md` | Ownership contract |
| `references/upgrade-contract.md` | Installed layout and upgrade semantics |
| `references/maintainer-architecture.md` | Source-repo architecture and invariants |
| `references/maintainer-thin-cli.md` | Root shell contract and anti-duplication rules |
| `references/maintainer-build-and-distribution.md` | Build, pack, and distribution contract |
| `references/maintainer-testing-and-evals.md` | Test/eval workflow and expectations |

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

## Framework Engine Surface

These files currently implement the framework behavior. Their contracts must
also be described in the maintainer references above.

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Top-level command dispatch |
| `src/commands/help.ts` | Help topic routing |
| `src/init.ts` / `src/verify.ts` / `src/upgrade.ts` | Command implementations for install, verify, and upgrade |
| `src/commands/` | Stable command entrypoints the CLI imports |
| `src/repo.ts` | Repo inspection and layout helpers |
| `src/rules/` | Situation-aware task generation after `init` |
| `src/validators/` | Deterministic tree and member validation |
| `src/runtime/asset-loader.ts` | Path constants plus legacy-layout detection |
| `src/runtime/installer.ts` | Copy and template-render helpers |
| `src/runtime/upgrader.ts` | Upstream clone/version helpers |
| `src/runtime/adapters.ts` | Agent-integration path helpers |

## Thin CLI Shell Surface

These root files are distribution shell code. They should stay thin and should
not become the only place important maintainer knowledge lives.

| Path | Purpose |
| --- | --- |
| `package.json` | Package metadata, import aliases, and scripts |
| `tsconfig.json` | TypeScript compile boundaries |
| `tsdown.config.ts` | Build entry and asset handling |
| `vitest.config.ts` | Unit-test entrypoints |
| `vitest.eval.config.ts` | Eval-test entrypoint and timeouts |
| `.github/workflows/ci.yml` | Thin CI shell |
| `README.md` | Thin distribution overview |
| `AGENT.md` | Thin maintainer pointer for agent sessions |

## Validation And Evals

| Path | Coverage |
| --- | --- |
| `tests/init.test.ts` | Init scaffolding behavior |
| `tests/verify.test.ts` | Verification and progress gating |
| `tests/rules.test.ts` | Task generation text |
| `tests/asset-loader.test.ts` | Layout detection and path precedence |
| `tests/generate-codeowners.test.ts` | Ownership helper behavior |
| `tests/run-review.test.ts` | Review helper behavior |
| `tests/skill-artifacts.test.ts` | Skill export and documentation integrity |
| `tests/upgrade.test.ts` | Installed-skill upgrade behavior |
| `evals/context-tree-eval.test.ts` | End-to-end eval harness |
| `evals/helpers/` | Eval orchestration and reporting |
| `evals/scripts/` | Context-tree management and report scripts |
| `evals/tests/` | Eval helper coverage |

## Compatibility Notes

- The source repo intentionally contains no root `.context-tree/`, `docs/`,
  mirror skills, or bundled repo snapshot.
- Legacy `.context-tree/...` paths still matter only for migrating existing
  user repos; the compatibility logic lives in `src/runtime/asset-loader.ts`
  and `src/upgrade.ts`.
- Root `README.md` and `AGENT.md` are intentionally brief. Important
  information must live in the skill references instead.
- If you change `references/` or `assets/framework/`, run `pnpm validate:skill`.
