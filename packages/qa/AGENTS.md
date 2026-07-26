# QA Package Instructions

`@first-tree/qa` contains the First Tree-specific assets used by the shipped `first-tree-qa` skill: formal run-cell
constraints, reusable briefings, natural-language QA cases, environment recipes, evidence guidance, templates, and
fixtures. The skill owns the QA lifecycle; this package extends it with repository-specific requirements and must not
define a competing order of work.

It is not a test runner, CLI, CI gate, or replacement for product tests and skill evals. Stable deterministic behavior
belongs in product tests. Recurring agent behavior belongs in `@first-tree/skill-evals`. Use these assets for live,
cross-surface, provider-backed, release, exploratory, or judgment-dependent First Tree QA.

## Required Invariants

A formal QA result cannot be `PASS` when any invariant is violated:

1. Run a Docker-backed cell plus a temporary git worktree, not the operator's checkout or shared local services. Use
   explicit native, device, or provider bridges only when a formal surface cannot live inside Docker.
2. Do not modify the tested product object. Test data, run-local config, and fixtures may change only inside the isolated
   cell. Product fixes and committed case maintenance are separate tasks.
3. Before `QA READY`, build, run, drive, observe, measure, and reset every formal First Tree product surface. A narrow
   request changes execution scope after readiness; it does not shrink the harness.
4. Do not select cases or write the formal task QA plan before the complete harness reaches `QA READY`. A provisional
   readiness checklist and run context are allowed.
5. Require real product behavior for `PASS`. Source, logs, mocks, and test output may support diagnosis but are not enough
   by themselves.
6. Write run artifacts outside the source repository and redact secrets, credentials, private sessions, and user data.
7. Separate valid target failures from environment, dependency, credential, provider, platform, or data-precondition
   failures and from insufficient evidence.
8. Put a case disposition in every final report without editing the committed case library during the run.

## Formal Lifecycle

1. Resolve the exact target and read repository, issue/PR/design, Context Tree, release, CI, and QA context.
2. Inventory every shipped or publicly promised product surface and the repository's tests, cases, tools, and contracts.
3. Prepare the complete isolated harness using `briefings/setup.md` and `environment/` while recording `run-context.md`.
4. Gate `QA READY`. If any required capability is missing, report `BLOCKED`, `FAIL`, or `INCONCLUSIVE` with evidence and
   do not pretend task execution occurred.
5. After readiness, write `plan.md` from `briefings/plan.md`, selecting the task-specific scope and reusable cases.
6. Execute through real product boundaries, adapt to live facts, and retain evidence tied to conclusions.
7. Report one status, performance observations, limitations, artifact paths, and case disposition.

Use one disposition: `no-change`, `candidate-new-case`, `candidate-case-update`, `move-to-product-test`,
`move-to-skill-eval`, or `merge-or-retire`. Apply the recommended change only in a separate maintenance or product-work
task.

Cases guide a capable agent rather than forming a rigid DSL. The current task plan owns live commands, parameters, data,
and evidence choices.

## Result Statuses

- `PASS`: the post-readiness plan completed with sufficient real-product evidence and no product issue was found.
- `FAIL`: a reproducible product defect attributable to the exact target was found. Produce a bug artifact.
- `BLOCKED`: environment or external preconditions prevented harness readiness or required task validation.
- `INCONCLUSIVE`: some evidence exists, but it is incomplete, unstable, interrupted, contradictory, or unattributable.

## Package Boundaries

- Put First Tree case authoring guidance and reusable cases under `cases/`.
- Put phase-specific repository guidance under `briefings/`.
- Put run-cell and provider-bridge recipes under `environment/`.
- Put evidence, performance-observation, and redaction guidance under `observability/`.
- Put minimal run artifact templates under `templates/`.
- Put reusable, non-run-specific assets under `fixtures/`.
- Do not add a public runner, lifecycle CLI, or CI gate without a separate design decision.
