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

These files establish the product boundary and should be read before deeper changes:

| Path | Why it matters |
| --- | --- |
| `AGENTS.md` | Repo-specific expectations for working on the CLI and framework |
| `README.md` | User-facing command overview and framework shape |
| `docs/about.md` | High-level Context Tree problem statement and promise |
| `docs/onboarding.md` | The onboarding narrative emitted by `help onboarding` and `init` |

## CLI Entrypoints

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Top-level command dispatch and usage text |
| `src/onboarding.ts` | Emits the onboarding markdown |
| `src/repo.ts` | Repo inspection helpers, marker checks, and path probing |

## Init And Upgrade Flow

| Path | Purpose |
| --- | --- |
| `src/init.ts` | Clones upstream framework, copies `.context-tree/`, renders templates, writes `progress.md` |
| `src/upgrade.ts` | Checks upstream version, writes upgrade tasks, and defines the upgrade contract |
| `src/verify.ts` | Progress gating plus node/member validation entrypoint |

Read these together when changing user-visible behavior for `init`, `verify`, or `upgrade`.

## Rule Modules

These files control which task groups appear in `progress.md` after `init`.

| Path | Purpose |
| --- | --- |
| `src/rules/framework.ts` | Detect missing framework |
| `src/rules/root-node.ts` | Detect missing or placeholder root `NODE.md` |
| `src/rules/agent-instructions.ts` | Detect missing `AGENT.md` or missing custom instructions |
| `src/rules/members.ts` | Detect missing members structure |
| `src/rules/agent-integration.ts` | Detect missing agent session integration |
| `src/rules/ci-validation.ts` | Detect missing validation, PR review, and CODEOWNERS workflows |
| `src/rules/populate-tree.ts` | Emit the deep-population workflow for the tree |
| `src/rules/index.ts` | Rule ordering and aggregation |

## Validators

| Path | Purpose |
| --- | --- |
| `src/validators/nodes.ts` | Validates frontmatter, owners, `soft_links`, folder structure, root domain sync, reciprocity, body length, title-heading consistency |
| `src/validators/members.ts` | Validates member node schema, nested member layout, name uniqueness, and `delegate_mention` integrity |

When changing validation behavior, inspect both validator files and the tests that prove the expected severity.

## Framework Payload

These files are copied into user repos or referenced by rule output:

| Path | Purpose |
| --- | --- |
| `.context-tree/principles.md` | Core decision model and examples |
| `.context-tree/ownership-and-naming.md` | Ownership and naming contract |
| `.context-tree/templates/root-node.md.template` | Root tree scaffold |
| `.context-tree/templates/agent.md.template` | Framework section for `AGENT.md` |
| `.context-tree/templates/members-domain.md.template` | `members/NODE.md` scaffold |
| `.context-tree/templates/member-node.md.template` | Member node scaffold |
| `.context-tree/workflows/validate.yml` | Validation workflow template |
| `.context-tree/workflows/pr-review.yml` | Optional AI PR review workflow |
| `.context-tree/workflows/codeowners.yml` | CODEOWNERS generation workflow |
| `.context-tree/generate-codeowners.ts` | CODEOWNERS generator with inheritance logic |
| `.context-tree/run-review.ts` | Review runner used by the PR review workflow |
| `.context-tree/scripts/inject-tree-context.sh` | Session-start root context injection |
| `.context-tree/examples/claude-code/README.md` | Claude Code integration instructions |

## Tests

Touch the paired tests whenever behavior changes:

| Path | Coverage |
| --- | --- |
| `tests/init.test.ts` | `init` flow and `progress.md` writing |
| `tests/verify.test.ts` | verification flow and progress handling |
| `tests/rules.test.ts` | init task generation |
| `tests/validate-nodes.test.ts` | node validator behavior |
| `tests/validate-members.test.ts` | member validator behavior |
| `tests/generate-codeowners.test.ts` | ownership resolution and CODEOWNERS generation |
| `tests/run-review.test.ts` | review runner behavior |
| `tests/repo.test.ts` | repo helper parsing behavior |

## Command Reference

Use these commands from the repo root unless the task explicitly needs something else:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Use these commands from the skill directory for local CLI smoke tests:

```bash
./scripts/run-local-cli.sh --help
./scripts/run-local-cli.sh --version
./scripts/run-local-cli.sh help onboarding
```

If a change touches user-facing CLI behavior, run both the repo checks and at least one CLI smoke test.
