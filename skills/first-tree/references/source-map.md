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
| `references/source-workspace-installation.md` | Contract for source/workspace installs vs dedicated tree repos |
| `references/principles.md` | Decision-model reference |
| `references/ownership-and-naming.md` | Ownership contract |
| `references/upgrade-contract.md` | Installed layout and upgrade semantics |
| `references/maintainer-architecture.md` | Source-repo architecture and invariants |
| `references/maintainer-thin-cli.md` | Root shell contract and anti-duplication rules |
| `references/maintainer-build-and-distribution.md` | Build, pack, and distribution contract |
| `references/maintainer-testing.md` | Test workflow and maintainer validation expectations |

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

These skill-owned files implement the framework behavior.

| Path | Purpose |
| --- | --- |
| `engine/commands/` | Stable command entrypoints that the thin CLI imports |
| `engine/init.ts` / `engine/publish.ts` / `engine/verify.ts` / `engine/upgrade.ts` | Command implementations for install, publish, verify, and upgrade |
| `engine/member-seeding.ts` | Contributor discovery plus optional member-node seeding during init |
| `engine/onboarding.ts` | Canonical onboarding text loader |
| `engine/repo.ts` | Repo inspection, source-vs-tree heuristics, and worktree-aware git-root helpers |
| `engine/rules/` | Situation-aware task generation after `init` |
| `engine/validators/` | Deterministic tree and member validation |
| `engine/runtime/asset-loader.ts` | Path constants plus legacy-layout detection |
| `engine/runtime/bootstrap.ts` | Dedicated-tree bootstrap metadata for the publish workflow |
| `engine/runtime/installer.ts` | Bundled-package discovery, skill copy, and template-render helpers |
| `engine/runtime/upgrader.ts` | Packaged-skill version comparison helpers |
| `engine/runtime/adapters.ts` | Agent-integration path helpers |

## Thin CLI Shell Surface

These root files are distribution shell code. They should stay thin and should
not become the only place important maintainer knowledge lives.

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Thin command parser and dispatcher |
| `src/md.d.ts` | Build-time markdown module typing |
| `package.json` | Package metadata, import aliases, and scripts |
| `tsconfig.json` | TypeScript compile boundaries |
| `tsdown.config.ts` | Build entry and asset handling |
| `vitest.config.ts` | Unit-test entrypoints |
| `.github/workflows/ci.yml` | Thin CI shell |
| `README.md` | Thin distribution overview |
| `AGENTS.md` | Thin maintainer pointer for agent sessions |

## Validation

| Path | Coverage |
| --- | --- |
| `tests/init.test.ts` | Init scaffolding behavior |
| `tests/member-seeding.test.ts` | Contributor discovery and member seeding behavior |
| `tests/publish.test.ts` | Publish workflow orchestration |
| `tests/verify.test.ts` | Verification and progress gating |
| `tests/rules.test.ts` | Task generation text |
| `tests/asset-loader.test.ts` | Layout detection and path precedence |
| `tests/generate-codeowners.test.ts` | Ownership helper behavior |
| `tests/run-review.test.ts` | Review helper behavior |
| `tests/skill-artifacts.test.ts` | Skill export and documentation integrity |
| `tests/thin-cli.test.ts` | Thin CLI entrypoint smoke coverage |
| `tests/upgrade.test.ts` | Installed-skill upgrade behavior |

## Compatibility Notes

- The source repo intentionally contains no root `.context-tree/`, `docs/`,
  mirror skills, or bundled repo snapshot.
- Legacy `.context-tree/...` paths still matter only for migrating existing
  user repos; the compatibility logic lives in
  `engine/runtime/asset-loader.ts` and `engine/upgrade.ts`.
- Root `README.md` and `AGENTS.md` are intentionally brief. Important
  information must live in the skill references instead.
- If you change `references/` or `assets/framework/`, run `pnpm validate:skill`.
