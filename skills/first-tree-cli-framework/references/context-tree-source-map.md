# Context Tree Source Map

## Table Of Contents

- Read first
- CLI entrypoints
- Init and upgrade flow
- Rule modules
- Validators
- Framework payload
- Tests
- Command reference

## Read First

These bundled files establish the product boundary and are safe to rely on even after this skill is copied elsewhere:

| Path | Why it matters |
| --- | --- |
| `references/repo-snapshot/AGENTS.md` | Repo-specific expectations for working on the CLI and framework |
| `references/repo-snapshot/README.md` | User-facing command overview and framework shape |
| `references/repo-snapshot/docs/about.md` | High-level Context Tree problem statement and promise |
| `references/repo-snapshot/docs/onboarding.md` | The onboarding narrative emitted by `help onboarding` and `init` |

## CLI Entrypoints

| Path | Purpose |
| --- | --- |
| `references/repo-snapshot/src/cli.ts` | Top-level command dispatch and usage text |
| `references/repo-snapshot/src/onboarding.ts` | Emits the onboarding markdown |
| `references/repo-snapshot/src/repo.ts` | Repo inspection helpers, marker checks, and path probing |

## Init And Upgrade Flow

| Path | Purpose |
| --- | --- |
| `references/repo-snapshot/src/init.ts` | Clones upstream framework, copies `.context-tree/`, renders templates, writes `progress.md` |
| `references/repo-snapshot/src/upgrade.ts` | Checks upstream version, writes upgrade tasks, and defines the upgrade contract |
| `references/repo-snapshot/src/verify.ts` | Progress gating plus node/member validation entrypoint |

Read these together when changing user-visible behavior for `init`, `verify`, or `upgrade`.

## Rule Modules

These files control which task groups appear in `progress.md` after `init`.

| Path | Purpose |
| --- | --- |
| `references/repo-snapshot/src/rules/framework.ts` | Detect missing framework |
| `references/repo-snapshot/src/rules/root-node.ts` | Detect missing or placeholder root `NODE.md` |
| `references/repo-snapshot/src/rules/agent-instructions.ts` | Detect missing `AGENT.md` or missing custom instructions |
| `references/repo-snapshot/src/rules/members.ts` | Detect missing members structure |
| `references/repo-snapshot/src/rules/agent-integration.ts` | Detect missing agent session integration |
| `references/repo-snapshot/src/rules/ci-validation.ts` | Detect missing validation, PR review, and CODEOWNERS workflows |
| `references/repo-snapshot/src/rules/populate-tree.ts` | Emit the deep-population workflow for the tree |
| `references/repo-snapshot/src/rules/index.ts` | Rule ordering and aggregation |

## Validators

| Path | Purpose |
| --- | --- |
| `references/repo-snapshot/src/validators/nodes.ts` | Validates frontmatter, owners, `soft_links`, folder structure, root domain sync, reciprocity, body length, title-heading consistency |
| `references/repo-snapshot/src/validators/members.ts` | Validates member node schema, nested member layout, name uniqueness, and `delegate_mention` integrity |

When changing validation behavior, inspect both validator files and the tests that prove the expected severity.

## Framework Payload

These files are copied into user repos or referenced by rule output:

| Path | Purpose |
| --- | --- |
| `references/repo-snapshot/.context-tree/principles.md` | Core decision model and examples |
| `references/repo-snapshot/.context-tree/ownership-and-naming.md` | Ownership and naming contract |
| `references/repo-snapshot/.context-tree/templates/root-node.md.template` | Root tree scaffold |
| `references/repo-snapshot/.context-tree/templates/agent.md.template` | Framework section for `AGENT.md` |
| `references/repo-snapshot/.context-tree/templates/members-domain.md.template` | `members/NODE.md` scaffold |
| `references/repo-snapshot/.context-tree/templates/member-node.md.template` | Member node scaffold |
| `references/repo-snapshot/.context-tree/workflows/validate.yml` | Validation workflow template |
| `references/repo-snapshot/.context-tree/workflows/pr-review.yml` | Optional AI PR review workflow |
| `references/repo-snapshot/.context-tree/workflows/codeowners.yml` | CODEOWNERS generation workflow |
| `references/repo-snapshot/.context-tree/generate-codeowners.ts` | CODEOWNERS generator with inheritance logic |
| `references/repo-snapshot/.context-tree/run-review.ts` | Review runner used by the PR review workflow |
| `references/repo-snapshot/.context-tree/scripts/inject-tree-context.sh` | Session-start root context injection |
| `references/repo-snapshot/.context-tree/examples/claude-code/README.md` | Claude Code integration instructions |

## Tests

Touch the paired tests whenever behavior changes:

| Path | Coverage |
| --- | --- |
| `references/repo-snapshot/tests/init.test.ts` | `init` flow and `progress.md` writing |
| `references/repo-snapshot/tests/verify.test.ts` | verification flow and progress handling |
| `references/repo-snapshot/tests/rules.test.ts` | init task generation |
| `references/repo-snapshot/tests/validate-nodes.test.ts` | node validator behavior |
| `references/repo-snapshot/tests/validate-members.test.ts` | member validator behavior |
| `references/repo-snapshot/tests/generate-codeowners.test.ts` | ownership resolution and CODEOWNERS generation |
| `references/repo-snapshot/tests/run-review.test.ts` | review runner behavior |
| `references/repo-snapshot/tests/repo.test.ts` | repo helper parsing behavior |
| `references/repo-snapshot/evals/tests/eval-helpers.test.ts` | eval helper behavior |

## Command Reference

Use these commands from a live `first-tree` repo root unless the task explicitly needs something else:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Use these commands from the skill directory for portable CLI smoke tests:

```bash
./scripts/run-local-cli.sh --help
./scripts/run-local-cli.sh --version
./scripts/run-local-cli.sh help onboarding
```

If a change touches user-facing CLI behavior, run both the live repo checks and at least one CLI smoke test.
